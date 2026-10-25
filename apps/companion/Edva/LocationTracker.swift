import Foundation
import CoreLocation
import SwiftData

#if os(iOS)
import CoreMotion
import UIKit
#endif

// MARK: - Named locations
//
// Locations the user wants to recognize by name. When the device's GPS lands
// within 150m of one of these coordinates, the published `place_name` is the
// named entry (not a reverse-geocode result), which gives the agent stable,
// human-readable place context across visits.
//
// Mirror these entries server-side in `bin/findme`'s named-location table so
// CLI and app agree on labels. The list is intentionally empty in the public
// repo — add your own:
//
//   ("Home",            40.7426, -74.0015, "<street>", "<city>"),
//   ("Office",          40.7484, -73.9857, "<street>", "<city>"),
//   ("Parents",         42.3601, -71.0589, "<street>", "<city>"),
//
// All five fields are required.

private let namedLocations: [(name: String, lat: Double, lon: Double, address: String, city: String)] = [
    // Add your named locations here. Empty default ships in the public repo.
]

private func haversineKm(_ lat1: Double, _ lon1: Double, _ lat2: Double, _ lon2: Double) -> Double {
    let R = 6371.0
    let dLat = (lat2 - lat1) * .pi / 180
    let dLon = (lon2 - lon1) * .pi / 180
    let a = sin(dLat / 2) * sin(dLat / 2) +
        cos(lat1 * .pi / 180) * cos(lat2 * .pi / 180) *
        sin(dLon / 2) * sin(dLon / 2)
    return R * 2 * asin(sqrt(a))
}

private func matchNamedLocation(lat: Double, lon: Double) -> (name: String, address: String, city: String)? {
    for loc in namedLocations {
        if haversineKm(lat, lon, loc.lat, loc.lon) <= 0.15 {
            return (loc.name, loc.address, loc.city)
        }
    }
    return nil
}

// MARK: - Current context (exposed for message metadata)

struct LocationContext {
    let placeName: String?
    let activity: String?
    let arrivedAt: Date
}

// MARK: - SwiftData model for local buffer

@Model
final class CachedLocationSegment {
    @Attribute(.unique) var localId: UUID
    var segmentType: String
    var latitude: Double
    var longitude: Double
    var accuracyM: Double?
    var arrivedAt: Date
    var departedAt: Date?
    var activity: String?
    var confidence: String?
    var placeName: String?
    var placeType: String?
    var address: String?
    var neighborhood: String?
    var city: String?
    var synced: Bool
    var remoteId: String?
    var needsDepartureUpdate: Bool

    init(
        segmentType: String, latitude: Double, longitude: Double, accuracyM: Double?,
        arrivedAt: Date, departedAt: Date?, activity: String?, confidence: String?,
        placeName: String?, placeType: String?, address: String?,
        neighborhood: String?, city: String?
    ) {
        self.localId = UUID()
        self.segmentType = segmentType
        self.latitude = latitude
        self.longitude = longitude
        self.accuracyM = accuracyM
        self.arrivedAt = arrivedAt
        self.departedAt = departedAt
        self.activity = activity
        self.confidence = confidence
        self.placeName = placeName
        self.placeType = placeType
        self.address = address
        self.neighborhood = neighborhood
        self.city = city
        self.synced = false
        self.remoteId = nil
        self.needsDepartureUpdate = false
    }

    fileprivate func toRow() -> LocationHistoryRow {
#if os(iOS)
        let deviceId = UIDevice.current.identifierForVendor?.uuidString ?? "unknown-device"
#else
        let deviceId = "macos-companion"
#endif
        return LocationHistoryRow(
            segment_type: segmentType,
            latitude: latitude,
            longitude: longitude,
            accuracy_m: accuracyM,
            arrived_at: arrivedAt.ISO8601Format(),
            departed_at: departedAt?.ISO8601Format(),
            activity: activity,
            confidence: confidence,
            place_name: placeName,
            place_type: placeType,
            address: address,
            neighborhood: neighborhood,
            city: city,
            device_id: deviceId
        )
    }
}

// MARK: - Supabase row types

private struct LocationHistoryRow: Encodable {
    let segment_type: String
    let latitude: Double
    let longitude: Double
    let accuracy_m: Double?
    let arrived_at: String
    let departed_at: String?
    let activity: String?
    let confidence: String?
    let place_name: String?
    let place_type: String?
    let address: String?
    let neighborhood: String?
    let city: String?
    let device_id: String
}

private struct SupabaseReturnRow: Decodable {
    let id: String
    let arrived_at: String
}

// MARK: - LocationTracker (iOS only — tracking runs on the user's iPhone)

#if os(iOS)

final class LocationTracker: NSObject, CLLocationManagerDelegate {
    static let shared = LocationTracker()

    private let manager = CLLocationManager()
    private let geocoder = CLGeocoder()
    private let motionManager = CMMotionActivityManager()

    private var modelContainer: ModelContainer?
    private var modelContext: ModelContext?

    private let supabase = SupabaseManager.shared

    /// Current context for message metadata enrichment.
    private(set) var currentContext: LocationContext?

    /// Last recorded activity type (to coalesce changes).
    private var lastActivityType: String?

    /// Most recent open visit segment (for departure updates).
    private var currentVisitLocalId: UUID?

    /// Last 30 visit coordinates, for deduping audio-context sampling. We only
    /// fire the ambient sampler at the start of visits to *new* places — Home,
    /// office, and regular spots don't need re-sampling on every arrival.
    private var recentVisitFingerprints: [(lat: Double, lon: Double)] = []
    private let recentVisitFingerprintLimit = 30
    /// Two visits within ~150m are treated as the same place.
    private let visitDedupeKm: Double = 0.15

    /// Minimum interval between transit waypoints (even when moving).
    private let transitMinInterval: TimeInterval = 120 // 2 minutes
    /// Max silence before recording a heartbeat at the same location.
    private let heartbeatInterval: TimeInterval = 3600 // 1 hour
    /// Distance threshold for "same place" dedup.
    private let sameLocationKm: Double = 0.005 // 5m
    private var lastTransitTimestamp: Date?
    private var lastRecordedLat: Double?
    private var lastRecordedLon: Double?

    private var syncTimer: Timer?
    private var accuracyPingTimer: Timer?
    private var isTracking = false

    override init() {
        super.init()
        setupSwiftData()
    }

    // MARK: - Setup

    private func setupSwiftData() {
        do {
            let schema = Schema([CachedLocationSegment.self])
            let config = ModelConfiguration(
                "edva_location",
                schema: schema,
                url: URL.applicationSupportDirectory.appending(path: "edva_location.store")
            )
            modelContainer = try ModelContainer(for: schema, configurations: [config])
            modelContext = ModelContext(modelContainer!)
            modelContext?.autosaveEnabled = true
        } catch {
            print("[LocationTracker] SwiftData setup failed: \(error)")
        }
    }

    func startTracking() {
        guard !isTracking else { return }
        isTracking = true

        manager.delegate = self

        // Request permission first, then configure background modes after authorization
        let status = manager.authorizationStatus
        print("[LocationTracker] Current auth status: \(status.rawValue)")

        switch status {
        case .notDetermined:
            // Must request WhenInUse first, then Always in the delegate callback
            print("[LocationTracker] Requesting WhenInUse (step 1 of 2)")
            manager.requestWhenInUseAuthorization()
            return // Will continue in didChangeAuthorization
        case .authorizedWhenInUse:
            // Upgrade to Always — this SHOULD show the system prompt
            print("[LocationTracker] Requesting Always upgrade from WhenInUse")
            manager.requestAlwaysAuthorization()
            // Continue to start monitoring even with WhenInUse (works in foreground)
        case .authorizedAlways:
            print("[LocationTracker] Already authorized Always")
        default:
            print("[LocationTracker] Authorization denied or restricted: \(status.rawValue)")
        }

        beginMonitoring()
    }

    private var isMonitoring = false

    private func beginMonitoring() {
        guard !isMonitoring else { return }
        isMonitoring = true

        let status = manager.authorizationStatus
        let bgModes = Bundle.main.infoDictionary?["UIBackgroundModes"] as? [String] ?? []
        if status == .authorizedAlways && bgModes.contains("location") {
            manager.allowsBackgroundLocationUpdates = true
            manager.pausesLocationUpdatesAutomatically = false
            manager.showsBackgroundLocationIndicator = false
        }

        manager.startMonitoringVisits()
        manager.startMonitoringSignificantLocationChanges()

        // Cell-radio only — keeps app alive with near-zero battery cost
        manager.desiredAccuracy = kCLLocationAccuracyThreeKilometers
        manager.distanceFilter = kCLDistanceFilterNone
        manager.startUpdatingLocation()

        startAccuracyPingTimer()
        startActivityMonitoring()
        startSyncTimer()
        restoreCurrentContext()

        print("[LocationTracker] Monitoring started (always=\(status == .authorizedAlways))")
    }

    // MARK: - CLLocationManagerDelegate

    nonisolated func locationManager(_ manager: CLLocationManager, didVisit visit: CLVisit) {
        let lat = visit.coordinate.latitude
        let lon = visit.coordinate.longitude
        let accuracy = visit.horizontalAccuracy
        let arrival = visit.arrivalDate == .distantPast ? Date() : visit.arrivalDate
        let departure = visit.departureDate == .distantFuture ? nil : visit.departureDate

        Task { @MainActor in
            await self.handleVisit(lat: lat, lon: lon, accuracy: accuracy, arrival: arrival, departure: departure)
        }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let location = locations.last else { return }
        let lat = location.coordinate.latitude
        let lon = location.coordinate.longitude
        let accuracy = location.horizontalAccuracy
        let timestamp = location.timestamp

        Task { @MainActor in
            await self.handleTransitWaypoint(lat: lat, lon: lon, accuracy: accuracy, timestamp: timestamp)
        }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didChangeAuthorization status: CLAuthorizationStatus) {
        print("[LocationTracker] Auth changed to: \(status.rawValue)")
        Task { @MainActor in
            switch status {
            case .authorizedWhenInUse:
                // Step 2: now upgrade to Always
                print("[LocationTracker] Got WhenInUse — requesting Always upgrade")
                self.manager.requestAlwaysAuthorization()
                self.beginMonitoring()
            case .authorizedAlways:
                print("[LocationTracker] Got Always — starting full background monitoring")
                self.beginMonitoring()
            default:
                break
            }
        }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        print("[LocationTracker] Location error: \(error.localizedDescription)")
    }

    // MARK: - Visit handling

    @MainActor
    private func handleVisit(lat: Double, lon: Double, accuracy: Double, arrival: Date, departure: Date?) async {
        guard let ctx = modelContext else { return }

        if let departure = departure {
            // Visit departure — update existing open segment or update/create one
            if let openId = currentVisitLocalId {
                let descriptor = FetchDescriptor<CachedLocationSegment>(
                    predicate: #Predicate { $0.localId == openId }
                )
                if let open = try? ctx.fetch(descriptor).first {
                    open.departedAt = departure
                    if open.synced {
                        open.needsDepartureUpdate = true
                        open.synced = false
                    }
                    try? ctx.save()
                    currentVisitLocalId = nil
                    currentContext = nil
                    return
                }
            }
            // No tracked open segment. Before creating a fresh "completed" row,
            // dedupe against an existing visit at this place + minute — iOS
            // sometimes fires the visit lifecycle as both an arrival/departure
            // pair AND a single "completed" CLVisit, which used to produce two
            // rows per stop in location_history (~25% duplication rate prior
            // to this fix). Find any visit at this place arrived within ±60s
            // of `arrival` and update its departure instead.
            if let existing = findRecentVisit(lat: lat, lon: lon, near: arrival, in: ctx) {
                let prevDep = existing.departedAt ?? .distantPast
                if departure > prevDep {
                    existing.departedAt = departure
                    if existing.synced {
                        existing.needsDepartureUpdate = true
                        existing.synced = false
                    }
                    try? ctx.save()
                }
                currentVisitLocalId = nil
                currentContext = nil
                return
            }
            let geo = await reverseGeocode(lat: lat, lon: lon)
            let segment = CachedLocationSegment(
                segmentType: "visit", latitude: lat, longitude: lon, accuracyM: accuracy,
                arrivedAt: arrival, departedAt: departure,
                activity: "stationary", confidence: "high",
                placeName: geo.placeName, placeType: geo.placeType,
                address: geo.address, neighborhood: geo.neighborhood, city: geo.city
            )
            ctx.insert(segment)
            try? ctx.save()
            currentVisitLocalId = nil
            currentContext = nil
        } else {
            // Visit arrival — open a new segment, but dedupe first against any
            // existing visit at this place arrived within ±60s.
            if let existing = findRecentVisit(lat: lat, lon: lon, near: arrival, in: ctx) {
                currentVisitLocalId = existing.localId
                currentContext = LocationContext(
                    placeName: existing.placeName,
                    activity: existing.activity ?? "stationary",
                    arrivedAt: existing.arrivedAt
                )
                return
            }
            let geo = await reverseGeocode(lat: lat, lon: lon)
            let segment = CachedLocationSegment(
                segmentType: "visit", latitude: lat, longitude: lon, accuracyM: accuracy,
                arrivedAt: arrival, departedAt: nil,
                activity: "stationary", confidence: "high",
                placeName: geo.placeName, placeType: geo.placeType,
                address: geo.address, neighborhood: geo.neighborhood, city: geo.city
            )
            ctx.insert(segment)
            try? ctx.save()
            currentVisitLocalId = segment.localId
            currentContext = LocationContext(
                placeName: geo.placeName,
                activity: "stationary",
                arrivedAt: arrival
            )

            #if os(iOS)
            if isNewPlace(lat: lat, lon: lon) {
                rememberVisit(lat: lat, lon: lon)
                Task {
                    await PhoneContextPublisher.publish(
                        trigger: .visit, latitude: lat, longitude: lon
                    )
                }
            }
            #endif
        }
    }

    /// Find an existing visit segment at the same place (lat/lon within
    /// ~150m) whose arrival is within ±60s of `arrival`. Used to dedupe
    /// duplicate CLVisit callbacks before they hit Supabase.
    @MainActor
    private func findRecentVisit(lat: Double, lon: Double, near arrival: Date,
                                 in ctx: ModelContext) -> CachedLocationSegment? {
        let descriptor = FetchDescriptor<CachedLocationSegment>(
            predicate: #Predicate { $0.segmentType == "visit" },
            sortBy: [SortDescriptor(\.arrivedAt, order: .reverse)]
        )
        guard let recent = try? ctx.fetch(descriptor) else { return nil }
        for seg in recent.prefix(20) {
            if abs(seg.arrivedAt.timeIntervalSince(arrival)) > 60 { continue }
            if haversineKm(seg.latitude, seg.longitude, lat, lon) <= visitDedupeKm {
                return seg
            }
        }
        return nil
    }

    private func isNewPlace(lat: Double, lon: Double) -> Bool {
        for fp in recentVisitFingerprints {
            if haversineKm(lat, lon, fp.lat, fp.lon) <= visitDedupeKm {
                return false
            }
        }
        // Entries in the `namedLocations` table are by definition not new.
        if matchNamedLocation(lat: lat, lon: lon) != nil {
            return false
        }
        return true
    }

    private func rememberVisit(lat: Double, lon: Double) {
        recentVisitFingerprints.append((lat, lon))
        if recentVisitFingerprints.count > recentVisitFingerprintLimit {
            recentVisitFingerprints.removeFirst(
                recentVisitFingerprints.count - recentVisitFingerprintLimit
            )
        }
    }

    // MARK: - Transit waypoint handling

    /// If the user has wandered well away from an open visit's center,
    /// close the visit ourselves. iOS's CLVisit sometimes fails to fire a
    /// departure when the user steps out for a short trip and returns —
    /// without this, the home/work visit can swallow the entire side trip
    /// (e.g. a 1h coffee outing showed up as overlapping the home stay).
    private let openVisitDepartureRadiusKm: Double = 0.2  // 200m
    private let openVisitDepartureGraceS: TimeInterval = 300 // 5 min away

    @MainActor
    private func closeOpenVisitIfMovedAway(lat: Double, lon: Double, timestamp: Date) {
        guard let openId = currentVisitLocalId, let ctx = modelContext else { return }
        let descriptor = FetchDescriptor<CachedLocationSegment>(
            predicate: #Predicate { $0.localId == openId }
        )
        guard let open = try? ctx.fetch(descriptor).first, open.departedAt == nil else { return }
        let dist = haversineKm(lat, lon, open.latitude, open.longitude)
        guard dist > openVisitDepartureRadiusKm else { return }
        // Backdate the departure so this transit waypoint sits AFTER the
        // visit, not within it. The grace window approximates how long it
        // took us to notice we'd left (since significant-location changes
        // don't fire instantly).
        let synthDep = timestamp.addingTimeInterval(-openVisitDepartureGraceS)
        let safeDep = max(synthDep, open.arrivedAt.addingTimeInterval(60))
        open.departedAt = safeDep
        if open.synced {
            open.needsDepartureUpdate = true
            open.synced = false
        }
        try? ctx.save()
        currentVisitLocalId = nil
        currentContext = nil
    }

    @MainActor
    private func handleTransitWaypoint(lat: Double, lon: Double, accuracy: Double, timestamp: Date) async {
        // Close any open visit that this waypoint is far from. Must run on
        // every waypoint, not just recorded ones, so the visit closes
        // promptly even if dedupe later short-circuits the record.
        closeOpenVisitIfMovedAway(lat: lat, lon: lon, timestamp: timestamp)

        guard let last = lastTransitTimestamp else {
            // First sample ever — always record
            recordTransit(lat: lat, lon: lon, accuracy: accuracy, timestamp: timestamp)
            return
        }

        let elapsed = timestamp.timeIntervalSince(last)
        if elapsed < transitMinInterval { return }

        let moved = lastRecordedLat == nil ||
            haversineKm(lat, lon, lastRecordedLat!, lastRecordedLon!) > sameLocationKm

        if moved {
            recordTransit(lat: lat, lon: lon, accuracy: accuracy, timestamp: timestamp)
        } else if elapsed >= heartbeatInterval {
            recordTransit(lat: lat, lon: lon, accuracy: accuracy, timestamp: timestamp)
        }
        // Same place, within heartbeat window → skip
    }

    @MainActor
    private func recordTransit(lat: Double, lon: Double, accuracy: Double, timestamp: Date) {
        lastTransitTimestamp = timestamp
        let moved = lastRecordedLat != nil &&
            haversineKm(lat, lon, lastRecordedLat!, lastRecordedLon!) > sameLocationKm
        lastRecordedLat = lat
        lastRecordedLon = lon
        if moved { stationarySkipCount = 0 }

        guard let ctx = modelContext else { return }

        let segment = CachedLocationSegment(
            segmentType: "transit", latitude: lat, longitude: lon, accuracyM: accuracy,
            arrivedAt: timestamp, departedAt: nil,
            activity: lastActivityType, confidence: nil,
            placeName: nil, placeType: "transit",
            address: nil, neighborhood: nil, city: nil
        )
        ctx.insert(segment)
        try? ctx.save()

        if currentVisitLocalId == nil {
            currentContext = LocationContext(
                placeName: nil,
                activity: lastActivityType ?? "unknown",
                arrivedAt: timestamp
            )
        }

        // Update LocationManager's lastKnownLocation for message metadata
        LocationManager.shared.lastKnownLocation = LocationManager.LocationResult(
            latitude: lat, longitude: lon, accuracy: accuracy, timestamp: timestamp
        )
    }

    // MARK: - Activity monitoring

    /// Shared CMMotionActivity → string mapping. Used here and by
    /// PhoneContextPublisher's one-shot motion read.
    static func motionType(from activity: CMMotionActivity) -> String {
        if activity.automotive { return "driving" }
        if activity.cycling { return "cycling" }
        if activity.running { return "running" }
        if activity.walking { return "walking" }
        if activity.stationary { return "stationary" }
        return "unknown"
    }

    private func startActivityMonitoring() {
        guard CMMotionActivityManager.isActivityAvailable() else {
            print("[LocationTracker] Motion activity not available")
            return
        }

        motionManager.startActivityUpdates(to: .main) { [weak self] activity in
            guard let self = self, let activity = activity else { return }

            let type = LocationTracker.motionType(from: activity)
            guard type != self.lastActivityType else { return }
            self.lastActivityType = type
            self.startAccuracyPingTimer()

            if let ctx = self.currentContext {
                self.currentContext = LocationContext(
                    placeName: ctx.placeName,
                    activity: type,
                    arrivedAt: ctx.arrivedAt
                )
            }
        }
    }

    // MARK: - Reverse geocoding

    private struct GeoResult {
        let placeName: String?
        let placeType: String?
        let address: String?
        let neighborhood: String?
        let city: String?
    }

    private func reverseGeocode(lat: Double, lon: Double) async -> GeoResult {
        // Tier 1: Named locations
        if let named = matchNamedLocation(lat: lat, lon: lon) {
            return GeoResult(
                placeName: named.name, placeType: "named",
                address: named.address, neighborhood: nil, city: named.city
            )
        }

        // Tier 2: Apple CLGeocoder
        let location = CLLocation(latitude: lat, longitude: lon)
        do {
            let placemarks = try await geocoder.reverseGeocodeLocation(location)
            guard let pm = placemarks.first else {
                return GeoResult(placeName: nil, placeType: nil, address: nil, neighborhood: nil, city: nil)
            }

            let street = [pm.subThoroughfare, pm.thoroughfare]
                .compactMap { $0 }
                .joined(separator: " ")

            // Deliberately ignore pm.areasOfInterest — CLGeocoder returns
            // low-confidence labels there (e.g. bare borough names like
            // "Manhattan" for an arbitrary West Village address). Only Tier 1
            // (named locations) and the server-side enrich flow are allowed
            // to set POI-level place_type. Client writes "address" at most.
            return GeoResult(
                placeName: street.isEmpty ? nil : street,
                placeType: street.isEmpty ? nil : "address",
                address: street.isEmpty ? nil : street,
                neighborhood: pm.subLocality,
                city: pm.locality
            )
        } catch {
            print("[LocationTracker] Geocoding failed: \(error.localizedDescription)")
            return GeoResult(placeName: nil, placeType: nil, address: nil, neighborhood: nil, city: nil)
        }
    }

    // MARK: - Sync engine

    private let syncBatchSize = 50

    @MainActor
    func flushUnsynced() async {
        guard let ctx = modelContext else { return }

        do {
            try await SupabaseManager.ensureAuthenticated()
        } catch {
            print("[LocationTracker] Auth failed, skipping sync: \(error)")
            return
        }

        let descriptor = FetchDescriptor<CachedLocationSegment>(
            predicate: #Predicate { $0.synced == false }
        )
        guard let unsynced = try? ctx.fetch(descriptor), !unsynced.isEmpty else { return }

        let newInserts = unsynced.filter { !$0.needsDepartureUpdate }
        let departureUpdates = unsynced.filter { $0.needsDepartureUpdate && $0.remoteId != nil }

        // Batch insert in chunks to avoid large payloads on reconnect
        for batchStart in stride(from: 0, to: newInserts.count, by: syncBatchSize) {
            let batchEnd = min(batchStart + syncBatchSize, newInserts.count)
            let batch = Array(newInserts[batchStart..<batchEnd])
            let rows = batch.map { $0.toRow() }
            do {
                let inserted: [SupabaseReturnRow] = try await supabase
                    .from("location_history")
                    .insert(rows)
                    .select("id, arrived_at")
                    .execute()
                    .value

                for (local, remote) in zip(batch, inserted) {
                    local.synced = true
                    local.remoteId = remote.id
                }
                try? ctx.save()
                print("[LocationTracker] Synced batch of \(batch.count) segment(s)")
            } catch {
                print("[LocationTracker] Insert sync failed: \(error)")
                break
            }
        }

        // Update departures
        for segment in departureUpdates {
            guard let departedAt = segment.departedAt else { continue }
            do {
                try await supabase
                    .from("location_history")
                    .update(["departed_at": departedAt.ISO8601Format()])
                    .eq("id", value: segment.remoteId!)
                    .execute()
                segment.needsDepartureUpdate = false
                segment.synced = true
                try? ctx.save()
            } catch {
                print("[LocationTracker] Departure update failed: \(error)")
            }
        }

        pruneOldSegmentsIfNeeded()
    }

    private var lastPruneDate: Date?

    @MainActor
    private func pruneOldSegmentsIfNeeded() {
        if let last = lastPruneDate, Date().timeIntervalSince(last) < 86400 { return }
        guard let ctx = modelContext else { return }
        let cutoff = Date().addingTimeInterval(-7 * 24 * 3600)
        let descriptor = FetchDescriptor<CachedLocationSegment>(
            predicate: #Predicate { $0.synced == true && $0.arrivedAt < cutoff }
        )
        guard let old = try? ctx.fetch(descriptor), !old.isEmpty else {
            lastPruneDate = Date()
            return
        }
        for segment in old {
            ctx.delete(segment)
        }
        try? ctx.save()
        lastPruneDate = Date()
        print("[LocationTracker] Pruned \(old.count) old segment(s)")
    }

    // MARK: - Teardown

    func stopTracking() {
        manager.stopUpdatingLocation()
        manager.stopMonitoringVisits()
        manager.stopMonitoringSignificantLocationChanges()
        #if os(iOS)
        motionManager.stopActivityUpdates()
        #endif
        syncTimer?.invalidate()
        syncTimer = nil
        accuracyPingTimer?.invalidate()
        accuracyPingTimer = nil
        isMonitoring = false
    }

    deinit {
        #if os(iOS)
        motionManager.stopActivityUpdates()
        #endif
        syncTimer?.invalidate()
        accuracyPingTimer?.invalidate()
    }

    // MARK: - Accuracy ping (sleep/wake cycle)

    private var currentPingInterval: TimeInterval = 0
    private var stationarySkipCount = 0
    private let maxStationarySkips = 3

    private func pingIntervalForActivity(_ activity: String?) -> TimeInterval {
        switch activity {
        case "walking", "running", "cycling", "driving":
            return 120
        case "stationary":
            return 300
        default:
            return 180
        }
    }

    /// Briefly bump to high accuracy to force a fresh location callback,
    /// then drop back to cell-radio-only. Skips GPS wake when stationary
    /// and recent pings produced no movement (saves battery).
    private func startAccuracyPingTimer() {
        let interval = pingIntervalForActivity(lastActivityType)
        guard interval != currentPingInterval else { return }
        currentPingInterval = interval
        stationarySkipCount = 0
        accuracyPingTimer?.invalidate()
        accuracyPingTimer = Timer.scheduledTimer(withTimeInterval: interval, repeats: true) { [weak self] _ in
            guard let self else { return }
            if self.lastActivityType == "stationary" && self.stationarySkipCount < self.maxStationarySkips {
                self.stationarySkipCount += 1
                return
            }
            self.stationarySkipCount = 0
            self.manager.desiredAccuracy = kCLLocationAccuracyHundredMeters
            DispatchQueue.main.asyncAfter(deadline: .now() + 6) { [weak self] in
                self?.manager.desiredAccuracy = kCLLocationAccuracyThreeKilometers
            }
        }
    }

    // MARK: - Periodic sync timer

    private func startSyncTimer() {
        syncTimer?.invalidate()
        syncTimer = Timer.scheduledTimer(withTimeInterval: 300, repeats: true) { [weak self] _ in
            Task { @MainActor in
                await self?.flushUnsynced()
            }
        }
    }

    // MARK: - Restore context on launch

    private func restoreCurrentContext() {
        guard let ctx = modelContext else { return }
        let descriptor = FetchDescriptor<CachedLocationSegment>(
            predicate: #Predicate { $0.segmentType == "visit" && $0.departedAt == nil },
            sortBy: [SortDescriptor(\.arrivedAt, order: .reverse)]
        )
        if let open = try? ctx.fetch(descriptor).first {
            currentVisitLocalId = open.localId
            currentContext = LocationContext(
                placeName: open.placeName,
                activity: open.activity ?? "stationary",
                arrivedAt: open.arrivedAt
            )
        }
    }

    // MARK: - App lifecycle

    func onAppForeground() {
        Task { @MainActor in
            await flushUnsynced()
        }
    }
}

#else

// macOS stub — tracking only runs on the user's iPhone
final class LocationTracker {
    static let shared = LocationTracker()
    var currentContext: LocationContext? { nil }
    func startTracking() {}
    func onAppForeground() {}
}

#endif

import Foundation

#if os(iOS)
import HealthKit
import UIKit
import Supabase

/// Reads Apple Health on-device and ships a trimmed, pre-aggregated view to
/// Supabase. Three paths:
///
/// - **Aggregated quantities** (`health_aggregates`): HR, steps, energy, etc.
///   Bucketed daily for last 30d, weekly 30-365d ago, yearly before. Computed
///   on-device via `HKStatisticsCollectionQuery` so we never materialize raw
///   samples in memory (prior design hit the 3.4GB jetsam ceiling).
/// - **Raw categorical events** (`health_samples`, `health_workouts`): sleep
///   stages, heart events, audio-exposure events, fall count, workouts. These
///   are sparse and per-occurrence meaningful, so we keep them as-is with
///   anchored queries + observer-driven sync.
/// - **Clinical records** (`health_clinical_records`): labs, meds, allergies,
///   conditions, immunizations, procedures, vitals, coverage, notes — the
///   FHIR resources Apple Health Records pulls from connected providers.
///   Stored as raw FHIR JSON in a jsonb column, keyed by HKClinicalRecord
///   uuid, pulled via anchored queries on each sync.
///
/// Waveforms (ECG voltage traces) are deliberately not synced.
final class HealthKitManager {
    static let shared = HealthKitManager()
    private init() {}

    private let store = HKHealthStore()
    private let batchSize = 500
    private let anchorKeyPrefix = "merlin.health.anchor."

    // MARK: - Type catalog

    private enum AggStat {
        case sum      // cumulative quantity → sum per bucket
        case discrete // discrete quantity → avg/min/max per bucket
    }

    private enum StatKind: String {
        case sum, avg, min, max
    }

    /// Which tiers to refresh. On launch we backfill everything; on foreground
    /// / observer wake we only touch the "current" bucket per tier (the only
    /// one that can change), cutting upsert volume by ~95%.
    private enum SyncMode { case full, currentOnly }

    /// Quantity types uploaded as pre-aggregated buckets only.
    private let aggregatedQuantities: [(HKQuantityTypeIdentifier, AggStat)] = [
        (.stepCount, .sum),
        (.distanceWalkingRunning, .sum),
        (.distanceCycling, .sum),
        (.flightsClimbed, .sum),
        (.activeEnergyBurned, .sum),
        (.basalEnergyBurned, .sum),
        (.appleExerciseTime, .sum),
        (.appleStandTime, .sum),
        (.heartRate, .discrete),
        (.restingHeartRate, .discrete),
        (.walkingHeartRateAverage, .discrete),
        (.heartRateVariabilitySDNN, .discrete),
        (.respiratoryRate, .discrete),
        (.oxygenSaturation, .discrete),
        (.vo2Max, .discrete),
        (.bodyMass, .discrete),
        (.appleSleepingWristTemperature, .discrete),
    ]

    /// Category types kept as raw samples in `health_samples`.
    private let rawCategoryIds: [HKCategoryTypeIdentifier] = [
        .sleepAnalysis,
        .highHeartRateEvent, .lowHeartRateEvent, .irregularHeartRhythmEvent,
        .environmentalAudioExposureEvent, .headphoneAudioExposureEvent,
    ]

    /// Apple Health Records (clinical) types — FHIR resources from connected
    /// providers. Uploaded to `health_clinical_records` as raw FHIR JSON.
    private let clinicalRecordIds: [HKClinicalTypeIdentifier] = [
        .allergyRecord,
        .conditionRecord,
        .immunizationRecord,
        .labResultRecord,
        .medicationRecord,
        .procedureRecord,
        .vitalSignRecord,
        .coverageRecord,
        .clinicalNoteRecord,
    ]

    private var aggregatedQuantityTypes: [(HKQuantityType, AggStat)] {
        aggregatedQuantities.compactMap { id, stat in
            HKQuantityType.quantityType(forIdentifier: id).map { ($0, stat) }
        }
    }

    private var rawSampleTypes: [HKSampleType] {
        var out: [HKSampleType] = [HKObjectType.workoutType()]
        for id in rawCategoryIds {
            if let t = HKCategoryType.categoryType(forIdentifier: id) { out.append(t) }
        }
        if let fallen = HKQuantityType.quantityType(forIdentifier: .numberOfTimesFallen) {
            out.append(fallen)
        }
        // watchOS 11 / iOS 18 sleep apnea screening — accelerometer-based
        // breathing disturbance detection. Count of nightly elevated-disturbance
        // events; Apple needs ~30 nights of sleep tracking on the wrist before
        // populating this. iOS 17 deployment target → guard at runtime. Apple
        // ships this as a quantity (count), not a category.
        if #available(iOS 18.0, macOS 15.0, *) {
            if let t = HKQuantityType.quantityType(forIdentifier: .appleSleepingBreathingDisturbances) {
                out.append(t)
            }
        }
        return out
    }

    private var clinicalSampleTypes: [HKClinicalType] {
        clinicalRecordIds.compactMap { HKObjectType.clinicalType(forIdentifier: $0) }
    }

    private var allReadTypes: Set<HKObjectType> {
        var s: Set<HKObjectType> = [HKObjectType.workoutType()]
        for (t, _) in aggregatedQuantityTypes { s.insert(t) }
        for t in rawSampleTypes { s.insert(t) }
        for t in clinicalSampleTypes { s.insert(t) }
        return s
    }

    // MARK: - Lifecycle

    /// Call once at app launch. Requests auth, enables observers on raw types,
    /// and kicks off aggregate + raw sync.
    func start() {
        guard HKHealthStore.isHealthDataAvailable() else {
            print("[Health] HealthKit not available on this device")
            return
        }
        store.requestAuthorization(toShare: nil, read: allReadTypes) { [weak self] ok, err in
            guard let self = self else { return }
            if let err = err {
                print("[Health] Auth error: \(err.localizedDescription)")
                return
            }
            print("[Health] Authorization complete (granted-some=\(ok))")
            self.installObservers()
            Task { await self.syncAll(reason: "launch") }
        }
    }

    /// Called from scene-phase .active in MerlinApp.
    func syncOnForeground() {
        Task { await self.syncAll(reason: "foreground") }
    }

    /// Wipes persisted anchors for raw-sample types so the next sync re-reads
    /// full history. Aggregates are always recomputed from source by
    /// `HKStatisticsCollectionQuery`, so no anchor applies to them. If
    /// `onlyTypes` is non-nil, only matching identifiers are cleared. Returns
    /// the number of anchor keys cleared. Called from the silent
    /// remote-command channel.
    @discardableResult
    func resetAnchors(onlyTypes: [String]? = nil) -> Int {
        let defaults = UserDefaults.standard
        var cleared = 0
        let allTypes: [HKSampleType] = rawSampleTypes + clinicalSampleTypes
        for type in allTypes {
            if let filter = onlyTypes, !filter.isEmpty {
                let id = type.identifier
                let match = filter.contains { f in
                    id == f || id.hasSuffix(f) || id.lowercased().contains(f.lowercased())
                }
                if !match { continue }
            }
            let key = anchorKeyPrefix + type.identifier
            if defaults.object(forKey: key) != nil {
                defaults.removeObject(forKey: key)
                cleared += 1
            }
        }
        print("[Health] resetAnchors cleared=\(cleared) filter=\(onlyTypes ?? [])")
        return cleared
    }

    // MARK: - Observers (raw types only)

    private func installObservers() {
        for type in rawSampleTypes {
            store.enableBackgroundDelivery(for: type, frequency: .immediate) { _, err in
                if let err = err {
                    print("[Health] bg-delivery \(type.identifier) failed: \(err.localizedDescription)")
                }
            }
            let obs = HKObserverQuery(sampleType: type, predicate: nil) { [weak self] _, completion, err in
                if let err = err {
                    print("[Health] observer \(type.identifier) err: \(err.localizedDescription)")
                    completion()
                    return
                }
                Task {
                    await self?.syncRawType(type, reason: "observer")
                    completion()
                }
            }
            store.execute(obs)
        }
    }

    // MARK: - Top-level sync

    /// Called from app launch + scene-foreground + observer wake. Does a fast
    /// current-bucket refresh (always cheap) + kicks off progressive backfill
    /// if historical work remains. Raw-sample types sync in full (they're
    /// already anchored + bounded).
    private func syncAll(reason: String) async {
        print("[Health] syncAll reason=\(reason)")
        let deviceId = currentDeviceId() ?? "unknown"
        for (type, stat) in aggregatedQuantityTypes {
            await syncAggregatesCurrentBuckets(type: type, stat: stat, deviceId: deviceId)
        }
        for type in rawSampleTypes {
            await syncRawType(type, reason: reason)
        }
        for type in clinicalSampleTypes {
            await syncClinicalType(type, reason: reason, deviceId: deviceId)
        }
        await startProgressiveBackfillIfNeeded(deviceId: deviceId)
    }

    // MARK: - Aggregate path

    private struct Tier {
        let granularity: String
        let interval: DateComponents
        let start: Date  // anchor; also lower bound of the enumerate range
        let end: Date    // exclusive upper bound
    }

    /// Historical tiers: daily (last 30d), weekly (30-365d), yearly (before).
    /// Each `start` is aligned to a natural bucket boundary so `bucket_start`
    /// values are stable across runs (otherwise the PK shifts every day and
    /// we'd accumulate duplicate rows).
    private func historicalTiers(now: Date = Date()) -> [Tier] {
        let cal = calendar()
        let today = cal.startOfDay(for: now)
        let daily30 = cal.date(byAdding: .day, value: -30, to: today)!
        let year1 = cal.date(byAdding: .day, value: -365, to: today)!
        let weeklyStart = startOfWeek(year1, cal: cal)
        let yearlyStart = startOfYear(
            cal.date(from: DateComponents(year: 2010, month: 1, day: 1))!, cal: cal
        )
        return [
            Tier(granularity: StatGranularity.daily.rawValue,
                 interval: DateComponents(day: 1),
                 start: daily30, end: today),
            Tier(granularity: StatGranularity.weekly.rawValue,
                 interval: DateComponents(weekOfYear: 1),
                 start: weeklyStart, end: startOfWeek(daily30, cal: cal)),
            Tier(granularity: StatGranularity.yearly.rawValue,
                 interval: DateComponents(year: 1),
                 start: yearlyStart, end: startOfYear(year1, cal: cal)),
        ]
    }

    /// The three current (still-mutable) buckets: today, this week, this year.
    /// These change as data lands throughout the day, so we refresh them on
    /// every `syncAll`.
    private func currentBucketTiers(now: Date = Date()) -> [Tier] {
        let cal = calendar()
        let today = cal.startOfDay(for: now)
        let tomorrow = cal.date(byAdding: .day, value: 1, to: today)!
        let weekStart = startOfWeek(now, cal: cal)
        let weekEnd = cal.date(byAdding: .weekOfYear, value: 1, to: weekStart)!
        let yearStart = startOfYear(now, cal: cal)
        let yearEnd = cal.date(byAdding: .year, value: 1, to: yearStart)!
        return [
            Tier(granularity: StatGranularity.daily.rawValue,
                 interval: DateComponents(day: 1), start: today, end: tomorrow),
            Tier(granularity: StatGranularity.weekly.rawValue,
                 interval: DateComponents(weekOfYear: 1), start: weekStart, end: weekEnd),
            Tier(granularity: StatGranularity.yearly.rawValue,
                 interval: DateComponents(year: 1), start: yearStart, end: yearEnd),
        ]
    }

    private func syncAggregatesCurrentBuckets(type: HKQuantityType, stat: AggStat, deviceId: String) async {
        for tier in currentBucketTiers() {
            await syncAggregateTier(type: type, stat: stat, tier: tier, deviceId: deviceId)
        }
    }

    private func syncAggregateTier(type: HKQuantityType, stat: AggStat, tier: Tier, deviceId: String) async {
        guard tier.start < tier.end else { return }
        let unit = canonicalUnit(for: type)
        let unitString = unit.unitString
        let options: HKStatisticsOptions = (stat == .sum)
            ? [.cumulativeSum]
            : [.discreteAverage, .discreteMin, .discreteMax]

        // For sum types the only stat is sum; for discrete types we emit avg/min/max.
        let extractors: [(StatKind, (HKStatistics) -> HKQuantity?)] = (stat == .sum)
            ? [(.sum, { $0.sumQuantity() })]
            : [(.avg, { $0.averageQuantity() }),
               (.min, { $0.minimumQuantity() }),
               (.max, { $0.maximumQuantity() })]

        var rows: [AggregateRow] = []
        do {
            let stats = try await runStatsCollection(
                type: type, options: options,
                anchor: tier.start, interval: tier.interval
            )
            stats.enumerateStatistics(from: tier.start, to: tier.end) { s, _ in
                let start = self.iso.string(from: s.startDate)
                let end = self.iso.string(from: s.endDate)
                for (kind, extract) in extractors {
                    guard let q = extract(s) else { continue }
                    rows.append(AggregateRow(
                        device_id: deviceId, hk_type: type.identifier,
                        granularity: tier.granularity,
                        bucket_start: start, bucket_end: end,
                        stat: kind.rawValue, value: q.doubleValue(for: unit), unit: unitString
                    ))
                }
            }
        } catch {
            print("[Health] agg \(type.identifier) \(tier.granularity) failed: \(error.localizedDescription)")
            return
        }

        guard !rows.isEmpty else { return }
        do {
            try await sendBatches(rows, table: "health_aggregates",
                                  conflict: "device_id,hk_type,granularity,bucket_start,stat")
        } catch {
            print("[Health] agg \(type.identifier) upload failed: \(error.localizedDescription)")
        }
    }

    // MARK: - Progressive backfill

    private enum StatGranularity: String { case daily, weekly, yearly }

    private let backfillDoneKey = "merlin.health.backfill.done"
    private let backfillCycleDelay: UInt64 = 8 * 1_000_000_000 // 8s between chunks
    private var backfillTask: Task<Void, Never>?

    /// Keys like `"HKQuantityTypeIdentifierHeartRate|weekly"` that finished backfill.
    private func loadBackfillDone() -> Set<String> {
        Set(UserDefaults.standard.stringArray(forKey: backfillDoneKey) ?? [])
    }

    private func saveBackfillDone(_ done: Set<String>) {
        UserDefaults.standard.set(Array(done), forKey: backfillDoneKey)
    }

    /// Starts a long-running, self-paced task that chips through historical
    /// buckets one (type, granularity) pair per cycle. Cheap per cycle: one
    /// `HKStatisticsCollectionQuery` (already aggregated by HK) + one upsert
    /// batch. Persists progress so a killed app resumes where it left off.
    ///
    /// MainActor-isolated guard prevents a second launch racing in from
    /// concurrent `syncAll` callers (launch vs. scene-foreground). Tier
    /// boundaries are computed from a single captured `now` so a run that
    /// crosses midnight doesn't skip the day that slid out from under the
    /// daily window.
    @MainActor
    private func startProgressiveBackfillIfNeeded(deviceId: String) {
        if backfillTask != nil { return }
        let pending = pendingBackfillPairs()
        if pending.isEmpty { return }
        let frozenNow = Date()
        let tiersByGranularity = Dictionary(
            uniqueKeysWithValues: historicalTiers(now: frozenNow).map { ($0.granularity, $0) }
        )
        print("[Health] backfill queue: \(pending.count) pairs")
        backfillTask = Task { [weak self] in
            guard let self = self else { return }
            for (typeId, stat, granularity) in pending {
                if Task.isCancelled { break }
                guard let type = HKQuantityType.quantityType(
                    forIdentifier: HKQuantityTypeIdentifier(rawValue: typeId)
                ) else { continue }
                guard let tier = tiersByGranularity[granularity] else { continue }
                await self.syncAggregateTier(type: type, stat: stat, tier: tier, deviceId: deviceId)
                var done = self.loadBackfillDone()
                done.insert(self.backfillKey(typeId: typeId, granularity: granularity))
                self.saveBackfillDone(done)
                print("[Health] backfill done \(typeId)|\(granularity)")
                try? await Task.sleep(nanoseconds: self.backfillCycleDelay)
            }
            await MainActor.run { self.backfillTask = nil }
            print("[Health] backfill complete")
        }
    }

    private func pendingBackfillPairs() -> [(String, AggStat, String)] {
        let done = loadBackfillDone()
        var out: [(String, AggStat, String)] = []
        for (type, stat) in aggregatedQuantityTypes {
            for g in [StatGranularity.daily, .weekly, .yearly] {
                let key = backfillKey(typeId: type.identifier, granularity: g.rawValue)
                if !done.contains(key) {
                    out.append((type.identifier, stat, g.rawValue))
                }
            }
        }
        return out
    }

    private func backfillKey(typeId: String, granularity: String) -> String {
        "\(typeId)|\(granularity)"
    }

    // MARK: - Statistics query runner

    private func runStatsCollection(
        type: HKQuantityType,
        options: HKStatisticsOptions,
        anchor: Date,
        interval: DateComponents
    ) async throws -> HKStatisticsCollection {
        try await withCheckedThrowingContinuation { cont in
            let q = HKStatisticsCollectionQuery(
                quantityType: type,
                quantitySamplePredicate: nil,
                options: options,
                anchorDate: anchor,
                intervalComponents: interval
            )
            q.initialResultsHandler = { _, result, error in
                if let error = error { cont.resume(throwing: error); return }
                guard let result = result else {
                    cont.resume(throwing: NSError(domain: "Health", code: -1))
                    return
                }
                cont.resume(returning: result)
            }
            store.execute(q)
        }
    }

    // MARK: - Calendar helpers

    private func calendar() -> Calendar {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone.current
        return cal
    }

    private func startOfWeek(_ date: Date, cal: Calendar) -> Date {
        let comps = cal.dateComponents([.yearForWeekOfYear, .weekOfYear], from: date)
        return cal.date(from: comps) ?? cal.startOfDay(for: date)
    }

    private func startOfYear(_ date: Date, cal: Calendar) -> Date {
        let comps = cal.dateComponents([.year], from: date)
        return cal.date(from: comps) ?? cal.startOfDay(for: date)
    }

    // MARK: - Raw path

    private let queryChunkSize = 2000

    private func syncRawType(_ type: HKSampleType, reason: String) async {
        let anchorKey = anchorKeyPrefix + type.identifier
        var currentAnchor = loadAnchor(anchorKey)
        let deviceId = currentDeviceId() ?? "unknown"
        var totalUploaded = 0

        do {
            while true {
                let (samples, newAnchor) = try await runAnchoredQuery(
                    type: type, anchor: currentAnchor, limit: queryChunkSize
                )
                if samples.isEmpty {
                    if let newAnchor = newAnchor { saveAnchor(anchorKey, newAnchor) }
                    break
                }
                if type is HKWorkoutType {
                    try await uploadWorkouts(samples.compactMap { $0 as? HKWorkout }, deviceId: deviceId)
                } else {
                    try await uploadSamples(samples, type: type, deviceId: deviceId)
                }
                totalUploaded += samples.count
                if let newAnchor = newAnchor {
                    saveAnchor(anchorKey, newAnchor)
                    currentAnchor = newAnchor
                }
                if samples.count < queryChunkSize { break }
            }
            if totalUploaded > 0 {
                print("[Health] raw \(type.identifier): +\(totalUploaded) (reason=\(reason))")
            }
        } catch {
            print("[Health] raw \(type.identifier) failed: \(error.localizedDescription)")
        }
    }

    private func runAnchoredQuery(
        type: HKSampleType,
        anchor: HKQueryAnchor?,
        limit: Int
    ) async throws -> ([HKSample], HKQueryAnchor?) {
        try await withCheckedThrowingContinuation { cont in
            let q = HKAnchoredObjectQuery(
                type: type, predicate: nil, anchor: anchor,
                limit: limit
            ) { _, samples, _, newAnchor, error in
                if let error = error { cont.resume(throwing: error); return }
                cont.resume(returning: (samples ?? [], newAnchor))
            }
            store.execute(q)
        }
    }

    // MARK: - Upload rows

    private struct AggregateRow: Encodable {
        let device_id: String
        let hk_type: String
        let granularity: String
        let bucket_start: String
        let bucket_end: String
        let stat: String
        let value: Double
        let unit: String?
    }

    private struct SampleRow: Encodable {
        let hk_uuid: String
        let device_id: String
        let hk_type: String
        let start_date: String
        let end_date: String
        let value: Double?
        let unit: String?
        let source_name: String?
        let source_bundle_id: String?
        let metadata: [String: String]?
    }

    private struct WorkoutRow: Encodable {
        let hk_uuid: String
        let device_id: String
        let activity_type: String
        let start_date: String
        let end_date: String
        let duration_s: Double
        let total_energy_kcal: Double?
        let total_distance_m: Double?
        let source_name: String?
        let source_bundle_id: String?
        let metadata: [String: String]?
    }

    private func uploadSamples(_ samples: [HKSample], type: HKSampleType, deviceId: String) async throws {
        let typeId = type.identifier
        var rows: [SampleRow] = []
        rows.reserveCapacity(samples.count)
        for s in samples {
            let (val, unit) = extractValue(from: s, type: type)
            rows.append(SampleRow(
                hk_uuid: s.uuid.uuidString,
                device_id: deviceId,
                hk_type: typeId,
                start_date: iso.string(from: s.startDate),
                end_date: iso.string(from: s.endDate),
                value: val,
                unit: unit,
                source_name: s.sourceRevision.source.name,
                source_bundle_id: s.sourceRevision.source.bundleIdentifier,
                metadata: s.metadata?.compactMapValues { "\($0)" }
            ))
        }
        try await sendBatches(rows, table: "health_samples", conflict: "hk_uuid")
    }

    // MARK: - Clinical records

    private struct ClinicalRow: Encodable {
        let hk_uuid: String
        let device_id: String
        let hk_clinical_type: String
        let fhir_resource_type: String?
        let fhir_id: String?
        let fhir_version: String?
        let display_name: String?
        let received_date: String
        let source_name: String?
        let source_bundle_id: String?
        let fhir_json: AnyJSON
    }

    private func syncClinicalType(_ type: HKClinicalType, reason: String, deviceId: String) async {
        let anchorKey = anchorKeyPrefix + type.identifier
        var currentAnchor = loadAnchor(anchorKey)
        var totalUploaded = 0
        do {
            while true {
                let (samples, newAnchor) = try await runAnchoredQuery(
                    type: type, anchor: currentAnchor, limit: queryChunkSize
                )
                if samples.isEmpty {
                    if let newAnchor = newAnchor { saveAnchor(anchorKey, newAnchor) }
                    break
                }
                let records = samples.compactMap { $0 as? HKClinicalRecord }
                try await uploadClinicalRecords(records, deviceId: deviceId)
                totalUploaded += records.count
                if let newAnchor = newAnchor {
                    saveAnchor(anchorKey, newAnchor)
                    currentAnchor = newAnchor
                }
                if samples.count < queryChunkSize { break }
            }
            if totalUploaded > 0 {
                print("[Health] clinical \(type.identifier): +\(totalUploaded) (reason=\(reason))")
            }
        } catch {
            print("[Health] clinical \(type.identifier) failed: \(error.localizedDescription)")
        }
    }

    private func uploadClinicalRecords(_ records: [HKClinicalRecord], deviceId: String) async throws {
        var rows: [ClinicalRow] = []
        rows.reserveCapacity(records.count)
        for r in records {
            guard let fhir = r.fhirResource, !fhir.data.isEmpty else {
                // Skip records without FHIR payload — HealthKit can't tell us
                // anything useful about them. This happens for a few legacy
                // clinical types that were written before FHIR support.
                continue
            }
            let jsonObj = (try? JSONSerialization.jsonObject(with: fhir.data)) as? [String: Any]
            let resourceType = jsonObj?["resourceType"] as? String ?? fhir.resourceType.rawValue
            let fhirId = jsonObj?["id"] as? String ?? fhir.identifier
            let anyJson: AnyJSON
            do {
                anyJson = try JSONDecoder().decode(AnyJSON.self, from: fhir.data)
            } catch {
                print("[Health] clinical \(r.uuid) FHIR decode failed: \(error.localizedDescription) — skipping")
                continue
            }
            rows.append(ClinicalRow(
                hk_uuid: r.uuid.uuidString,
                device_id: deviceId,
                hk_clinical_type: r.clinicalType.identifier,
                fhir_resource_type: resourceType,
                fhir_id: fhirId,
                fhir_version: fhir.fhirVersion.stringRepresentation,
                display_name: r.displayName,
                received_date: iso.string(from: r.startDate),
                source_name: r.sourceRevision.source.name,
                source_bundle_id: r.sourceRevision.source.bundleIdentifier,
                fhir_json: anyJson
            ))
        }
        try await sendBatches(rows, table: "health_clinical_records", conflict: "hk_uuid")
    }

    private func uploadWorkouts(_ workouts: [HKWorkout], deviceId: String) async throws {
        var rows: [WorkoutRow] = []
        for w in workouts {
            rows.append(WorkoutRow(
                hk_uuid: w.uuid.uuidString,
                device_id: deviceId,
                activity_type: String(describing: w.workoutActivityType),
                start_date: iso.string(from: w.startDate),
                end_date: iso.string(from: w.endDate),
                duration_s: w.duration,
                total_energy_kcal: w.totalEnergyBurned?.doubleValue(for: .kilocalorie()),
                total_distance_m: w.totalDistance?.doubleValue(for: .meter()),
                source_name: w.sourceRevision.source.name,
                source_bundle_id: w.sourceRevision.source.bundleIdentifier,
                metadata: w.metadata?.compactMapValues { "\($0)" }
            ))
        }
        try await sendBatches(rows, table: "health_workouts", conflict: "hk_uuid")
    }

    private func sendBatches<T: Encodable>(_ rows: [T], table: String, conflict: String) async throws {
        guard !rows.isEmpty else { return }
        try await SupabaseManager.ensureAuthenticated()
        for chunk in rows.chunked(into: batchSize) {
            try await SupabaseManager.shared
                .from(table)
                .upsert(chunk, onConflict: conflict, ignoreDuplicates: false)
                .execute()
        }
    }

    // MARK: - Value extraction (raw samples)

    private func extractValue(from sample: HKSample, type: HKSampleType) -> (Double?, String?) {
        if let q = sample as? HKQuantitySample, let qt = type as? HKQuantityType {
            let unit = canonicalUnit(for: qt)
            return (q.quantity.doubleValue(for: unit), unit.unitString)
        }
        if let c = sample as? HKCategorySample {
            return (Double(c.value), "category")
        }
        return (nil, nil)
    }

    private func canonicalUnit(for qt: HKQuantityType) -> HKUnit {
        switch qt.identifier {
        case HKQuantityTypeIdentifier.heartRate.rawValue,
             HKQuantityTypeIdentifier.restingHeartRate.rawValue,
             HKQuantityTypeIdentifier.walkingHeartRateAverage.rawValue,
             HKQuantityTypeIdentifier.respiratoryRate.rawValue:
            return HKUnit.count().unitDivided(by: .minute())
        case HKQuantityTypeIdentifier.heartRateVariabilitySDNN.rawValue:
            return .secondUnit(with: .milli)
        case HKQuantityTypeIdentifier.stepCount.rawValue,
             HKQuantityTypeIdentifier.flightsClimbed.rawValue,
             HKQuantityTypeIdentifier.numberOfTimesFallen.rawValue:
            return .count()
        case HKQuantityTypeIdentifier.distanceWalkingRunning.rawValue,
             HKQuantityTypeIdentifier.distanceCycling.rawValue:
            return .meter()
        case HKQuantityTypeIdentifier.activeEnergyBurned.rawValue,
             HKQuantityTypeIdentifier.basalEnergyBurned.rawValue:
            return .kilocalorie()
        case HKQuantityTypeIdentifier.appleExerciseTime.rawValue,
             HKQuantityTypeIdentifier.appleStandTime.rawValue:
            return .minute()
        case HKQuantityTypeIdentifier.vo2Max.rawValue:
            return HKUnit(from: "ml/kg*min")
        case HKQuantityTypeIdentifier.oxygenSaturation.rawValue:
            return .percent()
        case HKQuantityTypeIdentifier.appleSleepingWristTemperature.rawValue:
            return .degreeCelsius()
        case HKQuantityTypeIdentifier.bodyMass.rawValue:
            return .gramUnit(with: .kilo)
        default:
            print("[Health] WARNING: no canonical unit for \(qt.identifier) — defaulting to count")
            return .count()
        }
    }

    // MARK: - Anchors, device id, shared ISO formatter

    private let iso: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    private func loadAnchor(_ key: String) -> HKQueryAnchor? {
        guard let data = UserDefaults.standard.data(forKey: key) else { return nil }
        return try? NSKeyedUnarchiver.unarchivedObject(ofClass: HKQueryAnchor.self, from: data)
    }

    private func saveAnchor(_ key: String, _ anchor: HKQueryAnchor) {
        if let data = try? NSKeyedArchiver.archivedData(withRootObject: anchor, requiringSecureCoding: true) {
            UserDefaults.standard.set(data, forKey: key)
        }
    }

    private func currentDeviceId() -> String? {
        if let token = UserDefaults.standard.string(forKey: "merlin.apnsDeviceToken"),
           !token.isEmpty {
            return token
        }
        return UIDevice.current.identifierForVendor?.uuidString
    }
}

private extension Array {
    func chunked(into size: Int) -> [[Element]] {
        guard size > 0 else { return [self] }
        return stride(from: 0, to: count, by: size).map {
            Array(self[$0..<Swift.min($0 + size, count)])
        }
    }
}

#endif

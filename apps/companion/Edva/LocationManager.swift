import Foundation
import CoreLocation

private let isoFormatter: ISO8601DateFormatter = {
    let f = ISO8601DateFormatter()
    return f
}()

@MainActor
final class LocationManager: NSObject, CLLocationManagerDelegate {
    static let shared = LocationManager()

    private let manager = CLLocationManager()
    private var continuation: CheckedContinuation<LocationResult, Never>?
    internal(set) var lastKnownLocation: LocationResult?

    struct LocationResult {
        let latitude: Double
        let longitude: Double
        let accuracy: Double
        let timestamp: Date

        var metadataStrings: [String: String] {
            [
                "latitude": "\(latitude)",
                "longitude": "\(longitude)",
                "location_accuracy": "\(accuracy)",
                "location_timestamp": isoFormatter.string(from: timestamp),
            ]
        }
    }

    enum LocationError: Error {
        case denied
        case failed(String)
    }

    override init() {
        super.init()
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyBest
        manager.requestWhenInUseAuthorization()
        manager.startMonitoringSignificantLocationChanges()
    }

    func getCurrentLocation() async -> Result<LocationResult, LocationError> {
        let status = manager.authorizationStatus
        if status == .notDetermined {
            manager.requestWhenInUseAuthorization()
            try? await Task.sleep(nanoseconds: 1_000_000_000)
        }

        let currentStatus = manager.authorizationStatus
        #if os(macOS)
        let isAuthorized = currentStatus == .authorized
        #else
        let isAuthorized = currentStatus == .authorizedWhenInUse || currentStatus == .authorizedAlways
        #endif
        guard isAuthorized else {
            return .failure(.denied)
        }

        let result = await withCheckedContinuation { (cont: CheckedContinuation<LocationResult, Never>) in
            self.continuation = cont
            self.manager.requestLocation()
        }
        return .success(result)
    }

    // MARK: - CLLocationManagerDelegate

    nonisolated func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let location = locations.last else { return }
        let result = LocationResult(
            latitude: location.coordinate.latitude,
            longitude: location.coordinate.longitude,
            accuracy: location.horizontalAccuracy,
            timestamp: location.timestamp
        )
        Task { @MainActor in
            self.lastKnownLocation = result
            guard let cont = self.continuation else { return }
            self.continuation = nil
            cont.resume(returning: result)
        }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        Task { @MainActor in
            guard let cont = self.continuation else { return }
            self.continuation = nil
            cont.resume(returning: LocationResult(
                latitude: 0,
                longitude: 0,
                accuracy: -1,
                timestamp: Date()
            ))
        }
    }
}

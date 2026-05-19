import Foundation

#if os(iOS)
import UIKit
import CoreMotion
import Supabase

/// Publishes the device's current motion + Wi-Fi snapshot to the Supabase
/// `phone_context` table (single-row-per-device upsert).
enum PhoneContextPublisher {

    enum Trigger: String { case foreground, visit }

    private static let foregroundMinIntervalSeconds: TimeInterval = 5 * 60
    private static let lastForegroundKey = "merlin.lastAudioPublishAt.foreground"

    /// Debounced foreground publisher; skips if the previous publish fired in
    /// the last 5 minutes.
    static func publishOnForeground() async {
        // First-of-day unlock signal runs independently of the 5-min debounce —
        // it's a cheap row insert that feeds daily-summary's wake-time field.
        await recordFirstUnlockIfNeeded()

        let last = UserDefaults.standard.double(forKey: lastForegroundKey)
        let now = Date().timeIntervalSince1970
        if last > 0, now - last < foregroundMinIntervalSeconds { return }
        UserDefaults.standard.set(now, forKey: lastForegroundKey)
        await publish(trigger: .foreground)
    }

    /// Writes one row to `phone_unlocks` the first time the user opens the app
    /// on a given local date. The (device_id, date) primary key makes repeat
    /// calls no-ops. Daily-summary reads the earliest row to compute wake-time.
    private static func recordFirstUnlockIfNeeded() async {
        let fmt = DateFormatter()
        fmt.dateFormat = "yyyy-MM-dd"
        fmt.timeZone = .current
        let today = fmt.string(from: Date())

        let lastKey = "merlin.firstUnlockDate"
        if UserDefaults.standard.string(forKey: lastKey) == today { return }

        guard let deviceId = await currentDeviceId() else { return }

        struct UnlockRow: Encodable {
            let device_id: String
            let date: String
            let first_unlock_at: String
            let tz: String
        }

        let row = UnlockRow(
            device_id: deviceId,
            date: today,
            first_unlock_at: ISO8601DateFormatter().string(from: Date()),
            tz: TimeZone.current.identifier
        )

        do {
            try await SupabaseManager.ensureAuthenticated()
            try await SupabaseManager.shared
                .from("phone_unlocks")
                .upsert(row, onConflict: "device_id,date", ignoreDuplicates: true)
                .execute()
            UserDefaults.standard.set(today, forKey: lastKey)
            print("[PhoneContext] first-unlock logged for \(today)")
        } catch {
            print("[PhoneContext] first-unlock insert failed: \(error.localizedDescription)")
        }
    }

    /// Upsert a motion + Wi-Fi snapshot for this device.
    static func publish(trigger: Trigger, latitude: Double? = nil, longitude: Double? = nil) async {
        let motionClass = await currentMotionClass() ?? "unknown"
        let wifi = await WiFiContext.fetchCurrent()

        guard let deviceId = await currentDeviceId() else {
            print("[PhoneContext] no device id available; skipping publish")
            return
        }

        let row = PhoneContextRow(
            device_id: deviceId,
            motion_class: motionClass,
            latitude: latitude,
            longitude: longitude,
            wifi_ssid: wifi.ssid,
            wifi_bssid: wifi.bssid,
            trigger: trigger.rawValue,
            ts: ISO8601DateFormatter().string(from: Date())
        )

        do {
            try await SupabaseManager.ensureAuthenticated()
            try await SupabaseManager.shared
                .from("phone_context")
                .upsert(row, onConflict: "device_id")
                .execute()
            print("[PhoneContext] published trigger=\(trigger.rawValue) motion=\(motionClass) wifi=\(wifi.ssid ?? "-")")
        } catch {
            print("[PhoneContext] upsert failed: \(error.localizedDescription)")
        }
    }

    /// Stable per-device identifier. Prefers the APNs token (also used by
    /// `device_tokens`) so all server-side keys agree. Falls back to
    /// `identifierForVendor` when APNs hasn't yet registered.
    private static func currentDeviceId() async -> String? {
        if let token = UserDefaults.standard.string(forKey: "merlin.apnsDeviceToken"),
           !token.isEmpty {
            return token
        }
        return await MainActor.run { UIDevice.current.identifierForVendor?.uuidString }
    }

    /// Single-shot motion read from CMMotionActivityManager's 2-second history.
    private static func currentMotionClass() async -> String? {
        guard CMMotionActivityManager.isActivityAvailable() else { return nil }
        let manager = CMMotionActivityManager()
        return await withCheckedContinuation { cont in
            manager.queryActivityStarting(
                from: Date().addingTimeInterval(-2),
                to: Date(),
                to: .main
            ) { activities, _ in
                guard let last = activities?.last else { cont.resume(returning: nil); return }
                cont.resume(returning: LocationTracker.motionType(from: last))
            }
        }
    }

    private struct PhoneContextRow: Encodable {
        let device_id: String
        let motion_class: String
        let latitude: Double?
        let longitude: Double?
        let wifi_ssid: String?
        let wifi_bssid: String?
        let trigger: String
        let ts: String
    }
}

#endif

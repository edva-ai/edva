import Foundation

#if os(iOS)
import NetworkExtension

/// One-shot read of the device's current Wi-Fi SSID + BSSID. Far more reliable
/// than GPS for the binary "am I home / away" question — SSID has no jitter,
/// no indoor drift, and instant switch on Wi-Fi handoff. Returns nil when not
/// associated to a network, on cellular, or when the entitlement / Location
/// permission gate hasn't been granted.
///
/// Requires `com.apple.developer.networking.wifi-info` (set in
/// Merlin.entitlements) AND any of: a configured Wi-Fi via NEHotspotConfiguration,
/// the active VPN configuration's app, or precise-location-while-using granted.
/// If the user has already granted precise location to Merlin, the third path covers us.
enum WiFiContext {

    struct Snapshot {
        let ssid: String?
        let bssid: String?
    }

    /// Fetches the current network. Safe to call on any thread; returns nil
    /// rather than throwing — callers treat absent SSID as "no signal".
    static func fetchCurrent() async -> Snapshot {
        await withCheckedContinuation { cont in
            NEHotspotNetwork.fetchCurrent { network in
                guard let network = network else {
                    cont.resume(returning: Snapshot(ssid: nil, bssid: nil))
                    return
                }
                let ssid = network.ssid.isEmpty ? nil : network.ssid
                let bssid = network.bssid.isEmpty ? nil : network.bssid
                cont.resume(returning: Snapshot(ssid: ssid, bssid: bssid))
            }
        }
    }
}

#endif

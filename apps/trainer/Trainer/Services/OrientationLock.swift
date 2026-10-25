import SwiftUI
import UIKit

/// Per-view orientation gate. The Info.plist allows all orientations, but the
/// app delegate below restricts to portrait except when a view explicitly opts
/// into landscape by changing `OrientationLock.current`.
final class AppDelegate: NSObject, UIApplicationDelegate {
    func application(
        _ application: UIApplication,
        supportedInterfaceOrientationsFor window: UIWindow?
    ) -> UIInterfaceOrientationMask {
        OrientationLock.current
    }

    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        // Request HealthKit authorization and start background delivery into
        // Merlin's Supabase. No-ops gracefully if the user hasn't connected
        // their Merlin account yet — observers + auth are still installed
        // so once they sign in, the next foreground tick uploads the
        // captured anchor delta.
        HealthKitManager.shared.start()
        return true
    }
}

enum OrientationLock {
    nonisolated(unsafe) static var current: UIInterfaceOrientationMask = .portrait

    /// Sets the lock and asks the active window scene to re-evaluate its
    /// geometry so iOS actually rotates without waiting for the user to
    /// physically rotate the device.
    @MainActor
    static func apply(_ mask: UIInterfaceOrientationMask) {
        current = mask
        guard let scene = UIApplication.shared.connectedScenes
            .compactMap({ $0 as? UIWindowScene })
            .first
        else { return }
        scene.requestGeometryUpdate(.iOS(interfaceOrientations: mask))
        scene.keyWindow?.rootViewController?.setNeedsUpdateOfSupportedInterfaceOrientations()
    }
}

/// Modifier used by views that want to unlock landscape while they're on
/// screen (e.g. the illustration viewer). Restores portrait on disappear.
struct AllowAllOrientationsModifier: ViewModifier {
    func body(content: Content) -> some View {
        content
            .onAppear { OrientationLock.apply(.all) }
            .onDisappear { OrientationLock.apply(.portrait) }
    }
}

extension View {
    func allowAllOrientations() -> some View {
        modifier(AllowAllOrientationsModifier())
    }
}

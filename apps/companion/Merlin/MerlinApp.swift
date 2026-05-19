import SwiftUI
import UserNotifications
import Supabase

#if os(macOS)
import AppKit
#else
import UIKit
#endif

@main
struct MerlinApp: App {
    #if os(macOS)
    @NSApplicationDelegateAdaptor(AppDelegate.self) var appDelegate
    #else
    @UIApplicationDelegateAdaptor(AppDelegate.self) var appDelegate
    #endif

    @Environment(\.scenePhase) private var scenePhase

    #if os(macOS)
    @State private var isUnlocked = true
    #else
    @State private var isUnlocked = false
    #endif

    // nil = still checking Keychain for a persisted session; true/false once resolved.
    @State private var isSignedIn: Bool?

    var body: some Scene {
        WindowGroup {
            rootView
                .task { isSignedIn = await SupabaseManager.hasSession() }
        }
        .onChange(of: scenePhase) { _, newPhase in
            #if os(iOS)
            if newPhase == .background {
                isUnlocked = false
            }
            #endif
            if newPhase == .active {
                UNUserNotificationCenter.current().setBadgeCount(0)
                LocationTracker.shared.onAppForeground()
                #if os(iOS)
                Task { await PhoneContextPublisher.publishOnForeground() }
                HealthKitManager.shared.syncOnForeground()
                #endif
            }
        }
    }

    @ViewBuilder
    private var rootView: some View {
        switch isSignedIn {
        case .none:
            // Brief splash while Supabase reads the Keychain session.
            ProgressView()
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        case .some(false):
            SignInView {
                isSignedIn = true
                // Sign-in just happened via OS web auth → skip Face ID for this launch.
                isUnlocked = true
            }
        case .some(true):
            if isUnlocked {
                ContentView(onSignOut: {
                    Task {
                        await SupabaseManager.signOut()
                        await MainActor.run {
                            isSignedIn = false
                            #if os(iOS)
                            isUnlocked = false
                            #endif
                        }
                    }
                })
            } else {
                LockScreen(isUnlocked: $isUnlocked)
            }
        }
    }
}

extension Notification.Name {
    static let openMerlinMessage = Notification.Name("openMerlinMessage")
}

#if os(macOS)

final class AppDelegate: NSObject, NSApplicationDelegate, UNUserNotificationCenterDelegate {
    static var pendingMessageId: UUID?

    private lazy var supabase = SupabaseManager.shared

    func applicationDidBecomeActive(_ notification: Notification) {
        NSApplication.shared.dockTile.badgeLabel = nil
        UNUserNotificationCenter.current().setBadgeCount(0) { _ in }
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        UNUserNotificationCenter.current().delegate = self
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .badge, .sound]) { granted, error in
            if let error = error {
                print("[APNs] Authorization error: \(error)")
                return
            }
            print("[APNs] Permission granted: \(granted)")
            if granted {
                DispatchQueue.main.async {
                    NSApplication.shared.registerForRemoteNotifications()
                }
            }
        }
    }

    func application(_ application: NSApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        let token = deviceToken.map { String(format: "%02x", $0) }.joined()
        print("[APNs] Device token: \(token)")
        saveDeviceToken(token)
    }

    func application(_ application: NSApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        print("[APNs] Failed to register: \(error)")
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        if NSApplication.shared.isActive {
            completionHandler([])
        } else {
            completionHandler([.banner, .sound, .badge])
        }
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        if let idString = response.notification.request.content.userInfo["message_id"] as? String,
           let uuid = UUID(uuidString: idString) {
            AppDelegate.pendingMessageId = uuid
            NotificationCenter.default.post(name: .openMerlinMessage, object: uuid)
        }
        completionHandler()
    }

    private func saveDeviceToken(_ token: String) {
        Task {
            do {
                try await supabase
                    .from("device_tokens")
                    .upsert(
                        ["token": token, "platform": "macos", "updated_at": ISO8601DateFormatter().string(from: Date())],
                        onConflict: "token"
                    )
                    .execute()
                print("[APNs] Token saved to Supabase (platform: macos)")
            } catch {
                print("[APNs] Failed to save token: \(error)")
            }
        }
    }
}

#else

final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    static var pendingMessageId: UUID?

    private lazy var supabase = SupabaseManager.shared

    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        UNUserNotificationCenter.current().delegate = self

        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .badge, .sound]) { granted, error in
            if let error = error {
                print("[APNs] Authorization error: \(error)")
                return
            }
            print("[APNs] Permission granted: \(granted)")
            if granted {
                DispatchQueue.main.async {
                    UIApplication.shared.registerForRemoteNotifications()
                }
            }
        }

        // Start continuous location tracking (visits + activity detection)
        LocationTracker.shared.startTracking()

        // Request HealthKit authorization and start background delivery.
        // Clinical FHIR types were reverted in f39b315 (missing entitlement).
        // Kill-switch removed — the crash was from clinical types, not fitness sync.
        HealthKitManager.shared.start()

        return true
    }

    // Lock both iPhone and iPad to portrait at runtime. The iPad Info.plist
    // entry declares all four orientations because App Store Connect rejects
    // iPad apps with a narrower set ("must support iPad multitasking" — the
    // 2026-05-16 TestFlight upload was bounced for exactly this). Enforcing
    // the lock here keeps the iPad app portrait-only at runtime without
    // failing validation.
    func application(
        _ application: UIApplication,
        supportedInterfaceOrientationsFor window: UIWindow?
    ) -> UIInterfaceOrientationMask {
        .portrait
    }

    func application(
        _ application: UIApplication,
        didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
    ) {
        let token = deviceToken.map { String(format: "%02x", $0) }.joined()
        print("[APNs] Device token: \(token)")
        UserDefaults.standard.set(token, forKey: "merlin.apnsDeviceToken")
        saveDeviceToken(token)
    }

    func application(
        _ application: UIApplication,
        didReceiveRemoteNotification userInfo: [AnyHashable: Any],
        fetchCompletionHandler completionHandler: @escaping (UIBackgroundFetchResult) -> Void
    ) {
        completionHandler(.noData)
    }

    func application(
        _ application: UIApplication,
        didFailToRegisterForRemoteNotificationsWithError error: Error
    ) {
        print("[APNs] Failed to register: \(error)")
    }

    // Suppress notifications when app is in foreground
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        if UIApplication.shared.applicationState == .active {
            completionHandler([])  // silent — message already visible in chat
        } else {
            completionHandler([.banner, .sound, .badge])
        }
    }

    // User tapped a notification — deep-link to the related message
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        if let idString = response.notification.request.content.userInfo["message_id"] as? String,
           let uuid = UUID(uuidString: idString) {
            AppDelegate.pendingMessageId = uuid
            NotificationCenter.default.post(name: .openMerlinMessage, object: uuid)
        }
        completionHandler()
    }

    private func saveDeviceToken(_ token: String) {
        let platform = UIDevice.current.userInterfaceIdiom == .pad ? "ipados" : "ios"

        Task {
            do {
                try await supabase
                    .from("device_tokens")
                    .upsert(
                        ["token": token, "platform": platform, "updated_at": ISO8601DateFormatter().string(from: Date())],
                        onConflict: "token"
                    )
                    .execute()
                print("[APNs] Token saved to Supabase (platform: \(platform))")
            } catch {
                print("[APNs] Failed to save token: \(error)")
            }
        }
    }
}

#endif

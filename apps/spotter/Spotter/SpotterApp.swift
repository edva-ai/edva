import SwiftUI
import SwiftData

@main
struct SpotterApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @State private var auth: AuthService
    @State private var biometric = BiometricAuth()
    @Environment(\.scenePhase) private var scenePhase

    init() {
        let authService = AuthService()
        _auth = State(initialValue: authService)
        AuthServiceHolder.shared = authService
    }

    let modelContainer: ModelContainer = {
        do {
            let schema = Schema(AppSchema.models)
            let config = ModelConfiguration(schema: schema, isStoredInMemoryOnly: false)
            return try ModelContainer(for: schema, configurations: [config])
        } catch {
            fatalError("SwiftData container failed: \(error)")
        }
    }()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(auth)
                .environment(biometric)
                .task {
                    runLaunchHousekeeping(modelContainer.mainContext)
                    _ = await NotificationScheduler.shared.requestAuthorizationIfNeeded()
                    await WorkoutNotesStore.shared.load()
                }
                .onChange(of: scenePhase) { _, newPhase in
                    if newPhase == .active {
                        runLaunchHousekeeping(modelContainer.mainContext)
                        HealthKitManager.shared.syncOnForeground()
                    }
                }
        }
        .modelContainer(modelContainer)
    }

    @MainActor
    private func runLaunchHousekeeping(_ context: ModelContext) {
        PlanScheduler(context: context).seedIfNeeded()
        SessionManager(context: context).closeDanglingSessions()
        try? context.save()
        NotificationScheduler.shared.refreshTodayReminder(context: context)
    }
}

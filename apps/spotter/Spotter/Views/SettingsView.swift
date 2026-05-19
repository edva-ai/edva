import SwiftUI
import SwiftData

struct SettingsView: View {
    @Environment(\.modelContext) private var context
    @Environment(AuthService.self) private var auth
    @Environment(BiometricAuth.self) private var biometric
    @Query private var settingsList: [AppSettings]
    @State private var merlinConnected: Bool? = nil
    @State private var merlinBusy = false
    @State private var merlinError: String?

    private var settings: AppSettings? { settingsList.first }

    var body: some View {
        NavigationStack {
            ZStack {
                AppBackground()
                ScrollView {
                    VStack(spacing: 16) {
                        if let s = settings { preferencesCard(s) }
                        accountCard
                        backendCard
                        merlinHealthCard
                        aboutCard
                        Color.clear.frame(height: 30)
                    }
                    .padding(16)
                }
            }
            .navigationTitle("Settings")
            .toolbarColorScheme(.dark, for: .navigationBar)
            .task { merlinConnected = await SpotterSupabase.hasSession() }
        }
    }

    private func preferencesCard(_ s: AppSettings) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Preferences").font(.headline).foregroundStyle(.white)

            HStack {
                Label("Weight unit", systemImage: "scalemass")
                    .foregroundStyle(.white)
                Spacer()
                Picker("", selection: Binding(
                    get: { s.weightUnit },
                    set: { s.weightUnit = $0; try? context.save() }
                )) {
                    ForEach(WeightUnit.allCases, id: \.self) { u in
                        Text(u.label.uppercased()).tag(u)
                    }
                }
                .pickerStyle(.segmented)
                .frame(width: 140)
            }

            Toggle(isOn: Binding(
                get: { s.restTimerEnabled },
                set: { s.restTimerEnabled = $0; try? context.save() }
            )) {
                Label("Auto rest timer", systemImage: "timer")
                    .foregroundStyle(.white)
            }
            .tint(Color(.systemGreen))

            Toggle(isOn: Binding(
                get: { s.gymAvailableDefault },
                set: { s.gymAvailableDefault = $0; try? context.save() }
            )) {
                Label("Gym available by default", systemImage: "dumbbell.fill")
                    .foregroundStyle(.white)
            }
            .tint(Color(.systemGreen))

            Toggle(isOn: Binding(
                get: { s.remindersEnabled },
                set: { newValue in
                    s.remindersEnabled = newValue
                    try? context.save()
                    let ctx = context
                    Task {
                        if newValue { _ = await NotificationScheduler.shared.requestAuthorizationIfNeeded() }
                        await MainActor.run {
                            NotificationScheduler.shared.refreshTodayReminder(context: ctx)
                        }
                    }
                }
            )) {
                Label("Noon reminder on exercise days", systemImage: "bell.badge")
                    .foregroundStyle(.white)
            }
            .tint(Color(.systemGreen))
        }
        .padding(16)
        .liquidCard()
    }

    private var accountCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Account").font(.headline).foregroundStyle(.white)
            switch auth.state {
            case .ready(let userID):
                VStack(alignment: .leading, spacing: 4) {
                    Text("Anonymous")
                        .foregroundStyle(.white)
                        .font(.body.weight(.semibold))
                    Text(userID.prefix(8) + "…")
                        .foregroundStyle(.white.opacity(0.6))
                        .font(.caption.monospaced())
                }
            case .bootstrapping:
                Text("Connecting…").foregroundStyle(.white.opacity(0.7))
            case .error(let msg):
                Text(msg).foregroundStyle(.orange.opacity(0.9)).font(.caption)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .liquidCard()
    }

    private var backendCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Cloud sync").font(.headline).foregroundStyle(.white)
            HStack(spacing: 10) {
                Circle()
                    .fill(AppConfig.isBackendConfigured ? .green : .red)
                    .frame(width: 10, height: 10)
                Text(AppConfig.isBackendConfigured ? "Supabase configured" : "Supabase not configured")
                    .foregroundStyle(.white.opacity(0.9))
                    .font(.callout)
            }
            Text("Finished sessions sync automatically so Merlin can query your history.")
                .font(.footnote)
                .foregroundStyle(.white.opacity(0.7))
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .liquidCard()
    }

    private var merlinHealthCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Merlin health sync").font(.headline).foregroundStyle(.white)

            HStack(spacing: 10) {
                Circle()
                    .fill(merlinConnected == true ? .green : .gray)
                    .frame(width: 10, height: 10)
                Text(statusLabel)
                    .foregroundStyle(.white.opacity(0.9))
                    .font(.callout)
            }

            Text("Uploads Apple Health metrics, workouts, and clinical records to Merlin's Supabase so your assistant has the same context the Merlin iOS app provides. Spotter is foregrounded longer than Merlin, so this is where most of the sync happens.")
                .font(.footnote)
                .foregroundStyle(.white.opacity(0.7))

            if let msg = merlinError {
                Text(msg).foregroundStyle(.orange.opacity(0.9)).font(.caption)
            }

            HStack {
                if merlinConnected == true {
                    Button("Sign out", role: .destructive) {
                        merlinBusy = true
                        Task {
                            await SpotterSupabase.signOut()
                            merlinConnected = await SpotterSupabase.hasSession()
                            merlinBusy = false
                        }
                    }
                    .disabled(merlinBusy)
                } else {
                    Button("Connect to Merlin") {
                        merlinBusy = true
                        merlinError = nil
                        Task {
                            do {
                                try await SpotterSupabase.signInWithGoogle()
                                merlinConnected = await SpotterSupabase.hasSession()
                                if merlinConnected == true {
                                    HealthKitManager.shared.syncOnForeground()
                                }
                            } catch {
                                merlinError = error.localizedDescription
                            }
                            merlinBusy = false
                        }
                    }
                    .disabled(merlinBusy)
                    .buttonStyle(.borderedProminent)
                    .tint(.green)
                }
                if merlinBusy { ProgressView().tint(.white) }
                Spacer()
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .liquidCard()
    }

    private var statusLabel: String {
        switch merlinConnected {
        case .some(true): return "Connected — syncing to Merlin"
        case .some(false): return "Not connected"
        case .none: return "Checking…"
        }
    }

    private var aboutCard: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Spotter")
                .font(.headline).foregroundStyle(.white)
            Text("Built \(Date.now.formatted(.dateTime.month(.abbreviated).day().year()))")
                .font(.caption).foregroundStyle(.white.opacity(0.6))
            Text("Version \(Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "")")
                .font(.caption).foregroundStyle(.white.opacity(0.7))
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .liquidCard()
    }
}

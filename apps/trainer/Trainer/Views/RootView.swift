import SwiftUI
import SwiftData

struct RootView: View {
    @Environment(AuthService.self) private var auth
    @Environment(BiometricAuth.self) private var biometric
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        Group {
            switch auth.state {
            case .bootstrapping:
                SplashView()
            case .error(let msg):
                ErrorView(message: msg) { Task { await auth.bootstrap() } }
            case .ready:
                switch biometric.state {
                case .unlocked, .unavailable:
                    MainTabView()
                case .locked:
                    LockScreenView()
                }
            }
        }
        .onChange(of: authReadyKey) { _, _ in
            // Auth just finished bootstrapping → try Face ID right away.
            Task { await tryAutoUnlock() }
        }
        .animation(.smooth, value: describeState())
        .onChange(of: scenePhase) { _, newValue in
            switch newValue {
            case .background, .inactive:
                biometric.lock()
            case .active:
                // Auto-trigger Face ID whenever the app comes to the
                // foreground — both on first launch and after being
                // backgrounded. LockScreenView's own .task handles only
                // first appearance; this covers the rest.
                Task { await tryAutoUnlock() }
            @unknown default:
                break
            }
        }
        .task { await tryAutoUnlock() }
    }

    private func tryAutoUnlock() async {
        // Only attempt when we actually have a session and the gate is locked.
        if case .ready = auth.state, biometric.state == .locked {
            await biometric.unlock()
        }
    }

    private func describeState() -> String {
        switch auth.state {
        case .bootstrapping: "bootstrapping"
        case .ready: "ready-\(biometric.state)"
        case .error: "error"
        }
    }

    private var authReadyKey: String {
        if case .ready = auth.state { return "ready" }
        return "not-ready"
    }
}

struct SplashView: View {
    var body: some View {
        ZStack {
            AppBackground()
            VStack(spacing: 16) {
                Image("AppLogo")
                    .resizable()
                    .scaledToFill()
                    .frame(width: 120, height: 120)
                    .clipShape(Circle())
                    .overlay { Circle().stroke(.white.opacity(0.25), lineWidth: 1) }
                ProgressView()
                    .controlSize(.regular)
                    .tint(.white)
            }
        }
    }
}

struct ErrorView: View {
    let message: String
    let retry: () -> Void
    var body: some View {
        ZStack {
            AppBackground()
            VStack(spacing: 16) {
                Image(systemName: "exclamationmark.triangle.fill")
                    .font(.system(size: 48))
                    .foregroundStyle(.yellow)
                Text(message)
                    .font(.body)
                    .foregroundStyle(.white.opacity(0.85))
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 32)
                Button("Retry", action: retry)
                    .buttonStyle(.borderedProminent)
                    .tint(.white)
                    .foregroundStyle(.black)
            }
        }
    }
}

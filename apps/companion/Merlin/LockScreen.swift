import SwiftUI
import LocalAuthentication

#if os(macOS)
import AppKit
private let lockBackground = Color(nsColor: NSColor(name: nil) { appearance in
    appearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
    ? NSColor(red: 0, green: 0, blue: 0, alpha: 1)
    : NSColor(red: 1, green: 1, blue: 1, alpha: 1)
})
#else
import UIKit
private let lockBackground = Color(UIColor.systemBackground)
#endif

struct LockScreen: View {
    @Binding var isUnlocked: Bool
    @Environment(\.scenePhase) private var scenePhase
    @State private var authFailed = false
    @State private var authenticating = false

    var body: some View {
        VStack(spacing: 24) {
            Spacer()

            Image(systemName: "lock.fill")
                .font(.system(size: 48))
                .foregroundStyle(.secondary)

            Text("Merlin")
                .font(.largeTitle.bold())

            if authenticating {
                ProgressView()
            }

            Spacer()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(lockBackground)
        .onAppear {
            authenticate()
        }
        .onChange(of: scenePhase) { _, newPhase in
            if newPhase == .active && !isUnlocked && !authenticating {
                authenticate()
            }
        }
    }

    private func authenticate() {
        guard !authenticating else { return }
        authenticating = true

        let context = LAContext()
        var error: NSError?

        let policy: LAPolicy = context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &error)
            ? .deviceOwnerAuthenticationWithBiometrics
            : .deviceOwnerAuthentication

        context.evaluatePolicy(policy, localizedReason: "Unlock Merlin") { success, _ in
            DispatchQueue.main.async {
                authenticating = false
                if success {
                    isUnlocked = true
                    authFailed = false
                } else {
                    authFailed = true
                }
            }
        }
    }
}

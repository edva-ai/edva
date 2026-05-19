import Foundation
import LocalAuthentication
import Observation

@MainActor
@Observable
final class BiometricAuth {
    enum State {
        case locked
        case unlocked
        case unavailable
    }

    var state: State

    init() {
        let ctx = LAContext()
        var err: NSError?
        if ctx.canEvaluatePolicy(.deviceOwnerAuthentication, error: &err) {
            self.state = .locked
        } else {
            // No passcode / biometrics set — app is unlocked (no gate possible).
            self.state = .unavailable
        }
    }

    func unlock(reason: String = "Unlock Exercise") async {
        let ctx = LAContext()
        var err: NSError?
        guard ctx.canEvaluatePolicy(.deviceOwnerAuthentication, error: &err) else {
            state = .unavailable
            return
        }
        do {
            let ok = try await ctx.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason)
            state = ok ? .unlocked : .locked
        } catch {
            state = .locked
        }
    }

    func lock() {
        if state != .unavailable { state = .locked }
    }
}

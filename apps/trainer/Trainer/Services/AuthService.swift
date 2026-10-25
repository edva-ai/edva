import Foundation
import Observation
#if canImport(Supabase)
import Supabase
#endif

/// Personal single-user app: on first launch we create an anonymous Supabase
/// user, store the session locally, and reuse it forever. Face ID (see
/// BiometricAuth) is what actually gates access to the app — not the server
/// session. The anon user gives us a stable UUID so Supabase RLS scopes all
/// of our data to exactly one owner.
@MainActor
@Observable
final class AuthService {

    enum AuthState {
        case bootstrapping
        case ready(userID: String)
        case error(String)
    }

    private(set) var state: AuthState = .bootstrapping

    #if canImport(Supabase)
    let client: SupabaseClient?
    #endif

    init() {
        #if canImport(Supabase)
        if let url = AppConfig.supabaseURL, let key = AppConfig.supabaseAnonKey {
            self.client = SupabaseClient(supabaseURL: url, supabaseKey: key)
        } else {
            self.client = nil
        }
        #endif
        Task { await bootstrap() }
    }

    /// Restores an existing session or creates an anonymous one on first launch.
    func bootstrap() async {
        #if canImport(Supabase)
        guard let client else {
            state = .ready(userID: "offline")
            return
        }

        // Try to restore a stored session first.
        if let user = try? await client.auth.user() {
            state = .ready(userID: user.id.uuidString)
            return
        }

        // No session — provision an anonymous user.
        do {
            let session = try await client.auth.signInAnonymously()
            state = .ready(userID: session.user.id.uuidString)
        } catch {
            let ns = error as NSError
            print("[Auth] anon signup failed: domain=\(ns.domain) code=\(ns.code) \(error.localizedDescription)")
            state = .error("Offline mode — retrying on relaunch")
        }
        #else
        state = .ready(userID: "offline")
        #endif
    }

    func signOut() async {
        #if canImport(Supabase)
        try? await client?.auth.signOut()
        #endif
        state = .bootstrapping
        await bootstrap()
    }
}

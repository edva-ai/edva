import Foundation
import Supabase
import AuthenticationServices
import UIKit

/// Auth + client for **Merlin's** Supabase project. Distinct from
/// `AuthService` / `SupabaseSync` which write to Spotter's own project.
///
/// We sign into Merlin with Google OAuth so `HealthKitManager` uploads
/// land under the same auth.uid() that the Merlin iOS app uses — RLS
/// in Merlin scopes everything by that user id, so without it the
/// inserts would fail. Ported verbatim from
/// `client/Merlin/SupabaseManager.swift` in the merlin repo; kept here
/// as a standalone module so Spotter's existing Supabase plumbing is
/// untouched.
enum SpotterSupabase {
    static let url = URL(string: "https://mszowrkjhfstptnssrzk.supabase.co")!
    // Anon JWT — intentionally public (RLS enforces access, not secrecy).
    // Matches the value in merlin's SupabaseManager.swift.
    static let anonKey = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1zem93cmtqaGZzdHB0bnNzcnprIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYzMDU2NjAsImV4cCI6MjA5MTg4MTY2MH0.seXkEaAFoc5Zw-MTj1dNKMR5hSnGvf1ijjv3o5WAs20"

    // OAuth redirect — must match a CFBundleURLScheme in Info.plist AND
    // the Supabase Auth "Redirect URLs" allowlist on the Merlin project.
    // Spotter uses its own scheme so the OS routes the callback to us,
    // not to the Merlin app if both are installed on the same device.
    static let callbackScheme = "com.example.spotter.merlin"
    static let redirectURL = URL(string: "\(callbackScheme)://auth-callback")!

    static let shared: SupabaseClient = SupabaseClient(supabaseURL: url, supabaseKey: anonKey)

    enum AuthError: LocalizedError {
        case noSession
        case webAuthFailed(String)
        var errorDescription: String? {
            switch self {
            case .noSession: return "Not signed in to Merlin."
            case .webAuthFailed(let msg): return msg
            }
        }
    }

    /// Read-only check — does the Keychain hold a Merlin session?
    static func hasSession() async -> Bool {
        (try? await shared.auth.session) != nil
    }

    /// Refresh the existing session if close to expiry. Throws if no
    /// session exists or refresh fails — callers should drop sync work
    /// and surface the sign-in prompt.
    static func ensureAuthenticated() async throws {
        guard let session = try? await shared.auth.session else {
            throw AuthError.noSession
        }
        let safetyMargin: TimeInterval = 60
        let expiresAt = Date(timeIntervalSince1970: session.expiresAt)
        if expiresAt.timeIntervalSinceNow > safetyMargin {
            return
        }
        _ = try await shared.auth.refreshSession()
    }

    /// Launches Google OAuth via ASWebAuthenticationSession and persists
    /// the resulting session into the SDK's default Keychain backend.
    @MainActor
    static func signInWithGoogle() async throws {
        let authURL = try shared.auth.getOAuthSignInURL(
            provider: .google,
            redirectTo: redirectURL
        )
        let callbackURL = try await presentWebAuth(url: authURL, scheme: callbackScheme)
        try await shared.auth.session(from: callbackURL)
    }

    static func signOut() async {
        try? await shared.auth.signOut()
    }

    @MainActor
    private static func presentWebAuth(url: URL, scheme: String) async throws -> URL {
        try await withCheckedThrowingContinuation { continuation in
            let session = ASWebAuthenticationSession(
                url: url,
                callbackURLScheme: scheme
            ) { callbackURL, error in
                if let callbackURL {
                    continuation.resume(returning: callbackURL)
                } else if let error {
                    continuation.resume(throwing: AuthError.webAuthFailed(error.localizedDescription))
                } else {
                    continuation.resume(throwing: AuthError.webAuthFailed("Sign-in was cancelled."))
                }
            }
            session.presentationContextProvider = WebAuthPresenter.shared
            session.prefersEphemeralWebBrowserSession = false
            if !session.start() {
                continuation.resume(throwing: AuthError.webAuthFailed("Could not start web auth session."))
            }
        }
    }
}

private final class WebAuthPresenter: NSObject, ASWebAuthenticationPresentationContextProviding {
    static let shared = WebAuthPresenter()
    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        let window = scenes.flatMap(\.windows).first(where: { $0.isKeyWindow })
            ?? scenes.first?.windows.first
        return window ?? ASPresentationAnchor()
    }
}

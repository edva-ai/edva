import Foundation
import Supabase
import AuthenticationServices
import UIKit

/// Auth + client for **Edva's** Supabase project. Distinct from
/// `AuthService` / `SupabaseSync` which write to Trainer's own project.
///
/// We sign into Edva with Google OAuth so `HealthKitManager` uploads
/// land under the same auth.uid() that the Edva iOS app uses — RLS
/// in Edva scopes everything by that user id, so without it the
/// inserts would fail. Ported verbatim from
/// `client/Edva/SupabaseManager.swift` in the edva repo; kept here
/// as a standalone module so Trainer's existing Supabase plumbing is
/// untouched.
enum TrainerSupabase {
    static let url = URL(string: "https://${EDVA_SUPABASE_PROJECT}.supabase.co")!
    // Anon JWT — intentionally public (RLS enforces access, not secrecy).
    // Same anon key as apps/companion SupabaseManager.swift; set at build time.
    static let anonKey = "${EDVA_SUPABASE_ANON_KEY}"

    // OAuth redirect — must match a CFBundleURLScheme in Info.plist AND
    // the Supabase Auth "Redirect URLs" allowlist on the Edva project.
    // Trainer uses its own scheme so the OS routes the callback to us,
    // not to the Edva app if both are installed on the same device.
    static let callbackScheme = "com.example.trainer.edva"
    static let redirectURL = URL(string: "\(callbackScheme)://auth-callback")!

    static let shared: SupabaseClient = SupabaseClient(supabaseURL: url, supabaseKey: anonKey)

    enum AuthError: LocalizedError {
        case noSession
        case webAuthFailed(String)
        var errorDescription: String? {
            switch self {
            case .noSession: return "Not signed in to Edva."
            case .webAuthFailed(let msg): return msg
            }
        }
    }

    /// Read-only check — does the Keychain hold a Edva session?
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

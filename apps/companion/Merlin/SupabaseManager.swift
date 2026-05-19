import Foundation
import Supabase
import AuthenticationServices

#if os(macOS)
import AppKit
#else
import UIKit
#endif

enum SupabaseManager {
    static let url = URL(string: "https://${MERLIN_SUPABASE_PROJECT}.supabase.co")!
    // Supabase anon JWT — intentionally public (RLS enforces access, not secrecy).
    static let anonKey = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1zem93cmtqaGZzdHB0bnNzcnprIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYzMDU2NjAsImV4cCI6MjA5MTg4MTY2MH0.seXkEaAFoc5Zw-MTj1dNKMR5hSnGvf1ijjv3o5WAs20"

    // OAuth redirect — must match a CFBundleURLScheme in Info.plist and the
    // Supabase Auth "Redirect URLs" allowlist (Dashboard → Auth → URL Configuration).
    static let callbackScheme = "com.example.merlin"
    static let redirectURL = URL(string: "\(callbackScheme)://auth-callback")!

    static let shared: SupabaseClient = {
        #if os(macOS)
        // Sandboxed macOS apps need the data-protection keychain; the SDK's
        // default keychain backend reads return errSecMissingEntitlement /
        // session-missing, the SDK falls back to the anon key, and inserts
        // hit the merlin_messages RLS guard (auth.uid() IS NOT NULL).
        let options = SupabaseClientOptions(
            auth: SupabaseClientOptions.AuthOptions(storage: MacKeychainStorage())
        )
        return SupabaseClient(supabaseURL: url, supabaseKey: anonKey, options: options)
        #else
        return SupabaseClient(supabaseURL: url, supabaseKey: anonKey)
        #endif
    }()

    enum AuthError: LocalizedError {
        case noSession
        case webAuthFailed(String)
        var errorDescription: String? {
            switch self {
            case .noSession: return "Not signed in."
            case .webAuthFailed(let msg): return msg
            }
        }
    }

    /// Read-only check — does the Keychain hold a session (valid or stale)?
    static func hasSession() async -> Bool {
        (try? await shared.auth.session) != nil
    }

    /// Clear the current session (Keychain + in-memory). Safe to call when no
    /// session exists. Caller is responsible for flipping the UI back to the
    /// SignInView; the auth state listener does NOT re-render this app.
    @MainActor
    static func signOut() async {
        do {
            try await shared.auth.signOut()
        } catch {
            print("[Auth] signOut error: \(error)")
        }
    }

    /// Refresh the existing session if close to expiry. Throws if no session exists
    /// or refresh fails. Callers must route the user back to SignInView on error.
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

    /// Launch Google OAuth via a system web view, hand the callback to Supabase,
    /// and persist the resulting session to Keychain. Returns on success; throws on cancel/error.
    @MainActor
    static func signInWithGoogle() async throws {
        let authURL = try shared.auth.getOAuthSignInURL(
            provider: .google,
            redirectTo: redirectURL
        )
        let callbackURL = try await presentWebAuth(url: authURL, scheme: callbackScheme)
        try await shared.auth.session(from: callbackURL)
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
            // Keep cookies so subsequent sign-ins skip the Google account picker if appropriate.
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
        #if os(macOS)
        return NSApplication.shared.keyWindow ?? NSApplication.shared.windows.first ?? ASPresentationAnchor()
        #else
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        let window = scenes.flatMap(\.windows).first(where: { $0.isKeyWindow })
            ?? scenes.first?.windows.first
        return window ?? ASPresentationAnchor()
        #endif
    }
}

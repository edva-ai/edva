import Foundation

enum AppConfig {
    /// Returns Info.plist values injected via build-time placeholders.
    static func infoString(_ key: String) -> String? {
        guard let raw = Bundle.main.object(forInfoDictionaryKey: key) as? String,
              !raw.hasPrefix("REPLACE_")
        else { return nil }
        return raw
    }

    static var supabaseURL: URL? {
        infoString("SupabaseURL").flatMap(URL.init(string:))
    }

    static var supabaseAnonKey: String? {
        infoString("SupabaseAnonKey")
    }

    /// `true` when Supabase is configured with real values (not placeholders).
    static var isBackendConfigured: Bool {
        supabaseURL != nil && supabaseAnonKey != nil
    }
}

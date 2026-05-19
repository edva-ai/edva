#if os(macOS)
import Foundation
import Security
import Supabase

// AuthLocalStorage backed by the modern data-protection keychain.
//
// Supabase Swift's default KeychainLocalStorage targets the legacy file-based
// keychain (no kSecUseDataProtectionKeychain flag). Inside the macOS sandbox,
// reads of items written that way fail intermittently, so SessionManager.session()
// returns AuthError.sessionMissing on every request — the SDK then falls back to
// the anon key, and merlin_messages INSERTs hit the RLS guard
// (auth.uid() IS NOT NULL).
//
// The data-protection keychain has consistent semantics inside the sandbox and
// matches how iOS already behaves, so this is also the storage path the iOS
// build effectively uses.
struct MacKeychainStorage: AuthLocalStorage {
    let service: String

    init(service: String = "supabase.gotrue.swift") {
        self.service = service
    }

    private func baseQuery(key: String? = nil) -> [String: Any] {
        var q: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecUseDataProtectionKeychain as String: true,
        ]
        if let key {
            q[kSecAttrAccount as String] = key
        }
        return q
    }

    func store(key: String, value: Data) throws {
        var addQuery = baseQuery(key: key)
        addQuery[kSecValueData as String] = value
        addQuery[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock

        let status = SecItemAdd(addQuery as CFDictionary, nil)
        if status == errSecDuplicateItem {
            let updateStatus = SecItemUpdate(
                baseQuery(key: key) as CFDictionary,
                [kSecValueData as String: value] as CFDictionary
            )
            if updateStatus != errSecSuccess {
                throw KeychainError(status: updateStatus)
            }
        } else if status != errSecSuccess {
            throw KeychainError(status: status)
        }
    }

    func retrieve(key: String) throws -> Data? {
        var query = baseQuery(key: key)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne

        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)

        if status == errSecItemNotFound {
            return nil
        }
        if status != errSecSuccess {
            throw KeychainError(status: status)
        }
        return result as? Data
    }

    func remove(key: String) throws {
        let status = SecItemDelete(baseQuery(key: key) as CFDictionary)
        if status != errSecSuccess && status != errSecItemNotFound {
            throw KeychainError(status: status)
        }
    }

    struct KeychainError: LocalizedError {
        let status: OSStatus
        var errorDescription: String? { "Keychain error: \(status)" }
    }
}
#endif

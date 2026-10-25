import AppIntents

struct SendToEdvaIntent: AppIntent {
    static var title: LocalizedStringResource = "Send to Edva"
    static var description = IntentDescription("Send a message to Edva")
    static var openAppWhenRun: Bool = false

    @Parameter(title: "Message")
    var message: String

    func perform() async throws -> some IntentResult & ProvidesDialog {
        let supabase = SupabaseManager.shared
        try await SupabaseManager.ensureAuthenticated()

        let tz = TimeZone.current
        var metadata: [String: String] = [
            "timezone": tz.identifier,
            "utc_offset": "\(tz.secondsFromGMT() / 3600)",
            "source": "siri"
        ]

        if let location = await LocationManager.shared.lastKnownLocation {
            metadata.merge(location.metadataStrings) { _, new in new }
        }

        let currentUserId = try? await supabase.auth.session.user.id
        // Siri / shortcut entry point — always lands on the chat channel.
        // The system channel is reserved for Edva's own health alerts.
        let insert = InsertMessage(
            role: "user",
            content: message,
            read: false,
            channel: ChatChannel.chat.rawValue,
            metadata: metadata,
            userId: currentUserId
        )

        try await supabase
            .from("edva_messages")
            .insert(insert)
            .execute()

        return .result(dialog: "Sent to Edva: \(message)")
    }
}

struct EdvaShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: SendToEdvaIntent(),
            phrases: [
                "Send a message to \(.applicationName)",
                "Tell \(.applicationName) something",
                "Ask \(.applicationName) something",
                "Message \(.applicationName)"
            ],
            shortTitle: "Send to Edva",
            systemImageName: "message"
        )
    }
}

import AppIntents

struct SendToMerlinIntent: AppIntent {
    static var title: LocalizedStringResource = "Send to Merlin"
    static var description = IntentDescription("Send a message to Merlin")
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
        // The system channel is reserved for Merlin's own health alerts.
        let insert = InsertMessage(
            role: "user",
            content: message,
            read: false,
            channel: ChatChannel.chat.rawValue,
            metadata: metadata,
            userId: currentUserId
        )

        try await supabase
            .from("merlin_messages")
            .insert(insert)
            .execute()

        return .result(dialog: "Sent to Merlin: \(message)")
    }
}

struct MerlinShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: SendToMerlinIntent(),
            phrases: [
                "Send a message to \(.applicationName)",
                "Tell \(.applicationName) something",
                "Ask \(.applicationName) something",
                "Message \(.applicationName)"
            ],
            shortTitle: "Send to Merlin",
            systemImageName: "message"
        )
    }
}

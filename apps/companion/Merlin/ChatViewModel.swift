import Foundation
#if os(macOS)
import AppKit
#else
import UIKit
#endif
import Supabase
import Realtime

@MainActor
private var isAppActive: Bool {
    #if os(macOS)
    return NSApplication.shared.isActive
    #else
    return UIApplication.shared.applicationState == .active
    #endif
}

@MainActor
final class ChatViewModel: ObservableObject {
    @Published var messages: [Message] = []
    @Published var currentChannel: ChatChannel

    /// Draft persistence — called from the view's @State inputText onChange.
    /// NOT @Published: typing should not trigger ViewModel re-renders of the
    /// entire message list (expensive with hundreds of messages + reaction UI).
    static func loadDraft() -> String {
        UserDefaults.standard.string(forKey: draftKey) ?? ""
    }
    static func saveDraft(_ text: String) {
        if text.isEmpty {
            UserDefaults.standard.removeObject(forKey: draftKey)
        } else {
            UserDefaults.standard.set(text, forKey: draftKey)
        }
    }
    @Published var isWaitingForResponse: Bool = false
    @Published var error: String?
    @Published var isOffline: Bool = false
    @Published var isLoadingOlder: Bool = false
    @Published var hasOlderMessages: Bool = true

    private static let draftKey = "merlin.messageDraft"
    private static let channelKey = "merlin.currentChannel"

    private let supabase: SupabaseClient
    private let cloudBackup = CloudBackup.shared
    private let store = MessageStore.shared
    private var realtimeChannel: RealtimeChannelV2?
    private var commandsChannel: RealtimeChannelV2?
    private var reconnectTask: Task<Void, Never>?
    private var catchUpTimer: Task<Void, Never>?
    private var staleRetryTask: Task<Void, Never>?
    private let locationManager = LocationManager.shared

    init() {
        self.supabase = SupabaseManager.shared
        let savedChannel = UserDefaults.standard.string(forKey: Self.channelKey)
            .flatMap(ChatChannel.init(rawValue:)) ?? .chat
        self.currentChannel = savedChannel
        self.messages = store.loadAll(channel: savedChannel.rawValue)
    }

    /// Switch the active channel — persists the selection, swaps the visible
    /// message list from cache, then re-subscribes realtime + re-fetches.
    func switchChannel(to channel: ChatChannel) {
        guard channel != currentChannel else { return }
        currentChannel = channel
        UserDefaults.standard.set(channel.rawValue, forKey: Self.channelKey)
        messages = store.loadAll(channel: channel.rawValue)
        hasOlderMessages = true
        isWaitingForResponse = false
        reconnectIfNeeded()
        Task { await loadMessages() }
    }

    func loadMessages() async {
        // Ensure authenticated before any Supabase operations — bail if auth fails
        do {
            try await SupabaseManager.ensureAuthenticated()
        } catch {
            print("[Auth] Failed to authenticate: \(error) — skipping server load, using cache")
            return
        }

        let channel = currentChannel.rawValue
        do {
            // On fresh install (empty cache), load last 3 days.
            // With cache, load all (incremental sync via realtime handles new messages).
            let query = supabase
                .from("merlin_messages")
                .select()
                .eq("channel", value: channel)

            // Always cap the initial fetch — a multi-thousand message array
                                                                                                             // in a LazyVStack blows up scroll performance (each bubble runs
                                                                                                             // MarkdownUI), and cache eviction already bounds persistent storage.
                                                                                                             // Older history still reachable via the "Load older" button.
            let hasCache = !store.loadAll(channel: channel).isEmpty
            let response: [Message]
            if hasCache {
                let newestFirst: [Message] = try await query
                    .order("created_at", ascending: false)
                    .limit(500)
                    .execute()
                    .value
                response = Array(newestFirst.reversed())
            } else {
                let threeDaysAgo = Calendar.current.date(byAdding: .day, value: -3, to: Date())!
                let cutoff = ISO8601DateFormatter().string(from: threeDaysAgo)
                response = try await query
                    .gte("created_at", value: cutoff)
                    .order("created_at", ascending: true)
                    .execute()
                    .value
            }

            // An empty response must not wipe the cache-hydrated state: a
            // stale read or transient server wobble would silently erase the
            // conversation from the screen. Server-side deletions come in
            // through the realtime delete channel.
            if !response.isEmpty {
                self.messages = response
            } else if self.messages.isEmpty, channel == ChatChannel.chat.rawValue,
                      let restored = cloudBackup.restore(), !restored.isEmpty {
                // CloudBackup only ever held chat-channel messages, so only
                // restore it when we're viewing chat.
                self.messages = restored
                store.sync(with: restored, channel: channel)
            }

            self.isWaitingForResponse = (messages.last?.isUser == true)

            // Fresh install (no cache): the 3-day backfill is historical —
            // mark ALL as read immediately so they don't trigger push
            // notifications. Existing install: only mark read when app is active.
            let shouldMarkRead = !hasCache || isAppActive
            if shouldMarkRead {
                for msg in response where msg.isAssistant && !msg.read {
                    await markAsRead(messageId: msg.id)
                }
            }

            // Always reconcile the cache with a successful server response,
            // even if the in-memory array hasn't visibly changed — guarantees
            // the persistent store can never silently drift out of sync.
            if !response.isEmpty {
                store.sync(with: response, channel: channel)
                backupToCloud()
            }

            // Refresh succeeded — clear any stale-state error, drop offline
            // indicator, and stop the self-healing retry loop if running.
            self.error = nil
            self.isOffline = false
            staleRetryTask?.cancel()
            staleRetryTask = nil
        } catch {
            // Log the full error type, not just the localized description,
            // so we can actually diagnose what's failing if it recurs.
            print("[loadMessages] error: \(String(describing: error))")
            // Do NOT surface a modal alert here: the cache-hydrated UI is
            // still usable, the retry loop will recover silently, and the
            // offline banner gives the user a non-intrusive hint.
            self.isOffline = true
            if self.messages.isEmpty,
               let restored = cloudBackup.restore(), !restored.isEmpty {
                self.messages = restored
            }
            // The on-screen state may be stale (cache-hydrated) and the user
            // can't tell. Kick off a fast retry loop instead of waiting for
            // the 30s catchUpTimer to come around again.
            startStaleRetryLoop()
        }
    }

    /// Load messages older than the earliest currently displayed message.
    /// Called when the user scrolls to the top of the conversation.
    func loadOlderMessages() async {
        guard !isLoadingOlder, hasOlderMessages else { return }
        guard let earliest = messages.first?.createdAt else { return }

        isLoadingOlder = true
        defer { isLoadingOlder = false }

        let channel = currentChannel.rawValue
        do {
            try await SupabaseManager.ensureAuthenticated()
            let cutoff = ISO8601DateFormatter().string(from: earliest)
            let older: [Message] = try await supabase
                .from("merlin_messages")
                .select()
                .eq("channel", value: channel)
                .lt("created_at", value: cutoff)
                .order("created_at", ascending: false)
                .limit(50)
                .execute()
                .value

            if older.isEmpty {
                hasOlderMessages = false
                return
            }

            let reversed = older.reversed()
            messages.insert(contentsOf: reversed, at: 0)
            store.sync(with: messages, channel: channel)
        } catch {
            print("[loadOlderMessages] error: \(error)")
        }
    }

    /// Fast self-healing retry after a failed loadMessages: 12 attempts at
    /// 5s intervals (~1 minute total), then we fall back to the existing
    /// catchUpTimer cadence. Succeeding cancels the loop from inside
    /// loadMessages.
    private func startStaleRetryLoop() {
        staleRetryTask?.cancel()
        staleRetryTask = Task { [weak self] in
            for _ in 0..<12 {
                try? await Task.sleep(for: .seconds(5))
                if Task.isCancelled { return }
                await self?.loadMessages()
                if Task.isCancelled { return }
            }
        }
    }

    func subscribeToNewMessages() async {
        // Auth must be established before subscribing — realtime uses the auth token for RLS
        do {
            try await SupabaseManager.ensureAuthenticated()
        } catch {
            print("[Auth] Failed to authenticate for realtime — subscription may not receive updates")
        }

        // Per-channel realtime topic — switching channels tears this down
        // and re-subscribes via `reconnectIfNeeded()`.
        let activeChannel = currentChannel.rawValue
        let filter = "channel=eq.\(activeChannel)"
        let channel = supabase.realtimeV2.channel("merlin_messages_changes_\(activeChannel)")

        let insertions = channel.postgresChange(
            InsertAction.self,
            schema: "public",
            table: "merlin_messages",
            filter: filter
        )

        let deletions = channel.postgresChange(
            DeleteAction.self,
            schema: "public",
            table: "merlin_messages"
        )

        let updates = channel.postgresChange(
            UpdateAction.self,
            schema: "public",
            table: "merlin_messages",
            filter: filter
        )

        await channel.subscribe()
        self.realtimeChannel = channel

        // Listen for inserts, deletes, and updates concurrently
        await withTaskGroup(of: Void.self) { group in
            group.addTask { @MainActor in
                for await insertion in insertions {
                    do {
                        let message = try insertion.decodeRecord(as: Message.self, decoder: JSONDecoder.supabaseDecoder)
                        // Guard: if the user switched channels mid-subscribe,
                        // drop messages that don't belong to the new view.
                        guard message.channel == self.currentChannel.rawValue else { continue }
                        if !self.messages.contains(where: { $0.id == message.id }) {
                            self.messages.append(message)
                            if message.isAssistant {
                                self.isWaitingForResponse = false
                            }
                            self.store.upsert(message)
                            self.backupToCloud()
                            if isAppActive {
                                await self.markAsRead(messageId: message.id)
                            }
                        }
                    } catch {
                        print("Decode error: \(error)")
                    }
                }
            }
            group.addTask { @MainActor in
                for await deletion in deletions {
                    if let idString = deletion.oldRecord["id"]?.stringValue,
                       let id = UUID(uuidString: idString) {
                        self.messages.removeAll { $0.id == id }
                        self.store.delete(id: id)
                    }
                }
            }
            group.addTask { @MainActor in
                for await update in updates {
                    do {
                        let message = try update.decodeRecord(as: Message.self, decoder: JSONDecoder.supabaseDecoder)
                        guard message.channel == self.currentChannel.rawValue else { continue }
                        if let idx = self.messages.firstIndex(where: { $0.id == message.id }) {
                            self.messages[idx] = message
                            self.backupToCloud()
                        }
                    } catch {
                        print("Update decode error: \(error)")
                    }
                }
            }
        }
    }

    func sendMessage(_ rawText: String) async {
        let text = rawText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }

        Self.saveDraft("") // clear persisted draft
        isWaitingForResponse = true

        let tz = TimeZone.current
        var metadata: [String: String] = [
            "timezone": tz.identifier,
            "utc_offset": "\(tz.secondsFromGMT() / 3600)"
        ]

        if let location = locationManager.lastKnownLocation {
            metadata.merge(location.metadataStrings) { _, new in new }
        }

        // Add current place/activity context from LocationTracker
        if let ctx = LocationTracker.shared.currentContext {
            if let place = ctx.placeName {
                metadata["current_place"] = place
            }
            if let activity = ctx.activity {
                metadata["current_activity"] = activity
            }
            metadata["at_place_since"] = ctx.arrivedAt.ISO8601Format()
        }

        // Ensure auth before sending. If this fails, the SDK would silently fall
        // back to the anon key and the insert would hit the RLS guard — surface
        // the auth error directly instead.
        let currentUserId: UUID
        do {
            try await SupabaseManager.ensureAuthenticated()
            currentUserId = try await supabase.auth.session.user.id
        } catch {
            self.error = "Sign-in expired. Please sign in again."
            self.isWaitingForResponse = false
            print("Send auth error: \(error)")
            return
        }
        let newMessage = InsertMessage(
            role: "user",
            content: text,
            read: false,
            channel: currentChannel.rawValue,
            metadata: metadata,
            userId: currentUserId
        )

        do {
            let inserted: Message = try await supabase
                .from("merlin_messages")
                .insert(newMessage)
                .select()
                .single()
                .execute()
                .value
            if !self.messages.contains(where: { $0.id == inserted.id }) {
                self.messages.append(inserted)
            }
            store.upsert(inserted)
            backupToCloud()
        } catch {
            self.error = "Failed to send message: \(error.localizedDescription)"
            self.isWaitingForResponse = false
            print("Send error: \(error)")
        }
    }

    func setReaction(for message: Message, to newValue: Reaction?) async {
        guard message.isAssistant else { return }

        let resolved: Reaction? = (message.reaction == newValue) ? nil : newValue

        if let idx = messages.firstIndex(where: { $0.id == message.id }) {
            messages[idx] = messages[idx].with(reaction: resolved)
            backupToCloud()
        }

        struct ReactionUpdate: Encodable {
            let reaction: String?
        }

        do {
            try await supabase
                .from("merlin_messages")
                .update(ReactionUpdate(reaction: resolved?.rawValue))
                .eq("id", value: message.id.uuidString)
                .execute()
        } catch {
            print("Reaction update error: \(error)")
            if let idx = messages.firstIndex(where: { $0.id == message.id }) {
                messages[idx] = messages[idx].with(reaction: message.reaction)
            }
            self.error = "Failed to save reaction: \(error.localizedDescription)"
        }
    }

    private func markAsRead(messageId: UUID) async {
        try? await supabase
            .from("merlin_messages")
            .update(["read": true])
            .eq("id", value: messageId.uuidString)
            .execute()
    }

    private func backupToCloud() {
        let snapshot = self.messages
        Task.detached(priority: .utility) {
            CloudBackup.shared.backup(messages: snapshot)
        }
    }

    func subscribeToCommands() async {
        let channel = supabase.realtimeV2.channel("merlin_commands_changes")

        let insertions = channel.postgresChange(
            InsertAction.self,
            schema: "public",
            table: "merlin_commands",
            filter: "status=eq.pending"
        )

        await channel.subscribe()
        self.commandsChannel = channel

        for await insertion in insertions {
            do {
                let record = try insertion.decodeRecord(as: CommandRow.self, decoder: JSONDecoder.supabaseDecoder)
                switch record.command {
                case "get_location":
                    await handleLocationCommand(id: record.id)
                case "flush_location":
                    await handleFlushLocationCommand(id: record.id)
                case "reset_health_anchors":
                    await handleResetHealthAnchors(id: record.id, payload: record.payload)
                case "refresh_health_sync":
                    await handleRefreshHealthSync(id: record.id)
                default:
                    // unknown command — mark failed so sender doesn't hang
                    let _ = try? await self.supabase
                        .from("merlin_commands")
                        .update(CommandUpdate(
                            status: "failed",
                            response: ["error": "unknown command: \(record.command)"],
                            completed_at: ISO8601DateFormatter().string(from: Date())
                        ))
                        .eq("id", value: record.id.uuidString)
                        .execute()
                    continue
                }
            } catch {
                print("Command decode error: \(error)")
            }
        }
    }

    #if os(iOS)
    private func handleResetHealthAnchors(id: UUID, payload: [String: String]?) async {
        let types = payload?["types"]?.split(separator: ",").map { String($0).trimmingCharacters(in: .whitespaces) }
        let cleared = HealthKitManager.shared.resetAnchors(onlyTypes: types)
        // Kick a fresh sync immediately so new data flows.
        HealthKitManager.shared.syncOnForeground()
        let update = CommandUpdate(
            status: "completed",
            response: ["cleared_anchors": "\(cleared)", "types_filter": types?.joined(separator: ",") ?? "all"],
            completed_at: ISO8601DateFormatter().string(from: Date())
        )
        let _ = try? await supabase
            .from("merlin_commands")
            .update(update)
            .eq("id", value: id.uuidString)
            .execute()
    }

    private func handleRefreshHealthSync(id: UUID) async {
        HealthKitManager.shared.syncOnForeground()
        let update = CommandUpdate(
            status: "completed",
            response: ["triggered": "true"],
            completed_at: ISO8601DateFormatter().string(from: Date())
        )
        let _ = try? await supabase
            .from("merlin_commands")
            .update(update)
            .eq("id", value: id.uuidString)
            .execute()
    }
    #else
    // macOS: silently ignore iOS-only health commands — do NOT mark as failed,
    // so iOS can still pick them up via the same realtime subscription.
    private func handleResetHealthAnchors(id: UUID, payload: [String: String]?) async {}
    private func handleRefreshHealthSync(id: UUID) async {}
    #endif

    private func handleLocationCommand(id: UUID) async {
        let result = await locationManager.getCurrentLocation()

        switch result {
        case .success(let loc):
            if loc.accuracy < 0 {
                let update = CommandUpdate(
                    status: "failed",
                    response: ["error": "Location request failed"],
                    completed_at: ISO8601DateFormatter().string(from: Date())
                )
                let _ = try? await supabase
                    .from("merlin_commands")
                    .update(update)
                    .eq("id", value: id.uuidString)
                    .execute()
                return
            }
            let update = CommandUpdate(
                status: "completed",
                response: [
                    "latitude": "\(loc.latitude)",
                    "longitude": "\(loc.longitude)",
                    "accuracy": "\(loc.accuracy)",
                    "timestamp": ISO8601DateFormatter().string(from: loc.timestamp),
                ],
                completed_at: ISO8601DateFormatter().string(from: Date())
            )
            let _ = try? await supabase
                .from("merlin_commands")
                .update(update)
                .eq("id", value: id.uuidString)
                .execute()

        case .failure(let error):
            let errorMsg: String
            switch error {
            case .denied:
                errorMsg = "Location permission denied"
            case .failed(let msg):
                errorMsg = msg
            }
            let update = CommandUpdate(
                status: "failed",
                response: ["error": errorMsg],
                completed_at: ISO8601DateFormatter().string(from: Date())
            )
            let _ = try? await supabase
                .from("merlin_commands")
                .update(update)
                .eq("id", value: id.uuidString)
                .execute()
        }
    }

    private func handleFlushLocationCommand(id: UUID) async {
        #if os(iOS)
        await LocationTracker.shared.flushUnsynced()
        #endif
        let update = CommandUpdate(
            status: "completed",
            response: ["ok": "flushed"],
            completed_at: ISO8601DateFormatter().string(from: Date())
        )
        let _ = try? await supabase
            .from("merlin_commands")
            .update(update)
            .eq("id", value: id.uuidString)
            .execute()
    }

    func sendAttachment(data: Data, filename: String, contentType: String) async {
        isWaitingForResponse = true

        let path = "\(UUID().uuidString)/\(filename)"
        do {
            try await supabase.storage
                .from("merlin-attachments")
                .upload(path, data: data, options: .init(contentType: contentType))

            let publicURL = try supabase.storage
                .from("merlin-attachments")
                .getPublicURL(path: path)

            let newMessage = InsertMessage(
                role: "user",
                content: publicURL.absoluteString,
                read: false,
                channel: currentChannel.rawValue
            )
            let inserted: Message = try await supabase
                .from("merlin_messages")
                .insert(newMessage)
                .select()
                .single()
                .execute()
                .value
            if !self.messages.contains(where: { $0.id == inserted.id }) {
                self.messages.append(inserted)
            }
            store.upsert(inserted)
            backupToCloud()
        } catch {
            self.error = "Failed to send attachment: \(error.localizedDescription)"
            self.isWaitingForResponse = false
            print("Attachment error: \(error)")
        }
    }

    func reconnectIfNeeded() {
        // Cancel previous reconnect loops and start fresh
        reconnectTask?.cancel()
        reconnectTask = Task {
            await unsubscribe()
            async let msgs: Void = subscribeToNewMessages()
            async let cmds: Void = subscribeToCommands()
            _ = await (msgs, cmds)
        }
    }

    /// Periodic catch-up: re-fetch messages every 30s.
    /// Guards against silent Realtime drops that scenePhase doesn't detect.
    /// On macOS, runs unconditionally since isActive is unreliable when
    /// the window is open but another app has focus.
    func startCatchUpTimer() {
        catchUpTimer?.cancel()
        catchUpTimer = Task {
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(30))
                guard !Task.isCancelled else { continue }
                #if os(iOS)
                guard isAppActive else { continue }
                #endif
                await loadMessages()
            }
        }
    }

    func stopCatchUpTimer() {
        catchUpTimer?.cancel()
        catchUpTimer = nil
    }

    func unsubscribe() async {
        if let channel = realtimeChannel {
            await supabase.realtimeV2.removeChannel(channel)
        }
        if let channel = commandsChannel {
            await supabase.realtimeV2.removeChannel(channel)
        }
    }
}

struct CommandRow: Decodable {
    let id: UUID
    let command: String
    let status: String
    let payload: [String: String]?
}

struct CommandUpdate: Encodable {
    let status: String
    let response: [String: String]
    let completed_at: String
}

// Helper to get a proper Supabase-compatible JSON decoder
extension JSONDecoder {
    static var supabaseDecoder: JSONDecoder {
        let decoder = JSONDecoder()
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        decoder.dateDecodingStrategy = .custom { decoder in
            let container = try decoder.singleValueContainer()
            let string = try container.decode(String.self)
            if let date = formatter.date(from: string) {
                return date
            }
            // Try without fractional seconds
            formatter.formatOptions = [.withInternetDateTime]
            if let date = formatter.date(from: string) {
                return date
            }
            throw DecodingError.dataCorruptedError(
                in: container,
                debugDescription: "Cannot decode date: \(string)"
            )
        }
        return decoder
    }
}

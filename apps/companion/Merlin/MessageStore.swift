import Foundation
import SwiftData

@Model
final class CachedMessage {
    @Attribute(.unique) var id: UUID
    var role: String
    var content: String
    var read: Bool
    var createdAt: Date
    var reaction: String?
    // Optional so SwiftData can lightweight-migrate existing stores. nil rows
    // were inserted before channels existed; treat them as 'chat' on read.
    var channel: String?

    init(id: UUID, role: String, content: String, read: Bool, createdAt: Date,
         reaction: String? = nil, channel: String? = ChatChannel.chat.rawValue) {
        self.id = id
        self.role = role
        self.content = content
        self.read = read
        self.createdAt = createdAt
        self.reaction = reaction
        self.channel = channel
    }

    convenience init(from message: Message) {
        self.init(id: message.id,
                  role: message.role,
                  content: message.content,
                  read: message.read,
                  createdAt: message.createdAt,
                  reaction: message.reaction?.rawValue,
                  channel: message.channel)
    }

    func apply(_ message: Message) {
        self.role = message.role
        self.content = message.content
        self.read = message.read
        self.createdAt = message.createdAt
        self.reaction = message.reaction?.rawValue
        self.channel = message.channel
    }

    var asMessage: Message {
        Message(id: id, role: role, content: content, read: read, createdAt: createdAt,
                reaction: reaction.flatMap { Reaction(rawValue: $0) },
                channel: channel ?? ChatChannel.chat.rawValue)
    }
}

@MainActor
final class MessageStore {
    static let shared = MessageStore()

    private static let perRowOverheadBytes = 200
    private static let budgetBytes = 5 * 1024 * 1024

    private let container: ModelContainer
    private var context: ModelContext { container.mainContext }
    private var runningBytes: Int = 0

    private init() {
        let schema = Schema([CachedMessage.self])
        let fm = FileManager.default
        let dir = (try? fm.url(for: .applicationSupportDirectory,
                               in: .userDomainMask,
                               appropriateFor: nil,
                               create: true)) ?? fm.temporaryDirectory
        let storeURL = dir.appendingPathComponent("merlin_messages.store")
        let config = ModelConfiguration(schema: schema, url: storeURL)
        if let c = try? ModelContainer(for: schema, configurations: config) {
            self.container = c
        } else {
            let fallback = ModelConfiguration(schema: schema, isStoredInMemoryOnly: true)
            self.container = try! ModelContainer(for: schema, configurations: fallback)
        }
        // runningBytes is seeded by the first loadAll() — ChatViewModel.init
        // always calls it during cold start, so we avoid a duplicate fetch.
    }

    /// Synchronous load, oldest → newest, scoped to a single channel. Also
    /// seeds `runningBytes` from the full table so cold start only hits
    /// SwiftData once.
    func loadAll(channel: String = ChatChannel.chat.rawValue) -> [Message] {
        let descriptor = FetchDescriptor<CachedMessage>(
            sortBy: [SortDescriptor(\.createdAt, order: .forward)]
        )
        guard let rows = try? context.fetch(descriptor) else {
            runningBytes = 0
            return []
        }
        runningBytes = rows.reduce(0) { $0 + cost(for: $1.content) }
        return rows
            .filter { ($0.channel ?? ChatChannel.chat.rawValue) == channel }
            .map(\.asMessage)
    }

    /// Full reconciliation against a fresh server response, scoped to one
    /// channel. Rows in other channels are left untouched so switching back
    /// doesn't re-fetch from scratch.
    func sync(with freshMessages: [Message], channel: String) {
        let freshIds = Set(freshMessages.map(\.id))
        let descriptor = FetchDescriptor<CachedMessage>()
        guard let cached = try? context.fetch(descriptor) else { return }

        var existingById: [UUID: CachedMessage] = [:]
        for row in cached {
            let rowChannel = row.channel ?? ChatChannel.chat.rawValue
            if rowChannel != channel { continue }   // out of scope
            if freshIds.contains(row.id) {
                existingById[row.id] = row
            } else {
                context.delete(row)
            }
        }

        for msg in freshMessages {
            if let existing = existingById[msg.id] {
                existing.apply(msg)
            } else {
                context.insert(CachedMessage(from: msg))
            }
        }

        try? context.save()
        runningBytes = recomputeRunningBytes()
        if runningBytes > Self.budgetBytes {
            evictOverBudget()
        }
    }

    /// Insert or update a single message (realtime + optimistic send).
    func upsert(_ message: Message) {
        if let existing = row(id: message.id) {
            runningBytes -= cost(for: existing.content)
            existing.apply(message)
            runningBytes += cost(for: existing.content)
        } else {
            context.insert(CachedMessage(from: message))
            runningBytes += cost(for: message.content)
        }
        try? context.save()
        if runningBytes > Self.budgetBytes {
            evictOverBudget()
        }
    }

    func delete(id: UUID) {
        guard let target = row(id: id) else { return }
        runningBytes -= cost(for: target.content)
        context.delete(target)
        try? context.save()
    }

    private func row(id: UUID) -> CachedMessage? {
        let targetId = id
        var descriptor = FetchDescriptor<CachedMessage>(
            predicate: #Predicate { $0.id == targetId }
        )
        descriptor.fetchLimit = 1
        return try? context.fetch(descriptor).first
    }

    private func cost(for content: String) -> Int {
        Self.perRowOverheadBytes + content.utf8.count
    }

    private func recomputeRunningBytes() -> Int {
        let descriptor = FetchDescriptor<CachedMessage>()
        guard let rows = try? context.fetch(descriptor) else { return 0 }
        return rows.reduce(0) { $0 + cost(for: $1.content) }
    }

    /// Walk newest → oldest and evict anything past the budget.
    /// Only invoked when `runningBytes` has already crossed the limit.
    private func evictOverBudget() {
        let descriptor = FetchDescriptor<CachedMessage>(
            sortBy: [SortDescriptor(\.createdAt, order: .reverse)]
        )
        guard let rows = try? context.fetch(descriptor) else { return }

        var keep = 0
        for row in rows {
            let c = cost(for: row.content)
            if keep + c > Self.budgetBytes {
                runningBytes -= c
                context.delete(row)
            } else {
                keep += c
            }
        }
        try? context.save()
    }
}

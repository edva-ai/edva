import Foundation

enum Reaction: String, Codable, CaseIterable {
    case heart
    case thumbsUp = "thumbs_up"
    case thumbsDown = "thumbs_down"

    var emoji: String {
        switch self {
        case .heart: return "❤️"
        case .thumbsUp: return "👍"
        case .thumbsDown: return "👎"
        }
    }

    var label: String {
        switch self {
        case .heart: return "Great"
        case .thumbsUp: return "Useful"
        case .thumbsDown: return "Not Useful"
        }
    }
}

struct Message: Identifiable, Codable, Equatable {
    let id: UUID
    let role: String
    let content: String
    let read: Bool
    let createdAt: Date
    let reaction: Reaction?
    let channel: String

    enum CodingKeys: String, CodingKey {
        case id
        case role
        case content
        case read
        case createdAt = "created_at"
        case reaction
        case channel
    }

    init(id: UUID, role: String, content: String, read: Bool, createdAt: Date,
         reaction: Reaction?, channel: String = ChatChannel.chat.rawValue) {
        self.id = id
        self.role = role
        self.content = content
        self.read = read
        self.createdAt = createdAt
        self.reaction = reaction
        self.channel = channel
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.id = try c.decode(UUID.self, forKey: .id)
        self.role = try c.decode(String.self, forKey: .role)
        self.content = try c.decode(String.self, forKey: .content)
        self.read = try c.decode(Bool.self, forKey: .read)
        self.createdAt = try c.decode(Date.self, forKey: .createdAt)
        self.reaction = try c.decodeIfPresent(Reaction.self, forKey: .reaction)
        // Server defaults this to 'chat'; tolerate older rows that omit it.
        self.channel = (try c.decodeIfPresent(String.self, forKey: .channel)) ?? ChatChannel.chat.rawValue
    }

    var isUser: Bool { role == "user" }
    var isAssistant: Bool { role == "assistant" }

    func with(reaction: Reaction?) -> Message {
        Message(id: id, role: role, content: content, read: read, createdAt: createdAt, reaction: reaction, channel: channel)
    }
}

struct InsertMessage: Codable {
    let role: String
    let content: String
    let read: Bool
    let channel: String
    var metadata: [String: String]?
    var userId: UUID?

    enum CodingKeys: String, CodingKey {
        case role
        case content
        case read
        case channel
        case metadata
        case userId = "user_id"
    }
}

/// Channels the Merlin app surfaces in the top-bar menu.
/// `chat` is the conversational stream the user reads day-to-day; `system` carries
/// Merlin's own health/watchdog/supervisor alerts so they never pollute chat.
enum ChatChannel: String, CaseIterable, Identifiable {
    case chat
    case system

    var id: String { rawValue }

    var displayName: String {
        switch self {
        case .chat: return "Chat"
        case .system: return "System"
        }
    }

    var symbol: String {
        switch self {
        case .chat: return "bubble.left.and.bubble.right"
        case .system: return "gearshape"
        }
    }
}

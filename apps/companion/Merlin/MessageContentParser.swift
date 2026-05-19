import Foundation

enum MessageSegment: Equatable {
    case markdown(String)
    case inlineImage(URL)
    case linkPreview(URL)

    static func == (lhs: MessageSegment, rhs: MessageSegment) -> Bool {
        switch (lhs, rhs) {
        case (.markdown(let a), .markdown(let b)): return a == b
        case (.inlineImage(let a), .inlineImage(let b)): return a == b
        case (.linkPreview(let a), .linkPreview(let b)): return a == b
        default: return false
        }
    }
}

struct MessageContentParser {
    private static let imageExtensions: Set<String> = ["png", "jpg", "jpeg", "gif", "webp", "svg", "avif", "heic"]

    /// Known image hosting domains — URLs from these are always treated as images.
    private static let imageHosts: Set<String> = [
        "i.imgur.com",
        "images.unsplash.com",
        "upload.wikimedia.org",
        "pbs.twimg.com",          // Twitter/X images
        "media.licdn.com",        // LinkedIn images
        "m.media-amazon.com",     // Amazon product images
    ]

    /// URL path/query patterns that indicate an image response.
    private static let imagePathPatterns: [String] = [
        "/photo-",                // Unsplash photo URLs
        "/wikipedia/commons/",    // Wikimedia Commons
        "/wp-content/uploads/",   // WordPress media
    ]

    /// Parse message content into renderable segments.
    /// Standalone URLs on their own line become images or link previews.
    /// Everything else is coalesced into markdown segments.
    static func parse(_ content: String) -> [MessageSegment] {
        let lines = content.components(separatedBy: "\n")
        var segments: [MessageSegment] = []
        var markdownBuffer: [String] = []

        func flushMarkdown() {
            let text = markdownBuffer.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
            if !text.isEmpty {
                segments.append(.markdown(text))
            }
            markdownBuffer.removeAll()
        }

        for line in lines {
            let trimmed = line.trimmingCharacters(in: .whitespaces)

            // Check if the entire line is a standalone URL, or a 🔗-prefixed URL
            let urlCandidate = stripLinkEmoji(trimmed)
            if let url = standaloneURL(from: urlCandidate) {
                if isImageURL(url) {
                    flushMarkdown()
                    segments.append(.inlineImage(url))
                } else if isPreviewableURL(url) {
                    flushMarkdown()
                    segments.append(.linkPreview(url))
                } else {
                    markdownBuffer.append(line)
                }
            } else if let url = markdownLinkOnOwnLine(from: urlCandidate) {
                // Standalone markdown link like [Name](https://...) on its own line
                // → render as link preview instead of plain markdown
                if isImageURL(url) {
                    flushMarkdown()
                    segments.append(.inlineImage(url))
                } else if isPreviewableURL(url) {
                    flushMarkdown()
                    segments.append(.linkPreview(url))
                } else {
                    markdownBuffer.append(line)
                }
            } else {
                markdownBuffer.append(line)
            }
        }

        flushMarkdown()
        return segments
    }

    /// Strip leading emoji + whitespace prefixes commonly used for link lines (e.g., "🔗 https://...")
    private static func stripLinkEmoji(_ text: String) -> String {
        var s = text
        // Strip leading emoji characters followed by whitespace
        while let first = s.unicodeScalars.first,
              first.properties.isEmoji && first.value > 0x23F, // skip ASCII symbols like #
              !s.isEmpty {
            s = String(s.drop(while: { $0.unicodeScalars.first.map { $0.properties.isEmoji && $0.value > 0x23F } ?? false }))
            s = s.trimmingCharacters(in: .whitespaces)
        }
        return s
    }

    /// Returns a URL if the entire string is a single URL (not markdown link syntax).
    private static func standaloneURL(from text: String) -> URL? {
        let trimmed = text.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty,
              !trimmed.hasPrefix("["),  // markdown link
              !trimmed.hasPrefix("!"),  // markdown image
              !trimmed.hasPrefix("("),
              trimmed.lowercased().hasPrefix("http"),
              let url = URL(string: trimmed),
              url.scheme != nil,
              url.host != nil else {
            return nil
        }

        // Verify the URL spans the entire line (no extra text)
        let detector = try? NSDataDetector(types: NSTextCheckingResult.CheckingType.link.rawValue)
        guard let match = detector?.firstMatch(in: trimmed, range: NSRange(trimmed.startIndex..., in: trimmed)) else {
            return nil
        }
        // The match must cover the full string
        guard match.range.location == 0, match.range.length == trimmed.utf16.count else {
            return nil
        }
        return url
    }

    private static func isImageURL(_ url: URL) -> Bool {
        // 1. Check file extension (works for most direct image links)
        let ext = url.pathExtension.lowercased()
        if imageExtensions.contains(ext) { return true }

        // 2. Check query params for format hints (CDNs like ?format=jpg&w=400)
        if let query = url.query?.lowercased() {
            if query.contains("format=jpg") || query.contains("format=jpeg") ||
               query.contains("format=png") || query.contains("format=webp") {
                return true
            }
        }

        // 3. Known image hosting domains
        if let host = url.host?.lowercased(), imageHosts.contains(host) {
            return true
        }

        // 4. URL path patterns that indicate images
        let absString = url.absoluteString.lowercased()
        for pattern in imagePathPatterns {
            if absString.contains(pattern) { return true }
        }

        // 5. Google Places photo URLs
        if absString.contains("places.googleapis.com") && absString.contains("/media") {
            return true
        }

        // 6. Supabase attachment images
        if absString.contains("merlin-attachments") {
            return true
        }

        return false
    }

    /// Detect a standalone markdown link `[text](url)` that fills the whole line.
    /// Returns the URL if matched, nil otherwise.
    private static func markdownLinkOnOwnLine(from text: String) -> URL? {
        let trimmed = text.trimmingCharacters(in: .whitespaces)
        // Match [anything](https://...)
        guard trimmed.hasPrefix("["),
              let closeBracket = trimmed.firstIndex(of: "]") else {
            return nil
        }
        // Guard against out-of-bounds: `]` may be the last character (e.g.,
        // "[just a bracketed phrase]" — no trailing `(url)`). Accessing one
        // past endIndex crashes with EXC_BREAKPOINT (Swift precondition).
        let afterBracket = trimmed.index(after: closeBracket)
        guard afterBracket < trimmed.endIndex,
              trimmed[afterBracket] == "(" else {
            return nil
        }
        // Extract URL between ( and )
        let rest = trimmed[trimmed.index(after: afterBracket)...]
        guard rest.hasSuffix(")") else { return nil }
        let urlString = String(rest.dropLast())
        guard let url = URL(string: urlString),
              url.scheme != nil,
              url.host != nil else {
            return nil
        }
        return url
    }

    private static func isPreviewableURL(_ url: URL) -> Bool {
        guard let scheme = url.scheme?.lowercased() else { return false }
        return scheme == "http" || scheme == "https"
    }
}

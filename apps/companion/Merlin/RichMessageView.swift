import SwiftUI
import MarkdownUI

#if os(macOS)
import AppKit
private let codeFill = Color(nsColor: NSColor(name: nil) { appearance in
    appearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
    ? NSColor(red: 58/255, green: 58/255, blue: 60/255, alpha: 1)
    : NSColor(red: 209/255, green: 209/255, blue: 214/255, alpha: 1)
})
#else
import UIKit
private let codeFill = Color(UIColor.systemGray4)
#endif

struct RichMessageView: View {
    let segments: [MessageSegment]

    init(content: String) {
        self.segments = MessageContentParser.parse(content)
    }

    /// Cheap fast-path: if the text has no markdown syntax characters, skip
    /// MarkdownUI (which builds a heavy AttributedString tree per render) and
    /// render as a plain Text. This matters most for fast scroll in a
    /// LazyVStack — thousands of bubbles can instantiate back-to-back, and
    /// per-bubble MarkdownUI work saturates the main thread.
    private static let markdownChars: Set<Character> = ["*", "_", "`", "#", ">", "[", "|", "~"]
    private static func hasMarkdown(_ text: String) -> Bool {
        for c in text { if markdownChars.contains(c) { return true } }
        return false
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(Array(segments.enumerated()), id: \.offset) { _, segment in
                switch segment {
                case .markdown(let text):
                    Markdown(text)
                        .markdownTheme(.merlin)
                        .markdownTextStyle {
                            ForegroundColor(.primary)
                        }
                        .textSelection(.enabled)
                case .inlineImage(let url):
                    InlineImageView(url: url)
                case .linkPreview(let url):
                    LinkPreviewCard(url: url)
                }
            }
        }
    }
}

// MARK: - Merlin Markdown Theme

enum MerlinFontSize {
    #if os(macOS)
    static let body: CGFloat = 16
    static let h1: CGFloat = 20
    static let h2: CGFloat = 18
    static let h3: CGFloat = 16
    static let code: CGFloat = 14
    static let codeBlock: CGFloat = 13
    #else
    static let body: CGFloat = 17
    static let h1: CGFloat = 22
    static let h2: CGFloat = 20
    static let h3: CGFloat = 17
    static let code: CGFloat = 15
    static let codeBlock: CGFloat = 14
    #endif
}

extension MarkdownUI.Theme {
    static let merlin = Theme()
        .text {
            ForegroundColor(.primary)
            FontSize(MerlinFontSize.body)
        }
        .heading1 { configuration in
            configuration.label
                .markdownTextStyle {
                    FontWeight(.bold)
                    FontSize(MerlinFontSize.h1)
                }
                .markdownMargin(top: 8, bottom: 4)
        }
        .heading2 { configuration in
            configuration.label
                .markdownTextStyle {
                    FontWeight(.semibold)
                    FontSize(MerlinFontSize.h2)
                }
                .markdownMargin(top: 6, bottom: 4)
        }
        .heading3 { configuration in
            configuration.label
                .markdownTextStyle {
                    FontWeight(.semibold)
                    FontSize(MerlinFontSize.h3)
                }
                .markdownMargin(top: 4, bottom: 2)
        }
        .code {
            FontFamilyVariant(.monospaced)
            FontSize(MerlinFontSize.code)
            BackgroundColor(codeFill)
        }
        .codeBlock { configuration in
            configuration.label
                .markdownTextStyle {
                    FontFamilyVariant(.monospaced)
                    FontSize(MerlinFontSize.codeBlock)
                }
                .padding(10)
                .background(codeFill)
                .clipShape(RoundedRectangle(cornerRadius: 8))
                .markdownMargin(top: 4, bottom: 4)
        }
        .link {
            ForegroundColor(.blue)
        }
        .listItem { configuration in
            configuration.label
                .markdownMargin(top: 2, bottom: 2)
        }
}

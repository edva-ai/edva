import SwiftUI
import UIKit

/// Loads exercise illustrations from the public Supabase Storage bucket, with
/// a disk-backed URLCache so each slug is fetched at most once across launches.
/// Falls back to the bundled asset if the request is pending or fails offline.
struct RemoteIllustration: View {
    let slug: String
    var contentMode: ContentMode = .fit
    var placeholderPadding: CGFloat = 0

    var body: some View {
        CachedAsyncImage(url: Self.url(for: slug)) { phase in
            switch phase {
            case .success(let image):
                image
                    .resizable()
                    .aspectRatio(contentMode: contentMode)
                    .padding(placeholderPadding)
            case .failure, .empty:
                BundledFallback(slug: slug, contentMode: contentMode, padding: placeholderPadding)
            @unknown default:
                BundledFallback(slug: slug, contentMode: contentMode, padding: placeholderPadding)
            }
        }
    }

    static func url(for slug: String) -> URL? {
        guard let base = AppConfig.supabaseURL else { return nil }
        return base.appending(path: "storage/v1/object/public/exercise-illustrations/\(slug).png")
    }
}

private struct BundledFallback: View {
    let slug: String
    let contentMode: ContentMode
    let padding: CGFloat

    var body: some View {
        if UIImage(named: slug) != nil {
            Image(slug)
                .resizable()
                .aspectRatio(contentMode: contentMode)
                .padding(padding)
        } else {
            Image(systemName: "figure.strengthtraining.traditional")
                .foregroundStyle(.black.opacity(0.4))
        }
    }
}

// MARK: - URLCache-backed async image

/// Minimal AsyncImage replacement that routes through a shared disk-backed
/// URLCache. Uses the default SwiftUI `AsyncImagePhase` for convenience but
/// pulls bytes through `IllustrationCache.shared.data(for:)` so repeat loads
/// hit disk, not the network.
struct CachedAsyncImage<Content: View>: View {
    let url: URL?
    let content: (AsyncImagePhase) -> Content

    @State private var phase: AsyncImagePhase = .empty

    init(url: URL?, @ViewBuilder content: @escaping (AsyncImagePhase) -> Content) {
        self.url = url
        self.content = content
    }

    var body: some View {
        content(phase)
            .task(id: url) {
                await load()
            }
    }

    private func load() async {
        guard let url else { phase = .empty; return }

        // Show any in-memory decoded image instantly so the UI isn't blank
        // while we revalidate against the server.
        if let cached = IllustrationCache.shared.cachedImage(for: url) {
            phase = .success(Image(uiImage: cached))
        } else {
            phase = .empty
        }

        // Always revalidate. URLSession uses .useProtocolCachePolicy +
        // server no-cache ETag, so this is a cheap conditional GET when
        // bytes haven't changed, and fetches new bytes when they have.
        do {
            let data = try await IllustrationCache.shared.data(for: url)
            if let image = UIImage(data: data) {
                phase = .success(Image(uiImage: image))
            } else if case .empty = phase {
                phase = .failure(URLError(.cannotDecodeContentData))
            }
        } catch {
            if case .empty = phase {
                phase = .failure(error)
            }
        }
    }
}

@MainActor
final class IllustrationCache {
    static let shared = IllustrationCache()

    private let session: URLSession
    private let memoryDecode = NSCache<NSURL, UIImage>()

    private init() {
        let cache = URLCache(
            memoryCapacity: 32 * 1024 * 1024,   // 32 MB
            diskCapacity: 256 * 1024 * 1024,    // 256 MB on disk
            diskPath: "exercise-illustrations"
        )
        let config = URLSessionConfiguration.default
        config.urlCache = cache
        // Honor the server's Cache-Control / ETag so that when we re-upload
        // an image in the Supabase bucket, URLSession revalidates via
        // If-None-Match and picks up the new bytes. Supabase Storage sends
        // `cache-control: no-cache` + `etag`, so each load is a cheap
        // conditional GET → 304 (no body) when unchanged, 200 with new
        // bytes when changed. Old .returnCacheDataElseLoad bypassed this
        // entirely and pinned stale images forever.
        config.requestCachePolicy = .useProtocolCachePolicy
        self.session = URLSession(configuration: config)
        memoryDecode.countLimit = 80
    }

    /// In-memory decoded image hit — safe to return even when we'll also
    /// fire a revalidation fetch in the background, because server
    /// cache-control is `no-cache` and any bytes we have are already the
    /// authoritative latest-we-saw. If server has new bytes, the
    /// revalidation call replaces this entry.
    func cachedImage(for url: URL) -> UIImage? {
        memoryDecode.object(forKey: url as NSURL)
    }

    func data(for url: URL) async throws -> Data {
        // `.useProtocolCachePolicy` + server no-cache = conditional GET.
        // Returns cached Data on 304, fresh Data on 200.
        let (data, _) = try await session.data(from: url)
        if let image = UIImage(data: data) {
            memoryDecode.setObject(image, forKey: url as NSURL)
        }
        return data
    }
}

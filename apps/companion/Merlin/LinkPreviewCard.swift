import SwiftUI
import LinkPresentation
import CryptoKit

#if os(macOS)
import AppKit
typealias PlatformImage = NSImage
private let previewFill = Color(nsColor: NSColor(name: nil) { appearance in
    appearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
    ? NSColor(red: 58/255, green: 58/255, blue: 60/255, alpha: 1)
    : NSColor(red: 209/255, green: 209/255, blue: 214/255, alpha: 1)
})
#else
import UIKit
typealias PlatformImage = UIImage
private let previewFill = Color(UIColor.systemGray4)
#endif

private func openExternalURL(_ url: URL) {
    #if os(macOS)
    NSWorkspace.shared.open(url)
    #else
    UIApplication.shared.open(url)
    #endif
}

private extension Image {
    init(platformImage: PlatformImage) {
        #if os(macOS)
        self.init(nsImage: platformImage)
        #else
        self.init(uiImage: platformImage)
        #endif
    }
}

struct LinkPreviewCard: View {
    let url: URL
    @State private var title: String?
    @State private var icon: PlatformImage?
    @State private var loaded = false
    @State private var fetchTask: Task<Void, Never>?

    var body: some View {
        Button {
            openExternalURL(url)
        } label: {
            HStack(spacing: 10) {
                if let icon {
                    Image(platformImage: icon)
                        .resizable()
                        .scaledToFill()
                        .frame(width: 48, height: 48)
                        .clipShape(RoundedRectangle(cornerRadius: 8))
                } else if !loaded {
                    RoundedRectangle(cornerRadius: 8)
                        .fill(previewFill)
                        .frame(width: 48, height: 48)
                        .overlay(ProgressView().scaleEffect(0.6))
                }

                VStack(alignment: .leading, spacing: 2) {
                    Text(title ?? url.host ?? url.absoluteString)
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(.primary)
                        .lineLimit(2)
                        .multilineTextAlignment(.leading)

                    Text(url.host ?? url.absoluteString)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }

                Spacer(minLength: 0)
            }
            .padding(10)
            .background(previewFill)
            .clipShape(RoundedRectangle(cornerRadius: 12))
        }
        .buttonStyle(.plain)
        .task {
            guard !loaded else { return }
            await fetchMetadata()
        }
        .onDisappear {
            fetchTask?.cancel()
        }
    }

    private func fetchMetadata() async {
        if let cached = LinkMetadataCache.shared.get(url) {
            self.title = cached.title
            self.icon = cached.image
            self.loaded = true
            return
        }

        let task = Task.detached {
            let provider = LPMetadataProvider()
            provider.shouldFetchSubresources = true
            provider.timeout = 8

            do {
                let metadata = try await provider.startFetchingMetadata(for: url)
                let fetchedTitle = metadata.title
                var fetchedImage: PlatformImage?

                // Try image first, then icon
                let imageProvider = metadata.imageProvider ?? metadata.iconProvider
                if let provider = imageProvider {
                    fetchedImage = try? await withCheckedThrowingContinuation { (cont: CheckedContinuation<PlatformImage, Error>) in
                        provider.loadObject(ofClass: PlatformImage.self) { object, error in
                            if let img = object as? PlatformImage {
                                cont.resume(returning: img)
                            } else {
                                cont.resume(throwing: error ?? URLError(.unknown))
                            }
                        }
                    }
                }

                let entry = CachedLinkMetadata(title: fetchedTitle, image: fetchedImage)
                await MainActor.run {
                    LinkMetadataCache.shared.set(entry, for: url)
                    self.title = fetchedTitle
                    self.icon = fetchedImage
                    self.loaded = true
                }
            } catch {
                await MainActor.run {
                    self.loaded = true // stop showing spinner
                }
            }
        }

        await MainActor.run {
            self.fetchTask = task
        }
        await task.value
    }
}

// MARK: - Cache

struct CachedLinkMetadata {
    let title: String?
    let image: PlatformImage?
}

final class LinkMetadataCache: @unchecked Sendable {
    static let shared = LinkMetadataCache()
    private var memory: [URL: CachedLinkMetadata] = [:]
    private let lock = NSLock()
    private let diskDir: URL

    private init() {
        let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first!
        diskDir = caches.appendingPathComponent("LinkPreviews", isDirectory: true)
        try? FileManager.default.createDirectory(at: diskDir, withIntermediateDirectories: true)
    }

    func get(_ url: URL) -> CachedLinkMetadata? {
        lock.lock()
        defer { lock.unlock() }

        // Memory hit
        if let cached = memory[url] { return cached }

        // Disk hit
        let key = diskKey(for: url)
        let metaFile = diskDir.appendingPathComponent("\(key).json")
        guard let metaData = try? Data(contentsOf: metaFile),
              let meta = try? JSONDecoder().decode(DiskMeta.self, from: metaData) else {
            return nil
        }

        var image: PlatformImage?
        let imgFile = diskDir.appendingPathComponent("\(key).img")
        if let imgData = try? Data(contentsOf: imgFile) {
            image = PlatformImage(data: imgData)
        }

        let entry = CachedLinkMetadata(title: meta.title, image: image)
        memory[url] = entry
        return entry
    }

    func set(_ metadata: CachedLinkMetadata, for url: URL) {
        lock.lock()
        defer { lock.unlock() }

        memory[url] = metadata

        // Write-through to disk (fire and forget on background queue)
        let key = diskKey(for: url)
        let dir = diskDir
        let title = metadata.title
        let imageData: Data? = {
            guard let img = metadata.image else { return nil }
            #if os(macOS)
            guard let tiff = img.tiffRepresentation,
                  let rep = NSBitmapImageRep(data: tiff) else { return nil }
            return rep.representation(using: .jpeg, properties: [.compressionFactor: 0.8])
            #else
            return img.jpegData(compressionQuality: 0.8)
            #endif
        }()

        DispatchQueue.global(qos: .utility).async {
            let meta = DiskMeta(title: title)
            if let data = try? JSONEncoder().encode(meta) {
                try? data.write(to: dir.appendingPathComponent("\(key).json"))
            }
            if let imgData = imageData {
                try? imgData.write(to: dir.appendingPathComponent("\(key).img"))
            }
        }
    }

    private func diskKey(for url: URL) -> String {
        let digest = SHA256.hash(data: Data(url.absoluteString.utf8))
        return digest.prefix(16).map { String(format: "%02x", $0) }.joined()
    }
}

private struct DiskMeta: Codable {
    let title: String?
}

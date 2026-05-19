import SwiftUI

struct InlineImageView: View {
    let url: URL

    var body: some View {
        AsyncImage(url: url) { phase in
            switch phase {
            case .success(let image):
                image
                    .resizable()
                    .scaledToFit()
                    .frame(maxWidth: 260)
                    .clipShape(RoundedRectangle(cornerRadius: 12))
            case .failure:
                Label("Image failed to load", systemImage: "photo")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            default:
                ProgressView()
                    .frame(width: 120, height: 80)
            }
        }
    }
}

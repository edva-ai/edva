import SwiftUI
import UIKit

/// Full-screen zoom/pan viewer for an exercise illustration.
/// Rotates freely when the user turns the device (see OrientationLock).
struct IllustrationFullscreen: View {
    let assetName: String
    let title: String

    @Environment(\.dismiss) private var dismiss
    @State private var scale: CGFloat = 1.0
    @State private var offset: CGSize = .zero
    @GestureState private var magnify: CGFloat = 1.0
    @GestureState private var drag: CGSize = .zero

    var body: some View {
        ZStack {
            Color.white.ignoresSafeArea()

            RemoteIllustration(slug: assetName, contentMode: .fit)
                    .scaleEffect(scale * magnify)
                    .offset(
                        x: offset.width + drag.width,
                        y: offset.height + drag.height
                    )
                    .gesture(
                        MagnificationGesture()
                            .updating($magnify) { current, state, _ in state = current }
                            .onEnded { final in
                                scale = min(max(scale * final, 1.0), 5.0)
                                if scale == 1.0 { offset = .zero }
                            }
                            .simultaneously(with:
                                DragGesture()
                                    .updating($drag) { value, state, _ in
                                        if scale > 1.0 { state = value.translation }
                                    }
                                    .onEnded { value in
                                        if scale > 1.0 {
                                            offset.width += value.translation.width
                                            offset.height += value.translation.height
                                        }
                                    }
                            )
                    )
                    .onTapGesture(count: 2) {
                        withAnimation(.spring) {
                            scale = scale > 1.0 ? 1.0 : 2.5
                            if scale == 1.0 { offset = .zero }
                        }
                    }

            VStack {
                HStack {
                    Button {
                        dismiss()
                    } label: {
                        Image(systemName: "xmark.circle.fill")
                            .font(.largeTitle)
                            .foregroundStyle(.black.opacity(0.75), .white.opacity(0.9))
                            .symbolRenderingMode(.palette)
                    }
                    Spacer()
                    Text(title)
                        .font(.headline)
                        .foregroundStyle(.black)
                        .lineLimit(1)
                        .minimumScaleFactor(0.7)
                    Spacer()
                    Color.clear.frame(width: 36, height: 36)
                }
                .padding(.horizontal, 20)
                .padding(.top, 12)
                Spacer()
            }
        }
        .statusBarHidden(true)
        .preferredColorScheme(.light)
        .allowAllOrientations()
    }
}

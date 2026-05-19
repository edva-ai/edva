import SwiftUI

/// A soft, animated gradient that reads as "Liquid Glass" friendly.
struct AppBackground: View {
    @State private var phase: CGFloat = 0

    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 30)) { context in
            let t = context.date.timeIntervalSinceReferenceDate
            ZStack {
                LinearGradient(
                    colors: [
                        Color(red: 0.05, green: 0.07, blue: 0.16),
                        Color(red: 0.10, green: 0.12, blue: 0.24),
                        Color(red: 0.15, green: 0.10, blue: 0.28)
                    ],
                    startPoint: .topLeading,
                    endPoint: .bottomTrailing
                )

                // Two softly moving highlights for subtle movement
                Circle()
                    .fill(Color.accentColor.opacity(0.35))
                    .frame(width: 420, height: 420)
                    .blur(radius: 90)
                    .offset(
                        x: CGFloat(sin(t * 0.25)) * 140,
                        y: CGFloat(cos(t * 0.20)) * 200 - 220
                    )

                Circle()
                    .fill(Color(red: 0.45, green: 0.3, blue: 0.9).opacity(0.32))
                    .frame(width: 360, height: 360)
                    .blur(radius: 100)
                    .offset(
                        x: CGFloat(cos(t * 0.22)) * 160,
                        y: CGFloat(sin(t * 0.28)) * 180 + 260
                    )
            }
            .ignoresSafeArea()
        }
    }
}

/// App-wide palette. Picked to harmonize with the dark navy / purple
/// animated gradient background. All key CTAs share `cta` so the action
/// affordance reads consistently across the app.
enum Palette {
    /// Primary action tint — used on all key CTAs (Start/Resume workout,
    /// Log exercise, Finish workout). Light purple.
    static let cta = Color(red: 0.78, green: 0.66, blue: 1.00)

    /// Aliases that point to `cta` so existing call sites keep working.
    static let start = cta
    static let log = cta
    static let finish = cta

    /// "Superset / related items" — GroupFrame chip. Slightly deeper
    /// indigo so the chip is distinct from the main CTAs.
    static let group = Color(red: 0.62, green: 0.56, blue: 1.00)

    /// Success / "workout complete" tint — a warm, slightly minted green
    /// that reads clearly on the dark glass backdrop.
    static let complete = Color(red: 0.35, green: 0.82, blue: 0.52)
}

extension View {
    /// Applies a subtle "liquid glass" card styling.
    /// Set `enabled: false` to pass through unchanged — handy for rows that
    /// should render bare when embedded inside another card (e.g. GroupFrame).
    @ViewBuilder
    func liquidCard(cornerRadius: CGFloat = 22, enabled: Bool = true) -> some View {
        if enabled {
            self
                .background {
                    RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                        .fill(.ultraThinMaterial)
                }
                .overlay {
                    RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                        .stroke(.white.opacity(0.14), lineWidth: 0.5)
                }
                .clipShape(RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
                .shadow(color: .black.opacity(0.25), radius: 12, x: 0, y: 8)
        } else {
            self
        }
    }

    /// Floating action button ("Log set", "Start workout", etc.).
    /// Same liquid-glass material as `.liquidCard` with a brighter fill +
    /// stronger border so the button pops. A `tint` parameter mixes a
    /// subtle color wash into the glass (default is neutral white).
    func liquidButton(cornerRadius: CGFloat = 22, tint: Color = .white) -> some View {
        self
            .background {
                ZStack {
                    RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                        .fill(.ultraThinMaterial)
                    RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                        .fill(tint.opacity(0.32))
                }
            }
            .overlay {
                RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                    .stroke(tint.opacity(0.55), lineWidth: 0.75)
            }
            .clipShape(RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
            .shadow(color: .black.opacity(0.35), radius: 18, x: 0, y: 10)
            .foregroundStyle(.white)
    }
}

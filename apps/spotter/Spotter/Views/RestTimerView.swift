import SwiftUI
import AudioToolbox

struct RestTimerView: View {
    let duration: Int

    @Environment(\.dismiss) private var dismiss
    @State private var remaining: Int
    @State private var isRunning: Bool = true

    init(duration: Int) {
        self.duration = duration
        _remaining = State(initialValue: duration)
    }

    private let timer = Timer.publish(every: 1, on: .main, in: .common).autoconnect()

    var body: some View {
        ZStack {
            AppBackground()
            VStack(spacing: 24) {
                Spacer()
                Text("Rest")
                    .font(.title2.weight(.semibold))
                    .foregroundStyle(.white.opacity(0.8))
                timerRing
                controls
                Spacer()
            }
            .padding()
        }
        .onReceive(timer) { _ in tick() }
    }

    private var timerRing: some View {
        ZStack {
            Circle()
                .stroke(.white.opacity(0.18), lineWidth: 14)
            Circle()
                .trim(from: 0, to: CGFloat(remaining) / CGFloat(max(1, duration)))
                .stroke(.white, style: StrokeStyle(lineWidth: 14, lineCap: .round))
                .rotationEffect(.degrees(-90))
                .animation(.linear(duration: 0.25), value: remaining)
            Text("\(remaining)s")
                .font(.system(size: 72, weight: .semibold, design: .rounded).monospacedDigit())
                .foregroundStyle(.white)
        }
        .frame(width: 220, height: 220)
    }

    private var controls: some View {
        HStack(spacing: 16) {
            // Restart the rest from the beginning AND pause it. Use when
            // the user feels they need a fresh full rest period.
            Button {
                remaining = duration
                isRunning = false
                UIImpactFeedbackGenerator(style: .light).impactOccurred()
            } label: {
                Label("Restart", systemImage: "backward.end.fill")
                    .labelStyle(.iconOnly)
                    .font(.title3)
                    .frame(width: 44, height: 44)
            }
            .buttonStyle(.bordered)
            .tint(.white)

            Button {
                isRunning.toggle()
            } label: {
                Image(systemName: isRunning ? "pause.fill" : "play.fill")
                    .font(.title2)
                    .padding(20)
                    .background(Circle().fill(.white))
                    .foregroundStyle(.black)
            }
            .buttonStyle(.plain)

            // Skip the remaining rest and continue the workout.
            Button {
                remaining = 0
                finish()
            } label: {
                Label("Skip", systemImage: "forward.end.fill")
                    .labelStyle(.iconOnly)
                    .font(.title3)
                    .frame(width: 44, height: 44)
            }
            .buttonStyle(.bordered)
            .tint(.white)
        }
    }

    private func finish() {
        AudioServicesPlaySystemSound(1054)
        UINotificationFeedbackGenerator().notificationOccurred(.success)
        dismiss()
    }

    private func tick() {
        guard isRunning else { return }
        if remaining <= 0 {
            finish()
            return
        }
        remaining -= 1
    }
}

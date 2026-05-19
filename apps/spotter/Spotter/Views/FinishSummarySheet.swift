import SwiftUI

struct FinishSummarySheet: View {
    let session: WorkoutSession

    @Environment(\.dismiss) private var dismiss

    private var spec: WorkoutSpec { WorkoutCatalog.spec(for: session.workoutType) }

    private var duration: String {
        guard let end = session.finishedAt else { return "—" }
        let mins = Int(end.timeIntervalSince(session.startedAt) / 60)
        if mins < 1 { return "< 1 min" }
        return "\(mins) min"
    }

    private var exercisesCompleted: Int {
        Set(session.sets.map(\.exerciseSlug)).count
    }

    var body: some View {
        ZStack {
            AppBackground()

            VStack(spacing: 22) {
                VStack(spacing: 10) {
                    Image(systemName: "checkmark.seal.fill")
                        .font(.system(size: 54, weight: .semibold))
                        .foregroundStyle(.white, .green)
                        .symbolRenderingMode(.palette)
                    Text("Nice work.")
                        .font(.largeTitle.weight(.bold))
                        .foregroundStyle(.white)
                    Text(spec.title)
                        .font(.title3.weight(.semibold))
                        .foregroundStyle(.white.opacity(0.8))
                }
                .padding(.top, 24)

                HStack(spacing: 14) {
                    stat(value: "\(session.sets.count)", label: "sets")
                    stat(value: "\(exercisesCompleted)", label: "exercises")
                    stat(value: duration, label: "duration")
                }
                .padding(.horizontal, 16)

                Spacer()

                Button {
                    dismiss()
                } label: {
                    Text("Done")
                        .font(.body.weight(.semibold))
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 16)
                        .background {
                            RoundedRectangle(cornerRadius: 22, style: .continuous).fill(.white)
                        }
                        .foregroundStyle(.black)
                }
                .buttonStyle(.plain)
                .padding(.horizontal, 20)
                .padding(.bottom, 24)
            }
        }
    }

    private func stat(value: String, label: String) -> some View {
        VStack(spacing: 2) {
            Text(value)
                .font(.title.weight(.bold).monospacedDigit())
                .foregroundStyle(.white)
            Text(label.uppercased())
                .font(.caption2.weight(.bold))
                .foregroundStyle(.white.opacity(0.65))
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 14)
        .liquidCard(cornerRadius: 18)
    }
}

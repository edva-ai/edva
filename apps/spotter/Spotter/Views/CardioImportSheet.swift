import SwiftUI
import SwiftData

struct CardioImportSheet: View {
    @Bindable var session: WorkoutSession
    @Environment(\.modelContext) private var context
    @Environment(\.dismiss) private var dismiss

    @State private var isLoading = true
    @State private var candidates: [HealthKitService.WorkoutSummary] = []
    @State private var selected: HealthKitService.WorkoutSummary.ID?
    @State private var errorMessage: String?

    private let service = HealthKitService()

    var body: some View {
        ZStack {
            AppBackground()
            VStack(alignment: .leading, spacing: 14) {
                HStack {
                    Label("Import from Apple Watch", systemImage: "applewatch")
                        .font(.headline)
                        .foregroundStyle(.white)
                    Spacer()
                    Button { dismiss() } label: {
                        Image(systemName: "xmark.circle.fill")
                            .foregroundStyle(.white.opacity(0.6))
                            .font(.title3)
                    }
                    .buttonStyle(.plain)
                }

                if isLoading {
                    HStack { Spacer(); ProgressView().controlSize(.large); Spacer() }
                        .frame(height: 120)
                } else if let errorMessage {
                    Text(errorMessage)
                        .foregroundStyle(.red)
                        .font(.callout)
                } else if candidates.isEmpty {
                    emptyState
                } else {
                    ScrollView {
                        VStack(spacing: 10) {
                            ForEach(candidates) { w in
                                candidateRow(w)
                            }
                        }
                    }
                    Button(action: applySelection) {
                        Text("Import")
                            .font(.body.weight(.semibold))
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 14)
                            .background {
                                RoundedRectangle(cornerRadius: 20).fill(.white)
                            }
                            .foregroundStyle(.black)
                    }
                    .buttonStyle(.plain)
                    .disabled(selected == nil)
                    .opacity(selected == nil ? 0.6 : 1)
                }
            }
            .padding(20)
        }
        .task { await load() }
    }

    private var emptyState: some View {
        VStack(spacing: 8) {
            Image(systemName: "figure.walk")
                .font(.largeTitle)
                .foregroundStyle(.white.opacity(0.6))
            Text("No recent workouts")
                .font(.headline)
                .foregroundStyle(.white)
            Text("We didn't find any workouts in the last three hours on your Apple Watch.")
                .font(.callout)
                .foregroundStyle(.white.opacity(0.7))
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 20)
    }

    private func candidateRow(_ w: HealthKitService.WorkoutSummary) -> some View {
        HStack(spacing: 12) {
            Image(systemName: "applewatch")
                .font(.title3)
                .foregroundStyle(.white)
                .frame(width: 36, height: 36)
                .background(Circle().fill(.white.opacity(0.14)))
            VStack(alignment: .leading, spacing: 2) {
                Text(w.activityName)
                    .font(.body.weight(.semibold))
                    .foregroundStyle(.white)
                Text("\(w.start.formatted(.dateTime.hour().minute())) · \(Int(w.duration / 60)) min")
                    .font(.caption)
                    .foregroundStyle(.white.opacity(0.7))
            }
            Spacer()
            Image(systemName: selected == w.id ? "checkmark.circle.fill" : "circle")
                .foregroundStyle(selected == w.id ? .white : .white.opacity(0.3))
                .font(.title3)
        }
        .padding(12)
        .liquidCard(cornerRadius: 16)
        .contentShape(Rectangle())
        .onTapGesture { selected = w.id }
    }

    private func load() async {
        do {
            try await service.requestAuthorization()
            let windowStart = Date.now.addingTimeInterval(-3 * 3600)
            candidates = try await service.workouts(from: windowStart, to: .now)
            if candidates.count == 1 { selected = candidates.first?.id }
        } catch {
            errorMessage = error.localizedDescription
        }
        isLoading = false
    }

    private func applySelection() {
        guard let id = selected, let w = candidates.first(where: { $0.id == id }) else { return }
        session.startedAt = w.start
        session.finishedAt = w.end
        session.healthKitWorkoutUUID = w.id

        // Persist a duration log so it shows up under the cardio exercise.
        let slug = session.workoutType == .cardioIntervals ? "cardio_intervals" : "cardio_steady"
        let existing = session.sets.filter { $0.exerciseSlug == slug }
        let nextNumber = (existing.map(\.setNumber).max() ?? 0) + 1
        let log = SetLog(
            exerciseSlug: slug,
            setNumber: nextNumber,
            durationSeconds: Int(w.duration),
            completedAt: w.end,
            notes: "Imported from Apple Watch"
        )
        log.session = session
        session.sets.append(log)
        context.insert(log)
        try? context.save()

        UIImpactFeedbackGenerator(style: .medium).impactOccurred()
        dismiss()
    }
}

import SwiftUI
import SwiftData

struct SessionDetailView: View {
    @Bindable var session: WorkoutSession
    @Environment(\.modelContext) private var context

    private var spec: WorkoutSpec { WorkoutCatalog.spec(for: session.workoutType) }

    private var setsByExercise: [(ExerciseSpec, [SetLog])] {
        let grouped = Dictionary(grouping: session.sets) { $0.exerciseSlug }
        return spec.exercises.compactMap { ex -> (ExerciseSpec, [SetLog])? in
            guard let logs = grouped[ex.id], !logs.isEmpty else { return nil }
            return (ex, logs.sorted(by: { $0.setNumber < $1.setNumber }))
        }
    }

    var body: some View {
        ZStack {
            AppBackground()
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    header
                    ForEach(setsByExercise, id: \.0.id) { ex, logs in
                        ExerciseHistoryCard(exercise: ex, logs: logs)
                    }
                    if setsByExercise.isEmpty {
                        Text("No sets logged for this session.")
                            .foregroundStyle(.white.opacity(0.7))
                    }

                    notesField

                    Color.clear.frame(height: 40)
                }
                .padding(16)
            }
        }
        .navigationTitle(spec.title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbarColorScheme(.dark, for: .navigationBar)
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(session.startedAt.formatted(.dateTime.weekday(.wide).month().day().hour().minute()))
                .font(.subheadline)
                .foregroundStyle(.white.opacity(0.75))
            if let end = session.finishedAt {
                Text("Duration: \(Int(end.timeIntervalSince(session.startedAt) / 60)) min")
                    .font(.caption.weight(.medium))
                    .foregroundStyle(.white.opacity(0.7))
            } else {
                Text("In progress")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(.orange)
            }
            if session.remoteSyncedAt != nil {
                Label("Synced", systemImage: "icloud.fill")
                    .font(.caption2)
                    .foregroundStyle(.white.opacity(0.6))
            }
        }
    }

    private var notesField: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Notes")
                .font(.headline).foregroundStyle(.white)
            TextEditor(text: Binding(
                get: { session.notes },
                set: { session.notes = $0; try? context.save() }
            ))
            .scrollContentBackground(.hidden)
            .foregroundStyle(.white)
            .tint(.white)
            .frame(minHeight: 90)
            .padding(10)
            .background {
                RoundedRectangle(cornerRadius: 14)
                    .fill(.white.opacity(0.14))
                    .overlay {
                        RoundedRectangle(cornerRadius: 14)
                            .stroke(.white.opacity(0.25), lineWidth: 0.5)
                    }
            }
        }
    }
}

struct ExerciseHistoryCard: View {
    @Query private var settingsList: [AppSettings]
    private var unit: WeightUnit { settingsList.first?.weightUnit ?? .lbs }

    let exercise: ExerciseSpec
    let logs: [SetLog]

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                IllustrationThumb(assetName: exercise.id, title: exercise.name)
                    .frame(width: 80, height: 52)
                VStack(alignment: .leading) {
                    Text(exercise.name)
                        .font(.body.weight(.semibold))
                        .foregroundStyle(.white)
                    Text(exercise.targetLabel)
                        .font(.caption)
                        .foregroundStyle(.white.opacity(0.7))
                }
                Spacer()
            }
            ForEach(logs) { log in
                HStack {
                    Text("Set \(log.setNumber)\(log.side.map { " (\($0))" } ?? "")")
                        .foregroundStyle(.white)
                    Spacer()
                    Text(formatLog(log))
                        .monospacedDigit()
                        .foregroundStyle(.white.opacity(0.9))
                }
                .font(.callout)
                .padding(.vertical, 4)
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .liquidCard()
    }

    private func formatLog(_ log: SetLog) -> String {
        var parts: [String] = []
        if let r = log.reps { parts.append("\(r)") }
        if let w = log.weightLbs { parts.append("× \(unit.format(lbs: w))\(unit.shortSuffix)") }
        if let d = log.durationSeconds {
            if exercise.unit == .minutes { parts.append("\(d / 60)min") } else { parts.append("\(d)s") }
        }
        return parts.joined(separator: " ")
    }
}

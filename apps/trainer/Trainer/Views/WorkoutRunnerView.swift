import SwiftUI
import SwiftData

struct WorkoutRunnerView: View {
    @Bindable var session: WorkoutSession
    @Environment(\.modelContext) private var context
    @Environment(\.dismiss) private var dismiss

    @State private var activeExercise: ExerciseSpec?
    @State private var showFinishConfirm = false
    @State private var showFinishSummary = false
    @State private var showHealthImport = false
    @State private var healthImportError: String?

    private var spec: WorkoutSpec { WorkoutCatalog.spec(for: session.workoutType) }

    var body: some View {
        NavigationStack {
            ZStack {
                AppBackground()
                ScrollView {
                    VStack(alignment: .leading, spacing: 18) {
                        sessionHeader
                        if session.workoutType.isRest {
                            restDayCard
                        } else {
                            ForEach(spec.exerciseGroups) { group in
                                groupSection(for: group)
                            }
                        }
                        Color.clear.frame(height: 80)
                    }
                    .padding(.horizontal, 16)
                    .padding(.top, 8)
                }

                VStack {
                    Spacer()
                    finishButton
                        .padding(.horizontal, 20)
                        .padding(.bottom, 16)
                }
            }
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button {
                        dismiss()
                    } label: {
                        Label("Close", systemImage: "xmark.circle.fill")
                            .labelStyle(.iconOnly)
                            .foregroundStyle(.white.opacity(0.8))
                    }
                }
            }
            .sheet(item: $activeExercise) { exercise in
                SetLogSheet(
                    session: session,
                    exercise: exercise,
                    workoutSpec: spec,
                    onLogged: { handlePostLog(after: exercise) }
                )
                .presentationDetents([.large])
                .presentationDragIndicator(.visible)
            }
            .sheet(isPresented: $showFinishSummary, onDismiss: { dismiss() }) {
                FinishSummarySheet(session: session)
                    .presentationDetents([.medium, .large])
                    .presentationDragIndicator(.visible)
            }
            .sheet(isPresented: $showHealthImport) {
                CardioImportSheet(session: session)
                    .presentationDetents([.medium])
            }
            .alert("HealthKit", isPresented: Binding(
                get: { healthImportError != nil },
                set: { if !$0 { healthImportError = nil } }
            )) {
                Button("OK") { healthImportError = nil }
            } message: {
                Text(healthImportError ?? "")
            }
            .confirmationDialog("Finish this workout?", isPresented: $showFinishConfirm, titleVisibility: .visible) {
                Button("Finish & save", role: .destructive) { finish() }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("We'll save all logged sets and sync to your history.")
            }
        }
    }

    private var sessionHeader: some View {
        VStack(alignment: .leading, spacing: 10) {
            VStack(alignment: .leading, spacing: 4) {
                Text(spec.title)
                    .font(.largeTitle.weight(.bold))
                    .foregroundStyle(.white)
                Text(session.startedAt.formatted(.relative(presentation: .named)))
                    .font(.subheadline)
                    .foregroundStyle(.white.opacity(0.65))
            }
            if isCardio {
                Button {
                    showHealthImport = true
                } label: {
                    Label("Import from Apple Watch", systemImage: "applewatch")
                        .font(.subheadline.weight(.semibold))
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 10)
                        .background {
                            Capsule().fill(.white.opacity(0.18))
                                .overlay { Capsule().stroke(.white.opacity(0.3), lineWidth: 0.5) }
                        }
                        .foregroundStyle(.white)
                }
                .buttonStyle(.plain)
            }
        }
    }

    private var isCardio: Bool {
        session.workoutType == .cardioSteady || session.workoutType == .cardioIntervals
    }

    /// Finds the next unfinished exercise in the workout's linear order so
    /// the log sheet can auto-advance. Skips anything already fully
    /// logged. Returns nil when everything after `current` is done.
    private func nextExercise(after current: ExerciseSpec) -> ExerciseSpec? {
        guard let idx = spec.exercises.firstIndex(where: { $0.id == current.id }) else { return nil }
        for i in (idx + 1)..<spec.exercises.count where !isFullyLogged(spec.exercises[i]) {
            return spec.exercises[i]
        }
        return nil
    }

    /// When the user taps an exercise card: if it's already fully logged,
    /// jump forward to the next unfinished one. Otherwise open it
    /// directly. Covers the "resume the workout" case where the first
    /// card the user sees may already be complete.
    private func openExerciseSheet(for exercise: ExerciseSpec) {
        if isFullyLogged(exercise),
           let next = firstUnfinishedFrom(exercise) {
            activeExercise = next
        } else {
            activeExercise = exercise
        }
    }

    private func firstUnfinishedFrom(_ start: ExerciseSpec) -> ExerciseSpec? {
        guard let idx = spec.exercises.firstIndex(where: { $0.id == start.id }) else { return nil }
        for i in idx..<spec.exercises.count where !isFullyLogged(spec.exercises[i]) {
            return spec.exercises[i]
        }
        return nil
    }

    private func isFullyLogged(_ exercise: ExerciseSpec) -> Bool {
        let target = ExerciseTargetStore(context: context).effective(for: exercise)
        let needed = target.sets * (exercise.bilateral ? 2 : 1)
        let logged = session.sets.filter { $0.exerciseSlug == exercise.id }.count
        return logged >= needed
    }

    private var allExercisesFullyLogged: Bool {
        !spec.exercises.isEmpty && spec.exercises.allSatisfy { isFullyLogged($0) }
    }

    /// Called by SetLogSheet after it records an exercise. Advances to
    /// the next unfinished exercise, or — when the whole workout is
    /// fully logged — auto-triggers the finish flow so the user doesn't
    /// have to tap Finish workout manually.
    private func handlePostLog(after exercise: ExerciseSpec) {
        if let next = nextExercise(after: exercise) {
            activeExercise = next
            return
        }
        activeExercise = nil
        if allExercisesFullyLogged {
            finish()
        }
    }

    @ViewBuilder
    private func groupSection(for group: WorkoutSpec.ExerciseGroup) -> some View {
        if let gid = group.groupID, group.exercises.count >= 2 {
            GroupFrame(groupNumber: gid) {
                ForEach(Array(group.exercises.enumerated()), id: \.element.id) { idx, exercise in
                    if idx > 0 { GroupFrameDivider() }
                    RunnerExerciseCard(
                        exercise: exercise,
                        sets: session.sets.filter { $0.exerciseSlug == exercise.id },
                        hasBackground: false
                    )
                    .onTapGesture { openExerciseSheet(for: exercise) }
                }
            }
        } else if let exercise = group.exercises.first {
            RunnerExerciseCard(
                exercise: exercise,
                sets: session.sets.filter { $0.exerciseSlug == exercise.id }
            )
            .onTapGesture { activeExercise = exercise }
        }
    }

    private var restDayCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            Image(systemName: "leaf.fill")
                .font(.largeTitle)
                .foregroundStyle(.mint)
            Text("Recovery matters")
                .font(.title3.weight(.semibold))
                .foregroundStyle(.white)
            Text("An easy walk, gentle stretching, or just extra sleep all count. Tap Finish when you're done.")
                .font(.body)
                .foregroundStyle(.white.opacity(0.85))
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(20)
        .liquidCard(cornerRadius: 24)
    }

    private var finishButton: some View {
        Button {
            showFinishConfirm = true
        } label: {
            HStack {
                Image(systemName: "checkmark.seal.fill")
                Text("Finish workout")
                    .font(.body.weight(.semibold))
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 16)
            .liquidButton(tint: Palette.finish)
        }
        .buttonStyle(.plain)
    }

    private func finish() {
        session.finishedAt = .now
        try? context.save()
        NotificationScheduler.shared.refreshTodayReminder(context: context)
        Task {
            if let auth = AuthServiceHolder.shared {
                let sync = SupabaseSync(authService: auth, context: context)
                await sync.pushPendingSessions()
                await sync.pushLocalPrefs()
            }
        }
        // Show the summary sheet; its onDismiss will pop the runner.
        showFinishSummary = true
    }
}

// Lightweight singleton so we can kick off sync without a full env injection.
@MainActor
enum AuthServiceHolder {
    static var shared: AuthService?
}

// MARK: - Runner exercise card

struct RunnerExerciseCard: View {
    @Environment(\.modelContext) private var context
    @Query private var settingsList: [AppSettings]
    private var unit: WeightUnit { settingsList.first?.weightUnit ?? .lbs }

    let exercise: ExerciseSpec
    let sets: [SetLog]
    var hasBackground: Bool = true

    private var effective: ExerciseTargetStore.EffectiveTarget {
        ExerciseTargetStore(context: context).effective(for: exercise)
    }

    var body: some View {
        HStack(alignment: .center, spacing: 12) {
            IllustrationThumb(assetName: exercise.id, title: exercise.name)
                .frame(width: 92, height: 68)
            VStack(alignment: .leading, spacing: 6) {
                Text(exercise.name)
                    .font(.body.weight(.semibold))
                    .foregroundStyle(.white)
                HStack(spacing: 6) {
                    Text(targetSummary)
                        .font(.caption.weight(.medium))
                        .foregroundStyle(.white.opacity(0.8))
                    if effective.isOverridden {
                        Text("custom")
                            .font(.caption2.weight(.bold))
                            .padding(.horizontal, 6)
                            .padding(.vertical, 1)
                            .background(Capsule().fill(.white.opacity(0.18)))
                            .foregroundStyle(.white)
                    }
                }
                setsSummary
            }
            Spacer()
            progressBadge
            Image(systemName: "chevron.right")
                .foregroundStyle(.white.opacity(0.5))
                .font(.footnote)
        }
        .padding(hasBackground ? 14 : 0)
        .contentShape(Rectangle())
        .liquidCard(cornerRadius: 20, enabled: hasBackground)
    }

    private var targetSummary: String {
        let target = effective
        let countLabel: String
        if let lo = target.repsLow, let hi = target.repsHigh, lo != hi {
            countLabel = "\(lo)–\(hi)"
        } else if let lo = target.repsLow {
            countLabel = "\(lo)"
        } else {
            return "\(target.sets) sets"
        }
        let unitSuffix: String = switch exercise.unit {
            case .reps: " reps"
            case .seconds: "s"
            case .minutes: " min"
            case .steps: " steps"
            case .rounds: " rounds"
        }
        return "\(target.sets) × \(countLabel)\(unitSuffix)"
    }

    private var completedCount: Int {
        sets.count
    }

    private var progressBadge: some View {
        let target = effective
        let pct = min(1.0, Double(completedCount) / Double(max(1, target.sets * (exercise.bilateral ? 2 : 1))))
        return ZStack {
            Circle()
                .stroke(.white.opacity(0.25), lineWidth: 3)
            Circle()
                .trim(from: 0, to: pct)
                .stroke(.white, style: StrokeStyle(lineWidth: 3, lineCap: .round))
                .rotationEffect(.degrees(-90))
            Text("\(completedCount)")
                .font(.caption2.weight(.bold))
                .foregroundStyle(.white)
        }
        .frame(width: 28, height: 28)
    }

    @ViewBuilder
    private var setsSummary: some View {
        if sets.isEmpty {
            Text("Tap to log sets")
                .font(.caption)
                .foregroundStyle(.white.opacity(0.6))
        } else {
            Text(sets
                .sorted(by: { $0.setNumber < $1.setNumber })
                .map(formatSet)
                .joined(separator: "  ·  "))
                .font(.caption.weight(.medium))
                .foregroundStyle(.white.opacity(0.85))
                .lineLimit(2)
        }
    }

    private func formatSet(_ log: SetLog) -> String {
        var parts: [String] = []
        if let r = log.reps { parts.append("\(r)") }
        if let w = log.weightLbs { parts.append("@ \(unit.format(lbs: w))\(unit.shortSuffix)") }
        if let s = log.durationSeconds { parts.append("\(s)s") }
        if let side = log.side { parts.append(side) }
        return parts.isEmpty ? "✓" : parts.joined(separator: " ")
    }
}

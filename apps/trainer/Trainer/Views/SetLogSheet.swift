import SwiftUI
import SwiftData

/// In-workout logging sheet. Mirrors the ExerciseDetailView layout
/// (illustration → title → Target cards → How to do it) but the LOAD
/// card is editable and the floating "Log set" button records all sets
/// at once with the same reps + weight.
struct SetLogSheet: View {
    let session: WorkoutSession
    let exercise: ExerciseSpec
    let workoutSpec: WorkoutSpec
    /// Called after a successful "Log exercise" tap. The runner uses this
    /// to switch to the next exercise in the list (nil = last exercise →
    /// close the sheet).
    var onLogged: () -> Void = {}

    @Environment(\.modelContext) private var context
    @Environment(\.dismiss) private var dismiss
    @Query private var settingsList: [AppSettings]
    @State private var notes = WorkoutNotesStore.shared

    @State private var sets: Int = 0
    @State private var repsPerSet: Int = 0
    @State private var weightValue: Double = 0          // always stored in user's unit
    @State private var loadInput: String = ""            // "" = not entered yet
    @State private var durationSeconds: Int = 0
    @State private var showRestTimer = false
    @State private var showFullscreen = false
    @State private var initialized = false
    @State private var showLoadError = false
    @FocusState private var focusedField: Field?

    private enum Field: Hashable { case sets, reps, load }

    private var weightUnit: WeightUnit { settingsList.first?.weightUnit ?? .lbs }

    private var effectiveTarget: ExerciseTargetStore.EffectiveTarget {
        ExerciseTargetStore(context: context).effective(for: exercise)
    }

    private var unitSuffix: String {
        switch exercise.unit {
        case .reps: ""
        case .seconds: "s"
        case .minutes: " min"
        case .steps: " steps"
        case .rounds: " rounds"
        }
    }

    private var unitLabel: String {
        switch exercise.unit {
        case .reps: "REPS"
        case .seconds: "SECONDS"
        case .minutes: "MINUTES"
        case .steps: "STEPS"
        case .rounds: "ROUNDS"
        }
    }

    private var minimumLabel: String {
        if let lo = exercise.repsLow { return "\(unitLabel) (MIN \(lo))" }
        return unitLabel
    }

    private var existingSets: [SetLog] {
        session.sets.filter { $0.exerciseSlug == exercise.id }
    }

    /// True when the exercise has no partners OR is the final member of
    /// its group in the catalog order. We only kick the rest timer in
    /// that case — resting between partners in the same superset would
    /// defeat the point of alternating.
    private var isLastInGroup: Bool {
        guard let groupID = exercise.pair else { return true }
        let members = workoutSpec.exercises.filter { $0.pair == groupID }
        return members.last?.id == exercise.id
    }

    private var hasValidWeight: Bool {
        !exercise.weighted || weightValue > 0
    }

    private var logButtonEnabled: Bool {
        sets > 0 && hasValidWeight
    }

    var body: some View {
        NavigationStack {
            ZStack {
                AppBackground()
                ScrollView {
                    VStack(alignment: .leading, spacing: 18) {
                        illustration
                        titleBlock
                        targetBlock
                        howToDoItBlock
                        existingSetsBlock
                        Color.clear.frame(height: 120)
                    }
                    .padding(16)
                }

                VStack {
                    Spacer()
                    logButton
                        .padding(.horizontal, 16)
                        .padding(.bottom, 16)
                }
            }
            .toolbar {
                ToolbarItemGroup(placement: .keyboard) {
                    Spacer()
                    Button {
                        focusedField = nil
                    } label: {
                        Image(systemName: "keyboard.chevron.compact.down")
                    }
                }
            }
            .navigationBarTitleDisplayMode(.inline)
            .onAppear { if !initialized { loadDefaults(); initialized = true } }
            .fullScreenCover(isPresented: $showFullscreen) {
                IllustrationFullscreen(assetName: exercise.id, title: exercise.name)
            }
            .sheet(isPresented: $showRestTimer, onDismiss: { onLogged() }) {
                RestTimerView(duration: workoutSpec.restDefaultSeconds)
                    .presentationDetents([.fraction(0.5)])
            }
        }
    }

    // MARK: - Sections

    private var illustration: some View {
        Button {
            showFullscreen = true
        } label: {
            ZStack(alignment: .topTrailing) {
                ZStack {
                    RoundedRectangle(cornerRadius: 22, style: .continuous)
                        .fill(.white)
                    RemoteIllustration(slug: exercise.id, contentMode: .fit, placeholderPadding: 12)
                }
                .frame(maxWidth: .infinity)
                .frame(minHeight: 180)
                .clipShape(RoundedRectangle(cornerRadius: 22, style: .continuous))
                .shadow(color: .black.opacity(0.25), radius: 10, x: 0, y: 6)

                Label("Expand", systemImage: "arrow.up.left.and.arrow.down.right")
                    .labelStyle(.iconOnly)
                    .font(.footnote.weight(.semibold))
                    .padding(8)
                    .background { Circle().fill(.black.opacity(0.55)) }
                    .foregroundStyle(.white)
                    .padding(12)
            }
        }
        .buttonStyle(.plain)
    }

    private var titleBlock: some View {
        Text(exercise.name)
            .font(.largeTitle.weight(.bold))
            .foregroundStyle(.white)
    }

    private var targetBlock: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Target")
                .font(.headline)
                .foregroundStyle(.white)

            HStack(spacing: 10) {
                editableIntStat(
                    label: "SETS",
                    value: $sets,
                    field: .sets,
                    suffix: ""
                )
                editableIntStat(
                    label: minimumLabel,
                    value: $repsPerSet,
                    field: .reps,
                    suffix: unitSuffix
                )
                loadStat
            }

            if showLoadError && !hasValidWeight {
                HStack(spacing: 6) {
                    Image(systemName: "exclamationmark.circle.fill")
                    Text("Enter the weight you used before logging this exercise.")
                }
                .font(.footnote.weight(.medium))
                .foregroundStyle(.red)
                .transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
    }

    private func editableIntStat(
        label: String,
        value: Binding<Int>,
        field: Field,
        suffix: String
    ) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label)
                .font(.caption2.weight(.bold))
                .foregroundStyle(.white.opacity(0.6))
                .lineLimit(1)
                .minimumScaleFactor(0.7)
            HStack(spacing: 2) {
                TextField("", value: value, format: .number)
                    .keyboardType(.numberPad)
                    .focused($focusedField, equals: field)
                    .font(.title2.weight(.semibold).monospacedDigit())
                    .foregroundStyle(.white)
                    .tint(.white)
                if !suffix.isEmpty {
                    Text(suffix)
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.white.opacity(0.65))
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .liquidCard(cornerRadius: 14)
        .contentShape(Rectangle())
        .onTapGesture { focusedField = field }
    }

    /// Editable LOAD card. Accepts decimal input (e.g. 37.5).
    /// Shows "MAX" as a placeholder when empty — but the user can't log
    /// until they enter a real number. When the user taps "Log exercise"
    /// with no weight, the card frames itself in red until they fill it.
    private var loadStat: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("LOAD")
                .font(.caption2.weight(.bold))
                .foregroundStyle(.white.opacity(0.6))
            if exercise.weighted {
                HStack(spacing: 2) {
                    TextField("MAX", text: $loadInput)
                        .keyboardType(.decimalPad)
                        .focused($focusedField, equals: .load)
                        .font(.title2.weight(.semibold).monospacedDigit())
                        .foregroundStyle(.white)
                        .tint(.white)
                        .onChange(of: loadInput) { _, new in
                            weightValue = Double(new.replacingOccurrences(of: ",", with: ".")) ?? 0
                            if hasValidWeight {
                                withAnimation(.easeOut(duration: 0.2)) {
                                    showLoadError = false
                                }
                            }
                        }
                    Text(weightUnit.shortSuffix)
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.white.opacity(0.65))
                }
            } else {
                Text("—")
                    .font(.title2.weight(.semibold).monospacedDigit())
                    .foregroundStyle(.white.opacity(0.4))
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .liquidCard(cornerRadius: 14)
        .overlay {
            if showLoadError && !hasValidWeight {
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .stroke(Color.red, lineWidth: 1.5)
            }
        }
        .contentShape(Rectangle())
        .onTapGesture { if exercise.weighted { focusedField = .load } }
    }

    @ViewBuilder
    private var howToDoItBlock: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("How to do it")
                .font(.headline)
                .foregroundStyle(.white)
            Text(exercise.description)
                .font(.body)
                .foregroundStyle(.white.opacity(0.9))
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .liquidCard()
    }

    @ViewBuilder
    private var existingSetsBlock: some View {
        if !existingSets.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                Text("Logged")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(.white.opacity(0.6))
                ForEach(existingSets.sorted(by: { $0.completedAt < $1.completedAt })) { s in
                    HStack {
                        Image(systemName: "checkmark.circle.fill")
                            .foregroundStyle(.green.opacity(0.8))
                        Text(formatLog(s))
                            .foregroundStyle(.white)
                            .monospacedDigit()
                        Spacer()
                        Button {
                            deleteSet(s)
                        } label: {
                            Image(systemName: "trash")
                                .foregroundStyle(.white.opacity(0.5))
                        }
                        .buttonStyle(.plain)
                    }
                    .font(.callout)
                    .padding(.vertical, 2)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(14)
            .liquidCard()
        }
    }

    private var logButton: some View {
        Button {
            if !logButtonEnabled {
                // Surface a red error + frame around the LOAD card until
                // the user fills it in. Also focus the card so typing starts.
                withAnimation(.easeOut(duration: 0.2)) {
                    showLoadError = true
                }
                if exercise.weighted { focusedField = .load }
                UINotificationFeedbackGenerator().notificationOccurred(.warning)
                return
            }
            logAllSets()
        } label: {
            HStack {
                Image(systemName: "plus.circle.fill")
                Text(logButtonLabel)
                    .font(.body.weight(.semibold))
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 16)
            .liquidButton(tint: Palette.log)
            .opacity(logButtonEnabled ? 1 : 0.45)
        }
        .buttonStyle(.plain)
    }

    /// Always "Log exercise". The button is disabled when the user hasn't
    /// entered a weight yet (for weighted exercises) — we don't change
    /// the label because that was confusing.
    private var logButtonLabel: String { "Log exercise" }

    // MARK: - State + actions

    private func loadDefaults() {
        let eff = effectiveTarget
        sets = eff.sets
        // Default reps to the user's chosen target (high) or the catalog low.
        switch exercise.unit {
        case .reps, .rounds, .steps:
            repsPerSet = eff.repsHigh ?? eff.repsLow ?? exercise.repsLow ?? 1
        case .seconds:
            let secs = eff.repsHigh ?? eff.repsLow ?? exercise.repsLow ?? 30
            repsPerSet = secs
        case .minutes:
            let mins = eff.repsHigh ?? eff.repsLow ?? exercise.repsLow ?? 1
            repsPerSet = mins
        }
        // Prefill weight from the last session if we have one.
        let lookup = LastSessionLookup(context: context)
        if exercise.weighted,
           let prefill = lookup.prefill(for: exercise.id, side: exercise.bilateral ? "L" : nil),
           let w = prefill.weightLbs {
            let inUnit = weightUnit.fromLbs(w)
            weightValue = inUnit
            // display without trailing .0 when whole
            loadInput = inUnit.truncatingRemainder(dividingBy: 1) == 0
                ? String(Int(inUnit))
                : String(format: "%g", inUnit)
        } else {
            loadInput = ""          // shows "MAX" placeholder
            weightValue = 0
        }
    }

    private func logAllSets() {
        guard logButtonEnabled else { return }
        let weightLbs: Double? = exercise.weighted ? weightUnit.toLbs(weightValue) : nil
        let reps: Int?
        let duration: Int?
        switch exercise.unit {
        case .reps, .rounds, .steps:
            reps = repsPerSet; duration = nil
        case .seconds:
            reps = nil; duration = repsPerSet
        case .minutes:
            reps = nil; duration = repsPerSet * 60
        }

        // For bilateral, log N sets per side (left then right).
        let sides: [String?] = exercise.bilateral ? ["L", "R"] : [nil]
        let startingSetNumber = (existingSets.map(\.setNumber).max() ?? 0) + 1
        var nextSetNumber = startingSetNumber
        let now = Date.now
        for side in sides {
            for _ in 0..<sets {
                let log = SetLog(
                    exerciseSlug: exercise.id,
                    setNumber: nextSetNumber,
                    reps: reps,
                    weightLbs: weightLbs,
                    durationSeconds: duration,
                    side: side,
                    completedAt: now
                )
                log.session = session
                session.sets.append(log)
                context.insert(log)
                nextSetNumber += 1
            }
        }
        try? context.save()

        UIImpactFeedbackGenerator(style: .medium).impactOccurred()

        // Only rest between groups, not between partners inside a
        // superset. Timer also gated on the user's global toggle.
        let shouldRest = isLastInGroup
            && workoutSpec.restDefaultSeconds > 0
            && !workoutSpec.id.isRest
            && ((try? context.fetch(FetchDescriptor<AppSettings>()).first)?.restTimerEnabled ?? true)
        if shouldRest {
            showRestTimer = true
        } else {
            onLogged()
        }
    }

    private func deleteSet(_ log: SetLog) {
        session.sets.removeAll { $0.id == log.id }
        context.delete(log)
        try? context.save()
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
    }

    private func formatLog(_ s: SetLog) -> String {
        var parts: [String] = []
        if let r = s.reps { parts.append("\(r)") }
        if let w = s.weightLbs {
            parts.append("× \(weightUnit.format(lbs: w))\(weightUnit.shortSuffix)")
        }
        if let d = s.durationSeconds {
            if exercise.unit == .minutes { parts.append("\(d / 60)min") } else { parts.append("\(d)s") }
        }
        if let side = s.side { parts.append("(\(side))") }
        return parts.joined(separator: " ")
    }
}

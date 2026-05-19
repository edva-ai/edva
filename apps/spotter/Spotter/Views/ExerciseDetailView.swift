import SwiftUI
import SwiftData

struct ExerciseDetailView: View {
    let spec: ExerciseSpec
    let workoutSpec: WorkoutSpec

    @Environment(\.modelContext) private var context
    @Query private var settingsList: [AppSettings]
    @State private var showFullscreen = false
    @State private var sets: Int = 0
    @State private var repsTarget: Int = 0
    @State private var initialized = false
    @FocusState private var focusedField: TargetField?

    private enum TargetField: Hashable { case sets, reps }

    private var weightUnit: WeightUnit { settingsList.first?.weightUnit ?? .lbs }

    private var effectiveTarget: ExerciseTargetStore.EffectiveTarget {
        ExerciseTargetStore(context: context).effective(for: spec)
    }

    private var unitSuffix: String {
        switch spec.unit {
        case .reps: ""
        case .seconds: "s"
        case .minutes: " min"
        case .steps: " steps"
        case .rounds: " rounds"
        }
    }

    private var unitLabel: String {
        switch spec.unit {
        case .reps: "REPS"
        case .seconds: "SECONDS"
        case .minutes: "MINUTES"
        case .steps: "STEPS"
        case .rounds: "ROUNDS"
        }
    }

    /// Catalog's minimum — shown in the label as "REPS (MIN 6)" to remind
    /// the user what the floor is, regardless of what they've currently
    /// set as their personal target.
    private var minimumLabel: String {
        if let lo = spec.repsLow { return "\(unitLabel) (MIN \(lo))" }
        return unitLabel
    }

    /// Most-recent weight logged for this exercise, formatted in the user's
    /// preferred unit. Returns nil if they've never logged a weight here —
    /// the Load card shows "MAX" in that case, meaning "go by feel — to max".
    private var lastLoadText: String? {
        guard spec.weighted else { return nil }
        let slug = spec.id
        var d = FetchDescriptor<SetLog>(
            predicate: #Predicate<SetLog> { $0.exerciseSlug == slug && $0.weightLbs != nil },
            sortBy: [SortDescriptor(\.completedAt, order: .reverse)]
        )
        d.fetchLimit = 1
        guard let latest = try? context.fetch(d).first,
              let lbs = latest.weightLbs else { return nil }
        return "\(weightUnit.format(lbs: lbs))\(weightUnit.shortSuffix)"
    }

    var body: some View {
        ZStack {
            AppBackground()
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    illustration
                    titleBlock
                    targetBlock
                    descriptionBlock
                    Color.clear.frame(height: 40)
                }
                .padding(16)
            }
        }
        .navigationTitle(spec.name)
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(.hidden, for: .navigationBar)
        .fullScreenCover(isPresented: $showFullscreen) {
            IllustrationFullscreen(assetName: spec.id, title: spec.name)
        }
        .onAppear {
            if !initialized { loadFromEffective(); initialized = true }
        }
    }

    private var illustration: some View {
        Button {
            showFullscreen = true
        } label: {
            ZStack(alignment: .topTrailing) {
                ZStack {
                    RoundedRectangle(cornerRadius: 22, style: .continuous)
                        .fill(.white)
                    RemoteIllustration(slug: spec.id, contentMode: .fit, placeholderPadding: 12)
                }
                .frame(maxWidth: .infinity)
                .frame(minHeight: 180)
                .clipShape(RoundedRectangle(cornerRadius: 22, style: .continuous))
                .shadow(color: .black.opacity(0.25), radius: 10, x: 0, y: 6)

                Label("Expand", systemImage: "arrow.up.left.and.arrow.down.right")
                    .labelStyle(.iconOnly)
                    .font(.footnote.weight(.semibold))
                    .padding(8)
                    .background {
                        Circle().fill(.black.opacity(0.55))
                    }
                    .foregroundStyle(.white)
                    .padding(12)
            }
        }
        .buttonStyle(.plain)
    }

    private var titleBlock: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(spec.name)
                .font(.largeTitle.weight(.bold))
                .foregroundStyle(.white)
        }
    }

    private var targetBlock: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("Target")
                    .font(.headline)
                    .foregroundStyle(.white)
                if effectiveTarget.isOverridden {
                    Text("CUSTOM")
                        .font(.caption2.weight(.bold))
                        .padding(.horizontal, 8)
                        .padding(.vertical, 2)
                        .background(Capsule().fill(.white.opacity(0.18)))
                        .foregroundStyle(.white)
                    Spacer()
                    Button {
                        resetToDefault()
                    } label: {
                        Label("Reset", systemImage: "arrow.uturn.backward")
                            .font(.caption.weight(.semibold))
                            .padding(.horizontal, 12)
                            .padding(.vertical, 6)
                            .background(Capsule().fill(.white.opacity(0.12)))
                            .foregroundStyle(.white.opacity(0.85))
                    }
                    .buttonStyle(.plain)
                } else {
                    Spacer()
                }
            }

            HStack(spacing: 10) {
                editableStat(
                    label: "SETS",
                    value: $sets,
                    field: .sets,
                    suffix: ""
                )
                editableStat(
                    label: minimumLabel,
                    value: $repsTarget,
                    field: .reps,
                    suffix: unitSuffix
                )
                loadStat
            }
        }
        .toolbar {
            ToolbarItemGroup(placement: .keyboard) {
                Spacer()
                Button("Done") { focusedField = nil }
            }
        }
    }

    private func editableStat(
        label: String,
        value: Binding<Int>,
        field: TargetField,
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
        .onChange(of: value.wrappedValue) { _, _ in persist() }
    }

    /// Load card. Display-only — seeds from the user's most recent weight
    /// for this exercise. Shows "MAX" as a stand-in when they haven't
    /// logged a weight yet.
    private var loadStat: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("LOAD")
                .font(.caption2.weight(.bold))
                .foregroundStyle(.white.opacity(0.6))
            Text(lastLoadText ?? "MAX")
                .font(.title2.weight(.semibold).monospacedDigit())
                .foregroundStyle(spec.weighted ? .white : .white.opacity(0.5))
                .lineLimit(1)
                .minimumScaleFactor(0.6)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .liquidCard(cornerRadius: 14)
    }

    private func loadFromEffective() {
        let eff = effectiveTarget
        sets = eff.sets
        // Prefer the effective high (what the user aims for) when present,
        // otherwise fall back to the catalog's minimum.
        repsTarget = eff.repsHigh ?? eff.repsLow ?? spec.repsHigh ?? spec.repsLow ?? 1
    }

    private func persist() {
        let eff = effectiveTarget
        let defaultSets = spec.sets
        let defaultTarget = spec.repsHigh ?? spec.repsLow ?? repsTarget
        let isSameAsDefault = sets == defaultSets && repsTarget == defaultTarget
        if isSameAsDefault {
            if eff.isOverridden {
                ExerciseTargetStore(context: context).reset(slug: spec.id)
            }
        } else {
            ExerciseTargetStore(context: context).save(
                slug: spec.id,
                sets: sets,
                repsLow: spec.repsLow,       // keep catalog floor
                repsHigh: repsTarget         // user-set target
            )
        }
    }

    private func resetToDefault() {
        ExerciseTargetStore(context: context).reset(slug: spec.id)
        loadFromEffective()
    }

    private var descriptionBlock: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("How to do it")
                .font(.headline)
                .foregroundStyle(.white)
            Text(spec.description)
                .font(.body)
                .foregroundStyle(.white.opacity(0.9))
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .liquidCard()
    }

}

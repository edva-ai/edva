import SwiftUI
import SwiftData

struct TodayView: View {
    @Environment(\.modelContext) private var context
    @Query private var settingsList: [AppSettings]

    @State private var showSwapSheet = false
    @State private var showGymToggleConfirm = false
    @State private var showCancelConfirm = false
    @State private var activeSession: WorkoutSession?
    @State private var notes = WorkoutNotesStore.shared

    private var settings: AppSettings? { settingsList.first }

    private var today: Date { Calendar.current.startOfDay(for: .now) }

    private var gymAvailableToday: Bool {
        guard let s = settings else { return true }
        return PlanScheduler(context: context)
            .effectiveGymAvailable(for: today, defaultAvailable: s.gymAvailableDefault)
    }

    private var plannedType: WorkoutType {
        PlanScheduler(context: context).plannedWorkout(for: today, gymAvailable: gymAvailableToday)
    }

    var body: some View {
        NavigationStack {
            ZStack {
                AppBackground()
                ScrollView {
                    VStack(alignment: .leading, spacing: 20) {
                        header
                        planCard
                        howToDoItCard
                        warmupCard
                        exercisesList
                        Color.clear.frame(height: 40)
                    }
                    .padding(.horizontal, 16)
                    .padding(.top, 24)
                }
                .scrollIndicators(.hidden)
            }
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        Button("Swap today's workout", systemImage: "arrow.triangle.2.circlepath") {
                            showSwapSheet = true
                        }
                        Toggle("Gym available today", isOn: Binding(
                            get: { gymAvailableToday },
                            set: { setGymAvailable($0) }
                        ))
                    } label: {
                        Image(systemName: "ellipsis.circle")
                    }
                    .tint(.white)
                }
            }
            .sheet(isPresented: $showSwapSheet) {
                WorkoutSwapSheet(date: today, currentType: plannedType)
            }
            .fullScreenCover(item: $activeSession) { session in
                WorkoutRunnerView(session: session)
            }
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(today.formatted(.dateTime.weekday(.wide)))
                .font(.title2.weight(.semibold))
                .foregroundStyle(.white)
            Text(today.formatted(.dateTime.month(.wide).day().year()))
                .font(.subheadline)
                .foregroundStyle(.white.opacity(0.65))
        }
        .padding(.horizontal, 4)
        .padding(.top, 8)
    }

    private var planCard: some View {
        let spec = WorkoutCatalog.spec(for: plannedType)
        return VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(spec.title)
                        .font(.largeTitle.weight(.bold))
                        .foregroundStyle(.white)
                    Text(spec.subtitle)
                        .font(.subheadline)
                        .foregroundStyle(.white.opacity(0.75))
                }
                Spacer()
                workoutBadge(for: plannedType)
            }

            if !plannedType.isRest {
                HStack(spacing: 12) {
                    Label("\(spec.exercises.count) exercises", systemImage: "list.bullet")
                    Label(estimatedDuration(for: spec), systemImage: "clock")
                    Label(gymAvailableToday ? "Gym" : "No gym", systemImage: gymAvailableToday ? "dumbbell.fill" : "house.fill")
                }
                .font(.footnote.weight(.medium))
                .foregroundStyle(.white.opacity(0.9))
            }

            if isWorkoutComplete {
                ctaRow(icon: "checkmark.seal.fill", label: "Workout Complete", showChevron: false)
                    .liquidButton(cornerRadius: 18, tint: Palette.complete)

                Button(action: startOrResumeSession) {
                    Label(startLabel, systemImage: startIcon)
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(.white.opacity(0.9))
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 8)
                }
                .buttonStyle(.plain)
            } else {
                Button(action: startOrResumeSession) {
                    ctaRow(icon: startIcon, label: startLabel)
                        .liquidButton(cornerRadius: 18, tint: Palette.start)
                }
                .buttonStyle(.plain)

                if plannedType != .minimumEffective && todaySession == nil {
                    Button(action: swapToMinimumEffective) {
                        Label("Do Minimum Effective instead", systemImage: "bolt.fill")
                            .font(.footnote.weight(.semibold))
                            .foregroundStyle(.white.opacity(0.9))
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 8)
                    }
                    .buttonStyle(.plain)
                }

                if todaySession != nil {
                    Button(role: .destructive) {
                        showCancelConfirm = true
                    } label: {
                        Label("Cancel workout", systemImage: "xmark.circle")
                            .font(.footnote.weight(.semibold))
                            .foregroundStyle(.red.opacity(0.9))
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 8)
                    }
                    .buttonStyle(.plain)
                }
            }
        }
        .padding(20)
        .liquidCard(cornerRadius: 26)
        .confirmationDialog("Cancel today's workout?", isPresented: $showCancelConfirm, titleVisibility: .visible) {
            Button("Discard workout", role: .destructive) { cancelSession() }
            Button("Keep it", role: .cancel) {}
        } message: {
            Text("Deletes today's session and every set you've logged for it.")
        }
    }

    private func cancelSession() {
        SessionManager(context: context).cancelTodaySession()
        activeSession = nil
    }

    /// Sets today's DayOverride to .minimumEffective, swapping whatever
    /// was planned (rest, strength, etc.) for the quick circuit.
    private func swapToMinimumEffective() {
        let key = DayOverride.dateKey(from: today)
        let descriptor = FetchDescriptor<DayOverride>(predicate: #Predicate { $0.dateKey == key })
        if let existing = try? context.fetch(descriptor).first {
            existing.workoutType = .minimumEffective
        } else {
            context.insert(DayOverride(
                date: today,
                workoutType: .minimumEffective,
                gymAvailable: gymAvailableToday
            ))
        }
        try? context.save()
    }

    @ViewBuilder
    private var warmupCard: some View {
        let bullets = notes.notes(for: plannedType).warmup
        if !bullets.isEmpty {
            VStack(alignment: .leading, spacing: 10) {
                Label("Warm-up", systemImage: "flame")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.white.opacity(0.9))
                ForEach(Array(bullets.enumerated()), id: \.offset) { _, line in
                    HStack(alignment: .top, spacing: 8) {
                        Image(systemName: "checkmark.circle.fill")
                            .foregroundStyle(.white.opacity(0.7))
                            .font(.footnote)
                            .padding(.top, 3)
                        Text(line)
                            .font(.callout)
                            .foregroundStyle(.white.opacity(0.85))
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(16)
            .liquidCard()
        }
    }

    @ViewBuilder
    private var exercisesList: some View {
        let spec = WorkoutCatalog.spec(for: plannedType)
        if !spec.exercises.isEmpty {
            VStack(alignment: .leading, spacing: 12) {
                Text("Exercises")
                    .font(.headline)
                    .foregroundStyle(.white)
                    .padding(.leading, 4)
                ForEach(spec.exerciseGroups) { group in
                    if let gid = group.groupID, group.exercises.count >= 2 {
                        GroupFrame(groupNumber: gid) {
                            ForEach(Array(group.exercises.enumerated()), id: \.element.id) { idx, ex in
                                if idx > 0 { GroupFrameDivider() }
                                NavigationLink {
                                    ExerciseDetailView(spec: ex, workoutSpec: spec)
                                } label: {
                                    ExerciseRow(spec: ex, hasBackground: false)
                                }
                                .buttonStyle(.plain)
                            }
                        }
                    } else if let ex = group.exercises.first {
                        NavigationLink {
                            ExerciseDetailView(spec: ex, workoutSpec: spec)
                        } label: {
                            ExerciseRow(spec: ex)
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
        }
    }

    @ViewBuilder
    private var howToDoItCard: some View {
        let bullets = notes.notes(for: plannedType).howToDoIt
        if !bullets.isEmpty {
            VStack(alignment: .leading, spacing: 10) {
                Label("How to do it", systemImage: "info.circle")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.white.opacity(0.9))
                ForEach(Array(bullets.enumerated()), id: \.offset) { _, tip in
                    HStack(alignment: .top, spacing: 8) {
                        Image(systemName: "checkmark.circle.fill")
                            .foregroundStyle(.white.opacity(0.7))
                            .font(.footnote)
                            .padding(.top, 3)
                        Text(tip)
                            .font(.callout)
                            .foregroundStyle(.white.opacity(0.85))
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(16)
            .liquidCard()
        }
    }

    // MARK: session label helpers

    private var startLabel: String {
        if plannedType.isRest {
            return todaySession == nil ? "Log a rest day" : "View rest day"
        }
        guard let session = todaySession else { return "Start workout" }
        return session.finishedAt == nil ? "Resume workout" : "Add to today's workout"
    }

    private var startIcon: String {
        if plannedType.isRest { return "leaf.fill" }
        return todaySession == nil ? "play.fill" : "arrow.uturn.forward.circle.fill"
    }

    // MARK: helpers

    private func workoutBadge(for type: WorkoutType) -> some View {
        let (icon, tint) = badgeTheme(for: type)
        return Image(systemName: icon)
            .font(.title2.weight(.semibold))
            .foregroundStyle(.white)
            .padding(10)
            .background {
                Circle().fill(tint.gradient)
            }
    }

    private func badgeTheme(for type: WorkoutType) -> (String, Color) {
        switch type {
        case .strengthA, .strengthB: ("dumbbell.fill", .orange)
        case .bodyweightA, .bodyweightB: ("figure.strengthtraining.functional", .purple)
        case .minimumEffective: ("bolt.fill", .yellow)
        case .cardioSteady: ("figure.walk.treadmill", .green)
        case .cardioIntervals: ("waveform.path.ecg", .pink)
        case .rest: ("leaf.fill", .mint)
        }
    }

    private func estimatedDuration(for spec: WorkoutSpec) -> String {
        switch spec.id {
        case .cardioSteady: "25–35 min"
        case .cardioIntervals: "~28 min"
        case .minimumEffective: "10–20 min"
        case .rest: "—"
        default: "30–45 min"
        }
    }

    /// Returns the today button label & icon, reflecting the state of today's one session.
    private var todaySession: WorkoutSession? {
        SessionManager(context: context).session(for: today)
    }

    /// `true` once today's workout has been finished (auto-finish or manual).
    /// Drives the green "Workout Complete" badge + the white
    /// "Add to today's workout" secondary CTA.
    private var isWorkoutComplete: Bool {
        todaySession?.finishedAt != nil
    }

    /// Shared layout for the three plan-card CTA rows. Interactive rows
    /// trail a chevron; the static "Workout Complete" badge suppresses it.
    private func ctaRow(icon: String, label: String, showChevron: Bool = true) -> some View {
        HStack {
            if !showChevron { Spacer() }
            Image(systemName: icon)
            Text(label).font(.body.weight(.semibold))
            Spacer()
            if showChevron { Image(systemName: "chevron.right") }
        }
        .padding(.horizontal, 18)
        .padding(.vertical, 16)
    }

    private func startOrResumeSession() {
        let manager = SessionManager(context: context)
        let session = manager.startOrResumeToday(
            workoutType: plannedType,
            gymUsed: gymAvailableToday
        )
        try? context.save()
        NotificationScheduler.shared.refreshTodayReminder(context: context)
        activeSession = session
    }

    private func setGymAvailable(_ value: Bool) {
        let key = DayOverride.dateKey(from: today)
        let descriptor = FetchDescriptor<DayOverride>(predicate: #Predicate { $0.dateKey == key })
        if let existing = try? context.fetch(descriptor).first {
            existing.gymAvailable = value
        } else {
            // Only the gym flag is pinned — leave workoutType nil so the weekly default still applies.
            context.insert(DayOverride(date: today, workoutType: nil, gymAvailable: value))
        }
        try? context.save()
    }
}

// MARK: - Exercise row

struct ExerciseRow: View {
    let spec: ExerciseSpec
    var hasBackground: Bool = true

    var body: some View {
        HStack(spacing: 12) {
            IllustrationThumb(assetName: spec.id, title: spec.name)
                .frame(width: 80, height: 56)
            VStack(alignment: .leading, spacing: 2) {
                Text(spec.name)
                    .font(.body.weight(.semibold))
                    .foregroundStyle(.white)
                Text(spec.targetLabel)
                    .font(.caption.weight(.medium))
                    .foregroundStyle(.white.opacity(0.8))
            }
            Spacer()
            Image(systemName: "chevron.right")
                .font(.footnote)
                .foregroundStyle(.white.opacity(0.5))
        }
        .padding(hasBackground ? 12 : 0)
        .contentShape(Rectangle())
        .liquidCard(cornerRadius: 18, enabled: hasBackground)
    }
}

struct IllustrationThumb: View {
    let assetName: String
    let title: String
    @State private var showFullscreen = false

    init(assetName: String, title: String) {
        self.assetName = assetName
        self.title = title
    }

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .fill(.white.opacity(0.92))
            RemoteIllustration(slug: assetName, contentMode: .fit, placeholderPadding: 4)
        }
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        .contentShape(RoundedRectangle(cornerRadius: 12))
        .onTapGesture { showFullscreen = true }
        .fullScreenCover(isPresented: $showFullscreen) {
            IllustrationFullscreen(assetName: assetName, title: title)
        }
    }
}

import SwiftUI
import SwiftData

struct WeekView: View {
    @Environment(\.modelContext) private var context
    @Query(sort: \WeeklyPlanDay.dayOfWeek) private var planDays: [WeeklyPlanDay]
    @Query private var settingsList: [AppSettings]

    private var settings: AppSettings? { settingsList.first }

    var body: some View {
        NavigationStack {
            ZStack {
                AppBackground()
                ScrollView {
                    VStack(alignment: .leading, spacing: 18) {
                        if let settings {
                            Toggle(isOn: Binding(
                                get: { settings.gymAvailableDefault },
                                set: { settings.gymAvailableDefault = $0; try? context.save() }
                            )) {
                                HStack(spacing: 10) {
                                    Image(systemName: settings.gymAvailableDefault ? "dumbbell.fill" : "house.fill")
                                        .foregroundStyle(.white)
                                    Text("Gym available by default")
                                        .foregroundStyle(.white)
                                        .font(.body.weight(.medium))
                                }
                            }
                            .tint(Color(.systemGreen))
                            .padding(14)
                            .liquidCard()
                        }

                        VStack(spacing: 12) {
                            ForEach(orderedWeek, id: \.dayOfWeek) { day in
                                WeekDayRow(day: day)
                            }
                        }
                    }
                    .padding(16)
                }
            }
            .navigationTitle("Weekly Plan")
            .toolbarColorScheme(.dark, for: .navigationBar)
        }
    }

    /// Orders Mon → Sun
    private var orderedWeek: [WeeklyPlanDay] {
        let order = [2, 3, 4, 5, 6, 7, 1]
        return order.compactMap { d in planDays.first(where: { $0.dayOfWeek == d }) }
    }
}

struct WeekDayRow: View {
    @Environment(\.modelContext) private var context
    let day: WeeklyPlanDay

    private var defaultPair: (gym: WorkoutType, noGym: WorkoutType) {
        PlanScheduler.defaultPairForDayOfWeek(day.dayOfWeek)
    }
    private var isAtDefault: Bool {
        day.gymWorkout == defaultPair.gym && day.noGymWorkout == defaultPair.noGym
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text(Calendar.weekdayName(day.dayOfWeek))
                    .font(.headline)
                    .foregroundStyle(.white)
                Spacer()
                if !isAtDefault {
                    Button {
                        day.gymWorkout = defaultPair.gym
                        day.noGymWorkout = defaultPair.noGym
                        try? context.save()
                    } label: {
                        Label("Reset", systemImage: "arrow.counterclockwise")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(.white.opacity(0.85))
                            .padding(.horizontal, 10)
                            .padding(.vertical, 4)
                            .background(Capsule().fill(.white.opacity(0.12)))
                    }
                    .buttonStyle(.plain)
                }
            }

            pickerRow(title: "Gym", systemImage: "dumbbell.fill", binding: Binding(
                get: { day.gymWorkout },
                set: { day.gymWorkout = $0; try? context.save() }
            ))
            pickerRow(title: "No gym", systemImage: "house.fill", binding: Binding(
                get: { day.noGymWorkout },
                set: { day.noGymWorkout = $0; try? context.save() }
            ))
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .liquidCard()
    }

    private func pickerRow(title: String, systemImage: String, binding: Binding<WorkoutType>) -> some View {
        HStack {
            Label(title, systemImage: systemImage)
                .font(.subheadline.weight(.medium))
                .foregroundStyle(.white.opacity(0.9))
            Spacer()
            Menu {
                ForEach(WorkoutType.allCases) { t in
                    Button {
                        binding.wrappedValue = t
                    } label: {
                        HStack {
                            Text(WorkoutCatalog.spec(for: t).title)
                            if binding.wrappedValue == t {
                                Image(systemName: "checkmark")
                            }
                        }
                    }
                }
            } label: {
                HStack(spacing: 6) {
                    Text(WorkoutCatalog.spec(for: binding.wrappedValue).title)
                        .foregroundStyle(.white)
                    Image(systemName: "chevron.up.chevron.down")
                        .foregroundStyle(.white.opacity(0.7))
                        .font(.caption)
                }
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
                .background {
                    Capsule().fill(.white.opacity(0.12))
                }
            }
        }
    }
}

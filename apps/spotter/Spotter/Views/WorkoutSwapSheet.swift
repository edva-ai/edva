import SwiftUI
import SwiftData

struct WorkoutSwapSheet: View {
    let date: Date
    let currentType: WorkoutType

    @Environment(\.modelContext) private var context
    @Environment(\.dismiss) private var dismiss

    @State private var selected: WorkoutType

    init(date: Date, currentType: WorkoutType) {
        self.date = date
        self.currentType = currentType
        _selected = State(initialValue: currentType)
    }

    var body: some View {
        NavigationStack {
            ZStack {
                AppBackground()
                ScrollView {
                    VStack(spacing: 10) {
                        ForEach(WorkoutType.allCases) { type in
                            let spec = WorkoutCatalog.spec(for: type)
                            Button {
                                selected = type
                            } label: {
                                HStack {
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(spec.title)
                                            .font(.body.weight(.semibold))
                                            .foregroundStyle(.white)
                                        Text(spec.subtitle)
                                            .font(.caption)
                                            .foregroundStyle(.white.opacity(0.7))
                                    }
                                    Spacer()
                                    if selected == type {
                                        Image(systemName: "checkmark.circle.fill")
                                            .foregroundStyle(.white)
                                            .font(.title3)
                                    } else {
                                        Image(systemName: "circle")
                                            .foregroundStyle(.white.opacity(0.3))
                                            .font(.title3)
                                    }
                                }
                                .padding(14)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .liquidCard()
                            }
                            .buttonStyle(.plain)
                        }
                    }
                    .padding(16)
                }
            }
            .navigationTitle("Swap today's workout")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Save") {
                        save(); dismiss()
                    }
                    .foregroundStyle(.white)
                    .fontWeight(.semibold)
                }
                ToolbarItem(placement: .topBarLeading) {
                    Button("Cancel") { dismiss() }
                        .foregroundStyle(.white.opacity(0.8))
                }
            }
        }
    }

    private func save() {
        let key = DayOverride.dateKey(from: date)
        let descriptor = FetchDescriptor<DayOverride>(predicate: #Predicate { $0.dateKey == key })
        let existing = try? context.fetch(descriptor).first
        let gymAvail = existing?.gymAvailable ?? true
        if let existing {
            existing.workoutType = selected
        } else {
            context.insert(DayOverride(date: date, workoutType: selected, gymAvailable: gymAvail))
        }
        try? context.save()
    }
}

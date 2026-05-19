import Foundation
import SwiftData

/// Finds the most recent logged set for a given exercise slug, so we can
/// pre-fill reps/weight when the user starts a new set.
@MainActor
struct LastSessionLookup {
    let context: ModelContext

    struct Prefill {
        let reps: Int?
        let weightLbs: Double?
        let durationSeconds: Int?
    }

    func prefill(for exerciseSlug: String, side: String? = nil) -> Prefill? {
        var descriptor = FetchDescriptor<SetLog>(
            predicate: #Predicate { $0.exerciseSlug == exerciseSlug },
            sortBy: [SortDescriptor(\.completedAt, order: .reverse)]
        )
        descriptor.fetchLimit = 20

        guard let logs = try? context.fetch(descriptor) else { return nil }

        let match = logs.first(where: { ($0.side ?? "") == (side ?? "") }) ?? logs.first
        guard let last = match else { return nil }
        return Prefill(
            reps: last.reps,
            weightLbs: last.weightLbs,
            durationSeconds: last.durationSeconds
        )
    }
}

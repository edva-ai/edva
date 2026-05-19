import Foundation
import SwiftData

/// Resolves effective target (catalog default + user override).
@MainActor
struct ExerciseTargetStore {
    let context: ModelContext

    struct EffectiveTarget {
        let sets: Int
        let repsLow: Int?
        let repsHigh: Int?
        let isOverridden: Bool

        var targetLabel: String? {
            guard let lo = repsLow else { return "\(sets) sets" }
            if let hi = repsHigh, hi != lo { return "\(sets) × \(lo)–\(hi)" }
            return "\(sets) × \(lo)"
        }
    }

    func effective(for spec: ExerciseSpec) -> EffectiveTarget {
        if let override = fetch(exerciseSlug: spec.id) {
            return EffectiveTarget(
                sets: override.targetSets,
                repsLow: override.targetRepsLow ?? spec.repsLow,
                repsHigh: override.targetRepsHigh ?? spec.repsHigh,
                isOverridden: true
            )
        }
        return EffectiveTarget(
            sets: spec.sets,
            repsLow: spec.repsLow,
            repsHigh: spec.repsHigh,
            isOverridden: false
        )
    }

    func fetch(exerciseSlug: String) -> ExerciseTarget? {
        let d = FetchDescriptor<ExerciseTarget>(
            predicate: #Predicate { $0.exerciseSlug == exerciseSlug }
        )
        return try? context.fetch(d).first
    }

    func save(slug: String, sets: Int, repsLow: Int?, repsHigh: Int?) {
        if let existing = fetch(exerciseSlug: slug) {
            existing.targetSets = sets
            existing.targetRepsLow = repsLow
            existing.targetRepsHigh = repsHigh
            existing.updatedAt = .now
        } else {
            context.insert(ExerciseTarget(
                exerciseSlug: slug,
                targetSets: sets,
                targetRepsLow: repsLow,
                targetRepsHigh: repsHigh
            ))
        }
        try? context.save()
    }

    func reset(slug: String) {
        if let existing = fetch(exerciseSlug: slug) {
            context.delete(existing)
            try? context.save()
        }
    }
}

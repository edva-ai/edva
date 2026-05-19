import Foundation
import HealthKit

@MainActor
final class HealthKitService {
    private let store = HKHealthStore()

    var isAvailable: Bool { HKHealthStore.isHealthDataAvailable() }

    func requestAuthorization() async throws {
        guard isAvailable else { return }
        let read: Set<HKObjectType> = [
            HKObjectType.workoutType(),
            HKQuantityType.quantityType(forIdentifier: .heartRate)!,
            HKQuantityType.quantityType(forIdentifier: .activeEnergyBurned)!,
            HKQuantityType.quantityType(forIdentifier: .distanceWalkingRunning)!
        ]
        let write: Set<HKSampleType> = [HKObjectType.workoutType()]
        try await store.requestAuthorization(toShare: write, read: read)
    }

    struct WorkoutSummary: Identifiable, Sendable {
        let id: UUID
        let start: Date
        let end: Date
        let duration: TimeInterval
        let activityTypeRawValue: UInt
        let totalEnergyKcal: Double?
        let totalDistanceMeters: Double?
        let averageHeartRate: Double?

        var activityName: String {
            switch HKWorkoutActivityType(rawValue: activityTypeRawValue) {
            case .walking: "Walk"
            case .running: "Run"
            case .cycling: "Cycling"
            case .traditionalStrengthTraining, .functionalStrengthTraining: "Strength"
            case .hiking: "Hike"
            case .stairClimbing, .stairs: "Stairs"
            default: "Workout"
            }
        }
    }

    /// Fetch workouts in the given interval. Defaults to today.
    func workouts(from start: Date, to end: Date = .now) async throws -> [WorkoutSummary] {
        guard isAvailable else { return [] }
        let predicate = HKQuery.predicateForSamples(withStart: start, end: end, options: .strictStartDate)

        let samples: [HKWorkout] = try await withCheckedThrowingContinuation { cont in
            let q = HKSampleQuery(
                sampleType: .workoutType(),
                predicate: predicate,
                limit: HKObjectQueryNoLimit,
                sortDescriptors: [NSSortDescriptor(keyPath: \HKSample.startDate, ascending: false)]
            ) { _, results, error in
                if let error { cont.resume(throwing: error); return }
                cont.resume(returning: (results as? [HKWorkout]) ?? [])
            }
            store.execute(q)
        }

        return samples.map { w in
            WorkoutSummary(
                id: w.uuid,
                start: w.startDate,
                end: w.endDate,
                duration: w.duration,
                activityTypeRawValue: w.workoutActivityType.rawValue,
                totalEnergyKcal: (w.statistics(for: HKQuantityType(.activeEnergyBurned))?
                    .sumQuantity()?.doubleValue(for: .kilocalorie())),
                totalDistanceMeters: (w.statistics(for: HKQuantityType(.distanceWalkingRunning))?
                    .sumQuantity()?.doubleValue(for: .meter())),
                averageHeartRate: nil
            )
        }
    }
}

import Foundation
import SwiftData

// MARK: - Weight unit

enum WeightUnit: String, Codable, CaseIterable, Sendable {
    case lbs, kg

    var label: String { rawValue }
}

// MARK: - Weekly plan

/// Persisted default workout for each day of the week, for both gym and no-gym.
/// `dayOfWeek` uses Calendar numbering: 1 = Sunday … 7 = Saturday.
@Model
final class WeeklyPlanDay {
    @Attribute(.unique) var dayOfWeek: Int
    var gymWorkoutRaw: String
    var noGymWorkoutRaw: String

    init(dayOfWeek: Int, gym: WorkoutType, noGym: WorkoutType) {
        self.dayOfWeek = dayOfWeek
        self.gymWorkoutRaw = gym.rawValue
        self.noGymWorkoutRaw = noGym.rawValue
    }

    var gymWorkout: WorkoutType {
        get { WorkoutType(rawValue: gymWorkoutRaw) ?? .rest }
        set { gymWorkoutRaw = newValue.rawValue }
    }
    var noGymWorkout: WorkoutType {
        get { WorkoutType(rawValue: noGymWorkoutRaw) ?? .rest }
        set { noGymWorkoutRaw = newValue.rawValue }
    }
}

// MARK: - Day override

/// Per-date override that replaces the weekly default for a single day.
/// `workoutTypeRaw == nil` means "inherit weekly default" — only gymAvailable is pinned.
@Model
final class DayOverride {
    @Attribute(.unique) var dateKey: String   // yyyy-MM-dd
    var workoutTypeRaw: String?
    var gymAvailable: Bool
    var notes: String

    init(date: Date, workoutType: WorkoutType?, gymAvailable: Bool, notes: String = "") {
        self.dateKey = Self.dateKey(from: date)
        self.workoutTypeRaw = workoutType?.rawValue
        self.gymAvailable = gymAvailable
        self.notes = notes
    }

    var workoutType: WorkoutType? {
        get { workoutTypeRaw.flatMap { WorkoutType(rawValue: $0) } }
        set { workoutTypeRaw = newValue?.rawValue }
    }

    static func dateKey(from date: Date) -> String {
        let fmt = DateFormatter()
        fmt.calendar = Calendar(identifier: .iso8601)
        fmt.locale = Locale(identifier: "en_US_POSIX")
        fmt.dateFormat = "yyyy-MM-dd"
        fmt.timeZone = .current
        return fmt.string(from: date)
    }
}

// MARK: - Session + SetLog

@Model
final class WorkoutSession {
    @Attribute(.unique) var id: UUID
    var startedAt: Date
    var finishedAt: Date?
    var workoutTypeRaw: String
    var gymUsed: Bool
    var notes: String
    var healthKitWorkoutUUID: UUID?
    var remoteSyncedAt: Date?

    @Relationship(deleteRule: .cascade, inverse: \SetLog.session)
    var sets: [SetLog] = []

    init(
        id: UUID = UUID(),
        startedAt: Date = .now,
        workoutType: WorkoutType,
        gymUsed: Bool,
        notes: String = ""
    ) {
        self.id = id
        self.startedAt = startedAt
        self.workoutTypeRaw = workoutType.rawValue
        self.gymUsed = gymUsed
        self.notes = notes
    }

    var workoutType: WorkoutType {
        get { WorkoutType(rawValue: workoutTypeRaw) ?? .rest }
        set { workoutTypeRaw = newValue.rawValue }
    }

    var isFinished: Bool { finishedAt != nil }
}

@Model
final class SetLog {
    @Attribute(.unique) var id: UUID
    var exerciseSlug: String
    var setNumber: Int
    var reps: Int?
    var weightLbs: Double?
    var durationSeconds: Int?
    var side: String?               // "L" / "R" / nil
    var completedAt: Date
    var rpe: Int?                   // 1-10
    var notes: String
    var session: WorkoutSession?

    init(
        id: UUID = UUID(),
        exerciseSlug: String,
        setNumber: Int,
        reps: Int? = nil,
        weightLbs: Double? = nil,
        durationSeconds: Int? = nil,
        side: String? = nil,
        completedAt: Date = .now,
        rpe: Int? = nil,
        notes: String = ""
    ) {
        self.id = id
        self.exerciseSlug = exerciseSlug
        self.setNumber = setNumber
        self.reps = reps
        self.weightLbs = weightLbs
        self.durationSeconds = durationSeconds
        self.side = side
        self.completedAt = completedAt
        self.rpe = rpe
        self.notes = notes
    }
}

// MARK: - Per-exercise target override

/// User-edited target sets/reps for a specific exercise. If absent, the catalog default applies.
@Model
final class ExerciseTarget {
    @Attribute(.unique) var exerciseSlug: String
    var targetSets: Int
    var targetRepsLow: Int?
    var targetRepsHigh: Int?
    var updatedAt: Date

    init(exerciseSlug: String, targetSets: Int, targetRepsLow: Int?, targetRepsHigh: Int?) {
        self.exerciseSlug = exerciseSlug
        self.targetSets = targetSets
        self.targetRepsLow = targetRepsLow
        self.targetRepsHigh = targetRepsHigh
        self.updatedAt = .now
    }
}

// MARK: - App settings

@Model
final class AppSettings {
    var weightUnitRaw: String
    var restTimerEnabled: Bool
    var gymAvailableDefault: Bool
    var remindersEnabled: Bool = true
    var googleUserEmail: String?
    var googleDisplayName: String?

    init(
        weightUnit: WeightUnit = .lbs,
        restTimerEnabled: Bool = true,
        gymAvailableDefault: Bool = true,
        remindersEnabled: Bool = true
    ) {
        self.weightUnitRaw = weightUnit.rawValue
        self.restTimerEnabled = restTimerEnabled
        self.gymAvailableDefault = gymAvailableDefault
        self.remindersEnabled = remindersEnabled
    }

    var weightUnit: WeightUnit {
        get { WeightUnit(rawValue: weightUnitRaw) ?? .lbs }
        set { weightUnitRaw = newValue.rawValue }
    }
}

// MARK: - Schema bundle

enum AppSchema {
    static let version = Schema.Version(0, 1, 0)
    static let models: [any PersistentModel.Type] = [
        WeeklyPlanDay.self,
        DayOverride.self,
        WorkoutSession.self,
        SetLog.self,
        ExerciseTarget.self,
        AppSettings.self
    ]
}

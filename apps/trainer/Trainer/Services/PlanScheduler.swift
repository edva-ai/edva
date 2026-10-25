import Foundation
import SwiftData

/// Resolves which workout is scheduled for a given date, honoring:
///   1. Manual per-day override
///   2. Weekly default × gym-available toggle
@MainActor
struct PlanScheduler {
    let context: ModelContext

    func plannedWorkout(for date: Date, gymAvailable: Bool) -> WorkoutType {
        let key = DayOverride.dateKey(from: date)
        if let override = try? context.fetch(
            FetchDescriptor<DayOverride>(predicate: #Predicate { $0.dateKey == key })
        ).first, let explicit = override.workoutType {
            return explicit
        }

        let dow = Calendar.current.component(.weekday, from: date)
        if let day = try? context.fetch(
            FetchDescriptor<WeeklyPlanDay>(predicate: #Predicate { $0.dayOfWeek == dow })
        ).first {
            return gymAvailable ? day.gymWorkout : day.noGymWorkout
        }

        return Self.defaultWorkout(dayOfWeek: dow, gymAvailable: gymAvailable)
    }

    func effectiveGymAvailable(for date: Date, defaultAvailable: Bool) -> Bool {
        let key = DayOverride.dateKey(from: date)
        if let override = try? context.fetch(
            FetchDescriptor<DayOverride>(predicate: #Predicate { $0.dateKey == key })
        ).first {
            return override.gymAvailable
        }
        return defaultAvailable
    }

    /// First-launch seed: populates WeeklyPlanDay × 7 and AppSettings (singleton).
    func seedIfNeeded() {
        let settings = try? context.fetch(FetchDescriptor<AppSettings>()).first
        if settings == nil {
            context.insert(AppSettings())
        }

        for dow in 1...7 {
            let existing = try? context.fetch(
                FetchDescriptor<WeeklyPlanDay>(predicate: #Predicate { $0.dayOfWeek == dow })
            ).first
            if existing == nil {
                let (gym, noGym) = Self.defaultPairForDayOfWeek(dow)
                context.insert(WeeklyPlanDay(dayOfWeek: dow, gym: gym, noGym: noGym))
            }
        }
    }

    /// Default weekly template — matches what we discussed with the user.
    /// Calendar weekday: 1 = Sun, 2 = Mon, 3 = Tue, 4 = Wed, 5 = Thu, 6 = Fri, 7 = Sat.
    static func defaultPairForDayOfWeek(_ dow: Int) -> (gym: WorkoutType, noGym: WorkoutType) {
        switch dow {
        case 2: (.strengthA, .bodyweightA)          // Mon
        case 3: (.cardioSteady, .cardioSteady)      // Tue
        case 4: (.strengthB, .bodyweightB)          // Wed
        case 5: (.rest, .rest)                      // Thu (full rest day — Minimum Effective is opt-in via the Today card)
        case 6: (.strengthA, .bodyweightA)          // Fri
        case 7: (.cardioIntervals, .cardioIntervals)// Sat
        default: (.rest, .rest)                     // Sun
        }
    }

    static func defaultWorkout(dayOfWeek: Int, gymAvailable: Bool) -> WorkoutType {
        let pair = defaultPairForDayOfWeek(dayOfWeek)
        return gymAvailable ? pair.gym : pair.noGym
    }
}

extension Calendar {
    static func weekdayName(_ dayOfWeek: Int) -> String {
        switch dayOfWeek {
        case 1: "Sunday"
        case 2: "Monday"
        case 3: "Tuesday"
        case 4: "Wednesday"
        case 5: "Thursday"
        case 6: "Friday"
        case 7: "Saturday"
        default: ""
        }
    }

    static func weekdayShort(_ dayOfWeek: Int) -> String {
        switch dayOfWeek {
        case 1: "Sun"
        case 2: "Mon"
        case 3: "Tue"
        case 4: "Wed"
        case 5: "Thu"
        case 6: "Fri"
        case 7: "Sat"
        default: ""
        }
    }
}

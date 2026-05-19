import Foundation
import SwiftData
#if canImport(Supabase)
import Supabase
#endif

/// Pushes finished WorkoutSessions + their SetLogs to Supabase so Merlin can read them.
/// Idempotent: a session is only pushed once per `updatedAt`; we stamp `remoteSyncedAt` after success.
@MainActor
final class SupabaseSync {
    private let authService: AuthService
    private let context: ModelContext

    init(authService: AuthService, context: ModelContext) {
        self.authService = authService
        self.context = context
    }

    struct SessionPayload: Codable {
        let id: UUID
        let user_id: UUID
        let started_at: Date
        let finished_at: Date?
        let workout_type: String
        let gym_used: Bool
        let notes: String
        let healthkit_uuid: UUID?
    }

    struct SetPayload: Codable {
        let id: UUID
        let session_id: UUID
        let user_id: UUID
        let exercise_slug: String
        let set_number: Int
        let reps: Int?
        let weight_lbs: Double?
        let duration_seconds: Int?
        let side: String?
        let rpe: Int?
        let notes: String
        let completed_at: Date
    }

    struct TargetPayload: Codable {
        let user_id: UUID
        let exercise_slug: String
        let target_sets: Int
        let target_reps_low: Int?
        let target_reps_high: Int?
    }

    struct DayOverridePayload: Codable {
        let user_id: UUID
        let date_key: String
        let workout_type: String?
        let gym_available: Bool?
    }

    struct WeeklyPlanPayload: Codable {
        let user_id: UUID
        let day_of_week: Int
        let gym_workout: String
        let no_gym_workout: String
    }

    struct AppSettingsPayload: Codable {
        let user_id: UUID
        let weight_unit: String
        let rest_timer_enabled: Bool
        let gym_available_default: Bool
        let reminders_enabled: Bool
    }

    func pushPendingSessions() async {
        #if canImport(Supabase)
        guard let client = authService.client else { return }
        let userID: UUID
        do { userID = try await client.auth.user().id } catch { return }

        let descriptor = FetchDescriptor<WorkoutSession>(
            predicate: #Predicate { $0.finishedAt != nil && $0.remoteSyncedAt == nil },
            sortBy: [SortDescriptor(\.finishedAt, order: .forward)]
        )
        guard let sessions = try? context.fetch(descriptor) else { return }

        for session in sessions {
            let payload = SessionPayload(
                id: session.id,
                user_id: userID,
                started_at: session.startedAt,
                finished_at: session.finishedAt,
                workout_type: session.workoutTypeRaw,
                gym_used: session.gymUsed,
                notes: session.notes,
                healthkit_uuid: session.healthKitWorkoutUUID
            )
            let sets: [SetPayload] = session.sets.map {
                SetPayload(
                    id: $0.id,
                    session_id: session.id,
                    user_id: userID,
                    exercise_slug: $0.exerciseSlug,
                    set_number: $0.setNumber,
                    reps: $0.reps,
                    weight_lbs: $0.weightLbs,
                    duration_seconds: $0.durationSeconds,
                    side: $0.side,
                    rpe: $0.rpe,
                    notes: $0.notes,
                    completed_at: $0.completedAt
                )
            }

            do {
                try await client
                    .from("sessions")
                    .upsert(payload, onConflict: "id")
                    .execute()
                if !sets.isEmpty {
                    try await client
                        .from("set_logs")
                        .upsert(sets, onConflict: "id")
                        .execute()
                }
                session.remoteSyncedAt = .now
                try? context.save()
            } catch {
                print("[Sync] push failed for session \(session.id): \(error)")
            }
        }
        #endif
    }

    /// Pushes the current prefs — small tables, so full upsert each time is fine.
    func pushLocalPrefs() async {
        #if canImport(Supabase)
        guard let client = authService.client else { return }
        let userID: UUID
        do { userID = try await client.auth.user().id } catch { return }

        if let targets = try? context.fetch(FetchDescriptor<ExerciseTarget>()), !targets.isEmpty {
            let payload = targets.map {
                TargetPayload(
                    user_id: userID,
                    exercise_slug: $0.exerciseSlug,
                    target_sets: $0.targetSets,
                    target_reps_low: $0.targetRepsLow,
                    target_reps_high: $0.targetRepsHigh
                )
            }
            try? await client.from("exercise_targets")
                .upsert(payload, onConflict: "user_id,exercise_slug")
                .execute()
        }

        if let overrides = try? context.fetch(FetchDescriptor<DayOverride>()), !overrides.isEmpty {
            let payload = overrides.map {
                DayOverridePayload(
                    user_id: userID,
                    date_key: $0.dateKey,
                    workout_type: $0.workoutTypeRaw,
                    gym_available: $0.gymAvailable
                )
            }
            try? await client.from("day_overrides")
                .upsert(payload, onConflict: "user_id,date_key")
                .execute()
        }

        if let plan = try? context.fetch(FetchDescriptor<WeeklyPlanDay>()), !plan.isEmpty {
            let payload = plan.map {
                WeeklyPlanPayload(
                    user_id: userID,
                    day_of_week: $0.dayOfWeek,
                    gym_workout: $0.gymWorkoutRaw,
                    no_gym_workout: $0.noGymWorkoutRaw
                )
            }
            try? await client.from("weekly_plan_days")
                .upsert(payload, onConflict: "user_id,day_of_week")
                .execute()
        }

        if let settings = try? context.fetch(FetchDescriptor<AppSettings>()).first {
            let payload = AppSettingsPayload(
                user_id: userID,
                weight_unit: settings.weightUnitRaw,
                rest_timer_enabled: settings.restTimerEnabled,
                gym_available_default: settings.gymAvailableDefault,
                reminders_enabled: settings.remindersEnabled
            )
            try? await client.from("app_settings")
                .upsert(payload, onConflict: "user_id")
                .execute()
        }
        #endif
    }
}

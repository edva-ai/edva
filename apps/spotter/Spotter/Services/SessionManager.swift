import Foundation
import SwiftData

/// Enforces "one session per calendar day" and cleans up stale unfinished sessions.
@MainActor
struct SessionManager {
    let context: ModelContext

    /// The session that belongs to `date` (today by default). May be finished or in-progress.
    func session(for date: Date = .now) -> WorkoutSession? {
        let start = Calendar.current.startOfDay(for: date)
        let end = Calendar.current.date(byAdding: .day, value: 1, to: start) ?? start
        let descriptor = FetchDescriptor<WorkoutSession>(
            predicate: #Predicate { $0.startedAt >= start && $0.startedAt < end },
            sortBy: [SortDescriptor(\.startedAt, order: .forward)]
        )
        return try? context.fetch(descriptor).first
    }

    /// If a session for today exists, return it (un-finishing so the user can continue logging
    /// in a single daily record). Otherwise create a new one.
    @discardableResult
    func startOrResumeToday(workoutType: WorkoutType, gymUsed: Bool) -> WorkoutSession {
        if let existing = session(for: .now) {
            if existing.finishedAt != nil {
                // User is coming back in — re-open the session. Don't wipe its finishedAt
                // permanently; WorkoutRunnerView.finish() will re-stamp it.
                existing.finishedAt = nil
                existing.remoteSyncedAt = nil
            }
            return existing
        }
        let session = WorkoutSession(workoutType: workoutType, gymUsed: gymUsed)
        context.insert(session)
        try? context.save()
        return session
    }

    /// Wipes today's session + every set logged against it. Used by the
    /// "Cancel workout" button on the Today card to reset the day.
    func cancelTodaySession() {
        guard let existing = session(for: .now) else { return }
        for set in existing.sets {
            context.delete(set)
        }
        context.delete(existing)
        try? context.save()
    }

    /// Auto-closes any session from a prior day that was left in progress.
    /// Sets `finishedAt` to midnight-after-started-at so the record lands on the correct calendar day.
    func closeDanglingSessions() {
        let startOfToday = Calendar.current.startOfDay(for: .now)
        let descriptor = FetchDescriptor<WorkoutSession>(
            predicate: #Predicate { $0.startedAt < startOfToday && $0.finishedAt == nil }
        )
        guard let dangling = try? context.fetch(descriptor), !dangling.isEmpty else { return }

        for session in dangling {
            let startOfStartedDay = Calendar.current.startOfDay(for: session.startedAt)
            let nextDay = Calendar.current.date(byAdding: .day, value: 1, to: startOfStartedDay) ?? session.startedAt
            session.finishedAt = nextDay.addingTimeInterval(-60) // 23:59:00
        }
        try? context.save()
    }
}

import Foundation
import SwiftData
import UserNotifications

@MainActor
final class NotificationScheduler {
    static let shared = NotificationScheduler()

    static let reminderIdentifier = "spotter.daily-noon-reminder"
    static let reminderHour = 12
    static let reminderMinute = 0

    private init() {}

    /// Ask for authorization. Call once early in app lifecycle (or when the user first enables reminders).
    @discardableResult
    func requestAuthorizationIfNeeded() async -> Bool {
        let center = UNUserNotificationCenter.current()
        let current = await center.notificationSettings()
        switch current.authorizationStatus {
        case .notDetermined:
            return (try? await center.requestAuthorization(options: [.alert, .sound, .badge])) ?? false
        case .denied:
            return false
        default:
            return true
        }
    }

    /// Re-plan the noon reminder based on current state:
    ///  - Cancels any existing reminder.
    ///  - Schedules one for today at `reminderHour:reminderMinute` if **all** are true:
    ///    * reminders are enabled in `AppSettings`
    ///    * today is an exercise day (not rest)
    ///    * no session exists yet today
    ///    * current time is still before the reminder time
    ///
    /// Call this on: app foreground, session start, session finish, settings toggle, day rollover.
    func refreshTodayReminder(context: ModelContext) {
        let center = UNUserNotificationCenter.current()
        center.removePendingNotificationRequests(withIdentifiers: [Self.reminderIdentifier])

        let settings = (try? context.fetch(FetchDescriptor<AppSettings>()))?.first
        guard settings?.remindersEnabled ?? true else { return }

        // Already has a session today — no nag.
        if SessionManager(context: context).session(for: .now) != nil { return }

        // Today is a rest day — no nag.
        let gymAvailable = settings?.gymAvailableDefault ?? true
        let planned = PlanScheduler(context: context).plannedWorkout(for: .now, gymAvailable: gymAvailable)
        if planned.isRest { return }

        // Build noon today.
        var comps = Calendar.current.dateComponents([.year, .month, .day], from: .now)
        comps.hour = Self.reminderHour
        comps.minute = Self.reminderMinute
        guard let reminderDate = Calendar.current.date(from: comps), reminderDate > .now else { return }

        let spec = WorkoutCatalog.spec(for: planned)
        let content = UNMutableNotificationContent()
        content.title = "Move today"
        content.body = "Today is \(spec.title). Tap to log a workout or swap it out."
        content.sound = .default
        content.interruptionLevel = .timeSensitive

        let trigger = UNCalendarNotificationTrigger(
            dateMatching: Calendar.current.dateComponents([.year, .month, .day, .hour, .minute], from: reminderDate),
            repeats: false
        )
        let request = UNNotificationRequest(identifier: Self.reminderIdentifier, content: content, trigger: trigger)
        center.add(request) { error in
            if let error { print("[Notif] schedule failed: \(error)") }
        }
    }

    func cancelReminder() {
        UNUserNotificationCenter.current().removePendingNotificationRequests(withIdentifiers: [Self.reminderIdentifier])
    }
}

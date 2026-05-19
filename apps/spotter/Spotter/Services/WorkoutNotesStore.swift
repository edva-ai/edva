import Foundation
import Observation
#if canImport(Supabase)
import Supabase
#endif

/// Per-workout bullet text (warm-up + how-to-do-it) fetched from Supabase's
/// public `workout_notes` table with the static `WorkoutCatalog` values as
/// fallback. Loading happens once per app session in the background; views
/// read synchronously and transparently get the catalog text until the
/// fetch lands, then automatically re-render with the DB text.
@MainActor
@Observable
final class WorkoutNotesStore {

    struct Notes {
        let warmup: [String]
        let howToDoIt: [String]
    }

    private(set) var loaded = false
    private var remote: [WorkoutType: Notes] = [:]

    static let shared = WorkoutNotesStore()

    func notes(for type: WorkoutType) -> Notes {
        if let r = remote[type] { return r }
        let spec = WorkoutCatalog.spec(for: type)
        let warmupBullets = spec.warmup.isEmpty ? [] : [spec.warmup]
        return Notes(warmup: warmupBullets, howToDoIt: spec.howToDoIt)
    }

    struct Row: Decodable {
        let workout_type: String
        let kind: String
        let order_index: Int
        let text: String
    }

    func load() async {
        #if canImport(Supabase)
        guard !loaded else { return }
        guard let client = AuthServiceHolder.shared?.client else { return }
        do {
            let rows: [Row] = try await client
                .from("workout_notes")
                .select()
                .order("order_index", ascending: true)
                .execute()
                .value
            var byType: [WorkoutType: (warmup: [String], how: [String])] = [:]
            for row in rows {
                guard let type = WorkoutType(rawValue: row.workout_type) else { continue }
                var current = byType[type] ?? ([], [])
                if row.kind == "warmup" {
                    current.warmup.append(row.text)
                } else if row.kind == "how_to_do_it" {
                    current.how.append(row.text)
                }
                byType[type] = current
            }
            remote = byType.mapValues { Notes(warmup: $0.warmup, howToDoIt: $0.how) }
            loaded = true
        } catch {
            print("[Notes] fetch failed: \(error.localizedDescription)")
        }
        #endif
    }
}

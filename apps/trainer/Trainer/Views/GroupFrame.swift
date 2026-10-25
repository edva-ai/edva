import SwiftUI

/// Visual grouping for superset/group exercises. Use when two or more
/// exercises from the catalog share a `pair` value — the user alternates
/// between them. Renders a single liquid card with a "Group N" chip in the
/// top-left and the caller-provided rows stacked inside with thin dividers.
struct GroupFrame<Content: View>: View {
    let groupNumber: Int
    @ViewBuilder let content: () -> Content

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 6) {
                Image(systemName: "link")
                    .font(.caption2.weight(.bold))
                Text("Group \(groupNumber)")
                    .font(.caption.weight(.bold))
            }
            .foregroundStyle(.white)
            .padding(.horizontal, 10)
            .padding(.vertical, 4)
            .background(Capsule().fill(Palette.group.opacity(0.18)))
            .overlay(Capsule().stroke(Palette.group.opacity(0.4), lineWidth: 0.5))

            content()
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .liquidCard(cornerRadius: 22)
    }
}

/// Thin inter-row separator for GroupFrame contents.
struct GroupFrameDivider: View {
    var body: some View {
        Rectangle()
            .fill(.white.opacity(0.12))
            .frame(height: 0.5)
            .padding(.horizontal, -14)   // bleed to the outer card edges
    }
}

// MARK: - WorkoutSpec grouping helper

extension WorkoutSpec {
    struct ExerciseGroup: Identifiable {
        let id: String
        /// Catalog group id (nil = standalone exercise).
        let groupID: Int?
        let exercises: [ExerciseSpec]
    }

    /// Returns exercises grouped by their catalog `pair` id (which really
    /// means group — a set of 2+ exercises to alternate between) while
    /// preserving the catalog's ordering. Solo exercises become singleton
    /// groups. A group with a single member falls through as a singleton.
    var exerciseGroups: [ExerciseGroup] {
        var out: [ExerciseGroup] = []
        var seen = Set<Int>()
        for ex in exercises {
            if let g = ex.pair {
                if seen.contains(g) { continue }
                seen.insert(g)
                let members = exercises.filter { $0.pair == g }
                if members.count >= 2 {
                    out.append(ExerciseGroup(id: "group-\(g)", groupID: g, exercises: members))
                } else {
                    out.append(ExerciseGroup(id: "solo-\(ex.id)", groupID: nil, exercises: [ex]))
                }
            } else {
                out.append(ExerciseGroup(id: "solo-\(ex.id)", groupID: nil, exercises: [ex]))
            }
        }
        return out
    }
}

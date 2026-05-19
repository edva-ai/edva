import SwiftUI
import SwiftData

struct HistoryView: View {
    @Query(sort: \WorkoutSession.startedAt, order: .reverse) private var sessions: [WorkoutSession]

    var body: some View {
        NavigationStack {
            ZStack {
                AppBackground()
                if sessions.isEmpty {
                    emptyState
                } else {
                    ScrollView {
                        VStack(spacing: 12) {
                            ForEach(groupedByWeek, id: \.0) { week, items in
                                weekSection(week: week, items: items)
                            }
                        }
                        .padding(16)
                    }
                }
            }
            .navigationTitle("History")
            .toolbarColorScheme(.dark, for: .navigationBar)
        }
    }

    enum Bucket: Int, CaseIterable {
        case today, yesterday, thisWeek, lastWeek, earlier
        var title: String {
            switch self {
            case .today: "Today"
            case .yesterday: "Yesterday"
            case .thisWeek: "This week"
            case .lastWeek: "Last week"
            case .earlier: "Earlier"
            }
        }
    }

    private static func bucket(for date: Date) -> Bucket {
        let cal = Calendar.current
        if cal.isDateInToday(date) { return .today }
        if cal.isDateInYesterday(date) { return .yesterday }
        if let thisWeek = cal.dateInterval(of: .weekOfYear, for: .now), thisWeek.contains(date) {
            return .thisWeek
        }
        if let lastRef = cal.date(byAdding: .weekOfYear, value: -1, to: .now),
           let lastWeek = cal.dateInterval(of: .weekOfYear, for: lastRef),
           lastWeek.contains(date) {
            return .lastWeek
        }
        return .earlier
    }

    private var groupedByWeek: [(String, [WorkoutSession])] {
        let groups = Dictionary(grouping: sessions) { Self.bucket(for: $0.startedAt) }
        return Bucket.allCases.compactMap { b in
            guard let items = groups[b], !items.isEmpty else { return nil }
            return (b.title, items)
        }
    }

    private func weekSection(week: String, items: [WorkoutSession]) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(week.uppercased())
                .font(.caption.weight(.bold))
                .foregroundStyle(.white.opacity(0.6))
                .padding(.horizontal, 4)
            ForEach(items) { session in
                NavigationLink { SessionDetailView(session: session) } label: {
                    HistoryRow(session: session)
                }
                .buttonStyle(.plain)
            }
        }
    }

    private var emptyState: some View {
        VStack(spacing: 12) {
            Image(systemName: "clock.arrow.circlepath")
                .font(.system(size: 56))
                .foregroundStyle(.white.opacity(0.4))
            Text("No sessions yet")
                .font(.title3.weight(.semibold))
                .foregroundStyle(.white)
            Text("Complete your first workout to see it here.")
                .font(.callout)
                .foregroundStyle(.white.opacity(0.65))
        }
    }
}

struct HistoryRow: View {
    let session: WorkoutSession

    var body: some View {
        HStack(spacing: 14) {
            workoutBadge

            VStack(alignment: .leading, spacing: 2) {
                Text(WorkoutCatalog.spec(for: session.workoutType).title)
                    .font(.body.weight(.semibold))
                    .foregroundStyle(.white)
                Text(dateLine)
                    .font(.caption)
                    .foregroundStyle(.white.opacity(0.7))
                if session.sets.count > 0 {
                    Text("\(session.sets.count) sets logged")
                        .font(.caption.weight(.medium))
                        .foregroundStyle(.white.opacity(0.8))
                }
            }
            Spacer()
            if !session.isFinished {
                Text("In progress")
                    .font(.caption.weight(.bold))
                    .padding(.horizontal, 10)
                    .padding(.vertical, 4)
                    .background(Capsule().fill(.orange))
                    .foregroundStyle(.black)
            }
            Image(systemName: "chevron.right")
                .foregroundStyle(.white.opacity(0.5))
                .font(.footnote)
        }
        .padding(14)
        .liquidCard()
    }

    private var dateLine: String {
        let fmt = DateFormatter()
        fmt.dateFormat = "EEE, MMM d"
        let dateStr = fmt.string(from: session.startedAt)
        if let end = session.finishedAt {
            let mins = Int(end.timeIntervalSince(session.startedAt) / 60)
            return "\(dateStr) · \(mins) min"
        }
        return dateStr
    }

    private var workoutBadge: some View {
        let icon = iconFor(session.workoutType)
        let color = colorFor(session.workoutType)
        return Image(systemName: icon)
            .font(.title3.weight(.semibold))
            .foregroundStyle(.white)
            .frame(width: 44, height: 44)
            .background(Circle().fill(color.gradient))
    }

    private func iconFor(_ t: WorkoutType) -> String {
        switch t {
        case .strengthA, .strengthB: "dumbbell.fill"
        case .bodyweightA, .bodyweightB: "figure.strengthtraining.functional"
        case .minimumEffective: "bolt.fill"
        case .cardioSteady: "figure.walk.treadmill"
        case .cardioIntervals: "waveform.path.ecg"
        case .rest: "leaf.fill"
        }
    }

    private func colorFor(_ t: WorkoutType) -> Color {
        switch t {
        case .strengthA, .strengthB: .orange
        case .bodyweightA, .bodyweightB: .purple
        case .minimumEffective: .yellow
        case .cardioSteady: .green
        case .cardioIntervals: .pink
        case .rest: .mint
        }
    }
}

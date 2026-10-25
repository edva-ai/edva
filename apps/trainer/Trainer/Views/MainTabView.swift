import SwiftUI

struct MainTabView: View {
    var body: some View {
        TabView {
            Tab("Today", systemImage: "flame.fill") {
                TodayView()
            }
            Tab("Week", systemImage: "calendar") {
                WeekView()
            }
            Tab("History", systemImage: "chart.line.uptrend.xyaxis") {
                HistoryView()
            }
            Tab("Settings", systemImage: "gearshape") {
                SettingsView()
            }
        }
        .tint(.white)
    }
}

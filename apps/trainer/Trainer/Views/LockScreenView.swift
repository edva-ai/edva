import SwiftUI

struct LockScreenView: View {
    @Environment(BiometricAuth.self) private var biometric

    var body: some View {
        ZStack {
            AppBackground()

            VStack(spacing: 28) {
                Spacer()
                Image(systemName: "faceid")
                    .font(.system(size: 72, weight: .light))
                    .foregroundStyle(.white)
                Text("Locked")
                    .font(.title.weight(.semibold))
                    .foregroundStyle(.white)
                Text("Use Face ID to continue")
                    .font(.subheadline)
                    .foregroundStyle(.white.opacity(0.7))
                Spacer()
                Button {
                    Task { await biometric.unlock() }
                } label: {
                    Label("Unlock with Face ID", systemImage: "faceid")
                        .font(.body.weight(.semibold))
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 14)
                }
                .buttonStyle(.borderedProminent)
                .tint(.white)
                .foregroundStyle(.black)
                .clipShape(Capsule())
                .padding(.horizontal, 32)
                .padding(.bottom, 40)
            }
        }
        .task { await biometric.unlock() }
    }
}

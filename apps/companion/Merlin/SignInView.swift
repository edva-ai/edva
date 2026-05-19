import SwiftUI

struct SignInView: View {
    let onSignedIn: () -> Void

    @State private var signingIn = false
    @State private var error: String?

    var body: some View {
        VStack(spacing: 24) {
            Spacer()

            Image(systemName: "bubble.left.and.bubble.right.fill")
                .font(.system(size: 56))
                .foregroundStyle(.secondary)

            Text("Merlin")
                .font(.largeTitle.bold())

            Text("Sign in to continue.")
                .font(.body)
                .foregroundStyle(.secondary)

            Spacer()

            Button(action: signIn) {
                HStack(spacing: 10) {
                    if signingIn {
                        ProgressView().controlSize(.small)
                    } else {
                        Image(systemName: "person.crop.circle.fill")
                    }
                    Text(signingIn ? "Opening Google…" : "Sign in with Google")
                        .fontWeight(.semibold)
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 14)
                .background(
                    RoundedRectangle(cornerRadius: 12)
                        .fill(Color.accentColor)
                )
                .foregroundStyle(.white)
            }
            .buttonStyle(.plain)
            .disabled(signingIn)
            .padding(.horizontal, 40)

            if let error {
                Text(error)
                    .font(.footnote)
                    .foregroundStyle(.red)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 40)
            }

            Spacer().frame(height: 60)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func signIn() {
        signingIn = true
        error = nil
        Task {
            do {
                try await SupabaseManager.signInWithGoogle()
                await MainActor.run {
                    signingIn = false
                    onSignedIn()
                }
            } catch {
                await MainActor.run {
                    signingIn = false
                    self.error = error.localizedDescription
                }
            }
        }
    }
}

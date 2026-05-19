import SwiftUI
import WebKit

/// Embedded browser for the Merlin memory wiki served at
/// `http://${MERLIN_HOST}:9096` (reachable over Tailscale or home LAN).
/// Designed to swap into the chat window's main content area — the parent
/// owns the surrounding NavigationStack/title/toolbar so the user can switch
/// back to a chat channel from the same menu that opened Memory.
struct MemoryView: View {
    let url: URL
    @ObservedObject var state: WebViewState

    var body: some View {
        ZStack(alignment: .top) {
            WebView(initialURL: url, state: state)
            if state.isLoading {
                ProgressView()
                    .progressViewStyle(.linear)
                    .frame(maxWidth: .infinity)
            }
            if let err = state.loadError {
                errorOverlay(err)
            }
        }
    }

    @ViewBuilder
    private func errorOverlay(_ message: String) -> some View {
        VStack(spacing: 12) {
            Image(systemName: "wifi.exclamationmark")
                .font(.largeTitle)
                .foregroundStyle(.secondary)
            Text("Can't reach the wiki")
                .font(.headline)
            Text(message)
                .font(.caption)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 24)
            Text("Make sure Tailscale is connected or you're on the home network.")
                .font(.caption)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 24)
            Button("Retry") { state.reload() }
                .buttonStyle(.borderedProminent)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(.regularMaterial)
    }
}

@MainActor
final class WebViewState: ObservableObject {
    @Published var canGoBack: Bool = false
    @Published var canGoForward: Bool = false
    @Published var isLoading: Bool = false
    @Published var loadError: String?

    fileprivate weak var webView: WKWebView?

    func goBack() { webView?.goBack() }
    func goForward() { webView?.goForward() }
    func reload() {
        loadError = nil
        if webView?.url == nil, let pending = pendingInitialURL {
            webView?.load(URLRequest(url: pending))
        } else {
            webView?.reload()
        }
    }

    fileprivate var pendingInitialURL: URL?
}

#if os(iOS)
private struct WebView: UIViewRepresentable {
    let initialURL: URL
    let state: WebViewState

    func makeCoordinator() -> Coordinator { Coordinator(state: state) }

    func makeUIView(context: Context) -> WKWebView {
        let webView = WKWebView(frame: .zero, configuration: WKWebViewConfiguration())
        webView.navigationDelegate = context.coordinator
        webView.allowsBackForwardNavigationGestures = true
        state.webView = webView
        state.pendingInitialURL = initialURL
        context.coordinator.attach(webView)
        webView.load(URLRequest(url: initialURL))
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {}

    final class Coordinator: WebViewCoordinator {}
}
#else
private struct WebView: NSViewRepresentable {
    let initialURL: URL
    let state: WebViewState

    func makeCoordinator() -> Coordinator { Coordinator(state: state) }

    func makeNSView(context: Context) -> WKWebView {
        let webView = WKWebView(frame: .zero, configuration: WKWebViewConfiguration())
        webView.navigationDelegate = context.coordinator
        webView.allowsBackForwardNavigationGestures = true
        state.webView = webView
        state.pendingInitialURL = initialURL
        context.coordinator.attach(webView)
        webView.load(URLRequest(url: initialURL))
        return webView
    }

    func updateNSView(_ webView: WKWebView, context: Context) {}

    final class Coordinator: WebViewCoordinator {}
}
#endif

private class WebViewCoordinator: NSObject, WKNavigationDelegate {
    let state: WebViewState
    private var observers: [NSKeyValueObservation] = []

    init(state: WebViewState) {
        self.state = state
    }

    func attach(_ webView: WKWebView) {
        observers.append(webView.observe(\.canGoBack, options: [.initial, .new]) { [weak self] wv, _ in
            Task { @MainActor in self?.state.canGoBack = wv.canGoBack }
        })
        observers.append(webView.observe(\.canGoForward, options: [.initial, .new]) { [weak self] wv, _ in
            Task { @MainActor in self?.state.canGoForward = wv.canGoForward }
        })
        observers.append(webView.observe(\.isLoading, options: [.initial, .new]) { [weak self] wv, _ in
            Task { @MainActor in self?.state.isLoading = wv.isLoading }
        })
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        Task { @MainActor in state.loadError = nil }
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        Task { @MainActor in state.loadError = error.localizedDescription }
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        Task { @MainActor in state.loadError = error.localizedDescription }
    }
}

import SwiftUI
import PhotosUI

#if os(macOS)
import AppKit

/// Creates a Color that matches iOS UIColor system colors with light/dark support.
private func iosColor(light: (CGFloat, CGFloat, CGFloat), dark: (CGFloat, CGFloat, CGFloat)) -> Color {
    Color(nsColor: NSColor(name: nil) { appearance in
        let isDark = appearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
        let c = isDark ? dark : light
        return NSColor(red: c.0 / 255, green: c.1 / 255, blue: c.2 / 255, alpha: 1)
    })
}
// Exact iOS UIColor system gray RGB values
private let grayBubble    = iosColor(light: (229, 229, 234), dark: (44, 44, 46))     // systemGray5
private let grayInput     = iosColor(light: (242, 242, 247), dark: (28, 28, 30))     // systemGray6
private let grayDots      = iosColor(light: (174, 174, 178), dark: (99, 99, 102))    // systemGray2
private let grayDisabled  = iosColor(light: (199, 199, 204), dark: (72, 72, 74))     // systemGray3
private let grayStroke    = iosColor(light: (209, 209, 214), dark: (58, 58, 60))     // systemGray4
private let appBackground = iosColor(light: (255, 255, 255), dark: (0, 0, 0))        // systemBackground
#else
import UIKit
private let grayBubble = Color(UIColor.systemGray5)
private let grayInput = Color(UIColor.systemGray6)
private let grayDots = Color(UIColor.systemGray2)
private let grayDisabled = Color(UIColor.systemGray3)
private let grayStroke = Color(UIColor.systemGray4)
private let appBackground = Color(UIColor.systemBackground)
#endif

/// Copy a string to the system pasteboard (UIKit/AppKit bridge).
private func copyToPasteboard(_ string: String) {
    #if os(macOS)
    NSPasteboard.general.clearContents()
    NSPasteboard.general.setString(string, forType: .string)
    #else
    UIPasteboard.general.string = string
    #endif
}

struct ContentView: View {
    var onSignOut: () -> Void = {}

    @StateObject private var viewModel = ChatViewModel()
    @Environment(\.scenePhase) private var scenePhase
    #if os(iOS)
    @Environment(\.verticalSizeClass) private var verticalSizeClass
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    #endif
    @State private var showAttachMenu = false
    @State private var selectedPhoto: PhotosPickerItem?
    @State private var showPhotoPicker = false
    @State private var showFilePicker = false
    @FocusState private var isInputFocused: Bool
    @State private var inputActive = false
    @State private var pendingScrollId: UUID?
    @State private var activeReactionMessageId: UUID?
    @State private var scrollToBottomTick: Int = 0
    @State private var inputText: String = ChatViewModel.loadDraft()
    @State private var confirmSignOut = false
    @State private var memoryMode = false
    @StateObject private var memoryState = WebViewState()

    /// Wiki HTTP browser served from the Mac mini (Tailscale / home LAN).
    /// Centralized here so it can be tweaked without touching MemoryView.
    private static let memoryWikiURL = URL(string: "http://${MERLIN_HOST}:9096")!

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                offlineBanner
                if memoryMode {
                    MemoryView(url: Self.memoryWikiURL, state: memoryState)
                } else {
                    chatMessages
                    typingIndicator
                    inputBar
                }
            }
            .animation(.easeInOut(duration: 0.25), value: viewModel.isOffline)
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar { topBarItems }
            .confirmationDialog("Sign out of Merlin?",
                                isPresented: $confirmSignOut,
                                titleVisibility: .visible) {
                Button("Sign Out", role: .destructive) { onSignOut() }
                Button("Cancel", role: .cancel) { }
            }
        }
        .task {
            await viewModel.loadMessages()
            viewModel.startCatchUpTimer()
        }
        .task {
            await viewModel.subscribeToNewMessages()
        }
        .task {
            await viewModel.subscribeToCommands()
        }
        #if os(macOS)
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in
            Task {
                await viewModel.loadMessages()
            }
            viewModel.reconnectIfNeeded()
            viewModel.startCatchUpTimer()
        }
        #endif
        .onChange(of: scenePhase) { _, newPhase in
            if newPhase == .active {
                Task { await viewModel.loadMessages() }
                viewModel.reconnectIfNeeded()
                viewModel.startCatchUpTimer()
            } else {
                viewModel.stopCatchUpTimer()
                ChatViewModel.saveDraft(inputText) // persist on background
            }
        }
        #if os(iOS)
        // Rotation / size-class changes invalidate the LazyVStack's realized
        // cells, and `defaultScrollAnchor(.bottom)` doesn't re-resolve — the
        // viewport ends up blank until the user scrolls. Nudging the tick
        // triggers a `scrollTo(last, .bottom)` which forces re-realization.
        .onChange(of: verticalSizeClass) { _, _ in
            scrollToBottomTick &+= 1
        }
        .onChange(of: horizontalSizeClass) { _, _ in
            scrollToBottomTick &+= 1
        }
        #endif
        .alert("Error", isPresented: .init(
            get: { viewModel.error != nil },
            set: { if !$0 { viewModel.error = nil } }
        )) {
            Button("OK") { viewModel.error = nil }
        } message: {
            Text(viewModel.error ?? "")
        }
    }

    // MARK: - Top Bar

    @ToolbarContentBuilder
    private var topBarItems: some ToolbarContent {
        #if os(iOS)
        if memoryMode {
            ToolbarItemGroup(placement: .topBarLeading) {
                Button { memoryState.goBack() } label: {
                    Image(systemName: "chevron.backward")
                }
                .disabled(!memoryState.canGoBack)
                Button { memoryState.goForward() } label: {
                    Image(systemName: "chevron.forward")
                }
                .disabled(!memoryState.canGoForward)
            }
        }
        ToolbarItem(placement: .principal) {
            channelTitleLabel
        }
        ToolbarItem(placement: .topBarTrailing) {
            HStack(spacing: 12) {
                if memoryMode {
                    Button { memoryState.reload() } label: {
                        Image(systemName: "arrow.clockwise")
                    }
                }
                channelMenu
            }
        }
        #else
        // macOS: ToolbarItemGroup keeps both the title and the menu inside the
        // window-titlebar toolbar (no separate principal placement exists).
        ToolbarItemGroup {
            channelTitleLabel
            Spacer()
            if memoryMode {
                Button { memoryState.goBack() } label: {
                    Image(systemName: "chevron.backward")
                }
                .disabled(!memoryState.canGoBack)
                Button { memoryState.goForward() } label: {
                    Image(systemName: "chevron.forward")
                }
                .disabled(!memoryState.canGoForward)
                Button { memoryState.reload() } label: {
                    Image(systemName: "arrow.clockwise")
                }
            }
            channelMenu
        }
        #endif
    }

    private var channelTitleLabel: some View {
        HStack(spacing: 6) {
            Image(systemName: memoryMode ? "book.closed" : viewModel.currentChannel.symbol)
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(.secondary)
            Text(memoryMode ? "Memory" : viewModel.currentChannel.displayName)
                .font(.headline)
        }
    }

    private var channelMenu: some View {
        Menu {
            Section("Channel") {
                ForEach(ChatChannel.allCases) { ch in
                    Button {
                        memoryMode = false
                        viewModel.switchChannel(to: ch)
                    } label: {
                        if !memoryMode && ch == viewModel.currentChannel {
                            Label(ch.displayName, systemImage: "checkmark")
                        } else {
                            Label(ch.displayName, systemImage: ch.symbol)
                        }
                    }
                }
            }
            Divider()
            Button {
                memoryMode = true
            } label: {
                if memoryMode {
                    Label("Memory", systemImage: "checkmark")
                } else {
                    Label("Memory", systemImage: "book.closed")
                }
            }
            Divider()
            Button(role: .destructive) {
                confirmSignOut = true
            } label: {
                Label("Sign Out", systemImage: "rectangle.portrait.and.arrow.right")
            }
        } label: {
            Image(systemName: "line.3.horizontal")
                .font(.system(size: 17, weight: .semibold))
        }
    }

    // MARK: - Offline Banner

    @ViewBuilder
    private var offlineBanner: some View {
        if viewModel.isOffline {
            HStack(spacing: 6) {
                ProgressView()
                    .controlSize(.mini)
                Text("Reconnecting…")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 4)
            .background(grayInput)
            .transition(.move(edge: .top).combined(with: .opacity))
        }
    }

    // MARK: - Chat Messages

    @ViewBuilder
    private var loadOlderButton: some View {
        if viewModel.hasOlderMessages {
            Button {
                Task { await viewModel.loadOlderMessages() }
            } label: {
                if viewModel.isLoadingOlder {
                    ProgressView()
                        .padding(.vertical, 8)
                } else {
                    Text("Load older messages")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .padding(.vertical, 8)
                }
            }
            .buttonStyle(.plain)
        }
    }

    @ViewBuilder
    private var messagesList: some View {
        // LazyVStack on iOS avoids a scene-update watchdog kill on fast scroll
        // (Markdown rendering hundreds of bubbles eagerly pegs the main thread).
        // But LazyVStack breaks `defaultScrollAnchor(.bottom)` and `scrollTo` on
        // macOS — off-screen items aren't realized, so the view lands at the
        // top and the latest messages appear to be missing. macOS doesn't have
        // the same watchdog, so a plain VStack is safe there.
        #if os(macOS)
        VStack(spacing: 8) { messagesListContent }
            .padding(.horizontal, 12)
            .padding(.top, 8)
            .padding(.bottom, 40)
        #else
        LazyVStack(spacing: 8) { messagesListContent }
            .padding(.horizontal, 12)
            .padding(.top, 8)
            .padding(.bottom, 40)
        #endif
    }

    @ViewBuilder
    private var messagesListContent: some View {
        loadOlderButton
        ForEach(viewModel.messages) { message in
            MessageBubble(
                message: message,
                viewModel: viewModel,
                activeReactionMessageId: $activeReactionMessageId
            )
            .id(message.id)
            .zIndex(activeReactionMessageId == message.id ? 1 : 0)
        }
    }

    private var chatMessages: some View {
        ScrollViewReader { proxy in
            ScrollView { messagesList }
            #if os(iOS)
            .scrollDismissesKeyboard(.interactively)
            .onTapGesture {
                if activeReactionMessageId != nil {
                    withAnimation(.easeOut(duration: 0.15)) {
                        activeReactionMessageId = nil
                    }
                } else {
                    isInputFocused = false
                }
            }
            #endif
            .defaultScrollAnchor(.bottom)
            .onChange(of: activeReactionMessageId) { _, newValue in
                guard let target = newValue else { return }
                withAnimation(.easeOut(duration: 0.2)) {
                    // Anchor slightly below top so the palette (above the bubble) stays visible.
                    proxy.scrollTo(target, anchor: UnitPoint(x: 0.5, y: 0.25))
                }
            }
            .onChange(of: viewModel.messages.count) { oldCount, newCount in
                // If a push notification target is pending and now loaded, jump to it
                if let target = pendingScrollId,
                   viewModel.messages.contains(where: { $0.id == target }) {
                    withAnimation(.easeOut(duration: 0.3)) {
                        proxy.scrollTo(target, anchor: .center)
                    }
                    pendingScrollId = nil
                    return
                }
                // First non-empty population (fresh-install network load,
                // post-empty channel switch) — defaultScrollAnchor(.bottom)
                // doesn't re-resolve once the LazyVStack has measured an
                // empty layout, so explicitly jump to the latest message.
                if oldCount == 0, newCount > 0, let last = viewModel.messages.last {
                    proxy.scrollTo(last.id, anchor: .bottom)
                    return
                }
                guard oldCount > 0, newCount > oldCount else { return }
                if let lastMessage = viewModel.messages.last {
                    withAnimation(.easeOut(duration: 0.3)) {
                        proxy.scrollTo(lastMessage.id, anchor: .bottom)
                    }
                }
            }
            .onChange(of: viewModel.currentChannel) { _, _ in
                // Channel switch replaces `messages` from cache — the
                // ScrollView keeps its prior offset, so latest can be
                // off-screen. Force a snap to bottom.
                scrollToBottomTick &+= 1
            }
            .onAppear {
                // Consume any message ID stashed while the app was launching / locked
                if let pending = AppDelegate.pendingMessageId {
                    pendingScrollId = pending
                    AppDelegate.pendingMessageId = nil
                    if viewModel.messages.contains(where: { $0.id == pending }) {
                        proxy.scrollTo(pending, anchor: .center)
                        pendingScrollId = nil
                    }
                    return
                }
                // LazyVStack + defaultScrollAnchor(.bottom) is unreliable on
                // first appearance — the viewport often lands above the
                // realized cells, leaving the user looking at empty space
                // with the actual messages off-screen below. Snap to bottom
                // once cells have had a tick to realize.
                if let last = viewModel.messages.last {
                    DispatchQueue.main.async {
                        proxy.scrollTo(last.id, anchor: .bottom)
                    }
                }
            }
            .onReceive(NotificationCenter.default.publisher(for: .openMerlinMessage)) { note in
                guard let uuid = note.object as? UUID else { return }
                if viewModel.messages.contains(where: { $0.id == uuid }) {
                    withAnimation(.easeOut(duration: 0.3)) {
                        proxy.scrollTo(uuid, anchor: .center)
                    }
                } else {
                    pendingScrollId = uuid
                }
            }
            .onChange(of: scrollToBottomTick) { _, _ in
                guard let last = viewModel.messages.last else { return }
                withAnimation(.easeOut(duration: 0.3)) {
                    proxy.scrollTo(last.id, anchor: .bottom)
                }
            }
        }
    }

    // MARK: - Typing Indicator

    @ViewBuilder
    private var typingIndicator: some View {
        if viewModel.isWaitingForResponse {
            HStack {
                TypingDots()
                    .padding(.horizontal, 16)
                    .padding(.vertical, 8)
                    .background(grayBubble)
                    .clipShape(RoundedRectangle(cornerRadius: 16))
                Spacer()
            }
            .padding(.horizontal, 12)
            .padding(.bottom, 4)
            .transition(.opacity.combined(with: .move(edge: .bottom)))
        }
    }

    // MARK: - Input Bar

    private var inputBar: some View {
        HStack(alignment: .bottom, spacing: 8) {
            Menu {
                Button {
                    showPhotoPicker = true
                } label: {
                    Label("Photos", systemImage: "photo")
                }
                Button {
                    showFilePicker = true
                } label: {
                    Label("Files", systemImage: "doc")
                }
            } label: {
                Image(systemName: "plus")
                    .font(.system(size: 17, weight: .bold))
                    .foregroundStyle(.secondary)
            }
            .menuIndicator(.hidden)
            .fixedSize()
            #if os(macOS)
            .menuStyle(.borderlessButton)
            #endif
            .frame(width: 36, height: 36)
            .background(inputActive ? appBackground : grayInput)
            .clipShape(Circle())
            .overlay(
                Circle()
                    .stroke(grayStroke, lineWidth: inputActive ? 0.5 : 0)
            )
            .animation(.easeInOut(duration: 0.2), value: inputActive)

            Group {
                #if os(macOS)
                MacMessageField(
                    text: $inputText,
                    placeholder: "Message...",
                    isFocused: $inputActive,
                    onSend: {
                        let textToSend = inputText
                        inputText = ""
                        Task { await viewModel.sendMessage(textToSend) }
                    }
                )
                #else
                TextField("Message...", text: $inputText, axis: .vertical)
                    .lineLimit(1...5)
                    .focused($isInputFocused)
                    .submitLabel(.send)
                    .onSubmit {
                        let textToSend = inputText
                        inputText = ""
                        Task { await viewModel.sendMessage(textToSend) }
                    }
                #endif
            }
                .padding(.horizontal, 14)
                .padding(.vertical, 8)
                .background(inputActive ? appBackground : grayInput)
                .clipShape(RoundedRectangle(cornerRadius: 20))
                .overlay(
                    RoundedRectangle(cornerRadius: 20)
                        .stroke(grayStroke, lineWidth: inputActive ? 0.5 : 0)
                )
                .animation(.easeInOut(duration: 0.2), value: inputActive)

            #if !os(macOS)
            Button {
                let textToSend = inputText
                inputText = ""
                Task { await viewModel.sendMessage(textToSend) }
            } label: {
                Image(systemName: "arrow.up.circle.fill")
                    .font(.system(size: 32))
                    .foregroundStyle(
                        inputText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                            ? grayDisabled
                            : .blue
                    )
            }
            .disabled(inputText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            #endif
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(inputActive ? grayInput : appBackground)
        .animation(.easeInOut(duration: 0.2), value: inputActive)
        // Double-tap the input bar area to jump to the latest message —
        // useful when scrolled up and the user wants back to "now".
        // Attach with higher priority on the background so it doesn't
        // swallow text-field interactions.
        .simultaneousGesture(
            TapGesture(count: 2).onEnded {
                scrollToBottomTick &+= 1
            }
        )
        #if !os(macOS)
        .onChange(of: isInputFocused) { _, focused in
            inputActive = focused
        }
        #endif
        .photosPicker(isPresented: $showPhotoPicker, selection: $selectedPhoto, matching: .images)
        .onChange(of: selectedPhoto) { _, newItem in
            guard let newItem else { return }
            Task {
                if let data = try? await newItem.loadTransferable(type: Data.self) {
                    await viewModel.sendAttachment(data: data, filename: "photo.jpg", contentType: "image/jpeg")
                }
                selectedPhoto = nil
            }
        }
        .fileImporter(isPresented: $showFilePicker, allowedContentTypes: [.item], allowsMultipleSelection: false) { result in
            guard case .success(let urls) = result, let url = urls.first else { return }
            guard url.startAccessingSecurityScopedResource() else { return }
            defer { url.stopAccessingSecurityScopedResource() }
            guard let data = try? Data(contentsOf: url) else { return }
            let filename = url.lastPathComponent
            let ext = url.pathExtension.lowercased()
            let contentType: String
            switch ext {
            case "jpg", "jpeg": contentType = "image/jpeg"
            case "png": contentType = "image/png"
            case "gif": contentType = "image/gif"
            case "pdf": contentType = "application/pdf"
            case "mp4", "mov": contentType = "video/mp4"
            default: contentType = "application/octet-stream"
            }
            Task {
                await viewModel.sendAttachment(data: data, filename: filename, contentType: contentType)
            }
        }
    }
}

// MARK: - Message Bubble

struct MessageBubble: View {
    let message: Message
    @ObservedObject var viewModel: ChatViewModel
    @Binding var activeReactionMessageId: UUID?

    private var isImageURL: Bool {
        let c = message.content
        return c.contains("merlin-attachments") &&
            (c.hasSuffix(".jpg") || c.hasSuffix(".jpeg") || c.hasSuffix(".png") || c.hasSuffix(".gif"))
    }

    private var bubbleMaxWidth: CGFloat { .infinity }
    private var isPaletteOpen: Bool { activeReactionMessageId == message.id }

    private func openPalette() {
        #if os(iOS)
        let generator = UIImpactFeedbackGenerator(style: .medium)
        generator.impactOccurred()
        #endif
        withAnimation(.spring(response: 0.28, dampingFraction: 0.75)) {
            activeReactionMessageId = message.id
        }
    }

    private func apply(_ reaction: Reaction) {
        let target = message
        withAnimation(.easeOut(duration: 0.15)) {
            activeReactionMessageId = nil
        }
        Task { await viewModel.setReaction(for: target, to: reaction) }
    }

    var body: some View {
        HStack {
            if message.isUser { Spacer(minLength: 48) }

            VStack(alignment: message.isUser ? .trailing : .leading, spacing: 2) {
                bubbleContent

                Text(message.createdAt, style: .time)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 6)
            }

            if message.isAssistant { Spacer(minLength: 48) }
        }
    }

    @ViewBuilder
    private var bubbleContent: some View {
        if isImageURL, let url = URL(string: message.content) {
            AsyncImage(url: url) { phase in
                switch phase {
                case .success(let image):
                    image
                        .resizable()
                        .scaledToFill()
                        .frame(maxWidth: 220, maxHeight: 280)
                        .clipShape(RoundedRectangle(cornerRadius: 18))
                case .failure:
                    Text("Failed to load image")
                        .padding(.horizontal, 14)
                        .padding(.vertical, 9)
                        .background(message.isUser ? Color.blue : grayBubble)
                        .foregroundStyle(message.isUser ? .white : .primary)
                        .clipShape(RoundedRectangle(cornerRadius: 18))
                default:
                    ProgressView()
                        .frame(width: 120, height: 120)
                }
            }
        } else if message.isAssistant {
            RichMessageView(content: message.content)
                .padding(.horizontal, 14)
                .padding(.vertical, 9)
                .frame(maxWidth: bubbleMaxWidth, alignment: .leading)
                .background(grayBubble)
                .clipShape(RoundedRectangle(cornerRadius: 18))
                .scaleEffect(isPaletteOpen ? 1.02 : 1.0)
                .animation(.spring(response: 0.28, dampingFraction: 0.75), value: isPaletteOpen)
                .overlay(alignment: .topTrailing) {
                    if let reaction = message.reaction {
                        ReactionBadge(reaction: reaction)
                            .offset(x: 6, y: -6)
                            .transition(.scale.combined(with: .opacity))
                    }
                }
                .overlay(alignment: .topLeading) {
                    if isPaletteOpen {
                        ReactionPalette(
                            selected: message.reaction,
                            onSelect: apply
                        )
                        .offset(y: -52)
                        .transition(.scale(scale: 0.6, anchor: .bottomLeading).combined(with: .opacity))
                    }
                }
                #if os(iOS)
                .onLongPressGesture(minimumDuration: 0.35) {
                    openPalette()
                }
                #endif
                .contextMenu {
                    ForEach(Reaction.allCases, id: \.self) { reaction in
                        Button {
                            Task { await viewModel.setReaction(for: message, to: reaction) }
                        } label: {
                            if message.reaction == reaction {
                                Label("\(reaction.emoji) \(reaction.label)", systemImage: "checkmark")
                            } else {
                                Text("\(reaction.emoji) \(reaction.label)")
                            }
                        }
                    }
                    Divider()
                    Button {
                        copyToPasteboard(message.content)
                    } label: {
                        Label("Copy", systemImage: "doc.on.doc")
                    }
                }
        } else {
            Text(message.content)
                #if os(macOS)
                .font(.system(size: 16))
                #else
                .font(.body)
                #endif
                .textSelection(.enabled)
                .padding(.horizontal, 14)
                .padding(.vertical, 9)
                .frame(maxWidth: bubbleMaxWidth, alignment: .leading)
                .background(Color.blue)
                .foregroundStyle(.white)
                .clipShape(RoundedRectangle(cornerRadius: 18))
                .contextMenu {
                    Button {
                        copyToPasteboard(message.content)
                    } label: {
                        Label("Copy", systemImage: "doc.on.doc")
                    }
                }
        }
    }
}

// MARK: - Reaction Palette

private struct ReactionPalette: View {
    let selected: Reaction?
    let onSelect: (Reaction) -> Void

    var body: some View {
        HStack(spacing: 6) {
            ForEach(Reaction.allCases, id: \.self) { reaction in
                Button {
                    onSelect(reaction)
                } label: {
                    Text(reaction.emoji)
                        .font(.system(size: 26))
                        .frame(width: 40, height: 40)
                        .background(
                            Circle()
                                .fill(selected == reaction ? Color.blue.opacity(0.18) : Color.clear)
                        )
                        .overlay(
                            Circle()
                                .stroke(selected == reaction ? Color.blue : Color.clear, lineWidth: 1.5)
                        )
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 6)
        .background(
            Capsule()
                .fill(.ultraThinMaterial)
        )
        .overlay(
            Capsule()
                .stroke(grayStroke, lineWidth: 0.5)
        )
        .shadow(color: Color.black.opacity(0.18), radius: 10, x: 0, y: 4)
    }
}

// MARK: - Reaction Badge

private struct ReactionBadge: View {
    let reaction: Reaction

    var body: some View {
        Text(reaction.emoji)
            .font(.system(size: 14))
            .padding(6)
            .background(
                Circle().fill(grayBubble)
            )
            .overlay(
                Circle().stroke(appBackground, lineWidth: 2)
            )
            .shadow(color: Color.black.opacity(0.08), radius: 2, x: 0, y: 1)
    }
}

// MARK: - Typing Dots Animation

struct TypingDots: View {
    @State private var phase = 0
    @State private var timer: Timer?

    var body: some View {
        HStack(spacing: 4) {
            ForEach(0..<3) { index in
                Circle()
                    .fill(grayDots)
                    .frame(width: 7, height: 7)
                    .offset(y: phase == index ? -4 : 0)
            }
        }
        .onAppear {
            // Invalidate any prior timer first — a new .onAppear without a
            // matching .onDisappear (e.g., view churn during scroll) would
            // otherwise leak repeating timers that fire forever, each holding
            // the @State storage and queuing animation transactions.
            timer?.invalidate()
            timer = Timer.scheduledTimer(withTimeInterval: 0.15, repeats: true) { _ in
                withAnimation(.easeInOut(duration: 0.4)) {
                    phase = (phase + 1) % 3
                }
            }
        }
        .onDisappear {
            timer?.invalidate()
            timer = nil
        }
    }
}

#if os(macOS)

/// Native macOS input field: NSTextView that sends on Return, inserts a
/// newline on Option+Return, and grows from 1 up to 5 lines with a
/// placeholder overlay handled in SwiftUI.
private struct MacMessageField: View {
    @Binding var text: String
    var placeholder: String
    @Binding var isFocused: Bool
    var onSend: () -> Void
    @State private var textHeight: CGFloat = 20

    var body: some View {
        ZStack(alignment: .topLeading) {
            if text.isEmpty {
                Text(placeholder)
                    .font(.system(size: 16))
                    .foregroundStyle(Color(NSColor.placeholderTextColor))
                    .allowsHitTesting(false)
                    .padding(.top, 1)
            }
            MacTextViewRepresentable(
                text: $text,
                isFocused: $isFocused,
                onSend: onSend,
                desiredHeight: $textHeight
            )
            .frame(height: textHeight)
        }
    }
}

/// NSTextView subclass that intercepts Return at the keyDown level (more
/// reliable than doCommandBy: for detecting Option/Shift modifiers). Plain
/// Return calls `onSend`; Option+Return and Shift+Return insert a newline.
private final class MacSendTextView: NSTextView {
    var onSend: (() -> Void)?

    override func keyDown(with event: NSEvent) {
        // keyCode 36 = Return, 76 = Enter (numeric keypad)
        if event.keyCode == 36 || event.keyCode == 76 {
            let mods = event.modifierFlags
            if mods.contains(.option) || mods.contains(.shift) || mods.contains(.command) {
                insertNewline(nil)  // insert newline
            } else {
                onSend?()
            }
            return
        }
        super.keyDown(with: event)
    }
}

private struct MacTextViewRepresentable: NSViewRepresentable {
    @Binding var text: String
    @Binding var isFocused: Bool
    var onSend: () -> Void
    @Binding var desiredHeight: CGFloat

    private static let maxLines: CGFloat = 5

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeNSView(context: Context) -> NSScrollView {
        let scrollView = NSScrollView()
        scrollView.drawsBackground = false
        scrollView.hasVerticalScroller = false
        scrollView.hasHorizontalScroller = false
        scrollView.borderType = .noBorder

        let textView = MacSendTextView()
        textView.delegate = context.coordinator
        textView.isEditable = true
        textView.isSelectable = true
        textView.allowsUndo = true
        textView.isRichText = false
        textView.font = NSFont.systemFont(ofSize: 16)
        textView.drawsBackground = false
        textView.backgroundColor = .clear
        textView.textContainerInset = NSSize(width: 0, height: 0)
        textView.textContainer?.lineFragmentPadding = 0
        textView.minSize = NSSize(width: 0, height: 0)
        textView.maxSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
        textView.isVerticallyResizable = true
        textView.isHorizontallyResizable = false
        textView.autoresizingMask = [.width]
        textView.textContainer?.containerSize = NSSize(width: 0, height: CGFloat.greatestFiniteMagnitude)
        textView.textContainer?.widthTracksTextView = true
        textView.onSend = { [weak coordinator = context.coordinator] in
            coordinator?.parent.onSend()
        }

        scrollView.documentView = textView
        context.coordinator.textView = textView

        // Compute initial single-line height.
        if let font = textView.font, let lm = textView.layoutManager {
            let lineH = lm.defaultLineHeight(for: font)
            DispatchQueue.main.async { self.desiredHeight = ceil(lineH) }
        }

        return scrollView
    }

    func updateNSView(_ scrollView: NSScrollView, context: Context) {
        guard let textView = scrollView.documentView as? MacSendTextView else { return }
        context.coordinator.parent = self

        if textView.string != text {
            textView.string = text
            if text.isEmpty {
                // Reset to single-line height immediately — layout manager
                // hasn't re-laid out yet so recalcHeight would keep the old size.
                if let font = textView.font, let lm = textView.layoutManager {
                    let lineH = ceil(lm.defaultLineHeight(for: font))
                    if abs(desiredHeight - lineH) > 0.5 {
                        DispatchQueue.main.async { self.desiredHeight = lineH }
                    }
                }
            } else {
                context.coordinator.recalcHeight()
            }
        }

        if isFocused,
           textView.window != nil,
           textView.window?.firstResponder !== textView {
            DispatchQueue.main.async {
                textView.window?.makeFirstResponder(textView)
            }
        }
    }

    final class Coordinator: NSObject, NSTextViewDelegate {
        var parent: MacTextViewRepresentable
        weak var textView: MacSendTextView?

        init(_ parent: MacTextViewRepresentable) {
            self.parent = parent
        }

        func recalcHeight() {
            guard let tv = textView,
                  let lm = tv.layoutManager,
                  let container = tv.textContainer,
                  let font = tv.font else { return }
            lm.ensureLayout(for: container)
            let usedHeight = lm.usedRect(for: container).height
            let lineHeight = lm.defaultLineHeight(for: font)
            let maxHeight = ceil(lineHeight * MacTextViewRepresentable.maxLines)
            let newHeight = min(max(ceil(usedHeight), ceil(lineHeight)), maxHeight)
            if abs(newHeight - parent.desiredHeight) > 0.5 {
                parent.desiredHeight = newHeight
            }
        }

        func textDidChange(_ notification: Notification) {
            guard let tv = notification.object as? NSTextView else { return }
            parent.text = tv.string
            recalcHeight()
        }

        func textDidBeginEditing(_ notification: Notification) {
            if !parent.isFocused {
                parent.isFocused = true
            }
        }

        func textDidEndEditing(_ notification: Notification) {
            if parent.isFocused {
                parent.isFocused = false
            }
        }
    }
}

#endif

#Preview {
    ContentView()
}

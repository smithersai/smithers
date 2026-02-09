import SwiftUI
import Combine
import AppKit
import Foundation
import UniformTypeIdentifiers
import WebKit

struct FileIndexEntry: Identifiable, Hashable, Sendable {
    let id: URL
    let url: URL
    let displayPath: String
    let lowercasedPath: String
    let fileName: String
    let lowercasedName: String
    let pathDepth: Int
    let fileExtension: String
    let fileNameStartIndex: Int

    init(url: URL, displayPath: String) {
        self.id = url
        self.url = url
        self.displayPath = displayPath
        let lowercasedPath = displayPath.lowercased()
        self.lowercasedPath = lowercasedPath
        let components = displayPath.split(separator: "/")
        let name = components.last.map(String.init) ?? displayPath
        self.fileName = name
        self.lowercasedName = name.lowercased()
        self.pathDepth = max(0, components.count - 1)
        self.fileExtension = url.pathExtension.lowercased()
        self.fileNameStartIndex = max(0, lowercasedPath.count - self.lowercasedName.count)
    }
}

struct PaletteCommand: Identifiable {
    let id: String
    let title: String
    let icon: String
    let shortcut: String?
    let action: @MainActor () -> Void
}

struct RecentFolderEntry: Identifiable, Hashable {
    let id: URL
    let url: URL
    let displayPath: String
}

struct RecentEditEntry: Identifiable, Hashable {
    let id: URL
    let url: URL
    let displayPath: String
    let lastEdited: Date
}

struct SearchMatch: Identifiable, Hashable, Sendable {
    let id = UUID()
    let lineNumber: Int
    let column: Int
    let matchLength: Int
    let lineText: String
}

struct SearchResult: Identifiable, Hashable, Sendable {
    let id = UUID()
    let url: URL
    let displayPath: String
    var matches: [SearchMatch]
}

struct SearchPreviewLine: Identifiable, Hashable, Sendable {
    var id: Int { number }
    let number: Int
    let text: String
    let isMatch: Bool
}

struct SearchPreview: Hashable, Sendable {
    let url: URL
    let displayPath: String
    let matchLine: Int
    let lines: [SearchPreviewLine]
    let isTruncated: Bool
}

struct EditorSelection: Hashable, Sendable {
    let url: URL
    let line: Int
    let column: Int
    let length: Int
}

final class ObserverToken {
    private let cancel: () -> Void
    private var isActive = true

    init(cancel: @escaping () -> Void) {
        self.cancel = cancel
    }

    func invalidate() {
        guard isActive else { return }
        isActive = false
        cancel()
    }

    deinit {
        invalidate()
    }
}

private enum SearchOutcome {
    case success([SearchResult])
    case failure(String)
}

struct DiffTab: Identifiable, Hashable {
    let id: URL
    let title: String
    let summary: String
    let diff: String
}

struct WebviewTab: Identifiable, Hashable {
    let id: URL
    var title: String
    var url: URL
}

enum OverlayType: String, Codable {
    case chat
    case progress
    case panel
}

enum OverlayPosition: String, Codable {
    case bottom
    case center
    case top
}

struct OverlayContent: Identifiable {
    let id: String
    let type: OverlayType
    let message: String
    let title: String?
    let position: OverlayPosition
    var progress: Double?
    var dismissAfter: TimeInterval?
}

enum NvimFailureKind: String {
    case startup
    case crash
}

struct NvimFailure: Identifiable, Equatable {
    let id = UUID()
    let kind: NvimFailureKind
    let message: String
    let detail: String?
    let timestamp: Date
    let reportURL: URL?
    let logURL: URL?
}

@MainActor
class WorkspaceState: ObservableObject {
    enum NvimModeError: Error, LocalizedError {
        case missingWorkspace
        case recoveryRequired
        case startupExited

        var errorDescription: String? {
            switch self {
            case .missingWorkspace:
                return "Open a folder before enabling Neovim mode."
            case .recoveryRequired:
                return "Restart Neovim to continue."
            case .startupExited:
                return "Neovim exited during startup."
            }
        }
    }

    private enum CloseContext {
        case tab(URL)
        case window
        case application
        case workspace
    }

    struct JJRevertActionInfo {
        let snapshot: Snapshot
        let isLatest: Bool
    }

    private enum CloseDecision {
        case deny
        case allow(force: Bool)
    }

    private enum SessionItemKind: String, Codable {
        case file
        case terminal
        case chat
    }

    private struct SessionItem: Codable {
        let kind: SessionItemKind
        let path: String?
        let workingDirectory: String?
        let chatId: String?
    }

    private struct SessionState: Codable {
        let rootPath: String
        let openItems: [SessionItem]
        let selectedIndex: Int?
        var isShortcutsPanelVisible: Bool?
        var lastAccessed: Date?
    }

    @Published var rootDirectory: URL?
    @Published var fileTree: [FileItem] = []
    @Published var openFiles: [URL] = [] {
        didSet {
            persistSessionStateIfNeeded()
            notifyOpenFileObservers(oldValue: oldValue, newValue: openFiles)
        }
    }
    @Published var selectedFileURL: URL? {
        didSet {
            updateWindowTitle()
            persistSessionStateIfNeeded()
        }
    }
    @Published var terminalViews: [URL: GhosttyTerminalView] = [:]
    @Published private(set) var nvimTerminalView: GhosttyTerminalView?
    @Published private(set) var nvimCurrentFilePath: String? {
        didSet {
            updateWindowTitle()
        }
    }
    @Published private(set) var nvimViewport: NvimViewport?
    @Published private(set) var nvimModifiedBuffers: [NvimModifiedBuffer] = [] {
        didSet {
            updateWindowTitle()
        }
    }
    @Published private(set) var nvimFloatingWindows: [NvimFloatingWindow] = []
    @Published private(set) var nvimGridMetrics: GhosttyGridMetrics?
    @Published private(set) var nvimCmdlineState: NvimCmdlineState = .empty
    @Published private(set) var nvimPopupMenuState: NvimPopupMenuState = .empty
    @Published private(set) var nvimMessages: [NvimMessage] = []
    @Published private(set) var nvimMiniMessageState: NvimMiniMessageState = .empty
    @Published var nvimMessageRoutes: [NvimMessageRoute] = NvimMessageRoute.defaultRoutes
    @Published private(set) var nvimFailure: NvimFailure?
    @Published var editorText: String = """
    func hello() {
        print("Hello, Smithers!")
    }

    hello()
    """
    {
        didSet {
            guard !suppressEditorTextUpdate else { return }
            guard let selectedFileURL,
                  !isChatURL(selectedFileURL),
                  !isTerminalURL(selectedFileURL)
            else { return }
            if isNonUTF8File(selectedFileURL) {
                if editorText != Self.nonUTF8Placeholder {
                    setEditorText(Self.nonUTF8Placeholder)
                }
                clearNativeDirty(selectedFileURL)
                return
            }
            let canonicalURL = canonicalFileURL(selectedFileURL)
            let wasModified = isNativeFileModified(canonicalURL)
            openFileContents[canonicalURL] = editorText
            markNativeDirty(canonicalURL)
            let nowModified = isNativeFileModified(canonicalURL)
            if wasModified != nowModified {
                updateWindowTitle()
            }
            scheduleAutoSaveIfNeeded(for: canonicalURL)
            updateRecentEdit(for: canonicalURL)
        }
    }
    @Published var currentLanguage: SupportedLanguage?
    @Published var isEditorLoading: Bool = false
    @Published var chatMessages: [ChatMessage] = WorkspaceState.initialChatMessages() {
        didSet {
            scheduleChatHistoryPersist()
        }
    }
    @Published var preferences: EditorPreferences = EditorPreferences() {
        didSet {
            configurePreferences()
        }
    }
    @Published var activeDiffPreview: DiffPreview?
    @Published var activeSessionDiff: SessionDiffSnapshot?
    @Published private(set) var sessionDiffSnapshot: SessionDiffSnapshot?
    @Published var diffTabs: [URL: DiffTab] = [:]
    @Published var webviewTabs: [URL: WebviewTab] = [:]
    @Published var activeOverlay: OverlayContent?
    @Published var activeSkillModal: SkillModal?
    @Published var chatDraft: String = ""
    @Published var chatDraftImages: [ChatImage] = []
    @Published var isTurnInProgress: Bool = false
    @Published var activeSkills: [ActiveSkill] = []
    @Published var isCommandPalettePresented: Bool = false
    @Published var isSearchPresented: Bool = false
    @Published var isShortcutsPanelVisible: Bool = false {
        didSet {
            persistSessionStateIfNeeded()
        }
    }
    @Published var sidebarVisibility: NavigationSplitViewVisibility = .doubleColumn

    // MARK: - JJ Version Control
    @Published var jjService: JJService?
    @Published var jjSnapshotStore: JJSnapshotStore?
    @Published var agentOrchestrator: AgentOrchestrator?
    @Published var vcsPreferences: VCSPreferences = VCSPreferences()
    @Published var isJJPanelVisible: Bool = false
    @Published var isAgentDashboardVisible: Bool = false
    @Published var jjModifiedFiles: [JJFileDiff] = []
    @Published var jjChangeLog: [JJChange] = []
    @Published var jjBookmarks: [JJBookmark] = []
    @Published var jjOperations: [JJOperation] = []
    @Published var jjConflicts: [String] = []
    @Published var jjSnapshots: [Snapshot] = []
    @Published var detectedCommitStyle: CommitStyle = .freeform
    private var saveSnapshotDebounceTask: Task<Void, Never>?
    @Published var isNvimModeEnabled: Bool = false {
        didSet {
            inputMethodSwitcher.setActive(isNvimModeEnabled)
        }
    }
    @Published private(set) var nvimMode: NvimModeKind = .normal {
        didSet {
            inputMethodSwitcher.setMode(nvimMode)
        }
    }
    @Published var cursorLine: Int = 1
    @Published var cursorColumn: Int = 1
    @Published var isCloseWarningEnabled: Bool = {
        if UserDefaults.standard.object(forKey: WorkspaceState.closeWarningEnabledKey) == nil {
            return true
        }
        return UserDefaults.standard.bool(forKey: WorkspaceState.closeWarningEnabledKey)
    }() {
        didSet {
            UserDefaults.standard.set(isCloseWarningEnabled, forKey: Self.closeWarningEnabledKey)
        }
    }
    @Published var isAutoSaveEnabled: Bool = UserDefaults.standard.bool(
        forKey: WorkspaceState.autoSaveEnabledKey
    ) {
        didSet {
            UserDefaults.standard.set(isAutoSaveEnabled, forKey: Self.autoSaveEnabledKey)
            if !isAutoSaveEnabled {
                autoSaveTask?.cancel()
                autoSaveTask = nil
            }
            showToast(isAutoSaveEnabled ? "Auto Save On" : "Auto Save Off")
        }
    }
    @Published var autoSaveInterval: TimeInterval = {
        let value = UserDefaults.standard.double(forKey: WorkspaceState.autoSaveIntervalKey)
        return value > 0 ? value : WorkspaceState.defaultAutoSaveInterval
    }() {
        didSet {
            UserDefaults.standard.set(autoSaveInterval, forKey: Self.autoSaveIntervalKey)
            showToast("Auto Save Interval: \(Self.formatInterval(autoSaveInterval))")
        }
    }
    @Published var updateChannel: UpdateChannel = UpdateChannel.loadFromDefaults() {
        didSet {
            UserDefaults.standard.set(updateChannel.rawValue, forKey: UpdateChannel.userDefaultsKey)
        }
    }
    @Published var fileSearchQuery: String = "" {
        didSet {
            scheduleSearch()
        }
    }
    @Published var searchQuery: String = "" {
        didSet {
            scheduleSearchInFiles()
        }
    }
    @Published private(set) var fileSearchResults: [FileIndexEntry] = []
    @Published private(set) var paletteCommands: [PaletteCommand] = []
    @Published private(set) var skillItems: [SkillItem] = []
    @Published private(set) var skillErrors: [String] = []
    @Published private(set) var searchResults: [SearchResult] = []
    @Published var searchPreview: SearchPreview?
    @Published var isSearchInProgress: Bool = false
    @Published var searchErrorMessage: String?
    @Published private(set) var recentFileEntries: [FileIndexEntry] = []
    @Published private(set) var recentFolderEntries: [RecentFolderEntry] = []
    @Published private(set) var recentEditEntries: [RecentEditEntry] = []
    @Published var toastMessage: String?
    @Published private(set) var progressValue: Double = 0
    @Published private(set) var isProgressBarVisible: Bool = false
    @Published var progressBarHeight: CGFloat = {
        let value = UserDefaults.standard.double(forKey: WorkspaceState.progressBarHeightKey)
        if value > 0 { return WorkspaceState.clampProgressBarHeight(CGFloat(value)) }
        return 3
    }() {
        didSet {
            let clamped = Self.clampProgressBarHeight(progressBarHeight)
            if clamped != progressBarHeight {
                progressBarHeight = clamped
                return
            }
            UserDefaults.standard.set(Double(clamped), forKey: Self.progressBarHeightKey)
        }
    }
    @Published var progressBarFillColor: NSColor? = WorkspaceState.loadProgressColor(key: WorkspaceState.progressBarFillColorKey) {
        didSet {
            Self.storeProgressColor(progressBarFillColor, key: Self.progressBarFillColorKey)
        }
    }
    @Published var progressBarTrackColor: NSColor? = WorkspaceState.loadProgressColor(key: WorkspaceState.progressBarTrackColorKey) {
        didSet {
            Self.storeProgressColor(progressBarTrackColor, key: Self.progressBarTrackColorKey)
        }
    }
    @Published var pendingSelection: EditorSelection?
    private var fileLoadTask: Task<Void, Never>?
    private var fileReadTask: Task<(text: String, isUTF8: Bool), Never>?
    private var fileIndex: [FileIndexEntry] = []
    private var fileIndexTask: Task<Void, Never>?
    private var searchTask: Task<Void, Never>?
    private var searchToken: Int = 0
    private var searchInFilesTask: Task<SearchOutcome, Never>?
    private var searchInFilesToken: Int = 0
    private var searchPreviewTask: Task<Void, Never>?
    private var searchPreviewToken: Int = 0
    private var openFileContents: [URL: String] = [:]
    private var savedFileContents: [URL: String] = [:]
    private var nativeDirtyFiles: Set<URL> = []
    private var suppressEditorTextUpdate = false
    private var suppressSelectionSync = false
    private var closeGuardsBypassed = false
    private var windowHiddenForNvim = false
    private var windowHiddenForLaunch = false
    private var suppressSessionPersistence = false
    private var recentFileURLs: [URL] = []
    private var recentFolderURLs: [URL] = []
    private var recentEditTimestamps: [URL: Date] = [:]
    private var recentEditLocations: [URL: [EditorEditLocation]] = [:]
    private var recentEditRefreshTask: Task<Void, Never>?
    private var fileOpenObservers: [UUID: (URL) -> Void] = [:]
    private var fileCloseObservers: [UUID: (URL) -> Void] = [:]
    private var webviewViews: [URL: WKWebView] = [:]
    private var webviewTitleObservers: [URL: NSKeyValueObservation] = [:]
    private var preferencesCancellable: AnyCancellable?
    private var toastTask: Task<Void, Never>?
    private var toastToken: Int = 0
    private var overlayTask: Task<Void, Never>?
    private var overlayToken: Int = 0
    private var progressHideTask: Task<Void, Never>?
    private var progressHideToken: Int = 0
    private var autoSaveTask: Task<Void, Never>?
    private var autoSaveToken: Int = 0
    private var chatHistoryPersistTask: Task<Void, Never>?
    private var skillRefreshTask: Task<Void, Never>?
    private var skillWatchers: [DirectoryWatcher] = []
    private var nvimSaveTask: Task<Void, Never>?
    private var nvimSettingsSyncTask: Task<Void, Never>?
    private var nvimSettingsSyncToken: Int = 0
    private var nvimMessageExpiryTasks: [UUID: Task<Void, Never>] = [:]
    private var nvimMiniStatusTask: Task<Void, Never>?
    private var sessionPersistTask: Task<Void, Never>?
    private var sessionDiffComputeTask: Task<Void, Never>?
    private var sessionDiffComputeToken: Int = 0
    private var turnDiffs: [String: String] = [:]
    private var turnDiffOrder: [String] = []
    private var streamingTurnDiffs: [String: String] = [:]
    private var diffPreviewIndexByTurnId: [String: Int] = [:]
    private var suppressChatHistoryPersistence = false
    private var chatSessions: [String: ChatSessionState] = [:]
    private var activeChatId: String = WorkspaceState.mainChatId
    private var skillInstructionCache: [String: String] = [:]
    private let skillScanner = SkillScanner()
    private let skillRegistryClient = SkillRegistryClient()
    private let skillInstaller = SkillInstaller()
    private static let chatScheme = "smithers-chat"
    private static let mainChatId = "main"
    private static let chatURL = URL(string: "\(chatScheme)://\(mainChatId)")!
    private static let terminalScheme = "smithers-terminal"
    private static let openFileScheme = "smithers"
    private static let legacyOpenFileScheme = "smithers-open-file"
    private static let diffScheme = "smithers-diff"
    private static let webviewScheme = "smithers-webview"
    private static let lastWorkspaceKey = "smithers.lastWorkspacePath"
    private static let sessionStateKey = "smithers.sessionStateByRoot"
    private static var isRunningTests: Bool {
        let env = ProcessInfo.processInfo.environment
        if env["XCTestConfigurationFilePath"] != nil { return true }
        if env["XCTestSessionIdentifier"] != nil { return true }
        if env["XCTestBundlePath"] != nil { return true }
        return NSClassFromString("XCTestCase") != nil
    }
    private static let recentFilesKey = "smithers.recentFiles"
    private static let recentFoldersKey = "smithers.recentFolders"
    private static let maxRecentItems = 10
    private static let maxRecentEdits = 10
    nonisolated private static let maxSearchMatches = 1000
    nonisolated private static let maxPreviewBytes = 200_000
    nonisolated private static let previewContextLines = 2
    private static let maxSessionEntries = 20
    private static let closeWarningEnabledKey = "smithers.closeWarningsEnabled"
    private static let autoSaveEnabledKey = "smithers.autoSaveEnabled"
    private static let autoSaveIntervalKey = "smithers.autoSaveInterval"
    private static let defaultAutoSaveInterval: TimeInterval = 5
    static let progressBarHeightRange: ClosedRange<CGFloat> = 1...8
    private static let progressBarAutoHideDelay: TimeInterval = 0.45
    private static let nvimMessageMaxCount = 6
    private static let nvimDefaultMessageTimeout: TimeInterval = 4
    private static let nvimDefaultMiniTimeout: TimeInterval = 2
    private static let progressBarHeightKey = "smithers.progressBarHeight"
    private static let progressBarFillColorKey = "smithers.progressBarFillColor"
    private static let progressBarTrackColorKey = "smithers.progressBarTrackColor"
    nonisolated static let nonUTF8Placeholder = """
    This file is not UTF-8 and is opened as read-only.
    Open it in an external editor to modify.
    """
    private var terminalCounter = 0
    private let ghosttyApp = GhosttyApp.shared
    private let inputMethodSwitcher = InputMethodSwitcher()
    private var nvimLogFileURL: URL?
    private var nvimController: NvimController?
    private var nvimStartTask: Task<NvimController, Error>?
    private var codexService: CodexService?
    private var codexEventsTask: Task<Void, Never>?
    private var completionService: CodexCompletionService?
    private var activeThreadId: String?
    private var turnHistoryOrder: [String] = []
    private var nonUTF8Files: Set<URL> = []
    nonisolated private static let maxSearchResults = 200
    private static let maxRecentEditLocations = 12
    nonisolated private static let recencyEditWeight = 6
    nonisolated private static let recencyViewWeight = 3
    nonisolated private static let pathDepthPenalty = 6
    nonisolated private static let extensionExactBonus = 16
    nonisolated private static let extensionPartialBonus = 8
    nonisolated private static let skipDirectoryNames: Set<String> = [
        ".git",
        ".svn",
        ".hg"
    ]

    init() {
        configurePreferences()
        recentFileURLs = Self.loadRecentURLs(key: Self.recentFilesKey)
        recentFolderURLs = Self.loadRecentURLs(key: Self.recentFoldersKey)
        refreshRecentEntries()
    }

    private func configurePreferences() {
        preferences.onApplyWindowAppearance = { [weak self] in
            self?.applyWindowAppearance()
        }
        preferences.onScheduleNvimSettingsSync = { [weak self] in
            self?.scheduleNvimSettingsSync()
        }
        preferences.onUpdateTerminalOptionAsMeta = { [weak self] in
            self?.updateTerminalOptionAsMeta()
        }
        preferences.onShowToast = { [weak self] message in
            self?.showToast(message)
        }
        preferencesCancellable?.cancel()
        preferencesCancellable = preferences.objectWillChange.sink { [weak self] _ in
            self?.objectWillChange.send()
        }
    }

    var nvimFloatingWindowEffects: NvimFloatingWindowEffects {
        let prefs = preferences
        return NvimFloatingWindowEffects(
            windows: nvimFloatingWindows,
            blurEnabled: prefs.nvimFloatingBlurEnabled,
            blurRadius: CGFloat(prefs.nvimFloatingBlurRadius),
            cornerRadius: CGFloat(prefs.nvimFloatingCornerRadius),
            shadowEnabled: prefs.nvimFloatingShadowEnabled,
            shadowRadius: CGFloat(prefs.nvimFloatingShadowRadius),
            shadowOpacity: EditorPreferences.defaultFloatingShadowOpacity,
            shadowOffset: CGSize(width: 0, height: -2)
        )
    }

    private func updateTerminalOptionAsMeta() {
        let optionAsMeta = preferences.optionAsMeta
        for view in terminalViews.values {
            view.optionAsMeta = optionAsMeta
        }
        nvimTerminalView?.optionAsMeta = optionAsMeta
    }

    private func scheduleNvimSettingsSync() {
        guard isNvimModeEnabled, let controller = nvimController else { return }
        nvimSettingsSyncToken += 1
        let token = nvimSettingsSyncToken
        nvimSettingsSyncTask?.cancel()
        nvimSettingsSyncTask = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: 150_000_000)
            guard let self, token == self.nvimSettingsSyncToken else { return }
            guard self.isNvimModeEnabled else { return }
            guard self.nvimController === controller else { return }
            await self.syncNvimSettings(controller: controller)
        }
    }

    private func syncNvimSettings(controller: NvimController) async {
        let payload = nvimSettingsPayload()
        guard !payload.isEmpty else { return }
        await controller.setGlobalVariables(payload)
        let optionPayload = nvimOptionsPayload()
        if !optionPayload.isEmpty {
            await controller.setOptions(optionPayload)
        }
    }

    private func nvimSettingsPayload() -> [String: MsgPackValue] {
        let prefs = preferences
        return [
            "smithers_font_name": .string(prefs.editorFontName),
            "smithers_font_size": .double(prefs.editorFontSize),
            "smithers_font_ligatures": .bool(prefs.editorLigaturesEnabled),
            "smithers_line_spacing": .double(prefs.editorLineSpacing),
            "smithers_character_spacing": .double(prefs.editorCharacterSpacing),
            "smithers_option_as_meta": .string(prefs.optionAsMeta.rawValue),
            "smithers_scrollbar_mode": .string(prefs.scrollbarVisibilityMode.rawValue),
            "smithers_show_line_numbers": .bool(prefs.showLineNumbers),
            "smithers_highlight_current_line": .bool(prefs.highlightCurrentLine),
            "smithers_show_indent_guides": .bool(prefs.showIndentGuides),
            "smithers_show_minimap": .bool(prefs.showMinimap),
            "smithers_floating_blur_enabled": .bool(prefs.nvimFloatingBlurEnabled),
            "smithers_floating_blur_radius": .double(prefs.nvimFloatingBlurRadius),
            "smithers_floating_corner_radius": .double(prefs.nvimFloatingCornerRadius),
            "smithers_floating_shadow_enabled": .bool(prefs.nvimFloatingShadowEnabled),
            "smithers_floating_shadow_radius": .double(prefs.nvimFloatingShadowRadius),
            "smithers_nvim_path": .string(prefs.preferredNvimPath.isEmpty ? "" : prefs.expandedNvimPath),
        ]
    }

    private func nvimOptionsPayload() -> [String: MsgPackValue] {
        [
            "guifont": .string(preferences.nvimGuifont),
        ]
    }

    private func resolveNvimPath() throws -> String {
        let prefs = preferences
        let fm = FileManager.default
        if !prefs.preferredNvimPath.isEmpty {
            let expanded = prefs.expandedNvimPath
            if fm.isExecutableFile(atPath: expanded) {
                return expanded
            }
            throw NvimController.ControllerError.invalidNvimPath(expanded)
        }
        if let path = NvimController.locateNvimPath() {
            return path
        }
        throw NvimController.ControllerError.missingNvim
    }

    func persistChatHistory() {
        persistChatHistoryNow()
    }

    private func loadChatHistory(for rootDirectory: URL) {
        suppressChatHistoryPersistence = true
        defer { suppressChatHistoryPersistence = false }
        if let messages = ChatHistoryStore.loadHistory(for: rootDirectory), !messages.isEmpty {
            chatMessages = messages
        } else {
            chatMessages = Self.initialChatMessages()
        }
        rebuildDiffPreviewIndex()
    }

    private func scheduleChatHistoryPersist() {
        guard !suppressChatHistoryPersistence else { return }
        guard activeChatId == Self.mainChatId else { return }
        guard let rootDirectory else { return }
        chatHistoryPersistTask?.cancel()
        let root = rootDirectory
        chatHistoryPersistTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 1_000_000_000)
            guard let self, !Task.isCancelled else { return }
            let messages = self.chatMessages
            guard !Task.isCancelled else { return }
            DispatchQueue.global(qos: .utility).async {
                ChatHistoryStore.saveHistory(messages, for: root)
            }
        }
    }

    private func persistChatHistoryNow() {
        chatHistoryPersistTask?.cancel()
        chatHistoryPersistTask = nil
        guard activeChatId == Self.mainChatId else { return }
        guard let rootDirectory else { return }
        ChatHistoryStore.saveHistory(chatMessages, for: rootDirectory)
    }

    private func updateActiveThreadId(_ threadId: String?) {
        activeThreadId = threadId
        if let session = chatSessions[activeChatId] {
            session.threadId = threadId
        }
        guard activeChatId == Self.mainChatId else { return }
        guard let rootDirectory else { return }
        if let threadId {
            ThreadHistoryStore.saveThreadId(threadId, for: rootDirectory)
        } else {
            ThreadHistoryStore.removeThreadId(for: rootDirectory)
        }
    }

    private func applyThreadHistory(_ thread: ThreadSnapshot) {
        setTurnHistoryOrder(from: thread)
        let messages = Self.chatMessages(from: thread)
        suppressChatHistoryPersistence = true
        chatMessages = messages.isEmpty ? Self.initialChatMessages() : messages
        suppressChatHistoryPersistence = false
        isTurnInProgress = false
        rebuildDiffSnapshots(from: chatMessages)
    }

    private func setTurnHistoryOrder(from thread: ThreadSnapshot) {
        turnHistoryOrder = thread.turns.map(\.id)
    }

    private static func chatMessages(from thread: ThreadSnapshot) -> [ChatMessage] {
        var messages: [ChatMessage] = []
        for turn in thread.turns {
            for item in turn.items {
                switch item {
                case .userMessage(let userItem):
                    let text = userText(from: userItem)
                    let images = userImages(from: userItem)
                    if !text.isEmpty || !images.isEmpty {
                        messages.append(ChatMessage(role: .user, kind: .text(text), images: images, turnId: turn.id))
                    }
                case .agentMessage(let agentItem):
                    let text = agentItem.text.trimmingCharacters(in: .whitespacesAndNewlines)
                    if !text.isEmpty {
                        messages.append(ChatMessage(role: .assistant, kind: .text(text), turnId: turn.id))
                    }
                case .plan(let planItem):
                    let text = planItem.text.trimmingCharacters(in: .whitespacesAndNewlines)
                    if !text.isEmpty {
                        messages.append(ChatMessage(role: .assistant, kind: .status("Plan:\n\(text)"), turnId: turn.id))
                    }
                case .commandExecution(let commandItem):
                    let output = commandItem.aggregatedOutput ?? ""
                    let status = commandStatus(from: commandItem)
                    let info = CommandExecutionInfo(
                        itemId: commandItem.id,
                        command: commandItem.command,
                        cwd: commandItem.cwd,
                        output: output,
                        exitCode: commandItem.exitCode,
                        status: status
                    )
                    messages.append(ChatMessage(role: .assistant, kind: .command(info), turnId: turn.id))
                case .fileChange(let fileItem):
                    let preview = DiffPreview.fromFileChange(turnId: turn.id, item: fileItem)
                    messages.append(ChatMessage(role: .assistant, kind: .diffPreview(preview), turnId: turn.id))
                case .reasoning:
                    continue
                case .other:
                    continue
                }
            }
        }
        return messages
    }

    private static func userText(from item: UserMessageItem) -> String {
        let parts = item.content.compactMap { payload -> String? in
            if case .text(let text) = payload {
                return text
            }
            return nil
        }
        return parts.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static func userImages(from item: UserMessageItem) -> [ChatImage] {
        var images: [ChatImage] = []
        for payload in item.content {
            switch payload {
            case .image(let url):
                if let image = ChatImage.fromDataURL(url) {
                    images.append(image)
                }
            case .localImage(let path):
                let url = URL(fileURLWithPath: path)
                if let image = ChatImage.fromFileURL(url) {
                    images.append(image)
                }
            default:
                continue
            }
        }
        return images
    }

    private static func commandStatus(from item: CommandExecutionItem) -> CommandExecutionStatus {
        if let status = item.status {
            switch status {
            case .inProgress:
                return .running
            case .completed, .failed, .declined:
                return .completed
            }
        }
        if item.exitCode != nil {
            return .completed
        }
        return .running
    }

    private func rebuildDiffSnapshots(from messages: [ChatMessage]) {
        turnDiffs = [:]
        turnDiffOrder = []
        streamingTurnDiffs = [:]
        diffPreviewIndexByTurnId = [:]
        for message in messages {
            guard case .diffPreview(let preview) = message.kind else { continue }
            guard let turnId = preview.turnId else { continue }
            let trimmed = preview.diff.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty else { continue }
            if turnDiffs[turnId] == nil {
                turnDiffOrder.append(turnId)
            }
            turnDiffs[turnId] = preview.diff
        }
        rebuildDiffPreviewIndex()
        updateSessionDiffSnapshot()
    }

    private func rebuildDiffPreviewIndex() {
        diffPreviewIndexByTurnId = [:]
        for (index, message) in chatMessages.enumerated() {
            guard case .diffPreview(let preview) = message.kind else { continue }
            guard let turnId = preview.turnId else { continue }
            diffPreviewIndexByTurnId[turnId] = index
        }
    }

    func openDirectory(_ url: URL, restoreSession: Bool = false) {
        persistWindowFrameForCurrentWorkspace()
        persistSessionStateIfNeeded()
        persistChatHistoryNow()
        let shouldRestartNvim = isNvimModeEnabled
        stopNvim()
        if shouldRestartNvim {
            maybeHideWindowForNvimStart()
        }
        stopCodexService()
        closeAllTerminals()
        saveLastWorkspace(url)
        rootDirectory = canonicalFileURL(url)
        addRecentFolder(url)
        suppressSessionPersistence = true
        fileTree = FileItem.loadTree(at: url)
        openFiles = []
        selectedFileURL = nil
        setEditorText("")
        isEditorLoading = false
        currentLanguage = nil
        fileLoadTask?.cancel()
        fileLoadTask = nil
        fileReadTask?.cancel()
        fileReadTask = nil
        fileIndexTask?.cancel()
        fileIndexTask = nil
        searchTask?.cancel()
        searchTask = nil
        searchInFilesTask?.cancel()
        searchInFilesTask = nil
        searchPreviewTask?.cancel()
        searchPreviewTask = nil
        sessionDiffComputeTask?.cancel()
        sessionDiffComputeTask = nil
        chatHistoryPersistTask?.cancel()
        chatHistoryPersistTask = nil
        openFileContents = [:]
        savedFileContents = [:]
        nativeDirtyFiles = []
        nonUTF8Files = []
        fileIndex = []
        fileSearchResults = []
        searchQuery = ""
        searchResults = []
        clearSearchPreview()
        searchErrorMessage = nil
        isSearchPresented = false
        isShortcutsPanelVisible = false
        recentEditTimestamps = [:]
        recentEditEntries = []
        recentEditLocations = [:]
        activeDiffPreview = nil
        activeSessionDiff = nil
        sessionDiffSnapshot = nil
        turnDiffs = [:]
        turnDiffOrder = []
        streamingTurnDiffs = [:]
        diffPreviewIndexByTurnId = [:]
        turnHistoryOrder = []
        activeSkills = []
        skillInstructionCache = [:]
        chatSessions = [:]
        activeChatId = Self.mainChatId
        diffTabs = [:]
        let webviewIDs = Array(webviewTabs.keys)
        for id in webviewIDs {
            closeWebview(id)
        }
        webviewTabs = [:]
        webviewViews = [:]
        webviewTitleObservers = [:]
        skillWatchers.forEach { $0.invalidate() }
        skillWatchers = []
        let storedThreadId = ThreadHistoryStore.loadThreadId(for: url)
        activeThreadId = storedThreadId
        if storedThreadId == nil {
            loadChatHistory(for: url)
        } else {
            suppressChatHistoryPersistence = true
            chatMessages = Self.initialChatMessages()
            suppressChatHistoryPersistence = false
        }
        storeActiveChatSessionState()
        if restoreSession {
            if !restoreSessionStateIfAvailable() {
                openChat()
            }
        } else {
            openChat()
        }
        rebuildFileIndex()
        startCodexService(cwd: url.path, resumeThreadId: storedThreadId)
        startCompletionService(cwd: url.path)
        refreshSkills(force: true)
        setupJJService(for: url)
        suppressSessionPersistence = false
        persistSessionStateIfNeeded()
        applyWindowFrameForCurrentWorkspace()
        if shouldRestartNvim {
            Task { [weak self] in
                guard let self else { return }
                do {
                    _ = try await self.ensureNvimStarted(force: true)
                } catch {
                    self.handleNvimStartFailure(error)
                }
            }
        }
    }

    func handleExternalOpen(urls: [URL]) {
        Task { @MainActor [weak self] in
            await self?.handleExternalOpen(urls: urls, focus: nil)
        }
    }

    func handleExternalOpen(url: URL, line: Int?, column: Int?) {
        Task { @MainActor [weak self] in
            await self?.handleExternalOpen(urls: [url], focus: ExternalOpenFocus(url: url, line: line, column: column))
        }
    }

    struct ExternalOpenRequest {
        let url: URL
        let line: Int?
        let column: Int?
    }

    func handleExternalOpen(requests: [ExternalOpenRequest]) {
        guard !requests.isEmpty else { return }
        let urls = requests.map { $0.url }
        let focusRequest = requests.first { $0.line != nil || $0.column != nil }
        let focus = focusRequest.map {
            ExternalOpenFocus(url: $0.url, line: $0.line, column: $0.column)
        }
        Task { @MainActor [weak self] in
            await self?.handleExternalOpen(urls: urls, focus: focus)
        }
    }

    private struct ExternalOpenFocus {
        let url: URL
        let line: Int?
        let column: Int?
    }

    private enum WebviewEvalError: LocalizedError {
        case missingWebview

        var errorDescription: String? {
            switch self {
            case .missingWebview:
                return "webview not found"
            }
        }
    }

    private func handleExternalOpen(urls: [URL], focus: ExternalOpenFocus?) async {
        guard !urls.isEmpty else { return }
        var fileURLs: [URL] = []
        var directoryURLs: [URL] = []
        var seenFiles: Set<URL> = []
        var seenDirs: Set<URL> = []

        for url in urls {
            let normalized = url.standardizedFileURL
            var isDir: ObjCBool = false
            guard FileManager.default.fileExists(atPath: normalized.path, isDirectory: &isDir) else { continue }
            if isDir.boolValue {
                if seenDirs.insert(normalized).inserted {
                    directoryURLs.append(normalized)
                }
            } else {
                if seenFiles.insert(normalized).inserted {
                    fileURLs.append(normalized)
                }
            }
        }

        var resolvedFocus = focus
        if let focusURL = focus?.url.standardizedFileURL {
            resolvedFocus = ExternalOpenFocus(url: focusURL, line: focus?.line, column: focus?.column)
            if !seenFiles.contains(focusURL) {
                var isDir: ObjCBool = false
                if FileManager.default.fileExists(atPath: focusURL.path, isDirectory: &isDir),
                   !isDir.boolValue,
                   seenFiles.insert(focusURL).inserted {
                    fileURLs.append(focusURL)
                }
            }
        }

        guard !fileURLs.isEmpty || !directoryURLs.isEmpty else { return }

        if let root = preferredWorkspaceRoot(fileURLs: fileURLs, directoryURLs: directoryURLs),
           root != rootDirectory {
            if rootDirectory != nil {
                let shouldSwitch = await confirmCloseForWorkspaceSwitch()
                guard shouldSwitch else { return }
            }
            openDirectory(root, restoreSession: true)
        }

        if fileURLs.isEmpty {
            if let dir = directoryURLs.first, rootDirectory == nil {
                openDirectory(dir, restoreSession: true)
            }
            return
        }

        if let resolvedFocus {
            fileURLs.removeAll { $0 == resolvedFocus.url }
        }

        for url in fileURLs {
            selectFile(url)
        }

        if let resolvedFocus {
            if let line = resolvedFocus.line {
                openFileAtLocation(resolvedFocus.url, line: line, column: resolvedFocus.column ?? 1)
            } else {
                selectFile(resolvedFocus.url)
            }
        }
    }

    func addFileOpenObserver(_ handler: @escaping (URL) -> Void) -> ObserverToken {
        let id = UUID()
        fileOpenObservers[id] = handler
        return ObserverToken { [weak self] in
            self?.fileOpenObservers.removeValue(forKey: id)
        }
    }

    func removeFileOpenObserver(_ id: UUID) {
        fileOpenObservers.removeValue(forKey: id)
    }

    func addFileCloseObserver(_ handler: @escaping (URL) -> Void) -> ObserverToken {
        let id = UUID()
        fileCloseObservers[id] = handler
        return ObserverToken { [weak self] in
            self?.fileCloseObservers.removeValue(forKey: id)
        }
    }

    func removeFileCloseObserver(_ id: UUID) {
        fileCloseObservers.removeValue(forKey: id)
    }

    func isFileOpen(_ url: URL) -> Bool {
        let canonical = canonicalFileURL(url)
        return openFiles.contains { candidate in
            guard isRegularFileURL(candidate) else { return false }
            return canonicalFileURL(candidate) == canonical
        }
    }

    private func notifyOpenFileObservers(oldValue: [URL], newValue: [URL]) {
        let oldSet = Set(oldValue.filter { isRegularFileURL($0) }.map { $0.standardizedFileURL })
        let newSet = Set(newValue.filter { isRegularFileURL($0) }.map { $0.standardizedFileURL })
        let opened = newSet.subtracting(oldSet)
        let closed = oldSet.subtracting(newSet)
        for url in opened {
            notifyFileOpened(url)
        }
        for url in closed {
            notifyFileClosed(url)
        }
    }

    private func notifyFileOpened(_ url: URL) {
        for handler in fileOpenObservers.values {
            handler(url)
        }
    }

    private func notifyFileClosed(_ url: URL) {
        for handler in fileCloseObservers.values {
            handler(url)
        }
    }

    private func preferredWorkspaceRoot(fileURLs: [URL], directoryURLs: [URL]) -> URL? {
        let normalizedFiles = fileURLs.map { $0.standardizedFileURL }
        let normalizedDirectories = directoryURLs.map { $0.standardizedFileURL }

        if let root = rootDirectory?.standardizedFileURL,
           itemsAreWithinRoot(root, fileURLs: normalizedFiles, directoryURLs: normalizedDirectories) {
            return root
        }

        if normalizedDirectories.count == 1 {
            let dir = normalizedDirectories[0]
            if itemsAreWithinRoot(dir, fileURLs: normalizedFiles, directoryURLs: []) {
                return dir
            }
        }

        var candidates: [URL] = normalizedDirectories
        candidates.append(contentsOf: normalizedFiles.map { $0.deletingLastPathComponent() })
        guard !candidates.isEmpty else { return nil }
        return commonAncestorDirectory(for: candidates)
    }

    private func itemsAreWithinRoot(_ root: URL, fileURLs: [URL], directoryURLs: [URL]) -> Bool {
        for url in fileURLs where !isURL(url, within: root) {
            return false
        }
        for url in directoryURLs where !isURL(url, within: root) {
            return false
        }
        return true
    }

    private func isURL(_ url: URL, within root: URL) -> Bool {
        let rootPath = root.standardizedFileURL.path
        let path = url.standardizedFileURL.path
        let prefix = rootPath.hasSuffix("/") ? rootPath : "\(rootPath)/"
        return path == rootPath || path.hasPrefix(prefix)
    }

    private func canonicalFileURL(_ url: URL) -> URL {
        url.isFileURL ? url.standardizedFileURL : url
    }

    private func markNativeDirty(_ url: URL) {
        nativeDirtyFiles.insert(canonicalFileURL(url))
    }

    private func clearNativeDirty(_ url: URL) {
        nativeDirtyFiles.remove(canonicalFileURL(url))
    }

    private func commonAncestorDirectory(for urls: [URL]) -> URL? {
        guard var commonComponents = urls.first?.standardizedFileURL.pathComponents else { return nil }
        for url in urls.dropFirst() {
            let components = url.standardizedFileURL.pathComponents
            while !components.starts(with: commonComponents) {
                commonComponents.removeLast()
                if commonComponents.isEmpty {
                    return nil
                }
            }
        }
        return URL(fileURLWithPath: NSString.path(withComponents: commonComponents))
    }

    func requestOpenDirectory(_ url: URL, restoreSession: Bool = false) {
        Task { @MainActor [weak self] in
            guard let self else { return }
            if let rootDirectory,
               rootDirectory.standardizedFileURL == url.standardizedFileURL {
                return
            }
            if rootDirectory != nil {
                let shouldClose = await confirmCloseForWorkspaceSwitch()
                guard shouldClose else { return }
            }
            openDirectory(url, restoreSession: restoreSession)
        }
    }

    func selectFile(_ url: URL) {
        if suppressSelectionSync {
            suppressSelectionSync = false
            return
        }
        if isChatURL(url) {
            isEditorLoading = false
            selectChat(url)
            return
        }
        if isTerminalURL(url) {
            selectedFileURL = url
            currentLanguage = nil
            isEditorLoading = false
            setEditorText("")
            return
        }
        if isDiffURL(url) {
            selectedFileURL = url
            currentLanguage = nil
            isEditorLoading = false
            setEditorText("")
            return
        }
        if isWebviewURL(url) {
            selectedFileURL = url
            currentLanguage = nil
            isEditorLoading = false
            setEditorText("")
            return
        }
        var isDir: ObjCBool = false
        if FileManager.default.fileExists(atPath: url.path, isDirectory: &isDir), isDir.boolValue {
            return
        }
        let canonicalURL = canonicalFileURL(url)
        if isRegularFileURL(canonicalURL) {
            addRecentFile(canonicalURL)
        }
        if isNvimModeEnabled {
            isEditorLoading = false
            openFileInNvim(canonicalURL, line: nil, column: nil)
            return
        }
        if !openFiles.contains(canonicalURL) {
            openFiles.append(canonicalURL)
        }
        selectedFileURL = canonicalURL
        currentLanguage = SupportedLanguage.fromFileName(canonicalURL.lastPathComponent)
        fileLoadTask?.cancel()
        fileReadTask?.cancel()
        if let cached = openFileContents[canonicalURL] {
            if savedFileContents[canonicalURL] == nil {
                savedFileContents[canonicalURL] = cached
            }
            isEditorLoading = false
            if isNonUTF8File(canonicalURL) {
                currentLanguage = nil
                setEditorText(Self.nonUTF8Placeholder)
                clearNativeDirty(canonicalURL)
            } else {
                setEditorText(cached)
            }
            return
        }
        isEditorLoading = true
        setEditorText("")
        let requestedURL = canonicalURL
        let readTask = Task.detached(priority: .userInitiated) {
            Self.loadUTF8Text(from: requestedURL)
        }
        fileReadTask = readTask
        fileLoadTask = Task { [weak self] in
            let loadResult = await readTask.value
            guard !Task.isCancelled, let self else { return }
            let canonical = requestedURL
            if loadResult.isUTF8 {
                self.clearNonUTF8File(canonical)
            } else {
                self.markNonUTF8File(canonical)
            }
            if self.savedFileContents[canonical] == nil {
                self.savedFileContents[canonical] = loadResult.text
            }
            if self.openFileContents[canonical] == nil {
                self.openFileContents[canonical] = loadResult.text
            }
            self.clearNativeDirty(canonical)
            guard self.selectedFileURL == canonical else { return }
            if loadResult.isUTF8 {
                self.setEditorText(loadResult.text)
            } else {
                self.currentLanguage = nil
                self.setEditorText(Self.nonUTF8Placeholder)
                self.showToast("File is not UTF-8 and is read-only")
            }
            self.isEditorLoading = false
            self.updateWindowTitle()
        }
    }

    func requestCloseFile(_ url: URL) {
        Task { @MainActor [weak self] in
            guard let self else { return }
            let decision = await self.closeDecisionForTab(url)
            switch decision {
            case .deny:
                return
            case .allow(let force):
                closeFile(url, force: force)
            }
        }
    }

    func closeFile(_ url: URL) {
        closeFile(url, force: false)
    }

    private func closeFile(_ url: URL, force: Bool) {
        guard let index = openFiles.firstIndex(of: url) else { return }
        let canonicalURL = canonicalFileURL(url)
        if isNvimModeEnabled && isRegularFileURL(canonicalURL) {
            let wasSelected = selectedFileURL == url
            openFiles.remove(at: index)
            openFileContents.removeValue(forKey: canonicalURL)
            savedFileContents.removeValue(forKey: canonicalURL)
            nativeDirtyFiles.remove(canonicalURL)
            clearNonUTF8File(canonicalURL)
            if wasSelected {
                selectedFileURL = nil
                currentLanguage = nil
                setEditorText("")
            }
            Task { [weak self] in
                await self?.nvimController?.closeFile(canonicalURL, force: force)
            }
            return
        }
        let wasSelected = selectedFileURL == canonicalURL
        openFiles.remove(at: index)
        if isChatURL(canonicalURL) {
            if let chatId = chatId(for: canonicalURL) {
                chatSessions.removeValue(forKey: chatId)
            }
        } else if isTerminalURL(canonicalURL) {
            closeTerminal(canonicalURL)
        } else if isDiffURL(canonicalURL) {
            diffTabs.removeValue(forKey: canonicalURL)
        } else if isWebviewURL(canonicalURL) {
            closeWebview(canonicalURL)
        } else {
            openFileContents.removeValue(forKey: canonicalURL)
            savedFileContents.removeValue(forKey: canonicalURL)
            nativeDirtyFiles.remove(canonicalURL)
            clearNonUTF8File(canonicalURL)
        }

        guard wasSelected else { return }
        fileLoadTask?.cancel()
        fileReadTask?.cancel()
        if openFiles.isEmpty {
            selectedFileURL = nil
            currentLanguage = nil
            setEditorText("")
            return
        }
        let nextIndex = min(index, openFiles.count - 1)
        let nextURL = openFiles[nextIndex]
        selectFile(nextURL)
    }

    func confirmCloseForWindow() async -> Bool {
        await confirmCloseIfNeeded(context: .window)
    }

    func confirmCloseForApplication() async -> Bool {
        await confirmCloseIfNeeded(context: .application)
    }

    func confirmCloseForWorkspaceSwitch() async -> Bool {
        await confirmCloseIfNeeded(context: .workspace)
    }

    func setCloseGuardsBypassed(_ value: Bool) {
        closeGuardsBypassed = value
    }

    func shouldBypassCloseGuards() -> Bool {
        closeGuardsBypassed || !isCloseWarningEnabled
    }

    private func closeDecisionForTab(_ url: URL) async -> CloseDecision {
        if isChatURL(url) {
            if url == selectedFileURL && isTurnInProgress {
                showToast("Wait for the current turn to finish.")
                return .deny
            }
            return .allow(force: false)
        }
        if closeGuardsBypassed || !isCloseWarningEnabled || !isRegularFileURL(url) {
            return .allow(force: false)
        }
        if isNvimModeEnabled {
            guard let controller = nvimController else { return .allow(force: false) }
            do {
                let buffers = try await controller.listModifiedBuffersInTab(containing: url)
                guard !buffers.isEmpty else { return .allow(force: false) }
                let names = uniqueBufferNames(from: buffers)
                let confirmed = confirmDiscardChanges(context: .tab(url), names: names)
                return confirmed ? .allow(force: true) : .deny
            } catch {
                Self.debugLog("[WorkspaceState] listModifiedBuffersInTab error: \(error)")
                let confirmed = confirmUnableToCheck(context: .tab(url))
                return confirmed ? .allow(force: true) : .deny
            }
        }

        if isNativeFileModified(url) {
            let confirmed = confirmDiscardChanges(context: .tab(url), names: [displayPath(for: url)])
            return confirmed ? .allow(force: false) : .deny
        }
        return .allow(force: false)
    }

    private func confirmCloseIfNeeded(context: CloseContext) async -> Bool {
        if closeGuardsBypassed || !isCloseWarningEnabled {
            return true
        }
        var names: [String] = []
        if isNvimModeEnabled {
            guard let buffers = await fetchModifiedNvimBuffers() else {
                return confirmUnableToCheck(context: context)
            }
            names.append(contentsOf: uniqueBufferNames(from: buffers))
        }
        names.append(contentsOf: modifiedNativeFileNames())
        names = uniqueNames(names)
        guard !names.isEmpty else { return true }
        return confirmDiscardChanges(context: context, names: names)
    }

    private func fetchModifiedNvimBuffers() async -> [NvimModifiedBuffer]? {
        guard isNvimModeEnabled, let controller = nvimController else { return [] }
        do {
            let buffers = try await controller.listModifiedBuffers()
            setNvimModifiedBuffers(buffers)
            return buffers
        } catch {
            Self.debugLog("[WorkspaceState] listModifiedBuffers error: \(error)")
            return nil
        }
    }

    private func confirmDiscardChanges(context: CloseContext, names: [String]) -> Bool {
        let count = names.count
        let listText = formatBufferList(names)
        let alert = NSAlert()
        alert.alertStyle = .warning
        switch context {
        case .tab(let url):
            if count == 1 {
                let name = names.first ?? displayPath(for: url)
                alert.messageText = "The file \"\(name)\" has unsaved changes."
                alert.informativeText = "Closing this tab will discard your changes."
            } else {
                let fileWord = count == 1 ? "file" : "files"
                alert.messageText = "You have unsaved changes in \(count) \(fileWord)."
                alert.informativeText = buildCloseInfo(
                    listText: listText,
                    actionText: "Closing this tab will discard these changes."
                )
            }
            alert.addButton(withTitle: "Close Tab")
        case .window:
            let fileWord = count == 1 ? "file" : "files"
            alert.messageText = "You have unsaved changes in \(count) \(fileWord)."
            alert.informativeText = buildCloseInfo(listText: listText, actionText: "Closing the window will discard these changes.")
            alert.addButton(withTitle: "Close Window")
        case .application:
            let fileWord = count == 1 ? "file" : "files"
            alert.messageText = "You have unsaved changes in \(count) \(fileWord)."
            alert.informativeText = buildCloseInfo(listText: listText, actionText: "Quitting will discard these changes.")
            alert.addButton(withTitle: "Quit")
        case .workspace:
            let fileWord = count == 1 ? "file" : "files"
            alert.messageText = "You have unsaved changes in \(count) \(fileWord)."
            alert.informativeText = buildCloseInfo(listText: listText, actionText: "Opening another folder will discard these changes.")
            alert.addButton(withTitle: "Open Folder")
        }
        alert.addButton(withTitle: "Cancel")
        return alert.runModal() == .alertFirstButtonReturn
    }

    private func confirmUnableToCheck(context: CloseContext) -> Bool {
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = "Unable to check for unsaved changes."
        switch context {
        case .tab:
            alert.informativeText = "Close this tab anyway?"
            alert.addButton(withTitle: "Close Tab")
        case .window:
            alert.informativeText = "Close the window anyway?"
            alert.addButton(withTitle: "Close Window")
        case .application:
            alert.informativeText = "Quit anyway?"
            alert.addButton(withTitle: "Quit")
        case .workspace:
            alert.informativeText = "Open the folder anyway?"
            alert.addButton(withTitle: "Open Folder")
        }
        alert.addButton(withTitle: "Cancel")
        return alert.runModal() == .alertFirstButtonReturn
    }

    private func buildCloseInfo(listText: String, actionText: String) -> String {
        if listText.isEmpty {
            return actionText
        }
        return "Unsaved files:\n\(listText)\n\n\(actionText)"
    }

    private func formatBufferList(_ names: [String], limit: Int = 6) -> String {
        guard !names.isEmpty else { return "" }
        let shown = names.prefix(limit)
        var text = shown.joined(separator: "\n")
        let remaining = names.count - shown.count
        if remaining > 0 {
            text += "\n...and \(remaining) more"
        }
        return text
    }

    private func modifiedNativeFileNames() -> [String] {
        var names: [String] = []
        for url in openFiles where isRegularFileURL(url) {
            if isNativeFileModified(url) {
                names.append(displayPath(for: url))
            }
        }
        return names
    }

    private func uniqueNames(_ names: [String]) -> [String] {
        var seen = Set<String>()
        var output: [String] = []
        for name in names {
            if seen.contains(name) { continue }
            seen.insert(name)
            output.append(name)
        }
        return output
    }

    private func uniqueBufferNames(from buffers: [NvimModifiedBuffer]) -> [String] {
        var names: [String] = []
        var seen: Set<String> = []
        for buffer in buffers {
            let name = bufferDisplayName(buffer)
            guard !seen.contains(name) else { continue }
            seen.insert(name)
            names.append(name)
        }
        return names
    }

    private func bufferDisplayName(_ buffer: NvimModifiedBuffer) -> String {
        if let url = buffer.url {
            return displayPath(for: url)
        }
        let trimmed = buffer.name.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty {
            return "Untitled"
        }
        return (trimmed as NSString).lastPathComponent
    }

    private static let debugDateFormatter: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        return f
    }()

    private static let nvimReportDateFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyyMMdd-HHmmss"
        return formatter
    }()

    static func debugLog(_ msg: String) {
        let ts = debugDateFormatter.string(from: Date())
        let line = "[\(ts)] \(msg)\n"
        let path = "/tmp/smithers-nvim-debug.log"
        if let fh = FileHandle(forWritingAtPath: path) {
            fh.seekToEndOfFile()
            fh.write(Data(line.utf8))
            fh.closeFile()
        } else {
            FileManager.default.createFile(atPath: path, contents: Data(line.utf8))
        }
    }

    private func clearNvimFailure() {
        nvimFailure = nil
    }

    private func nvimSupportDirectory() -> URL? {
        guard let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first else {
            return nil
        }
        return base
            .appendingPathComponent("Smithers", isDirectory: true)
            .appendingPathComponent("Nvim", isDirectory: true)
    }

    private func makeNvimLogFileURL() -> URL? {
        guard let base = nvimSupportDirectory() else { return nil }
        let dir = base.appendingPathComponent("Logs", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let timestamp = Self.nvimReportDateFormatter.string(from: Date())
        let suffix = String(UUID().uuidString.prefix(8))
        return dir.appendingPathComponent("nvim-\(timestamp)-\(suffix).log")
    }

    private func writeNvimReport(kind: NvimFailureKind, error: Error?) -> URL? {
        guard let base = nvimSupportDirectory() else { return nil }
        let dir = base.appendingPathComponent("Reports", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let timestamp = Self.nvimReportDateFormatter.string(from: Date())
        let suffix = String(UUID().uuidString.prefix(8))
        let reportURL = dir.appendingPathComponent("nvim-report-\(timestamp)-\(suffix).txt")

        var lines: [String] = []
        lines.append("Smithers Neovim Report")
        lines.append("Timestamp: \(Self.debugDateFormatter.string(from: Date()))")
        lines.append("Failure: \(kind == .startup ? "Startup failure" : "Crash")")
        if let error {
            lines.append("Error: \(error.localizedDescription)")
        }
        if let rootDirectory {
            lines.append("Workspace: \(rootDirectory.path)")
        }
        lines.append("Neovim path setting: \(nvimPathStatusMessage)")
        if let command = nvimTerminalView?.command {
            lines.append("Command: \(command)")
        }
        if let logURL = nvimLogFileURL {
            lines.append("NVIM_LOG_FILE: \(logURL.path)")
        }
        if let selectedFileURL, isRegularFileURL(selectedFileURL) {
            lines.append("Selected file: \(selectedFileURL.path)")
        }
        let regularFiles = openFiles.filter { isRegularFileURL($0) }
        lines.append("Open files: \(regularFiles.count)")
        if !regularFiles.isEmpty {
            let maxList = min(12, regularFiles.count)
            lines.append("Open file list (first \(maxList)):")
            for url in regularFiles.prefix(maxList) {
                lines.append("- \(url.path)")
            }
            if regularFiles.count > maxList {
                lines.append("... +\(regularFiles.count - maxList) more")
            }
        }

        lines.append("")
        lines.append("---- Smithers debug log (tail) ----")
        if let debugTail = readTail(fromPath: "/tmp/smithers-nvim-debug.log", maxLines: 200) {
            lines.append(debugTail)
        } else {
            lines.append("(no debug log)")
        }

        if let logURL = nvimLogFileURL {
            lines.append("")
            lines.append("---- Neovim log (tail) ----")
            if let nvimTail = readTail(from: logURL, maxLines: 200) {
                lines.append(nvimTail)
            } else {
                lines.append("(no Neovim log)")
            }
        }

        let report = lines.joined(separator: "\n")
        do {
            try report.write(to: reportURL, atomically: true, encoding: .utf8)
            return reportURL
        } catch {
            return nil
        }
    }

    private func readTail(fromPath path: String, maxLines: Int) -> String? {
        let url = URL(fileURLWithPath: path)
        return readTail(from: url, maxLines: maxLines)
    }

    private func readTail(from url: URL, maxLines: Int) -> String? {
        guard maxLines > 0 else { return nil }
        guard let data = try? Data(contentsOf: url), !data.isEmpty else { return nil }
        guard let text = String(data: data, encoding: .utf8) else { return nil }
        let lines = text.split(separator: "\n", omittingEmptySubsequences: false)
        guard !lines.isEmpty else { return nil }
        return lines.suffix(maxLines).joined(separator: "\n")
    }

    @discardableResult
    private func recordNvimFailure(kind: NvimFailureKind, error: Error?, message: String) -> Bool {
        if nvimFailure != nil { return false }
        let reportURL = writeNvimReport(kind: kind, error: error)
        nvimFailure = NvimFailure(
            kind: kind,
            message: message,
            detail: error?.localizedDescription,
            timestamp: Date(),
            reportURL: reportURL,
            logURL: nvimLogFileURL
        )
        return true
    }

    private func handleNvimStartFailure(_ error: Error) {
        guard !(error is CancellationError) else { return }
        if recordNvimFailure(kind: .startup, error: error, message: "Neovim failed to start.") {
            appendErrorMessage("Neovim failed to start: \(error.localizedDescription)")
        }
        stopNvim()
    }

    private func handleNvimRuntimeFailure(_ error: Error?, message: String) {
        if recordNvimFailure(kind: .crash, error: error, message: message) {
            if let error {
                appendErrorMessage("Neovim error: \(error.localizedDescription)")
            } else {
                appendErrorMessage(message)
            }
        }
        stopNvim()
    }

    func restartNvim() {
        guard isNvimModeEnabled else { return }
        let regularFiles = openFiles.filter { isRegularFileURL($0) }
        let selected = selectedFileURL
        clearNvimFailure()
        stopNvim()
        maybeHideWindowForNvimStart()
        Task { [weak self] in
            guard let self else { return }
            do {
                let controller = try await self.ensureNvimStarted(force: true)
                await self.restoreNvimWorkspaceState(controller: controller, openFiles: regularFiles, selected: selected)
            } catch {
                self.handleNvimStartFailure(error)
            }
        }
    }

    private func restoreNvimWorkspaceState(
        controller: NvimController,
        openFiles: [URL],
        selected: URL?
    ) async {
        let regularFiles = openFiles.filter { isRegularFileURL($0) }
        for url in regularFiles where url != selected {
            try? await controller.openFile(url, line: nil, column: nil)
        }
        if let selected, isRegularFileURL(selected) {
            try? await controller.openFile(selected, line: nil, column: nil)
        }
    }

    func handleNvimBufferEnter(url: URL, select: Bool) {
        let normalizedURL = url.standardizedFileURL
        Self.debugLog("[WorkspaceState] handleNvimBufferEnter: \(normalizedURL.path) select: \(select)")
        if !openFiles.contains(normalizedURL) {
            openFiles.append(normalizedURL)
        }
        if select {
            if selectedFileURL != normalizedURL {
                suppressSelectionSync = true
                selectedFileURL = normalizedURL
            }
            Self.debugLog("[WorkspaceState] setting nvimCurrentFilePath = \(normalizedURL.path)")
            nvimCurrentFilePath = normalizedURL.path
            currentLanguage = nil
            setEditorText("")
        }
    }

    func handleNvimViewport(topLine: Int, bottomLine: Int, lineCount: Int) {
        let safeCount = max(1, lineCount)
        let safeTop = min(max(1, topLine), safeCount)
        let safeBottom = min(max(safeTop, bottomLine), safeCount)
        let viewport = NvimViewport(topLine: safeTop, bottomLine: safeBottom, lineCount: safeCount)
        if viewport != nvimViewport {
            nvimViewport = viewport
        }
    }

    func handleNvimGridMetrics(_ metrics: GhosttyGridMetrics?) {
        if metrics != nvimGridMetrics {
            nvimGridMetrics = metrics
        }
    }

    func handleNvimCmdlineShow(_ state: NvimCmdlineState) {
        if state != nvimCmdlineState {
            nvimCmdlineState = state
        } else if !state.isVisible {
            nvimCmdlineState.isVisible = true
        }
    }

    func handleNvimCmdlineHide() {
        if nvimCmdlineState.isVisible {
            nvimCmdlineState.isVisible = false
        }
    }

    func handleNvimCmdlinePos(_ pos: Int, level: Int) {
        guard nvimCmdlineState.isVisible else { return }
        if nvimCmdlineState.cursorPos != pos || nvimCmdlineState.level != level {
            nvimCmdlineState.cursorPos = pos
            nvimCmdlineState.level = level
        }
    }

    func handleNvimPopupmenuShow(_ state: NvimPopupMenuState) {
        if state != nvimPopupMenuState {
            nvimPopupMenuState = state
        } else if !state.isVisible {
            nvimPopupMenuState.isVisible = true
        }
    }

    func handleNvimPopupmenuHide() {
        if nvimPopupMenuState.isVisible {
            nvimPopupMenuState.isVisible = false
        }
    }

    func handleNvimPopupmenuSelect(_ selected: Int) {
        guard nvimPopupMenuState.isVisible else { return }
        if nvimPopupMenuState.selected != selected {
            nvimPopupMenuState.selected = selected
        }
    }

    func handleNvimMessageShow(kind: String, chunks: [NvimTextChunk], replaceLast: Bool) {
        let text = chunks.map(\.text).joined()
        let lineCount = max(1, text.split(separator: "\n", omittingEmptySubsequences: false).count)
        let route = routeNvimMessage(event: .msgShow, kind: kind, lineCount: lineCount)

        switch route.view {
        case .none:
            return
        case .mini:
            setMiniStatus(text, timeout: resolveNvimTimeout(for: route, view: .mini))
        case .float:
            insertNvimMessage(kind: kind, text: text, replaceLast: replaceLast, timeout: resolveNvimTimeout(for: route, view: .float))
        }
    }

    func handleNvimMessageClear() {
        clearNvimMessages()
        nvimMiniStatusTask?.cancel()
        nvimMiniStatusTask = nil
        if !nvimMiniMessageState.status.isEmpty {
            nvimMiniMessageState.status = ""
        }
    }

    func handleNvimMessageShowMode(_ chunks: [NvimTextChunk]) {
        let text = chunks.map(\.text).joined()
        if text != nvimMiniMessageState.showMode {
            nvimMiniMessageState.showMode = text
        }
    }

    func handleNvimMessageShowCmd(_ chunks: [NvimTextChunk]) {
        let text = chunks.map(\.text).joined()
        if text != nvimMiniMessageState.showCmd {
            nvimMiniMessageState.showCmd = text
        }
    }

    func handleNvimMessageRuler(_ chunks: [NvimTextChunk]) {
        let text = chunks.map(\.text).joined()
        if text != nvimMiniMessageState.ruler {
            nvimMiniMessageState.ruler = text
        }
    }

    private func routeNvimMessage(event: NvimMessageEvent, kind: String, lineCount: Int) -> NvimMessageRoute {
        if let match = nvimMessageRoutes.first(where: { $0.matches(event: event, kind: kind, lineCount: lineCount) }) {
            return match
        }
        return NvimMessageRoute(
            event: event,
            kinds: nil,
            view: .float,
            timeout: Self.nvimDefaultMessageTimeout,
            minHeight: nil,
            maxHeight: nil
        )
    }

    private func resolveNvimTimeout(for route: NvimMessageRoute, view: NvimMessageView) -> TimeInterval? {
        if let timeout = route.timeout {
            return timeout > 0 ? timeout : nil
        }
        switch view {
        case .mini:
            return Self.nvimDefaultMiniTimeout
        case .float:
            return Self.nvimDefaultMessageTimeout
        case .none:
            return nil
        }
    }

    private func setMiniStatus(_ text: String, timeout: TimeInterval?) {
        if text != nvimMiniMessageState.status {
            nvimMiniMessageState.status = text
        }
        nvimMiniStatusTask?.cancel()
        guard let timeout else { return }
        nvimMiniStatusTask = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(timeout * 1_000_000_000))
            guard let self else { return }
            if self.nvimMiniMessageState.status == text {
                self.nvimMiniMessageState.status = ""
            }
        }
    }

    private func insertNvimMessage(kind: String, text: String, replaceLast: Bool, timeout: TimeInterval?) {
        if replaceLast, let lastIndex = nvimMessages.indices.last {
            var entry = nvimMessages[lastIndex]
            cancelNvimMessageExpiry(for: entry.id)
            entry.kind = kind
            entry.text = text
            entry.timestamp = Date()
            nvimMessages[lastIndex] = entry
            scheduleNvimMessageExpiry(id: entry.id, timeout: timeout)
            return
        }

        let entry = NvimMessage(id: UUID(), kind: kind, text: text, timestamp: Date())
        nvimMessages.append(entry)
        if nvimMessages.count > Self.nvimMessageMaxCount {
            let overflow = nvimMessages.count - Self.nvimMessageMaxCount
            let removed = nvimMessages.prefix(overflow)
            for message in removed {
                cancelNvimMessageExpiry(for: message.id)
            }
            nvimMessages.removeFirst(overflow)
        }
        scheduleNvimMessageExpiry(id: entry.id, timeout: timeout)
    }

    private func scheduleNvimMessageExpiry(id: UUID, timeout: TimeInterval?) {
        guard let timeout else { return }
        nvimMessageExpiryTasks[id]?.cancel()
        nvimMessageExpiryTasks[id] = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(timeout * 1_000_000_000))
            guard let self else { return }
            if let index = self.nvimMessages.firstIndex(where: { $0.id == id }) {
                self.nvimMessages.remove(at: index)
            }
            self.nvimMessageExpiryTasks.removeValue(forKey: id)
        }
    }

    private func cancelNvimMessageExpiry(for id: UUID) {
        nvimMessageExpiryTasks[id]?.cancel()
        nvimMessageExpiryTasks.removeValue(forKey: id)
    }

    private func clearNvimMessages() {
        let ids = Array(nvimMessageExpiryTasks.keys)
        for id in ids {
            nvimMessageExpiryTasks[id]?.cancel()
        }
        nvimMessageExpiryTasks.removeAll()
        nvimMessages.removeAll()
    }

    func scrollNvimToTopLine(_ topLine: Int) {
        guard isNvimModeEnabled, let controller = nvimController else { return }
        Task { await controller.scrollToTopLine(topLine) }
    }

    func scrollNvimByLines(_ delta: Int) {
        guard isNvimModeEnabled, let controller = nvimController else { return }
        Task { await controller.scrollByLines(delta) }
    }

    func refreshFileTreeForNewFile(_ url: URL) {
        let canonicalURL = canonicalFileURL(url)
        let parentURL = canonicalURL.deletingLastPathComponent()
        guard let rootDirectory else { return }
        // Only refresh if the file is within the workspace
        guard isURL(canonicalURL, within: rootDirectory) else { return }
        // Check if the file already exists in the tree — if so, nothing to do
        if fileTreeContains(url: canonicalURL, in: fileTree) { return }
        // Reload the parent directory's children in the tree
        let newChildren = FileItem.loadShallowChildren(of: parentURL)
        if parentURL == rootDirectory {
            fileTree = newChildren
        } else {
            var updated = fileTree
            FileItem.replaceChildren(in: &updated, for: parentURL, with: newChildren)
            fileTree = updated
        }
        // Also rebuild the file index for command palette search
        rebuildFileIndex()
    }

    private func reloadFileTree(at folderURL: URL) {
        guard let rootDirectory else { return }
        let children = FileItem.loadShallowChildren(of: folderURL)
        if folderURL == rootDirectory {
            fileTree = children
        } else {
            var updated = fileTree
            FileItem.replaceChildren(in: &updated, for: folderURL, with: children)
            fileTree = updated
        }
        rebuildFileIndex()
    }

    private func updateOpenFilesForFileRename(from oldURL: URL, to newURL: URL) {
        let oldCanonical = canonicalFileURL(oldURL)
        let newCanonical = canonicalFileURL(newURL)
        if let index = openFiles.firstIndex(of: oldCanonical) {
            openFiles[index] = newCanonical
        }
        if selectedFileURL == oldCanonical {
            selectedFileURL = newCanonical
        }
        if isNonUTF8File(oldCanonical) {
            clearNonUTF8File(oldCanonical)
            markNonUTF8File(newCanonical)
        }
        if let cached = openFileContents.removeValue(forKey: oldCanonical) {
            openFileContents[newCanonical] = cached
        }
        if let saved = savedFileContents.removeValue(forKey: oldCanonical) {
            savedFileContents[newCanonical] = saved
        }
        if nativeDirtyFiles.remove(oldCanonical) != nil {
            nativeDirtyFiles.insert(newCanonical)
        }
    }

    private func updateOpenFilesForFolderRename(from oldURL: URL, to newURL: URL) {
        let oldPath = oldURL.path.hasSuffix("/") ? oldURL.path : oldURL.path + "/"
        let newPath = newURL.path.hasSuffix("/") ? newURL.path : newURL.path + "/"

        openFiles = openFiles.map { url in
            guard url.path.hasPrefix(oldPath) else { return url }
            let suffix = String(url.path.dropFirst(oldPath.count))
            return canonicalFileURL(URL(fileURLWithPath: newPath + suffix))
        }

        if let selectedFileURL, selectedFileURL.path.hasPrefix(oldPath) {
            let suffix = String(selectedFileURL.path.dropFirst(oldPath.count))
            self.selectedFileURL = canonicalFileURL(URL(fileURLWithPath: newPath + suffix))
        }

        func remapKeys(_ input: [URL: String]) -> [URL: String] {
            var output: [URL: String] = [:]
            output.reserveCapacity(input.count)
            for (url, value) in input {
                if url.path.hasPrefix(oldPath) {
                    let suffix = String(url.path.dropFirst(oldPath.count))
                    let updated = canonicalFileURL(URL(fileURLWithPath: newPath + suffix))
                    output[updated] = value
                } else {
                    output[canonicalFileURL(url)] = value
                }
            }
            return output
        }

        openFileContents = remapKeys(openFileContents)
        savedFileContents = remapKeys(savedFileContents)
        nativeDirtyFiles = Set(nativeDirtyFiles.map { url in
            guard url.path.hasPrefix(oldPath) else { return canonicalFileURL(url) }
            let suffix = String(url.path.dropFirst(oldPath.count))
            return canonicalFileURL(URL(fileURLWithPath: newPath + suffix))
        })
        if !nonUTF8Files.isEmpty {
            let updatedNonUTF8 = nonUTF8Files.map { url -> URL in
                let path = url.path
                guard path.hasPrefix(oldPath) else { return url }
                let suffix = String(path.dropFirst(oldPath.count))
                return canonicalFileURL(URL(fileURLWithPath: newPath + suffix))
            }
            nonUTF8Files = Set(updatedNonUTF8.map { $0.standardizedFileURL })
        }
    }

    private func closeOpenFiles(in folderURL: URL) {
        let prefix = folderURL.path.hasSuffix("/") ? folderURL.path : folderURL.path + "/"
        let targets = openFiles.filter { $0.path.hasPrefix(prefix) }
        for url in targets {
            requestCloseFile(url)
        }
    }

    private func promptForName(title: String, message: String, defaultValue: String? = nil) -> String? {
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = message
        let input = NSTextField(frame: NSRect(x: 0, y: 0, width: 240, height: 22))
        if let defaultValue {
            input.stringValue = defaultValue
        }
        alert.accessoryView = input
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Cancel")
        let response = alert.runModal()
        guard response == .alertFirstButtonReturn else { return nil }
        let trimmed = input.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    private func fileTreeContains(url: URL, in items: [FileItem]) -> Bool {
        for item in items {
            if item.id == url { return true }
            if let children = item.children, fileTreeContains(url: url, in: children) {
                return true
            }
        }
        return false
    }

    func handleNvimBufferDelete(url: URL) {
        let canonicalURL = canonicalFileURL(url)
        guard let index = openFiles.firstIndex(of: canonicalURL) else { return }
        openFiles.remove(at: index)
        openFileContents.removeValue(forKey: canonicalURL)
        savedFileContents.removeValue(forKey: canonicalURL)
        nativeDirtyFiles.remove(canonicalURL)
        clearNonUTF8File(canonicalURL)
        nvimModifiedBuffers.removeAll { $0.url?.standardizedFileURL == canonicalURL }
        if selectedFileURL == canonicalURL {
            selectedFileURL = nil
            currentLanguage = nil
            setEditorText("")
        }
        if nvimCurrentFilePath == canonicalURL.path {
            nvimCurrentFilePath = nil
        }
    }

    func handleNvimBufferDeleted(buffer: Int64) {
        nvimModifiedBuffers.removeAll { $0.buffer == buffer }
    }

    func setNvimModifiedBuffers(_ buffers: [NvimModifiedBuffer]) {
        if buffers.isEmpty {
            nvimModifiedBuffers = []
            return
        }
        var unique: [NvimModifiedBuffer] = []
        unique.reserveCapacity(buffers.count)
        var seen = Set<Int64>()
        for buffer in buffers {
            if buffer.buffer != 0 {
                if seen.contains(buffer.buffer) { continue }
                seen.insert(buffer.buffer)
            }
            unique.append(buffer)
        }
        nvimModifiedBuffers = unique
    }

    func setNvimFloatingWindows(_ windows: [NvimFloatingWindow]) {
        if windows != nvimFloatingWindows {
            nvimFloatingWindows = windows
        }
    }

    func handleNvimBufferModified(
        buffer: Int64?,
        name: String,
        listed: Bool,
        url: URL?,
        modified: Bool
    ) {
        let bufferId = buffer ?? 0
        let entry = NvimModifiedBuffer(buffer: bufferId, name: name, listed: listed, url: url)
        updateModifiedEntry(entry, modified: modified)
        if modified, let url {
            updateRecentEdit(for: canonicalFileURL(url))
        }
    }

    func handleNvimBufferWrite(url: URL) {
        refreshFileTreeForNewFile(url)
        snapshotOnSaveIfEnabled(url: url.standardizedFileURL)
    }

    func handleNvimModeChange(rawMode: String) {
        guard isNvimModeEnabled else { return }
        let mapped = Self.mapNvimMode(rawMode)
        if nvimMode != mapped {
            nvimMode = mapped
        }
    }

    private static func mapNvimMode(_ mode: String) -> NvimModeKind {
        let trimmed = mode.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return .normal }
        let lower = trimmed.lowercased()
        if lower.hasPrefix("i") || lower.hasPrefix("r") || lower.hasPrefix("t") {
            return .insert
        }
        if lower.hasPrefix("c") {
            return .command
        }
        if lower.hasPrefix("v") || lower.hasPrefix("s") {
            return .visual
        }
        if trimmed == "\u{16}" || trimmed == "\u{13}" {
            return .visual
        }
        return .normal
    }

    func isNvimBufferModified(_ url: URL) -> Bool {
        let normalized = url.standardizedFileURL
        return nvimModifiedBuffers.contains { $0.url?.standardizedFileURL == normalized }
    }

    private func markNonUTF8File(_ url: URL) {
        nonUTF8Files.insert(url.standardizedFileURL)
    }

    private func clearNonUTF8File(_ url: URL) {
        nonUTF8Files.remove(url.standardizedFileURL)
    }

    private func isNonUTF8File(_ url: URL) -> Bool {
        nonUTF8Files.contains(url.standardizedFileURL)
    }

    nonisolated private static func loadUTF8Text(from url: URL) -> (text: String, isUTF8: Bool) {
        guard let data = try? Data(contentsOf: url) else {
            return ("", true)
        }
        if data.isEmpty {
            return ("", true)
        }
        if let text = String(data: data, encoding: .utf8) {
            return (text, true)
        }
        return (nonUTF8Placeholder, false)
    }

    private func isNativeFileModified(_ url: URL) -> Bool {
        guard !isNonUTF8File(url) else { return false }
        let canonical = canonicalFileURL(url)
        return nativeDirtyFiles.contains(canonical)
    }

    private func updateModifiedEntry(_ entry: NvimModifiedBuffer, modified: Bool) {
        if modified {
            if entry.buffer != 0, let index = nvimModifiedBuffers.firstIndex(where: { $0.buffer == entry.buffer }) {
                nvimModifiedBuffers[index] = entry
                return
            }
            if let url = entry.url,
               let index = nvimModifiedBuffers.firstIndex(where: { $0.url?.standardizedFileURL == url.standardizedFileURL }) {
                nvimModifiedBuffers[index] = entry
                return
            }
            nvimModifiedBuffers.append(entry)
            return
        }

        if entry.buffer != 0 {
            nvimModifiedBuffers.removeAll { $0.buffer == entry.buffer }
            return
        }
        if let url = entry.url {
            nvimModifiedBuffers.removeAll { $0.url?.standardizedFileURL == url.standardizedFileURL }
            return
        }
        let trimmed = entry.name.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmed.isEmpty {
            nvimModifiedBuffers.removeAll { $0.name == trimmed }
        }
    }

    func applyNvimHighlights(_ highlights: [String: NvimHighlightColors]) {
        let nextTheme = AppTheme.fromNvimHighlights(highlights)
        if nextTheme != preferences.theme {
            preferences.theme = nextTheme
        }
    }

    func toggleNvimMode() {
        if isNvimModeEnabled {
            disableNvimMode()
        } else {
            enableNvimMode()
        }
    }

    func isChatURL(_ url: URL) -> Bool {
        url.scheme == Self.chatScheme
    }

    func isMainChatURL(_ url: URL) -> Bool {
        chatId(for: url) == Self.mainChatId
    }

    func chatId(for url: URL) -> String? {
        guard isChatURL(url) else { return nil }
        if let host = url.host, !host.isEmpty {
            return host
        }
        let path = url.path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        return path.isEmpty ? nil : path
    }

    private static func chatURL(for id: String) -> URL {
        URL(string: "\(chatScheme)://\(id)")!
    }

    func isRegularFileURL(_ url: URL) -> Bool {
        !isChatURL(url) && !isTerminalURL(url) && !isDiffURL(url) && !isWebviewURL(url)
    }

    func isFileModified(_ url: URL) -> Bool {
        guard isRegularFileURL(url) else { return false }
        if isNvimModeEnabled {
            return isNvimBufferModified(url)
        }
        return isNativeFileModified(url)
    }

    func isTerminalURL(_ url: URL) -> Bool {
        url.scheme == Self.terminalScheme
    }

    func isDiffURL(_ url: URL) -> Bool {
        url.scheme == Self.diffScheme
    }

    func isWebviewURL(_ url: URL) -> Bool {
        url.scheme == Self.webviewScheme
    }

    func diffTab(for url: URL) -> DiffTab? {
        diffTabs[url]
    }

    func webviewTab(for url: URL) -> WebviewTab? {
        webviewTabs[url]
    }

    func webviewView(for url: URL) -> WKWebView? {
        if let view = webviewViews[url] {
            return view
        }
        if let tab = webviewTabs[url] {
            return ensureWebview(for: tab)
        }
        return nil
    }

    func saveAllFiles() {
        if isNvimModeEnabled {
            enqueueNvimSave { controller in
                try await controller.saveAll()
                return "Saved all"
            }
            return
        }
        saveAllNativeFiles()
    }

    func saveCurrentFile() {
        guard let selectedFileURL, isRegularFileURL(selectedFileURL) else { return }
        if isNvimModeEnabled {
            enqueueNvimSave { controller in
                try await controller.saveCurrent()
                return "Saved"
            }
            return
        }
        saveNativeFile(selectedFileURL, notify: true)
    }

    private func enqueueNvimSave(_ operation: @escaping (NvimController) async throws -> String) {
        let previous = nvimSaveTask
        nvimSaveTask = Task { @MainActor [weak self] in
            _ = await previous?.result
            guard let self else { return }
            guard !Task.isCancelled, self.isNvimModeEnabled else { return }
            if nvimFailure != nil {
                self.showToast("Restart Neovim to save")
                return
            }
            let controller: NvimController
            do {
                controller = try await self.ensureNvimStarted()
            } catch {
                if case NvimModeError.recoveryRequired = error {
                    return
                }
                self.handleNvimStartFailure(error)
                return
            }
            do {
                let message = try await operation(controller)
                let buffers = try await controller.listModifiedBuffers()
                self.setNvimModifiedBuffers(buffers)
                self.showToast(message)
            } catch {
                if error is NvimRPCError || error is NvimController.ControllerError {
                    self.handleNvimRuntimeFailure(error, message: "Neovim exited unexpectedly.")
                } else {
                    self.appendErrorMessage("Save failed: \(error.localizedDescription)")
                    self.showToast("Save failed")
                }
            }
        }
    }

    private func saveAllNativeFiles() {
        var skippedNonUTF8 = false
        var targets: [(URL, String)] = []
        targets.reserveCapacity(openFiles.count)
        for url in openFiles where isRegularFileURL(url) {
            let canonical = canonicalFileURL(url)
            if isNonUTF8File(canonical) {
                skippedNonUTF8 = true
                continue
            }
            guard nativeDirtyFiles.contains(canonical) else { continue }
            guard let content = openFileContents[canonical]
                ?? (selectedFileURL == canonical ? editorText : nil)
            else { continue }
            targets.append((canonical, content))
        }
        guard !targets.isEmpty else {
            if skippedNonUTF8 {
                showToast("Skipped non-UTF-8 files")
            } else {
                showToast("No changes to save")
            }
            return
        }

        Task.detached(priority: .userInitiated) { [targets, skippedNonUTF8] in
            var successes: [(URL, String)] = []
            var failures: [(URL, Error)] = []
            successes.reserveCapacity(targets.count)
            for (url, content) in targets {
                do {
                    try content.write(to: url, atomically: true, encoding: .utf8)
                    successes.append((url, content))
                } catch {
                    failures.append((url, error))
                }
            }
            await MainActor.run { [weak self] in
                guard let self else { return }
                for (url, content) in successes {
                    self.savedFileContents[url] = content
                    let current = self.openFileContents[url]
                        ?? (self.selectedFileURL == url ? self.editorText : nil)
                    if current == content {
                        self.openFileContents[url] = content
                        self.clearNativeDirty(url)
                    }
                }
                if !successes.isEmpty {
                    self.updateWindowTitle()
                }
                for (url, error) in failures {
                    self.appendErrorMessage("Failed to save \(self.displayPath(for: url)): \(error.localizedDescription)")
                }
                if !failures.isEmpty {
                    self.showToast("Save failed for some files")
                } else if skippedNonUTF8 {
                    self.showToast("Skipped non-UTF-8 files")
                } else {
                    self.showToast("Saved all")
                }
            }
        }
    }

    private func saveNativeFile(_ url: URL, notify: Bool) {
        let canonical = canonicalFileURL(url)
        if isNonUTF8File(canonical) {
            if notify {
                showToast("Cannot save non-UTF-8 file")
            }
            return
        }
        let content = openFileContents[canonical]
            ?? (selectedFileURL == canonical ? editorText : nil)
        guard let content else { return }
        if !nativeDirtyFiles.contains(canonical) {
            if notify {
                showToast("No changes to save")
            }
            return
        }
        Task.detached(priority: .userInitiated) { [content, canonical, notify] in
            do {
                try content.write(to: canonical, atomically: true, encoding: .utf8)
                await MainActor.run { [weak self] in
                    guard let self else { return }
                    self.savedFileContents[canonical] = content
                    let current = self.openFileContents[canonical]
                        ?? (self.selectedFileURL == canonical ? self.editorText : nil)
                    if current == content {
                        self.openFileContents[canonical] = content
                        self.clearNativeDirty(canonical)
                    }
                    self.updateWindowTitle()
                    if notify {
                        self.showToast("Saved")
                    }
                    self.snapshotOnSaveIfEnabled(url: canonical)
                }
            } catch {
                await MainActor.run { [weak self] in
                    guard let self else { return }
                    self.appendErrorMessage("Failed to save \(self.displayPath(for: canonical)): \(error.localizedDescription)")
                    if notify {
                        self.showToast("Save failed")
                    }
                }
            }
        }
    }

    private func toggleAutoSave() {
        isAutoSaveEnabled.toggle()
    }

    private func setAutoSaveInterval(_ interval: TimeInterval) {
        autoSaveInterval = interval
    }

    private func openFileInNvim(_ url: URL, line: Int?, column: Int?) {
        let canonicalURL = canonicalFileURL(url)
        Self.debugLog("[WorkspaceState] openFileInNvim: \(canonicalURL.path)")
        if !openFiles.contains(canonicalURL) {
            openFiles.append(canonicalURL)
        }
        selectedFileURL = canonicalURL
        currentLanguage = nil
        setEditorText("")
        Task { [weak self] in
            guard let self else { return }
            let controller: NvimController
            do {
                controller = try await self.ensureNvimStarted()
            } catch {
                if case NvimModeError.recoveryRequired = error {
                    return
                }
                self.handleNvimStartFailure(error)
                return
            }
            do {
                Self.debugLog("[WorkspaceState] openFileInNvim: calling openFile")
                try await controller.openFile(canonicalURL, line: line, column: column)
                Self.debugLog("[WorkspaceState] openFileInNvim: openFile completed OK")
            } catch {
                Self.debugLog("[WorkspaceState] openFileInNvim error: \(error)")
                if error is NvimRPCError || error is NvimController.ControllerError {
                    self.handleNvimRuntimeFailure(error, message: "Neovim exited unexpectedly.")
                } else {
                    self.appendErrorMessage("Neovim error: \(error.localizedDescription)")
                }
            }
        }
    }

    private func enableNvimMode() {
        if rootDirectory == nil {
            guard let url = promptForFolderURL() else { return }
            openDirectory(url, restoreSession: true)
        }
        isNvimModeEnabled = true
        nvimMode = .normal
        clearNvimFailure()
        maybeHideWindowForNvimStart()
        Task { [weak self] in
            guard let self else { return }
            do {
                _ = try await self.ensureNvimStarted(force: true)
            } catch {
                self.handleNvimStartFailure(error)
            }
        }
    }

    private func disableNvimMode() {
        isNvimModeEnabled = false
        clearNvimFailure()
        stopNvim()
        preferences.theme = .default
        if let selectedFileURL, isRegularFileURL(selectedFileURL) {
            selectFile(selectedFileURL)
        }
    }

    private func ensureNvimStarted(force: Bool = false) async throws -> NvimController {
        if let controller = nvimController, nvimStartTask == nil {
            return controller
        }
        if let task = nvimStartTask {
            return try await task.value
        }
        if nvimFailure != nil && !force {
            throw NvimModeError.recoveryRequired
        }
        if force {
            clearNvimFailure()
        }
        maybeHideWindowForNvimStart()

        let logURL = makeNvimLogFileURL()
        nvimLogFileURL = logURL
        let task = Task { [weak self] () throws -> NvimController in
            guard let self else { throw CancellationError() }
            guard let rootDirectory = self.rootDirectory else {
                throw NvimModeError.missingWorkspace
            }

            let nvimPath = try self.resolveNvimPath()
            let controller = NvimController(
                workspace: self,
                ghosttyApp: self.ghosttyApp,
                workingDirectory: rootDirectory.path,
                nvimPath: nvimPath,
                optionAsMeta: preferences.optionAsMeta,
                logFilePath: logURL?.path
            )
            self.nvimController = controller
            self.nvimTerminalView = controller.terminalView
            controller.terminalView.onClose = { [weak self] in
                Task { @MainActor in
                    self?.handleNvimTerminalClosed()
                }
            }
            try await controller.start()
            return controller
        }

        nvimStartTask = task
        do {
            let controller = try await task.value
            nvimStartTask = nil
            return controller
        } catch {
            nvimStartTask = nil
            nvimController = nil
            nvimTerminalView = nil
            throw error
        }
    }

    private func stopNvim() {
        nvimSaveTask?.cancel()
        nvimSaveTask = nil
        nvimStartTask?.cancel()
        nvimStartTask = nil
        nvimSettingsSyncTask?.cancel()
        nvimSettingsSyncTask = nil
        nvimTerminalView?.onClose = nil
        nvimController?.stop()
        nvimController = nil
        nvimTerminalView = nil
        nvimCurrentFilePath = nil
        nvimViewport = nil
        nvimModifiedBuffers = []
        nvimFloatingWindows = []
        nvimGridMetrics = nil
        nvimCmdlineState = .empty
        nvimPopupMenuState = .empty
        clearNvimMessages()
        nvimMiniStatusTask?.cancel()
        nvimMiniStatusTask = nil
        nvimMiniMessageState = .empty
        nvimMode = .normal
        updateWindowTitle()
        showWindowAfterNvimReady()
    }

    private func handleNvimTerminalClosed() {
        guard isNvimModeEnabled else { return }
        if nvimFailure != nil { return }
        if nvimStartTask != nil {
            handleNvimStartFailure(NvimModeError.startupExited)
        } else {
            handleNvimRuntimeFailure(nil, message: "Neovim exited unexpectedly.")
        }
    }

    func handleNvimReady() {
        showWindowAfterNvimReady()
        scheduleNvimSettingsSync()
    }

    func makeOpenFileURL(path: String, line: Int?, column: Int?) -> URL? {
        guard let fileURL = resolveFileURL(path: path) else { return nil }
        var components = URLComponents()
        components.scheme = Self.openFileScheme
        components.host = "open"
        var items = [URLQueryItem(name: "path", value: fileURL.path)]
        if let line {
            items.append(URLQueryItem(name: "line", value: String(line)))
        }
        if let column {
            items.append(URLQueryItem(name: "column", value: String(column)))
        }
        components.queryItems = items
        return components.url
    }

    func handleOpenURL(_ url: URL) -> Bool {
        guard let scheme = url.scheme else { return false }
        guard scheme == Self.openFileScheme || scheme == Self.legacyOpenFileScheme else { return false }
        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return false }
        if let host = components.host, host.lowercased() != "open" {
            return false
        }
        if components.host == nil && !components.path.isEmpty && components.path.lowercased() != "/open" {
            return false
        }
        guard let pathValue = components.queryItems?.first(where: { $0.name == "path" })?.value else { return false }
        guard let resolved = resolvePathURL(path: pathValue, allowDirectory: true) else { return false }
        var isDir: ObjCBool = false
        let isDirectory = FileManager.default.fileExists(atPath: resolved.path, isDirectory: &isDir) && isDir.boolValue
        let line = components.queryItems?.first(where: { $0.name == "line" })?.value.flatMap(Int.init)
        let column = components.queryItems?.first(where: { $0.name == "column" })?.value.flatMap(Int.init)
        let normalizedLine = isDirectory ? nil : line.flatMap { $0 > 0 ? $0 : nil }
        let normalizedColumn = normalizedLine == nil ? nil : column.flatMap { $0 > 0 ? $0 : nil }
        handleExternalOpen(requests: [ExternalOpenRequest(url: resolved, line: normalizedLine, column: normalizedColumn)])
        return true
    }

    func openSearchResult(_ result: SearchResult, match: SearchMatch) {
        openFileAtLocation(result.url, line: match.lineNumber, column: match.column, length: match.matchLength)
    }

    func openFileAtLocation(_ url: URL, line: Int, column: Int, length: Int = 0) {
        let canonicalURL = canonicalFileURL(url)
        if isNvimModeEnabled {
            if selectedFileURL != canonicalURL {
                suppressSelectionSync = true
            }
            openFileInNvim(canonicalURL, line: line, column: column)
            return
        }
        selectFile(canonicalURL)
        pendingSelection = EditorSelection(url: canonicalURL, line: line, column: column, length: length)
    }

    func closeSelectedTab() {
        guard let selectedFileURL else { return }
        requestCloseFile(selectedFileURL)
    }

    func closeOtherTabs() {
        guard let selectedFileURL else { return }
        let tabs = openFiles.filter { $0 != selectedFileURL }
        for url in tabs {
            requestCloseFile(url)
        }
    }

    func closeAllExcept(_ url: URL) {
        let tabs = openFiles.filter { $0 != url }
        for tab in tabs {
            requestCloseFile(tab)
        }
    }

    func closeAllTabs() {
        let tabs = openFiles
        for url in tabs {
            requestCloseFile(url)
        }
    }

    func closeTabsToRight(of url: URL) {
        guard let index = openFiles.firstIndex(of: url) else { return }
        let startIndex = openFiles.index(after: index)
        guard startIndex < openFiles.endIndex else { return }
        let tabs = Array(openFiles[startIndex...])
        for tab in tabs {
            requestCloseFile(tab)
        }
    }

    func moveTab(from source: URL, to target: URL) {
        guard source != target,
              let fromIndex = openFiles.firstIndex(of: source),
              let toIndex = openFiles.firstIndex(of: target)
        else { return }
        var tabs = openFiles
        tabs.remove(at: fromIndex)
        let adjustedIndex = toIndex > fromIndex ? max(0, toIndex - 1) : toIndex
        tabs.insert(source, at: adjustedIndex)
        openFiles = tabs
    }

    func copyFilePath(_ url: URL) {
        let pasteboard = NSPasteboard.general
        pasteboard.clearContents()
        pasteboard.setString(url.path, forType: .string)
        showToast("Path copied")
    }

    func copyRelativeFilePath(_ url: URL) {
        let path = displayPath(for: url)
        let pasteboard = NSPasteboard.general
        pasteboard.clearContents()
        pasteboard.setString(path, forType: .string)
        showToast("Relative path copied")
    }

    func revealInFinder(_ url: URL) {
        NSWorkspace.shared.activateFileViewerSelecting([url])
    }

    func revealSelectedFileInFinder() {
        guard let selectedFileURL, isRegularFileURL(selectedFileURL) else { return }
        NSWorkspace.shared.activateFileViewerSelecting([selectedFileURL])
    }

    func copySelectedFilePath() {
        guard let selectedFileURL, isRegularFileURL(selectedFileURL) else { return }
        let pasteboard = NSPasteboard.general
        pasteboard.clearContents()
        pasteboard.setString(selectedFileURL.path, forType: .string)
        showToast("Path copied")
    }

    func selectNextTab() {
        guard !openFiles.isEmpty else { return }
        if let selectedFileURL, let index = openFiles.firstIndex(of: selectedFileURL) {
            let nextIndex = (index + 1) % openFiles.count
            selectFile(openFiles[nextIndex])
        } else {
            selectFile(openFiles[0])
        }
    }

    func selectPreviousTab() {
        guard !openFiles.isEmpty else { return }
        if let selectedFileURL, let index = openFiles.firstIndex(of: selectedFileURL) {
            let prevIndex = (index - 1 + openFiles.count) % openFiles.count
            selectFile(openFiles[prevIndex])
        } else {
            selectFile(openFiles[0])
        }
    }

    func selectTab(index: Int) {
        guard index >= 0, index < openFiles.count else { return }
        selectFile(openFiles[index])
    }

    var isCommandMode: Bool {
        fileSearchQuery.hasPrefix(">")
    }

    func showCommandPalette() {
        guard rootDirectory != nil else {
            openFolderPanel()
            return
        }
        if fileIndex.isEmpty {
            rebuildFileIndex()
        }
        fileSearchQuery = ""
        isCommandPalettePresented = true
        scheduleSearch()
    }

    func hideCommandPalette() {
        isCommandPalettePresented = false
    }

    func showSearchPanel() {
        guard rootDirectory != nil else {
            openFolderPanel()
            return
        }
        isSearchPresented = true
        searchErrorMessage = nil
        scheduleSearchInFiles()
    }

    func hideSearchPanel() {
        isSearchPresented = false
        clearSearchPreview()
    }

    func toggleShortcutsPanel() {
        isShortcutsPanelVisible.toggle()
    }

    func toggleSidebarVisibility() {
        withAnimation(.easeInOut(duration: 0.2)) {
            sidebarVisibility = sidebarVisibility == .detailOnly ? .doubleColumn : .detailOnly
        }
    }

    func updateSearchPreview(result: SearchResult, match: SearchMatch) {
        searchPreviewTask?.cancel()
        searchPreviewToken += 1
        let token = searchPreviewToken
        let targetURL = result.url
        let displayPath = result.displayPath
        let lineNumber = match.lineNumber
        let fallbackLine = match.lineText
        searchPreviewTask = Task.detached(priority: .userInitiated) {
            if Task.isCancelled { return }
            let preview = Self.buildSearchPreview(
                url: targetURL,
                displayPath: displayPath,
                lineNumber: lineNumber,
                fallbackLine: fallbackLine
            )
            if Task.isCancelled { return }
            await MainActor.run { [weak self] in
                guard let self, token == self.searchPreviewToken else { return }
                self.searchPreview = preview
            }
        }
    }

    func clearSearchPreview() {
        searchPreviewTask?.cancel()
        searchPreviewTask = nil
        searchPreviewToken += 1
        searchPreview = nil
    }

    func expandFolder(_ item: FileItem) {
        guard item.needsLoading else { return }
        let children = FileItem.loadShallowChildren(of: item.id)
        var updated = fileTree
        FileItem.replaceChildren(in: &updated, for: item.id, with: children)
        fileTree = updated
    }

    func createFile(in folder: URL) {
        let panel = NSSavePanel()
        panel.directoryURL = folder
        panel.canCreateDirectories = true
        panel.nameFieldStringValue = "untitled.txt"
        if panel.runModal() == .OK, let url = panel.url {
            let success = FileManager.default.createFile(atPath: url.path, contents: Data())
            if success {
                refreshFileTreeForNewFile(url)
                showToast("File created")
            } else {
                appendErrorMessage("Failed to create file.")
            }
        }
    }

    func createFolder(in folder: URL) {
        guard let name = promptForName(title: "New Folder", message: "Enter a folder name.") else { return }
        let url = folder.appendingPathComponent(name)
        do {
            try FileManager.default.createDirectory(at: url, withIntermediateDirectories: false)
            reloadFileTree(at: folder)
            showToast("Folder created")
        } catch {
            appendErrorMessage("Failed to create folder: \(error.localizedDescription)")
        }
    }

    func renameItem(_ item: FileItem) {
        guard let name = promptForName(
            title: "Rename",
            message: "Enter a new name.",
            defaultValue: item.name
        ) else { return }
        let parent = item.id.deletingLastPathComponent()
        let newURL = parent.appendingPathComponent(name)
        guard newURL != item.id else { return }
        do {
            try FileManager.default.moveItem(at: item.id, to: newURL)
            if item.isFolder {
                updateOpenFilesForFolderRename(from: item.id, to: newURL)
            } else {
                updateOpenFilesForFileRename(from: item.id, to: newURL)
            }
            reloadFileTree(at: parent)
            showToast("Renamed")
        } catch {
            appendErrorMessage("Failed to rename: \(error.localizedDescription)")
        }
    }

    func deleteItem(_ item: FileItem) {
        let alert = NSAlert()
        alert.messageText = "Delete \"\(item.name)\"?"
        alert.informativeText = "This will move the item to the Trash."
        alert.addButton(withTitle: "Delete")
        alert.addButton(withTitle: "Cancel")
        alert.alertStyle = .warning
        let response = alert.runModal()
        guard response == .alertFirstButtonReturn else { return }
        do {
            try FileManager.default.trashItem(at: item.id, resultingItemURL: nil)
            let parent = item.id.deletingLastPathComponent()
            if item.isFolder {
                closeOpenFiles(in: item.id)
            } else {
                requestCloseFile(item.id)
            }
            reloadFileTree(at: parent)
            showToast("Moved to Trash")
        } catch {
            appendErrorMessage("Failed to delete: \(error.localizedDescription)")
        }
    }

    func openInTerminal(_ itemURL: URL) {
        let target = (try? itemURL.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true
            ? itemURL
            : itemURL.deletingLastPathComponent()
        let process = Process()
        process.launchPath = "/usr/bin/open"
        process.arguments = ["-a", "Terminal", target.path]
        try? process.run()
    }

    private func promptForFolderURL() -> URL? {
        let panel = NSOpenPanel()
        panel.canChooseFiles = false
        panel.canChooseDirectories = true
        panel.allowsMultipleSelection = false
        return panel.runModal() == .OK ? panel.url : nil
    }

    func openFolderPanel() {
        guard let url = promptForFolderURL() else { return }
        requestOpenDirectory(url)
    }

    func restoreLastWorkspaceIfNeeded() {
        guard rootDirectory == nil else { return }
        guard let path = UserDefaults.standard.string(forKey: Self.lastWorkspaceKey) else { return }
        let url = URL(fileURLWithPath: path)
        var isDir: ObjCBool = false
        guard FileManager.default.fileExists(atPath: url.path, isDirectory: &isDir),
              isDir.boolValue else { return }
        openDirectory(url, restoreSession: true)
    }

    private func saveLastWorkspace(_ url: URL) {
        UserDefaults.standard.set(url.path, forKey: Self.lastWorkspaceKey)
    }

    func persistSessionState() {
        persistSessionStateNow()
    }

    private func persistSessionStateNow() {
        sessionPersistTask?.cancel()
        sessionPersistTask = nil
        guard let rootDirectory else { return }
        var session = buildSessionState(rootPath: rootDirectory.path)
        session.lastAccessed = Date()
        var map = Self.loadSessionStateMap()
        map[rootDirectory.path] = session
        Self.saveSessionStateMap(map)
    }

    private func persistSessionStateIfNeeded(force: Bool = false) {
        guard force || !suppressSessionPersistence else { return }
        guard rootDirectory != nil else { return }
        if force {
            persistSessionStateNow()
            return
        }
        // Debounce: coalesce rapid changes into a single write after 1.5s
        sessionPersistTask?.cancel()
        sessionPersistTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 1_500_000_000)
            guard let self, !Task.isCancelled else { return }
            self.persistSessionStateNow()
        }
    }

    private func buildSessionState(rootPath: String) -> SessionState {
        var items: [SessionItem] = []
        var selectedIndex: Int?
        items.reserveCapacity(openFiles.count)
        for url in openFiles {
            if isDiffURL(url) || isWebviewURL(url) {
                continue
            }
            if isChatURL(url) {
                items.append(SessionItem(kind: .chat, path: nil, workingDirectory: nil, chatId: chatId(for: url)))
            } else if isTerminalURL(url) {
                let workingDirectory = terminalViews[url]?.pwd ?? rootDirectory?.path
                items.append(SessionItem(kind: .terminal, path: nil, workingDirectory: workingDirectory, chatId: nil))
            } else {
                items.append(SessionItem(kind: .file, path: url.standardizedFileURL.path, workingDirectory: nil, chatId: nil))
            }
            if url == selectedFileURL {
                selectedIndex = items.count - 1
            }
        }
        return SessionState(
            rootPath: rootPath,
            openItems: items,
            selectedIndex: selectedIndex,
            isShortcutsPanelVisible: isShortcutsPanelVisible
        )
    }

    private func restoreSessionStateIfAvailable() -> Bool {
        guard let rootDirectory else { return false }
        let map = Self.loadSessionStateMap()
        guard let session = map[rootDirectory.path] else { return false }
        applySessionState(session)
        return true
    }

    private func applySessionState(_ session: SessionState) {
        guard let rootDirectory, session.rootPath == rootDirectory.path else { return }
        let previousSuppression = suppressSessionPersistence
        suppressSessionPersistence = true
        openFiles = []
        selectedFileURL = nil
        terminalViews = [:]
        terminalCounter = 0
        isShortcutsPanelVisible = session.isShortcutsPanelVisible ?? false
        var selectedURL: URL?
        for (index, item) in session.openItems.enumerated() {
            switch item.kind {
            case .chat:
                let chatId = item.chatId ?? Self.mainChatId
                let chatURL = Self.chatURL(for: chatId)
                _ = ensureChatSession(id: chatId)
                if !openFiles.contains(chatURL) {
                    openFiles.append(chatURL)
                }
                if session.selectedIndex == index {
                    selectedURL = chatURL
                }
            case .terminal:
                let url = URL(string: "\(Self.terminalScheme)://\(terminalCounter)")!
                terminalCounter += 1
                let workingDirectory = item.workingDirectory ?? rootDirectory.path
                let view = GhosttyTerminalView(app: ghosttyApp, workingDirectory: workingDirectory, optionAsMeta: preferences.optionAsMeta)
                view.onClose = { [weak self] in
                    Task { @MainActor in
                        self?.closeFile(url)
                    }
                }
                terminalViews[url] = view
                openFiles.append(url)
                if session.selectedIndex == index {
                    selectedURL = url
                }
            case .file:
                guard let path = item.path else { continue }
                let url = URL(fileURLWithPath: path).standardizedFileURL
                var isDir: ObjCBool = false
                guard FileManager.default.fileExists(atPath: url.path, isDirectory: &isDir),
                      !isDir.boolValue else { continue }
                openFiles.append(url)
                if session.selectedIndex == index {
                    selectedURL = url
                }
            }
        }

        if let selectedURL {
            if isChatURL(selectedURL) {
                selectChat(selectedURL)
            } else {
                selectFile(selectedURL)
            }
        } else if let first = openFiles.first {
            if isChatURL(first) {
                selectChat(first)
            } else {
                selectFile(first)
            }
        } else {
            selectedFileURL = nil
            currentLanguage = nil
            setEditorText("")
        }
        suppressSessionPersistence = previousSuppression
    }

    private static func loadSessionStateMap() -> [String: SessionState] {
        guard let data = UserDefaults.standard.data(forKey: Self.sessionStateKey) else { return [:] }
        return (try? JSONDecoder().decode([String: SessionState].self, from: data)) ?? [:]
    }

    private static func saveSessionStateMap(_ map: [String: SessionState]) {
        var map = map
        if map.count > maxSessionEntries {
            let sorted = map.sorted { ($0.value.lastAccessed ?? .distantPast) < ($1.value.lastAccessed ?? .distantPast) }
            let excess = map.count - maxSessionEntries
            for (key, _) in sorted.prefix(excess) {
                map.removeValue(forKey: key)
            }
        }
        guard let data = try? JSONEncoder().encode(map) else { return }
        UserDefaults.standard.set(data, forKey: Self.sessionStateKey)
    }

    private func addRecentFile(_ url: URL) {
        let normalized = url.standardizedFileURL
        recentFileURLs.removeAll { $0.standardizedFileURL == normalized }
        recentFileURLs.insert(normalized, at: 0)
        if recentFileURLs.count > Self.maxRecentItems {
            recentFileURLs = Array(recentFileURLs.prefix(Self.maxRecentItems))
        }
        persistRecentURLs()
        refreshRecentEntries()
    }

    private func addRecentFolder(_ url: URL) {
        let normalized = url.standardizedFileURL
        recentFolderURLs.removeAll { $0.standardizedFileURL == normalized }
        recentFolderURLs.insert(normalized, at: 0)
        if recentFolderURLs.count > Self.maxRecentItems {
            recentFolderURLs = Array(recentFolderURLs.prefix(Self.maxRecentItems))
        }
        persistRecentURLs()
        refreshRecentEntries()
    }

    private func refreshRecentEntries() {
        recentFileEntries = recentFileURLs.compactMap { url in
            guard fileExists(at: url, isDirectory: false) else { return nil }
            let displayPath = recentDisplayPath(for: url)
            return FileIndexEntry(url: url, displayPath: displayPath)
        }
        recentFolderEntries = recentFolderURLs.compactMap { url in
            guard fileExists(at: url, isDirectory: true) else { return nil }
            return RecentFolderEntry(id: url, url: url, displayPath: Self.abbreviatedPath(url.path))
        }
    }

    private func updateRecentEdit(for url: URL) {
        let normalized = url.standardizedFileURL
        recentEditTimestamps[normalized] = Date()
        scheduleRecentEditRefresh()
    }

    private func scheduleRecentEditRefresh() {
        recentEditRefreshTask?.cancel()
        recentEditRefreshTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 300_000_000)
            guard let self, !Task.isCancelled else { return }
            self.refreshRecentEditEntries()
        }
    }

    private func refreshRecentEditEntries() {
        var entries: [RecentEditEntry] = []
        entries.reserveCapacity(Self.maxRecentEdits)
        let sorted = recentEditTimestamps.sorted { $0.value > $1.value }
        var urlsToRemove: [URL] = []
        for (url, date) in sorted {
            guard fileExists(at: url, isDirectory: false) else {
                urlsToRemove.append(url)
                continue
            }
            let displayPath = recentDisplayPath(for: url)
            entries.append(RecentEditEntry(id: url, url: url, displayPath: displayPath, lastEdited: date))
            if entries.count >= Self.maxRecentEdits {
                break
            }
        }
        for url in urlsToRemove {
            recentEditTimestamps.removeValue(forKey: url)
        }
        recentEditEntries = entries
    }

    private func recentDisplayPath(for url: URL) -> String {
        guard let rootDirectory else { return url.path }
        let rootPath = rootDirectory.path
        let fullPath = url.path
        let prefix = rootPath.hasSuffix("/") ? rootPath : "\(rootPath)/"
        if fullPath.hasPrefix(prefix) {
            return String(fullPath.dropFirst(prefix.count))
        }
        return fullPath
    }

    private func fileExists(at url: URL, isDirectory: Bool) -> Bool {
        var isDir: ObjCBool = false
        guard FileManager.default.fileExists(atPath: url.path, isDirectory: &isDir) else { return false }
        return isDir.boolValue == isDirectory
    }

    private func persistRecentURLs() {
        let filePaths = recentFileURLs.map { $0.path }
        let folderPaths = recentFolderURLs.map { $0.path }
        UserDefaults.standard.set(filePaths, forKey: Self.recentFilesKey)
        UserDefaults.standard.set(folderPaths, forKey: Self.recentFoldersKey)
    }

    private static func loadRecentURLs(key: String) -> [URL] {
        guard let paths = UserDefaults.standard.array(forKey: key) as? [String] else { return [] }
        return paths.map { URL(fileURLWithPath: $0).standardizedFileURL }
    }

    func openFilePanel() {
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = false
        if let rootDirectory {
            panel.directoryURL = rootDirectory
        }
        if panel.runModal() == .OK, let url = panel.url {
            selectFile(url)
        }
    }

    func displayPath(for url: URL) -> String {
        if isChatURL(url) {
            return chatTitle(for: url)
        }
        if isTerminalURL(url) {
            return terminalViews[url]?.pwd ?? "Terminal"
        }
        if isDiffURL(url) {
            return diffTabs[url]?.title ?? "Diff"
        }
        if isWebviewURL(url) {
            return webviewTabs[url]?.title ?? "Webview"
        }
        guard let rootDirectory else { return url.lastPathComponent }
        let rootPath = rootDirectory.path
        let fullPath = url.path
        let prefix = rootPath.hasSuffix("/") ? rootPath : "\(rootPath)/"
        if fullPath.hasPrefix(prefix) {
            return String(fullPath.dropFirst(prefix.count))
        }
        return url.lastPathComponent
    }

    private func persistWindowFrameForCurrentWorkspace() {
        guard let window = activeWindow() else { return }
        WindowFrameStore.saveFrame(window.frame, for: rootDirectory)
    }

    func applyWindowFrameForCurrentWorkspace() {
        guard let window = activeWindow() else { return }
        guard let savedFrame = WindowFrameStore.loadFrame(for: rootDirectory) else { return }
        window.setFrame(WindowFrameStore.adjustedFrame(savedFrame), display: true)
    }

    func applyWindowAppearance() {
        guard let window = activeWindow() else { return }
        let prefs = preferences
        if prefs.isWindowTransparencyEnabled {
            let clamped = EditorPreferences.clampWindowOpacity(prefs.windowOpacity)
            if window.alphaValue != clamped {
                window.alphaValue = clamped
            }
            window.isOpaque = false
            window.backgroundColor = .clear
        } else {
            if window.alphaValue != 1.0 {
                window.alphaValue = 1.0
            }
            window.isOpaque = true
            window.backgroundColor = prefs.theme.background
        }
    }

    private func updateWindowTitle() {
        guard let window = activeWindow() else { return }
        let context = buildWindowTitleContext()
        let title = context.title == "Smithers" ? "Smithers" : "\(context.title) - Smithers"
        if window.title != title {
            window.title = title
        }
        if window.representedURL != context.representedURL {
            window.representedURL = context.representedURL
            window.representedFilename = context.representedURL?.path ?? ""
        }
        if window.isDocumentEdited != context.isEdited {
            window.isDocumentEdited = context.isEdited
        }
        if let button = window.standardWindowButton(.documentIconButton) {
            let shouldHide = context.representedURL == nil
            if button.isHidden != shouldHide {
                button.isHidden = shouldHide
            }
            button.toolTip = context.representedURL?.path
        }
    }

    func refreshWindowTitle() {
        updateWindowTitle()
    }

    private func buildWindowTitleContext() -> (title: String, representedURL: URL?, isEdited: Bool) {
        guard let selectedFileURL else {
            return (title: "Smithers", representedURL: nil, isEdited: false)
        }

        if isChatURL(selectedFileURL) {
            return (title: chatTitle(for: selectedFileURL), representedURL: nil, isEdited: false)
        }
        if isTerminalURL(selectedFileURL) {
            let terminalTitle = terminalViews[selectedFileURL]?.title ?? ""
            let title = terminalTitle.isEmpty ? "Terminal" : terminalTitle
            return (title: title, representedURL: nil, isEdited: false)
        }
        if isDiffURL(selectedFileURL) {
            let title = diffTabs[selectedFileURL]?.title ?? "Diff"
            return (title: title, representedURL: nil, isEdited: false)
        }
        if isWebviewURL(selectedFileURL) {
            let title = webviewTabs[selectedFileURL]?.title ?? "Webview"
            return (title: title, representedURL: nil, isEdited: false)
        }

        let fileURL = resolvedCurrentFileURL(fallback: selectedFileURL)
        let title = fileURL.map { displayPath(for: $0) } ?? selectedFileURL.lastPathComponent
        let edited = fileURL.map { isFileModified($0) } ?? false
        let suffix = edited ? "*" : ""
        return (title: "\(title)\(suffix)", representedURL: fileURL, isEdited: edited)
    }

    private func resolvedCurrentFileURL(fallback: URL) -> URL? {
        guard isRegularFileURL(fallback) else { return nil }
        if isNvimModeEnabled, let path = nvimCurrentFilePath, let url = fileURLFromPath(path) {
            return url.standardizedFileURL
        }
        return fallback.standardizedFileURL
    }

    private func fileURLFromPath(_ path: String) -> URL? {
        let trimmed = path.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        guard !trimmed.contains("://") else { return nil }
        if trimmed.hasPrefix("/") {
            return URL(fileURLWithPath: trimmed).standardizedFileURL
        }
        if let rootDirectory {
            return URL(fileURLWithPath: trimmed, relativeTo: rootDirectory).standardizedFileURL
        }
        return URL(fileURLWithPath: trimmed).standardizedFileURL
    }

    private var windowRecoveryTask: Task<Void, Never>?

    func hideWindowForLaunch() {
        guard !windowHiddenForLaunch else { return }
        windowHiddenForLaunch = true
        updateWindowVisibility()
    }

    func showWindowAfterLaunch() {
        guard windowHiddenForLaunch else { return }
        windowHiddenForLaunch = false
        updateWindowVisibility()
    }

    private func maybeHideWindowForNvimStart() {
        guard !windowHiddenForNvim else { return }
        guard nvimController == nil && nvimStartTask == nil else { return }
        windowHiddenForNvim = true
        updateWindowVisibility()
        windowRecoveryTask?.cancel()
        windowRecoveryTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 30_000_000_000)
            guard let self, self.windowHiddenForNvim else { return }
            Self.debugLog("[WorkspaceState] window recovery timeout — forcing show")
            self.showWindowAfterNvimReady()
        }
    }

    private func showWindowAfterNvimReady() {
        guard windowHiddenForNvim else { return }
        windowHiddenForNvim = false
        windowRecoveryTask?.cancel()
        windowRecoveryTask = nil
        updateWindowVisibility()
    }

    private func activeWindow() -> NSWindow? {
        guard let app = NSApp else { return nil }
        return app.windows.first(where: { $0.isKeyWindow || $0.isMainWindow }) ?? app.windows.first
    }

    private func updateWindowVisibility() {
        guard let window = activeWindow() else { return }
        if windowHiddenForNvim || windowHiddenForLaunch {
            window.orderOut(nil)
        } else {
            window.makeKeyAndOrderFront(nil)
        }
    }

    private func scheduleAutoSaveIfNeeded(for url: URL) {
        guard isAutoSaveEnabled else { return }
        guard !isNvimModeEnabled, isRegularFileURL(url) else { return }
        guard !isNonUTF8File(url) else { return }
        autoSaveToken += 1
        let token = autoSaveToken
        let targetURL = canonicalFileURL(url)
        let interval = autoSaveInterval
        autoSaveTask?.cancel()
        autoSaveTask = Task { [weak self] in
            guard let self else { return }
            try? await Task.sleep(nanoseconds: UInt64(interval * 1_000_000_000))
            await MainActor.run {
                guard token == self.autoSaveToken else { return }
                guard self.isNativeFileModified(targetURL) else { return }
                self.saveNativeFile(targetURL, notify: false)
            }
        }
    }

    func setProgress(
        _ value: Double,
        height: CGFloat? = nil,
        fillColor: NSColor? = nil,
        trackColor: NSColor? = nil
    ) {
        if let height {
            progressBarHeight = height
        }
        if let fillColor {
            progressBarFillColor = fillColor
        }
        if let trackColor {
            progressBarTrackColor = trackColor
        }
        let sanitized = value.isFinite ? value : 0
        let clamped = min(max(sanitized, 0), 1)
        progressHideToken += 1
        let token = progressHideToken
        progressHideTask?.cancel()
        progressHideTask = nil
        progressValue = clamped
        if !isProgressBarVisible {
            isProgressBarVisible = true
        }
        if clamped >= 1 {
            progressHideTask = Task { @MainActor [weak self] in
                try? await Task.sleep(nanoseconds: UInt64(Self.progressBarAutoHideDelay * 1_000_000_000))
                guard let self, token == self.progressHideToken else { return }
                self.isProgressBarVisible = false
                self.progressValue = 0
            }
        }
    }

    private static func clampProgressBarHeight(_ value: CGFloat) -> CGFloat {
        min(max(value, progressBarHeightRange.lowerBound), progressBarHeightRange.upperBound)
    }

    private static func loadProgressColor(key: String) -> NSColor? {
        guard let hex = UserDefaults.standard.string(forKey: key) else { return nil }
        return NSColor.fromHex(hex)
    }

    private static func storeProgressColor(_ color: NSColor?, key: String) {
        guard let color else {
            UserDefaults.standard.removeObject(forKey: key)
            return
        }
        if let hex = color.toHexString(includeAlpha: true) {
            UserDefaults.standard.set(hex, forKey: key)
        } else {
            UserDefaults.standard.removeObject(forKey: key)
        }
    }

    private func showToast(_ message: String, duration: TimeInterval = 2.0) {
        toastToken += 1
        let token = toastToken
        toastMessage = message
        toastTask?.cancel()
        toastTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(duration * 1_000_000_000))
            await MainActor.run {
                guard let self, token == self.toastToken else { return }
                self.toastMessage = nil
            }
        }
    }

    @discardableResult
    func showOverlay(
        type: OverlayType,
        message: String,
        title: String?,
        position: OverlayPosition,
        duration: TimeInterval?,
        progress: Double? = nil
    ) -> String {
        overlayToken += 1
        let id = UUID().uuidString
        activeOverlay = OverlayContent(
            id: id,
            type: type,
            message: message,
            title: title,
            position: position,
            progress: progress,
            dismissAfter: duration
        )
        overlayTask?.cancel()
        if let duration, duration > 0 {
            let token = overlayToken
            overlayTask = Task { [weak self] in
                try? await Task.sleep(nanoseconds: UInt64(duration * 1_000_000_000))
                await MainActor.run {
                    guard let self, token == self.overlayToken else { return }
                    self.activeOverlay = nil
                }
            }
        }
        return id
    }

    func dismissOverlay(id: String?) {
        guard let active = activeOverlay else { return }
        if let id, id != active.id {
            return
        }
        overlayTask?.cancel()
        activeOverlay = nil
    }

    private static func abbreviatedPath(_ path: String) -> String {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        let prefix = home.hasSuffix("/") ? home : "\(home)/"
        if path == home {
            return "~"
        }
        if path.hasPrefix(prefix) {
            return "~/" + String(path.dropFirst(prefix.count))
        }
        return path
    }

    private static func formatInterval(_ interval: TimeInterval) -> String {
        let seconds = Int(interval.rounded())
        return "\(seconds)s"
    }

    private static func initialChatMessages() -> [ChatMessage] {
        [
            ChatMessage(
                role: .assistant,
                kind: .starterPrompt(
                    title: "Talk to me to get started!",
                    suggestions: [
                        "What tools and capabilities do you have?",
                        "Help me fix a bug?",
                        "Help me build a ralph script"
                    ]
                )
            )
        ]
    }

    func sendChatMessage() {
        let text = chatDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        let images = chatDraftImages
        guard !text.isEmpty || !images.isEmpty else { return }
        chatDraft = ""
        chatDraftImages = []
        sendChatMessage(text: text, images: images)
    }

    func sendChatMessage(text: String, images: [ChatImage] = []) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty || !images.isEmpty else { return }
        chatMessages.append(ChatMessage(role: .user, kind: .text(trimmed), images: images))
        guard let codexService else {
            appendErrorMessage("Codex service is not running.")
            return
        }
        isTurnInProgress = true
        let skillInputs = buildSkillInstructionInputs()
        Task { [weak self] in
            guard let self else { return }
            do {
                _ = try await codexService.sendMessage(trimmed, images: images, extraInputs: skillInputs)
            } catch {
                self.appendErrorMessage("Failed to send message: \(error.localizedDescription)")
                self.isTurnInProgress = false
            }
        }
    }

    func handleChatImagePaste() -> Bool {
        let pasteboard = NSPasteboard.general
        let images = Self.chatImages(from: pasteboard)
        guard !images.isEmpty else { return false }
        chatDraftImages.append(contentsOf: images)
        return true
    }

    func handleChatImageDrop(providers: [NSItemProvider]) -> Bool {
        var accepted = false
        for provider in providers {
            if provider.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) {
                accepted = true
                provider.loadItem(forTypeIdentifier: UTType.fileURL.identifier, options: nil) { item, _ in
                    guard let url = Self.fileURL(from: item),
                          Self.isSupportedImageURL(url),
                          let image = ChatImage.fromFileURL(url)
                    else { return }
                    Task { @MainActor in
                        self.chatDraftImages.append(image)
                    }
                }
                continue
            }

            if provider.canLoadObject(ofClass: NSImage.self) {
                accepted = true
                _ = provider.loadObject(ofClass: NSImage.self) { object, _ in
                    guard let nsImage = object as? NSImage,
                          let image = ChatImage.fromImage(nsImage)
                    else { return }
                    Task { @MainActor in
                        self.chatDraftImages.append(image)
                    }
                }
            }
        }
        return accepted
    }

    private static func chatImages(from pasteboard: NSPasteboard) -> [ChatImage] {
        guard let items = pasteboard.pasteboardItems else { return [] }
        var images: [ChatImage] = []
        for item in items {
            if let url = imageFileURL(from: item),
               let image = ChatImage.fromFileURL(url) {
                images.append(image)
                continue
            }

            if let data = item.data(forType: .png)
                ?? item.data(forType: .tiff)
                ?? item.data(forType: NSPasteboard.PasteboardType("public.image")),
               let image = ChatImage.fromData(data)
            {
                images.append(image)
                continue
            }
        }
        return images
    }

    private static func imageFileURL(from item: NSPasteboardItem) -> URL? {
        if let urlString = item.string(forType: .fileURL),
           let url = URL(string: urlString),
           isSupportedImageURL(url) {
            return url
        }
        return nil
    }

    nonisolated private static func fileURL(from item: Any?) -> URL? {
        if let url = item as? URL, url.isFileURL {
            return url
        }
        if let data = item as? Data,
           let url = URL(dataRepresentation: data, relativeTo: nil),
           url.isFileURL {
            return url
        }
        if let urlString = item as? String,
           let url = URL(string: urlString),
           url.isFileURL {
            return url
        }
        return nil
    }

    nonisolated private static func isSupportedImageURL(_ url: URL) -> Bool {
        guard url.isFileURL else { return false }
        guard !url.pathExtension.isEmpty else { return false }
        let ext = url.pathExtension.lowercased()
        guard let type = UTType(filenameExtension: ext) else { return false }
        return type.conforms(to: .image)
    }

    func startNewChat() {
        guard !isTurnInProgress else {
            showToast("Wait for the current turn to finish.")
            return
        }
        guard let rootDirectory else { return }
        guard let codexService else {
            appendErrorMessage("Codex service is not running.")
            return
        }
        let root = rootDirectory
        let targetChatId = activeChatId
        resetChatForNewThread()
        openChat(id: targetChatId, title: chatSessions[targetChatId]?.title, select: true)
        Task { @MainActor [weak self] in
            guard let self else { return }
            do {
                let threadId = try await codexService.startNewThread(cwd: root.path)
                self.updateActiveThreadId(threadId)
            } catch {
                self.appendErrorMessage("Failed to start new chat: \(error.localizedDescription)")
            }
        }
    }

    private func resetChatForNewThread() {
        suppressChatHistoryPersistence = true
        chatMessages = Self.initialChatMessages()
        suppressChatHistoryPersistence = false
        chatDraft = ""
        chatDraftImages = []
        isTurnInProgress = false
        activeDiffPreview = nil
        activeSessionDiff = nil
        sessionDiffSnapshot = nil
        diffPreviewIndexByTurnId = [:]
        sessionDiffComputeTask?.cancel()
        sessionDiffComputeTask = nil
        sessionDiffComputeToken += 1
        turnDiffs = [:]
        turnDiffOrder = []
        streamingTurnDiffs = [:]
        turnHistoryOrder = []
        storeActiveChatSessionState()
    }

    func canCopyMessage(_ message: ChatMessage) -> Bool {
        switch message.kind {
        case .starterPrompt:
            return false
        default:
            return true
        }
    }

    func copyChatMessage(_ message: ChatMessage) {
        guard let text = plainText(for: message) else { return }
        let pasteboard = NSPasteboard.general
        pasteboard.clearContents()
        pasteboard.setString(text, forType: .string)
        showToast("Copied to clipboard")
    }

    func canForkMessage(_ message: ChatMessage) -> Bool {
        guard !isTurnInProgress else { return false }
        guard activeThreadId != nil else { return false }
        return message.turnId != nil
    }

    func forkChat(from message: ChatMessage) {
        guard let turnId = message.turnId else {
            showToast("Cannot fork from this message.")
            return
        }
        Task { [weak self] in
            guard let self else { return }
            _ = await self.forkChatInternal(turnId: turnId)
        }
    }

    func canRetryMessage(_ message: ChatMessage) -> Bool {
        guard !isTurnInProgress else { return false }
        guard message.role == .assistant else { return false }
        switch message.kind {
        case .text, .status:
            return true
        default:
            return false
        }
    }

    func retryFromMessage(_ message: ChatMessage) {
        guard !isTurnInProgress else {
            showToast("Wait for the current turn to finish.")
            return
        }
        guard let index = chatMessages.firstIndex(where: { $0.id == message.id }) else { return }
        guard let userMessage = chatMessages[0..<index].last(where: { $0.role == .user }),
              case .text(let text) = userMessage.kind
        else {
            showToast("No user message to retry.")
            return
        }
        sendChatMessage(text: text, images: userMessage.images)
    }

    func canEditMessage(_ message: ChatMessage) -> Bool {
        guard !isTurnInProgress else { return false }
        guard message.role == .user else { return false }
        if case .text = message.kind {
            return true
        }
        return false
    }

    func editAndResendMessage(_ message: ChatMessage) {
        guard !isTurnInProgress else {
            showToast("Wait for the current turn to finish.")
            return
        }
        guard case .text(let text) = message.kind else { return }
        if let turnId = message.turnId, canForkMessage(message) {
            Task { [weak self] in
                guard let self else { return }
                let success = await self.forkChatInternal(turnId: turnId)
                if success {
                    self.chatDraft = text
                    self.chatDraftImages = message.images
                    self.openChat(id: self.activeChatId, title: self.chatSessions[self.activeChatId]?.title, select: true)
                }
            }
        } else {
            chatDraft = text
            chatDraftImages = message.images
            openChat(id: activeChatId, title: chatSessions[activeChatId]?.title, select: true)
        }
    }

    func canRollbackToMessage(_ message: ChatMessage) -> Bool {
        guard !isTurnInProgress else { return false }
        guard activeThreadId != nil else { return false }
        guard let turnId = message.turnId,
              let index = turnHistoryOrder.firstIndex(of: turnId)
        else {
            return false
        }
        let numTurns = turnHistoryOrder.count - index - 1
        return numTurns > 0
    }

    func rollbackChat(to message: ChatMessage) {
        guard !isTurnInProgress else {
            showToast("Wait for the current turn to finish.")
            return
        }
        guard let turnId = message.turnId,
              let currentThreadId = activeThreadId,
              let index = turnHistoryOrder.firstIndex(of: turnId)
        else {
            showToast("Cannot rollback from this message.")
            return
        }
        let numTurns = turnHistoryOrder.count - index - 1
        guard numTurns > 0 else {
            showToast("Already at this point.")
            return
        }
        guard confirmRollback(numTurns: numTurns) else { return }
        guard let codexService else {
            appendErrorMessage("Codex service is not running.")
            return
        }
        Task { [weak self] in
            guard let self else { return }
            do {
                let thread = try await codexService.rollbackThread(threadId: currentThreadId, numTurns: numTurns)
                self.applyThreadHistory(thread)
                self.showToast("Rolled back chat history.")
            } catch {
                self.appendErrorMessage("Failed to rollback: \(error.localizedDescription)")
            }
        }
    }

    private func forkChatInternal(turnId: String) async -> Bool {
        guard !isTurnInProgress else {
            showToast("Wait for the current turn to finish.")
            return false
        }
        guard let rootDirectory else { return false }
        guard let codexService else {
            appendErrorMessage("Codex service is not running.")
            return false
        }
        guard let currentThreadId = activeThreadId else {
            showToast("No active thread to fork.")
            return false
        }
        guard let index = turnHistoryOrder.firstIndex(of: turnId) else {
            showToast("Unable to locate that turn.")
            return false
        }
        let numTurnsToDrop = turnHistoryOrder.count - index - 1
        do {
            let forked = try await codexService.forkThread(threadId: currentThreadId, cwd: rootDirectory.path)
            var finalThread = forked
            if numTurnsToDrop > 0 {
                finalThread = try await codexService.rollbackThread(threadId: forked.id, numTurns: numTurnsToDrop)
            }
            applyThreadHistory(finalThread)
            updateActiveThreadId(finalThread.id)
            openChat(id: activeChatId, title: chatSessions[activeChatId]?.title, select: true)
            if numTurnsToDrop > 0 {
                showToast("Forked chat history. File changes were not reverted.")
            } else {
                showToast("Forked chat.")
            }
            return true
        } catch {
            appendErrorMessage("Failed to fork: \(error.localizedDescription)")
            return false
        }
    }

    private func plainText(for message: ChatMessage) -> String? {
        switch message.kind {
        case .text(let text):
            return text
        case .status(let text):
            return text
        case .command(let info):
            var output = "$ \(info.command)"
            if !info.cwd.isEmpty {
                output += "\n" + "cwd: \(info.cwd)"
            }
            if !info.output.isEmpty {
                output += "\n" + info.output
            }
            if let exitCode = info.exitCode {
                output += "\n" + "exit \(exitCode)"
            }
            return output
        case .diffPreview(let preview):
            return preview.diff
        case .starterPrompt:
            return nil
        }
    }

    private func confirmRollback(numTurns: Int) -> Bool {
        let alert = NSAlert()
        alert.messageText = "Rollback chat to this point?"
        alert.informativeText = "This removes the last \(numTurns) turns from chat history. File changes are not reverted."
        alert.addButton(withTitle: "Rollback")
        alert.addButton(withTitle: "Cancel")
        return alert.runModal() == .alertFirstButtonReturn
    }

    func interruptTurn() {
        guard let codexService else { return }
        Task { [weak self] in
            guard let self else { return }
            do {
                try await codexService.interrupt()
            } catch {
                self.appendErrorMessage("Failed to interrupt: \(error.localizedDescription)")
            }
        }
    }

    func openTerminal() {
        _ = openTerminal(command: nil, cwd: nil)
    }

    @discardableResult
    func openTerminal(command: String?, cwd: String?) -> URL {
        let url = URL(string: "\(Self.terminalScheme)://\(terminalCounter)")!
        terminalCounter += 1
        let workingDirectory = cwd
            ?? rootDirectory?.path
            ?? FileManager.default.homeDirectoryForCurrentUser.path
        let view = GhosttyTerminalView(app: ghosttyApp, workingDirectory: workingDirectory, optionAsMeta: preferences.optionAsMeta)
        view.onClose = { [weak self] in
            Task { @MainActor in
                self?.closeFile(url)
            }
        }
        terminalViews[url] = view
        openFiles.append(url)
        selectedFileURL = url
        currentLanguage = nil
        setEditorText("")
        if let command, !command.isEmpty {
            Task { @MainActor in
                try? await Task.sleep(nanoseconds: 120_000_000)
                view.sendText(command + "\n")
            }
        }
        return url
    }

    // MARK: - Terminal Content Reading

    /// Read viewport text from all open terminals. Keys are terminal URL strings.
    func readAllTerminalViewports() -> [String: String] {
        var result: [String: String] = [:]
        for (url, view) in terminalViews {
            if let text = view.readViewportText() {
                result[url.absoluteString] = text
            }
        }
        return result
    }

    /// Read viewport text from a specific terminal by its URL.
    func readTerminalViewport(for url: URL) -> String? {
        terminalViews[url]?.readViewportText()
    }

    /// Read the full scrollback from a specific terminal by its URL.
    func readTerminalScreen(for url: URL) -> String? {
        terminalViews[url]?.readScreenText()
    }

    private func buildCommandList() -> [PaletteCommand] {
        [
            PaletteCommand(
                id: "toggle-nvim",
                title: isNvimModeEnabled ? "Disable Neovim Mode" : "Enable Neovim Mode",
                icon: "terminal",
                shortcut: "⇧⌘N",
                action: { [weak self] in
                    self?.toggleNvimMode()
                }
            ),
            PaletteCommand(
                id: "toggle-shortcuts",
                title: "Toggle Keyboard Shortcuts",
                icon: "keyboard",
                shortcut: "⌘/",
                action: { [weak self] in
                    self?.toggleShortcutsPanel()
                }
            ),
            PaletteCommand(
                id: "save",
                title: "Save",
                icon: "square.and.arrow.down",
                shortcut: "⌘S",
                action: { [weak self] in
                    self?.saveCurrentFile()
                }
            ),
            PaletteCommand(
                id: "save-all",
                title: "Save All",
                icon: "square.and.arrow.down",
                shortcut: "⇧⌘S",
                action: { [weak self] in
                    self?.saveAllFiles()
                }
            ),
            PaletteCommand(
                id: "toggle-auto-save",
                title: isAutoSaveEnabled ? "Auto Save: On" : "Auto Save: Off",
                icon: "clock.arrow.circlepath",
                shortcut: nil,
                action: { [weak self] in
                    self?.toggleAutoSave()
                }
            ),
            PaletteCommand(
                id: "auto-save-interval-5",
                title: "Auto Save Interval: 5s",
                icon: "timer",
                shortcut: nil,
                action: { [weak self] in
                    self?.setAutoSaveInterval(5)
                }
            ),
            PaletteCommand(
                id: "auto-save-interval-10",
                title: "Auto Save Interval: 10s",
                icon: "timer",
                shortcut: nil,
                action: { [weak self] in
                    self?.setAutoSaveInterval(10)
                }
            ),
            PaletteCommand(
                id: "auto-save-interval-30",
                title: "Auto Save Interval: 30s",
                icon: "timer",
                shortcut: nil,
                action: { [weak self] in
                    self?.setAutoSaveInterval(30)
                }
            ),
            PaletteCommand(
                id: "new-terminal",
                title: "New Terminal",
                icon: "terminal",
                shortcut: "⌘`",
                action: { [weak self] in
                    self?.openTerminal()
                }
            ),
            PaletteCommand(
                id: "open-folder",
                title: "Open Folder...",
                icon: "folder",
                shortcut: "⇧⌘O",
                action: { [weak self] in
                    self?.openFolderPanel()
                }
            ),
            PaletteCommand(
                id: "search-in-files",
                title: "Search in Files...",
                icon: "magnifyingglass",
                shortcut: "⇧⌘F",
                action: { [weak self] in
                    self?.showSearchPanel()
                }
            ),
            PaletteCommand(
                id: "close-others",
                title: "Close Other Tabs",
                icon: "xmark",
                shortcut: nil,
                action: { [weak self] in
                    self?.closeOtherTabs()
                }
            ),
            PaletteCommand(
                id: "close-all",
                title: "Close All Tabs",
                icon: "xmark.circle",
                shortcut: nil,
                action: { [weak self] in
                    self?.closeAllTabs()
                }
            ),
            PaletteCommand(
                id: "reveal-in-finder",
                title: "Reveal in Finder",
                icon: "folder",
                shortcut: nil,
                action: { [weak self] in
                    self?.revealSelectedFileInFinder()
                }
            ),
            PaletteCommand(
                id: "copy-path",
                title: "Copy File Path",
                icon: "doc.on.doc",
                shortcut: nil,
                action: { [weak self] in
                    self?.copySelectedFilePath()
                }
            ),
            PaletteCommand(
                id: "new-chat",
                title: "New Chat",
                icon: "plus.bubble",
                shortcut: nil,
                action: { [weak self] in
                    self?.startNewChat()
                }
            ),
            PaletteCommand(
                id: "open-chat",
                title: "Open Chat History",
                icon: "bubble.left.and.bubble.right",
                shortcut: nil,
                action: { [weak self] in
                    self?.openChat()
                }
            ),
            PaletteCommand(
                id: "skills-browse",
                title: "Skills: Browse",
                icon: "sparkles",
                shortcut: nil,
                action: { [weak self] in
                    self?.showSkillBrowser()
                }
            ),
            PaletteCommand(
                id: "skills-add",
                title: "Skills: Add",
                icon: "square.and.arrow.down",
                shortcut: nil,
                action: { [weak self] in
                    self?.showSkillBrowser()
                }
            ),
            PaletteCommand(
                id: "skills-manage",
                title: "Skills: Manage",
                icon: "list.bullet",
                shortcut: nil,
                action: { [weak self] in
                    self?.showSkillManager()
                }
            ),
            PaletteCommand(
                id: "skills-create",
                title: "Skills: Create",
                icon: "plus.square",
                shortcut: nil,
                action: { [weak self] in
                    self?.showSkillCreator()
                }
            ),
            PaletteCommand(
                id: "skills-use",
                title: "Skills: Use",
                icon: "wand.and.stars",
                shortcut: nil,
                action: { [weak self] in
                    self?.showSkillUse()
                }
            ),
            // MARK: - JJ Version Control Commands
            PaletteCommand(
                id: "jj-toggle-panel",
                title: "Source Control: Toggle Panel",
                icon: "arrow.triangle.branch",
                shortcut: "⌃⇧G",
                action: { [weak self] in
                    self?.isJJPanelVisible.toggle()
                }
            ),
            PaletteCommand(
                id: "jj-commit",
                title: "Source Control: Commit",
                icon: "checkmark.circle",
                shortcut: nil,
                action: { [weak self] in
                    Task { await self?.jjCommit() }
                }
            ),
            PaletteCommand(
                id: "jj-new",
                title: "Source Control: New Change",
                icon: "plus.circle",
                shortcut: nil,
                action: { [weak self] in
                    Task { await self?.jjNewChange() }
                }
            ),
            PaletteCommand(
                id: "jj-undo",
                title: "Source Control: Undo",
                icon: "arrow.uturn.backward",
                shortcut: nil,
                action: { [weak self] in
                    Task { await self?.jjUndo() }
                }
            ),
            PaletteCommand(
                id: "jj-push",
                title: "Source Control: Push",
                icon: "arrow.up",
                shortcut: nil,
                action: { [weak self] in
                    Task {
                        guard let self, let jjService = self.jjService else { return }
                        do {
                            try await jjService.gitPush(allTracked: true)
                            await self.refreshJJStatus()
                            self.showToast("Pushed")
                        } catch {
                            self.appendErrorMessage("Push failed: \(error.localizedDescription)")
                        }
                    }
                }
            ),
            PaletteCommand(
                id: "jj-fetch",
                title: "Source Control: Fetch",
                icon: "arrow.down",
                shortcut: nil,
                action: { [weak self] in
                    Task {
                        guard let self, let jjService = self.jjService else { return }
                        do {
                            try await jjService.gitFetch()
                            await self.refreshJJStatus()
                            self.showToast("Fetched")
                        } catch {
                            self.appendErrorMessage("Fetch failed: \(error.localizedDescription)")
                        }
                    }
                }
            ),
            PaletteCommand(
                id: "jj-toggle-blame",
                title: "Source Control: Toggle Inline Blame",
                icon: "text.alignleft",
                shortcut: nil,
                action: { [weak self] in
                    self?.vcsPreferences.showInlineBlame.toggle()
                }
            ),
            PaletteCommand(
                id: "jj-snapshot-browser",
                title: "Source Control: Snapshot Browser",
                icon: "clock.arrow.circlepath",
                shortcut: nil,
                action: { [weak self] in
                    self?.showSnapshotBrowser()
                }
            ),
            PaletteCommand(
                id: "jj-agent-dashboard",
                title: "Agents: Dashboard",
                icon: "person.3",
                shortcut: nil,
                action: { [weak self] in
                    self?.isAgentDashboardVisible.toggle()
                }
            ),
            PaletteCommand(
                id: "jj-spawn-agent",
                title: "Agents: Spawn New Agent",
                icon: "person.badge.plus",
                shortcut: nil,
                action: { [weak self] in
                    self?.showNewAgentPrompt()
                }
            ),
        ]
    }

    private func rebuildFileIndex() {
        fileIndexTask?.cancel()
        guard let rootDirectory else { return }
        let rootPath = rootDirectory.path
        let rootPathPrefix = rootPath.hasSuffix("/") ? rootPath : "\(rootPath)/"
        let skipNames = Self.skipDirectoryNames
        let keys: [URLResourceKey] = [.isDirectoryKey, .isRegularFileKey]
        fileIndexTask = Task.detached(priority: .utility) { [rootDirectory, rootPathPrefix, skipNames, keys] in
            let fm = FileManager.default
            var ignoreMatcher = Self.loadIgnoreMatcher(rootDirectory: rootDirectory)
            if let gitPaths = Self.runGitListFiles(rootDirectory: rootDirectory) {
                var entries: [FileIndexEntry] = []
                entries.reserveCapacity(gitPaths.count)
                for path in gitPaths {
                    if Task.isCancelled { return }
                    if Self.isHiddenPath(path) { continue }
                    let fileURL = rootDirectory.appendingPathComponent(path)
                    var isDir: ObjCBool = false
                    if fm.fileExists(atPath: fileURL.path, isDirectory: &isDir), isDir.boolValue {
                        continue
                    }
                    entries.append(FileIndexEntry(url: fileURL, displayPath: path))
                }
                entries.sort { lhs, rhs in
                    lhs.displayPath.localizedStandardCompare(rhs.displayPath) == .orderedAscending
                }
                if Task.isCancelled { return }
                await MainActor.run { [weak self] in
                    guard let self, !Task.isCancelled else { return }
                    self.fileIndex = entries
                    self.scheduleSearch()
                }
                return
            }
            guard let enumerator = fm.enumerator(
                at: rootDirectory,
                includingPropertiesForKeys: keys,
                options: [.skipsHiddenFiles, .skipsPackageDescendants]
            ) else {
                await MainActor.run { [weak self] in
                    guard let self, !Task.isCancelled else { return }
                    self.fileIndex = []
                    self.scheduleSearch()
                }
                return
            }
            var entries: [FileIndexEntry] = []
            while let url = enumerator.nextObject() as? URL {
                if Task.isCancelled { return }
                let values = try? url.resourceValues(forKeys: Set(keys))
                if values?.isDirectory == true {
                    if skipNames.contains(url.lastPathComponent) {
                        enumerator.skipDescendants()
                    }
                    let fullPath = url.path
                    let displayPath: String
                    if fullPath.hasPrefix(rootPathPrefix) {
                        displayPath = String(fullPath.dropFirst(rootPathPrefix.count))
                    } else {
                        displayPath = url.lastPathComponent
                    }
                    if ignoreMatcher.shouldIgnore(path: displayPath, isDirectory: true) {
                        enumerator.skipDescendants()
                        continue
                    }
                    continue
                }
                guard values?.isRegularFile == true else { continue }
                let fullPath = url.path
                let displayPath: String
                if fullPath.hasPrefix(rootPathPrefix) {
                    displayPath = String(fullPath.dropFirst(rootPathPrefix.count))
                } else {
                    displayPath = url.lastPathComponent
                }
                if ignoreMatcher.shouldIgnore(path: displayPath, isDirectory: false) {
                    continue
                }
                entries.append(FileIndexEntry(url: url, displayPath: displayPath))
            }
            entries.sort { lhs, rhs in
                lhs.displayPath.localizedStandardCompare(rhs.displayPath) == .orderedAscending
            }
            if Task.isCancelled { return }
            await MainActor.run { [weak self] in
                guard let self, !Task.isCancelled else { return }
                self.fileIndex = entries
                self.scheduleSearch()
            }
        }
    }

    private func scheduleSearch() {
        searchTask?.cancel()
        searchToken += 1
        let token = searchToken
        let rawQuery = fileSearchQuery
        let trimmedQuery = rawQuery.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmedQuery.hasPrefix(">") {
            let commandQuery = String(trimmedQuery.dropFirst())
                .trimmingCharacters(in: .whitespacesAndNewlines)
                .lowercased()
            let commands = buildCommandList()
            let results: [PaletteCommand]
            if commandQuery.isEmpty {
                results = commands
            } else {
                var scored: [(PaletteCommand, Int)] = []
                scored.reserveCapacity(commands.count)
                for command in commands {
                    if let score = Self.scoreCommandMatch(query: commandQuery, in: command.title.lowercased()) {
                        scored.append((command, score))
                    }
                }
                scored.sort { lhs, rhs in
                    if lhs.1 != rhs.1 { return lhs.1 < rhs.1 }
                    return lhs.0.title.localizedStandardCompare(rhs.0.title) == .orderedAscending
                }
                results = scored.map { $0.0 }
            }
            paletteCommands = results
            fileSearchResults = []
            return
        }

        let query = trimmedQuery.lowercased()
        let entries = fileIndex
        let recentEditScores = Self.buildRecencyScores(from: recentEditEntries.map(\.url), weight: Self.recencyEditWeight)
        let recentViewScores = Self.buildRecencyScores(from: recentFileEntries.map(\.url), weight: Self.recencyViewWeight)
        searchTask = Task.detached(priority: .userInitiated) { [entries, query, recentEditScores, recentViewScores] in
            if Task.isCancelled { return }
            let results: [FileIndexEntry]
            if query.isEmpty {
                results = Array(entries.prefix(Self.maxSearchResults))
            } else {
                var scored: [(FileIndexEntry, Int)] = []
                scored.reserveCapacity(entries.count / 2)
                for entry in entries {
                    if Task.isCancelled { return }
                    if let score = Self.scoreFileMatch(
                        query: query,
                        entry: entry,
                        recentEditScores: recentEditScores,
                        recentViewScores: recentViewScores
                    ) {
                        scored.append((entry, score))
                    }
                }
                scored.sort { lhs, rhs in
                    if lhs.1 != rhs.1 { return lhs.1 < rhs.1 }
                    return lhs.0.displayPath.localizedStandardCompare(rhs.0.displayPath) == .orderedAscending
                }
                results = scored.prefix(Self.maxSearchResults).map { $0.0 }
            }
            if Task.isCancelled { return }
            await MainActor.run { [weak self] in
                guard let self, token == self.searchToken else { return }
                let currentQuery = self.fileSearchQuery.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
                guard currentQuery == query else { return }
                self.fileSearchResults = results
                self.paletteCommands = []
            }
        }
    }

    private func scheduleSearchInFiles() {
        searchInFilesTask?.cancel()
        searchInFilesToken += 1
        let token = searchInFilesToken
        let rawQuery = searchQuery
        let trimmedQuery = rawQuery.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let rootDirectory else {
            searchResults = []
            clearSearchPreview()
            isSearchInProgress = false
            return
        }
        if trimmedQuery.isEmpty {
            searchResults = []
            searchErrorMessage = nil
            clearSearchPreview()
            isSearchInProgress = false
            return
        }
        isSearchInProgress = true
        searchErrorMessage = nil
        clearSearchPreview()
        let rootPath = rootDirectory.path
        searchInFilesTask = Task.detached(priority: .utility) {
            do {
                try await Task.sleep(nanoseconds: 250_000_000)
            } catch {
                await MainActor.run { [weak self] in
                    guard let self, token == self.searchInFilesToken else { return }
                    self.isSearchInProgress = false
                }
                return .failure("Search cancelled.")
            }
            if Task.isCancelled { return .failure("Search cancelled.") }
            let result = await Self.runRipgrep(query: trimmedQuery, rootPath: rootPath)
            if Task.isCancelled { return .failure("Search cancelled.") }
            await MainActor.run { [weak self] in
                guard let self, token == self.searchInFilesToken else { return }
                switch result {
                case .success(let results):
                    self.searchResults = results
                    self.searchErrorMessage = nil
                case .failure(let message):
                    self.searchResults = []
                    self.searchErrorMessage = message
                }
                self.isSearchInProgress = false
            }
            return result
        }
    }

#if DEBUG
    @MainActor
    func runSearchInFilesForTesting(query: String) async {
        let trimmedQuery = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let rootDirectory else {
            searchResults = []
            clearSearchPreview()
            isSearchInProgress = false
            return
        }
        guard !trimmedQuery.isEmpty else {
            searchResults = []
            searchErrorMessage = nil
            clearSearchPreview()
            isSearchInProgress = false
            return
        }
        searchInFilesTask?.cancel()
        isSearchInProgress = true
        searchErrorMessage = nil
        clearSearchPreview()
        searchInFilesToken += 1
        let token = searchInFilesToken
        let rootPath = rootDirectory.path
        let task = Task.detached(priority: .utility) {
            await Self.runRipgrep(query: trimmedQuery, rootPath: rootPath)
        }
        searchInFilesTask = task
        let result = await task.value
        guard token == searchInFilesToken else { return }
        switch result {
        case .success(let results):
            searchResults = results
            searchErrorMessage = nil
        case .failure(let message):
            searchResults = []
            searchErrorMessage = message
        }
        isSearchInProgress = false
    }
#endif

    nonisolated private static func scoreCommandMatch(query: String, in text: String) -> Int? {
        fuzzyScore(query: query, in: text, fileNameStartIndex: 0)
    }

    nonisolated private static func scoreFileMatch(
        query: String,
        entry: FileIndexEntry,
        recentEditScores: [String: Int],
        recentViewScores: [String: Int]
    ) -> Int? {
        guard let baseScore = fuzzyScore(
            query: query,
            in: entry.lowercasedPath,
            fileNameStartIndex: entry.fileNameStartIndex
        ) else {
            return nil
        }
        var score = baseScore
        score += entry.pathDepth * Self.pathDepthPenalty
        score += min(entry.displayPath.count, 120) / 6
        if entry.lowercasedName == query {
            score -= 30
        } else if entry.lowercasedName.hasPrefix(query) {
            score -= 18
        } else if entry.lowercasedName.contains(query) {
            score -= 8
        }
        score -= Self.extensionBonus(for: query, fileExtension: entry.fileExtension)
        let pathKey = entry.url.standardizedFileURL.path
        score -= (recentEditScores[pathKey] ?? 0)
        score -= (recentViewScores[pathKey] ?? 0)
        return score
    }

    nonisolated private static func buildRecencyScores(from urls: [URL], weight: Int) -> [String: Int] {
        guard weight > 0, !urls.isEmpty else { return [:] }
        var scores: [String: Int] = [:]
        let count = urls.count
        for (index, url) in urls.enumerated() {
            let bonus = (count - index) * weight
            scores[url.standardizedFileURL.path] = bonus
        }
        return scores
    }

    nonisolated private static func extensionBonus(for query: String, fileExtension: String) -> Int {
        guard let dotIndex = query.lastIndex(of: "."), dotIndex < query.index(before: query.endIndex) else {
            if !query.contains("/"), !query.contains(" "), !query.contains(".") {
                if fileExtension == query {
                    return Self.extensionPartialBonus
                }
                if fileExtension.hasPrefix(query) {
                    return max(2, Self.extensionPartialBonus / 2)
                }
            }
            return 0
        }
        let ext = String(query[query.index(after: dotIndex)...])
        if ext.isEmpty { return 0 }
        if fileExtension == ext {
            return Self.extensionExactBonus
        }
        if fileExtension.hasPrefix(ext) {
            return Self.extensionPartialBonus
        }
        return 0
    }

    nonisolated private static func fuzzyScore(
        query: String,
        in text: String,
        fileNameStartIndex: Int
    ) -> Int? {
        guard !query.isEmpty else { return 0 }
        let textChars = Array(text)
        let queryChars = Array(query)
        guard queryChars.count <= textChars.count else { return nil }

        var searchIndex = 0
        var lastMatch = -1
        var firstMatch = -1
        var lastMatchIndex = -1
        var gapSum = 0
        var consecutive = 0
        var boundaryHits = 0
        var fileNameMatches = 0

        for ch in queryChars {
            var foundIndex = -1
            var i = searchIndex
            while i < textChars.count {
                if textChars[i] == ch {
                    foundIndex = i
                    break
                }
                i += 1
            }
            if foundIndex == -1 { return nil }
            if firstMatch == -1 { firstMatch = foundIndex }
            lastMatchIndex = foundIndex
            if foundIndex >= fileNameStartIndex {
                fileNameMatches += 1
            }
            if lastMatch >= 0 {
                let gap = foundIndex - lastMatch - 1
                if gap == 0 { consecutive += 1 }
                gapSum += max(0, gap)
            }
            if foundIndex == 0 || Self.isBoundary(textChars[foundIndex - 1]) {
                boundaryHits += 1
            }
            lastMatch = foundIndex
            searchIndex = foundIndex + 1
        }

        let matchCount = queryChars.count
        let consecutiveRun = firstMatch >= 0 && (lastMatchIndex - firstMatch + 1 == matchCount)
        let startsInName = firstMatch >= fileNameStartIndex
        let inFileName = fileNameMatches == matchCount

        var score = 0
        score += max(0, firstMatch) * 2
        score += gapSum * 4
        score -= consecutive * 6
        score -= boundaryHits * 3
        if consecutiveRun { score -= 12 }
        if inFileName { score -= 20 } else if startsInName { score -= 10 }
        score += textChars.count / 6
        return score
    }

    nonisolated private static func isBoundary(_ char: Character) -> Bool {
        switch char {
        case "/", "_", "-", " ", ".":
            return true
        default:
            return false
        }
    }

    private struct IgnoreRule {
        let isNegation: Bool
        let directoryOnly: Bool
        let directoryRegex: NSRegularExpression?
        let descendantRegex: NSRegularExpression?
        let pathRegex: NSRegularExpression?

        init?(
            pattern: String,
            basePath: String,
            isNegation: Bool,
            directoryOnly: Bool,
            anchored: Bool
        ) {
            guard let body = WorkspaceState.buildIgnoreRegexBody(
                pattern: pattern,
                basePath: basePath,
                anchored: anchored
            ) else {
                return nil
            }
            self.isNegation = isNegation
            self.directoryOnly = directoryOnly

            if directoryOnly {
                guard let dirRegex = try? NSRegularExpression(pattern: "\(body)$"),
                      let descendantRegex = try? NSRegularExpression(pattern: "\(body)/.*$")
                else {
                    return nil
                }
                self.directoryRegex = dirRegex
                self.descendantRegex = descendantRegex
                self.pathRegex = nil
            } else {
                guard let pathRegex = try? NSRegularExpression(pattern: "\(body)(?:/.*)?$") else {
                    return nil
                }
                self.directoryRegex = nil
                self.descendantRegex = nil
                self.pathRegex = pathRegex
            }
        }

        func matches(path: String, isDirectory: Bool) -> Bool {
            let range = NSRange(path.startIndex..., in: path)
            if directoryOnly {
                if isDirectory, let directoryRegex,
                   directoryRegex.firstMatch(in: path, range: range) != nil {
                    return true
                }
                if let descendantRegex, descendantRegex.firstMatch(in: path, range: range) != nil {
                    return true
                }
                return false
            }
            return pathRegex?.firstMatch(in: path, range: range) != nil
        }
    }

    private struct IgnoreMatcher {
        let rootDirectory: URL
        let baseRules: [IgnoreRule]
        private var combinedRulesCache: [String: [IgnoreRule]]
        private var localRulesCache: [String: [IgnoreRule]]

        init(rootDirectory: URL, baseRules: [IgnoreRule]) {
            self.rootDirectory = rootDirectory
            self.baseRules = baseRules
            self.combinedRulesCache = ["": baseRules]
            self.localRulesCache = ["": []]
        }

        mutating func shouldIgnore(path: String, isDirectory: Bool) -> Bool {
            let normalizedPath = path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
            let directoryPath: String
            if isDirectory {
                directoryPath = normalizedPath
            } else if let slashIndex = normalizedPath.lastIndex(of: "/") {
                directoryPath = String(normalizedPath[..<slashIndex])
            } else {
                directoryPath = ""
            }

            let rules = rulesForDirectory(directoryPath)
            guard !rules.isEmpty else { return false }

            var ignored = false
            for rule in rules {
                if rule.matches(path: normalizedPath, isDirectory: isDirectory) {
                    ignored = !rule.isNegation
                }
            }
            return ignored
        }

        private mutating func rulesForDirectory(_ directoryPath: String) -> [IgnoreRule] {
            if let cached = combinedRulesCache[directoryPath] {
                return cached
            }
            let parentPath = parentDirectory(of: directoryPath)
            var rules = parentPath == directoryPath ? baseRules : rulesForDirectory(parentPath)
            let localRules = loadLocalRules(for: directoryPath)
            if !localRules.isEmpty {
                rules.append(contentsOf: localRules)
            }
            combinedRulesCache[directoryPath] = rules
            return rules
        }

        private mutating func loadLocalRules(for directoryPath: String) -> [IgnoreRule] {
            if directoryPath.isEmpty {
                return []
            }
            if let cached = localRulesCache[directoryPath] {
                return cached
            }
            let dirURL = rootDirectory.appendingPathComponent(directoryPath)
            let gitignoreURL = dirURL.appendingPathComponent(".gitignore")
            let rules = WorkspaceState.parseIgnoreFile(at: gitignoreURL, basePath: directoryPath)
            localRulesCache[directoryPath] = rules
            return rules
        }

        private func parentDirectory(of path: String) -> String {
            guard let slashIndex = path.lastIndex(of: "/") else { return "" }
            return String(path[..<slashIndex])
        }
    }

    nonisolated private static func loadIgnoreMatcher(rootDirectory: URL) -> IgnoreMatcher {
        let fm = FileManager.default
        let home = fm.homeDirectoryForCurrentUser
        var rules: [IgnoreRule] = []

        let globalCandidates: [URL] = [
            home.appendingPathComponent(".config/git/ignore"),
            home.appendingPathComponent(".gitignore_global"),
            home.appendingPathComponent(".gitignore")
        ]
        for url in globalCandidates {
            rules.append(contentsOf: parseIgnoreFile(at: url, basePath: ""))
        }

        let infoExclude = rootDirectory.appendingPathComponent(".git/info/exclude")
        rules.append(contentsOf: parseIgnoreFile(at: infoExclude, basePath: ""))

        let rootIgnore = rootDirectory.appendingPathComponent(".gitignore")
        rules.append(contentsOf: parseIgnoreFile(at: rootIgnore, basePath: ""))

        return IgnoreMatcher(rootDirectory: rootDirectory, baseRules: rules)
    }

    nonisolated private static func parseIgnoreFile(at url: URL, basePath: String) -> [IgnoreRule] {
        guard let data = try? String(contentsOf: url, encoding: .utf8) else { return [] }
        var rules: [IgnoreRule] = []
        for rawLine in data.split(whereSeparator: \.isNewline) {
            var line = String(rawLine)
            line = line.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !line.isEmpty else { continue }

            if line.hasPrefix("\\#") {
                line.removeFirst()
            } else if line.hasPrefix("#") {
                continue
            }

            var isNegation = false
            if line.hasPrefix("\\!") {
                line.removeFirst()
            } else if line.hasPrefix("!") {
                isNegation = true
                line.removeFirst()
            }

            line = line.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !line.isEmpty else { continue }

            let directoryOnly = line.hasSuffix("/")
            if directoryOnly {
                line.removeLast()
            }
            let anchored = line.hasPrefix("/")
            if anchored {
                line.removeFirst()
            }
            guard !line.isEmpty else { continue }

            if let rule = IgnoreRule(
                pattern: line,
                basePath: basePath,
                isNegation: isNegation,
                directoryOnly: directoryOnly,
                anchored: anchored
            ) {
                rules.append(rule)
            }
        }
        return rules
    }

    nonisolated private static func buildIgnoreRegexBody(
        pattern: String,
        basePath: String,
        anchored: Bool
    ) -> String? {
        guard !pattern.isEmpty else { return nil }
        let containsSlash = pattern.contains("/")
        let prefix = basePath.isEmpty
            ? ""
            : NSRegularExpression.escapedPattern(for: basePath) + "/"
        let body = globToRegex(pattern)
        if containsSlash {
            return "^\(prefix)\(body)"
        }
        let depthPrefix = anchored ? "" : "(?:[^/]*/)*"
        return "^\(prefix)\(depthPrefix)\(body)"
    }

    nonisolated private static func globToRegex(_ pattern: String) -> String {
        var regex = ""
        var index = pattern.startIndex
        while index < pattern.endIndex {
            let ch = pattern[index]
            if ch == "*" {
                let next = pattern.index(after: index)
                if next < pattern.endIndex && pattern[next] == "*" {
                    regex += ".*"
                    index = pattern.index(after: next)
                } else {
                    regex += "[^/]*"
                    index = next
                }
                continue
            }
            if ch == "?" {
                regex += "[^/]"
                index = pattern.index(after: index)
                continue
            }
            if ch == "[" {
                var j = pattern.index(after: index)
                var classBody = ""
                if j < pattern.endIndex, pattern[j] == "!" {
                    classBody += "^"
                    j = pattern.index(after: j)
                }
                var closed = false
                while j < pattern.endIndex {
                    let current = pattern[j]
                    if current == "]" {
                        closed = true
                        break
                    }
                    if current == "\\" {
                        classBody += "\\\\"
                    } else {
                        classBody += String(current)
                    }
                    j = pattern.index(after: j)
                }
                if closed {
                    regex += "[\(classBody)]"
                    index = pattern.index(after: j)
                } else {
                    regex += "\\["
                    index = pattern.index(after: index)
                }
                continue
            }
            if ch == "\\" {
                let next = pattern.index(after: index)
                if next < pattern.endIndex {
                    let literal = String(pattern[next])
                    regex += NSRegularExpression.escapedPattern(for: literal)
                    index = pattern.index(after: next)
                } else {
                    regex += "\\\\"
                    index = next
                }
                continue
            }
            if ".^$+(){}|[]\\".contains(ch) {
                regex += "\\\(ch)"
            } else {
                regex += String(ch)
            }
            index = pattern.index(after: index)
        }
        return regex
    }

    nonisolated private static func runGitListFiles(rootDirectory: URL) -> [String]? {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        process.arguments = ["git", "-C", rootDirectory.path, "ls-files", "-co", "--exclude-standard", "-z"]

        let outputPipe = Pipe()
        process.standardInput = FileHandle.nullDevice
        process.standardOutput = outputPipe
        process.standardError = FileHandle.nullDevice

        do {
            try process.run()
        } catch {
            return nil
        }

        let data = outputPipe.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        guard process.terminationStatus == 0 else { return nil }

        let output = String(decoding: data, as: UTF8.self)
        return output.split(separator: "\0").map(String.init).filter { !$0.isEmpty }
    }

    nonisolated private static func isHiddenPath(_ path: String) -> Bool {
        path.split(separator: "/").contains { $0.hasPrefix(".") }
    }

    nonisolated private static func utf16Offset(forByteOffset offset: Int, in line: String) -> Int? {
        guard offset >= 0 else { return nil }
        let utf8 = line.utf8
        guard let byteIndex = utf8.index(utf8.startIndex, offsetBy: offset, limitedBy: utf8.endIndex) else {
            return nil
        }
        guard let stringIndex = String.Index(byteIndex, within: line) else { return nil }
        return line.utf16.distance(from: line.utf16.startIndex, to: stringIndex)
    }

    nonisolated private static func runRipgrep(
        query: String,
        rootPath: String
    ) async -> SearchOutcome {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        process.arguments = ["rg", "--json", "--smart-case", "--", query, "."]
        process.currentDirectoryURL = URL(fileURLWithPath: rootPath)

        let outputPipe = Pipe()
        let errorPipe = Pipe()
        process.standardOutput = outputPipe
        process.standardError = errorPipe

        do {
            try process.run()
        } catch {
            return .failure("Ripgrep (rg) not available.")
        }

        return await withTaskCancellationHandler(operation: {
            let errorTask = Task<Data, Never> {
                (try? errorPipe.fileHandleForReading.readToEnd()) ?? Data()
            }

            var results: [SearchResult] = []
            var indexByPath: [String: Int] = [:]
            var matchCount = 0
            let rootURL = URL(fileURLWithPath: rootPath)
            let handle = outputPipe.fileHandleForReading
            var hitLimit = false

            do {
                lineLoop: for try await line in handle.bytes.lines {
                    if Task.isCancelled { break }
                    guard !line.isEmpty, let lineData = line.data(using: .utf8) else { continue }
                    guard let json = try? JSONSerialization.jsonObject(with: lineData) as? [String: Any],
                          let type = json["type"] as? String,
                          type == "match",
                          let data = json["data"] as? [String: Any],
                          let path = (data["path"] as? [String: Any])?["text"] as? String,
                          let lineNumber = (data["line_number"] as? NSNumber)?.intValue,
                          let lineText = (data["lines"] as? [String: Any])?["text"] as? String,
                          let submatches = data["submatches"] as? [[String: Any]]
                    else { continue }

                    let fileURL: URL
                    if path.hasPrefix("/") {
                        fileURL = URL(fileURLWithPath: path).standardizedFileURL
                    } else {
                        fileURL = URL(fileURLWithPath: path, relativeTo: rootURL).standardizedFileURL
                    }
                    let displayPath = relativePath(for: fileURL, rootPath: rootPath)
                    let trimmedLine = lineText.trimmingCharacters(in: .newlines)
                    for submatch in submatches {
                        guard let start = (submatch["start"] as? NSNumber)?.intValue else { continue }
                        let end = (submatch["end"] as? NSNumber)?.intValue ?? start + 1
                        let startOffset = utf16Offset(forByteOffset: start, in: lineText) ?? start
                        let endOffset = utf16Offset(forByteOffset: end, in: lineText) ?? end
                        let matchLength = max(1, endOffset - startOffset)
                        let match = SearchMatch(
                            lineNumber: lineNumber,
                            column: startOffset + 1,
                            matchLength: matchLength,
                            lineText: trimmedLine
                        )
                        if let index = indexByPath[path] {
                            results[index].matches.append(match)
                        } else {
                            let result = SearchResult(url: fileURL, displayPath: displayPath, matches: [match])
                            results.append(result)
                            indexByPath[path] = results.count - 1
                        }
                        matchCount += 1
                        if matchCount >= Self.maxSearchMatches {
                            hitLimit = true
                            process.terminate()
                            break lineLoop
                        }
                    }
                }
            } catch {
                // ignore read errors
            }

            if Task.isCancelled {
                process.terminate()
                return .success([])
            }

            if hitLimit {
                _ = try? handle.readToEnd()
            }

            let errorData = await errorTask.value
            process.waitUntilExit()

            // rg exit code 1 = no matches, 2+ = error
            if process.terminationStatus == 1 {
                return .success([])
            }
            if process.terminationStatus != 0 && !hitLimit {
                let message = String(data: errorData, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines)
                return .failure(message?.isEmpty == false ? message! : "Search failed.")
            }

            return .success(results)
        }, onCancel: {
            process.terminate()
        })
    }

    nonisolated private static func buildSearchPreview(
        url: URL,
        displayPath: String,
        lineNumber: Int,
        fallbackLine: String
    ) -> SearchPreview {
        let fm = FileManager.default
        let size = (try? fm.attributesOfItem(atPath: url.path)[.size] as? NSNumber)?.intValue ?? 0
        if size > maxPreviewBytes {
            let line = SearchPreviewLine(number: lineNumber, text: fallbackLine, isMatch: true)
            return SearchPreview(
                url: url,
                displayPath: displayPath,
                matchLine: lineNumber,
                lines: [line],
                isTruncated: true
            )
        }

        guard let contents = try? String(contentsOf: url, encoding: .utf8) else {
            let line = SearchPreviewLine(number: lineNumber, text: fallbackLine, isMatch: true)
            return SearchPreview(
                url: url,
                displayPath: displayPath,
                matchLine: lineNumber,
                lines: [line],
                isTruncated: false
            )
        }

        let startLine = max(1, lineNumber - previewContextLines)
        let endLine = lineNumber + previewContextLines
        var lines: [SearchPreviewLine] = []
        var current = 1
        contents.enumerateLines { line, stop in
            if current >= startLine && current <= endLine {
                lines.append(SearchPreviewLine(number: current, text: line, isMatch: current == lineNumber))
            }
            if current >= endLine {
                stop = true
            }
            current += 1
        }

        if lines.isEmpty {
            lines.append(SearchPreviewLine(number: lineNumber, text: fallbackLine, isMatch: true))
        }

        return SearchPreview(
            url: url,
            displayPath: displayPath,
            matchLine: lineNumber,
            lines: lines,
            isTruncated: false
        )
    }

    nonisolated private static func relativePath(for url: URL, rootPath: String) -> String {
        let fullPath = url.path
        let prefix = rootPath.hasSuffix("/") ? rootPath : "\(rootPath)/"
        if fullPath.hasPrefix(prefix) {
            return String(fullPath.dropFirst(prefix.count))
        }
        return url.lastPathComponent
    }

    private func startCodexService(cwd: String, resumeThreadId: String?) {
        stopCodexService()
        guard !Self.isRunningTests else { return }
        let service = CodexService()
        service.attachWorkspace(self)
        codexService = service

        codexEventsTask = Task { [weak self] in
            guard let self else { return }
            for await event in service.events {
                self.handleCodexEvent(event)
            }
        }

        Task { @MainActor [weak self] in
            guard let self else { return }
            do {
                let startResult = try await service.start(cwd: cwd, resumeThreadId: resumeThreadId)
                self.handleThreadStartResult(startResult, resumeRequested: resumeThreadId != nil)
                if let apiKey = ProcessInfo.processInfo.environment["OPENAI_API_KEY"], !apiKey.isEmpty {
                    try await service.login(apiKey: apiKey)
                }
            } catch {
                self.appendErrorMessage("Codex failed to start: \(error.localizedDescription)")
                self.stopCodexService()
            }
        }
    }

    private func startCompletionService(cwd: String) {
        stopCompletionService()
        guard !Self.isRunningTests else { return }
        let service = CodexCompletionService()
        completionService = service

        Task { @MainActor [weak self] in
            guard let self else { return }
            do {
                try await service.start(cwd: cwd)
                if let apiKey = ProcessInfo.processInfo.environment["OPENAI_API_KEY"], !apiKey.isEmpty {
                    try await service.login(apiKey: apiKey)
                }
            } catch {
                self.appendErrorMessage("Completion service failed to start: \(error.localizedDescription)")
                self.stopCompletionService()
            }
        }
    }

    private func handleThreadStartResult(_ result: ThreadStartResult, resumeRequested: Bool) {
        updateActiveThreadId(result.threadId)
        if let thread = result.restoredThread {
            applyThreadHistory(thread)
        } else if resumeRequested && result.resumed == false {
            if chatMessages.isEmpty {
                chatMessages = Self.initialChatMessages()
                rebuildDiffPreviewIndex()
            }
        }
    }

    private func stopCodexService() {
        codexEventsTask?.cancel()
        codexEventsTask = nil
        codexService?.stop()
        codexService = nil
        isTurnInProgress = false
        stopCompletionService()
    }

    private func stopCompletionService() {
        completionService?.stop()
        completionService = nil
    }

    private func handleCodexEvent(_ event: CodexEvent) {
        switch event {
        case .turnStarted(let turnId):
            isTurnInProgress = true
            registerTurnIfNeeded(turnId)
            attachTurnToLastUserMessage(turnId)
        case .agentMessageDelta(let turnId, let text):
            applyAgentMessageDelta(turnId: turnId, delta: text)
        case .agentMessageCompleted(let turnId, let text):
            finalizeAgentMessage(turnId: turnId, text: text)
        case .commandStarted(let turnId, let itemId, let command, let cwd):
            appendCommandMessage(turnId: turnId, itemId: itemId, command: command, cwd: cwd)
        case .commandOutput(let turnId, let itemId, let text):
            appendCommandOutput(turnId: turnId, itemId: itemId, text: text)
        case .commandCompleted(let turnId, let itemId, let exitCode):
            completeCommand(turnId: turnId, itemId: itemId, exitCode: exitCode)
        case .fileChange(let turnId, let item):
            appendDiffPreview(from: item, turnId: turnId)
        case .fileChangeDelta(let turnId, _, let delta):
            appendStreamingDiff(turnId: turnId, delta: delta)
        case .turnDiffUpdated(let turnId, let diff):
            updateTurnDiffPreview(turnId: turnId, diff: diff)
        case .turnCompleted(let turnId, let status):
            isTurnInProgress = false
            finalizeAgentMessage(turnId: nil, text: nil)
            if status == "failed" {
                appendErrorMessage("Turn failed.")
            } else if status == "interrupted" {
                appendErrorMessage("Turn interrupted.")
            } else if status != "completed" {
                appendErrorMessage("Turn finished with status: \(status)")
            }
            if status == "completed" {
                autoSnapshotAfterTurn(turnId: turnId)
            }
        case .error(let message):
            isTurnInProgress = false
            appendErrorMessage(message)
        }
    }

    private func registerTurnIfNeeded(_ turnId: String) {
        if !turnHistoryOrder.contains(turnId) {
            turnHistoryOrder.append(turnId)
        }
    }

    private func attachTurnToLastUserMessage(_ turnId: String) {
        guard let index = chatMessages.lastIndex(where: { $0.role == .user && $0.turnId == nil }) else { return }
        var message = chatMessages[index]
        message.turnId = turnId
        chatMessages[index] = message
    }

    private func applyAgentMessageDelta(turnId: String, delta: String) {
        if let index = chatMessages.lastIndex(where: { $0.role == .assistant && $0.isStreaming }) {
            var message = chatMessages[index]
            message.turnId = message.turnId ?? turnId
            message.appendText(delta)
            chatMessages[index] = message
        } else {
            let message = ChatMessage(role: .assistant, kind: .text(delta), isStreaming: true, turnId: turnId)
            chatMessages.append(message)
        }
    }

    private func finalizeAgentMessage(turnId: String?, text: String?) {
        guard let index = chatMessages.lastIndex(where: { $0.role == .assistant && $0.isStreaming }) else { return }
        var message = chatMessages[index]
        if let text {
            message.setText(text)
        }
        if let turnId {
            message.turnId = turnId
        }
        message.isStreaming = false
        chatMessages[index] = message
    }

    private func appendCommandMessage(turnId: String, itemId: String, command: String, cwd: String) {
        let info = CommandExecutionInfo(itemId: itemId, command: command, cwd: cwd, output: "", exitCode: nil, status: .running)
        let message = ChatMessage(role: .assistant, kind: .command(info), turnId: turnId)
        chatMessages.append(message)
    }

    private func appendCommandOutput(turnId: String, itemId: String, text: String) {
        guard let index = chatMessages.lastIndex(where: { $0.commandItemId == itemId }) else {
            appendCommandMessage(turnId: turnId, itemId: itemId, command: "command", cwd: "", output: text)
            return
        }
        var message = chatMessages[index]
        message.turnId = message.turnId ?? turnId
        message.appendCommandOutput(text)
        chatMessages[index] = message
    }

    private func completeCommand(turnId: String, itemId: String, exitCode: Int?) {
        guard let index = chatMessages.lastIndex(where: { $0.commandItemId == itemId }) else { return }
        var message = chatMessages[index]
        message.turnId = message.turnId ?? turnId
        message.completeCommand(exitCode: exitCode)
        chatMessages[index] = message
    }

    private func appendCommandMessage(turnId: String, itemId: String, command: String, cwd: String, output: String) {
        let info = CommandExecutionInfo(itemId: itemId, command: command, cwd: cwd, output: output, exitCode: nil, status: .running)
        let message = ChatMessage(role: .assistant, kind: .command(info), turnId: turnId)
        chatMessages.append(message)
    }

    private func appendDiffPreview(from item: FileChangeItem, turnId: String) {
        let preview = DiffPreview.fromFileChange(turnId: turnId, item: item)
        let trimmed = preview.diff.trimmingCharacters(in: .whitespacesAndNewlines)
        if turnDiffs[turnId] == nil && !trimmed.isEmpty {
            ensureTurnOrder(turnId)
            turnDiffs[turnId] = preview.diff
            scheduleSessionDiffRecompute()
        }
        upsertDiffPreview(preview)
    }

    private func updateTurnDiffPreview(turnId: String, diff: String) {
        let trimmed = diff.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        ensureTurnOrder(turnId)
        streamingTurnDiffs[turnId] = nil
        turnDiffs[turnId] = diff
        let preview = DiffPreview.fromTurnDiff(turnId: turnId, diff: diff)
        upsertDiffPreview(preview)
        scheduleSessionDiffRecompute()
    }

    private func appendStreamingDiff(turnId: String, delta: String) {
        guard looksLikeUnifiedDiff(delta) else { return }
        if turnDiffs[turnId] != nil {
            return
        }
        ensureTurnOrder(turnId)
        let current = streamingTurnDiffs[turnId] ?? ""
        let updated = current + delta
        streamingTurnDiffs[turnId] = updated
        let preview = DiffPreview.fromStreamingDiff(turnId: turnId, diff: updated)
        upsertDiffPreview(preview)
        scheduleSessionDiffRecompute()
    }

    private func ensureTurnOrder(_ turnId: String) {
        if !turnDiffOrder.contains(turnId) {
            turnDiffOrder.append(turnId)
        }
    }

    private func updateSessionDiffSnapshot() {
        sessionDiffComputeTask?.cancel()
        sessionDiffComputeTask = nil
        sessionDiffComputeToken += 1
        let parts = turnDiffOrder.compactMap { turnDiffs[$0] ?? streamingTurnDiffs[$0] }
        let combined = parts.joined(separator: "\n\n")
        let trimmed = combined.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            sessionDiffSnapshot = nil
            return
        }
        let summary = DiffPreview.summarize(diff: combined)
        sessionDiffSnapshot = SessionDiffSnapshot(
            files: summary.files,
            summary: summary.summary,
            diff: combined
        )
    }

    private func scheduleSessionDiffRecompute() {
        sessionDiffComputeTask?.cancel()
        sessionDiffComputeToken += 1
        let token = sessionDiffComputeToken
        let parts = turnDiffOrder.compactMap { turnDiffs[$0] ?? streamingTurnDiffs[$0] }
        let combined = parts.joined(separator: "\n\n")
        let trimmed = combined.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            sessionDiffSnapshot = nil
            sessionDiffComputeTask = nil
            return
        }
        sessionDiffSnapshot = SessionDiffSnapshot(files: [], summary: "", diff: combined)
        sessionDiffComputeTask = Task.detached(priority: .utility) { [combined] in
            try? await Task.sleep(nanoseconds: 200_000_000)
            if Task.isCancelled { return }
            let summary = DiffPreview.summarize(diff: combined)
            await MainActor.run { [weak self] in
                guard let self, token == self.sessionDiffComputeToken else { return }
                self.sessionDiffSnapshot = SessionDiffSnapshot(
                    files: summary.files,
                    summary: summary.summary,
                    diff: combined
                )
            }
        }
    }

    private func upsertDiffPreview(_ preview: DiffPreview) {
        if let turnId = preview.turnId {
            if let index = diffPreviewIndexByTurnId[turnId],
               index < chatMessages.count,
               case .diffPreview(let existing) = chatMessages[index].kind,
               existing.turnId == turnId {
                var message = chatMessages[index]
                message.kind = .diffPreview(preview)
                message.turnId = turnId
                chatMessages[index] = message
                diffPreviewIndexByTurnId[turnId] = index
                return
            }
            if let index = chatMessages.lastIndex(where: { message in
                if case .diffPreview(let existing) = message.kind {
                    return existing.turnId == turnId
                }
                return false
            }) {
                var message = chatMessages[index]
                message.kind = .diffPreview(preview)
                message.turnId = turnId
                chatMessages[index] = message
                diffPreviewIndexByTurnId[turnId] = index
                return
            }
        }
        let message = ChatMessage(role: .assistant, kind: .diffPreview(preview), turnId: preview.turnId)
        chatMessages.append(message)
        if let turnId = preview.turnId {
            diffPreviewIndexByTurnId[turnId] = chatMessages.count - 1
        }
    }

    private func appendErrorMessage(_ message: String) {
        chatMessages.append(ChatMessage(role: .assistant, kind: .status(message)))
    }

    func presentDiff(_ preview: DiffPreview) {
        activeSessionDiff = nil
        activeDiffPreview = preview
    }

    func presentSessionDiff() {
        guard let snapshot = sessionDiffSnapshot else { return }
        activeDiffPreview = nil
        activeSessionDiff = snapshot
    }

    private func diffTabURL(category: String, identifier: String) -> URL? {
        var components = URLComponents()
        components.scheme = Self.diffScheme
        components.host = category
        let path = identifier.hasPrefix("/") ? identifier : "/\(identifier)"
        components.path = path
        return components.url
    }

    private func openDiffTab(id: URL, title: String, summary: String?, diff: String) {
        let tab = DiffTab(
            id: id,
            title: title,
            summary: summary ?? "",
            diff: diff
        )
        diffTabs[id] = tab
        if !openFiles.contains(id) {
            openFiles.append(id)
        }
        selectedFileURL = id
        currentLanguage = nil
        setEditorText("")
    }

    func openDiffTab(title: String, summary: String?, diff: String) {
        let id = UUID().uuidString
        guard let url = URL(string: "\(Self.diffScheme)://\(id)") else { return }
        openDiffTab(id: url, title: title, summary: summary, diff: diff)
    }

    @discardableResult
    func openWebview(url: URL, title: String?) -> URL {
        let id = UUID().uuidString
        guard let tabURL = URL(string: "\(Self.webviewScheme)://\(id)") else { return url }
        let tabTitle = title?.trimmingCharacters(in: .whitespacesAndNewlines)
        let resolvedTitle = tabTitle?.isEmpty == false
            ? tabTitle!
            : (url.host ?? url.absoluteString)
        let tab = WebviewTab(id: tabURL, title: resolvedTitle, url: url)
        webviewTabs[tabURL] = tab
        _ = ensureWebview(for: tab)
        if !openFiles.contains(tabURL) {
            openFiles.append(tabURL)
        }
        selectedFileURL = tabURL
        currentLanguage = nil
        setEditorText("")
        return tabURL
    }

    func closeWebview(_ url: URL) {
        if let view = webviewViews[url] {
            view.navigationDelegate = nil
            view.uiDelegate = nil
            view.stopLoading()
        }
        webviewTitleObservers[url]?.invalidate()
        webviewViews.removeValue(forKey: url)
        webviewTitleObservers.removeValue(forKey: url)
        webviewTabs.removeValue(forKey: url)
    }

    func currentWebviewURL(tabId: URL) -> URL? {
        if let view = webviewViews[tabId], let url = view.url {
            return url
        }
        return webviewTabs[tabId]?.url
    }

    func evaluateWebviewJavaScript(_ script: String, tabId: URL) async -> Result<String, Error> {
        guard let webView = webviewView(for: tabId) else {
            return .failure(WebviewEvalError.missingWebview)
        }
        return await withCheckedContinuation { continuation in
            webView.evaluateJavaScript(script) { result, error in
                if let error {
                    continuation.resume(returning: .failure(error))
                    return
                }
                if let result {
                    continuation.resume(returning: .success(String(describing: result)))
                } else {
                    continuation.resume(returning: .success(""))
                }
            }
        }
    }

    private func ensureWebview(for tab: WebviewTab) -> WKWebView {
        if let existing = webviewViews[tab.id] {
            return existing
        }
        let view = WKWebView()
        view.load(URLRequest(url: tab.url))
        let tabId = tab.id
        let observation = view.observe(\.title, options: [.new]) { [weak self] webView, change in
            let nextTitle = change.newValue ?? webView.title
            guard let title = nextTitle, !title.isEmpty else { return }
            Task { @MainActor [weak self] in
                guard let self else { return }
                if var existingTab = self.webviewTabs[tabId] {
                    existingTab.title = title
                    self.webviewTabs[tabId] = existingTab
                }
            }
        }
        webviewViews[tab.id] = view
        webviewTitleObservers[tab.id] = observation
        return view
    }

    private func looksLikeUnifiedDiff(_ text: String) -> Bool {
        if text.contains("diff --git ") || text.contains("\n+++ ") || text.contains("\n--- ") {
            return true
        }
        if text.contains("\n@@ ") || text.hasPrefix("@@") {
            return true
        }
        return false
    }

    private func ensureChatSession(id: String, title: String? = nil) -> ChatSessionState {
        if let existing = chatSessions[id] {
            return existing
        }
        let sessionTitle = title ?? (id == Self.mainChatId ? "Chat" : "Skill")
        let session = ChatSessionState(
            id: id,
            title: sessionTitle,
            messages: Self.initialChatMessages()
        )
        chatSessions[id] = session
        return session
    }

    private func storeActiveChatSessionState() {
        sessionDiffComputeTask?.cancel()
        sessionDiffComputeTask = nil
        sessionDiffComputeToken += 1
        let session = ensureChatSession(id: activeChatId)
        session.messages = chatMessages
        session.draft = chatDraft
        session.draftImages = chatDraftImages
        session.isTurnInProgress = isTurnInProgress
        session.activeDiffPreview = activeDiffPreview
        session.activeSessionDiff = activeSessionDiff
        session.activeSkills = activeSkills
        session.sessionDiffSnapshot = sessionDiffSnapshot
        session.turnDiffs = turnDiffs
        session.turnDiffOrder = turnDiffOrder
        session.streamingTurnDiffs = streamingTurnDiffs
        session.turnHistoryOrder = turnHistoryOrder
        session.threadId = activeThreadId
    }

    private func loadChatSessionState(_ session: ChatSessionState) {
        let wasSuppressed = suppressChatHistoryPersistence
        suppressChatHistoryPersistence = true
        chatMessages = session.messages
        suppressChatHistoryPersistence = wasSuppressed
        rebuildDiffPreviewIndex()
        chatDraft = session.draft
        chatDraftImages = session.draftImages
        isTurnInProgress = session.isTurnInProgress
        activeDiffPreview = session.activeDiffPreview
        activeSessionDiff = session.activeSessionDiff
        activeSkills = session.activeSkills
        primeSkillInstructionCache()
        sessionDiffSnapshot = session.sessionDiffSnapshot
        turnDiffs = session.turnDiffs
        turnDiffOrder = session.turnDiffOrder
        streamingTurnDiffs = session.streamingTurnDiffs
        turnHistoryOrder = session.turnHistoryOrder
        activeThreadId = session.threadId
    }

    private func resumeChatSessionThread(_ session: ChatSessionState) {
        guard let rootDirectory else { return }
        guard let threadId = session.threadId else { return }
        guard let codexService else { return }
        Task { [weak self] in
            guard let self else { return }
            do {
                _ = try await codexService.resumeThread(threadId: threadId, cwd: rootDirectory.path)
                await MainActor.run {
                    self.updateActiveThreadId(threadId)
                }
            } catch {
                await MainActor.run {
                    self.appendErrorMessage("Failed to resume chat: \(error.localizedDescription)")
                }
            }
        }
    }

    private func selectChat(_ url: URL) {
        guard let chatId = chatId(for: url) else { return }
        if chatId != activeChatId {
            guard !isTurnInProgress else {
                showToast("Wait for the current turn to finish.")
                return
            }
            storeActiveChatSessionState()
            activeChatId = chatId
            let session = ensureChatSession(id: chatId)
            loadChatSessionState(session)
            resumeChatSessionThread(session)
        }
        selectedFileURL = url
        currentLanguage = nil
        isEditorLoading = false
        setEditorText("")
    }

    private func openChat(id: String? = nil, title: String? = nil, select: Bool = true) {
        let resolvedId = id ?? WorkspaceState.mainChatId
        let url = Self.chatURL(for: resolvedId)
        _ = ensureChatSession(id: resolvedId, title: title)
        if !openFiles.contains(url) {
            openFiles.insert(url, at: 0)
        }
        if select {
            selectChat(url)
        }
    }

    func chatTitle(for url: URL) -> String {
        guard let chatId = chatId(for: url) else { return "Chat" }
        return chatSessions[chatId]?.title ?? (chatId == Self.mainChatId ? "Chat" : "Skill")
    }

    func chatSubtitle(for url: URL) -> String {
        guard let chatId = chatId(for: url) else { return "Chat" }
        if chatId == Self.mainChatId {
            return "Main chat"
        }
        return "Skill tab"
    }

    private func closeTerminal(_ url: URL) {
        if let view = terminalViews[url] {
            view.shutdown()
        }
        terminalViews.removeValue(forKey: url)
    }

    private func closeAllTerminals() {
        for (_, view) in terminalViews {
            view.shutdown()
        }
        terminalViews.removeAll()
        openFiles.removeAll(where: { isTerminalURL($0) })
    }

    private func setEditorText(_ text: String) {
        suppressEditorTextUpdate = true
        editorText = text
        suppressEditorTextUpdate = false
    }

    func recordEditorEdit(line: Int, column: Int) {
        guard let url = selectedFileURL, isRegularFileURL(url) else { return }
        var edits = recentEditLocations[url] ?? []
        edits.append(EditorEditLocation(line: line, column: column, timestamp: Date()))
        if edits.count > Self.maxRecentEditLocations {
            edits = Array(edits.suffix(Self.maxRecentEditLocations))
        }
        recentEditLocations[url] = edits
    }

    func requestEditorCompletion(
        _ request: EditorCompletionRequest,
        onPartial: @escaping @MainActor (String) -> Void
    ) async -> String? {
        guard let completionService else { return nil }
        guard let rootDirectory else { return nil }
        guard let fileURL = request.fileURL, isRegularFileURL(fileURL) else { return nil }
        let prompt = buildCompletionPrompt(for: request, rootPath: rootDirectory.path)
        do {
            let completion = try await completionService.requestCompletion(prompt: prompt, onDelta: onPartial)
            let sanitized = sanitizeCompletion(completion)
            return sanitized.isEmpty ? nil : sanitized
        } catch {
            return nil
        }
    }

    func cancelEditorCompletion() {
        completionService?.cancelActiveRequest()
    }

    private func buildCompletionPrompt(for request: EditorCompletionRequest, rootPath: String) -> String {
        let fileURL = request.fileURL
        let filePath = fileURL.map { Self.relativePath(for: $0, rootPath: rootPath) } ?? "(unknown)"
        let language = request.languageName ?? "Unknown"
        let (prefix, suffix) = completionContextSlices(
            text: request.text,
            cursorOffset: request.cursorOffset,
            maxPrefix: 4_000,
            maxSuffix: 2_000
        )
        let openFilePaths = openFiles
            .filter { isRegularFileURL($0) }
            .map { Self.relativePath(for: $0, rootPath: rootPath) }
            .prefix(20)
        let openFilesSummary = openFilePaths.isEmpty
            ? "(none)"
            : openFilePaths.map { "- \($0)" }.joined(separator: "\n")
        let recentEdits = fileURL.flatMap { recentEditLocations[$0] } ?? []
        let recentEditsSummary: String
        if recentEdits.isEmpty {
            recentEditsSummary = "(none)"
        } else {
            recentEditsSummary = recentEdits
                .suffix(8)
                .map { "- \($0.line):\($0.column)" }
                .joined(separator: "\n")
        }

        return """
You are a code completion engine. Return ONLY the text to insert at the cursor.
Do not include explanations, markdown, or code fences.
If no completion is appropriate, return an empty string.

File: \(filePath)
Language: \(language)
Cursor: line \(request.line), column \(request.column)

Open files:
\(openFilesSummary)

Recent edits:
\(recentEditsSummary)

<prefix>
\(prefix)
</prefix>
<suffix>
\(suffix)
</suffix>
"""
    }

    private func completionContextSlices(
        text: String,
        cursorOffset: Int,
        maxPrefix: Int,
        maxSuffix: Int
    ) -> (String, String) {
        let nsText = text as NSString
        let length = nsText.length
        let cursor = min(max(cursorOffset, 0), length)
        let prefixStart = max(0, cursor - maxPrefix)
        let prefixRange = NSRange(location: prefixStart, length: cursor - prefixStart)
        let suffixLength = min(maxSuffix, length - cursor)
        let suffixRange = NSRange(location: cursor, length: suffixLength)
        return (
            nsText.substring(with: prefixRange),
            nsText.substring(with: suffixRange)
        )
    }

    private func sanitizeCompletion(_ text: String) -> String {
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return "" }
        if let fenceStart = text.range(of: "```") {
            let afterFence = text[fenceStart.upperBound...]
            if let newlineIndex = afterFence.firstIndex(of: "\n") {
                let contentStart = afterFence.index(after: newlineIndex)
                if let closing = text.range(of: "```", range: contentStart..<text.endIndex) {
                    let inner = String(text[contentStart..<closing.lowerBound])
                    return inner.trimmingCharacters(in: .newlines)
                }
            }
        }
        return text
    }

    private func resolveFileURL(path: String) -> URL? {
        resolvePathURL(path: path, allowDirectory: false)
    }

    private func resolvePathURL(path: String, allowDirectory: Bool) -> URL? {
        let expanded = (path as NSString).expandingTildeInPath
        let fileURL: URL
        if expanded.hasPrefix("/") {
            fileURL = URL(fileURLWithPath: expanded).standardizedFileURL
        } else if let rootDirectory {
            fileURL = URL(fileURLWithPath: expanded, relativeTo: rootDirectory).standardizedFileURL
        } else {
            return nil
        }
        var isDir: ObjCBool = false
        guard FileManager.default.fileExists(atPath: fileURL.path, isDirectory: &isDir) else { return nil }
        if isDir.boolValue && !allowDirectory {
            return nil
        }
        return fileURL
    }


}

extension WorkspaceState {
    func refreshSkills(force: Bool = false) {
        guard !Self.isRunningTests else { return }
        skillRefreshTask?.cancel()
        let root = rootDirectory
        skillRefreshTask = Task.detached(priority: .utility) { [root] in
            let scanner = SkillScanner()
            let output = await scanner.scan(rootDirectory: root)
            if Task.isCancelled { return }
            let directories = scanner.skillDirectories(rootDirectory: root).map(\.url)
            await MainActor.run { [weak self] in
                guard let self else { return }
                self.skillItems = output.skills
                self.skillErrors = output.errors
                self.skillInstructionCache.removeAll()
                self.primeSkillInstructionCache()
                self.setupSkillWatchers(for: directories)
            }
        }
    }

    private func setupSkillWatchers(for directories: [URL]) {
        skillWatchers.forEach { $0.invalidate() }
        skillWatchers = directories.compactMap { url in
            DirectoryWatcher(url: url) { [weak self] in
                Task { @MainActor in
                    self?.refreshSkills(force: true)
                }
            }
        }
    }

    func showSkillBrowser() {
        activeSkillModal = .browse
    }

    func showSkillManager() {
        activeSkillModal = .manage
    }

    func showSkillUse() {
        activeSkillModal = .use
    }

    func showSkillCreator() {
        activeSkillModal = .create
    }

    func openSkillDetail(_ skill: SkillItem) {
        activeSkillModal = .detail(skill)
    }

    func searchRegistry(query: String) async throws -> [SkillRegistryEntry] {
        try await skillRegistryClient.search(query: query)
    }

    func fetchRegistryMarkdown(_ entry: SkillRegistryEntry) async -> String? {
        await skillRegistryClient.fetchSkillMarkdown(source: entry.source, skillId: entry.skillId)
    }

    func installRegistrySkill(_ entry: SkillRegistryEntry, scope: SkillScope) {
        installSkill(source: .registry(entry: entry), scope: scope)
    }

    func installSkill(from input: String, scope: SkillScope) {
        let trimmed = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        let (sourceText, skillName) = parseSkillInstallInput(trimmed)
        if let localURL = resolvePathURL(path: sourceText, allowDirectory: true) {
            installSkill(source: .local(path: localURL.path, skillName: skillName), scope: scope)
            return
        }
        installSkill(source: .git(url: sourceText, skillName: skillName), scope: scope)
    }

    private func parseSkillInstallInput(_ text: String) -> (String, String?) {
        guard let atIndex = text.lastIndex(of: "@") else {
            return (text, nil)
        }
        let after = text[text.index(after: atIndex)...]
        let before = text[..<atIndex]
        if after.contains("/") || after.isEmpty {
            return (text, nil)
        }
        if before.contains("git@") || before.contains("://") {
            return (text, nil)
        }
        return (String(before), String(after))
    }

    private func installSkill(source: SkillInstallSource, scope: SkillScope) {
        guard scope != .system else {
            showToast("System skills are read-only.")
            return
        }
        let root = rootDirectory
        let confirmScripts: @Sendable ([URL]) -> Bool = { scripts in
            if Thread.isMainThread {
                return WorkspaceState.confirmSkillScripts(scripts)
            }
            return DispatchQueue.main.sync {
                WorkspaceState.confirmSkillScripts(scripts)
            }
        }

        Task { [weak self] in
            guard let self else { return }
            do {
                let result = try await Task.detached(priority: .utility) { [source, scope, root, confirmScripts] in
                    let installer = SkillInstaller()
                    return try installer.install(
                        source: source,
                        scope: scope,
                        rootDirectory: root,
                        confirmScripts: confirmScripts
                    )
                }.value
                await MainActor.run {
                    self.showToast("Installed \(result.skill.name) to \(scope.rawValue)")
                    self.refreshSkills(force: true)
                }
            } catch {
                await MainActor.run {
                    self.appendErrorMessage("Skill install failed: \(error.localizedDescription)")
                }
            }
        }
    }

    func updateSkill(_ skill: SkillItem) {
        guard let source = skill.source, !source.isEmpty else {
            showToast("No update source available.")
            return
        }
        installSkill(source: .git(url: source, skillName: skill.name), scope: skill.scope)
    }

    func removeSkill(_ skill: SkillItem) {
        guard skill.scope == .project || skill.scope == .user else {
            showToast("This skill cannot be removed.")
            return
        }
        let alert = NSAlert()
        alert.messageText = "Remove \"\(skill.name)\"?"
        alert.informativeText = "This deletes the skill from \(skill.scope.rawValue) scope."
        alert.addButton(withTitle: "Remove")
        alert.addButton(withTitle: "Cancel")
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        do {
            try FileManager.default.removeItem(at: skill.path)
            SkillInstallStore.shared.remove(path: skill.path)
            showToast("Removed \(skill.name)")
            refreshSkills(force: true)
        } catch {
            appendErrorMessage("Failed to remove skill: \(error.localizedDescription)")
        }
    }

    func moveSkill(_ skill: SkillItem, to scope: SkillScope) {
        guard skill.scope != scope else { return }
        guard let destinationRoot = skillScopeDirectory(for: scope) else {
            showToast("Open a folder to move project skills.")
            return
        }
        let destination = destinationRoot.appendingPathComponent(skill.name, isDirectory: true)
        do {
            try FileManager.default.createDirectory(at: destinationRoot, withIntermediateDirectories: true)
            if FileManager.default.fileExists(atPath: destination.path) {
                try FileManager.default.removeItem(at: destination)
            }
            try FileManager.default.copyItem(at: skill.path, to: destination)
            if let record = SkillInstallStore.shared.record(for: skill.path) {
                let updated = SkillInstallRecord(
                    path: destination.standardizedFileURL.path,
                    source: record.source,
                    installedAt: record.installedAt,
                    lastUpdatedAt: record.lastUpdatedAt
                )
                SkillInstallStore.shared.upsert(record: updated)
                SkillInstallStore.shared.remove(path: skill.path)
            }
            try FileManager.default.removeItem(at: skill.path)
            showToast("Moved \(skill.name) to \(scope.rawValue)")
            refreshSkills(force: true)
        } catch {
            appendErrorMessage("Failed to move skill: \(error.localizedDescription)")
        }
    }

    func isSkillActive(_ skill: SkillItem) -> Bool {
        activeSkills.contains { $0.skill.id == skill.id }
    }

    func activateSkillInline(_ skill: SkillItem) {
        guard !isTurnInProgress else {
            showToast("Wait for the current turn to finish.")
            return
        }
        guard !isSkillActive(skill) else {
            showToast("Skill \"\(skill.name)\" is already active.")
            return
        }
        let arguments = promptForSkillArguments(skill)
        guard arguments != nil || skill.argumentHint == nil else { return }
        let active = ActiveSkill(
            id: "\(skill.id)::inline",
            skill: skill,
            activatedAt: Date(),
            mode: .inline,
            arguments: arguments
        )
        cacheSkillInstruction(for: active)
        activeSkills.append(active)
        storeActiveChatSessionState()
        showToast("Skill \"\(skill.name)\" activated")
    }

    func activateSkillInNewTab(_ skill: SkillItem) {
        guard !isTurnInProgress else {
            showToast("Wait for the current turn to finish.")
            return
        }
        guard let rootDirectory else {
            appendErrorMessage("Open a folder to start a skill tab.")
            return
        }
        guard let codexService else {
            appendErrorMessage("Codex service is not running.")
            return
        }
        let arguments = promptForSkillArguments(skill)
        guard arguments != nil || skill.argumentHint == nil else { return }
        Task { @MainActor [weak self] in
            guard let self else { return }
            do {
                let threadId = try await codexService.startNewThread(cwd: rootDirectory.path)
                storeActiveChatSessionState()
                let chatId = UUID().uuidString
                let session = ChatSessionState(
                    id: chatId,
                    title: skill.name,
                    threadId: threadId,
                    messages: Self.initialChatMessages(),
                    activeSkills: [
                        ActiveSkill(
                            id: "\(skill.id)::tab::\(threadId)",
                            skill: skill,
                            activatedAt: Date(),
                            mode: .tab(threadId: threadId),
                            arguments: arguments
                        )
                    ]
                )
                if let active = session.activeSkills.first {
                    cacheSkillInstruction(for: active)
                }
                chatSessions[chatId] = session
                activeChatId = chatId
                loadChatSessionState(session)
                updateActiveThreadId(threadId)
                let url = Self.chatURL(for: chatId)
                if !openFiles.contains(url) {
                    openFiles.append(url)
                }
                selectedFileURL = url
                currentLanguage = nil
                setEditorText("")
                showToast("Skill \"\(skill.name)\" opened in new tab")
                if let args = arguments, !args.isEmpty {
                    sendChatMessage(text: args)
                }
            } catch {
                appendErrorMessage("Failed to start skill tab: \(error.localizedDescription)")
            }
        }
    }

    func deactivateSkill(_ skill: SkillItem) {
        activeSkills.removeAll { $0.skill.id == skill.id }
        let prefix = "\(skill.id)::"
        skillInstructionCache = skillInstructionCache.filter { !($0.key.hasPrefix(prefix)) }
        storeActiveChatSessionState()
    }

    func deactivateAllSkills() {
        activeSkills.removeAll()
        skillInstructionCache.removeAll()
        storeActiveChatSessionState()
    }

    func createSkill(
        name: String,
        scope: SkillScope,
        contents: String,
        scripts: [SkillScriptTemplate]
    ) -> Bool {
        let trimmedName = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedName.isEmpty else {
            showToast("Skill name is required.")
            return false
        }
        guard let destinationRoot = skillScopeDirectory(for: scope) else {
            showToast("Open a folder to create project skills.")
            return false
        }
        let document = SkillFrontmatterParser.parseDocument(from: contents)
        guard let fmName = document.frontmatter.name,
              let _ = document.frontmatter.description,
              fmName == trimmedName
        else {
            showToast("SKILL.md frontmatter must include matching name and description.")
            return false
        }
        let destination = destinationRoot.appendingPathComponent(trimmedName, isDirectory: true)
        do {
            try FileManager.default.createDirectory(at: destinationRoot, withIntermediateDirectories: true)
            if FileManager.default.fileExists(atPath: destination.path) {
                let alert = NSAlert()
                alert.messageText = "Overwrite skill \"\(trimmedName)\"?"
                alert.informativeText = "This replaces the existing skill contents."
                alert.addButton(withTitle: "Overwrite")
                alert.addButton(withTitle: "Cancel")
                guard alert.runModal() == .alertFirstButtonReturn else { return false }
                try FileManager.default.removeItem(at: destination)
            }
            try FileManager.default.createDirectory(at: destination, withIntermediateDirectories: true)
            let skillFile = destination.appendingPathComponent("SKILL.md")
            try contents.trimmingCharacters(in: .newlines).appending("\n").write(to: skillFile, atomically: true, encoding: .utf8)
            if !scripts.isEmpty {
                let scriptsDir = destination.appendingPathComponent("scripts", isDirectory: true)
                try FileManager.default.createDirectory(at: scriptsDir, withIntermediateDirectories: true)
                for script in scripts {
                    let scriptURL = scriptsDir.appendingPathComponent(script.name)
                    try script.contents.trimmingCharacters(in: .newlines).appending("\n").write(to: scriptURL, atomically: true, encoding: .utf8)
                    if script.isExecutable {
                        makeFileExecutable(at: scriptURL)
                    }
                }
            }
            let record = SkillInstallRecord(
                path: destination.standardizedFileURL.path,
                source: nil,
                installedAt: Date(),
                lastUpdatedAt: nil
            )
            SkillInstallStore.shared.upsert(record: record)
            showToast("Created skill \"\(trimmedName)\"")
            refreshSkills(force: true)
            return true
        } catch {
            appendErrorMessage("Failed to create skill: \(error.localizedDescription)")
            return false
        }
    }

    nonisolated private static func confirmSkillScripts(_ scripts: [URL]) -> Bool {
        let list = scripts.map { $0.lastPathComponent }.sorted().joined(separator: "\n• ")
        let alert = NSAlert()
        alert.messageText = "Skill includes scripts"
        alert.informativeText = "These scripts will be installed and marked executable:\n• \(list)"
        alert.addButton(withTitle: "Install")
        alert.addButton(withTitle: "Cancel")
        return alert.runModal() == .alertFirstButtonReturn
    }

    private func promptForSkillArguments(_ skill: SkillItem) -> String? {
        guard let hint = skill.argumentHint, !hint.isEmpty else { return "" }
        let alert = NSAlert()
        alert.messageText = "Arguments for \"\(skill.name)\""
        alert.informativeText = hint
        let input = NSTextField(string: "")
        input.placeholderString = hint
        alert.accessoryView = input
        alert.addButton(withTitle: "Continue")
        alert.addButton(withTitle: "Cancel")
        let response = alert.runModal()
        if response == .alertFirstButtonReturn {
            return input.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        }
        return nil
    }

    private func skillScopeDirectory(for scope: SkillScope) -> URL? {
        let fm = FileManager.default
        switch scope {
        case .project:
            guard let rootDirectory else { return nil }
            return rootDirectory.appendingPathComponent(".agents/skills", isDirectory: true)
        case .user:
            return fm.homeDirectoryForCurrentUser.appendingPathComponent(".agents/skills", isDirectory: true)
        case .admin:
            return URL(fileURLWithPath: "/etc/codex/skills", isDirectory: true)
        case .system:
            return nil
        }
    }

    private func makeFileExecutable(at url: URL) {
        let fm = FileManager.default
        guard let attributes = try? fm.attributesOfItem(atPath: url.path),
              var permissions = attributes[.posixPermissions] as? NSNumber else { return }
        let current = permissions.intValue
        let updated = current | 0o111
        permissions = NSNumber(value: updated)
        try? fm.setAttributes([.posixPermissions: permissions], ofItemAtPath: url.path)
    }

    private func primeSkillInstructionCache() {
        guard !activeSkills.isEmpty else { return }
        for active in activeSkills {
            cacheSkillInstruction(for: active)
        }
    }

    private func cacheSkillInstruction(for active: ActiveSkill) {
        guard skillInstructionCache[active.id] == nil else { return }
        guard let block = renderSkillInstructionBlock(active) else { return }
        skillInstructionCache[active.id] = block
    }

    private func buildSkillInstructionInputs() -> [UserInput] {
        guard !activeSkills.isEmpty else { return [] }
        return activeSkills.compactMap { active in
            if let cached = skillInstructionCache[active.id] {
                return UserInput.text(cached)
            }
            guard let block = renderSkillInstructionBlock(active) else { return nil }
            skillInstructionCache[active.id] = block
            return UserInput.text(block)
        }
    }

    private func renderSkillInstructionBlock(_ active: ActiveSkill) -> String? {
        let skillFile = active.skill.path.appendingPathComponent("SKILL.md")
        guard let contents = try? String(contentsOf: skillFile, encoding: .utf8) else { return nil }
        let expanded = expandSkillArguments(contents, arguments: active.arguments)
        let path = skillFile.standardizedFileURL.path
        return "<skill>\n<name>\(active.skill.name)</name>\n<path>\(path)</path>\n\(expanded)\n</skill>"
    }

    private func expandSkillArguments(_ text: String, arguments: String?) -> String {
        guard let arguments, !arguments.isEmpty else { return text }
        var output = text.replacingOccurrences(of: "$ARGUMENTS", with: arguments)
        let parts = arguments.split(whereSeparator: { $0.isWhitespace }).map(String.init)
        for index in 1...9 {
            let token = "$\(index)"
            let replacement = index <= parts.count ? parts[index - 1] : ""
            output = output.replacingOccurrences(of: token, with: replacement)
        }
        return output
    }

    private struct SnapshotOperationMetadata: Codable {
        let restoreOperationId: String?
        let snapshotOperationId: String?
    }

    // MARK: - JJ Version Control Integration

    func setupJJService(for url: URL) {
        let service = JJService(workingDirectory: url)
        let vcsType = service.detectVCS()
        jjService = service

        if vcsType == .jjColocated || vcsType == .jjNative {
            let store = JJSnapshotStore(workspacePath: url.path)
            do {
                try store.setup()
                jjSnapshotStore = store
            } catch {
                // SQLite setup failed — non-fatal
            }

            // Set up agent orchestrator
            agentOrchestrator = AgentOrchestrator(
                mainWorkspace: url,
                jjService: service,
                snapshotStore: store,
                preferences: vcsPreferences
            )

            // Initial refresh
            Task {
                await refreshJJStatus()
                detectedCommitStyle = await CommitStyleDetector.detectFromRepo(jjService: service)
            }
        } else {
            jjSnapshotStore = nil
            agentOrchestrator = nil
            jjModifiedFiles = []
            jjChangeLog = []
            jjBookmarks = []
            jjOperations = []
            jjConflicts = []
            jjSnapshots = []
            detectedCommitStyle = .freeform
            isJJPanelVisible = false
            isAgentDashboardVisible = false
        }
    }

    func refreshJJStatus() async {
        guard let jjService, jjService.isAvailable else { return }
        do {
            let status = try await jjService.status()
            jjModifiedFiles = status.modifiedFiles
            jjConflicts = status.conflicts

            let changes = try await jjService.log(limit: 50)
            jjChangeLog = changes

            let bookmarks = try await jjService.bookmarkList()
            jjBookmarks = bookmarks

            let ops = try await jjService.opLog(limit: 20)
            jjOperations = ops

            if let store = jjSnapshotStore {
                jjSnapshots = (try? await store.snapshotsForWorkspace()) ?? []
            }
        } catch {
            // Silently fail on refresh
        }

        rebuildPaletteCommands()
    }

    func initJJRepo() async {
        guard let jjService else { return }
        do {
            try await jjService.initJJColocated()
            if let rootDirectory {
                let store = JJSnapshotStore(workspacePath: rootDirectory.path)
                try store.setup()
                jjSnapshotStore = store
                agentOrchestrator = AgentOrchestrator(
                    mainWorkspace: rootDirectory,
                    jjService: jjService,
                    snapshotStore: store,
                    preferences: vcsPreferences
                )
            }
            await refreshJJStatus()
            showToast("jj initialized (colocated with git)")
        } catch {
            appendErrorMessage("Failed to initialize jj: \(error.localizedDescription)")
        }
    }

    private func snapshotOperationMetadata() async -> String? {
        guard let jjService, jjService.isAvailable else { return nil }
        do {
            let ops = try await jjService.opLog(limit: 2)
            let metadata = SnapshotOperationMetadata(
                restoreOperationId: ops.count > 1 ? ops[1].operationId : nil,
                snapshotOperationId: ops.first?.operationId
            )
            let data = try JSONEncoder().encode(metadata)
            return String(data: data, encoding: .utf8)
        } catch {
            return nil
        }
    }

    private func decodeSnapshotMetadata(_ snapshot: Snapshot) -> SnapshotOperationMetadata? {
        guard let text = snapshot.metadata,
              let data = text.data(using: .utf8) else { return nil }
        return try? JSONDecoder().decode(SnapshotOperationMetadata.self, from: data)
    }

    private func resolveRestoreOperationId(for snapshot: Snapshot) async -> String? {
        guard let jjService, jjService.isAvailable else { return nil }
        let metadata = decodeSnapshotMetadata(snapshot)
        if let restoreId = metadata?.restoreOperationId {
            return restoreId
        }
        do {
            let ops = try await jjService.opLog(limit: 200)
            if let resolved = resolveRestoreOperationId(
                from: ops,
                snapshotOpId: metadata?.snapshotOperationId,
                snapshotDate: snapshot.createdAt
            ) {
                return resolved
            }
            if ops.count == 200 {
                let fullOps = try await jjService.opLog()
                return resolveRestoreOperationId(
                    from: fullOps,
                    snapshotOpId: metadata?.snapshotOperationId,
                    snapshotDate: snapshot.createdAt
                )
            }
            return nil
        } catch {
            return nil
        }
    }

    private func resolveRestoreOperationId(
        from ops: [JJOperation],
        snapshotOpId: String?,
        snapshotDate: Date
    ) -> String? {
        if let snapshotOpId,
           let index = ops.firstIndex(where: { $0.operationId == snapshotOpId }) {
            let restoreIndex = index + 1
            guard restoreIndex < ops.count else { return nil }
            return ops[restoreIndex].operationId
        }
        return resolveRestoreOperationId(from: ops, snapshotDate: snapshotDate)
    }

    private func resolveRestoreOperationId(from ops: [JJOperation], snapshotDate: Date) -> String? {
        guard !ops.isEmpty else { return nil }
        for (index, op) in ops.enumerated() {
            if op.timestamp <= snapshotDate {
                let restoreIndex = index + 1
                guard restoreIndex < ops.count else { return nil }
                return ops[restoreIndex].operationId
            }
        }
        return nil
    }

    // MARK: - Auto-Snapshot

    private func autoSnapshotAfterTurn(turnId: String) {
        guard let jjService, jjService.isAvailable, vcsPreferences.snapshotOnAIChange else { return }
        Task {
            do {
                let summary = lastAssistantMessageSummary()
                try await jjService.describe(message: "ai: \(summary)")
                let newChange = try await jjService.newChange()
                let metadata = await snapshotOperationMetadata()

                // Record in SQLite
                let chatSession = activeChatId
                let messageIndex = chatMessages.count - 1
                if let store = jjSnapshotStore {
                    try? await store.recordSnapshot(
                        changeId: newChange.changeId,
                        commitId: newChange.commitId,
                        description: "ai: \(summary)",
                        snapshotType: .aiChange,
                        chatSessionId: chatSession,
                        chatMessageIndex: messageIndex,
                        metadata: metadata
                    )
                }

                // Write git note if enabled
                if vcsPreferences.gitNotesOnCommit, jjService.detectedVCSType == .jjColocated {
                    let commitId = try await jjService.commitIdForChange(newChange.changeId)
                    let note = SmithersNotePayload(
                        sessionId: chatSession,
                        prompts: [],
                        model: nil,
                        filesChanged: jjModifiedFiles.map(\.path),
                        snapshotIds: [newChange.changeId]
                    )
                    if let noteJSON = try? JSONEncoder().encode(note),
                       let noteStr = String(data: noteJSON, encoding: .utf8) {
                        try? await jjService.addGitNote(commitId: commitId, note: noteStr)
                    }
                }

                await refreshJJStatus()
            } catch {
                // Non-fatal
            }
        }
    }

    private func snapshotOnSaveIfEnabled(url: URL) {
        guard let jjService, jjService.isAvailable, vcsPreferences.snapshotOnSave else { return }

        saveSnapshotDebounceTask?.cancel()
        saveSnapshotDebounceTask = Task {
            try? await Task.sleep(nanoseconds: 2_000_000_000) // 2 second debounce
            guard !Task.isCancelled else { return }
            do {
                let filename = url.lastPathComponent
                try await jjService.describe(message: "save: \(filename)")
                let newChange = try await jjService.newChange()
                let metadata = await snapshotOperationMetadata()

                if let store = jjSnapshotStore {
                    try? await store.recordSnapshot(
                        changeId: newChange.changeId,
                        commitId: newChange.commitId,
                        description: "save: \(filename)",
                        snapshotType: .userSave,
                        metadata: metadata
                    )
                }

                await refreshJJStatus()
            } catch {
                // Non-fatal
            }
        }
    }

    private func lastAssistantMessageSummary() -> String {
        if let last = chatMessages.last(where: { $0.role == .assistant }) {
            if case .text(let text) = last.kind {
                let firstLine = text.components(separatedBy: "\n").first ?? text
                return String(firstLine.prefix(80))
            }
        }
        return "AI change"
    }

    // MARK: - JJ Actions

    func jjCommit() async {
        guard let jjService, jjService.isAvailable else { return }
        do {
            let files = try await jjService.diffSummary()
            guard !files.isEmpty else {
                showToast("No changes to commit")
                return
            }

            // Auto-generate a commit message based on detected style
            let description = "commit: \(files.count) file(s) changed"
            try await jjService.describe(message: description)
            _ = try await jjService.newChange()
            let metadata = await snapshotOperationMetadata()

            if let store = jjSnapshotStore {
                try? await store.recordSnapshot(
                    changeId: "",
                    commitId: nil,
                    description: description,
                    snapshotType: .manualCommit,
                    metadata: metadata
                )
            }

            await refreshJJStatus()
            showToast("Committed")
        } catch {
            appendErrorMessage("Commit failed: \(error.localizedDescription)")
        }
    }

    func jjNewChange() async {
        guard let jjService, jjService.isAvailable else { return }
        do {
            _ = try await jjService.newChange()
            await refreshJJStatus()
            showToast("New change created")
        } catch {
            appendErrorMessage("Failed to create new change: \(error.localizedDescription)")
        }
    }

    func jjUndo() async {
        guard let jjService, jjService.isAvailable else { return }
        do {
            try await jjService.undo()
            await refreshJJStatus()
            showToast("Undone")
        } catch {
            appendErrorMessage("Undo failed: \(error.localizedDescription)")
        }
    }

    // MARK: - JJ Panel Actions

    func openJJDiff(for file: JJFileDiff) {
        guard let jjService else { return }
        Task {
            do {
                let diff = try await jjService.diff(paths: [file.path])
                let title = file.path.split(separator: "/").last.map(String.init) ?? file.path
                let summary = "\(file.status.rawValue) \(file.path)"
                if let url = diffTabURL(category: "jj-file", identifier: file.path) {
                    openDiffTab(id: url, title: title, summary: summary, diff: diff)
                } else {
                    openDiffTab(title: title, summary: summary, diff: diff)
                }
            } catch {
                appendErrorMessage("Failed to get diff: \(error.localizedDescription)")
            }
        }
    }

    func openJJChangeDiff(_ change: JJChange) async {
        guard let jjService else { return }
        do {
            let diff = try await jjService.diff(revision: change.changeId)
            let title = change.shortChangeId
            let summary = change.firstLine
            if let url = diffTabURL(category: "jj-change", identifier: change.shortChangeId) {
                openDiffTab(id: url, title: title, summary: summary, diff: diff)
            } else {
                openDiffTab(title: title, summary: summary, diff: diff)
            }
        } catch {
            appendErrorMessage("Failed to get diff: \(error.localizedDescription)")
        }
    }

    func openFileFromJJPanel(_ path: String) {
        guard let rootDirectory else { return }
        let url = canonicalFileURL(rootDirectory.appendingPathComponent(path))
        selectFile(url)
    }

    func revertJJFile(_ path: String) async {
        guard let jjService else { return }
        do {
            // Restore the file from the parent change
            _ = try await jjService.runJJ(["restore", "--from", "@-", path])
            await refreshJJStatus()
            // Reload the file if it's currently open
            if let rootDirectory {
                let url = canonicalFileURL(rootDirectory.appendingPathComponent(path))
                if openFiles.contains(url) {
                    reloadFileContent(url)
                }
            }
            showToast("Reverted \(path)")
        } catch {
            appendErrorMessage("Revert failed: \(error.localizedDescription)")
        }
    }

    private func reloadFileContent(_ url: URL) {
        let canonicalURL = canonicalFileURL(url)
        if let content = try? String(contentsOf: canonicalURL, encoding: .utf8) {
            savedFileContents[canonicalURL] = content
            openFileContents[canonicalURL] = content
            clearNativeDirty(canonicalURL)
            if selectedFileURL == canonicalURL {
                suppressEditorTextUpdate = true
                editorText = content
                suppressEditorTextUpdate = false
            }
        }
    }

    func showJJDescribePrompt() {
        // Use a simple toast for now — could be enhanced with a text input dialog
        showToast("Use command palette to describe the working copy")
    }

    func showJJDescribePromptForChange(_ change: JJChange) {
        showToast("Describe change \(change.shortChangeId)")
    }

    func showJJBookmarkPrompt(for change: JJChange) {
        showToast("Create bookmark for \(change.shortChangeId)")
    }

    // MARK: - Snapshot Actions

    func revertToSnapshot(_ snapshot: Snapshot) async {
        let isLatest: Bool
        if let store = jjSnapshotStore, let latest = try? await store.latestSnapshot() {
            isLatest = latest.id == snapshot.id || latest.changeId == snapshot.changeId
        } else {
            isLatest = true
        }
        await revertJJSnapshot(snapshot, isLatest: isLatest)
    }

    func viewSnapshotDiff(_ snapshot: Snapshot) async {
        guard let jjService else { return }
        do {
            let diff = try await jjService.diff(revision: snapshot.changeId)
            let title = "Snapshot \(String(snapshot.changeId.prefix(8)))"
            let summary = snapshot.description
            if let url = diffTabURL(category: "snapshot", identifier: snapshot.changeId) {
                openDiffTab(id: url, title: title, summary: summary, diff: diff)
            } else {
                openDiffTab(title: title, summary: summary, diff: diff)
            }
        } catch {
            appendErrorMessage("Failed to get snapshot diff: \(error.localizedDescription)")
        }
    }

    func navigateToSnapshotChat(_ snapshot: Snapshot) {
        if let sessionId = snapshot.chatSessionId {
            openChat(id: sessionId, title: chatSessions[sessionId]?.title, select: true)
        }
    }

    func showSnapshotBrowser() {
        // Toggle the snapshot browser panel
        showToast("Snapshot browser")
    }

    // MARK: - Agent Actions

    func showNewAgentPrompt() {
        showToast("Use chat to spawn agents: 'Run an agent to...'")
    }

    func switchToAgentChat(_ agent: AgentWorkspace) {
        activeChatId = agent.chatSessionId
    }

    func viewAgentDiff(_ agent: AgentWorkspace) async {
        guard let jjService else { return }
        do {
            let diff = try await jjService.diff(revision: agent.changeId)
            let title = "Agent: \(agent.id)"
            let summary = agent.task
            if let url = diffTabURL(category: "agent", identifier: agent.id) {
                openDiffTab(id: url, title: title, summary: summary, diff: diff)
            } else {
                openDiffTab(title: title, summary: summary, diff: diff)
            }
        } catch {
            appendErrorMessage("Failed to get agent diff: \(error.localizedDescription)")
        }
    }

    // MARK: - Revert Chat Message (JJ)

    func jjRevertActionInfo(_ message: ChatMessage) async -> JJRevertActionInfo? {
        guard jjService?.isAvailable == true else { return nil }
        guard message.role == .assistant else { return nil }
        guard message.turnId != nil else { return nil }
        guard !isTurnInProgress else { return nil }
        // Check if there's a snapshot for this message
        if let store = jjSnapshotStore,
           let sessionId = activeChatId as String?,
           let idx = chatMessages.firstIndex(where: { $0.id == message.id }) {
            let snapshot = try? await store.snapshotForMessage(sessionId: sessionId, messageIndex: idx)
            if let snapshot {
                let latest = try? await store.latestSnapshot()
                let isLatest = latest == nil || latest?.id == snapshot.id || latest?.changeId == snapshot.changeId
                return JJRevertActionInfo(snapshot: snapshot, isLatest: isLatest)
            }
        }
        return nil
    }

    func canRevertJJMessage(_ message: ChatMessage) async -> Bool {
        await jjRevertActionInfo(message) != nil
    }

    func revertJJMessage(_ message: ChatMessage) async {
        guard let info = await jjRevertActionInfo(message) else { return }
        await revertJJSnapshot(info.snapshot, isLatest: info.isLatest)
    }

    func revertJJSnapshot(_ snapshot: Snapshot, isLatest: Bool) async {
        guard let jjService, jjService.isAvailable else { return }
        do {
            guard let opId = await resolveRestoreOperationId(for: snapshot) else {
                appendErrorMessage("Unable to locate operation for snapshot.")
                return
            }
            try await jjService.opRestore(operationId: opId)
            await refreshJJStatus()
            showToast(isLatest ? "Reverted" : "Reverted to snapshot")
        } catch {
            appendErrorMessage("Revert failed: \(error.localizedDescription)")
        }
    }

    private func rebuildPaletteCommands() {
        paletteCommands = buildCommandList()
    }
}

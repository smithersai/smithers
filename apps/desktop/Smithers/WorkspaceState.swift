import SwiftUI
import AppKit
import Foundation

struct FileIndexEntry: Identifiable, Hashable, Sendable {
    let id: URL
    let url: URL
    let displayPath: String
    let lowercasedPath: String

    init(url: URL, displayPath: String) {
        self.id = url
        self.url = url
        self.displayPath = displayPath
        self.lowercasedPath = displayPath.lowercased()
    }
}

struct PaletteCommand: Identifiable {
    let id: String
    let title: String
    let icon: String
    let action: () -> Void
}

struct DiffTab: Identifiable, Hashable {
    let id: URL
    let title: String
    let summary: String
    let diff: String
}

@MainActor
class WorkspaceState: ObservableObject {
    enum NvimModeError: Error, LocalizedError {
        case missingWorkspace

        var errorDescription: String? {
            switch self {
            case .missingWorkspace:
                return "Open a folder before enabling Neovim mode."
            }
        }
    }

    private enum CloseContext {
        case tab(URL)
        case window
        case application
    }

    private enum CloseDecision {
        case deny
        case allow(force: Bool)
    }

    @Published var rootDirectory: URL?
    @Published var fileTree: [FileItem] = []
    @Published var openFiles: [URL] = []
    @Published var selectedFileURL: URL? {
        didSet {
            updateWindowTitle()
        }
    }
    @Published var terminalViews: [URL: GhosttyTerminalView] = [:]
    @Published private(set) var nvimTerminalView: GhosttyTerminalView?
    @Published private(set) var nvimCurrentFilePath: String?
    @Published private(set) var nvimModifiedBuffers: [NvimModifiedBuffer] = [] {
        didSet {
            updateWindowTitle()
        }
    }
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
            let wasModified = isNativeFileModified(selectedFileURL)
            openFileContents[selectedFileURL] = editorText
            let nowModified = isNativeFileModified(selectedFileURL)
            if wasModified != nowModified {
                updateWindowTitle()
            }
        }
    }
    @Published var currentLanguage: SupportedLanguage?
    @Published var chatMessages: [ChatMessage] = [
        ChatMessage(role: .assistant, kind: .text("Chat ready. Ask me anything."))
    ]
    @Published var theme: AppTheme = .default
    @Published var activeDiffPreview: DiffPreview?
    @Published var activeSessionDiff: SessionDiffSnapshot?
    @Published private(set) var sessionDiffSnapshot: SessionDiffSnapshot?
    @Published var diffTabs: [URL: DiffTab] = [:]
    @Published var chatDraft: String = ""
    @Published var isTurnInProgress: Bool = false
    @Published var isCommandPalettePresented: Bool = false
    @Published var isNvimModeEnabled: Bool = false
    @Published var fileSearchQuery: String = "" {
        didSet {
            scheduleSearch()
        }
    }
    @Published private(set) var fileSearchResults: [FileIndexEntry] = []
    @Published private(set) var paletteCommands: [PaletteCommand] = []
    private var fileLoadTask: Task<Void, Never>?
    private var fileIndex: [FileIndexEntry] = []
    private var fileIndexTask: Task<Void, Never>?
    private var searchTask: Task<Void, Never>?
    private var openFileContents: [URL: String] = [:]
    private var savedFileContents: [URL: String] = [:]
    private var suppressEditorTextUpdate = false
    private var suppressSelectionSync = false
    private var closeGuardsBypassed = false
    private var turnDiffs: [String: String] = [:]
    private var turnDiffOrder: [String] = []
    private var streamingTurnDiffs: [String: String] = [:]
    private static let chatURL = URL(string: "smithers-chat://current")!
    private static let terminalScheme = "smithers-terminal"
    private static let openFileScheme = "smithers-open-file"
    private static let diffScheme = "smithers-diff"
    private static let lastWorkspaceKey = "smithers.lastWorkspacePath"
    private var terminalCounter = 0
    private let ghosttyApp = GhosttyApp.shared
    private var nvimController: NvimController?
    private var nvimStartTask: Task<NvimController, Error>?
    private var codexService: CodexService?
    private var codexEventsTask: Task<Void, Never>?
    nonisolated private static let maxSearchResults = 200
    nonisolated private static let skipDirectoryNames: Set<String> = [
        ".git",
        ".svn",
        ".hg",
        ".DS_Store",
        "node_modules",
        "DerivedData",
        "build",
        "dist"
    ]

    func openDirectory(_ url: URL) {
        let shouldRestartNvim = isNvimModeEnabled
        stopNvim()
        stopCodexService()
        closeAllTerminals()
        saveLastWorkspace(url)
        rootDirectory = url
        fileTree = FileItem.loadTree(at: url)
        openFiles = []
        selectedFileURL = nil
        setEditorText("")
        currentLanguage = nil
        fileLoadTask?.cancel()
        openFileContents = [:]
        savedFileContents = [:]
        fileIndex = []
        fileSearchResults = []
        activeDiffPreview = nil
        activeSessionDiff = nil
        sessionDiffSnapshot = nil
        turnDiffs = [:]
        turnDiffOrder = []
        streamingTurnDiffs = [:]
        diffTabs = [:]
        openChat()
        rebuildFileIndex()
        startCodexService(cwd: url.path)
        if shouldRestartNvim {
            Task { [weak self] in
                guard let self else { return }
                do {
                    _ = try await self.ensureNvimStarted()
                } catch {
                    self.appendErrorMessage("Neovim failed to start: \(error.localizedDescription)")
                    self.isNvimModeEnabled = false
                }
            }
        }
    }

    func selectFile(_ url: URL) {
        if suppressSelectionSync {
            suppressSelectionSync = false
            return
        }
        if isChatURL(url) {
            openChat()
            return
        }
        if isTerminalURL(url) {
            selectedFileURL = url
            currentLanguage = nil
            setEditorText("")
            return
        }
        if isDiffURL(url) {
            selectedFileURL = url
            currentLanguage = nil
            setEditorText("")
            return
        }
        var isDir: ObjCBool = false
        if FileManager.default.fileExists(atPath: url.path, isDirectory: &isDir), isDir.boolValue {
            return
        }
        if isNvimModeEnabled {
            openFileInNvim(url, line: nil, column: nil)
            return
        }
        if !openFiles.contains(url) {
            openFiles.append(url)
        }
        selectedFileURL = url
        currentLanguage = SupportedLanguage.fromFileName(url.lastPathComponent)
        fileLoadTask?.cancel()
        if let cached = openFileContents[url] {
            if savedFileContents[url] == nil {
                savedFileContents[url] = cached
            }
            setEditorText(cached)
            return
        }
        setEditorText("")
        let requestedURL = url
        fileLoadTask = Task { [weak self] in
            let text = await Task.detached(priority: .userInitiated) {
                (try? String(contentsOf: requestedURL, encoding: .utf8)) ?? ""
            }.value
            guard !Task.isCancelled, let self else { return }
            if self.savedFileContents[requestedURL] == nil {
                self.savedFileContents[requestedURL] = text
            }
            if self.openFileContents[requestedURL] == nil {
                self.openFileContents[requestedURL] = text
            }
            guard self.selectedFileURL == requestedURL else { return }
            self.setEditorText(text)
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
        if isNvimModeEnabled && isRegularFileURL(url) {
            let wasSelected = selectedFileURL == url
            openFiles.remove(at: index)
            openFileContents.removeValue(forKey: url)
            savedFileContents.removeValue(forKey: url)
            savedFileContents.removeValue(forKey: url.standardizedFileURL)
            if wasSelected {
                selectedFileURL = nil
                currentLanguage = nil
                setEditorText("")
            }
            Task { [weak self] in
                await self?.nvimController?.closeFile(url, force: force)
            }
            return
        }
        let wasSelected = selectedFileURL == url
        openFiles.remove(at: index)
        if isTerminalURL(url) {
            closeTerminal(url)
        } else if isDiffURL(url) {
            diffTabs.removeValue(forKey: url)
        } else {
            openFileContents.removeValue(forKey: url)
            savedFileContents.removeValue(forKey: url)
            savedFileContents.removeValue(forKey: url.standardizedFileURL)
        }

        guard wasSelected else { return }
        fileLoadTask?.cancel()
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

    func setCloseGuardsBypassed(_ value: Bool) {
        closeGuardsBypassed = value
    }

    func shouldBypassCloseGuards() -> Bool {
        closeGuardsBypassed
    }

    private func closeDecisionForTab(_ url: URL) async -> CloseDecision {
        if closeGuardsBypassed || !isNvimModeEnabled || !isRegularFileURL(url) {
            return .allow(force: false)
        }
        guard let buffers = await fetchModifiedNvimBuffers() else {
            let confirmed = confirmUnableToCheck(context: .tab(url))
            return confirmed ? .allow(force: true) : .deny
        }
        let normalized = url.standardizedFileURL
        let matching = buffers.filter { $0.url?.standardizedFileURL == normalized }
        guard !matching.isEmpty else { return .allow(force: false) }
        let confirmed = confirmDiscardChanges(context: .tab(url), buffers: matching)
        return confirmed ? .allow(force: true) : .deny
    }

    private func confirmCloseIfNeeded(context: CloseContext) async -> Bool {
        if closeGuardsBypassed || !isNvimModeEnabled {
            return true
        }
        guard let buffers = await fetchModifiedNvimBuffers() else {
            return confirmUnableToCheck(context: context)
        }
        guard !buffers.isEmpty else { return true }
        return confirmDiscardChanges(context: context, buffers: buffers)
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

    private func confirmDiscardChanges(context: CloseContext, buffers: [NvimModifiedBuffer]) -> Bool {
        let names = uniqueBufferNames(from: buffers)
        let count = names.count
        let listText = formatBufferList(names)
        let alert = NSAlert()
        alert.alertStyle = .warning
        switch context {
        case .tab(let url):
            let name = names.first ?? displayPath(for: url)
            alert.messageText = "The file \"\(name)\" has unsaved changes."
            alert.informativeText = "Closing this tab will discard your changes."
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

    func refreshFileTreeForNewFile(_ url: URL) {
        let parentURL = url.deletingLastPathComponent()
        guard let rootDirectory else { return }
        // Only refresh if the file is within the workspace
        guard url.path.hasPrefix(rootDirectory.path) else { return }
        // Check if the file already exists in the tree — if so, nothing to do
        if fileTreeContains(url: url, in: fileTree) { return }
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
        let normalizedURL = url.standardizedFileURL
        guard let index = openFiles.firstIndex(of: normalizedURL) else { return }
        openFiles.remove(at: index)
        openFileContents.removeValue(forKey: normalizedURL)
        nvimModifiedBuffers.removeAll { $0.url?.standardizedFileURL == normalizedURL }
        if selectedFileURL == normalizedURL {
            selectedFileURL = nil
            currentLanguage = nil
            setEditorText("")
        }
        if nvimCurrentFilePath == normalizedURL.path {
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
    }

    func isNvimBufferModified(_ url: URL) -> Bool {
        let normalized = url.standardizedFileURL
        return nvimModifiedBuffers.contains { $0.url?.standardizedFileURL == normalized }
    }

    private func isNativeFileModified(_ url: URL) -> Bool {
        let normalized = url.standardizedFileURL
        guard let saved = savedFileContents[normalized] ?? savedFileContents[url] else {
            return false
        }
        if let current = openFileContents[normalized] ?? openFileContents[url] {
            return current != saved
        }
        if selectedFileURL == normalized {
            return editorText != saved
        }
        return false
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
        if nextTheme != theme {
            theme = nextTheme
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
        url == Self.chatURL
    }

    func isRegularFileURL(_ url: URL) -> Bool {
        !isChatURL(url) && !isTerminalURL(url) && !isDiffURL(url)
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

    func diffTab(for url: URL) -> DiffTab? {
        diffTabs[url]
    }

    func saveAllFiles() {
        if isNvimModeEnabled {
            Task { @MainActor [weak self] in
                guard let self else { return }
                do {
                    let controller = try await self.ensureNvimStarted()
                    try await controller.saveAll()
                    let buffers = try await controller.listModifiedBuffers()
                    self.setNvimModifiedBuffers(buffers)
                } catch {
                    self.appendErrorMessage("Save failed: \(error.localizedDescription)")
                }
            }
            return
        }
        saveAllNativeFiles()
    }

    func saveCurrentFile() {
        guard let selectedFileURL, isRegularFileURL(selectedFileURL) else { return }
        if isNvimModeEnabled {
            Task { @MainActor [weak self] in
                guard let self else { return }
                do {
                    let controller = try await self.ensureNvimStarted()
                    try await controller.saveCurrent()
                    let buffers = try await controller.listModifiedBuffers()
                    self.setNvimModifiedBuffers(buffers)
                } catch {
                    self.appendErrorMessage("Save failed: \(error.localizedDescription)")
                }
            }
            return
        }
        saveNativeFile(selectedFileURL)
    }

    private func saveAllNativeFiles() {
        var didSave = false
        for url in openFiles where isRegularFileURL(url) {
            let normalized = url.standardizedFileURL
            guard let content = openFileContents[normalized] ?? openFileContents[url] else { continue }
            if let saved = savedFileContents[normalized] ?? savedFileContents[url],
               saved == content {
                continue
            }
            do {
                try content.write(to: normalized, atomically: true, encoding: .utf8)
                savedFileContents[normalized] = content
                savedFileContents[url] = content
                didSave = true
            } catch {
                appendErrorMessage("Failed to save \(displayPath(for: normalized)): \(error.localizedDescription)")
            }
        }
        if didSave {
            updateWindowTitle()
        }
    }

    private func saveNativeFile(_ url: URL) {
        let normalized = url.standardizedFileURL
        let content = openFileContents[normalized] ?? openFileContents[url]
            ?? (selectedFileURL == normalized ? editorText : nil)
        guard let content else { return }
        do {
            try content.write(to: normalized, atomically: true, encoding: .utf8)
            savedFileContents[normalized] = content
            savedFileContents[url] = content
            openFileContents[normalized] = content
            updateWindowTitle()
        } catch {
            appendErrorMessage("Failed to save \(displayPath(for: normalized)): \(error.localizedDescription)")
        }
    }

    private func openFileInNvim(_ url: URL, line: Int?, column: Int?) {
        let normalizedURL = url.standardizedFileURL
        Self.debugLog("[WorkspaceState] openFileInNvim: \(normalizedURL.path)")
        if !openFiles.contains(normalizedURL) {
            openFiles.append(normalizedURL)
        }
        selectedFileURL = normalizedURL
        currentLanguage = nil
        setEditorText("")
        Task { [weak self] in
            guard let self else { return }
            do {
                let controller = try await self.ensureNvimStarted()
                Self.debugLog("[WorkspaceState] openFileInNvim: calling openFile")
                try await controller.openFile(normalizedURL, line: line, column: column)
                Self.debugLog("[WorkspaceState] openFileInNvim: openFile completed OK")
            } catch {
                Self.debugLog("[WorkspaceState] openFileInNvim error: \(error)")
                self.appendErrorMessage("Neovim error: \(error.localizedDescription)")
                if error is NvimRPCError || error is NvimController.ControllerError {
                    self.isNvimModeEnabled = false
                    self.stopNvim()
                }
            }
        }
    }

    private func enableNvimMode() {
        if rootDirectory == nil {
            isNvimModeEnabled = true
            openFolderPanel()
            if rootDirectory == nil {
                isNvimModeEnabled = false
            }
            return
        }
        isNvimModeEnabled = true
        Task { [weak self] in
            guard let self else { return }
            do {
                _ = try await self.ensureNvimStarted()
            } catch {
                self.appendErrorMessage("Neovim failed to start: \(error.localizedDescription)")
                self.isNvimModeEnabled = false
                self.stopNvim()
            }
        }
    }

    private func disableNvimMode() {
        isNvimModeEnabled = false
        stopNvim()
        theme = .default
        if let selectedFileURL, isRegularFileURL(selectedFileURL) {
            selectFile(selectedFileURL)
        }
    }

    private func ensureNvimStarted() async throws -> NvimController {
        if let controller = nvimController, nvimStartTask == nil {
            return controller
        }
        if let task = nvimStartTask {
            return try await task.value
        }

        let task = Task { [weak self] () throws -> NvimController in
            guard let self else { throw CancellationError() }
            guard let rootDirectory = self.rootDirectory else {
                throw NvimModeError.missingWorkspace
            }

            guard let nvimPath = NvimController.locateNvimPath() else {
                throw NvimController.ControllerError.missingNvim
            }
            let controller = NvimController(
                workspace: self,
                ghosttyApp: self.ghosttyApp,
                workingDirectory: rootDirectory.path,
                nvimPath: nvimPath
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
        nvimStartTask?.cancel()
        nvimStartTask = nil
        nvimTerminalView?.onClose = nil
        nvimController?.stop()
        nvimController = nil
        nvimTerminalView = nil
        nvimCurrentFilePath = nil
        nvimModifiedBuffers = []
        updateWindowTitle()
    }

    private func handleNvimTerminalClosed() {
        guard isNvimModeEnabled else { return }
        appendErrorMessage("Neovim exited.")
        isNvimModeEnabled = false
        stopNvim()
    }

    func makeOpenFileURL(path: String, line: Int?, column: Int?) -> URL? {
        guard let fileURL = resolveFileURL(path: path) else { return nil }
        var components = URLComponents()
        components.scheme = Self.openFileScheme
        components.path = "/open"
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
        guard url.scheme == Self.openFileScheme else { return false }
        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return false }
        guard let pathValue = components.queryItems?.first(where: { $0.name == "path" })?.value else { return false }
        guard let resolved = resolveFileURL(path: pathValue) else { return false }
        let line = components.queryItems?.first(where: { $0.name == "line" })?.value.flatMap(Int.init)
        let column = components.queryItems?.first(where: { $0.name == "column" })?.value.flatMap(Int.init)
        if isNvimModeEnabled {
            if selectedFileURL != resolved {
                suppressSelectionSync = true
            }
            openFileInNvim(resolved, line: line, column: column)
        } else {
            selectFile(resolved)
        }
        return true
    }

    func closeSelectedTab() {
        guard let selectedFileURL else { return }
        requestCloseFile(selectedFileURL)
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

    func expandFolder(_ item: FileItem) {
        guard item.needsLoading else { return }
        let children = FileItem.loadShallowChildren(of: item.id)
        var updated = fileTree
        FileItem.replaceChildren(in: &updated, for: item.id, with: children)
        fileTree = updated
    }

    func openFolderPanel() {
        let panel = NSOpenPanel()
        panel.canChooseFiles = false
        panel.canChooseDirectories = true
        panel.allowsMultipleSelection = false
        if panel.runModal() == .OK, let url = panel.url {
            openDirectory(url)
        }
    }

    func restoreLastWorkspaceIfNeeded() {
        guard rootDirectory == nil else { return }
        guard let path = UserDefaults.standard.string(forKey: Self.lastWorkspaceKey) else { return }
        let url = URL(fileURLWithPath: path)
        var isDir: ObjCBool = false
        guard FileManager.default.fileExists(atPath: url.path, isDirectory: &isDir),
              isDir.boolValue else { return }
        openDirectory(url)
    }

    private func saveLastWorkspace(_ url: URL) {
        UserDefaults.standard.set(url.path, forKey: Self.lastWorkspaceKey)
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
            return "Current chat"
        }
        if isTerminalURL(url) {
            return terminalViews[url]?.pwd ?? "Terminal"
        }
        if isDiffURL(url) {
            return diffTabs[url]?.title ?? "Diff"
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

    private func updateWindowTitle() {
        guard let window = NSApp.windows.first(where: { $0.isKeyWindow || $0.isMainWindow }) else { return }
        let title = buildWindowTitle()
        if window.title != title {
            window.title = title
        }
    }

    private func buildWindowTitle() -> String {
        guard let selectedFileURL else { return "Smithers" }
        var title: String
        if isChatURL(selectedFileURL) {
            title = "Chat"
        } else if isTerminalURL(selectedFileURL) {
            let terminalTitle = terminalViews[selectedFileURL]?.title ?? ""
            title = terminalTitle.isEmpty ? "Terminal" : terminalTitle
        } else if isDiffURL(selectedFileURL) {
            title = diffTabs[selectedFileURL]?.title ?? "Diff"
        } else {
            title = displayPath(for: selectedFileURL)
        }
        if isRegularFileURL(selectedFileURL), isFileModified(selectedFileURL) {
            title += "*"
        }
        return "\(title) - Smithers"
    }

    func sendChatMessage() {
        let text = chatDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        chatMessages.append(ChatMessage(role: .user, kind: .text(text)))
        chatDraft = ""
        guard let codexService else {
            appendErrorMessage("Codex service is not running.")
            return
        }
        isTurnInProgress = true
        Task { [weak self] in
            guard let self else { return }
            do {
                try await codexService.sendMessage(text)
            } catch {
                self.appendErrorMessage("Failed to send message: \(error.localizedDescription)")
                self.isTurnInProgress = false
            }
        }
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
        let url = URL(string: "\(Self.terminalScheme)://\(terminalCounter)")!
        terminalCounter += 1
        let workingDirectory = rootDirectory?.path ?? FileManager.default.homeDirectoryForCurrentUser.path
        let view = GhosttyTerminalView(app: ghosttyApp, workingDirectory: workingDirectory)
        view.onClose = { [weak self] in
            self?.closeFile(url)
        }
        terminalViews[url] = view
        openFiles.append(url)
        selectedFileURL = url
        currentLanguage = nil
        setEditorText("")
    }

    private func buildCommandList() -> [PaletteCommand] {
        [
            PaletteCommand(
                id: "toggle-nvim",
                title: isNvimModeEnabled ? "Disable Neovim Mode" : "Enable Neovim Mode",
                icon: "terminal",
                action: { [weak self] in
                    self?.toggleNvimMode()
                }
            ),
            PaletteCommand(
                id: "save-all",
                title: "Save All",
                icon: "square.and.arrow.down",
                action: { [weak self] in
                    self?.saveAllFiles()
                }
            ),
            PaletteCommand(
                id: "new-terminal",
                title: "New Terminal",
                icon: "terminal",
                action: { [weak self] in
                    self?.openTerminal()
                }
            ),
            PaletteCommand(
                id: "open-folder",
                title: "Open Folder...",
                icon: "folder",
                action: { [weak self] in
                    self?.openFolderPanel()
                }
            ),
            PaletteCommand(
                id: "open-chat",
                title: "Open Chat",
                icon: "bubble.left.and.bubble.right",
                action: { [weak self] in
                    self?.openChat()
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
        fileIndexTask = Task { [weak self] in
            let entries = await Task.detached(priority: .utility) {
                let fm = FileManager.default
                guard let enumerator = fm.enumerator(
                    at: rootDirectory,
                    includingPropertiesForKeys: keys,
                    options: [.skipsHiddenFiles, .skipsPackageDescendants]
                ) else {
                    return [FileIndexEntry]()
                }
                var entries: [FileIndexEntry] = []
                while let url = enumerator.nextObject() as? URL {
                    if Task.isCancelled { return entries }
                    let values = try? url.resourceValues(forKeys: Set(keys))
                    if values?.isDirectory == true {
                        if skipNames.contains(url.lastPathComponent) {
                            enumerator.skipDescendants()
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
                    entries.append(FileIndexEntry(url: url, displayPath: displayPath))
                }
                entries.sort { lhs, rhs in
                    lhs.displayPath.localizedStandardCompare(rhs.displayPath) == .orderedAscending
                }
                return entries
            }.value
            guard let self, !Task.isCancelled else { return }
            self.fileIndex = entries
            self.scheduleSearch()
        }
    }

    private func scheduleSearch() {
        searchTask?.cancel()
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
                    if let score = Self.scoreMatch(query: commandQuery, in: command.title.lowercased()) {
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
        searchTask = Task { [weak self] in
            let results = await Task.detached(priority: .userInitiated) {
                if query.isEmpty {
                    return Array(entries.prefix(Self.maxSearchResults))
                }
                var scored: [(FileIndexEntry, Int)] = []
                scored.reserveCapacity(entries.count / 2)
                for entry in entries {
                    if Task.isCancelled { return [FileIndexEntry]() }
                    if let score = Self.scoreMatch(query: query, in: entry.lowercasedPath) {
                        scored.append((entry, score))
                    }
                }
                scored.sort { lhs, rhs in
                    if lhs.1 != rhs.1 { return lhs.1 < rhs.1 }
                    return lhs.0.displayPath.localizedStandardCompare(rhs.0.displayPath) == .orderedAscending
                }
                return scored.prefix(Self.maxSearchResults).map { $0.0 }
            }.value
            guard let self else { return }
            let currentQuery = self.fileSearchQuery.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            guard currentQuery == query else { return }
            self.fileSearchResults = results
            self.paletteCommands = []
        }
    }

    nonisolated private static func scoreMatch(query: String, in text: String) -> Int? {
        if let range = text.range(of: query) {
            let offset = text.distance(from: text.startIndex, to: range.lowerBound)
            return offset
        }
        var score = 0
        var searchIndex = text.startIndex
        for ch in query {
            guard let found = text[searchIndex...].firstIndex(of: ch) else {
                return nil
            }
            score += text.distance(from: text.startIndex, to: found)
            searchIndex = text.index(after: found)
        }
        return 1000 + score
    }

    private func startCodexService(cwd: String) {
        stopCodexService()
        let service = CodexService()
        codexService = service

        codexEventsTask = Task { [weak self] in
            guard let self else { return }
            for await event in service.events {
                self.handleCodexEvent(event)
            }
        }

        Task { [weak self] in
            guard let self else { return }
            do {
                try await service.start(cwd: cwd)
                if let apiKey = ProcessInfo.processInfo.environment["OPENAI_API_KEY"], !apiKey.isEmpty {
                    try await service.login(apiKey: apiKey)
                }
            } catch {
                self.appendErrorMessage("Codex failed to start: \(error.localizedDescription)")
                self.stopCodexService()
            }
        }
    }

    private func stopCodexService() {
        codexEventsTask?.cancel()
        codexEventsTask = nil
        codexService?.stop()
        codexService = nil
        isTurnInProgress = false
    }

    private func handleCodexEvent(_ event: CodexEvent) {
        switch event {
        case .turnStarted:
            isTurnInProgress = true
        case .agentMessageDelta(let text):
            applyAgentMessageDelta(text)
        case .agentMessageCompleted(let text):
            finalizeAgentMessage(text: text)
        case .commandStarted(let itemId, let command, let cwd):
            appendCommandMessage(itemId: itemId, command: command, cwd: cwd)
        case .commandOutput(let itemId, let text):
            appendCommandOutput(itemId: itemId, text: text)
        case .commandCompleted(let itemId, let exitCode):
            completeCommand(itemId: itemId, exitCode: exitCode)
        case .fileChange(let turnId, let item):
            appendDiffPreview(from: item, turnId: turnId)
        case .fileChangeDelta(let turnId, _, let delta):
            appendStreamingDiff(turnId: turnId, delta: delta)
        case .turnDiffUpdated(let turnId, let diff):
            updateTurnDiffPreview(turnId: turnId, diff: diff)
        case .turnCompleted(let status):
            isTurnInProgress = false
            finalizeAgentMessage(text: nil)
            if status == "failed" {
                appendErrorMessage("Turn failed.")
            } else if status == "interrupted" {
                appendErrorMessage("Turn interrupted.")
            } else if status != "completed" {
                appendErrorMessage("Turn finished with status: \(status)")
            }
        case .error(let message):
            isTurnInProgress = false
            appendErrorMessage(message)
        }
    }

    private func applyAgentMessageDelta(_ delta: String) {
        if let index = chatMessages.lastIndex(where: { $0.role == .assistant && $0.isStreaming }) {
            var message = chatMessages[index]
            message.appendText(delta)
            chatMessages[index] = message
        } else {
            let message = ChatMessage(role: .assistant, kind: .text(delta), isStreaming: true)
            chatMessages.append(message)
        }
    }

    private func finalizeAgentMessage(text: String?) {
        guard let index = chatMessages.lastIndex(where: { $0.role == .assistant && $0.isStreaming }) else { return }
        var message = chatMessages[index]
        if let text {
            message.setText(text)
        }
        message.isStreaming = false
        chatMessages[index] = message
    }

    private func appendCommandMessage(itemId: String, command: String, cwd: String) {
        let info = CommandExecutionInfo(itemId: itemId, command: command, cwd: cwd, output: "", exitCode: nil, status: .running)
        let message = ChatMessage(role: .assistant, kind: .command(info))
        chatMessages.append(message)
    }

    private func appendCommandOutput(itemId: String, text: String) {
        guard let index = chatMessages.lastIndex(where: { $0.commandItemId == itemId }) else {
            appendCommandMessage(itemId: itemId, command: "command", cwd: "", output: text)
            return
        }
        var message = chatMessages[index]
        message.appendCommandOutput(text)
        chatMessages[index] = message
    }

    private func completeCommand(itemId: String, exitCode: Int?) {
        guard let index = chatMessages.lastIndex(where: { $0.commandItemId == itemId }) else { return }
        var message = chatMessages[index]
        message.completeCommand(exitCode: exitCode)
        chatMessages[index] = message
    }

    private func appendCommandMessage(itemId: String, command: String, cwd: String, output: String) {
        let info = CommandExecutionInfo(itemId: itemId, command: command, cwd: cwd, output: output, exitCode: nil, status: .running)
        let message = ChatMessage(role: .assistant, kind: .command(info))
        chatMessages.append(message)
    }

    private func appendDiffPreview(from item: FileChangeItem, turnId: String) {
        let preview = DiffPreview.fromFileChange(turnId: turnId, item: item)
        let trimmed = preview.diff.trimmingCharacters(in: .whitespacesAndNewlines)
        if turnDiffs[turnId] == nil && !trimmed.isEmpty {
            ensureTurnOrder(turnId)
            turnDiffs[turnId] = preview.diff
            updateSessionDiffSnapshot()
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
        updateSessionDiffSnapshot()
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
        updateSessionDiffSnapshot()
    }

    private func ensureTurnOrder(_ turnId: String) {
        if !turnDiffOrder.contains(turnId) {
            turnDiffOrder.append(turnId)
        }
    }

    private func updateSessionDiffSnapshot() {
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

    private func upsertDiffPreview(_ preview: DiffPreview) {
        if let turnId = preview.turnId,
           let index = chatMessages.lastIndex(where: { message in
               if case .diffPreview(let existing) = message.kind {
                   return existing.turnId == turnId
               }
               return false
           }) {
            var message = chatMessages[index]
            message.kind = .diffPreview(preview)
            chatMessages[index] = message
        } else {
            let message = ChatMessage(role: .assistant, kind: .diffPreview(preview))
            chatMessages.append(message)
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

    func openDiffTab(title: String, summary: String?, diff: String) {
        let id = UUID().uuidString
        guard let url = URL(string: "\(Self.diffScheme)://\(id)") else { return }
        let tab = DiffTab(
            id: url,
            title: title,
            summary: summary ?? "",
            diff: diff
        )
        diffTabs[url] = tab
        if !openFiles.contains(url) {
            openFiles.append(url)
        }
        selectedFileURL = url
        currentLanguage = nil
        setEditorText("")
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

    private func openChat() {
        if !openFiles.contains(Self.chatURL) {
            openFiles.insert(Self.chatURL, at: 0)
        }
        selectedFileURL = Self.chatURL
        currentLanguage = nil
        setEditorText("")
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

    private func resolveFileURL(path: String) -> URL? {
        let expanded = (path as NSString).expandingTildeInPath
        let fileURL: URL
        if expanded.hasPrefix("/") {
            fileURL = URL(fileURLWithPath: expanded)
        } else if let rootDirectory {
            fileURL = URL(fileURLWithPath: expanded, relativeTo: rootDirectory).standardizedFileURL
        } else {
            return nil
        }
        var isDir: ObjCBool = false
        guard FileManager.default.fileExists(atPath: fileURL.path, isDirectory: &isDir), !isDir.boolValue else { return nil }
        return fileURL
    }


}

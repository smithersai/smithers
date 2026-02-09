import SwiftUI

@main
struct SmithersApp: App {
    @StateObject private var workspace: WorkspaceState
    @NSApplicationDelegateAdaptor(SmithersAppDelegate.self) private var appDelegate
    @StateObject private var tmuxKeyHandler: TmuxKeyHandler
    @State private var windowCloseDelegate = WindowCloseDelegate()

    init() {
        let workspace = WorkspaceState()
        _workspace = StateObject(wrappedValue: workspace)
        _tmuxKeyHandler = StateObject(wrappedValue: TmuxKeyHandler(workspace: workspace))
    }

    var body: some Scene {
        WindowGroup {
            ContentView(workspace: workspace, tmuxKeyHandler: tmuxKeyHandler)
                .preferredColorScheme(workspace.theme.colorScheme)
                .tint(workspace.theme.accentColor)
                .frame(minWidth: 700, minHeight: 400)
                .environment(\.openURL, OpenURLAction { url in
                    workspace.handleOpenURL(url) ? .handled : .systemAction
                })
                .onAppear {
                    workspace.hideWindowForLaunch()
                    handleLaunchArguments()
                    appDelegate.workspace = workspace
                    windowCloseDelegate.workspace = workspace
                    setInitialWindowSize()
                    configureWindowChrome()
                    tmuxKeyHandler.install()
                }
        }
        .windowStyle(.hiddenTitleBar)
        .windowToolbarStyle(.unifiedCompact)
        .commands {
            CommandGroup(replacing: .saveItem) {
                Button("Save") {
                    workspace.saveCurrentFile()
                }
                .keyboardShortcut("S", modifiers: [.command])
                Button("Save All") {
                    workspace.saveAllFiles()
                }
                .keyboardShortcut("S", modifiers: [.command, .shift])
            }
            CommandGroup(after: .newItem) {
                Button("Open Folder...") {
                    workspace.openFolderPanel()
                }
                .keyboardShortcut("O", modifiers: [.command, .shift])
                Button("Search in Files...") {
                    workspace.showSearchPanel()
                }
                .keyboardShortcut("F", modifiers: [.command, .shift])
            }
            CommandGroup(after: .newItem) {
                Button("New Terminal") {
                    workspace.openTerminal()
                }
                .keyboardShortcut("`", modifiers: [.command])
                Button(workspace.isNvimModeEnabled ? "Disable Neovim Mode" : "Enable Neovim Mode") {
                    workspace.toggleNvimMode()
                }
                .keyboardShortcut("N", modifiers: [.command, .shift])
                Button("Toggle Keyboard Shortcuts") {
                    workspace.toggleShortcutsPanel()
                }
                .keyboardShortcut("/", modifiers: [.command])
            }
            CommandGroup(replacing: .printItem) {
                Button("Go to File...") {
                    workspace.showCommandPalette()
                }
                .keyboardShortcut("P", modifiers: [.command])
            }
        }
        Settings {
            PreferencesView(workspace: workspace)
        }
    }

    private func setInitialWindowSize() {
        applyInitialWindowSize(retryCount: 5)
    }

    private func applyInitialWindowSize(retryCount: Int) {
        DispatchQueue.main.async {
            guard let screen = NSScreen.main else { return }
            guard let window = NSApp.windows.first(where: { $0.isKeyWindow || $0.isMainWindow }) ?? NSApp.windows.first else {
                if retryCount > 0 {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) {
                        applyInitialWindowSize(retryCount: retryCount - 1)
                    }
                }
                return
            }
            let screenFrame = screen.visibleFrame
            let width = screenFrame.width * 0.85
            let height = screenFrame.height * 0.85
            let x = screenFrame.origin.x + (screenFrame.width - width) / 2
            let y = screenFrame.origin.y + (screenFrame.height - height) / 2
            if let savedFrame = WindowCloseDelegate.loadWindowFrame() {
                window.setFrame(adjustedFrame(savedFrame), display: true)
            } else {
                window.setFrame(NSRect(x: x, y: y, width: width, height: height), display: true)
            }
            workspace.showWindowAfterLaunch()
        }
    }

    private func configureWindowChrome() {
        DispatchQueue.main.async {
            guard let window = NSApp.windows.first(where: { $0.isKeyWindow || $0.isMainWindow }) else { return }
            window.titleVisibility = .hidden
            window.titlebarAppearsTransparent = true
            window.isMovableByWindowBackground = true
            window.styleMask.insert(.fullSizeContentView)
            window.title = ""
            window.delegate = windowCloseDelegate
        }
    }

    private func adjustedFrame(_ frame: NSRect) -> NSRect {
        for screen in NSScreen.screens {
            if screen.visibleFrame.intersects(frame) {
                return clampFrame(frame, to: screen.visibleFrame)
            }
        }
        guard let screen = NSScreen.main else { return frame }
        let visible = screen.visibleFrame
        let width = min(frame.width, visible.width)
        let height = min(frame.height, visible.height)
        let x = visible.origin.x + (visible.width - width) / 2
        let y = visible.origin.y + (visible.height - height) / 2
        return NSRect(x: x, y: y, width: width, height: height)
    }

    private func clampFrame(_ frame: NSRect, to bounds: NSRect) -> NSRect {
        var clamped = frame
        if clamped.width > bounds.width {
            clamped.size.width = bounds.width
        }
        if clamped.height > bounds.height {
            clamped.size.height = bounds.height
        }
        if clamped.minX < bounds.minX {
            clamped.origin.x = bounds.minX
        }
        if clamped.maxX > bounds.maxX {
            clamped.origin.x = bounds.maxX - clamped.width
        }
        if clamped.minY < bounds.minY {
            clamped.origin.y = bounds.minY
        }
        if clamped.maxY > bounds.maxY {
            clamped.origin.y = bounds.maxY - clamped.height
        }
        return clamped
    }

    private func handleLaunchArguments() {
        let args = ProcessInfo.processInfo.arguments
        var handledDirectory = false
        var handledFile = false
        if let idx = args.firstIndex(of: "-openDirectory"),
           idx + 1 < args.count {
            let path = args[idx + 1]
            let url = URL(fileURLWithPath: path)
            workspace.openDirectory(url)
            handledDirectory = true
        }
        if let idx = args.firstIndex(of: "-openFile"),
           idx + 1 < args.count {
            let path = args[idx + 1]
            workspace.selectFile(URL(fileURLWithPath: path))
            handledFile = true
        }
        if !handledDirectory && !handledFile {
            workspace.restoreLastWorkspaceIfNeeded()
        }
    }
}

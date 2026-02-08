import SwiftUI

@main
struct SmithersApp: App {
    @StateObject private var workspace = WorkspaceState()
    @NSApplicationDelegateAdaptor(SmithersAppDelegate.self) private var appDelegate
    @State private var tmuxKeyHandler: TmuxKeyHandler?
    @State private var windowCloseDelegate = WindowCloseDelegate()

    var body: some Scene {
        WindowGroup {
            ContentView(workspace: workspace)
                .preferredColorScheme(workspace.theme.colorScheme)
                .tint(workspace.theme.accentColor)
                .frame(minWidth: 700, minHeight: 400)
                .environment(\.openURL, OpenURLAction { url in
                    workspace.handleOpenURL(url) ? .handled : .systemAction
                })
                .onAppear {
                    handleLaunchArguments()
                    appDelegate.workspace = workspace
                    windowCloseDelegate.workspace = workspace
                    setInitialWindowSize()
                    configureWindowChrome()
                    let handler = TmuxKeyHandler(workspace: workspace)
                    handler.install()
                    tmuxKeyHandler = handler
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
            }
            CommandGroup(replacing: .printItem) {
                Button("Go to File...") {
                    workspace.showCommandPalette()
                }
                .keyboardShortcut("P", modifiers: [.command])
            }
        }
    }

    private func setInitialWindowSize() {
        DispatchQueue.main.async {
            guard let screen = NSScreen.main else { return }
            let screenFrame = screen.visibleFrame
            let width = screenFrame.width * 0.85
            let height = screenFrame.height * 0.85
            let x = screenFrame.origin.x + (screenFrame.width - width) / 2
            let y = screenFrame.origin.y + (screenFrame.height - height) / 2
            if let window = NSApp.windows.first(where: { $0.isKeyWindow || $0.isMainWindow }) {
                window.setFrame(NSRect(x: x, y: y, width: width, height: height), display: true)
            }
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

    private func handleLaunchArguments() {
        let args = ProcessInfo.processInfo.arguments
        if let idx = args.firstIndex(of: "-openDirectory"),
           idx + 1 < args.count {
            let path = args[idx + 1]
            let url = URL(fileURLWithPath: path)
            workspace.openDirectory(url)
        }
        if let idx = args.firstIndex(of: "-openFile"),
           idx + 1 < args.count {
            let path = args[idx + 1]
            workspace.selectFile(URL(fileURLWithPath: path))
        }
    }
}

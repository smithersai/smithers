import SwiftUI

@main
struct SmithersApp: App {
    @StateObject private var workspace = WorkspaceState()

    var body: some Scene {
        WindowGroup {
            ContentView(workspace: workspace)
                .preferredColorScheme(.dark)
                .frame(minWidth: 700, minHeight: 400)
                .onAppear {
                    handleLaunchArguments()
                    setInitialWindowSize()
                }
        }
        .commands {
            CommandGroup(after: .newItem) {
                Button("Open Folder...") {
                    workspace.openFolderPanel()
                }
                .keyboardShortcut("O", modifiers: [.command, .shift])
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

    private func handleLaunchArguments() {
        let args = ProcessInfo.processInfo.arguments
        if let idx = args.firstIndex(of: "-openDirectory"),
           idx + 1 < args.count {
            let path = args[idx + 1]
            let url = URL(fileURLWithPath: path)
            workspace.openDirectory(url)
        }
    }
}

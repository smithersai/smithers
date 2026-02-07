import SwiftUI

struct FileTreeSidebar: View {
    @ObservedObject var workspace: WorkspaceState

    var body: some View {
        Group {
            if workspace.fileTree.isEmpty {
                VStack(spacing: 16) {
                    Image(systemName: "folder.badge.plus")
                        .font(.system(size: 36))
                        .foregroundStyle(.tertiary)
                    Text("No Folder Open")
                        .font(.title3)
                        .foregroundStyle(.secondary)
                        .accessibilityIdentifier("NoFolderLabel")
                    Button {
                        workspace.openFolderPanel()
                    } label: {
                        Text("Open Folder...")
                            .frame(minWidth: 120)
                    }
                    .controlSize(.large)
                    .accessibilityIdentifier("OpenFolderButton")
                    Text("⌘⇧O")
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                List(selection: $workspace.selectedFileURL) {
                    Section(workspace.rootDirectory?.lastPathComponent.uppercased() ?? "FILES") {
                        ForEach(workspace.fileTree) { item in
                            FileTreeRow(item: item, workspace: workspace)
                        }
                    }
                }
                .listStyle(.sidebar)
                .accessibilityIdentifier("FileTreeList")
                .onChange(of: workspace.selectedFileURL) { _, newValue in
                    if let url = newValue {
                        workspace.selectFile(url)
                    }
                }
            }
        }
    }
}

private func iconForFile(_ name: String) -> String {
    let ext = (name as NSString).pathExtension.lowercased()
    switch ext {
    case "swift": return "swift"
    case "py": return "text.page"
    case "js", "ts", "jsx", "tsx": return "curlybraces"
    case "json": return "curlybraces.square"
    case "md", "txt", "readme": return "doc.plaintext"
    case "yml", "yaml", "toml": return "gearshape"
    case "png", "jpg", "jpeg", "gif", "svg", "webp", "ico": return "photo"
    case "html", "css": return "globe"
    case "sh", "zsh", "bash": return "terminal"
    case "zip", "tar", "gz": return "doc.zipper"
    case "resolved": return "lock"
    default: return "doc.text"
    }
}

struct FileTreeRow: View {
    let item: FileItem
    @ObservedObject var workspace: WorkspaceState
    @State private var isExpanded = false

    var body: some View {
        if item.isFolder {
            folderRow
        } else {
            fileLabel
                .tag(item.id)
                .accessibilityIdentifier("FileTreeItem_\(item.name)")
        }
    }

    @ViewBuilder
    private var folderRow: some View {
        HStack(spacing: 6) {
            Image(systemName: "chevron.right")
                .font(.system(size: 9, weight: .bold))
                .foregroundStyle(.tertiary)
                .rotationEffect(isExpanded ? .degrees(90) : .zero)
                .animation(.easeInOut(duration: 0.15), value: isExpanded)
                .frame(width: 10)
            Image(systemName: isExpanded ? "folder.fill" : "folder")
                .foregroundStyle(.blue)
                .font(.system(size: 13))
            Text(item.name)
                .lineLimit(1)
                .truncationMode(.middle)
        }
        .contentShape(Rectangle())
        .onTapGesture { isExpanded.toggle() }
        .accessibilityIdentifier("FileTreeItem_\(item.name)")

        if isExpanded, let children = item.children {
            ForEach(children) { child in
                FileTreeRow(item: child, workspace: workspace)
                    .padding(.leading, 16)
            }
        }
    }

    private var fileLabel: some View {
        Label {
            Text(item.name)
                .lineLimit(1)
                .truncationMode(.middle)
        } icon: {
            Image(systemName: iconForFile(item.name))
                .foregroundStyle(.secondary)
                .font(.system(size: 13))
        }
    }
}

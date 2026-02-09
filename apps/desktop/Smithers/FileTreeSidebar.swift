import SwiftUI

struct FileTreeSidebar: View {
    @ObservedObject var workspace: WorkspaceState

    var body: some View {
        let theme = workspace.theme
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
                .background(theme.secondaryBackgroundColor)
            } else if workspace.isSearchPresented {
                SearchPanelView(workspace: workspace)
                    .background(theme.secondaryBackgroundColor)
            } else {
                List(selection: $workspace.selectedFileURL) {
                    Section(workspace.rootDirectory?.lastPathComponent.uppercased() ?? "FILES") {
                        ForEach(workspace.fileTree) { item in
                            FileTreeRow(item: item, workspace: workspace)
                        }
                    }
                }
                .listStyle(.sidebar)
                .scrollContentBackground(.hidden)
                .background(theme.secondaryBackgroundColor)
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
        .onTapGesture {
            if !isExpanded {
                workspace.expandFolder(item)
            }
            isExpanded.toggle()
        }
        .accessibilityIdentifier("FileTreeItem_\(item.name)")

        if isExpanded, let children = item.children {
            let visibleChildren = children.filter { !$0.isLazyPlaceholder }
            ForEach(visibleChildren) { child in
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

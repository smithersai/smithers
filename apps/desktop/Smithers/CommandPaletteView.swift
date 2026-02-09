import SwiftUI
import Dispatch
import Foundation

private enum PaletteSelection: Hashable {
    case file(URL)
    case folder(URL)
}

struct CommandPaletteView: View {
    @ObservedObject var workspace: WorkspaceState
    @FocusState private var searchFocused: Bool
    @State private var selectedEntry: PaletteSelection?
    @State private var selectedCommandID: String?

    var body: some View {
        GeometryReader { proxy in
            ZStack {
                overlayBackground
                CommandPalettePanel(
                    workspace: workspace,
                    selectedEntry: $selectedEntry,
                    selectedCommandID: $selectedCommandID,
                    searchFocused: $searchFocused,
                    containerSize: proxy.size
                )
            }
        }
        .onExitCommand {
            workspace.hideCommandPalette()
        }
    }

    private var overlayBackground: some View {
        Color.black.opacity(0.35)
            .ignoresSafeArea()
            .onTapGesture {
                workspace.hideCommandPalette()
            }
    }

}

private struct CommandPalettePanel: View {
    @ObservedObject var workspace: WorkspaceState
    @Binding var selectedEntry: PaletteSelection?
    @Binding var selectedCommandID: String?
    var searchFocused: FocusState<Bool>.Binding
    let containerSize: CGSize
    @State private var previewText: String = ""
    @State private var previewTitle: String = ""
    @State private var previewPath: String = ""
    @State private var previewTask: Task<Void, Never>?

    var body: some View {
        let theme = workspace.theme
        let targetWidth = min(680, max(420, containerSize.width * 0.65))
        let targetHeight = min(460, max(320, containerSize.height * 0.55))
        let content = VStack(spacing: 0) {
            header
            Divider()
                .background(theme.dividerColor)
            paletteContent
        }

        let sized = AnyView(
            content
                .frame(width: targetWidth, height: targetHeight)
                .background(theme.panelBackgroundColor)
        )

        let decorated = AnyView(
            sized
                .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: 10, style: .continuous)
                        .strokeBorder(theme.panelBorderColor)
                )
                .shadow(color: .black.opacity(0.35), radius: 18, x: 0, y: 8)
        )

        let panel = decorated
            .onAppear {
                selectedEntry = firstAvailableSelection()
                selectedCommandID = workspace.paletteCommands.first?.id
                updatePreview(for: selectedEntry)
                DispatchQueue.main.async {
                    searchFocused.wrappedValue = true
                }
            }
            .onChange(of: workspace.fileSearchResults) { _, newValue in
                updateSelectionIfNeeded()
            }
            .onChange(of: workspace.recentEditEntries.map(\.url)) { _, _ in
                updateSelectionIfNeeded()
            }
        .onChange(of: workspace.paletteCommands.map(\.id)) { _, newValue in
            if let selectedCommandID, newValue.contains(selectedCommandID) {
                return
            }
            selectedCommandID = newValue.first
        }
        .onChange(of: workspace.recentFileEntries.map(\.url)) { _, _ in
            updateSelectionIfNeeded()
        }
        .onChange(of: workspace.recentFolderEntries.map(\.url)) { _, _ in
            updateSelectionIfNeeded()
        }
        .onChange(of: workspace.fileSearchQuery) { _, _ in
            updateSelectionIfNeeded()
        }
        .onChange(of: selectedEntry) { _, newValue in
            updatePreview(for: newValue)
        }
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("CommandPaletteOverlay")

        return panel
    }

    private var header: some View {
        HStack(spacing: 10) {
            if workspace.isCommandMode {
                Text(">")
                    .font(.system(size: Typography.base, weight: .semibold, design: .monospaced))
                    .foregroundStyle(.secondary)
            } else {
                Image(systemName: "magnifyingglass")
                    .foregroundStyle(.secondary)
            }
            TextField("Go to File...", text: $workspace.fileSearchQuery)
                .textFieldStyle(.plain)
                .font(.system(size: Typography.base, weight: .regular))
                .foregroundStyle(.primary)
                .focused(searchFocused)
                .accessibilityIdentifier("CommandPaletteSearchField")
                .onKeyPress(.downArrow) {
                    moveSelection(by: 1)
                    return .handled
                }
                .onKeyPress(.upArrow) {
                    moveSelection(by: -1)
                    return .handled
                }
                .onSubmit {
                    openSelection()
                }
            Button {
                workspace.hideCommandPalette()
            } label: {
                Image(systemName: "xmark.circle.fill")
                    .foregroundStyle(.secondary)
            }
            .buttonStyle(.plain)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
    }

    private var paletteContent: AnyView {
        if workspace.isCommandMode {
            return AnyView(commandContent)
        }
        return AnyView(fileContent)
    }

    @ViewBuilder
    private var commandContent: some View {
        let theme = workspace.theme
        if workspace.paletteCommands.isEmpty {
            VStack(spacing: 8) {
                Image(systemName: "command")
                    .font(.system(size: Typography.iconM))
                    .foregroundStyle(.tertiary)
                Text("No matching commands")
                    .foregroundStyle(.secondary)
                Text("Remove \">\" to search files")
                    .font(.caption)
                    .foregroundStyle(.tertiary)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            List(selection: $selectedCommandID) {
                ForEach(workspace.paletteCommands) { command in
                    HStack(spacing: 8) {
                        Image(systemName: command.icon)
                            .foregroundStyle(.secondary)
                        highlightedText(command.title, query: workspace.fileSearchQuery, accent: theme.accentColor)
                            .lineLimit(1)
                            .truncationMode(.middle)
                        Spacer()
                        if let shortcut = command.shortcut {
                            Text(shortcut)
                                .font(.system(size: Typography.s, weight: .regular, design: .monospaced))
                                .foregroundStyle(.tertiary)
                        }
                    }
                    .tag(command.id)
                    .listRowBackground(
                        selectedCommandID == command.id ? theme.selectionBackgroundColor : Color.clear
                    )
                    .contentShape(Rectangle())
                    .onTapGesture {
                        run(command)
                    }
                }
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .accessibilityIdentifier("CommandPaletteResults")
        }
    }

    @ViewBuilder
    private var fileContent: some View {
        let theme = workspace.theme
        let showRecents = shouldShowRecents
        let recentEdits = workspace.recentEditEntries
        let recentFiles = workspace.recentFileEntries
        let recentFolders = workspace.recentFolderEntries
        let fileResults = workspace.fileSearchResults
        let highlightQuery = workspace.fileSearchQuery.trimmingCharacters(in: .whitespacesAndNewlines)
        let hasResults = !fileResults.isEmpty
        let hasRecents = !recentEdits.isEmpty || !recentFiles.isEmpty || !recentFolders.isEmpty
        if !hasResults && !(showRecents && hasRecents) {
            VStack(spacing: 8) {
                Image(systemName: "doc.text.magnifyingglass")
                    .font(.system(size: Typography.iconM))
                    .foregroundStyle(.tertiary)
                Text("No matching files")
                    .foregroundStyle(.secondary)
                Text("Type \">\" to search commands")
                    .font(.caption)
                    .foregroundStyle(.tertiary)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            let list = List(selection: $selectedEntry) {
                if showRecents {
                    if !recentEdits.isEmpty {
                        Section("Recent Edits") {
                            ForEach(recentEdits) { entry in
                                let selection = PaletteSelection.file(entry.url)
                                let isSelected = selection == selectedEntry
                                HStack(spacing: 8) {
                                    Image(systemName: iconForFile(entry.displayPath))
                                        .foregroundStyle(.secondary)
                                    highlightedText(entry.displayPath, query: highlightQuery, accent: theme.accentColor)
                                        .lineLimit(1)
                                        .truncationMode(.middle)
                                }
                                .tag(selection)
                                .listRowBackground(
                                    isSelected ? theme.selectionBackgroundColor : Color.clear
                                )
                                .contentShape(Rectangle())
                                .onTapGesture {
                                    open(.file(entry.url))
                                }
                            }
                        }
                    }
                    if !recentFiles.isEmpty {
                        Section("Recent Files") {
                            ForEach(recentFiles) { entry in
                                let selection = PaletteSelection.file(entry.url)
                                let isSelected = selection == selectedEntry
                                HStack(spacing: 8) {
                                    Image(systemName: iconForFile(entry.displayPath))
                                        .foregroundStyle(.secondary)
                                    highlightedText(entry.displayPath, query: highlightQuery, accent: theme.accentColor)
                                        .lineLimit(1)
                                        .truncationMode(.middle)
                                }
                                .tag(selection)
                                .listRowBackground(
                                    isSelected ? theme.selectionBackgroundColor : Color.clear
                                )
                                .contentShape(Rectangle())
                                .onTapGesture {
                                    open(.file(entry.url))
                                }
                            }
                        }
                    }
                    if !recentFolders.isEmpty {
                        Section("Recent Folders") {
                            ForEach(recentFolders) { entry in
                                let selection = PaletteSelection.folder(entry.url)
                                let isSelected = selection == selectedEntry
                                HStack(spacing: 8) {
                                    Image(systemName: "folder")
                                        .foregroundStyle(.secondary)
                                    highlightedText(entry.displayPath, query: highlightQuery, accent: theme.accentColor)
                                        .lineLimit(1)
                                        .truncationMode(.middle)
                                }
                                .tag(selection)
                                .listRowBackground(
                                    isSelected ? theme.selectionBackgroundColor : Color.clear
                                )
                                .contentShape(Rectangle())
                                .onTapGesture {
                                    open(.folder(entry.url))
                                }
                            }
                        }
                    }
                    if !fileResults.isEmpty {
                        Section("Files") {
                            ForEach(fileResults) { entry in
                                let selection = PaletteSelection.file(entry.url)
                                let isSelected = selection == selectedEntry
                                HStack(spacing: 8) {
                                    Image(systemName: iconForFile(entry.displayPath))
                                        .foregroundStyle(.secondary)
                                    highlightedText(entry.displayPath, query: highlightQuery, accent: theme.accentColor)
                                        .lineLimit(1)
                                        .truncationMode(.middle)
                                }
                                .tag(selection)
                                .listRowBackground(
                                    isSelected ? theme.selectionBackgroundColor : Color.clear
                                )
                                .contentShape(Rectangle())
                                .onTapGesture {
                                    open(.file(entry.url))
                                }
                            }
                        }
                    }
                } else {
                    ForEach(fileResults) { entry in
                        let selection = PaletteSelection.file(entry.url)
                        let isSelected = selection == selectedEntry
                        HStack(spacing: 8) {
                            Image(systemName: iconForFile(entry.displayPath))
                                .foregroundStyle(.secondary)
                            highlightedText(entry.displayPath, query: highlightQuery, accent: theme.accentColor)
                                .lineLimit(1)
                                .truncationMode(.middle)
                        }
                        .tag(selection)
                        .listRowBackground(
                            isSelected ? theme.selectionBackgroundColor : Color.clear
                        )
                        .contentShape(Rectangle())
                        .onTapGesture {
                            open(.file(entry.url))
                        }
                    }
                }
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .accessibilityIdentifier("CommandPaletteResults")

            HStack(spacing: 0) {
                list
                    .frame(width: 330)
                Divider()
                previewPane
            }
        }
    }

    private func openSelection() {
        if workspace.isCommandMode {
            if let selectedCommandID,
               let command = workspace.paletteCommands.first(where: { $0.id == selectedCommandID }) {
                run(command)
                return
            }
            if let first = workspace.paletteCommands.first {
                run(first)
            }
            return
        }
        if let selectedEntry {
            open(selectedEntry)
            return
        }
        if let first = firstAvailableSelection() {
            open(first)
        }
    }

    private var previewPane: some View {
        VStack(alignment: .leading, spacing: 8) {
            if previewTitle.isEmpty {
                Text("No selection")
                    .foregroundStyle(.secondary)
            } else {
                Text(previewTitle)
                    .font(.system(size: Typography.base, weight: .semibold))
                    .lineLimit(1)
                    .truncationMode(.middle)
                if !previewPath.isEmpty {
                    Text(previewPath)
                        .font(.system(size: Typography.xs, weight: .regular))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
                Divider()
                ScrollView {
                    Text(previewText)
                        .font(.system(size: Typography.code, weight: .regular, design: .monospaced))
                        .foregroundStyle(.primary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .textSelection(.enabled)
                }
            }
            Spacer()
        }
        .padding(12)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(workspace.theme.panelBackgroundColor)
    }

    private func highlightedText(_ text: String, query: String, accent: Color) -> Text {
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        let cleaned = trimmed.hasPrefix(">")
            ? String(trimmed.dropFirst()).trimmingCharacters(in: .whitespacesAndNewlines)
            : trimmed
        guard !cleaned.isEmpty else {
            return Text(text).font(.system(size: Typography.base, weight: .regular))
        }
        let lowerText = text.lowercased()
        let lowerQuery = cleaned.lowercased()
        var matches = Set<Int>()
        if let range = lowerText.range(of: lowerQuery) {
            let start = lowerText.distance(from: lowerText.startIndex, to: range.lowerBound)
            for offset in 0..<lowerQuery.count {
                matches.insert(start + offset)
            }
        } else {
            var searchIndex = lowerText.startIndex
            for ch in lowerQuery {
                guard let found = lowerText[searchIndex...].firstIndex(of: ch) else { break }
                let idx = lowerText.distance(from: lowerText.startIndex, to: found)
                matches.insert(idx)
                searchIndex = lowerText.index(after: found)
            }
        }
        var result = Text("")
        for (index, char) in text.enumerated() {
            if matches.contains(index) {
                result = result + Text(String(char))
                    .fontWeight(.semibold)
                    .foregroundColor(accent)
            } else {
                result = result + Text(String(char))
            }
        }
        return result.font(.system(size: Typography.base, weight: .regular))
    }

    private func updatePreview(for entry: PaletteSelection?) {
        previewTask?.cancel()
        guard let entry else {
            previewTitle = ""
            previewPath = ""
            previewText = ""
            return
        }
        switch entry {
        case .folder(let url):
            previewTitle = url.lastPathComponent
            previewPath = url.path
            previewText = "Folder"
        case .file(let url):
            previewTitle = url.lastPathComponent
            previewPath = url.path
            previewText = "Loading..."
            previewTask = Task {
                let text = await Task.detached(priority: .utility) {
                    Self.loadPreviewText(for: url)
                }.value
                previewText = text
            }
        }
    }

    nonisolated private static func loadPreviewText(for url: URL) -> String {
        guard let handle = try? FileHandle(forReadingFrom: url) else {
            return "Unable to read file."
        }
        defer { handle.closeFile() }
        let data = (try? handle.read(upToCount: 8_192)) ?? Data()
        if data.isEmpty {
            return ""
        }
        if data.contains(0) {
            return "Binary file"
        }
        let text = String(data: data, encoding: .utf8) ?? String(decoding: data, as: UTF8.self)
        let lines = text.split(omittingEmptySubsequences: false, whereSeparator: \.isNewline)
        let maxLines = 20
        let snippet = lines.prefix(maxLines).joined(separator: "\n")
        if lines.count > maxLines {
            return "\(snippet)\n…"
        }
        return snippet
    }

    private func open(_ entry: PaletteSelection) {
        switch entry {
        case .file(let url):
            workspace.selectFile(url)
        case .folder(let url):
            workspace.requestOpenDirectory(url)
        }
        workspace.hideCommandPalette()
    }

    private func run(_ command: PaletteCommand) {
        command.action()
        workspace.hideCommandPalette()
    }

    private var shouldShowRecents: Bool {
        let trimmed = workspace.fileSearchQuery.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty
    }

    private func firstAvailableSelection() -> PaletteSelection? {
        if shouldShowRecents {
            if let first = workspace.recentEditEntries.first {
                return .file(first.url)
            }
            if let first = workspace.recentFileEntries.first {
                return .file(first.url)
            }
            if let first = workspace.recentFolderEntries.first {
                return .folder(first.url)
            }
        }
        if let first = workspace.fileSearchResults.first {
            return .file(first.url)
        }
        return nil
    }

    private func moveSelection(by offset: Int) {
        if workspace.isCommandMode {
            let commands = workspace.paletteCommands
            guard !commands.isEmpty else { return }
            let currentIndex = commands.firstIndex(where: { $0.id == selectedCommandID }) ?? -1
            let newIndex = max(0, min(commands.count - 1, currentIndex + offset))
            selectedCommandID = commands[newIndex].id
        } else {
            let entries = allFileEntries()
            guard !entries.isEmpty else { return }
            let currentIndex = entries.firstIndex(of: selectedEntry ?? entries[0]) ?? -1
            let newIndex = max(0, min(entries.count - 1, currentIndex + offset))
            selectedEntry = entries[newIndex]
        }
    }

    private func allFileEntries() -> [PaletteSelection] {
        var entries: [PaletteSelection] = []
        if shouldShowRecents {
            entries += workspace.recentEditEntries.map { .file($0.url) }
            entries += workspace.recentFileEntries.map { .file($0.url) }
            entries += workspace.recentFolderEntries.map { .folder($0.url) }
        }
        entries += workspace.fileSearchResults.map { .file($0.url) }
        return entries
    }

    private func updateSelectionIfNeeded() {
        let showRecents = shouldShowRecents
        if let selectedEntry {
            switch selectedEntry {
            case .file(let url):
                let inEdits = workspace.recentEditEntries.contains { $0.url == url }
                let inRecents = workspace.recentFileEntries.contains { $0.url == url }
                let inResults = workspace.fileSearchResults.contains { $0.url == url }
                if inResults { return }
                if showRecents, (inEdits || inRecents) {
                    return
                }
            case .folder(let url):
                let inRecents = workspace.recentFolderEntries.contains { $0.url == url }
                if showRecents, inRecents { return }
            }
        }
        selectedEntry = firstAvailableSelection()
    }

}

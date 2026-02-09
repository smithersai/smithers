import SwiftUI

struct SearchPanelView: View {
    @ObservedObject var workspace: WorkspaceState
    @FocusState private var searchFocused: Bool

    var body: some View {
        let theme = workspace.theme
        VStack(spacing: 0) {
            header
            Divider()
                .background(theme.dividerColor)
            content
        }
        .background(theme.secondaryBackgroundColor)
        .onAppear {
            DispatchQueue.main.async {
                searchFocused = true
            }
        }
        .onExitCommand {
            workspace.hideSearchPanel()
        }
    }

    private var header: some View {
        HStack(spacing: 8) {
            Image(systemName: "magnifyingglass")
                .foregroundStyle(.secondary)
            TextField("Search in files", text: $workspace.searchQuery)
                .textFieldStyle(.plain)
                .font(.system(size: 13, weight: .regular))
                .foregroundStyle(.primary)
                .focused($searchFocused)
                .accessibilityIdentifier("SearchInFilesField")
            Button {
                workspace.hideSearchPanel()
            } label: {
                Image(systemName: "xmark.circle.fill")
                    .foregroundStyle(.secondary)
            }
            .buttonStyle(.plain)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
    }

    @ViewBuilder
    private var content: some View {
        if workspace.isSearchInProgress {
            VStack(spacing: 8) {
                ProgressView()
                    .controlSize(.small)
                Text("Searching...")
                    .foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if let message = workspace.searchErrorMessage {
            VStack(spacing: 8) {
                Image(systemName: "exclamationmark.triangle")
                    .font(.system(size: 24))
                    .foregroundStyle(.secondary)
                Text(message)
                    .multilineTextAlignment(.center)
                    .foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if workspace.searchQuery.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            VStack(spacing: 8) {
                Image(systemName: "doc.text.magnifyingglass")
                    .font(.system(size: 24))
                    .foregroundStyle(.tertiary)
                Text("Search for text in the workspace")
                    .foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if workspace.searchResults.isEmpty {
            VStack(spacing: 8) {
                Image(systemName: "doc.text.magnifyingglass")
                    .font(.system(size: 24))
                    .foregroundStyle(.tertiary)
                Text("No matches found")
                    .foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            List {
                ForEach(workspace.searchResults) { result in
                    Section(result.displayPath) {
                        ForEach(result.matches) { match in
                            Button {
                                workspace.openSearchResult(result, match: match)
                            } label: {
                                HStack(alignment: .firstTextBaseline, spacing: 8) {
                                    Text("\(match.lineNumber)")
                                        .font(.system(size: 11, weight: .semibold, design: .monospaced))
                                        .foregroundStyle(.secondary)
                                        .frame(width: 36, alignment: .trailing)
                                    Text(match.lineText.trimmingCharacters(in: .whitespaces))
                                        .font(.system(size: 12, weight: .regular, design: .monospaced))
                                        .foregroundStyle(.primary)
                                        .lineLimit(2)
                                        .truncationMode(.tail)
                                }
                                .frame(maxWidth: .infinity, alignment: .leading)
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .accessibilityIdentifier("SearchInFilesResults")
        }
    }
}

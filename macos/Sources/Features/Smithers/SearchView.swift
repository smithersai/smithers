import SwiftUI

/// Result from a search query
struct SearchResult: Identifiable, Equatable {
    let id: String
    let type: ResultType
    let title: String
    let preview: String
    let sessionId: String
    let timestamp: Date?

    enum ResultType: String {
        case event
        case checkpoint
    }
}

/// Global search view with results navigation
struct SearchView: View {
    @State private var searchQuery: String = ""
    @State private var results: [SearchResult] = []
    @State private var isSearching: Bool = false
    @Binding var isPresented: Bool
    @Binding var selectedResult: SearchResult?

    var onSendRequest: ((AgentRequest) -> Void)?

    var body: some View {
        VStack(spacing: 0) {
            // Search bar
            HStack {
                Image(systemName: "magnifyingglass")
                    .foregroundColor(.secondary)
                TextField("Search sessions, messages, and checkpoints...", text: $searchQuery)
                    .textFieldStyle(.plain)
                    .onSubmit {
                        performSearch()
                    }
                if !searchQuery.isEmpty {
                    Button(action: {
                        searchQuery = ""
                        results = []
                    }) {
                        Image(systemName: "xmark.circle.fill")
                            .foregroundColor(.secondary)
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(12)
            .background(Color(NSColor.controlBackgroundColor))

            Divider()

            // Results list
            if isSearching {
                HStack {
                    ProgressView()
                        .controlSize(.small)
                    Text("Searching...")
                        .foregroundColor(.secondary)
                }
                .padding()
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if results.isEmpty && !searchQuery.isEmpty {
                VStack(spacing: 8) {
                    Image(systemName: "doc.text.magnifyingglass")
                        .font(.system(size: 48))
                        .foregroundColor(.secondary)
                    Text("No results found")
                        .font(.headline)
                    Text("Try a different search term")
                        .font(.caption)
                        .foregroundColor(.secondary)
                }
                .padding()
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if !results.isEmpty {
                ScrollView {
                    LazyVStack(spacing: 0) {
                        ForEach(results) { result in
                            SearchResultRow(result: result)
                                .contentShape(Rectangle())
                                .onTapGesture {
                                    selectedResult = result
                                    isPresented = false
                                }
                        }
                    }
                }
            } else {
                VStack(spacing: 8) {
                    Image(systemName: "magnifyingglass")
                        .font(.system(size: 48))
                        .foregroundColor(.secondary)
                    Text("Search your sessions")
                        .font(.headline)
                    Text("Find messages, checkpoints, and more")
                        .font(.caption)
                        .foregroundColor(.secondary)
                }
                .padding()
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .frame(width: 600, height: 400)
        .onChange(of: searchQuery) { newValue in
            if !newValue.isEmpty {
                performSearch()
            } else {
                results = []
            }
        }
    }

    private func performSearch() {
        guard !searchQuery.isEmpty else { return }

        isSearching = true

        // Send search request
        let request = AgentRequest.searchAll(query: searchQuery)
        onSendRequest?(request)

        // Mock results for now - will be replaced when we handle search.results events
        // In a real implementation, we'd listen for search.results events from the daemon
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
            // TODO: Replace with actual event handling
            results = []
            isSearching = false
        }
    }
}

/// Row displaying a single search result
struct SearchResultRow: View {
    let result: SearchResult

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                // Type icon
                Image(systemName: iconForType(result.type))
                    .foregroundColor(colorForType(result.type))
                    .frame(width: 16)

                Text(result.title)
                    .font(.system(.body, design: .default))
                    .lineLimit(1)

                Spacer()

                if let timestamp = result.timestamp {
                    Text(timestamp, style: .relative)
                        .font(.caption)
                        .foregroundColor(.secondary)
                }
            }

            Text(result.preview)
                .font(.caption)
                .foregroundColor(.secondary)
                .lineLimit(2)
                .padding(.leading, 24)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(Color(NSColor.controlBackgroundColor).opacity(0.5))
        .contentShape(Rectangle())
    }

    private func iconForType(_ type: SearchResult.ResultType) -> String {
        switch type {
        case .event:
            return "message"
        case .checkpoint:
            return "bookmark"
        }
    }

    private func colorForType(_ type: SearchResult.ResultType) -> Color {
        switch type {
        case .event:
            return .blue
        case .checkpoint:
            return .purple
        }
    }
}

#Preview {
    SearchView(
        isPresented: .constant(true),
        selectedResult: .constant(nil)
    )
}

import SwiftUI

/// Root view for the Smithers app - combines sidebar and session detail
struct SmithersView: View {
    @State private var sessions: [Session] = Session.mockSessions
    @State private var selectedSessionId: UUID? = Session.mockSessions.first?.id
    @State private var showSearch: Bool = false
    @State private var selectedSearchResult: SearchResult?

    var body: some View {
        NavigationSplitView {
            SessionSidebar(
                sessions: $sessions,
                selectedSessionId: $selectedSessionId
            )
            .navigationSplitViewColumnWidth(min: 200, ideal: 250, max: 300)
        } detail: {
            SessionDetail(session: selectedSession)
        }
        .frame(minWidth: 800, minHeight: 500)
        .sheet(isPresented: $showSearch) {
            SearchView(
                isPresented: $showSearch,
                selectedResult: $selectedSearchResult,
                onSendRequest: { request in
                    // TODO: Wire to AgentClient when available
                    print("Search request: \(request.method)")
                }
            )
        }
        .onChange(of: selectedSearchResult) { result in
            if let result = result {
                // TODO: Navigate to the result in the session
                print("Selected result: \(result.title)")
            }
        }
        .backport.onKeyPress("f") { modifiers in
            if modifiers.contains(.command) {
                showSearch.toggle()
                return .handled
            }
            return .ignored
        }
    }

    private var selectedSession: Session? {
        sessions.first { $0.id == selectedSessionId }
    }
}

#Preview {
    SmithersView()
        .frame(width: 1000, height: 600)
}

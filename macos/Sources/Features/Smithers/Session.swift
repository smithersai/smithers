import Foundation
import SwiftUI

/// A single Claude Code session (chat)
struct Session: Identifiable {
    let id: UUID
    var title: String
    var createdAt: Date
    var isActive: Bool
    var graph: SessionGraph

    init(id: UUID = UUID(), title: String, createdAt: Date = Date(), isActive: Bool = false, graph: SessionGraph = SessionGraph()) {
        self.id = id
        self.title = title
        self.createdAt = createdAt
        self.isActive = isActive
        self.graph = graph
    }
}

/// Groups sessions by time period (Today, Yesterday, Last Week, etc.)
enum SessionGroup: String, CaseIterable {
    case today = "Today"
    case yesterday = "Yesterday"
    case lastWeek = "Last Week"
    case older = "Older"

    static func group(for date: Date) -> SessionGroup {
        let calendar = Calendar.current
        if calendar.isDateInToday(date) {
            return .today
        } else if calendar.isDateInYesterday(date) {
            return .yesterday
        } else if let weekAgo = calendar.date(byAdding: .day, value: -7, to: Date()),
                  date > weekAgo {
            return .lastWeek
        }
        return .older
    }
}

/// Mock data for UI development
extension Session {
    static let mockSessions: [Session] = [
        Session(title: "Fix auth bug", createdAt: Date(), isActive: true, graph: Session.mockGraphWithMessages()),
        Session(title: "Refactor API", createdAt: Date().addingTimeInterval(-3600)),
        Session(title: "Add tests", createdAt: Date().addingTimeInterval(-86400)),
        Session(title: "Debug perf", createdAt: Date().addingTimeInterval(-90000)),
        Session(title: "Initial setup", createdAt: Date().addingTimeInterval(-604800)),
    ]

    /// Create a mock graph with sample conversation
    static func mockGraphWithMessages() -> SessionGraph {
        let graph = SessionGraph()

        // User's initial message
        let userMsg1 = GraphNode(
            id: UUID(),
            type: .message,
            parentId: nil,
            timestamp: Date().addingTimeInterval(-300),
            data: [
                "role": AnyCodable("user"),
                "text": AnyCodable("Can you help me fix the authentication bug in auth.py? Users are reporting that expired tokens are still being accepted."),
            ]
        )
        graph.addNode(userMsg1)

        // Assistant's response
        let assistantMsg1 = GraphNode(
            id: UUID(),
            type: .message,
            parentId: userMsg1.id,
            timestamp: Date().addingTimeInterval(-290),
            data: [
                "role": AnyCodable("assistant"),
                "text": AnyCodable("I'll help you fix the authentication bug. Let me first read the auth.py file to understand the current implementation."),
            ]
        )
        graph.addNode(assistantMsg1)

        // Tool use: Read file
        let toolUseRead = GraphNode(
            id: UUID(),
            type: .toolUse,
            parentId: assistantMsg1.id,
            timestamp: Date().addingTimeInterval(-285),
            data: [
                "tool_name": AnyCodable("Read"),
                "status": AnyCodable("completed"),
                "input": AnyCodable([
                    "file_path": "/workspace/auth.py",
                    "line_start": 1,
                    "line_end": 100
                ] as [String: Any]),
                "duration": AnyCodable(0.42)
            ]
        )
        graph.addNode(toolUseRead)
        MockDataService.shared.registerNode(toolUseRead)

        // Tool result: Read output
        let toolResultRead = GraphNode(
            id: UUID(),
            type: .toolResult,
            parentId: toolUseRead.id,
            timestamp: Date().addingTimeInterval(-284),
            data: [
                "tool_name": AnyCodable("Read"),
                "output": AnyCodable("def validate_token(token):\n    # Missing expiration check!\n    return token is not None\n\ndef authenticate(request):\n    token = request.headers.get('Authorization')\n    return validate_token(token)"),
                "byte_count": AnyCodable(248),
                "artifact_ref": AnyCodable("artifact://read-auth-py-001")
            ]
        )
        graph.addNode(toolResultRead)
        MockDataService.shared.registerNode(toolResultRead)

        // Another assistant message
        let assistantMsg2 = GraphNode(
            id: UUID(),
            type: .message,
            parentId: toolResultRead.id,
            timestamp: Date().addingTimeInterval(-240),
            data: [
                "role": AnyCodable("assistant"),
                "text": AnyCodable("I found the issue! The validate_token() function on line 42 is missing proper expiration checks. The token validation logic needs to:\n\n1. Parse the expiration timestamp from the token\n2. Compare it with the current time\n3. Reject tokens that have expired\n\nLet me fix this now."),
            ]
        )
        graph.addNode(assistantMsg2)

        // Tool use: Edit file
        let toolUseEdit = GraphNode(
            id: UUID(),
            type: .toolUse,
            parentId: assistantMsg2.id,
            timestamp: Date().addingTimeInterval(-235),
            data: [
                "tool_name": AnyCodable("Edit"),
                "status": AnyCodable("completed"),
                "input": AnyCodable([
                    "file_path": "/workspace/auth.py",
                    "old_string": "def validate_token(token):\n    # Missing expiration check!\n    return token is not None",
                    "new_string": "def validate_token(token):\n    if token is None:\n        return False\n    try:\n        expiry = token.get('exp')\n        return expiry > time.time()\n    except (KeyError, AttributeError):\n        return False"
                ] as [String: Any]),
                "duration": AnyCodable(0.18)
            ]
        )
        graph.addNode(toolUseEdit)
        MockDataService.shared.registerNode(toolUseEdit)

        // Tool result: Edit success
        let toolResultEdit = GraphNode(
            id: UUID(),
            type: .toolResult,
            parentId: toolUseEdit.id,
            timestamp: Date().addingTimeInterval(-234),
            data: [
                "tool_name": AnyCodable("Edit"),
                "output": AnyCodable("Successfully edited /workspace/auth.py"),
                "byte_count": AnyCodable(42)
            ]
        )
        graph.addNode(toolResultEdit)
        MockDataService.shared.registerNode(toolResultEdit)

        // User follow-up
        let userMsg2 = GraphNode(
            id: UUID(),
            type: .message,
            parentId: toolResultEdit.id,
            timestamp: Date().addingTimeInterval(-180),
            data: [
                "role": AnyCodable("user"),
                "text": AnyCodable("Great! Can you also add some logging so we can track failed authentication attempts?"),
            ]
        )
        graph.addNode(userMsg2)

        // Assistant response
        let assistantMsg3 = GraphNode(
            id: UUID(),
            type: .message,
            parentId: userMsg2.id,
            timestamp: Date().addingTimeInterval(-120),
            data: [
                "role": AnyCodable("assistant"),
                "text": AnyCodable("Absolutely! I'll add comprehensive logging for:\n- Failed token validation (expired, invalid format, etc.)\n- Successful authentications\n- Rate limiting events\n\nThis will help you monitor authentication issues in production."),
            ]
        )
        graph.addNode(assistantMsg3)

        // Tool use: Run tests
        let toolUseBash = GraphNode(
            id: UUID(),
            type: .toolUse,
            parentId: assistantMsg3.id,
            timestamp: Date().addingTimeInterval(-115),
            data: [
                "tool_name": AnyCodable("Bash"),
                "status": AnyCodable("completed"),
                "input": AnyCodable([
                    "command": "pytest tests/test_auth.py -v",
                    "cwd": "/workspace"
                ] as [String: Any]),
                "duration": AnyCodable(2.34)
            ]
        )
        graph.addNode(toolUseBash)
        MockDataService.shared.registerNode(toolUseBash)

        // Tool result: Test output
        let toolResultBash = GraphNode(
            id: UUID(),
            type: .toolResult,
            parentId: toolUseBash.id,
            timestamp: Date().addingTimeInterval(-112),
            data: [
                "tool_name": AnyCodable("Bash"),
                "output": AnyCodable("============================= test session starts ==============================\ntests/test_auth.py::test_valid_token PASSED [ 33%]\ntests/test_auth.py::test_expired_token PASSED [ 66%]\ntests/test_auth.py::test_invalid_token PASSED [100%]\n\n============================== 3 passed in 0.12s ==============================="),
                "byte_count": AnyCodable(312),
                "artifact_ref": AnyCodable("artifact://bash-pytest-001")
            ]
        )
        graph.addNode(toolResultBash)
        MockDataService.shared.registerNode(toolResultBash)

        return graph
    }
}

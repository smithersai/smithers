import XCTest
@testable import Smithers

@MainActor
final class SessionManagerTests: XCTestCase {
    // MARK: - Workspace Tests

    func testWorkspaceProperty_ReturnsWorkspaceRoot() {
        let testWorkspace = "/tmp/test-workspace"
        let manager = SessionManager(
            workspaceRoot: testWorkspace,
            agentBackend: "fake"
        )

        XCTAssertEqual(manager.workspace, testWorkspace)
    }

    func testWorkspaceProperty_IsAccessible() {
        let homeDir = FileManager.default.homeDirectoryForCurrentUser.path
        let manager = SessionManager(
            workspaceRoot: homeDir,
            agentBackend: "fake"
        )

        XCTAssertFalse(manager.workspace.isEmpty)
        XCTAssertEqual(manager.workspace, homeDir)
    }
}

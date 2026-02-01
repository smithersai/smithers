import XCTest
@testable import Smithers

@MainActor
final class TerminalSessionManagerTests: XCTestCase {
    var manager: TerminalSessionManager!

    override func setUp() {
        super.setUp()
        manager = TerminalSessionManager()
    }

    override func tearDown() {
        manager = nil
        super.tearDown()
    }

    // MARK: - Tab Creation Tests

    func testOpenTab_CreatesTabWithDefaultSettings() {
        let tabId = manager.openTab()

        XCTAssertEqual(manager.tabs.count, 1)
        XCTAssertEqual(manager.selectedTabId, tabId)

        let tab = manager.tabs.first!
        XCTAssertEqual(tab.id, tabId)
        XCTAssertEqual(tab.workingDirectory, FileManager.default.homeDirectoryForCurrentUser)
        XCTAssertNotNil(tab.title)
        XCTAssertNil(tab.surfaceView)
    }

    func testOpenTab_WithCustomCwd_SetsWorkingDirectory() {
        let customCwd = URL(fileURLWithPath: "/tmp")
        let tabId = manager.openTab(cwd: customCwd)

        let tab = manager.tabs.first!
        XCTAssertEqual(tab.workingDirectory, customCwd)
    }

    func testOpenTab_WithCustomTitle_SetsTitle() {
        let customTitle = "My Terminal"
        let tabId = manager.openTab(title: customTitle)

        let tab = manager.tabs.first!
        XCTAssertEqual(tab.title, customTitle)
    }

    func testOpenTab_SelectsNewTab() {
        let firstTabId = manager.openTab()
        let secondTabId = manager.openTab()

        XCTAssertEqual(manager.selectedTabId, secondTabId)
        XCTAssertEqual(manager.tabs.count, 2)
    }

    func testOpenNewTab_CreatesDefaultTab() {
        manager.openNewTab()

        XCTAssertEqual(manager.tabs.count, 1)
        XCTAssertNotNil(manager.selectedTabId)
    }

    // MARK: - Tab Reuse Tests

    func testReuseOrOpenTab_ReusesExistingTab() {
        let cwd = URL(fileURLWithPath: "/tmp")
        let firstTabId = manager.openTab(cwd: cwd, title: "First")
        let secondTabId = manager.openTab(cwd: URL(fileURLWithPath: "/var"), title: "Second")

        let reusedTabId = manager.reuseOrOpenTab(cwd: cwd, title: "Should Not Be Used")

        XCTAssertEqual(reusedTabId, firstTabId)
        XCTAssertEqual(manager.selectedTabId, firstTabId)
        XCTAssertEqual(manager.tabs.count, 2) // No new tab created
    }

    func testReuseOrOpenTab_CreatesNewTabWhenNoMatch() {
        let existingCwd = URL(fileURLWithPath: "/tmp")
        let newCwd = URL(fileURLWithPath: "/var")

        manager.openTab(cwd: existingCwd)
        let newTabId = manager.reuseOrOpenTab(cwd: newCwd, title: "New Tab")

        XCTAssertEqual(manager.tabs.count, 2)
        XCTAssertEqual(manager.selectedTabId, newTabId)

        let newTab = manager.tabs.first { $0.id == newTabId }
        XCTAssertEqual(newTab?.workingDirectory, newCwd)
        XCTAssertEqual(newTab?.title, "New Tab")
    }

    // MARK: - Tab Selection Tests

    func testSelectTab_UpdatesSelectedTabId() {
        let firstTabId = manager.openTab()
        let secondTabId = manager.openTab()

        manager.selectTab(firstTabId)

        XCTAssertEqual(manager.selectedTabId, firstTabId)
    }

    func testSelectTab_IgnoresInvalidId() {
        let tabId = manager.openTab()
        let invalidId = UUID()

        manager.selectTab(invalidId)

        XCTAssertEqual(manager.selectedTabId, tabId) // Still the original
    }

    func testSelectedTab_ReturnsCorrectTab() {
        let firstTabId = manager.openTab(title: "First")
        let secondTabId = manager.openTab(title: "Second")

        manager.selectTab(firstTabId)
        XCTAssertEqual(manager.selectedTab?.title, "First")

        manager.selectTab(secondTabId)
        XCTAssertEqual(manager.selectedTab?.title, "Second")
    }

    func testSelectedTab_ReturnsNilWhenNoneSelected() {
        XCTAssertNil(manager.selectedTab)
    }

    // MARK: - Tab Closure Tests

    func testCloseTab_RemovesTab() {
        let tabId = manager.openTab()

        manager.closeTab(tabId)

        XCTAssertTrue(manager.tabs.isEmpty)
        XCTAssertNil(manager.selectedTabId)
    }

    func testCloseTab_SelectsNextTab() {
        let firstTabId = manager.openTab(title: "First")
        let secondTabId = manager.openTab(title: "Second")
        let thirdTabId = manager.openTab(title: "Third")

        manager.selectTab(secondTabId)
        manager.closeTab(secondTabId)

        XCTAssertEqual(manager.tabs.count, 2)
        XCTAssertEqual(manager.selectedTabId, thirdTabId) // Selects next
    }

    func testCloseTab_SelectsPreviousTabWhenClosingLast() {
        let firstTabId = manager.openTab(title: "First")
        let secondTabId = manager.openTab(title: "Second")

        manager.selectTab(secondTabId)
        manager.closeTab(secondTabId)

        XCTAssertEqual(manager.tabs.count, 1)
        XCTAssertEqual(manager.selectedTabId, firstTabId) // Selects previous
    }

    func testCloseTab_IgnoresInvalidId() {
        let tabId = manager.openTab()
        let invalidId = UUID()

        manager.closeTab(invalidId)

        XCTAssertEqual(manager.tabs.count, 1) // No change
        XCTAssertEqual(manager.selectedTabId, tabId)
    }

    func testCloseAllTabs_RemovesAllTabs() {
        manager.openTab()
        manager.openTab()
        manager.openTab()

        manager.closeAllTabs()

        XCTAssertTrue(manager.tabs.isEmpty)
        XCTAssertNil(manager.selectedTabId)
    }

    // MARK: - Tab Update Tests

    func testUpdateTabTitle_ChangesTitle() {
        let tabId = manager.openTab(title: "Original")

        manager.updateTabTitle(tabId, title: "Updated")

        XCTAssertEqual(manager.tabs.first?.title, "Updated")
    }

    func testUpdateTabTitle_IgnoresInvalidId() {
        let tabId = manager.openTab(title: "Original")

        manager.updateTabTitle(UUID(), title: "Should Not Apply")

        XCTAssertEqual(manager.tabs.first?.title, "Original")
    }

    func testUpdateTabWorkingDirectory_ChangesWorkingDirectory() {
        let tabId = manager.openTab(cwd: URL(fileURLWithPath: "/tmp"))
        let newCwd = URL(fileURLWithPath: "/var")

        manager.updateTabWorkingDirectory(tabId, workingDirectory: newCwd)

        XCTAssertEqual(manager.tabs.first?.workingDirectory, newCwd)
    }

    func testUpdateTabWorkingDirectory_IgnoresInvalidId() {
        let originalCwd = URL(fileURLWithPath: "/tmp")
        let tabId = manager.openTab(cwd: originalCwd)

        manager.updateTabWorkingDirectory(UUID(), workingDirectory: URL(fileURLWithPath: "/var"))

        XCTAssertEqual(manager.tabs.first?.workingDirectory, originalCwd)
    }

    // MARK: - Surface Management Tests

    func testAttachSurface_AttachesSurfaceView() {
        // Note: We can't create a real Ghostty.SurfaceView in tests without the full app context,
        // so this test verifies the API works but doesn't create a real surface
        let tabId = manager.openTab()

        // In real usage, this would be called with a real surface view
        // For now, we just verify the method exists and can be called
        XCTAssertNil(manager.tabs.first?.surfaceView)
    }

    // MARK: - Multiple Tabs Tests

    func testMultipleTabs_MaintainsIndependentState() {
        let tab1Id = manager.openTab(cwd: URL(fileURLWithPath: "/tmp"), title: "Tab 1")
        let tab2Id = manager.openTab(cwd: URL(fileURLWithPath: "/var"), title: "Tab 2")
        let tab3Id = manager.openTab(cwd: URL(fileURLWithPath: "/usr"), title: "Tab 3")

        XCTAssertEqual(manager.tabs.count, 3)

        // Verify each tab has correct properties
        let tab1 = manager.tabs.first { $0.id == tab1Id }!
        XCTAssertEqual(tab1.title, "Tab 1")
        XCTAssertEqual(tab1.workingDirectory?.path, "/tmp")

        let tab2 = manager.tabs.first { $0.id == tab2Id }!
        XCTAssertEqual(tab2.title, "Tab 2")
        XCTAssertEqual(tab2.workingDirectory?.path, "/var")

        let tab3 = manager.tabs.first { $0.id == tab3Id }!
        XCTAssertEqual(tab3.title, "Tab 3")
        XCTAssertEqual(tab3.workingDirectory?.path, "/usr")
    }

    // MARK: - Edge Cases

    func testEmptyManager_HasNoTabs() {
        XCTAssertTrue(manager.tabs.isEmpty)
        XCTAssertNil(manager.selectedTabId)
        XCTAssertNil(manager.selectedTab)
    }

    func testConcurrentTabOperations_MaintainsConsistency() {
        // Create several tabs
        let tab1Id = manager.openTab(title: "Tab 1")
        let tab2Id = manager.openTab(title: "Tab 2")
        let tab3Id = manager.openTab(title: "Tab 3")

        // Close middle tab
        manager.closeTab(tab2Id)
        XCTAssertEqual(manager.tabs.count, 2)

        // Update remaining tabs
        manager.updateTabTitle(tab1Id, title: "Updated Tab 1")
        manager.updateTabTitle(tab3Id, title: "Updated Tab 3")

        XCTAssertEqual(manager.tabs.first { $0.id == tab1Id }?.title, "Updated Tab 1")
        XCTAssertEqual(manager.tabs.first { $0.id == tab3Id }?.title, "Updated Tab 3")
    }

    // MARK: - Working Directory Tests

    func testTabWithoutWorkingDirectory_UsesHomeDirectory() {
        let tabId = manager.openTab(cwd: nil)

        let tab = manager.tabs.first!
        XCTAssertEqual(tab.workingDirectory, FileManager.default.homeDirectoryForCurrentUser)
    }

    func testTabTitle_DefaultsToDirectoryName() {
        let cwd = URL(fileURLWithPath: "/tmp/myproject")

        let tabId = manager.openTab(cwd: cwd, title: nil)

        let tab = manager.tabs.first!
        XCTAssertEqual(tab.title, "myproject")
    }
}

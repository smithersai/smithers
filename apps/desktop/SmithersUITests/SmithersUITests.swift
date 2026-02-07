import XCTest

final class SmithersUITests: XCTestCase {
    var app: XCUIApplication!

    override func setUpWithError() throws {
        continueAfterFailure = false
        app = XCUIApplication()
    }

    override func tearDownWithError() throws {
        app.terminate()
    }

    private func launchApp() {
        app.launch()
        app.activate()
        // Wait for window to appear
        _ = app.windows.firstMatch.waitForExistence(timeout: 10)
    }

    // MARK: - Editor tests

    func testEditorIsVisible() throws {
        let dir = try createTestDirectory()
        defer { try? FileManager.default.removeItem(at: dir) }

        launchWithDirectory(dir)

        // Click a file to show the editor
        let list = app.outlines["FileTreeList"]
        XCTAssertTrue(list.waitForExistence(timeout: 5))
        let readme = list.staticTexts["FileTreeItem_README.md"]
        XCTAssertTrue(readme.waitForExistence(timeout: 3))
        readme.click()

        let editor = app.scrollViews["CodeEditor"]
        XCTAssertTrue(editor.waitForExistence(timeout: 5), "Editor should be visible")
    }

    func testEditorShowsFileContents() throws {
        let dir = try createTestDirectory()
        defer { try? FileManager.default.removeItem(at: dir) }

        launchWithDirectory(dir)

        let list = app.outlines["FileTreeList"]
        XCTAssertTrue(list.waitForExistence(timeout: 5))
        let readme = list.staticTexts["FileTreeItem_README.md"]
        XCTAssertTrue(readme.waitForExistence(timeout: 3))
        readme.click()

        let editor = app.scrollViews["CodeEditor"]
        XCTAssertTrue(editor.waitForExistence(timeout: 5))

        let textView = editor.textViews.firstMatch
        XCTAssertTrue(textView.exists, "Text view should exist inside editor")

        let predicate = NSPredicate(format: "value CONTAINS %@", "# Test README")
        let expectation = XCTNSPredicateExpectation(predicate: predicate, object: textView)
        XCTAssertEqual(XCTWaiter.wait(for: [expectation], timeout: 5), .completed, "Editor should show file contents")
    }

    func testCanTypeInEditor() throws {
        let dir = try createTestDirectory()
        defer { try? FileManager.default.removeItem(at: dir) }

        launchWithDirectory(dir)

        let list = app.outlines["FileTreeList"]
        XCTAssertTrue(list.waitForExistence(timeout: 5))
        let readme = list.staticTexts["FileTreeItem_README.md"]
        XCTAssertTrue(readme.waitForExistence(timeout: 3))
        readme.click()

        let editor = app.scrollViews["CodeEditor"]
        XCTAssertTrue(editor.waitForExistence(timeout: 5))

        let textView = editor.textViews.firstMatch
        XCTAssertTrue(textView.exists)

        textView.click()
        textView.typeText("\nlet x = 42")

        let value = textView.value as? String ?? ""
        XCTAssertTrue(value.contains("let x = 42"), "Typed text should appear in editor, got: \(value)")
    }

    func testWindowScreenshot() throws {
        launchApp()
        let window = app.windows.firstMatch
        XCTAssertTrue(window.waitForExistence(timeout: 5))

        let screenshot = window.screenshot()
        let attachment = XCTAttachment(screenshot: screenshot)
        attachment.name = "editor-window"
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    // MARK: - File tree tests

    private func createTestDirectory() throws -> URL {
        let tmp = FileManager.default.temporaryDirectory
            .appendingPathComponent("SmithersTest_\(UUID().uuidString)")
        let fm = FileManager.default
        let srcDir = tmp.appendingPathComponent("src")
        try fm.createDirectory(at: srcDir, withIntermediateDirectories: true)
        try "# Test README".write(to: tmp.appendingPathComponent("README.md"), atomically: true, encoding: .utf8)
        try "let x = 42\n".write(to: srcDir.appendingPathComponent("main.swift"), atomically: true, encoding: .utf8)
        try "import Foundation\n".write(to: srcDir.appendingPathComponent("utils.swift"), atomically: true, encoding: .utf8)
        return tmp
    }

    private func launchWithDirectory(_ dir: URL) {
        app.launchArguments = ["-openDirectory", dir.path]
        launchApp()
    }

    func testSidebarShowsEmptyState() throws {
        launchApp()
        let label = app.staticTexts["NoFolderLabel"]
        XCTAssertTrue(label.waitForExistence(timeout: 5), "Should show 'No folder open' label")

        let button = app.buttons["OpenFolderButton"]
        XCTAssertTrue(button.exists, "Should show 'Open Folder...' button")
    }

    func testOpenDirectoryShowsFileTree() throws {
        let dir = try createTestDirectory()
        defer { try? FileManager.default.removeItem(at: dir) }

        launchWithDirectory(dir)

        let list = app.outlines["FileTreeList"]
        XCTAssertTrue(list.waitForExistence(timeout: 5), "File tree list should be visible")
    }

    func testFileTreeShowsFiles() throws {
        let dir = try createTestDirectory()
        defer { try? FileManager.default.removeItem(at: dir) }

        launchWithDirectory(dir)

        let list = app.outlines["FileTreeList"]
        XCTAssertTrue(list.waitForExistence(timeout: 5))

        let readme = list.staticTexts["FileTreeItem_README.md"]
        XCTAssertTrue(readme.waitForExistence(timeout: 3), "README.md should appear in file tree")
    }

    func testFileTreeShowsFolders() throws {
        let dir = try createTestDirectory()
        defer { try? FileManager.default.removeItem(at: dir) }

        launchWithDirectory(dir)

        let list = app.outlines["FileTreeList"]
        XCTAssertTrue(list.waitForExistence(timeout: 5))

        let srcFolder = list.staticTexts["FileTreeItem_src"]
        XCTAssertTrue(srcFolder.waitForExistence(timeout: 3), "src folder should appear in file tree")
    }

    func testClickFileShowsContents() throws {
        let dir = try createTestDirectory()
        defer { try? FileManager.default.removeItem(at: dir) }

        launchWithDirectory(dir)

        let list = app.outlines["FileTreeList"]
        XCTAssertTrue(list.waitForExistence(timeout: 5))

        let readme = list.staticTexts["FileTreeItem_README.md"]
        XCTAssertTrue(readme.waitForExistence(timeout: 3))
        readme.click()

        let editor = app.scrollViews["CodeEditor"]
        XCTAssertTrue(editor.waitForExistence(timeout: 5))
        let textView = editor.textViews.firstMatch
        XCTAssertTrue(textView.exists)

        // Wait for content to update
        let predicate = NSPredicate(format: "value CONTAINS %@", "# Test README")
        let expectation = XCTNSPredicateExpectation(predicate: predicate, object: textView)
        let result = XCTWaiter.wait(for: [expectation], timeout: 5)
        XCTAssertEqual(result, .completed, "Editor should show README contents")
    }

    func testClickDifferentFileSwitchesContent() throws {
        let dir = try createTestDirectory()
        defer { try? FileManager.default.removeItem(at: dir) }

        launchWithDirectory(dir)

        let list = app.outlines["FileTreeList"]
        XCTAssertTrue(list.waitForExistence(timeout: 5))

        // Click README first
        let readme = list.staticTexts["FileTreeItem_README.md"]
        XCTAssertTrue(readme.waitForExistence(timeout: 3))
        readme.click()

        let editor = app.scrollViews["CodeEditor"]
        XCTAssertTrue(editor.waitForExistence(timeout: 5))
        let textView = editor.textViews.firstMatch

        let readmePredicate = NSPredicate(format: "value CONTAINS %@", "# Test README")
        let readmeExpectation = XCTNSPredicateExpectation(predicate: readmePredicate, object: textView)
        XCTAssertEqual(XCTWaiter.wait(for: [readmeExpectation], timeout: 5), .completed)

        // Expand src folder by clicking it
        let srcFolder = list.staticTexts["FileTreeItem_src"]
        XCTAssertTrue(srcFolder.waitForExistence(timeout: 3))
        srcFolder.click()

        let mainSwift = list.staticTexts["FileTreeItem_main.swift"]
        XCTAssertTrue(mainSwift.waitForExistence(timeout: 3))
        mainSwift.click()

        let mainPredicate = NSPredicate(format: "value CONTAINS %@", "let x = 42")
        let mainExpectation = XCTNSPredicateExpectation(predicate: mainPredicate, object: textView)
        XCTAssertEqual(XCTWaiter.wait(for: [mainExpectation], timeout: 5), .completed, "Editor should switch to main.swift contents")
    }

    func testFileTreeScreenshot() throws {
        let dir = try createTestDirectory()
        defer { try? FileManager.default.removeItem(at: dir) }

        launchWithDirectory(dir)

        let list = app.outlines["FileTreeList"]
        XCTAssertTrue(list.waitForExistence(timeout: 5))

        // Click a file so the editor has content
        let readme = list.staticTexts["FileTreeItem_README.md"]
        XCTAssertTrue(readme.waitForExistence(timeout: 3))
        readme.click()

        // Wait for editor content
        let editor = app.scrollViews["CodeEditor"]
        XCTAssertTrue(editor.waitForExistence(timeout: 5))

        sleep(1) // Brief pause for rendering

        let window = app.windows.firstMatch
        let screenshot = window.screenshot()
        let attachment = XCTAttachment(screenshot: screenshot)
        attachment.name = "file-tree-sidebar"
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}

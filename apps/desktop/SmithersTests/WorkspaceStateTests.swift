import XCTest
@testable import Smithers

@MainActor
final class WorkspaceStateTests: XCTestCase {

    private func makeTempDir() throws -> URL {
        let tmpDir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: tmpDir, withIntermediateDirectories: true)
        return tmpDir
    }

    private func waitUntil(_ condition: @escaping () -> Bool, timeout: TimeInterval = 2.0) async -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if condition() { return true }
            try? await Task.sleep(nanoseconds: 50_000_000)
        }
        return condition()
    }

    private func isRipgrepAvailable() -> Bool {
        guard let pathEnv = ProcessInfo.processInfo.environment["PATH"] else { return false }
        for part in pathEnv.split(separator: ":") {
            let candidate = URL(fileURLWithPath: String(part)).appendingPathComponent("rg").path
            if FileManager.default.isExecutableFile(atPath: candidate) {
                return true
            }
        }
        return false
    }

    // MARK: - Phase 4: expandFolder

    func testOpenDirectoryProducesShallowTree() throws {
        let tmpDir = try makeTempDir()
        defer { try? FileManager.default.removeItem(at: tmpDir) }

        let sub = tmpDir.appendingPathComponent("sub")
        try FileManager.default.createDirectory(at: sub, withIntermediateDirectories: true)
        try "x".write(to: sub.appendingPathComponent("file.txt"), atomically: true, encoding: .utf8)

        let ws = WorkspaceState()
        ws.openDirectory(tmpDir)

        let folder = ws.fileTree.first { $0.isFolder && $0.name == "sub" }
        XCTAssertNotNil(folder)
        XCTAssertTrue(folder!.needsLoading, "openDirectory should produce shallow tree")
    }

    func testExpandFolderLoadsChildren() throws {
        let tmpDir = try makeTempDir()
        defer { try? FileManager.default.removeItem(at: tmpDir) }

        let sub = tmpDir.appendingPathComponent("sub")
        try FileManager.default.createDirectory(at: sub, withIntermediateDirectories: true)
        try "hello".write(to: sub.appendingPathComponent("a.txt"), atomically: true, encoding: .utf8)

        let ws = WorkspaceState()
        ws.openDirectory(tmpDir)

        let folder = ws.fileTree.first { $0.isFolder && $0.name == "sub" }!
        XCTAssertTrue(folder.needsLoading)

        ws.expandFolder(folder)

        let updated = ws.fileTree.first { $0.isFolder && $0.name == "sub" }!
        XCTAssertFalse(updated.needsLoading)
        XCTAssertEqual(updated.children?.count, 1)
        XCTAssertEqual(updated.children?.first?.name, "a.txt")
    }

    func testExpandFolderAlreadyLoadedIsNoOp() throws {
        let tmpDir = try makeTempDir()
        defer { try? FileManager.default.removeItem(at: tmpDir) }

        let sub = tmpDir.appendingPathComponent("sub")
        try FileManager.default.createDirectory(at: sub, withIntermediateDirectories: true)
        try "hello".write(to: sub.appendingPathComponent("a.txt"), atomically: true, encoding: .utf8)

        let ws = WorkspaceState()
        ws.openDirectory(tmpDir)

        let folder = ws.fileTree.first { $0.isFolder && $0.name == "sub" }!
        ws.expandFolder(folder)

        let loaded = ws.fileTree.first { $0.isFolder && $0.name == "sub" }!
        let childrenBefore = loaded.children

        // Expand again — should be a no-op
        ws.expandFolder(loaded)

        let afterSecond = ws.fileTree.first { $0.isFolder && $0.name == "sub" }!
        XCTAssertEqual(afterSecond.children, childrenBefore)
    }

    func testExpandFolderNestedTwoLevels() throws {
        let tmpDir = try makeTempDir()
        defer { try? FileManager.default.removeItem(at: tmpDir) }

        let l1 = tmpDir.appendingPathComponent("l1")
        let l2 = l1.appendingPathComponent("l2")
        try FileManager.default.createDirectory(at: l2, withIntermediateDirectories: true)
        try "deep".write(to: l2.appendingPathComponent("deep.txt"), atomically: true, encoding: .utf8)

        let ws = WorkspaceState()
        ws.openDirectory(tmpDir)

        // Expand l1
        let folderL1 = ws.fileTree.first { $0.name == "l1" }!
        XCTAssertTrue(folderL1.needsLoading)
        ws.expandFolder(folderL1)

        // Now expand l2 within l1
        let updatedL1 = ws.fileTree.first { $0.name == "l1" }!
        let folderL2 = updatedL1.children!.first { $0.name == "l2" }!
        XCTAssertTrue(folderL2.needsLoading)
        ws.expandFolder(folderL2)

        // Verify l2 is loaded
        let finalL1 = ws.fileTree.first { $0.name == "l1" }!
        let finalL2 = finalL1.children!.first { $0.name == "l2" }!
        XCTAssertFalse(finalL2.needsLoading)
        XCTAssertEqual(finalL2.children?.count, 1)
        XCTAssertEqual(finalL2.children?.first?.name, "deep.txt")
    }

    // MARK: - Tabs

    func testSelectFileAddsOpenTab() throws {
        let tmpDir = try makeTempDir()
        defer { try? FileManager.default.removeItem(at: tmpDir) }

        let file = tmpDir.appendingPathComponent("a.txt")
        try "hello".write(to: file, atomically: true, encoding: .utf8)

        let ws = WorkspaceState()
        ws.openDirectory(tmpDir)
        ws.selectFile(file)

        XCTAssertEqual(ws.openFiles.count, 2)
        XCTAssertTrue(ws.isChatURL(ws.openFiles[0]))
        XCTAssertEqual(ws.openFiles[1], file)
        XCTAssertEqual(ws.selectedFileURL, file)
    }

    func testCloseFileSelectsNeighbor() throws {
        let tmpDir = try makeTempDir()
        defer { try? FileManager.default.removeItem(at: tmpDir) }

        let fileA = tmpDir.appendingPathComponent("a.txt")
        let fileB = tmpDir.appendingPathComponent("b.txt")
        try "a".write(to: fileA, atomically: true, encoding: .utf8)
        try "b".write(to: fileB, atomically: true, encoding: .utf8)

        let ws = WorkspaceState()
        ws.openDirectory(tmpDir)
        ws.selectFile(fileA)
        ws.selectFile(fileB)

        ws.closeFile(fileB)

        XCTAssertEqual(ws.openFiles.count, 2)
        XCTAssertTrue(ws.isChatURL(ws.openFiles[0]))
        XCTAssertEqual(ws.openFiles[1], fileA)
        XCTAssertEqual(ws.selectedFileURL, fileA)
    }

    func testTabNavigationSelectsExpectedTabs() throws {
        let tmpDir = try makeTempDir()
        defer { try? FileManager.default.removeItem(at: tmpDir) }

        let fileA = tmpDir.appendingPathComponent("a.txt")
        let fileB = tmpDir.appendingPathComponent("b.txt")
        try "a".write(to: fileA, atomically: true, encoding: .utf8)
        try "b".write(to: fileB, atomically: true, encoding: .utf8)

        let ws = WorkspaceState()
        ws.openDirectory(tmpDir)
        ws.selectFile(fileA)
        ws.selectFile(fileB)

        ws.selectPreviousTab()
        XCTAssertEqual(ws.selectedFileURL, fileA)

        ws.selectNextTab()
        XCTAssertEqual(ws.selectedFileURL, fileB)

        ws.selectTab(index: 0)
        XCTAssertTrue(ws.isChatURL(ws.selectedFileURL!))
    }

    func testHandleOpenURLOpensFile() async throws {
        let tmpDir = try makeTempDir()
        defer { try? FileManager.default.removeItem(at: tmpDir) }

        let file = tmpDir.appendingPathComponent("log.txt")
        try "log".write(to: file, atomically: true, encoding: .utf8)

        let ws = WorkspaceState()
        ws.openDirectory(tmpDir)

        let link = ws.makeOpenFileURL(path: file.path, line: 3, column: 2)
        XCTAssertNotNil(link)
        guard let link else { return }
        XCTAssertTrue(ws.handleOpenURL(link))
        let opened = await waitUntil({ ws.selectedFileURL == file })
        XCTAssertTrue(opened)
    }

    func testHandleExternalOpenSetsWorkspaceRoot() async throws {
        let tmpDir = try makeTempDir()
        defer { try? FileManager.default.removeItem(at: tmpDir) }

        let file = tmpDir.appendingPathComponent("main.swift")
        try "print(\"hello\")".write(to: file, atomically: true, encoding: .utf8)

        let ws = WorkspaceState()
        ws.handleExternalOpen(urls: [file])

        let rootSet = await waitUntil({ ws.rootDirectory != nil })
        XCTAssertTrue(rootSet)
        XCTAssertEqual(ws.rootDirectory?.standardizedFileURL, tmpDir.standardizedFileURL)
        XCTAssertEqual(ws.selectedFileURL, file)
        XCTAssertTrue(ws.openFiles.contains(file))
    }

    func testHandleExternalOpenMultipleFilesOpensInOneWindow() async throws {
        let tmpDir = try makeTempDir()
        defer { try? FileManager.default.removeItem(at: tmpDir) }

        let fileA = tmpDir.appendingPathComponent("a.py")
        let fileB = tmpDir.appendingPathComponent("b.py")
        try "a".write(to: fileA, atomically: true, encoding: .utf8)
        try "b".write(to: fileB, atomically: true, encoding: .utf8)

        let ws = WorkspaceState()
        ws.handleExternalOpen(urls: [fileA, fileB])

        let filesOpened = await waitUntil({ ws.openFiles.contains(fileA) && ws.openFiles.contains(fileB) })
        XCTAssertTrue(filesOpened)
        XCTAssertEqual(ws.rootDirectory?.standardizedFileURL, tmpDir.standardizedFileURL)
        XCTAssertEqual(ws.selectedFileURL, fileB)
        XCTAssertEqual(ws.openFiles.count, 3)
    }

    func testNonUTF8FileIsReadOnly() async throws {
        let tmpDir = try makeTempDir()
        defer { try? FileManager.default.removeItem(at: tmpDir) }

        let file = tmpDir.appendingPathComponent("binary.dat")
        let originalData = Data([0xff, 0xfe, 0xfd, 0x00])
        try originalData.write(to: file)

        let ws = WorkspaceState()
        ws.openDirectory(tmpDir)
        ws.selectFile(file)

        let loaded = await waitUntil({ !ws.isEditorLoading })
        XCTAssertTrue(loaded)
        XCTAssertEqual(ws.editorText, WorkspaceState.nonUTF8Placeholder)
        XCTAssertFalse(ws.isFileModified(file))

        ws.editorText = "mutate"
        let reverted = await waitUntil({ ws.editorText == WorkspaceState.nonUTF8Placeholder })
        XCTAssertTrue(reverted)
        XCTAssertFalse(ws.isFileModified(file))

        ws.saveCurrentFile()
        let afterSave = try Data(contentsOf: file)
        XCTAssertEqual(afterSave, originalData)
    }

    func testUTF8FileModificationAndSave() async throws {
        let tmpDir = try makeTempDir()
        defer { try? FileManager.default.removeItem(at: tmpDir) }

        let file = tmpDir.appendingPathComponent("note.txt")
        try "hello".write(to: file, atomically: true, encoding: .utf8)

        let ws = WorkspaceState()
        ws.isAutoSaveEnabled = false
        ws.openDirectory(tmpDir)
        ws.selectFile(file)

        let loaded = await waitUntil({ !ws.isEditorLoading })
        XCTAssertTrue(loaded)
        XCTAssertEqual(ws.editorText, "hello")

        ws.editorText = "hello world"
        let modified = await waitUntil({ ws.isFileModified(file) })
        XCTAssertTrue(modified)

        ws.saveCurrentFile()
        let afterSave = try String(contentsOf: file)
        XCTAssertEqual(afterSave, "hello world")
        XCTAssertFalse(ws.isFileModified(file))
    }

    func testSearchInFilesUsesLatestQuery() async throws {
        if !isRipgrepAvailable() {
            throw XCTSkip("rg not available")
        }

        let tmpDir = try makeTempDir()
        defer { try? FileManager.default.removeItem(at: tmpDir) }

        let alpha = tmpDir.appendingPathComponent("alpha.txt")
        let beta = tmpDir.appendingPathComponent("beta.txt")
        try "alpha".write(to: alpha, atomically: true, encoding: .utf8)
        try "beta".write(to: beta, atomically: true, encoding: .utf8)

        let ws = WorkspaceState()
        ws.openDirectory(tmpDir)
        await ws.runSearchInFilesForTesting(query: "alpha")
        await ws.runSearchInFilesForTesting(query: "beta")

        XCTAssertNil(ws.searchErrorMessage)
        let resultFiles = Set(ws.searchResults.map { $0.url.lastPathComponent })
        XCTAssertTrue(resultFiles.contains("beta.txt"))
        XCTAssertFalse(resultFiles.contains("alpha.txt"))
    }
}

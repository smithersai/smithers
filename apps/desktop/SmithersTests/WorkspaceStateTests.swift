import XCTest
@testable import Smithers

final class WorkspaceStateTests: XCTestCase {

    private func makeTempDir() throws -> URL {
        let tmpDir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: tmpDir, withIntermediateDirectories: true)
        return tmpDir
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
}

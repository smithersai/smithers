import XCTest
@testable import Smithers

final class FileItemTests: XCTestCase {

    // MARK: - Phase 1: Sentinel Infrastructure

    func testPlaceholderIsIdentifiable() {
        let placeholder = FileItem.lazyPlaceholder
        XCTAssertEqual(placeholder.id, FileItem.lazyPlaceholderURL)
        XCTAssertEqual(placeholder.name, "__lazy_placeholder__")
        XCTAssertTrue(placeholder.isLazyPlaceholder)
    }

    func testRegularFileIsNotPlaceholder() {
        let file = FileItem(id: URL(fileURLWithPath: "/tmp/test.txt"), name: "test.txt", isFolder: false, children: nil)
        XCTAssertFalse(file.isLazyPlaceholder)
    }

    func testFolderWithSentinelNeedsLoading() {
        let folder = FileItem(id: URL(fileURLWithPath: "/tmp/folder"), name: "folder", isFolder: true, children: [FileItem.lazyPlaceholder])
        XCTAssertTrue(folder.needsLoading)
    }

    func testFolderWithRealChildrenDoesNotNeedLoading() {
        let child = FileItem(id: URL(fileURLWithPath: "/tmp/folder/a.txt"), name: "a.txt", isFolder: false, children: nil)
        let folder = FileItem(id: URL(fileURLWithPath: "/tmp/folder"), name: "folder", isFolder: true, children: [child])
        XCTAssertFalse(folder.needsLoading)
    }

    func testEmptyFolderDoesNotNeedLoading() {
        let folder = FileItem(id: URL(fileURLWithPath: "/tmp/folder"), name: "folder", isFolder: true, children: [])
        XCTAssertFalse(folder.needsLoading)
    }

    func testFileDoesNotNeedLoading() {
        let file = FileItem(id: URL(fileURLWithPath: "/tmp/test.txt"), name: "test.txt", isFolder: false, children: nil)
        XCTAssertFalse(file.needsLoading)
    }

    // MARK: - Phase 2: Shallow Loading

    func testLoadShallowChildrenReturnsImmediateChildren() throws {
        let tmpDir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: tmpDir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tmpDir) }

        // Create a file and a subfolder with its own file
        let subFolder = tmpDir.appendingPathComponent("subfolder")
        try FileManager.default.createDirectory(at: subFolder, withIntermediateDirectories: true)
        try "hello".write(to: tmpDir.appendingPathComponent("file.txt"), atomically: true, encoding: .utf8)
        try "nested".write(to: subFolder.appendingPathComponent("nested.txt"), atomically: true, encoding: .utf8)

        let children = FileItem.loadShallowChildren(of: tmpDir)

        // Should have 2 items: subfolder and file.txt
        XCTAssertEqual(children.count, 2)

        // Folders come first (sorted)
        let folder = children[0]
        XCTAssertTrue(folder.isFolder)
        XCTAssertEqual(folder.name, "subfolder")
        // Subfolder should have sentinel, NOT recursively loaded children
        XCTAssertTrue(folder.needsLoading)
        XCTAssertEqual(folder.children?.count, 1)
        XCTAssertTrue(folder.children!.first!.isLazyPlaceholder)

        let file = children[1]
        XCTAssertFalse(file.isFolder)
        XCTAssertEqual(file.name, "file.txt")
        XCTAssertNil(file.children)
    }

    func testLoadShallowChildrenEmptyDirectory() throws {
        let tmpDir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: tmpDir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tmpDir) }

        let children = FileItem.loadShallowChildren(of: tmpDir)
        XCTAssertEqual(children, [])
    }

    func testLoadShallowChildrenInvalidPath() {
        let bogus = URL(fileURLWithPath: "/nonexistent_\(UUID().uuidString)")
        let children = FileItem.loadShallowChildren(of: bogus)
        XCTAssertEqual(children, [])
    }

    // MARK: - Phase 3: loadTree is Shallow

    func testLoadTreeReturnsShallowTree() throws {
        let tmpDir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: tmpDir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tmpDir) }

        let subFolder = tmpDir.appendingPathComponent("sub")
        try FileManager.default.createDirectory(at: subFolder, withIntermediateDirectories: true)
        try "x".write(to: subFolder.appendingPathComponent("deep.txt"), atomically: true, encoding: .utf8)

        let tree = FileItem.loadTree(at: tmpDir)
        let folder = tree.first { $0.isFolder && $0.name == "sub" }
        XCTAssertNotNil(folder)
        XCTAssertTrue(folder!.needsLoading, "loadTree should produce shallow tree with sentinels")
    }

    // MARK: - Phase 5: replaceChildren

    func testReplaceChildrenReplacesTargetFolder() {
        let folderURL = URL(fileURLWithPath: "/root/folder")
        let newChild = FileItem(id: URL(fileURLWithPath: "/root/folder/a.txt"), name: "a.txt", isFolder: false, children: nil)

        var tree = [
            FileItem(id: folderURL, name: "folder", isFolder: true, children: [FileItem.lazyPlaceholder]),
            FileItem(id: URL(fileURLWithPath: "/root/b.txt"), name: "b.txt", isFolder: false, children: nil),
        ]

        FileItem.replaceChildren(in: &tree, for: folderURL, with: [newChild])

        let folder = tree.first { $0.id == folderURL }!
        XCTAssertEqual(folder.children?.count, 1)
        XCTAssertEqual(folder.children?.first?.name, "a.txt")
        XCTAssertFalse(folder.needsLoading)
    }

    func testReplaceChildrenWorksNested() {
        let level1URL = URL(fileURLWithPath: "/root/l1")
        let level2URL = URL(fileURLWithPath: "/root/l1/l2")
        let newChild = FileItem(id: URL(fileURLWithPath: "/root/l1/l2/file.txt"), name: "file.txt", isFolder: false, children: nil)

        let l2 = FileItem(id: level2URL, name: "l2", isFolder: true, children: [FileItem.lazyPlaceholder])
        let l1 = FileItem(id: level1URL, name: "l1", isFolder: true, children: [l2])
        var tree = [l1]

        FileItem.replaceChildren(in: &tree, for: level2URL, with: [newChild])

        let updatedL1 = tree.first { $0.id == level1URL }!
        let updatedL2 = updatedL1.children!.first { $0.id == level2URL }!
        XCTAssertEqual(updatedL2.children?.count, 1)
        XCTAssertEqual(updatedL2.children?.first?.name, "file.txt")
    }
}

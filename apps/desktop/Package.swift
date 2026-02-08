// swift-tools-version: 5.10
import PackageDescription

let package = Package(
    name: "Smithers",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "Smithers", targets: ["Smithers"]),
    ],
    dependencies: [
        .package(url: "https://github.com/krzyzanowskim/STTextView.git", from: "0.9.0"),
        .package(url: "https://github.com/tree-sitter/swift-tree-sitter.git", from: "0.9.0"),
        .package(url: "https://github.com/alex-pinkus/tree-sitter-swift.git", branch: "with-generated-files"),
        .package(url: "https://github.com/tree-sitter/tree-sitter-javascript.git", exact: "0.23.1"),
        .package(url: "https://github.com/tree-sitter/tree-sitter-python.git", exact: "0.23.6"),
        .package(url: "https://github.com/tree-sitter/tree-sitter-json.git", exact: "0.24.8"),
        .package(url: "https://github.com/tree-sitter/tree-sitter-bash.git", exact: "0.23.3"),
        .package(url: "https://github.com/tree-sitter/tree-sitter-typescript.git", exact: "0.23.2"),
        .package(url: "https://github.com/tree-sitter-grammars/tree-sitter-markdown.git", exact: "0.4.1"),
        .package(url: "https://github.com/tree-sitter-grammars/tree-sitter-zig.git", exact: "1.1.2"),
        .package(url: "https://github.com/tree-sitter/tree-sitter-rust.git", exact: "0.23.3"),
        .package(url: "https://github.com/tree-sitter/tree-sitter-go.git", exact: "0.23.4"),
    ],
    targets: [
        .binaryTarget(
            name: "GhosttyKit",
            path: "../../ghostty/macos/GhosttyKit.xcframework"
        ),
        .executableTarget(
            name: "Smithers",
            dependencies: [
                "GhosttyKit",
                .product(name: "STTextView", package: "STTextView"),
                .product(name: "SwiftTreeSitter", package: "swift-tree-sitter"),
                .product(name: "TreeSitterSwift", package: "tree-sitter-swift"),
                .product(name: "TreeSitterJavaScript", package: "tree-sitter-javascript"),
                .product(name: "TreeSitterPython", package: "tree-sitter-python"),
                .product(name: "TreeSitterJSON", package: "tree-sitter-json"),
                .product(name: "TreeSitterBash", package: "tree-sitter-bash"),
                .product(name: "TreeSitterTypeScript", package: "tree-sitter-typescript"),
                .product(name: "TreeSitterMarkdown", package: "tree-sitter-markdown"),
                .product(name: "TreeSitterZig", package: "tree-sitter-zig"),
                .product(name: "TreeSitterRust", package: "tree-sitter-rust"),
                .product(name: "TreeSitterGo", package: "tree-sitter-go"),
            ],
            path: "Smithers",
            linkerSettings: [
                .linkedLibrary("stdc++"),
                .linkedFramework("Carbon"),
            ]
        ),
    ]
)

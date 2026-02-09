# Smithers Desktop

Native macOS IDE built with SwiftUI, targeting macOS 14+.

## Build & Run

```bash
# From repo root:
zig build dev        # Build and launch .app bundle
zig build test       # Run XCUITests

# Regenerate Xcode project after changing project.yml:
cd apps/desktop && xcodegen generate
```

## Architecture

**Entry point**: `SmithersApp.swift` — WindowGroup with hidden title bar, launch args (`-openDirectory`, `-openFile`), menu commands.

**State**: `WorkspaceState.swift` — single `@MainActor ObservableObject` holding all app state: open files, file tree, editor content, terminals, chat, theme, search, diffs. This is the largest file and the central hub.

**Views**:
- `ContentView.swift` — NavigationSplitView (sidebar + detail with tab bar). Contains `CodeEditor` (NSViewRepresentable wrapping STTextView).
- `FileTreeSidebar.swift` — list-based file browser with lazy folder expansion
- `CommandPaletteView.swift` — Cmd+P palette (file search + command mode with `>` prefix)
- `SearchPanelView.swift` — Cmd+Shift+F workspace-wide text search
- `ChatView.swift` — AI chat interface connected to CodexService
- `DiffViewer.swift` — unified diff display with hunk navigation

**File tree**: `FileItem.swift` — recursive model with lazy sentinel pattern (placeholder children for unloaded folders).

**Editor**: STTextView (TextKit 2) with TreeSitter syntax highlighting (`SyntaxHighlighting.swift`). Supported languages: Swift, JS, TS, TSX, Python, JSON, Bash, Markdown, Zig, Rust, Go.

**Terminal**: Ghostty integration via `GhosttyTerminalView.swift` (NSView) + `GhosttyApp.swift` (singleton C library wrapper) + `GhosttyInput.swift` (key mapping). Ghostty binary framework at `ghostty/macos/`.

**Neovim**: `NvimController.swift` launches nvim subprocess with stdio RPC (`NvimRPC.swift` — MessagePack protocol). Syncs buffers, highlights, and cursor. Toggled on/off in UI.

**AI backend**: `CodexService.swift` talks to Rust `codex-app-server` via `JSONRPCTransport.swift` (JSON-RPC 2.0 over stdio). Events: message deltas, command execution, file changes.

**Theming**: `AppTheme.swift` — 24-color theme struct, can derive from Neovim highlight groups.

**Utilities**: `TmuxKeyHandler.swift` (Ctrl+A prefix shortcuts), `LinkifiedText.swift` (clickable file paths), `CloseGuard.swift` (unsaved changes prompt), `ChatHistoryStore.swift` (per-workspace chat persistence).

## Dependencies

- **STTextView 0.9.0** — native Swift editor (TextKit 2)
- **SwiftTreeSitter 0.9.0** + language grammars — syntax highlighting
- **GhosttyKit** — terminal emulator (local binary framework)
- **Carbon** — native macOS APIs

Deps declared in both `Package.swift` and `project.yml`. Keep them in sync.

## Testing

- **Unit tests**: `SmithersTests/FileItemTests.swift` — tests for file tree lazy loading
- **UI tests**: `SmithersUITests/SmithersUITests.swift` — XCUITest automation

Run with `zig build test`. Screenshots from UI tests can be extracted from `.xcresult` bundles.

## Reference Implementations

Cloned reference projects live in `references/` at the repo root:

- **neovide** — Rust-based Neovim GUI. Reference for Neovim bridge, RPC communication, cursor rendering, and cross-platform window management.
- **vimr** — Native macOS Neovim GUI (Swift/AppKit). Reference for NvimApi (MessagePack RPC), NvimView (rendering, key handling, grid), tab bar, and workspace layout.
- **zonvie** — Zig + Swift Neovim GUI with Metal rendering. Reference for Zig build system integration, msgpack RPC, GPU text rendering, and macOS app structure with Zig core.

## Gotchas

- STTextView `textColor` only sets typing attributes for new text. To color existing text, use `setTextColor(_:range:)` after `setAttributedString`.
- XCUITest on macOS: must call `app.activate()` after `app.launch()` for the window to appear in accessibility hierarchy.
- Don't set `.accessibilityIdentifier()` on SwiftUI `Group` — it propagates to all children, overriding their individual identifiers.
- To expand a folder in XCUITest, click `disclosureTriangles.firstMatch`, not the folder text (which selects it).
- The `.app` bundle is required for keyboard focus — raw executables from `swift build` won't work properly.

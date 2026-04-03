# Smithers IDE — Agent Instructions

You are running inside **Smithers**, a native macOS IDE built with SwiftUI. You can interact with the IDE using the `smithers-ctl` CLI tool.

## Project Overview

- **Desktop app**: `apps/desktop/` — Swift/SwiftUI, macOS 14+
- **Build**: `zig build dev` (build & launch), `zig build test` (XCUITests)
- **Editor**: STTextView (TextKit 2) with TreeSitter syntax highlighting
- **Terminal**: Ghostty integration
- **VCS**: jj (Jujutsu) — not git
- **AI backend**: Codex via JSON-RPC over stdio

## smithers-ctl Command Reference

Use these commands to control the IDE from your shell:

### Open files
```bash
smithers-ctl open <path> [--line N] [--column N]
smithers-ctl open <path> +N        # jump to line N
smithers-ctl open <path> +N:C      # jump to line N, column C
```

### Terminal
```bash
smithers-ctl terminal                          # open new terminal tab
smithers-ctl terminal --command "CMD"          # open terminal running CMD
smithers-ctl terminal --cwd /path              # open terminal in directory
smithers-ctl terminal run <cmd>                # run command in new terminal
```

### Diff preview
```bash
smithers-ctl diff show --content "<unified diff>" [--title "Title"] [--file path]
```

### Overlays (notifications / progress)
```bash
smithers-ctl overlay --type chat --message "text"
smithers-ctl overlay --type progress --message "Building..." --percent 50
smithers-ctl overlay --type panel --message "text" --title "Heading" --position center --duration 5
smithers-ctl dismiss-overlay [--id ID]
```

### Webview tabs
```bash
smithers-ctl webview open <url> [--title "Title"]   # returns tab ID
smithers-ctl webview close <tab-id>
smithers-ctl webview eval <tab-id> --js "document.title"
smithers-ctl webview url <tab-id>
```

## Build & Test

```bash
zig build dev          # build and launch .app bundle
zig build test         # run XCUITests
cd apps/desktop && xcodegen generate   # regenerate Xcode project after project.yml changes
```

## Key Conventions

- Use `jj` for version control, not `git`
- Dependencies in both `apps/desktop/Package.swift` and `apps/desktop/project.yml` — keep in sync
- SmithersShared is NOT a module — don't `import SmithersShared`, just reference types directly

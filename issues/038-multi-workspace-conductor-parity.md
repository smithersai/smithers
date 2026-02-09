# Multi-Workspace Support & Conductor Parity

## Summary

Add multi-workspace support to Smithers with a unified agent, SQLite persistence via GRDB.swift, and Conductor-parity features (checkpoints, todos, scripts, GitHub integration, archiving). Transforms Smithers from a single-workspace IDE into a multi-project orchestration environment.

## Context

Smithers currently operates as a single-workspace IDE. `WorkspaceState` (2,780 lines) is a `@MainActor ObservableObject` singleton that holds *all* app state — file tree, editor content, terminals, chat, theme, search, diffs, preferences, neovim, and session management. When the user calls `openDirectory()` (line 502), it does a hard reset: stops codex, closes terminals, clears all state, and reinitializes everything for the new directory.

This means:
- Only one project is active at a time
- Switching projects kills all running agents and terminals
- No cross-project awareness or coordination
- Session state is persisted via UserDefaults (fragile, not queryable)
- Chat history is persisted as JSON files via `ChatHistoryStore.swift`

[Conductor](https://conductor.build) demonstrates the value of parallel workspaces with isolated agents, checkpoints, todos, scripts, and GitHub integration. This issue adds those capabilities to Smithers.

### Design Decisions

- **Single-window model** with workspace switcher dropdown + dashboard sidebar (not multi-window)
- **Symlink directory approach** for the main workspace unified agent — a directory containing symlinks to all workspace roots, so one CodexService instance can see all repos
- **SQLite via GRDB.swift** for all workspace metadata (replaces UserDefaults for structured data)

## Phase 1: Foundation (SQLite + Data Model Refactor)

### 1.1 Add GRDB.swift Dependency

**Files to modify:**
- `apps/desktop/Package.swift` — add `.package(url: "https://github.com/groue/GRDB.swift.git", from: "7.0.0")` to dependencies and `.product(name: "GRDB", package: "GRDB.swift")` to the Smithers target
- `apps/desktop/project.yml` — add `GRDB.swift` package entry and `GRDB` product dependency to the Smithers target

### 1.2 SQLite Schema & DatabaseManager

**New file:** `apps/desktop/Smithers/DatabaseManager.swift`

Database location: `~/Library/Application Support/Smithers/smithers.db`

```sql
-- Core workspace registry
CREATE TABLE workspaces (
    id TEXT PRIMARY KEY,              -- UUID
    root_path TEXT NOT NULL UNIQUE,   -- absolute path to workspace root
    display_name TEXT NOT NULL,       -- derived from directory name, user-editable
    created_at TEXT NOT NULL,         -- ISO 8601
    last_accessed_at TEXT NOT NULL,   -- ISO 8601
    is_archived INTEGER NOT NULL DEFAULT 0,
    sort_order INTEGER NOT NULL DEFAULT 0,
    metadata_json TEXT                -- extensible JSON blob for future fields
);

-- Session state (replaces UserDefaults sessionStateByRoot)
CREATE TABLE sessions (
    id TEXT PRIMARY KEY,              -- UUID
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    open_items_json TEXT NOT NULL,    -- JSON array of {kind, path, workingDirectory}
    selected_index INTEGER,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

-- Agent status tracking (per-workspace codex instance)
CREATE TABLE agent_status (
    id TEXT PRIMARY KEY,              -- UUID
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    thread_id TEXT,                   -- codex thread ID
    status TEXT NOT NULL DEFAULT 'idle', -- idle | thinking | executing | error
    last_message_preview TEXT,
    last_activity_at TEXT,
    token_usage_json TEXT             -- {input: N, output: N}
);

-- Git-ref checkpoints per agent turn
CREATE TABLE checkpoints (
    id TEXT PRIMARY KEY,              -- UUID
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    turn_id TEXT NOT NULL,            -- codex turn ID
    git_ref TEXT NOT NULL,            -- refs/smithers/checkpoint/<id>
    parent_commit TEXT NOT NULL,      -- commit SHA before the turn
    description TEXT,                 -- auto-generated summary
    diff_summary TEXT,                -- files changed, insertions, deletions
    created_at TEXT NOT NULL
);

-- Per-workspace todo/checklist items
CREATE TABLE todos (
    id TEXT PRIMARY KEY,              -- UUID
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    is_completed INTEGER NOT NULL DEFAULT 0,
    is_blocking_merge INTEGER NOT NULL DEFAULT 0,  -- blocks PR creation
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    completed_at TEXT,
    source TEXT DEFAULT 'user'        -- user | agent
);

-- Workspace lifecycle scripts
CREATE TABLE workspace_scripts (
    id TEXT PRIMARY KEY,              -- UUID
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    name TEXT NOT NULL,               -- setup | run | test | build | archive | custom
    command TEXT NOT NULL,             -- shell command
    working_directory TEXT,           -- relative to workspace root, or absolute
    environment_json TEXT,            -- {"KEY": "value"} extra env vars
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
);

CREATE INDEX idx_sessions_workspace ON sessions(workspace_id);
CREATE INDEX idx_agent_status_workspace ON agent_status(workspace_id);
CREATE INDEX idx_checkpoints_workspace ON checkpoints(workspace_id);
CREATE INDEX idx_checkpoints_turn ON checkpoints(turn_id);
CREATE INDEX idx_todos_workspace ON todos(workspace_id);
CREATE INDEX idx_scripts_workspace ON workspace_scripts(workspace_id);
```

`DatabaseManager` responsibilities:
- Open/create database at app launch
- Run migrations (versioned, forward-only)
- Expose typed read/write methods via GRDB's record types
- Thread-safe via GRDB's `DatabaseQueue` (serialized access)

### 1.3 Refactor WorkspaceState into AppState + WorkspaceContext

This is the largest change. The current `WorkspaceState` conflates global app state with per-workspace state.

**Current structure (WorkspaceState, ~2,780 lines):**

Global concerns mixed with per-workspace concerns:
- **Global**: theme, preferences (font, auto-save, nvim path, option-as-meta), recent files/folders, window management, command palette commands, toast messages
- **Per-workspace**: rootDirectory, fileTree, openFiles, selectedFileURL, editorText, terminalViews, chatMessages, codexService, nvimController, searchQuery/results, diffs, session persistence

**New structure:**

**`AppState.swift`** (new file) — global singleton, owned by `SmithersApp`:
```swift
@MainActor
class AppState: ObservableObject {
    @Published var workspaces: [WorkspaceContext] = []
    @Published var activeWorkspaceId: UUID?
    @Published var mainWorkspace: MainWorkspaceContext?  // Phase 3

    // Global preferences (currently in WorkspaceState lines 194-262)
    @Published var theme: AppTheme
    @Published var isAutoSaveEnabled: Bool
    @Published var autoSaveInterval: TimeInterval
    @Published var editorFontName: String
    @Published var editorFontSize: Double
    @Published var preferredNvimPath: String
    @Published var optionAsMeta: OptionAsMeta

    // Global UI state
    @Published var toastMessage: String?
    @Published var isCommandPalettePresented: Bool = false

    // Recent items (currently in WorkspaceState lines 300-303)
    @Published var recentFileEntries: [FileIndexEntry]
    @Published var recentFolderEntries: [RecentFolderEntry]

    let db: DatabaseManager

    var activeWorkspace: WorkspaceContext? { ... }
    func openWorkspace(at url: URL) -> WorkspaceContext { ... }
    func closeWorkspace(id: UUID) { ... }
    func switchWorkspace(to id: UUID) { ... }
}
```

**`WorkspaceContext.swift`** (new file) — per-workspace, multiple instances:
```swift
@MainActor
class WorkspaceContext: ObservableObject, Identifiable {
    let id: UUID
    let rootDirectory: URL
    @Published var displayName: String

    // File management (from WorkspaceState)
    @Published var fileTree: [FileItem] = []
    @Published var openFiles: [URL] = []
    @Published var selectedFileURL: URL?
    @Published var editorText: String = ""
    @Published var currentLanguage: SupportedLanguage?

    // Terminals (from WorkspaceState)
    @Published var terminalViews: [URL: GhosttyTerminalView] = [:]

    // Chat/Agent (from WorkspaceState)
    @Published var chatMessages: [ChatMessage] = []
    @Published var chatDraft: String = ""
    @Published var isTurnInProgress: Bool = false
    private var codexService: CodexService?

    // Neovim (from WorkspaceState)
    @Published var isNvimModeEnabled: Bool = false
    private var nvimController: NvimController?

    // Search (from WorkspaceState)
    @Published var searchQuery: String = ""
    @Published var searchResults: [SearchResult] = []

    // Diffs (from WorkspaceState)
    @Published var activeDiffPreview: DiffPreview?
    @Published var diffTabs: [URL: DiffTab] = [:]

    // Checkpoints (Phase 4)
    @Published var checkpoints: [Checkpoint] = []

    // Todos (Phase 4)
    @Published var todos: [TodoItem] = []

    // Agent status
    @Published var agentStatus: AgentStatus = .idle
}
```

**Files to modify:**
- `apps/desktop/Smithers/WorkspaceState.swift` — extract into two new files, then delete or keep as thin compatibility shim during migration
- `apps/desktop/Smithers/SmithersApp.swift` — change `@StateObject private var workspace = WorkspaceState()` (line 5) to use `AppState`; update all `workspace` references
- `apps/desktop/Smithers/ContentView.swift` — accept `AppState` + `WorkspaceContext` instead of single `WorkspaceState`; workspace-specific views bind to `activeWorkspace`
- `apps/desktop/Smithers/FileTreeSidebar.swift` — bind to `WorkspaceContext.fileTree` instead of `WorkspaceState.fileTree`
- `apps/desktop/Smithers/ChatView.swift` — bind to `WorkspaceContext.chatMessages` etc.
- `apps/desktop/Smithers/SearchPanelView.swift` — bind to `WorkspaceContext.searchQuery/searchResults`
- `apps/desktop/Smithers/CommandPaletteView.swift` — needs both `AppState` (global commands, workspace switching) and active `WorkspaceContext`
- `apps/desktop/Smithers/GhosttyTerminalView.swift` — no changes needed (already per-instance)
- `apps/desktop/Smithers/NvimController.swift` — no changes needed (already per-instance)
- `apps/desktop/Smithers/CodexService.swift` — no changes needed (already per-instance); each `WorkspaceContext` creates its own
- `apps/desktop/Smithers/ChatHistoryStore.swift` — migrate from JSON files to SQLite (or keep as fallback for migration)
- `apps/desktop/Smithers/CloseGuard.swift` — needs to check all workspaces for unsaved changes
- `apps/desktop/Smithers/PreferencesView.swift` — bind to `AppState` global preferences instead of `WorkspaceState`
- `apps/desktop/Smithers/TmuxKeyHandler.swift` — update to reference `AppState.activeWorkspace`

### 1.4 UserDefaults → SQLite Migration

On first launch after the update:

1. Read `UserDefaults["smithers.lastWorkspacePath"]` and `UserDefaults["smithers.sessionStateByRoot"]`
2. Create workspace rows in SQLite for each known root path
3. Migrate session data to the `sessions` table
4. Migrate `ChatHistoryStore` JSON files to SQLite (or keep JSON files and add workspace_id cross-reference)
5. Clear the old UserDefaults keys (or leave them as fallback)
6. Preferences (font, auto-save, nvim path, option-as-meta) stay in UserDefaults — they're simple key-value pairs and don't benefit from SQLite

**New file:** `apps/desktop/Smithers/Migration.swift` — one-time migration logic

## Phase 2: UI (Workspace Switcher + Agent Dashboard)

### 2.1 Workspace Switcher Dropdown

**New file:** `apps/desktop/Smithers/WorkspaceSwitcherView.swift`

Location: toolbar area, left of the tab bar (or integrated into the existing title bar area).

Appearance:
- Shows current workspace name + agent status indicator dot
- Clicking opens a dropdown listing all open workspaces
- Each row: workspace name, directory path, agent status dot (green=idle, yellow=thinking, red=error)
- "Open Workspace..." button at bottom → folder picker panel
- "Close Workspace" option for non-active workspaces

**Files to modify:**
- `apps/desktop/Smithers/ContentView.swift` — add `WorkspaceSwitcherView` to the toolbar/header area
- `apps/desktop/Smithers/SmithersApp.swift` — update `CommandGroup` entries for workspace management

### 2.2 Agent Dashboard Sidebar Section

**New file:** `apps/desktop/Smithers/AgentDashboardView.swift`

A collapsible section in the sidebar (below file tree or as a separate sidebar tab) showing:
- All workspace agents with real-time status
- Each agent row: workspace name, status (idle/thinking/executing), last message preview, elapsed time
- Click to switch to that workspace
- Right-click context menu: interrupt agent, view full chat, restart agent

**Files to modify:**
- `apps/desktop/Smithers/ContentView.swift` — add dashboard section to sidebar
- `apps/desktop/Smithers/FileTreeSidebar.swift` — may need to coexist with dashboard section

### 2.3 Command Palette Integration

**Files to modify:**
- `apps/desktop/Smithers/CommandPaletteView.swift` — add workspace commands
- `apps/desktop/Smithers/WorkspaceState.swift` (or `AppState.swift`) — register commands in `paletteCommands`

New commands:
- "Switch Workspace: <name>" — for each open workspace
- "Open Workspace..." — triggers folder picker
- "Close Workspace: <name>" — for each open workspace except active
- "Search across workspaces: <query>" — prefix with `@all/` to search all workspace files

Cross-workspace file search with `@workspace/` prefix:
- Typing `@myproject/` in the command palette scopes file search to that workspace
- Typing `@all/` searches across all open workspaces
- Results show workspace name as prefix: `[myproject] src/main.swift`

### 2.4 Cross-Workspace Status Bar

**New file:** `apps/desktop/Smithers/WorkspaceStatusBarView.swift`

A thin bar below the tab bar (or at the bottom of the window) showing:
- All workspace agent statuses as compact pills: `[project-a: idle] [project-b: thinking...] [project-c: executing]`
- Click a pill to switch to that workspace
- Only visible when multiple workspaces are open

**Files to modify:**
- `apps/desktop/Smithers/ContentView.swift` — add status bar to layout

### 2.5 Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| Cmd+Ctrl+Left | Switch to previous workspace |
| Cmd+Ctrl+Right | Switch to next workspace |
| Cmd+Ctrl+1-9 | Jump to workspace by index |
| Cmd+Ctrl+N | Open new workspace |
| Cmd+Ctrl+W | Close current workspace |

**Files to modify:**
- `apps/desktop/Smithers/SmithersApp.swift` — add keyboard shortcuts to `.commands {}` block
- `apps/desktop/Smithers/TmuxKeyHandler.swift` — add workspace shortcuts if using tmux-style prefix

## Phase 3: Main Workspace (Unified Agent)

### 3.1 MainWorkspaceContext

**New file:** `apps/desktop/Smithers/MainWorkspaceContext.swift`

A special workspace context that spans all open workspaces:
- Creates a temporary directory at `~/Library/Application Support/Smithers/main-workspace/`
- Populates it with symlinks to all workspace roots: `main-workspace/project-a -> /Users/x/project-a`
- Its own `CodexService` instance starts with `cwd` set to this symlink directory
- The agent sees all repos as subdirectories and can navigate between them

Symlink management:
- When a workspace is opened → create symlink
- When a workspace is closed → remove symlink
- When the app launches → recreate all symlinks from the workspace registry
- Handle name collisions by appending `-2`, `-3`, etc.

### 3.2 Cross-Workspace Search

**Files to modify:**
- `apps/desktop/Smithers/SearchPanelView.swift` — add "Search All Workspaces" toggle
- `apps/desktop/Smithers/WorkspaceContext.swift` (or new utility) — parallel ripgrep across all workspace roots

Implementation:
- When "Search All Workspaces" is toggled on, spawn parallel `rg` processes (one per workspace root)
- Merge and deduplicate results
- Results show workspace name prefix in display path
- Clicking a result switches to that workspace and opens the file

### 3.3 Inter-Workspace Agent Messaging

The main workspace agent can coordinate work across projects. Implementation:
- `AppState` acts as message bus between workspace agents
- Main agent can instruct a workspace-specific agent: "In project-a, run the tests"
- Workspace agents report results back through `AppState`
- Chat messages from cross-workspace operations show the source workspace badge

**Files to modify:**
- `apps/desktop/Smithers/AppState.swift` — add message routing
- `apps/desktop/Smithers/CodexService.swift` — may need to expose inter-agent messaging hooks

### 3.4 Cross-Workspace File Navigation

When the chat shows a file path like `project-a/src/main.swift`:
- `LinkifiedText.swift` already detects file paths
- Extend it to recognize cross-workspace paths (paths starting with a workspace name)
- Clicking navigates: switch workspace → open file → scroll to line

**Files to modify:**
- `apps/desktop/Smithers/LinkifiedText.swift` — add cross-workspace path resolution

## Phase 4: Conductor Parity Features

### 4.1 Checkpoints (Git-Ref Snapshots)

Every time a codex agent completes a turn that modifies files:
1. Stage all changes and create a commit: `git commit -m "smithers: checkpoint <turn_id>"`
2. Create a ref: `git update-ref refs/smithers/checkpoint/<checkpoint_id> HEAD`
3. Store checkpoint metadata in SQLite `checkpoints` table
4. Show in timeline UI

**New files:**
- `apps/desktop/Smithers/CheckpointManager.swift` — git operations for creating/reverting checkpoints
- `apps/desktop/Smithers/CheckpointTimelineView.swift` — visual timeline of checkpoints per workspace

**Revert flow:**
- User clicks "Revert to this checkpoint" in timeline
- `git checkout <ref> -- .` to restore files
- Or `git reset --hard <ref>` if user confirms full revert
- Show diff preview before reverting

**Files to modify:**
- `apps/desktop/Smithers/WorkspaceContext.swift` — hook into codex turn completion to create checkpoints
- `apps/desktop/Smithers/ChatView.swift` — show checkpoint markers in chat timeline
- `apps/desktop/Smithers/ContentView.swift` — add checkpoint timeline panel

### 4.2 Todos / Merge Gating

Per-workspace checklist that can optionally block PR creation.

**New files:**
- `apps/desktop/Smithers/TodoListView.swift` — sidebar section or panel showing workspace todos
- `apps/desktop/Smithers/TodoItem.swift` — data model (backed by SQLite `todos` table)

Features:
- Add/edit/delete/reorder todos
- Mark as completed (checkbox)
- Mark as "blocks merge" (toggle) — if any blocking todos are incomplete, PR creation button is disabled
- Agent can add todos via tool use (e.g., "TODO: write tests for auth module")
- Todos persist across sessions via SQLite

**Files to modify:**
- `apps/desktop/Smithers/ContentView.swift` — add todo list to sidebar
- `apps/desktop/Smithers/WorkspaceContext.swift` — expose todo management methods

### 4.3 Workspace Scripts

Configurable lifecycle scripts per workspace.

**New files:**
- `apps/desktop/Smithers/ScriptRunner.swift` — execute scripts, capture output, stream to terminal
- `apps/desktop/Smithers/ScriptsView.swift` — UI for managing scripts
- `.smithers/scripts.json` schema (per-project, shareable via VCS):

```json
{
  "scripts": [
    {"name": "setup", "command": "npm install", "cwd": "."},
    {"name": "run", "command": "npm start", "cwd": "."},
    {"name": "test", "command": "npm test", "cwd": "."},
    {"name": "build", "command": "npm run build", "cwd": "."},
    {"name": "lint", "command": "npm run lint", "cwd": "."}
  ]
}
```

Script sources (merged, project takes precedence):
1. `.smithers/scripts.json` in workspace root (project-level, committed to VCS)
2. SQLite `workspace_scripts` table (user-level overrides)

Execution:
- Scripts run in a Ghostty terminal tab within the workspace
- Output captured and accessible to the agent
- Script status shown in dashboard (running/completed/failed)

**Files to modify:**
- `apps/desktop/Smithers/WorkspaceContext.swift` — load scripts from both sources
- `apps/desktop/Smithers/ContentView.swift` — add scripts panel/section

### 4.4 GitHub Integration

PR creation, CI monitoring, and agent-assisted fixes via the `gh` CLI.

**New files:**
- `apps/desktop/Smithers/GitHubService.swift` — wrapper around `gh` CLI commands
- `apps/desktop/Smithers/GitHubPanelView.swift` — PR status, CI checks, review comments

Features:
- **PR creation**: one-click from workspace, respects todo merge gating
  - `gh pr create --title "..." --body "..."`
  - Auto-generates PR description from agent chat + checkpoint history
  - Blocked if any "blocks merge" todos are incomplete
- **CI monitoring**: poll `gh pr checks` for status updates
  - Show pass/fail badges in workspace dashboard
  - Notify when CI fails
- **Agent-assisted fixes**: when CI fails, offer to send the failure log to the workspace agent
  - "CI failed on lint check. Fix?" → agent reads error, makes changes, creates new checkpoint
- **Review comments**: `gh pr view --comments` rendered in panel
  - Agent can respond to review comments with code changes

**Files to modify:**
- `apps/desktop/Smithers/WorkspaceContext.swift` — GitHub state per workspace
- `apps/desktop/Smithers/ContentView.swift` — add GitHub panel

### 4.5 Workspace Archiving

Archive a workspace to remove it from the active list while preserving all state.

Implementation:
- Set `is_archived = 1` in SQLite `workspaces` table
- Stop the workspace's CodexService, terminals, and neovim
- Remove from active workspace list
- Remove symlink from main workspace directory
- Archived workspaces accessible from "Open Workspace" → "Archived" tab
- Restore: flip `is_archived = 0`, recreate symlink, optionally restore session

**Files to modify:**
- `apps/desktop/Smithers/AppState.swift` — archive/restore methods
- `apps/desktop/Smithers/WorkspaceSwitcherView.swift` — show archived workspaces section

## Migration Strategy

The refactor is large. Recommended implementation order within each phase:

### Phase 1 (Foundation):
1. Add GRDB dependency (1.1) — purely additive
2. Create `DatabaseManager` with schema (1.2) — no existing code changes
3. Create `AppState` shell with `WorkspaceContext` shell (1.3) — initially wrapping existing `WorkspaceState` methods via delegation
4. Gradually move state from `WorkspaceState` → `AppState`/`WorkspaceContext`
5. Update views one at a time to accept new types
6. Add migration logic (1.4) and remove old UserDefaults usage
7. Delete `WorkspaceState` once fully extracted

### Phase 2 (UI):
1. Workspace switcher dropdown (2.1) — most impactful, enables testing multi-workspace
2. Keyboard shortcuts (2.5) — quick to add, immediately useful
3. Command palette updates (2.3)
4. Status bar (2.4)
5. Agent dashboard (2.2) — most complex UI piece

### Phase 3 (Main Workspace):
1. Symlink directory management (3.1)
2. Cross-workspace search (3.2)
3. File navigation (3.4)
4. Agent messaging (3.3) — most complex, requires protocol design

### Phase 4 (Conductor Parity):
1. Checkpoints (4.1) — high value, relatively contained
2. Todos (4.2) — simple model, quick UI
3. Scripts (4.3) — leverages existing terminal infrastructure
4. GitHub integration (4.4) — largest piece, can be incremental
5. Archiving (4.5) — simple once the data model exists

## New Files Summary

| File | Phase | Purpose |
|------|-------|---------|
| `DatabaseManager.swift` | 1 | SQLite setup, migrations, typed queries |
| `AppState.swift` | 1 | Global singleton: workspaces, preferences, routing |
| `WorkspaceContext.swift` | 1 | Per-workspace state: files, editor, chat, agent |
| `Migration.swift` | 1 | One-time UserDefaults/JSON → SQLite migration |
| `WorkspaceSwitcherView.swift` | 2 | Toolbar dropdown for workspace switching |
| `AgentDashboardView.swift` | 2 | Sidebar panel showing all workspace agents |
| `WorkspaceStatusBarView.swift` | 2 | Compact status bar for multi-workspace |
| `MainWorkspaceContext.swift` | 3 | Unified agent spanning all workspaces |
| `CheckpointManager.swift` | 4 | Git-ref checkpoint creation/revert |
| `CheckpointTimelineView.swift` | 4 | Visual timeline of checkpoints |
| `TodoListView.swift` | 4 | Per-workspace todo checklist |
| `TodoItem.swift` | 4 | Todo data model |
| `ScriptRunner.swift` | 4 | Script execution engine |
| `ScriptsView.swift` | 4 | Script management UI |
| `GitHubService.swift` | 4 | `gh` CLI wrapper |
| `GitHubPanelView.swift` | 4 | PR/CI/review UI |

## Modified Files Summary

| File | Phases | Changes |
|------|--------|---------|
| `Package.swift` | 1 | Add GRDB.swift dependency |
| `project.yml` | 1 | Add GRDB.swift dependency |
| `WorkspaceState.swift` | 1 | Extract into AppState + WorkspaceContext, eventually delete |
| `SmithersApp.swift` | 1, 2 | Use AppState, add workspace keyboard shortcuts + menu items |
| `ContentView.swift` | 1, 2, 4 | Accept AppState, add switcher/dashboard/status bar/panels |
| `FileTreeSidebar.swift` | 1 | Bind to WorkspaceContext |
| `ChatView.swift` | 1, 4 | Bind to WorkspaceContext, checkpoint markers |
| `SearchPanelView.swift` | 1, 3 | Bind to WorkspaceContext, cross-workspace toggle |
| `CommandPaletteView.swift` | 1, 2 | Accept AppState, workspace commands, @workspace/ prefix |
| `ChatHistoryStore.swift` | 1 | Migrate to SQLite or add workspace_id reference |
| `CloseGuard.swift` | 1 | Check all workspaces for unsaved changes |
| `PreferencesView.swift` | 1 | Bind to AppState preferences |
| `TmuxKeyHandler.swift` | 1, 2 | Reference AppState, workspace shortcuts |
| `LinkifiedText.swift` | 3 | Cross-workspace path resolution |

## Open Questions

1. **Checkpoint storage**: Should checkpoints use actual git refs (persistent, survives gc) or stash-like entries? Git refs are more robust but pollute the ref namespace.
2. **Main workspace agent model**: Should the main workspace agent be always-on (running even when no user query), or only started when explicitly invoked?
3. **Script output routing**: Should script output go to a dedicated terminal tab, or to the chat view, or both?
4. **GitHub auth**: Should we require `gh auth status` on first use, or bundle our own OAuth flow?
5. **Workspace limit**: Should there be a practical limit on simultaneous workspaces (e.g., 10) to bound memory usage from multiple CodexService/NvimController instances?
6. **Chat history migration**: Move existing `ChatHistoryStore` JSON files into SQLite, or keep them as-is and only use SQLite for new metadata?

## Priority

Phase 1 is prerequisite for everything else and should be done first. Within Phase 1, the data model refactor (1.3) is the critical path — it unblocks all subsequent phases. Phase 2 (UI) and Phase 4 features (checkpoints, todos) can be developed in parallel once the foundation is in place. Phase 3 (main workspace) depends on Phase 2 being functional.

# Miniapps: Local-First Web Apps with Smithers SDK Access

## Summary

Allow anyone — users or their agents — to create miniapps: local-first web apps (HTML/CSS/JS, all assets stored on disk) that run inside Smithers via WKWebView and have access to the Smithers SDK over a JavaScript bridge. The Smithers SDK exposes the same capabilities the CLI agent uses to interact with the editor — file operations, terminal access, search, tab management, etc. Miniapps are automatically discoverable from the command palette, can be triggered by the main agent (via tool call), but cannot talk back to the main agent.

## Context

Smithers has a rich internal API surface (WorkspaceState methods, CodexService events) that currently only the Codex agent can access via JSON-RPC over stdio. Miniapps open this up to anyone who can write a web page. A miniapp is just a directory with an `index.html` and a manifest — no build step, no server, no bundler required. The Smithers SDK is injected as `window.smithers` and provides async methods that map to the same operations the agent CLI performs.

This creates a plugin ecosystem without the complexity of native Swift plugins:
- **Users** can build custom tools (git visualizers, database browsers, deployment dashboards, test runners)
- **Agents** can scaffold miniapps on the fly as part of a task ("here's a custom diff viewer for this migration")
- **The main agent** can invoke miniapps as tools ("open the database browser and show me the users table")

### Why Local-First Web

- **Zero infrastructure**: No server, no bundling, no npm install. Just files on disk.
- **Universal skill**: HTML/CSS/JS is the most widely known stack. Agents are excellent at generating it.
- **Sandboxed**: WKWebView runs in a sandboxed process. Miniapps can only reach Smithers through the explicit SDK bridge.
- **Portable**: A miniapp directory can be shared, committed to a repo, or published as a skill.

### Why Miniapps Can't Talk to the Main Agent

Miniapps are tools, not peers. They can read/write files, open terminals, and manipulate the editor — but they cannot inject messages into the agent conversation or influence the agent's context. This keeps the agent's context clean and prevents miniapps from becoming attack vectors for prompt injection. The agent can *invoke* a miniapp (open it, pass it parameters), but communication is one-directional.

---

## Feature Breakdown

### 1. Miniapp Structure

A miniapp is a directory containing a manifest and web assets:

```
.smithers/miniapps/my-app/
├── miniapp.json          # Required — manifest
├── index.html            # Required — entry point
├── style.css             # Optional
├── app.js                # Optional
├── assets/               # Optional — images, fonts, etc.
│   └── icon.png
└── lib/                  # Optional — vendored libraries
    └── preact.min.js
```

**miniapp.json:**
```json
{
  "id": "my-app",
  "name": "My App",
  "description": "A custom tool for doing something useful",
  "icon": "assets/icon.png",
  "version": "1.0.0",
  "permissions": [
    "files.read",
    "files.write",
    "terminal.open",
    "editor.read",
    "search"
  ],
  "trigger": {
    "command": "Open My App",
    "shortcut": null
  },
  "display": "tab",
  "size": {
    "width": 800,
    "height": 600
  }
}
```

### 2. Discovery Locations

Miniapps are discovered from multiple scopes (checked in order):

| Scope | Path | Use Case |
|-------|------|----------|
| Workspace | `.smithers/miniapps/` | Project-specific tools |
| User | `~/.smithers/miniapps/` | Personal tools across projects |
| Built-in | Bundled in Smithers.app | Default miniapps shipped with Smithers |

On workspace open, Smithers scans these directories, parses each `miniapp.json`, and registers them.

### 3. Smithers SDK (JavaScript Bridge)

The SDK is injected into every miniapp's WKWebView as `window.smithers`. All methods return Promises. The SDK surface mirrors the capabilities available to the CLI agent.

```typescript
interface Smithers {
  // ── File Operations ──
  files: {
    read(path: string): Promise<string>;
    write(path: string, content: string): Promise<void>;
    exists(path: string): Promise<boolean>;
    list(path: string, options?: { recursive?: boolean, glob?: string }): Promise<FileEntry[]>;
    search(pattern: string, options?: { path?: string, glob?: string }): Promise<SearchResult[]>;
    stat(path: string): Promise<FileStat>;
    delete(path: string): Promise<void>;
    rename(oldPath: string, newPath: string): Promise<void>;
    mkdir(path: string): Promise<void>;
  };

  // ── Editor ──
  editor: {
    getOpenFiles(): Promise<string[]>;
    getActiveFile(): Promise<string | null>;
    getSelection(): Promise<Selection | null>;
    getText(path?: string): Promise<string>;
    openFile(path: string, options?: { line?: number, column?: number }): Promise<void>;
    // Note: no setText — miniapps open files but don't silently modify editor content
  };

  // ── Terminal ──
  terminal: {
    run(command: string, options?: { cwd?: string }): Promise<CommandResult>;
    open(options?: { cwd?: string }): Promise<void>;
  };

  // ── Workspace ──
  workspace: {
    getRootDirectory(): Promise<string>;
    getGitBranch(): Promise<string | null>;
    showToast(message: string): Promise<void>;
  };

  // ── UI ──
  ui: {
    getTheme(): Promise<Theme>;
    onThemeChange(callback: (theme: Theme) => void): void;
    close(): Promise<void>;  // Close the miniapp tab/modal
    setTitle(title: string): Promise<void>;
  };

  // ── Invocation Context ──
  context: {
    getParams(): Promise<Record<string, string>>;  // Parameters passed when invoked
  };
}

interface FileEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  size: number;
  modified: string;
}

interface SearchResult {
  path: string;
  line: number;
  column: number;
  text: string;
}

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface Theme {
  background: string;       // hex color
  foreground: string;
  mutedForeground: string;
  panelBackground: string;
  accent: string;
  isLight: boolean;
  // ... all AppTheme colors as hex strings
}

interface Selection {
  start: { line: number; column: number };
  end: { line: number; column: number };
  text: string;
}
```

### 4. WKWebView Integration

Each miniapp runs in a WKWebView tab with the SDK bridge injected via `WKUserScript` and `WKScriptMessageHandler`.

**MiniappWebView.swift** (NSViewRepresentable):

```swift
class MiniappWebView: NSViewRepresentable {
    let miniapp: MiniappManifest
    let workspace: WorkspaceState

    func makeNSView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()

        // Inject SDK bridge script
        let sdkScript = WKUserScript(
            source: smithersSDKJavaScript,
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        )
        config.userContentController.addUserScript(sdkScript)

        // Register message handlers for SDK calls
        let handler = MiniappMessageHandler(workspace: workspace, miniapp: miniapp)
        config.userContentController.add(handler, name: "smithers")

        // Allow local file access
        let webView = WKWebView(frame: .zero, configuration: config)
        let fileURL = miniapp.directory.appendingPathComponent("index.html")
        webView.loadFileURL(fileURL, allowingReadAccessTo: miniapp.directory)

        return webView
    }
}
```

**Message handler** processes SDK calls from JavaScript:

```swift
class MiniappMessageHandler: NSObject, WKScriptMessageHandler {
    func userContentController(_ controller: WKUserContentController,
                               didReceive message: WKScriptMessage) {
        // message.body is JSON: { "id": "req-1", "method": "files.read", "params": { "path": "/foo" } }
        // Dispatch to WorkspaceState methods
        // Send response back via webView.evaluateJavaScript("window.__smithers_resolve('req-1', ...)")
    }
}
```

**Security constraints:**
- WKWebView has no network access (`WKWebViewConfiguration` with no URL scheme handlers for http/https) — local files only
- File operations are sandboxed to the workspace root directory
- Each permission in `miniapp.json` must be granted; unauthorized calls return errors
- No access to `smithers-chat://` or agent conversation

### 5. Display Modes

Miniapps can render in three display modes (set in `miniapp.json`):

| Mode | Description | Use Case |
|------|-------------|----------|
| `tab` | Opens as a full tab in the editor area | Database browsers, dashboards, complex tools |
| `panel` | Slides in as a right-side panel | Reference viewers, status monitors |
| `modal` | Centered overlay (like command palette) | Quick actions, forms, pickers |

**Tab mode** uses the existing tab system:
```swift
static let miniappScheme = "smithers-miniapp"
// URL: smithers-miniapp://my-app?param1=value1
```

**Panel mode** renders alongside the editor detail:
```
┌──────────┬──────────────────────────┬──────────────────┐
│  Files   │       Editor             │   Miniapp Panel  │
│          │                          │   (WKWebView)    │
│          │                          │                  │
└──────────┴──────────────────────────┴──────────────────┘
```

**Modal mode** renders as a centered overlay:
```
┌────────────────────────────────────────────────────────┐
│                                                        │
│          ┌────────────────────────────┐                 │
│          │      Miniapp Modal         │                 │
│          │      (WKWebView)           │                 │
│          │                            │                 │
│          └────────────────────────────┘                 │
│                                                        │
└────────────────────────────────────────────────────────┘
```

### 6. Command Palette Integration

Every registered miniapp automatically gets a command palette entry:

```
> Open My App
> Open Database Browser
> Open Test Runner
```

Added to `buildCommandList()` in WorkspaceState by iterating registered miniapps:

```swift
for miniapp in registeredMiniapps {
    commands.append(PaletteCommand(
        id: "miniapp-\(miniapp.id)",
        title: miniapp.trigger.command,
        icon: "puzzlepiece",
        action: { [weak self] in self?.openMiniapp(miniapp) }
    ))
}
```

If a miniapp specifies a keyboard shortcut in its manifest, it's also registered as a global shortcut.

### 7. Agent Invocation

The main agent can open miniapps via a tool call but cannot receive data back from them. This is a fire-and-forget invocation.

**Codex tool registration** — Smithers advertises a `miniapp/open` tool to the agent:

When the agent wants to open a miniapp, it emits a command like:
```bash
smithers miniapp open my-app --param key=value
```

Or via a dedicated RPC method that Smithers handles:

```swift
// Incoming from Codex: { "method": "miniapp/open", "params": { "id": "my-app", "params": { "key": "value" } } }
case "miniapp/open":
    let id = params["id"] as! String
    let miniappParams = params["params"] as? [String: String] ?? [:]
    openMiniapp(id: id, params: miniappParams)
```

The miniapp reads its invocation parameters via `smithers.context.getParams()`.

**What the agent CAN do:**
- Open a miniapp with parameters: "Open the database browser showing the users table"
- The agent knows which miniapps are available (they're listed in its tools)

**What the agent CANNOT do:**
- Read output from the miniapp
- Receive callbacks or events from the miniapp
- Inject the miniapp into its conversation context

### 8. Agent-Created Miniapps

An agent can create a miniapp as part of a task by writing the files to `.smithers/miniapps/<name>/`. Smithers watches the miniapp directories (FSEvents) and auto-registers new miniapps.

**Example agent flow:**
```
User: "Build me a tool to visualize the git commit graph"

Agent:
1. mkdir .smithers/miniapps/git-graph/
2. Write miniapp.json with name, permissions, display mode
3. Write index.html with a commit graph visualization
4. Write app.js that uses smithers.terminal.run("git log --graph --oneline")
   to fetch commit data and renders it
5. "I've created a miniapp called 'Git Graph'. You can open it
   from the command palette (Cmd+P > Open Git Graph)."
```

The miniapp appears in the palette immediately after the files are written (no restart needed).

### 9. Theme Integration

Miniapps should look native. The SDK provides theme colors and a change listener:

```javascript
// On load, apply Smithers theme
const theme = await smithers.ui.getTheme();
document.documentElement.style.setProperty('--bg', theme.background);
document.documentElement.style.setProperty('--fg', theme.foreground);
document.documentElement.style.setProperty('--muted', theme.mutedForeground);
document.documentElement.style.setProperty('--accent', theme.accent);

// React to theme changes (e.g., nvim colorscheme switch)
smithers.ui.onThemeChange((theme) => {
  document.documentElement.style.setProperty('--bg', theme.background);
  // ...
});
```

Smithers could also ship a default CSS file (`smithers-theme.css`) that miniapps can optionally include for instant native-looking styling:
```html
<link rel="stylesheet" href="smithers://theme.css">
```

### 10. Miniapp Lifecycle

```
Scan directories on workspace open
        │
        ▼
Parse miniapp.json for each directory
        │
        ▼
Register in WorkspaceState.registeredMiniapps
        │
        ▼
Add entries to command palette
        │
        ▼
User opens (palette / shortcut / agent invocation)
        │
        ▼
Create WKWebView, inject SDK bridge, load index.html
        │
        ▼
Miniapp calls smithers.* methods → MiniappMessageHandler
        │                                    │
        ▼                                    ▼
SDK calls dispatched to              Response sent back
WorkspaceState methods               via JS callback
        │
        ▼
User closes tab/panel/modal
        │
        ▼
WKWebView deallocated, resources freed
```

---

## Implementation Phases

### Phase 1: Core Runtime

1. **`MiniappManifest.swift`** — Parse `miniapp.json`, validate required fields, resolve paths
2. **`MiniappScanner.swift`** — Scan `.smithers/miniapps/` and `~/.smithers/miniapps/` directories, watch with FSEvents for live registration
3. **`MiniappWebView.swift`** — NSViewRepresentable wrapping WKWebView with SDK injection
4. **`MiniappMessageHandler.swift`** — WKScriptMessageHandler dispatching SDK calls to WorkspaceState
5. **SDK JavaScript** — `smithers-sdk.js` injected at document start, implements `window.smithers` with Promise-based message passing

### Phase 2: Integration

6. **Tab routing** — Add `miniappScheme` URL type, render `MiniappWebView` in ContentView tab router
7. **Command palette** — Register miniapps in `buildCommandList()`, add "Open <name>" entries
8. **WorkspaceState additions**:
   - `registeredMiniapps: [MiniappManifest]`
   - `openMiniapp(id:params:)`
   - `miniappViews: [URL: WKWebView]` (like `terminalViews`)
9. **Permission enforcement** — Check `miniapp.json` permissions before executing SDK calls

### Phase 3: Agent Integration

10. **Agent tool** — Register `miniapp/open` as a tool the Codex agent can call, list available miniapps in tool description
11. **FSEvents watcher** — Auto-register miniapps when the agent writes new ones to disk
12. **Agent scaffolding prompt** — Add system context so the agent knows the miniapp structure and SDK API when asked to create one

### Phase 4: Polish

13. **Panel and modal display modes** — Beyond tab, support side panel and modal overlay rendering
14. **Theme CSS** — Ship `smithers-theme.css` via custom URL scheme handler for native styling
15. **Miniapp management** — Command palette entries for "Manage Miniapps" (list, delete, reload)
16. **Error handling** — Surface JS errors from miniapps as toasts, handle crashed WKWebView processes

---

## Data Models

```swift
struct MiniappManifest: Identifiable, Codable {
    let id: String
    let name: String
    let description: String
    let icon: String?
    let version: String?
    let permissions: [MiniappPermission]
    let trigger: MiniappTrigger
    let display: MiniappDisplayMode
    let size: MiniappSize?

    // Resolved at scan time, not in JSON
    var directory: URL!
}

enum MiniappPermission: String, Codable {
    case filesRead = "files.read"
    case filesWrite = "files.write"
    case terminalOpen = "terminal.open"
    case terminalRun = "terminal.run"
    case editorRead = "editor.read"
    case search = "search"
    case workspace = "workspace"
}

struct MiniappTrigger: Codable {
    let command: String        // Command palette label
    let shortcut: String?      // Optional keyboard shortcut
}

enum MiniappDisplayMode: String, Codable {
    case tab
    case panel
    case modal
}

struct MiniappSize: Codable {
    let width: Int?
    let height: Int?
}
```

---

## Example Miniapps

### Git Commit Graph
```json
{
  "id": "git-graph",
  "name": "Git Graph",
  "description": "Visualize git commit history as an interactive graph",
  "permissions": ["terminal.run"],
  "trigger": { "command": "Open Git Graph" },
  "display": "tab"
}
```
```html
<!-- index.html -->
<canvas id="graph"></canvas>
<script>
  async function load() {
    const result = await smithers.terminal.run(
      'git log --all --oneline --graph --decorate --format="%H|%s|%an|%ar|%D"'
    );
    renderGraph(result.stdout);
  }
  load();
</script>
```

### Database Browser
```json
{
  "id": "db-browser",
  "name": "Database Browser",
  "description": "Browse and query local SQLite databases",
  "permissions": ["files.read", "terminal.run"],
  "trigger": { "command": "Open Database Browser" },
  "display": "tab"
}
```

### Quick Note
```json
{
  "id": "quick-note",
  "name": "Quick Note",
  "description": "Jot down a quick note saved to .smithers/notes/",
  "permissions": ["files.read", "files.write"],
  "trigger": { "command": "Quick Note", "shortcut": "Cmd+Shift+J" },
  "display": "modal",
  "size": { "width": 400, "height": 300 }
}
```

---

## Open Questions

1. **Network access**: Should miniapps be fully offline (no fetch/XHR), or should they be allowed to make network requests? Restricting network keeps them truly local-first and sandboxed, but some tools (API explorers, webhook testers) would need it.
2. **Persistent storage**: Should miniapps get localStorage / IndexedDB, or should all persistence go through `smithers.files.*`? WKWebView's default storage is ephemeral per-process.
3. **Inter-miniapp communication**: Should one miniapp be able to invoke another, or are they fully isolated from each other?
4. **NPM/bundled miniapps**: Should Smithers support a `package.json` + build step for miniapps that want to use React/Preact/etc, or keep it strictly no-build? Could offer both: raw HTML for simple tools, and a `build` field in manifest for compiled apps.
5. **SDK versioning**: When the SDK surface changes, how do miniapps declare compatibility? Semver in `miniapp.json`?
6. **File access scope**: Should `files.*` operations be restricted to the workspace root, or can miniapps access any path the user can? Workspace-only is safer but limits utility.
7. **Max concurrent miniapps**: Should there be a limit on open WKWebView instances for memory reasons?

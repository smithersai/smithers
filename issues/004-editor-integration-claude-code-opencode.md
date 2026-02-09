# Editor Integration: Claude Code & OpenCode

## Summary

Research and design how Smithers can serve as a first-class editor frontend for **Claude Code** and **OpenCode**, the same way VS Code and Neovim do today. Smithers already uses Codex as its default agent (via `codex-app-server` over JSON-RPC/stdio), so Codex integration is not in scope. The goal is to let users run `claude` or `opencode` and have Smithers act as their IDE — providing file navigation, diff review, selection context, diagnostics, and terminal access.

## Context

### Current State

Smithers talks to **Codex** via `CodexService.swift` → `JSONRPCTransport.swift` (JSON-RPC 2.0 over stdio to `codex-app-server`). This is a client-driven model: Smithers launches the backend, sends `initialize`, `thread/start`, `turn/start`, and processes notifications (`item/agentMessage/delta`, `item/completed`, etc.). Smithers auto-approves all file changes and command executions.

### What's Different About Claude Code & OpenCode

Both Claude Code and OpenCode flip the relationship — the **CLI is the agent** and the **editor is the tool provider**. The editor exposes capabilities (open file, show diff, get selection, run terminal) that the agent calls when it needs them.

| | Codex (current) | Claude Code | OpenCode |
|-|------------------|-------------|----------|
| Who launches whom | Smithers launches `codex-app-server` | User launches `claude` CLI; it discovers Smithers | User launches `opencode acp`; Smithers launches it as subprocess |
| Transport | JSON-RPC over stdio | WebSocket on localhost | JSON-RPC over stdio |
| Protocol | Codex v1 RPC | MCP (Model Context Protocol) | ACP (Agent Client Protocol) |
| Editor role | Client (sends requests) | Server (exposes tools) | Server (handles agent requests) |
| Diff review | Auto-approve | Blocking `openDiff` tool — user accepts/rejects | `fs/write_text_file` with permission model |

---

## Claude Code Integration

### Protocol: WebSocket MCP

Claude Code uses a **WebSocket-based MCP protocol**. The editor runs a WebSocket server on localhost; the `claude` CLI connects as a client. Communication is JSON-RPC 2.0.

**Reference implementations:**
- [coder/claudecode.nvim](https://github.com/coder/claudecode.nvim) — Neovim, full parity, includes `PROTOCOL.md`
- [manzaltu/claude-code-ide.el](https://github.com/manzaltu/claude-code-ide.el) — Emacs
- [Eclipse Theia](https://github.com/eclipse-theia/theia) — Open-source IDE with native support

### Connection Lifecycle

```
1. Smithers starts WebSocket server on a random localhost port
2. Smithers writes lock file: ~/.claude/ide/<port>.lock
3. User launches `claude` in a terminal (or Smithers spawns it)
4. Claude CLI reads lock file, connects via WebSocket
5. Auth handshake: x-claude-code-ide-authorization header
6. Claude sends `initialize` → Smithers responds with capabilities
7. Claude calls `tools/list` → Smithers returns available tools
8. During operation: Claude calls `tools/call` with specific tool names
9. Smithers sends `selection_changed` notifications as user navigates
10. Ping/pong keepalive every 30 seconds
```

### Lock File

Path: `~/.claude/ide/<port>.lock`

```json
{
  "pid": 12345,
  "workspaceFolders": ["/Users/williamcory/myproject"],
  "ideName": "Smithers",
  "transport": "ws",
  "authToken": "550e8400-e29b-41d4-a716-446655440000"
}
```

### Environment Variables (if Smithers launches Claude)

| Variable | Value |
|----------|-------|
| `CLAUDE_CODE_SSE_PORT` | WebSocket server port |
| `ENABLE_IDE_INTEGRATION` | `"true"` |
| `CLAUDE_IDE_AUTH_TOKEN` | UUID v4 auth token |

### Tools to Implement

These are the MCP tools Smithers must expose as the WebSocket server:

| Tool | Parameters | Behavior | Blocking? |
|------|-----------|----------|-----------|
| `openFile` | `filePath`, `preview?`, `startText?`, `endText?`, `selectToEndOfLine?`, `makeFrontmost?` | Open file in editor, optionally scroll to text range | No |
| `openDiff` | `old_file_path`, `new_file_path`, `new_file_contents`, `tab_name` | Show side-by-side diff; wait for user accept/reject | **Yes** — respond `"FILE_SAVED"` or `"DIFF_REJECTED"` |
| `getCurrentSelection` | — | Return selected text, file path, selection range | No |
| `getLatestSelection` | — | Return most recent selection | No |
| `getOpenEditors` | — | List open tabs with URI, active state, language, dirty flag | No |
| `getWorkspaceFolders` | — | Return workspace folders and root path | No |
| `getDiagnostics` | `uri?` | Return LSP diagnostics for file or all files | No |
| `checkDocumentDirty` | `filePath` | Check if file has unsaved changes | No |
| `saveDocument` | `filePath` | Save file to disk | No |
| `closeAllDiffTabs` | — | Close all diff viewer tabs | No |
| `close_tab` | — | Close a specific tab | No |

### Notifications to Send (Smithers → Claude)

| Notification | When | Payload |
|-------------|------|---------|
| `selection_changed` | User selects text or moves cursor | `text`, `filePath`, `fileUrl`, `selection` (start/end line/char), `isEmpty` |
| `at_mentioned` | User @-mentions a file in chat | `filePath`, `lineStart`, `lineEnd` |

### The `openDiff` Pattern

This is the most important tool. When Claude wants to edit a file:

1. Claude calls `openDiff` with old content, new content, and a tab name
2. Smithers opens the DiffViewer (already exists!) showing the proposed changes
3. The user reviews and clicks Accept or Reject
4. **Only then** does Smithers send the response: `"FILE_SAVED"` or `"DIFF_REJECTED"`
5. Claude blocks until it gets this response, then proceeds accordingly

This replaces the current auto-approve behavior and gives users control over every file change.

### Implementation Components

#### `ClaudeCodeBridge.swift` — WebSocket MCP Server

```swift
@MainActor
final class ClaudeCodeBridge: ObservableObject {
    @Published var isConnected = false
    @Published var connectedAgent: String?  // "claude" when connected

    private var server: NWListener?         // Network.framework WebSocket
    private var connection: NWConnection?
    private var authToken: String
    private var port: UInt16

    func start(workspaceFolders: [URL]) throws
    func stop()

    // Lock file management
    private func writeLockFile() throws
    private func removeLockFile()

    // Tool handlers
    private func handleToolCall(id: RPCID, name: String, arguments: JSONValue)
    private func handleOpenFile(_ args: OpenFileArgs) -> String
    private func handleOpenDiff(_ id: RPCID, _ args: OpenDiffArgs)  // Deferred response
    private func handleGetCurrentSelection() -> SelectionInfo
    private func handleGetOpenEditors() -> [EditorInfo]
    private func handleGetWorkspaceFolders() -> WorkspaceFoldersInfo
    private func handleGetDiagnostics(_ uri: String?) -> [DiagnosticInfo]

    // Notifications
    func notifySelectionChanged(_ selection: SelectionInfo)
    func notifyAtMention(filePath: String, lineStart: Int, lineEnd: Int)
}
```

#### Integration with Existing Components

| Smithers Component | Claude Code Tool | How It Maps |
|-------------------|-----------------|-------------|
| `WorkspaceState.selectedFileURL` + file tree | `openFile` | Navigate to file in sidebar, open in editor |
| `DiffViewer` (existing) | `openDiff` | Show diff sheet, wait for accept/reject |
| STTextView selection | `getCurrentSelection` | Read selection range from text view |
| Tab system (from issue 002 skill tabs) | `getOpenEditors` | Enumerate open editor tabs |
| `WorkspaceState.rootDirectory` | `getWorkspaceFolders` | Return workspace root |
| Future LSP integration | `getDiagnostics` | Forward LSP diagnostics |
| `WorkspaceState.saveCurrentFile()` | `saveDocument` | Trigger file save |

---

## OpenCode Integration

### Protocol: ACP (Agent Client Protocol)

OpenCode uses the **Agent Client Protocol** — an open standard designed as "LSP for AI coding agents." Communication is JSON-RPC 2.0 over stdio (Smithers launches `opencode acp` as a subprocess, similar to how it launches `codex-app-server` today).

**Spec:** [agentclientprotocol.com](https://agentclientprotocol.com/)
**SDKs:** TypeScript (`@agentclientprotocol/sdk`), Rust (`agent-client-protocol`), Python, Kotlin
**OpenCode ACP docs:** [opencode.ai/docs/acp/](https://opencode.ai/docs/acp/)

### Connection Lifecycle

```
1. Smithers spawns `opencode acp` as subprocess (stdio transport)
2. Smithers sends `initialize` with capabilities
3. OpenCode responds with its capabilities
4. Smithers sends `session/new` to create a conversation
5. Smithers sends `session/prompt` with user messages
6. OpenCode streams `session/update` notifications (text chunks, tool calls, plans)
7. OpenCode sends requests back to Smithers for file/terminal operations
8. Smithers handles `fs/read_text_file`, `fs/write_text_file`, `terminal/*`
```

### Capability Negotiation

Smithers advertises what it can do:

```json
{
  "capabilities": {
    "fileSystem": {
      "readTextFile": true,
      "writeTextFile": true
    },
    "terminal": {
      "create": true,
      "output": true,
      "waitForExit": true,
      "kill": true,
      "release": true
    },
    "prompts": {
      "audio": false,
      "image": true,
      "embeddedContext": true
    }
  }
}
```

### Requests from OpenCode → Smithers

| Method | Parameters | Behavior |
|--------|-----------|----------|
| `fs/read_text_file` | `uri` | Read file contents from editor buffer (or disk) |
| `fs/write_text_file` | `uri`, `text` | Write file — Smithers can show diff review before applying |
| `terminal/create` | `command`, `args`, `cwd` | Create terminal session (Ghostty integration?) |
| `terminal/output` | `terminalId` | Get terminal output |
| `terminal/wait_for_exit` | `terminalId` | Wait for command completion |
| `terminal/kill` | `terminalId` | Kill terminal process |
| `terminal/release` | `terminalId` | Release terminal resources |
| `session/request_permission` | `tool`, `args` | Ask user to approve a tool call |

### Notifications from OpenCode → Smithers

`session/update` with update types:
- `agent_message_chunk` — streaming text response
- `agent_thought_chunk` — reasoning/thinking
- `tool_call` — tool invocation announcement
- `tool_call_update` — tool execution result
- `plan` — multi-step plan with steps array

### Alternative: HTTP Server Mode

OpenCode can also run as a headless HTTP server (`opencode serve`), exposing a full REST API with SSE for real-time updates. This is simpler but gives Smithers less control over file operations.

| Mode | Command | Transport | Smithers Role |
|------|---------|-----------|---------------|
| ACP (recommended) | `opencode acp` | stdio JSON-RPC | Tool provider (handles file/terminal requests) |
| HTTP server | `opencode serve` | HTTP + SSE | API client (sends prompts, receives events) |

### Implementation Components

#### `OpenCodeBridge.swift` — ACP Client/Server

```swift
@MainActor
final class OpenCodeBridge: ObservableObject {
    @Published var isConnected = false

    private var process: Process?
    private var transport: JSONRPCTransport?  // Reuse existing transport!

    func start(cwd: String) async throws
    func stop()

    // Session management (Smithers → OpenCode)
    func createSession() async throws -> String
    func sendPrompt(sessionId: String, text: String) async throws
    func cancelPrompt(sessionId: String) async throws

    // Tool handlers (OpenCode → Smithers)
    private func handleReadFile(uri: String) -> String
    private func handleWriteFile(uri: String, text: String) async -> Bool
    private func handleCreateTerminal(command: String, args: [String], cwd: String) -> String
    private func handleTerminalOutput(terminalId: String) -> String
    private func handleRequestPermission(tool: String, args: JSONValue) async -> Bool
}
```

**Key advantage:** `JSONRPCTransport.swift` already handles stdio JSON-RPC — the same transport used for Codex can be reused for OpenCode ACP with minimal changes. The main difference is that Smithers needs to handle **incoming requests** (not just notifications), which `handleRequest` in `CodexService` already scaffolds.

---

## Unified Agent Architecture

With three agent backends (Codex, Claude Code, OpenCode), Smithers needs an abstraction layer.

### Agent Protocol Adapter

```swift
protocol AgentBridge {
    var isConnected: Bool { get }
    var events: AsyncStream<AgentEvent> { get }

    func start(cwd: String) async throws
    func stop()
    func sendMessage(_ text: String) async throws
    func interrupt() async throws
}

enum AgentEvent {
    case turnStarted
    case messageDelta(text: String)
    case messageCompleted(text: String)
    case commandStarted(id: String, command: String, cwd: String)
    case commandOutput(id: String, text: String)
    case commandCompleted(id: String, exitCode: Int?)
    case fileChange(files: [String], diff: String)
    case diffReviewRequested(id: String, oldContent: String, newContent: String, filePath: String)
    case permissionRequested(id: String, tool: String, description: String)
    case turnCompleted
    case error(message: String)
}
```

Each bridge (`CodexService`, `ClaudeCodeBridge`, `OpenCodeBridge`) conforms to `AgentBridge`. WorkspaceState talks to the protocol, not the concrete type.

### Agent Selector

Users pick their agent from settings or command palette:

```
┌────────────────────────────────────────┐
│  Select Agent                          │
│                                        │
│  (●) Codex (default)                   │
│      Built-in, auto-launched           │
│                                        │
│  ( ) Claude Code                       │
│      Connects when `claude` CLI runs   │
│                                        │
│  ( ) OpenCode                          │
│      Launches `opencode acp` subprocess│
│                                        │
│  [Cancel]              [Select]        │
└────────────────────────────────────────┘
```

---

## Implementation Phases

### Phase 1: WebSocket Server Foundation (Claude Code)

1. **WebSocket server** using `Network.framework` (`NWListener` with WebSocket protocol)
   - Listen on random available port on localhost
   - Handle upgrade with auth token validation
   - JSON-RPC 2.0 message parsing (reuse patterns from `JSONRPCTransport`)

2. **Lock file management**
   - Write `~/.claude/ide/<port>.lock` on server start
   - Clean up on server stop / app quit
   - Include `ideName: "Smithers"`, workspace folders, auth token

3. **Basic tool handlers**
   - `getWorkspaceFolders` → return `WorkspaceState.rootDirectory`
   - `getOpenEditors` → return currently open file
   - `getCurrentSelection` → return STTextView selection (if available)
   - `openFile` → navigate to file in sidebar, open in editor

### Phase 2: Diff Review (Claude Code)

4. **`openDiff` handler**
   - Receive old/new content from Claude
   - Open `DiffViewer` sheet with the proposed changes
   - **Block the JSON-RPC response** until user clicks Accept or Reject
   - Respond with `"FILE_SAVED"` or `"DIFF_REJECTED"`
   - This is the critical UX — it turns Smithers from auto-approve into interactive review

5. **Selection & diagnostic notifications**
   - Fire `selection_changed` when STTextView selection changes
   - Wire up `@`-mention from chat input to `at_mentioned` notification
   - `getDiagnostics` — stub initially, wire up when LSP integration lands

### Phase 3: OpenCode ACP Bridge

6. **ACP transport** — reuse `JSONRPCTransport` for stdio communication
   - Launch `opencode acp` as subprocess
   - `initialize` handshake with capabilities
   - `session/new` + `session/prompt` for sending messages
   - Process `session/update` notifications into `AgentEvent` stream

7. **File operation handlers**
   - `fs/read_text_file` → read from disk or editor buffer
   - `fs/write_text_file` → optionally show diff review, then write
   - `session/request_permission` → show approval dialog

8. **Terminal handlers**
   - `terminal/create` → spawn process (or integrate with GhosttyTerminalView)
   - `terminal/output`, `terminal/wait_for_exit`, `terminal/kill`

### Phase 4: Unified Agent Layer

9. **`AgentBridge` protocol**
   - Abstract over Codex, Claude Code, and OpenCode
   - Unified `AgentEvent` stream
   - `WorkspaceState` refactored to use `AgentBridge` instead of `CodexService` directly

10. **Agent selector UI**
    - Settings pane or command palette entry
    - Per-workspace agent preference
    - Status indicator showing which agent is active

11. **Multi-agent support** (stretch)
    - Run Codex as primary agent, Claude Code as secondary
    - Each agent gets its own chat tab
    - Share workspace context across agents

---

## Key Design Decisions

### 1. Diff Review Is the Core Value Proposition

The biggest difference between "Smithers as Codex frontend" (current) and "Smithers as Claude Code/OpenCode frontend" is **interactive diff review**. Today Smithers auto-approves everything. With Claude Code's `openDiff`, every file change becomes a review point. This is the feature that makes editor integration worthwhile.

### 2. Reuse Existing Transport

`JSONRPCTransport.swift` already handles:
- Process spawning and stdio pipes
- JSON-RPC 2.0 encoding/decoding
- Request/response correlation
- Notification handling

For OpenCode ACP, this transport is directly reusable. For Claude Code, we need a WebSocket variant, but the JSON-RPC layer on top is identical.

### 3. Claude Code Discovery vs Launch

Two modes:
- **Passive**: Smithers runs its WebSocket server and writes the lock file. When the user opens a terminal and runs `claude`, it discovers Smithers automatically. This is how VS Code/Neovim work.
- **Active**: Smithers has a "Launch Claude" button that spawns the `claude` CLI in the built-in terminal (GhosttyTerminalView) with the right environment variables. More integrated UX.

Both should be supported.

### 4. No Codex Changes Needed

The existing `CodexService` continues working as-is. The new bridges are additive — they don't modify the Codex integration path.

---

## Resources

| Resource | URL |
|----------|-----|
| Claude Code VS Code docs | [code.claude.com/docs/en/vs-code](https://code.claude.com/docs/en/vs-code) |
| Claude Code JetBrains docs | [code.claude.com/docs/en/jetbrains](https://code.claude.com/docs/en/jetbrains) |
| claudecode.nvim (best protocol reference) | [github.com/coder/claudecode.nvim](https://github.com/coder/claudecode.nvim) |
| claude-code-ide.el (Emacs) | [github.com/manzaltu/claude-code-ide.el](https://github.com/manzaltu/claude-code-ide.el) |
| Agent Client Protocol spec | [agentclientprotocol.com](https://agentclientprotocol.com/) |
| ACP GitHub | [github.com/agentclientprotocol/agent-client-protocol](https://github.com/agentclientprotocol/agent-client-protocol) |
| OpenCode docs | [opencode.ai/docs](https://opencode.ai/docs/) |
| OpenCode ACP docs | [opencode.ai/docs/acp/](https://opencode.ai/docs/acp/) |
| OpenCode server docs | [opencode.ai/docs/server/](https://opencode.ai/docs/server/) |
| OpenCode JS SDK | [github.com/anomalyco/opencode-sdk-js](https://github.com/anomalyco/opencode-sdk-js) |
| OpenCode architecture deep dive | [cefboud.com/posts/coding-agents-internals-opencode-deepdive/](https://cefboud.com/posts/coding-agents-internals-opencode-deepdive/) |

## Open Questions

1. **WebSocket library**: Use `Network.framework` (NWListener) directly, or bring in a Swift WebSocket library like `Vapor/WebSocketKit`? Network.framework keeps dependencies minimal but is lower-level.
2. **Lock file cleanup**: What happens if Smithers crashes without removing the lock file? Should we check PID liveness on startup and clean stale locks?
3. **Multiple Claude instances**: Can multiple `claude` CLI instances connect simultaneously? If so, how do we handle concurrent `openDiff` requests?
4. **OpenCode binary discovery**: Where does `opencode` get installed? Should Smithers bundle it or require the user to install it separately?
5. **Permission model**: For OpenCode's `session/request_permission`, should we show the same approval UI as Claude Code's `openDiff`, or a separate permission dialog?
6. **Diagnostics**: Both protocols ask for LSP diagnostics. Smithers doesn't have LSP yet (per MEMORY.md: "Will add LSP integration later"). Should we stub this out or prioritize LSP?

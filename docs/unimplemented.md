# Unimplemented Features & Stubs

This document tracks stub implementations, placeholder code, and unimplemented features in the Smithers Desktop app (`apps/desktop`).

## Critical Stubs

### 1. Chat Agent (Echo Stub)
**Location:** [`apps/desktop/src/bun/agent/runner.ts`](../apps/desktop/src/bun/agent/runner.ts)

The chat agent is a **minimal stub** that does NOT connect to any LLM. It simply echoes back the user's message.

```typescript
// runner.ts:218-221
function buildAssistantText(prompt: string): string {
  const trimmed = prompt.trim();
  if (!trimmed) return "I didn't receive any text. Try typing a message.";
  return `You said: ${trimmed}`;
}
```

**What's missing:**
- Integration with Claude, OpenAI, or other LLM APIs
- API key configuration and management
- Model selection (Claude Sonnet, GPT-4, etc.)
- System prompts and agent configuration
- Conversation context/memory management
- Token counting and rate limiting

**Workaround:** The agent supports explicit tool commands for testing:
- `/read path/to/file` - Read a file
- `/write path/to/file` + content - Write a file
- `/edit path/to/file` + patch - Apply a diff patch
- `/bash <command>` - Execute a shell command

### 2. Streaming Simulation
**Location:** [`apps/desktop/src/bun/agent/runner.ts#L173-L206`](../apps/desktop/src/bun/agent/runner.ts#L173-L206)

The agent simulates streaming by artificially chunking the response into 24-character pieces. This is not real streaming from an LLM.

```typescript
// runner.ts:177
const chunks = chunkText(text, 24);
```

**What's missing:**
- Real streaming from LLM APIs (SSE/WebSocket)
- Proper token-by-token streaming
- Cancellation of in-progress streaming

### 3. Network Access Blocking (Simple String Check)
**Location:** [`apps/desktop/src/bun/tools/index.ts#L144-L161`](../apps/desktop/src/bun/tools/index.ts#L144-L161)

Network access is blocked using simple string matching, which can be bypassed.

```typescript
function isCommandSafe(command: string): boolean {
  const lowered = command.toLowerCase();
  const blocked = [
    "curl ", "wget ", "http://", "https://",
    "ssh ", "scp ", "nc ", "netcat", "telnet",
    "ftp ", "sftp ", "git ",
  ];
  return !blocked.some((token) => lowered.includes(token));
}
```

**What's missing:**
- Proper network namespace isolation
- Firewall rules or sandbox containers
- More comprehensive command analysis
- Support for `allowNetwork: true` configuration

---

## Partial Implementations

### 4. Plugin System
**Location:** [`apps/desktop/src/bun/plugins/`](../apps/desktop/src/bun/plugins/)

The plugin system has types and a registry but no actual plugins are loaded or used.

```typescript
// main.ts:16-17
const plugins = new PluginRegistry();
plugins.register({ id: "smithers" });  // Empty plugin, does nothing
```

**What's missing:**
- Actual plugin implementations
- Plugin discovery and loading
- Plugin API hooks are defined but never called:
  - `registerTools()` - never called
  - `registerRpc()` - never called
  - `registerDbMigrations()` - never called
  - `registerUiContributions()` - never called

### 5. Window Close Handler
**Location:** [`apps/desktop/src/bun/main.ts#L136-138`](../apps/desktop/src/bun/main.ts#L136-138)

```typescript
win.on("closed", () => {
  // no-op for now
});
```

**What's missing:**
- Cleanup of running workflows
- Aborting in-progress agent runs
- Saving unsaved state
- Confirmation dialog for unsaved changes

### 6. Secrets/Credentials Storage
**Location:** Mentioned in [`docs/uispec.md`](./uispec.md) but not implemented

The UI spec mentions:
> Store secrets in Bun using OS keychain if available (phase 2+).
> Phase 1 fallback: encrypted blob in SQLite.

**What's missing:**
- OS keychain integration (macOS Keychain, Windows Credential Manager)
- Encrypted storage for API keys
- Secure credential management UI

---

## UI Stubs & TODOs

### 7. Custom Message Renderer for Workflow Cards
**Location:** [`apps/desktop/src/webview/main.ts#L292`](../apps/desktop/src/webview/main.ts#L292)

```typescript
// TODO: Add custom message renderer support to ChatPanel for workflow cards
```

Workflow cards are defined but not rendered in the chat panel.

### 8. Watcher Failure Handling
**Location:** [`apps/desktop/src/bun/workspace/WorkspaceService.ts#L89-91`](../apps/desktop/src/bun/workspace/WorkspaceService.ts#L89-91)

```typescript
} catch {
  // ignore watcher failures; users can refresh manually
}
```

No user notification when file watching fails.

---

## Electrobun Framework TODOs

These are in the Electrobun framework code (bundled in build), not Smithers code:

- `TODO: Implement proper cleanup mechanism that checks for running processes`
- `TODO: Received ArrayBuffer message` - ArrayBuffer messages not handled
- `TODO: webviewDecideNavigation` - Navigation decisions not implemented
- `TODO: webviewTagCallAsyncJavaScript NOT YET IMPLEMENTED`

---

## Implementation Priority

### High Priority (Core Functionality)
1. **LLM Integration** - Replace echo stub with real Claude/OpenAI API calls
2. **API Key Management** - Secure storage and configuration UI
3. **Real Streaming** - Proper token streaming from LLM APIs

### Medium Priority (Polish)
4. **Network Sandboxing** - More robust bash command isolation
5. **Workflow Cards in Chat** - Custom renderer for workflow status
6. **Window Close Cleanup** - Proper shutdown handling

### Low Priority (Future)
7. **Plugin System** - Hook up plugin lifecycle
8. **OS Keychain** - Native credential storage
9. **File Watcher Notifications** - User feedback on watcher errors

---

## Testing Notes

The current stub agent can be tested with explicit tool commands:

```
/bash pwd
/read package.json
/write test.txt
Hello world
/bash ls -la
```

These commands execute real tools in the sandboxed workspace.

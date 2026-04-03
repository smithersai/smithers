# Engineering Doc: TUI Chat-First Redesign

**Status**: Draft
**Date**: 2026-03-29

---

## Architecture Overview

The TUI is a React app rendered by OpenTUI (`@opentui/core` + `@opentui/react`). The existing CLI command `smithers tui` already creates the renderer and mounts a `<TuiApp>` component. Our job is to implement `TuiApp` and all child components.

### File Structure

```
src/cli/tui/
├── app.tsx                    # Root TuiApp component + router
├── state.ts                   # Shared state types and context
├── hooks/
│   ├── useAgent.ts            # Agent detection + generation
│   ├── useRuns.ts             # Polling adapter.listRuns()
│   ├── useSlashCommands.ts    # Command registry + matching
│   └── useWorkflows.ts        # Workflow discovery
├── components/
│   ├── StatusBar.tsx           # Top status bar
│   ├── RunsSidebar.tsx         # Left sidebar with active/recent runs
│   ├── ChatView.tsx            # Chat message list + input
│   ├── MessageBubble.tsx       # Individual chat message
│   ├── ChatInput.tsx           # Text input with slash detection
│   ├── AutocompletePopup.tsx   # Slash command autocomplete overlay
│   ├── LoadingIndicator.tsx    # Animated thinking dots
│   ├── RunDetailView.tsx       # EXISTING - task list drill-down
│   ├── TaskInspector.tsx       # 5-tab task detail view
│   ├── DashboardView.tsx       # Runs list (full-screen browse)
│   ├── TelemetryView.tsx       # Metrics display
│   ├── TriggersView.tsx        # Cron trigger list
│   ├── DataGridView.tsx        # SQL query browser
│   └── HelpOverlay.tsx         # Command help overlay
tests/
├── tui/
│   ├── chat-view.test.tsx      # Chat view unit tests
│   ├── slash-commands.test.ts  # Slash command parsing + matching
│   ├── autocomplete.test.tsx   # Autocomplete popup behavior
│   ├── runs-sidebar.test.tsx   # Sidebar polling + display
│   ├── status-bar.test.tsx     # Status bar content
│   ├── dashboard-view.test.tsx # Dashboard navigation
│   ├── task-inspector.test.tsx # Inspector sub-views
│   ├── telemetry-view.test.tsx # Telemetry display
│   ├── triggers-view.test.tsx  # Triggers list
│   ├── data-grid-view.test.tsx # SQL browser
│   ├── agent-hook.test.ts      # Agent detection + generation
│   ├── app-router.test.tsx     # Screen navigation
│   └── helpers.ts              # Test utilities (mock adapter, render helpers)
├── tui.e2e.test.ts             # EXISTING - full E2E test
```

---

## Component Architecture

### 1. TuiApp (Root)

```tsx
// src/cli/tui/app.tsx
type Screen =
  | { kind: "chat" }
  | { kind: "dashboard" }
  | { kind: "run-detail"; runId: string }
  | { kind: "task-inspector"; runId: string; nodeId: string | null }
  | { kind: "telemetry" }
  | { kind: "triggers" }
  | { kind: "datagrid" }

type TuiAppProps = {
  adapter: SmithersDb;
  onExit: () => void;
};

export function TuiApp({ adapter, onExit }: TuiAppProps) {
  const [screen, setScreen] = useState<Screen>({ kind: "chat" });
  const [screenHistory, setScreenHistory] = useState<Screen[]>([]);
  const agent = useAgent();
  const runs = useRuns(adapter);
  const workflows = useWorkflows();
  const commands = useSlashCommands(workflows, setScreen);

  const navigate = (next: Screen) => {
    setScreenHistory(prev => [...prev, screen]);
    setScreen(next);
  };

  const goBack = () => {
    const prev = screenHistory[screenHistory.length - 1];
    if (prev) {
      setScreenHistory(h => h.slice(0, -1));
      setScreen(prev);
    } else if (screen.kind === "chat") {
      onExit();
    } else {
      setScreen({ kind: "chat" });
    }
  };

  // Global Esc handler
  useKeyboard((key) => {
    if (key.name === "escape") goBack();
    if (key.name === "c" && key.ctrl) onExit();
  });

  return (
    <box style={{ width: "100%", height: "100%", flexDirection: "column", border: true, borderColor: "#34d399" }} title="Smithers">
      <StatusBar agent={agent} activeRunCount={runs.active.length} screenName={screen.kind} />
      <box style={{ flexGrow: 1, flexDirection: "row" }}>
        <RunsSidebar
          activeRuns={runs.active}
          recentRuns={runs.recent}
          onSelectRun={(runId) => navigate({ kind: "run-detail", runId })}
        />
        {renderScreen(screen)}
      </box>
    </box>
  );
}
```

### 2. Screen Router

```tsx
function renderScreen(screen: Screen) {
  switch (screen.kind) {
    case "chat":
      return <ChatView agent={agent} adapter={adapter} commands={commands} />;
    case "dashboard":
      return <DashboardView adapter={adapter} onSelectRun={...} />;
    case "run-detail":
      return <RunDetailView adapter={adapter} runId={screen.runId} onBack={goBack} onSelectNode={...} />;
    case "task-inspector":
      return <TaskInspector adapter={adapter} runId={screen.runId} nodeId={screen.nodeId} onBack={goBack} />;
    case "telemetry":
      return <TelemetryView adapter={adapter} />;
    case "triggers":
      return <TriggersView adapter={adapter} />;
    case "datagrid":
      return <DataGridView adapter={adapter} />;
  }
}
```

### 3. Navigation History

Use a stack-based history for back navigation:
- `navigate(screen)` pushes current screen onto stack, sets new screen
- `goBack()` pops stack, reverts to previous screen
- Empty stack + Esc on chat → exit TUI

---

## Hook Implementations

### useAgent

```typescript
// src/cli/tui/hooks/useAgent.ts
import { detectAvailableAgents, CONSTRUCTORS } from "../../agent-detection";

type AgentState = {
  agent: AgentLike | null;
  name: string;
  model: string;
  status: "detecting" | "ready" | "unavailable";
  generate: (prompt: string) => Promise<string>;
};

export function useAgent(): AgentState {
  const [state, setState] = useState<AgentState>({
    agent: null, name: "", model: "", status: "detecting",
    generate: async () => "",
  });

  useEffect(() => {
    const detections = detectAvailableAgents(process.env);
    const best = detections
      .filter(d => d.usable)
      .sort((a, b) => b.score - a.score)[0];

    if (!best) {
      setState(s => ({ ...s, status: "unavailable" }));
      return;
    }

    // Dynamically import and construct the agent
    const constructor = CONSTRUCTORS[best.id];
    // ... dynamic import of the agent class and instantiation
    // Set state with agent instance, name, model
  }, []);

  return state;
}
```

**Key decision**: We use the existing `detectAvailableAgents()` from `src/cli/agent-detection.ts` which scores each agent (claude, codex, gemini, etc.) based on binary presence and auth signals, then pick the highest-scored one. This is the same system used by `smithers ask`.

### useRuns

```typescript
// src/cli/tui/hooks/useRuns.ts
export function useRuns(adapter: SmithersDb) {
  const [active, setActive] = useState<RunSummary[]>([]);
  const [recent, setRecent] = useState<RunSummary[]>([]);

  useEffect(() => {
    let mounted = true;
    async function poll() {
      if (!mounted) return;
      const running = await adapter.listRuns(10, "running");
      const waiting = await adapter.listRuns(10, "waiting-approval");
      const finished = await adapter.listRuns(5, "finished");
      const failed = await adapter.listRuns(5, "failed");

      if (mounted) {
        setActive([...running, ...waiting].map(toRunSummary));
        setRecent([...finished, ...failed]
          .sort((a, b) => (b.finishedAtMs ?? 0) - (a.finishedAtMs ?? 0))
          .slice(0, 5)
          .map(toRunSummary));
      }
      if (mounted) setTimeout(poll, 2000);
    }
    poll();
    return () => { mounted = false; };
  }, [adapter]);

  return { active, recent };
}
```

### useSlashCommands

```typescript
// src/cli/tui/hooks/useSlashCommands.ts
type SlashCommand = {
  name: string;           // e.g., "dashboard"
  description: string;    // e.g., "Browse workflow runs"
  category: "navigation" | "workflow" | "action";
  execute: () => void;    // What to do when selected
};

export function useSlashCommands(
  workflows: WorkflowMeta[],
  navigate: (screen: Screen) => void,
): SlashCommand[] {
  return useMemo(() => {
    const nav: SlashCommand[] = [
      { name: "dashboard", description: "Browse workflow runs", category: "navigation", execute: () => navigate({ kind: "dashboard" }) },
      { name: "runs", description: "Browse workflow runs", category: "navigation", execute: () => navigate({ kind: "dashboard" }) },
      { name: "telemetry", description: "Global metrics and token usage", category: "navigation", execute: () => navigate({ kind: "telemetry" }) },
      { name: "metrics", description: "Global metrics and token usage", category: "navigation", execute: () => navigate({ kind: "telemetry" }) },
      { name: "triggers", description: "View cron triggers", category: "navigation", execute: () => navigate({ kind: "triggers" }) },
      { name: "crons", description: "View cron triggers", category: "navigation", execute: () => navigate({ kind: "triggers" }) },
      { name: "datagrid", description: "SQL query browser", category: "navigation", execute: () => navigate({ kind: "datagrid" }) },
      { name: "sql", description: "SQL query browser", category: "navigation", execute: () => navigate({ kind: "datagrid" }) },
      { name: "chat", description: "Return to chat", category: "navigation", execute: () => navigate({ kind: "chat" }) },
      { name: "home", description: "Return to chat", category: "navigation", execute: () => navigate({ kind: "chat" }) },
      { name: "help", description: "Show all commands", category: "action", execute: () => { /* toggle help overlay */ } },
      { name: "clear", description: "Clear chat history", category: "action", execute: () => { /* clear messages */ } },
    ];

    const wf: SlashCommand[] = workflows.map(w => ({
      name: w.id,
      description: w.entryFile,
      category: "workflow" as const,
      execute: () => { /* launch workflow */ },
    }));

    return [...nav, ...wf];
  }, [workflows, navigate]);
}
```

### useWorkflows

```typescript
// src/cli/tui/hooks/useWorkflows.ts
import { discoverWorkflows } from "../../workflows";

export function useWorkflows() {
  const [workflows, setWorkflows] = useState<WorkflowMeta[]>([]);

  useEffect(() => {
    try {
      const discovered = discoverWorkflows(process.cwd());
      setWorkflows(discovered);
    } catch {
      setWorkflows([]);
    }
  }, []);

  return workflows;
}
```

---

## Agent Integration Details

### System Prompt Construction

When the user sends a message in chat, we construct a system prompt that gives the agent context about the Smithers instance:

```typescript
function buildChatSystemPrompt(adapter: SmithersDb): string {
  // Query current state
  const activeRuns = await adapter.listRuns(10, "running");
  const recentFailed = await adapter.listRuns(5, "failed");

  return `You are Smithers, an AI assistant embedded in the Smithers workflow orchestrator TUI.
You have access to the current state of the workflow system:

Active Runs: ${activeRuns.length}
${activeRuns.map(r => `- ${r.workflowName} (${r.runId}): ${r.status}`).join("\n")}

Recent Failures: ${recentFailed.length}
${recentFailed.map(r => `- ${r.workflowName} (${r.runId}): failed`).join("\n")}

Answer questions about workflow status, explain errors, and help debug issues.
Keep responses concise and terminal-friendly (no long paragraphs).`;
}
```

### Message Flow

```
User types message → ChatInput.onSubmit
  ↓
Check if starts with "/"
  ├── YES → parse slash command → execute command
  └── NO  → add to messages[] as { role: "user", content }
              ↓
            set loading = true
              ↓
            agent.generate({ prompt: buildPrompt(messages) })
              ↓
            add response to messages[] as { role: "assistant", content }
              ↓
            set loading = false
```

### Agent Construction

We dynamically import the agent class based on detection results:

```typescript
async function constructAgent(detection: AgentAvailability): Promise<AgentLike> {
  const { id } = detection;
  switch (id) {
    case "claude": {
      const { ClaudeCodeAgent } = await import("../../agents/ClaudeCodeAgent");
      return new ClaudeCodeAgent({ model: "claude-opus-4-6" });
    }
    case "codex": {
      const { CodexAgent } = await import("../../agents/CodexAgent");
      return new CodexAgent({ model: "gpt-5.3-codex", skipGitRepoCheck: true });
    }
    case "gemini": {
      const { GeminiAgent } = await import("../../agents/GeminiAgent");
      return new GeminiAgent({ model: "gemini-3.1-pro-preview" });
    }
    // ... etc for pi, kimi, amp
  }
}
```

---

## Slash Command Parsing

```typescript
function parseSlashCommand(input: string): { command: string; args: string } | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) return null;
  const spaceIdx = trimmed.indexOf(" ");
  if (spaceIdx === -1) return { command: trimmed.slice(1), args: "" };
  return { command: trimmed.slice(1, spaceIdx), args: trimmed.slice(spaceIdx + 1) };
}
```

### Fuzzy Matching for Autocomplete

```typescript
function fuzzyMatch(query: string, commands: SlashCommand[]): SlashCommand[] {
  const q = query.toLowerCase();
  return commands
    .filter(cmd => cmd.name.toLowerCase().includes(q) || cmd.description.toLowerCase().includes(q))
    .sort((a, b) => {
      // Prefer prefix match
      const aPrefix = a.name.toLowerCase().startsWith(q) ? 0 : 1;
      const bPrefix = b.name.toLowerCase().startsWith(q) ? 0 : 1;
      return aPrefix - bPrefix || a.name.localeCompare(b.name);
    });
}
```

---

## State Management

### ChatView State

```typescript
type ChatMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: number;
};

// In ChatView component:
const [messages, setMessages] = useState<ChatMessage[]>([]);
const [isLoading, setIsLoading] = useState(false);
const [error, setError] = useState<string | null>(null);
const [showAutocomplete, setShowAutocomplete] = useState(false);
const [autocompleteQuery, setAutocompleteQuery] = useState("");
const [autocompleteIndex, setAutocompleteIndex] = useState(0);
```

### Focus Management

The TUI has two focus contexts:
1. **Sidebar focus**: Arrow keys navigate runs in the sidebar
2. **Main focus**: Arrow keys / typing interact with the main content area

Use a `focusArea` state: `"sidebar" | "main"`. Tab key toggles focus. Visual indicator shows which area is focused (brighter border).

```typescript
const [focusArea, setFocusArea] = useState<"sidebar" | "main">("main");

useKeyboard((key) => {
  if (key.name === "tab") {
    setFocusArea(f => f === "sidebar" ? "main" : "sidebar");
  }
});
```

---

## Workflow Execution from Chat

When a user types `/hello`:

```typescript
async function executeWorkflowCommand(workflowId: string, args: string) {
  const workflow = resolveWorkflow(workflowId, process.cwd());
  if (!workflow) {
    addMessage({ role: "system", content: `Unknown workflow: ${workflowId}` });
    return;
  }

  addMessage({ role: "system", content: `Launching workflow **${workflowId}** (${workflow.entryFile})...` });

  // Spawn detached smithers up process
  const proc = Bun.spawn(
    ["bun", "run", "src/cli/index.ts", "up", workflow.entryFile, "-d"],
    { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" }
  );

  // Parse run ID from output
  const output = await new Response(proc.stdout).text();
  const runIdMatch = output.match(/run[_-]id[:\s]+(\S+)/i);
  const runId = runIdMatch?.[1];

  if (runId) {
    addMessage({ role: "system", content: `Started run \`${runId}\`. Tracking in sidebar.` });
    // The useRuns hook will pick it up automatically via polling
  }
}
```

---

## Existing Component Integration

### RunDetailView

The existing `RunDetailView.tsx` is already implemented and functional. We keep it as-is, just wire `onBack` to our `goBack()` and `onSelectNode` to navigate to TaskInspector.

### TaskInspector (New)

The TaskInspector is referenced in docs and tests but not yet implemented. It has 5 tabs:

```tsx
function TaskInspector({ adapter, runId, nodeId, onBack }) {
  const [tab, setTab] = useState<1 | 2 | 3 | 4 | 5>(1);

  useKeyboard((key) => {
    if (["1","2","3","4","5"].includes(key.name)) setTab(Number(key.name));
    if (key.name === "escape") onBack();
    if (key.name === "r") { /* revert logic */ }
  });

  return (
    <box style={{ flexGrow: 1, flexDirection: "column" }}>
      <tab-select tabs={["Input", "Output", "Frames", "Chat", "Logs"]} selected={tab - 1} />
      {tab === 1 && <InputTab adapter={adapter} runId={runId} nodeId={nodeId} />}
      {tab === 2 && <OutputTab adapter={adapter} runId={runId} nodeId={nodeId} />}
      {tab === 3 && <FramesTab adapter={adapter} runId={runId} nodeId={nodeId} />}
      {tab === 4 && <ChatTab adapter={adapter} runId={runId} nodeId={nodeId} />}
      {tab === 5 && <LogsTab adapter={adapter} runId={runId} nodeId={nodeId} />}
    </box>
  );
}
```

---

## Testing Strategy

### Unit Tests (per component)

Each component gets a test file that:
1. Creates a mock `SmithersDb` adapter with canned data
2. Renders the component using OpenTUI's test renderer
3. Asserts on rendered text content
4. Simulates keyboard events and asserts state changes

```typescript
// tests/tui/helpers.ts
export function createMockAdapter(overrides?: Partial<SmithersDb>): SmithersDb {
  return {
    getRun: async () => ({ runId: "test-run", status: "running", workflowName: "test" }),
    listRuns: async () => [],
    listNodes: async () => [],
    listEvents: async () => [],
    listAttemptsForRun: async () => [],
    ...overrides,
  };
}

export function createMockAgent(response: string = "Mock response"): AgentLike {
  return {
    generate: async ({ prompt }) => ({ text: response }),
  };
}
```

### Hook Tests

```typescript
// tests/tui/slash-commands.test.ts
test("parseSlashCommand extracts command and args", () => {
  expect(parseSlashCommand("/dashboard")).toEqual({ command: "dashboard", args: "" });
  expect(parseSlashCommand("/review pr 123")).toEqual({ command: "review", args: "pr 123" });
  expect(parseSlashCommand("hello")).toBeNull();
});

test("fuzzyMatch filters and ranks commands", () => {
  const commands = [
    { name: "dashboard", description: "Browse runs", ... },
    { name: "datagrid", description: "SQL browser", ... },
    { name: "telemetry", description: "Metrics", ... },
  ];
  const results = fuzzyMatch("da", commands);
  expect(results.map(c => c.name)).toEqual(["dashboard", "datagrid"]);
});
```

### E2E Tests

Extend the existing `tui.e2e.test.ts` with chat-specific scenarios:

```typescript
test("Chat input sends message and receives response", async () => {
  const tui = await launchTUI(["tui"]);
  await tui.waitForText("Type a message");
  tui.type("hello");
  tui.sendKeys("\r");
  await tui.waitForText("Smithers"); // assistant response bubble
});

test("Slash command /dashboard navigates to runs view", async () => {
  const tui = await launchTUI(["tui"]);
  tui.type("/dashboard");
  tui.sendKeys("\r");
  await tui.waitForText("Smithers Runs");
});

test("Active runs sidebar shows running workflows", async () => {
  // Start a workflow first, then launch TUI
  const tui = await launchTUI(["tui"]);
  await tui.waitForText("Active Runs");
});
```

---

## Dependencies

### Already Available
- `@opentui/core` + `@opentui/react` — rendering framework
- `react` 19.2.4 — component model
- Agent classes (ClaudeCodeAgent, CodexAgent, GeminiAgent, etc.)
- `detectAvailableAgents()` — agent detection
- `discoverWorkflows()` — workflow discovery
- `SmithersDb` adapter — database access
- `RunDetailView` — existing component

### No New Dependencies Required

Everything needed is already in the project. We use:
- OpenTUI's `<box>`, `<scrollbox>`, `<text>`, `<input>`, `<markdown>`, `<tab-select>` components
- OpenTUI's `useKeyboard`, `useTerminalDimensions`, `useTimeline` hooks
- Existing agent and workflow infrastructure

---

## Migration Path

1. Create `src/cli/tui/app.tsx` — this is imported by the existing CLI command
2. The CLI command already expects `TuiApp` from `./tui/app.js` — just create the file
3. No changes to CLI entry point needed
4. No changes to existing RunDetailView needed (just import and use)
5. `find-db.ts` already imported in CLI — needs implementation if not present

---

## Open Technical Questions

1. **Input component behavior**: Does OpenTUI's `<input>` support `onChange` for real-time autocomplete, or only `onSubmit`? May need a custom input component.
2. **Overlay positioning**: OpenTUI may not support absolute positioning for the autocomplete popup. Alternative: render it inline above the input, pushing messages up.
3. **Markdown rendering**: Does `<markdown>` handle code blocks with syntax highlighting in the terminal? Need to verify.
4. **Agent timeout**: What's the right timeout for chat generation? 60s? 120s? Should match the agent's default.

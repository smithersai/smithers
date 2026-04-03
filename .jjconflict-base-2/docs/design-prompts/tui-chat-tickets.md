# Implementation Tickets: TUI Chat-First Redesign

**Total tickets**: 14
**Approach**: TDD — each ticket writes tests first, then implementation.
**Parallelism**: Tickets marked with the same "wave" can be built concurrently by sub-agents.

---

## Wave 1: Foundation (no dependencies)

### Ticket 1: Test helpers and mock adapter
**Files**: `tests/tui/helpers.ts`
**Description**:
Create test infrastructure for all TUI tests:
- `createMockAdapter(overrides?)` — returns a mock `SmithersDb` with canned data for runs, nodes, events, attempts
- `createMockAgent(response?)` — returns a mock `AgentLike` that resolves with the given response
- `renderTui(component)` — wrapper around OpenTUI test renderer for component testing
- Type exports for test data factories

**Tests**: Self-tested — importing the module should work and factories should return correct types.

---

### Ticket 2: Slash command parsing and matching
**Files**: `src/cli/tui/hooks/useSlashCommands.ts`, `tests/tui/slash-commands.test.ts`
**Description**:
Implement the slash command system:
- `parseSlashCommand(input: string)` — extracts `{ command, args }` from `/command args` input, returns null for non-slash input
- `fuzzyMatch(query: string, commands: SlashCommand[])` — filters and ranks commands by prefix match then substring match
- `SlashCommand` type definition with `name`, `description`, `category`, `execute`
- `useSlashCommands(workflows, navigate)` hook that builds the full command list from navigation commands + discovered workflows

**Tests**:
- `parseSlashCommand("/dashboard")` → `{ command: "dashboard", args: "" }`
- `parseSlashCommand("/review pr 123")` → `{ command: "review", args: "pr 123" }`
- `parseSlashCommand("hello")` → `null`
- `parseSlashCommand("")` → `null`
- `fuzzyMatch("da", [...])` → `["dashboard", "datagrid"]`
- `fuzzyMatch("tel", [...])` → `["telemetry"]`
- `fuzzyMatch("", [...])` → all commands
- `useSlashCommands` includes navigation + workflow commands

---

### Ticket 3: useAgent hook
**Files**: `src/cli/tui/hooks/useAgent.ts`, `tests/tui/agent-hook.test.ts`
**Description**:
Implement agent detection and construction hook:
- Calls `detectAvailableAgents(process.env)` on mount
- Picks highest-scored usable agent
- Dynamically imports and constructs the agent class
- Returns `{ agent, name, model, status, generate }` where `generate(prompt)` wraps `agent.generate()`
- Handles "unavailable" state gracefully

**Tests**:
- With mocked detection returning claude → status becomes "ready", name is "claude"
- With no agents available → status is "unavailable"
- `generate()` calls underlying agent and returns text
- Error in agent.generate() is caught and returned as error string

---

### Ticket 4: useRuns hook
**Files**: `src/cli/tui/hooks/useRuns.ts`, `tests/tui/runs-hook.test.ts`
**Description**:
Implement polling hook for active/recent runs:
- Polls `adapter.listRuns()` every 2 seconds
- Separates into `active` (running + waiting-approval) and `recent` (finished + failed, last 5)
- Computes `RunSummary` objects with `workflowName`, `elapsed`, `currentStep`, `progress` (`done/total`), `status`
- Cleans up polling on unmount

**Tests**:
- Returns active runs from mock adapter
- Returns recent runs sorted by finish time
- Polls and updates when data changes
- Cleanup stops polling

---

### Ticket 5: useWorkflows hook
**Files**: `src/cli/tui/hooks/useWorkflows.ts`, `tests/tui/workflows-hook.test.ts`
**Description**:
Wrapper hook for workflow discovery:
- Calls `discoverWorkflows(process.cwd())` on mount
- Returns workflow metadata array
- Handles errors gracefully (returns empty array)

**Tests**:
- Returns discovered workflows
- Returns empty array on error

---

## Wave 2: Core Components (depends on Wave 1)

### Ticket 6: StatusBar component
**Files**: `src/cli/tui/components/StatusBar.tsx`, `tests/tui/status-bar.test.tsx`
**Description**:
Fixed single-row status bar at the top:
- Shows agent indicator (green dot when ready, red when unavailable) + model name
- Shows active run count
- Shows current screen name
- Shows "/help for commands" hint on the right
- Styled with `backgroundColor: "#1a1a2e"`

**Tests**:
- Renders agent name when ready
- Shows "No agent" when unavailable
- Shows correct run count
- Shows current screen name
- Shows help hint

---

### Ticket 7: RunsSidebar component
**Files**: `src/cli/tui/components/RunsSidebar.tsx`, `tests/tui/runs-sidebar.test.tsx`
**Description**:
Persistent left sidebar (22 cols wide) showing active and recent runs:
- Active runs section with spinning indicator `◐`, elapsed time, current step with progress
- Recent runs section with `✓` (finished) or `✗` (failed), relative time
- Arrow keys navigate when sidebar is focused
- Enter on a run calls `onSelectRun(runId)`
- Border color `#4bc5a3`

**Tests**:
- Renders active runs with status indicators
- Renders recent runs with completion indicators
- Arrow keys change selection
- Enter calls onSelectRun with correct runId
- Empty state shows "No active runs"

---

### Ticket 8: MessageBubble and LoadingIndicator components
**Files**: `src/cli/tui/components/MessageBubble.tsx`, `src/cli/tui/components/LoadingIndicator.tsx`, `tests/tui/message-bubble.test.tsx`
**Description**:
MessageBubble:
- Bordered box with title "You" (cyan border) or "Smithers" (teal border)
- User messages rendered as plain `<text>`
- Assistant messages rendered with `<markdown>`
- System messages rendered with gray text, no border

LoadingIndicator:
- Animated dots "Thinking..." inside a Smithers-styled bubble
- Uses `useTimeline()` for animation

**Tests**:
- User message shows "You" title with cyan border
- Assistant message shows "Smithers" title with teal border
- System message has no border, gray text
- Loading indicator renders with "Thinking" text

---

### Ticket 9: ChatInput and AutocompletePopup components
**Files**: `src/cli/tui/components/ChatInput.tsx`, `src/cli/tui/components/AutocompletePopup.tsx`, `tests/tui/chat-input.test.tsx`, `tests/tui/autocomplete.test.tsx`
**Description**:
ChatInput:
- Text input with placeholder "Type a message... (/ for commands, @ for files)"
- On submit (Enter), calls `onSubmit(text)` and clears input
- When text starts with `/`, shows autocomplete popup
- Passes current text to autocomplete for filtering

AutocompletePopup:
- Renders above the input when visible
- Shows filtered commands grouped by category (Navigation, Workflows, Actions)
- Arrow Up/Down navigates, Enter selects, Esc dismisses
- Selected item highlighted in green with `▶` prefix
- Category headers in bold

**Tests**:
- ChatInput calls onSubmit with text on Enter
- ChatInput clears after submit
- Typing "/" shows autocomplete
- Autocomplete filters commands by query
- Arrow keys navigate autocomplete
- Enter selects command and calls execute
- Esc dismisses autocomplete

---

## Wave 3: Views (depends on Wave 2)

### Ticket 10: ChatView component
**Files**: `src/cli/tui/components/ChatView.tsx`, `tests/tui/chat-view.test.tsx`
**Description**:
Main chat view combining all chat components:
- Scrollable message list using `<scrollbox>`
- Welcome message on first render
- Handles user message submission:
  - If slash command → parse and execute
  - If regular text → send to agent, show loading, display response
- Error handling for agent failures (inline red message)
- `Ctrl+L` clears chat history

**Tests**:
- Renders welcome message initially
- User message appears in message list
- Slash command triggers navigation (not sent to agent)
- Regular message triggers agent.generate()
- Loading indicator shown while generating
- Agent response appears as assistant message
- Agent error shown as red system message
- Ctrl+L clears messages

---

### Ticket 11: DashboardView component
**Files**: `src/cli/tui/components/DashboardView.tsx`, `tests/tui/dashboard-view.test.tsx`
**Description**:
Full-screen runs browser (replaces the old TUI home screen):
- Left pane (40 cols): Run list with workflow name + status
- Right pane: Selected run details (ID, status, duration, task count, tokens, current step, errors)
- Arrow keys navigate, Enter drills into RunDetailView
- `N` key opens new run dialog (v2)
- `P` key toggles pending approvals filter
- Polls adapter for live updates

**Tests**:
- Renders run list from adapter
- Arrow keys change selection
- Right pane shows selected run details
- Enter calls onSelectRun
- P toggles pending filter
- Empty state message when no runs

---

### Ticket 12: TaskInspector component
**Files**: `src/cli/tui/components/TaskInspector.tsx`, `tests/tui/task-inspector.test.tsx`
**Description**:
5-tab detail view for a single task:
- Tab bar: [1] Input [2] Output [3] Frames [4] Chat [5] Logs [R] Revert
- Number keys switch tabs
- Tab 1 (Input): Agent, model, output table, retries, timeout, approval, prompt text
- Tab 2 (Output): Persisted output row with structured data
- Tab 3 (Frames): JSX render frame timeline (list of frame snapshots)
- Tab 4 (Chat): Full USER/ASSISTANT conversation from attempt data
- Tab 5 (Logs): Timestamped events filtered to this node
- R key triggers revert action
- Esc goes back

**Tests**:
- Renders with tab bar
- Number keys switch displayed tab
- Each tab renders correct data from adapter
- Esc calls onBack
- R triggers revert (mocked)

---

### Ticket 13: TelemetryView, TriggersView, DataGridView
**Files**: `src/cli/tui/components/TelemetryView.tsx`, `src/cli/tui/components/TriggersView.tsx`, `src/cli/tui/components/DataGridView.tsx`, `tests/tui/telemetry-view.test.tsx`, `tests/tui/triggers-view.test.tsx`, `tests/tui/data-grid-view.test.tsx`
**Description**:
Three remaining views:

TelemetryView:
- Aggregate token usage from all events
- Bar chart using `█`/`░` characters
- Top agents by usage

TriggersView:
- List cron triggers from `adapter.listCrons()`
- Table with ID, schedule, workflow, last run
- Del key removes trigger

DataGridView:
- Left pane: table list (from adapter schema)
- Right pane: query results
- Input bar becomes SQL input
- Tab switches between table list and query
- Selecting table auto-generates SELECT query

**Tests per view**:
- Renders correct data from adapter
- Keyboard navigation works
- Actions (delete trigger, run query) function correctly

---

## Wave 4: App Shell (depends on all above)

### Ticket 14: TuiApp root component and router
**Files**: `src/cli/tui/app.tsx`, `src/cli/tui/state.ts`, `tests/tui/app-router.test.tsx`
**Description**:
Root app component that ties everything together:
- Screen state machine with history stack
- `navigate(screen)` and `goBack()` functions
- Global keyboard handlers (Esc for back, Ctrl+C for exit)
- Mounts StatusBar + RunsSidebar + screen router
- Focus management between sidebar and main area (Tab to toggle)
- Passes adapter, agent, and navigation functions down to children

State types:
```typescript
type Screen =
  | { kind: "chat" }
  | { kind: "dashboard" }
  | { kind: "run-detail"; runId: string }
  | { kind: "task-inspector"; runId: string; nodeId: string | null }
  | { kind: "telemetry" }
  | { kind: "triggers" }
  | { kind: "datagrid" }
```

**Tests**:
- Renders chat view by default
- Navigate to dashboard → renders DashboardView
- Esc from dashboard → returns to chat
- Esc from chat → calls onExit
- History stack tracks navigation depth
- Tab toggles focus between sidebar and main
- Ctrl+C calls onExit from any screen

---

## Dependency Graph

```
Wave 1 (parallel):
  T1: helpers ─────┐
  T2: slash cmds ──┤
  T3: useAgent ────┤
  T4: useRuns ─────┤
  T5: useWorkflows ┘
                    │
Wave 2 (parallel, depends on Wave 1):
  T6: StatusBar ───────┐
  T7: RunsSidebar ─────┤
  T8: MessageBubble ───┤
  T9: ChatInput ───────┘
                        │
Wave 3 (parallel, depends on Wave 2):
  T10: ChatView ─────────┐
  T11: DashboardView ────┤
  T12: TaskInspector ────┤
  T13: Telemetry/etc ────┘
                          │
Wave 4 (depends on all):
  T14: TuiApp root ──────┘
```

## Estimated Sub-Agent Dispatch Plan

- **Wave 1**: 5 agents in parallel (T1-T5)
- **Wave 2**: 4 agents in parallel (T6-T9)
- **Wave 3**: 4 agents in parallel (T10-T13)
- **Wave 4**: 1 agent (T14)

Total: 14 agents across 4 waves.

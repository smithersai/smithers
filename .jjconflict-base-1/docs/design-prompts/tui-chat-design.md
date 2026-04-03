# Design Doc: TUI Chat-First Redesign

**Status**: Draft
**Date**: 2026-03-29

---

## Overview

This document specifies the visual design, component structure, and UX flows for transforming the Smithers TUI from a dashboard into a chat-first interface. All mockups use ASCII art representing what the OpenTUI renderer will produce in a standard 120×40 terminal.

## Color Palette

| Element | Color | Hex/Named |
|---------|-------|-----------|
| App border | Emerald | `#34d399` |
| Panel borders | Teal | `#4bc5a3` |
| User messages | Cyan | `cyan` |
| Assistant messages | White | `white` |
| Slash commands | Yellow | `yellow` |
| Error text | Red | `red` |
| Muted/hint text | Gray | `gray` |
| Selected/active | Green | `green` |
| Status bar bg | Dark gray | `#1a1a2e` |
| Input bar bg | Dark | `#16213e` |

## Typography

- All text is monospace (terminal default)
- Bold for headings and labels via `<b>` / `<strong>`
- Dim for hints and secondary info via gray color

---

## Screen 1: Chat View (Home)

This is the default screen when `smithers tui` launches. The chat view includes a persistent left sidebar showing currently running workflows so the user always has visibility into active work.

```
┌─ Smithers ──────────────────────────────────────────────────────────────────────┐
│ 🟢 claude-opus-4-6 │ 2 active runs │ Chat │ /help for commands                │
├──────────────────────┬──────────────────────────────────────────────────────────┤
│ Active Runs          │                                                          │
│ ─────────────────    │  Welcome to Smithers. Type a message or use /commands.   │
│ ◐ fan-out-fan-in     │                                                          │
│   00:03:42           │  ┌─ You ─────────────────────────────────────────────┐   │
│   validate (4/7)     │  │ Why did my last run fail?                         │   │
│                      │  └───────────────────────────────────────────────────┘   │
│ ◐ code-review        │                                                          │
│   00:01:15           │  ┌─ Smithers ────────────────────────────────────────┐   │
│   research (2/5)     │  │ Your last run `fan-out-fan-in` (ID: abc123)      │   │
│                      │  │ failed at the `validate` task with error:         │   │
│ Recent               │  │                                                   │   │
│ ─────────────────    │  │ ```                                                │   │
│ ✓ pr-shepherd        │  │ TypeError: Cannot read property 'score'          │   │
│   finished 5m ago    │  │ ```                                                │   │
│ ✗ daily-standup      │  │                                                   │   │
│   failed 1h ago      │  │ The `research` task produced output missing the  │   │
│                      │  │ `score` field. Check your Zod schema.            │   │
│                      │  └───────────────────────────────────────────────────┘   │
│                      │                                                          │
│                      │                                                          │
│ [Enter] inspect run  │                                                          │
├──────────────────────┴──────────────────────────────────────────────────────────┤
│ > Type a message... (/ for commands, @ for files)                               │
└─────────────────────────────────────────────────────────────────────────────────┘
```

### Layout Structure

```
<box flexDirection="column" width="100%" height="100%">
  <StatusBar />              <!-- height: 1 row, fixed -->
  <box flexDirection="row" flexGrow={1}>
    <RunsSidebar />          <!-- width: 22 cols, fixed, always visible -->
    <scrollbox flexGrow={1}> <!-- message list, scrollable -->
      <MessageBubble role="user" />
      <MessageBubble role="assistant" />
      ...
    </scrollbox>
  </box>
  <ChatInput />              <!-- height: 1-3 rows, fixed at bottom -->
</box>
```

### Component: RunsSidebar

Persistent left sidebar (22 cols) showing active and recent runs. Polls `adapter.listRuns()` every 2 seconds.

```tsx
<box style={{ width: 22, height: "100%", border: true, borderColor: "#4bc5a3", flexDirection: "column", paddingLeft: 1 }}>
  <text style={{ color: "cyan" }}><b>Active Runs</b></text>
  {activeRuns.map(run => (
    <box key={run.runId}>
      <text style={{ color: "green" }}>◐ {run.workflowName}</text>
      <text style={{ color: "gray" }}>  {elapsed(run)} </text>
      <text style={{ color: "gray" }}>  {run.currentStep} ({run.done}/{run.total})</text>
    </box>
  ))}
  <text style={{ color: "gray", marginTop: 1 }}>Recent</text>
  {recentRuns.map(run => (
    <box key={run.runId}>
      <text style={{ color: run.status === "finished" ? "green" : "red" }}>
        {run.status === "finished" ? "✓" : "✗"} {run.workflowName}
      </text>
      <text style={{ color: "gray" }}>  {run.status} {ago(run)}</text>
    </box>
  ))}
</box>
```

- Active runs: spinning indicator `◐`, elapsed time, current step with progress
- Recent runs: checkmark `✓` or cross `✗`, relative time
- Arrow keys navigate sidebar items, Enter drills into RunDetailView
- Sidebar is visible on ALL screens (chat, dashboard, telemetry, etc.)

### Component: StatusBar

Fixed single row at the top.

```
 🟢 claude-opus-4-6 │ 2 active runs │ Chat │ /help for commands
```

- Left: Agent indicator (green dot = connected, red = no agent) + model name
- Center: Active run count (polled from `adapter.listRuns()`)
- Right: Current screen name + hint

OpenTUI implementation:
```tsx
<box style={{ width: "100%", height: 1, flexDirection: "row", backgroundColor: "#1a1a2e" }}>
  <text style={{ color: "green" }}> ● {agentName} </text>
  <text style={{ color: "gray" }}>│</text>
  <text style={{ color: "white" }}> {activeRuns} active runs </text>
  <text style={{ color: "gray" }}>│</text>
  <text style={{ color: "cyan" }}> {screenName} </text>
  <text style={{ flexGrow: 1 }} />
  <text style={{ color: "gray" }}>/help for commands </text>
</box>
```

### Component: MessageBubble

Each message is a bordered box with a role label in the title.

```tsx
<box
  style={{
    width: "100%",
    border: true,
    borderColor: role === "user" ? "cyan" : "#4bc5a3",
    marginTop: 1,
    paddingLeft: 1,
    paddingRight: 1,
  }}
  title={role === "user" ? "You" : "Smithers"}
>
  {role === "assistant" ? <markdown>{content}</markdown> : <text>{content}</text>}
</box>
```

### Component: ChatInput

Single-line input at the bottom.

```tsx
<box style={{ width: "100%", height: 1, border: true, borderColor: "#34d399" }}>
  <input
    placeholder="Type a message... (/ for commands, @ for files)"
    onSubmit={handleSubmit}
    style={{ flexGrow: 1 }}
  />
</box>
```

### Component: LoadingIndicator

Shown below the last message while agent is generating.

```
  ┌─ Smithers ─────────────────────────────┐
  │ ● ● ● Thinking...                      │
  └─────────────────────────────────────────┘
```

Uses `useTimeline()` hook for animation.

---

## Screen 2: Slash Command Autocomplete Overlay

When user types `/` as the first character, an autocomplete popup appears above the input.

```
┌─ Smithers ──────────────────────────────────────────────────────────────────┐
│ 🟢 claude-opus-4-6 │ 2 active runs │ Chat │ /help for commands            │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ... (chat messages)                                                        │
│                                                                             │
│  ┌─ Commands ───────────────────────────────────────────────────────────┐   │
│  │  Navigation                                                          │   │
│  │  ▶ /dashboard    Browse workflow runs                                │   │
│  │    /telemetry    Global metrics and token usage                      │   │
│  │    /triggers     View cron triggers                                  │   │
│  │    /datagrid     SQL query browser                                   │   │
│  │    /help         Show all commands                                   │   │
│  │                                                                      │   │
│  │  Workflows                                                           │   │
│  │    /hello        workflows/hello.tsx                                  │   │
│  │    /quickstart   workflows/quickstart.tsx                            │   │
│  │    /review       .smithers/workflows/review.tsx                      │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
├─────────────────────────────────────────────────────────────────────────────┤
│ > /da█                                                                      │
└─────────────────────────────────────────────────────────────────────────────┘
```

With filter applied (`/da`):

```
│  ┌─ Commands ───────────────────────────────────────────┐                   │
│  │  ▶ /dashboard    Browse workflow runs                │                   │
│  │    /datagrid     SQL query browser                   │                   │
│  └──────────────────────────────────────────────────────┘                   │
```

### Autocomplete behavior

1. Popup anchored to bottom of message area, directly above input.
2. Arrow Up/Down to navigate, Enter to select and execute, Esc to dismiss.
3. Selected item highlighted in green with `▶` prefix.
4. Fuzzy matching on command name and description.
5. Groups: **Navigation** (built-in screens), **Workflows** (discovered), **Actions** (clear, help).

---

## Screen 3: Dashboard / Runs View

Accessed via `/dashboard` or `/runs`. This is the existing runs list + RunDetailView.

```
┌─ Smithers ──────────────────────────────────────────────────────────────────┐
│ 🟢 claude-opus-4-6 │ 2 active runs │ Dashboard │ Esc to return to chat     │
├─────────────────────────────────────────────────────────────────────────────┤
│ ┌─ Smithers Runs ──────────────┐ ┌─ Run Details ───────────────────────┐   │
│ │                               │ │                                     │   │
│ │  ▶ fan-out-fan-in   running   │ │ ID: abc-123-def                     │   │
│ │    code-review      finished  │ │ Status: running                     │   │
│ │    pr-shepherd      failed    │ │ Duration: 00:03:42                  │   │
│ │                               │ │ Tasks: 4/7 completed                │   │
│ │                               │ │ Tokens: 12,340 IN | 3,210 OUT      │   │
│ │                               │ │                                     │   │
│ │                               │ │ Current: validate                   │   │
│ │                               │ │ Agent: claude-opus-4-6              │   │
│ │                               │ │                                     │   │
│ │                               │ │ Error: none                         │   │
│ │                               │ │                                     │   │
│ │ [N] New  [P] Pending          │ │ [Enter] Inspect  [Esc] Back         │   │
│ └───────────────────────────────┘ └─────────────────────────────────────┘   │
├─────────────────────────────────────────────────────────────────────────────┤
│ > /dashboard                                                                │
└─────────────────────────────────────────────────────────────────────────────┘
```

- Left pane: Run list (40 cols) with status badges
- Right pane: Selected run details
- Enter → drills into RunDetailView (existing component)
- Esc → returns to Chat view
- Input bar stays visible but shows the command that brought you here

---

## Screen 4: Run Detail / Task List

Drilled from Dashboard. This is the existing `RunDetailView` component.

```
┌─ Smithers ──────────────────────────────────────────────────────────────────┐
│ 🟢 claude-opus-4-6 │ Run: abc123 │ Tasks │ Esc to return                   │
├─────────────────────────────────────────────────────────────────────────────┤
│ ┌─ Run Tasks [Esc to Return] ──┐ ┌─ Preview: discover ─────────────────┐   │
│ │                               │ │                                     │   │
│ │  ▶ [ Entire Run ]             │ │ State: finished                     │   │
│ │    discover: finished         │ │ Tokens: 2,100 IN | 890 OUT         │   │
│ │    research: finished         │ │                                     │   │
│ │    validate: in-progress      │ │ --- Terminal Output Snippet ---     │   │
│ │    report: pending            │ │                                     │   │
│ │                               │ │ Found 12 relevant files in the     │   │
│ │                               │ │ repository. Analyzing patterns...  │   │
│ │                               │ │                                     │   │
│ │                               │ │ [Enter] Deep Inspect  [H] Hijack   │   │
│ └───────────────────────────────┘ └─────────────────────────────────────┘   │
├─────────────────────────────────────────────────────────────────────────────┤
│ > Run abc123 - fan-out-fan-in                                               │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Screen 5: Task Inspector

Drilled from Task List. Five sub-views via number keys.

```
┌─ Smithers ──────────────────────────────────────────────────────────────────┐
│ 🟢 claude-opus-4-6 │ Task: discover │ Inspector │ Esc to return            │
├─────────────────────────────────────────────────────────────────────────────┤
│ ┌─ Task Inspector ──────────────────────────────────────────────────────┐   │
│ │ [1] Input  [2] Output  [3] Frames  [4] Chat  [5] Logs    [R] Revert │   │
│ ├───────────────────────────────────────────────────────────────────────┤   │
│ │                                                                       │   │
│ │  Agent: claude-opus-4-6                                               │   │
│ │  Model: claude-opus-4-6                                               │   │
│ │  Output Table: discover                                               │   │
│ │  Retries: 0/3                                                         │   │
│ │  Timeout: 120000ms                                                    │   │
│ │  Approval: not required                                               │   │
│ │                                                                       │   │
│ │  Prompt:                                                              │   │
│ │  ┌────────────────────────────────────────────────────────────────┐   │   │
│ │  │ Discover relevant files in the repository that match the      │   │   │
│ │  │ user's description. Return a list of file paths with brief    │   │   │
│ │  │ explanations of relevance.                                    │   │   │
│ │  └────────────────────────────────────────────────────────────────┘   │   │
│ │                                                                       │   │
│ └───────────────────────────────────────────────────────────────────────┘   │
├─────────────────────────────────────────────────────────────────────────────┤
│ > Inspecting task: discover                                                 │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Screen 6: Telemetry View

Accessed via `/telemetry`.

```
┌─ Smithers ──────────────────────────────────────────────────────────────────┐
│ 🟢 claude-opus-4-6 │ 2 active runs │ Telemetry │ Esc to return             │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  Lifetime Runs: 47        Total Nodes: 312       Failed: 3                  │
│                                                                             │
│  Token Usage (24h)                                                          │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │  Input:  142,800 tokens                                              │   │
│  │  Output:  38,200 tokens                                              │   │
│  │  Cache:   12,400 tokens                                              │   │
│  │                                                                      │   │
│  │  ████████████████████████████░░░░░░  78% input                       │   │
│  │  ███████░░░░░░░░░░░░░░░░░░░░░░░░░░  21% output                      │   │
│  │  ██░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░   1% cache                       │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│  Top Agents by Usage                                                        │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │  claude-opus-4-6     89,200 tokens   ████████████████████            │   │
│  │  codex-gpt-5.3       42,100 tokens   ██████████                      │   │
│  │  gemini-3.1-pro      11,500 tokens   ███                             │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
├─────────────────────────────────────────────────────────────────────────────┤
│ > /telemetry                                                                │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Screen 7: Triggers View

Accessed via `/triggers`.

```
┌─ Smithers ──────────────────────────────────────────────────────────────────┐
│ 🟢 claude-opus-4-6 │ 2 active runs │ Triggers │ Esc to return              │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  Active Cron Triggers                                                       │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │  ID             Schedule      Workflow            Last Run          │   │
│  │  ─────────────────────────────────────────────────────────────────  │   │
│  │  ▶ cron-abc123  */10 * * * *  review.tsx           3 min ago        │   │
│  │    cron-def456  0 9 * * 1-5   daily-standup.tsx    18 hours ago     │   │
│  │    cron-ghi789  0 */6 * * *   health-check.tsx     2 hours ago      │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│  [Del] Remove trigger  [Up/Down] Navigate  [Esc] Back to chat               │
│                                                                             │
├─────────────────────────────────────────────────────────────────────────────┤
│ > /triggers                                                                 │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Screen 8: Data Grid View

Accessed via `/datagrid` or `/sql`.

```
┌─ Smithers ──────────────────────────────────────────────────────────────────┐
│ 🟢 claude-opus-4-6 │ 2 active runs │ Data Grid │ Esc to return             │
├─────────────────────────────────────────────────────────────────────────────┤
│ ┌─ Tables ──────────┐ ┌─ Query Results ─────────────────────────────────┐  │
│ │                    │ │ SELECT * FROM _smithers_runs LIMIT 50          │  │
│ │ ▶ _smithers_runs   │ ├───────────────────────────────────────────────── │  │
│ │   _smithers_nodes  │ │ runId          │ status   │ workflowName       │  │
│ │   _smithers_events │ │ ───────────────┼──────────┼──────────────────  │  │
│ │   _smithers_approva│ │ abc-123-def    │ running  │ fan-out-fan-in     │  │
│ │   discover         │ │ xyz-456-ghi    │ finished │ code-review        │  │
│ │   research         │ │ mno-789-pqr    │ failed   │ pr-shepherd        │  │
│ │   validate         │ │                │          │                    │  │
│ │                    │ │                                                 │  │
│ │                    │ │ 3 rows returned                                 │  │
│ │ [Tab] Switch pane  │ │                                                 │  │
│ └────────────────────┘ └─────────────────────────────────────────────────┘  │
├─────────────────────────────────────────────────────────────────────────────┤
│ > SELECT * FROM _smithers_runs WHERE status = 'failed'█                     │
└─────────────────────────────────────────────────────────────────────────────┘
```

- Left pane: Table list (20 cols)
- Right pane: Query results
- Input bar becomes SQL input when in this view
- Tab switches focus between table list and query input

---

## Screen 9: Workflow Launch

When a user executes a workflow slash command (e.g., `/hello`):

```
┌─ Smithers ──────────────────────────────────────────────────────────────────┐
│ 🟢 claude-opus-4-6 │ 2 active runs │ Chat │ /help for commands            │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌─ You ────────────────────────────────────────────────────────────────┐   │
│  │ /hello                                                               │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│  ┌─ Smithers ───────────────────────────────────────────────────────────┐   │
│  │ Launching workflow **hello** (workflows/hello.tsx)                    │   │
│  │ Run ID: `run-abc-123`                                                │   │
│  │                                                                      │   │
│  │ ● discover .............. finished  ✓                                │   │
│  │ ● research .............. finished  ✓                                │   │
│  │ ● validate .............. running   ◐                                │   │
│  │ ○ report ................ pending                                    │   │
│  │                                                                      │   │
│  │ Use `/dashboard` to see full details.                                │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
├─────────────────────────────────────────────────────────────────────────────┤
│ > Type a message... (/ for commands, @ for files)                           │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Navigation Flow

```
                    ┌─────────────┐
                    │  Chat View  │ ← HOME (default)
                    │  (Screen 1) │
                    └──────┬──────┘
                           │
              ┌────────────┼────────────┬────────────┬────────────┐
              │            │            │            │            │
              ▼            ▼            ▼            ▼            ▼
        ┌───────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐
        │ Dashboard │ │Telemetry│ │Triggers │ │Data Grid│ │  Help   │
        │(Screen 3) │ │(Scrn 6) │ │(Scrn 7) │ │(Scrn 8) │ │(overlay)│
        └─────┬─────┘ └─────────┘ └─────────┘ └─────────┘ └─────────┘
              │
              ▼
        ┌───────────┐
        │ Run Detail│
        │(Screen 4) │
        └─────┬─────┘
              │
              ▼
        ┌───────────┐
        │  Task     │
        │ Inspector │
        │(Screen 5) │
        └───────────┘

  Esc at any level → goes back one level
  Esc at Chat → exits TUI
  /chat from any screen → returns to Chat
```

---

## OpenTUI Component Mapping

| Design Element | OpenTUI Component | Notes |
|---------------|-------------------|-------|
| App shell | `<box>` with border | Root container |
| Status bar | `<box>` with `flexDirection: "row"` | Fixed height 1 |
| Message list | `<scrollbox>` | Auto-scroll to bottom |
| Message bubble | `<box>` with border + title | Colored border per role |
| Markdown response | `<markdown>` | Built-in markdown renderer |
| Chat input | `<input>` | `onSubmit` handler |
| Autocomplete popup | `<box>` absolutely positioned | Over message area |
| Command item | `<text>` | Green when selected |
| Tab bar | `<tab-select>` | For Task Inspector sub-views |
| SQL input | `<input>` or `<textarea>` | In Data Grid mode |
| Table view | `<box>` with `<text>` rows | Manual table formatting |
| Loading dots | `<text>` + `useTimeline()` | Animated dots |
| Bar charts | `<text>` with `█` and `░` chars | In Telemetry view |

---

## Responsive Behavior

- **< 80 cols**: Single-pane mode. Dashboard hides right panel. Autocomplete shrinks.
- **80-120 cols**: Standard two-pane layout for dashboard/datagrid.
- **> 120 cols**: Full layout with generous padding.
- Use `useTerminalDimensions()` hook to detect and adapt.

# PRD: TUI Chat-First Redesign

**Status**: Draft
**Date**: 2026-03-29
**Author**: Auto-generated from codebase analysis

---

## Problem Statement

The Smithers TUI (`smithers tui`) is currently designed as a dashboard — a read-only observability tool for browsing runs, inspecting tasks, and viewing telemetry. Users must leave the TUI to interact with workflows, run commands, or ask questions. This creates friction: the terminal is where developers live, and switching between `smithers tui` (read) and `smithers up` / `smithers ask` (write) breaks flow.

## Vision

Transform the TUI's main screen from a dashboard into a **chat-first interface** — an interactive LLM-powered terminal chat app. The chat is the home screen. Every existing dashboard view becomes a screen navigable via slash commands. Every registered workflow becomes a slash command. The TUI becomes the single pane of glass for both **observing** and **operating** Smithers.

## Goals

1. **Chat as home screen** — The default view when launching `smithers tui` is a chat input, not a runs list.
2. **LLM-powered** — Chat is backed by a real agent (Claude Code, Codex, or Gemini) detected at startup using the existing `agent-detection.ts` system.
3. **Slash commands for navigation** — `/dashboard`, `/runs`, `/telemetry`, `/triggers`, `/datagrid` navigate to existing screens.
4. **Slash commands for workflows** — Every discovered workflow (via `discoverWorkflows()`) is auto-registered as a slash command (e.g., `/review`, `/hello`).
5. **Autocomplete** — Typing `/` surfaces all available commands with fuzzy matching.
6. **File attachment** — Users can reference files in prompts (e.g., `@src/index.ts`).
7. **Preserve all existing functionality** — Dashboard, RunDetailView, Task Inspector, Agent Console, Triggers, Telemetry, Data Grid all remain accessible.

## Non-Goals

- Multi-turn streaming (v1 uses single-turn `agent.generate()`)
- Voice input/output in the TUI
- Remote collaboration features
- Replacing the web-based Burns UI

## User Personas

| Persona | Use Case |
|---------|----------|
| Developer running workflows | Launches TUI, types `/review` to start a code review workflow, watches progress in chat |
| Ops engineer monitoring | Types `/dashboard` to check active runs, `/datagrid` to query the DB |
| Developer debugging | Asks the LLM "why did my last run fail?" — agent queries the DB and explains |
| New user exploring | Types `/` to see all available commands, picks one from the autocomplete list |

## Feature Requirements

### F1: Chat View (Home Screen)

- **Message list**: Scrollable history of user messages and assistant responses.
- **Input bar**: Single-line text input at the bottom with placeholder text.
- **Message rendering**: User messages shown with `[You]` prefix, assistant with `[Smithers]` prefix.
- **Markdown support**: Assistant responses rendered with OpenTUI's `<markdown>` component.
- **Loading indicator**: Spinner/animated dots while agent is generating.
- **Error display**: Agent failures shown inline as red error messages.

### F2: Agent Integration

- **Auto-detect agent**: On TUI launch, run `detectAvailableAgents()` and pick the highest-scored agent.
- **Single-turn generation**: Each user message → `agent.generate({ prompt })` → display response.
- **Context injection**: Automatically include Smithers DB context (active runs, recent failures) in the system prompt so the agent can answer questions about workflow state.
- **Fallback**: If no agent is detected, show a message explaining how to install one and disable chat input.

### F3: Slash Commands — Navigation

| Command | Target Screen | Description |
|---------|--------------|-------------|
| `/dashboard` or `/runs` | Runs pane | Browse workflow runs |
| `/telemetry` or `/metrics` | Telemetry pane | Global metrics and token usage |
| `/triggers` or `/crons` | Triggers pane | View cron triggers |
| `/datagrid` or `/sql` | Data Grid pane | SQL query browser |
| `/chat` or `/home` | Chat view | Return to chat (from any screen) |
| `/help` | Help overlay | Show all available commands |

### F4: Slash Commands — Workflows

- On TUI startup, call `discoverWorkflows(process.cwd())` to get all registered workflows.
- Each workflow `id` becomes a slash command: `/hello`, `/review`, `/quickstart`, etc.
- Executing a workflow slash command:
  1. If the workflow requires input, prompt the user for JSON input in the chat.
  2. Launch the workflow via `runWorkflow()` (or spawn `smithers up <path>` in background).
  3. Automatically switch to a live run view showing progress.
  4. Return to chat when complete, with a summary message.

### F5: Autocomplete

- Triggered when the user types `/` as the first character.
- Shows a popup/overlay listing all available commands.
- Fuzzy-match filter as the user types (e.g., `/da` matches `/dashboard` and `/datagrid`).
- Arrow keys to navigate, Enter to select, Esc to dismiss.
- Commands grouped by category: **Navigation**, **Workflows**, **Actions**.

### F6: File References

- Typing `@` followed by a path triggers file path autocomplete.
- Selected files are read and included in the prompt context sent to the agent.
- Display attached files as chips/tags above the input bar.

### F7: Status Bar

- Persistent bar at the top or bottom showing:
  - Active agent name and model (e.g., `claude-opus-4-6`)
  - Number of active runs
  - Current screen name
  - Keyboard shortcut hints

### F8: Active Runs Sidebar

- Persistent left sidebar visible on **every screen** (chat, dashboard, telemetry, etc.).
- Shows currently running workflows with elapsed time, current step, and progress (e.g., "4/7 tasks").
- Shows recent completed/failed runs with relative timestamps.
- Polls `adapter.listRuns()` every 2 seconds for live updates.
- Arrow keys navigate sidebar items; Enter drills into the RunDetailView for that run.
- Width: 22 columns, collapsible on narrow terminals (< 80 cols).

### F9: Keyboard Shortcuts (Global)

| Key | Action |
|-----|--------|
| `Ctrl+C` | Exit TUI |
| `Esc` | Back to previous screen / dismiss overlay |
| `/` (when input empty) | Open command palette |
| `Ctrl+L` | Clear chat history |

## Success Metrics

- User can complete a full workflow cycle (discover → run → monitor → debug) without leaving the TUI.
- Chat responses return within the agent's generation time (no added latency).
- All existing dashboard functionality remains accessible and unchanged.

## Rollout

- **Phase 1**: Chat view + agent integration + navigation slash commands (this PRD).
- **Phase 2**: Workflow slash commands with input prompting and live progress.
- **Phase 3**: File references, advanced autocomplete, multi-turn context.

## Open Questions

1. Should chat history persist across TUI sessions (store in smithers.db)?
2. Should the agent have tool access (bash, read, write) or just generate text?
3. Should workflow slash commands accept inline JSON input (e.g., `/review {"pr": 123}")?

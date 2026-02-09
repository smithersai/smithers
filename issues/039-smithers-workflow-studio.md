# 039: Smithers Workflow Studio — First-Class Workflow Execution & Monitoring in the Editor

## Summary

Make Smithers workflows the premier feature of the desktop app. The editor should be the best place to create, run, monitor, debug, schedule, and self-heal AI workflows. Today the workflow engine (`packages/core`) and web UI (`packages/ui`) exist as standalone Bun services with no integration into the native macOS app. This issue covers bridging that gap — deeply embedding workflow orchestration into the editor experience.

## Status Quo

### What exists

- **Workflow engine** (`packages/core`): JSX-based declarative AI workflow framework running on Bun. Supports `<Task>`, `<Sequence>`, `<Parallel>`, `<Branch>`, `<Ralph>` (loops). Durable state in per-run SQLite databases. Full agent tool calling (read, write, edit, grep, bash). Approval gates. Retry/resume. VCS snapshots via jj.
- **RPC surface** (`packages/shared/src/rpc.ts`): 20+ procedures — `runWorkflow`, `listRuns`, `getRunEvents`, `approveNode`, `cancelRun`, `resumeRun`, `getFrame`, `queryRunDb`, etc.
- **CLI** (`src/cli/index.ts`): `run`, `resume`, `approve`, `deny`, `status`, `frames`, `list`, `graph`, `revert` commands.
- **Web UI** (`packages/ui`): SolidJS views — `WorkflowsView`, `RunsView`, `Inspector` with graph visualization, event timeline, output viewer, approval buttons.
- **Plugin system**: `BunPlugin` interface for custom tools, RPC handlers, DB migrations, UI panels.

### What's missing

- **Zero integration with the native desktop app.** No way to run, view, or monitor workflows from within the editor.
- **No scheduling/cron.** Workflows are ad-hoc only — no recurring automations.
- **No AI-assisted workflow creation.** Users must hand-write `.tsx` files.
- **No self-healing.** When a workflow fails, it stays failed until a human intervenes.
- **No observability dashboard.** No aggregate view of workflow health across a workspace.

---

## Design

### Part 1: Runtime Bridge — Connect the Desktop App to the Workflow Engine

**Goal:** The Swift app spawns and communicates with the Bun workflow runtime, just like it already does with `codex-app-server` via JSON-RPC over stdio.

#### 1.1 Process Management

- `SmithersRuntimeService.swift` — new service class (mirroring `CodexService.swift`)
- Spawns `bun run packages/core/src/runtime.ts` (or a bundled binary) as a child process
- JSON-RPC 2.0 over stdio (reuse `JSONRPCTransport.swift`)
- Lifecycle: start on workspace open, restart on crash with backoff, kill on workspace close
- Pass workspace root as `--root` argument for file sandboxing

#### 1.2 RPC Client

- Swift types mirroring `packages/shared/src/rpc.ts` DTOs:
  - `WorkflowRef`, `RunSummaryDTO`, `RunDetailDTO`, `SmithersEventDTO`, `FrameDTO`, `NodeStateDTO`
- Typed async methods: `listWorkflows()`, `runWorkflow(path:input:)`, `cancelRun(id:)`, `approveNode(runId:nodeId:)`, etc.
- Event stream subscription via server-initiated JSON-RPC notifications (workflow events)

#### 1.3 State Sync

- `WorkspaceState.swift` gains workflow-related published properties:
  - `@Published var workflows: [WorkflowRef]`
  - `@Published var activeRuns: [RunSummaryDTO]`
  - `@Published var selectedRun: RunDetailDTO?`
- Polling + push: initial list via RPC, incremental updates via event notifications

---

### Part 2: Workflow Panel — Native UI for Monitoring & Control

**Goal:** A dedicated panel in the editor for workflow lifecycle management.

#### 2.1 Workflows Sidebar Section

- New collapsible section in `FileTreeSidebar.swift` (below file tree) or a dedicated tab
- Lists all `.tsx` workflow files discovered in workspace
- Each row: workflow name, file path, "Run" button
- Click to open the workflow file in the editor
- Right-click context menu: Run, Run with input, View runs, Open in terminal

#### 2.2 Runs Panel (URL scheme: `smithers-run://`)

- New tab type in the editor area, opened when a run starts or user clicks a run
- **Header**: Run ID, workflow name, status badge (running/finished/failed/waiting-approval), elapsed time, start time
- **Graph View**: Visual DAG of workflow nodes — color-coded by state (grey=pending, blue=in-progress, green=finished, red=failed, yellow=waiting-approval, striped=skipped)
- **Event Timeline**: Scrolling list of events with timestamps, expandable details
- **Output Inspector**: Tab per output table, rendered as a native table view
- **Approval Actions**: Prominent Approve / Deny buttons when a node is waiting
- **Controls**: Cancel, Resume, Revert buttons in toolbar
- **Live Streaming**: Real-time `NodeOutput` events shown as streaming text (like terminal output) for agent tasks

#### 2.3 Runs List

- Accessible via Command Palette ("Show Workflow Runs") or sidebar
- Filterable by status: active, finished, failed, waiting-approval
- Sortable by start time, duration
- Bulk actions: cancel all active, clean up old runs

#### 2.4 Toast / Notification Integration

- Workflow completion → toast notification ("workflow-name finished in 2m 30s")
- Failure → toast with "View" button to jump to run panel
- Approval request → persistent banner or badge on workflow sidebar section
- Optional: macOS system notifications for background workflows

---

### Part 3: AI-Powered Workflow Creation

**Goal:** Users describe what they want in natural language; the AI generates a complete `.tsx` workflow file.

#### 3.1 Workflow Generator via Chat

- New chat command: `/workflow <description>` or dedicated "Create Workflow" action
- Codex agent has Smithers JSX component knowledge injected as context (component docs, examples, Drizzle schema patterns)
- Flow:
  1. User describes intent: "every morning, scan for TODO comments in my codebase and file GitHub issues"
  2. Agent generates complete `.tsx` file with: Drizzle schema, agent configuration, task graph, proper input/output types
  3. Preview shown as a diff — user approves → file written to `workflows/` directory
  4. Option to immediately run a test execution

#### 3.2 Workflow Templates

- Built-in template gallery accessible from Command Palette or welcome screen
- Templates for common patterns:
  - **Code Review Loop** — Ralph-based iterative review + fix cycle
  - **CI/CD Pipeline** — Sequential build → test → deploy
  - **Data Pipeline** — Parallel fetch → transform → load
  - **Monitoring** — Periodic health check with alerting
  - **Report Generator** — Collect data → analyze → produce formatted output
  - **Self-Healing Service** — Watch logs → detect anomalies → apply fixes
- Each template is a parameterized `.tsx` file with placeholders

#### 3.3 Inline Workflow Editing Assistance

- When editing a `.tsx` workflow file, the editor provides:
  - Autocomplete for Smithers JSX components (`<Task>`, `<Sequence>`, `<Parallel>`, `<Branch>`, `<Ralph>`)
  - Inline validation: detect missing `id` props, invalid `output` table references, circular dependencies
  - "Run this workflow" CodeLens-style button above `export default smithers(...)` line
  - Schema generation: from a natural language description of desired output columns, generate the Drizzle table definition

---

### Part 4: AI Scheduling & Cron Jobs

**Goal:** Workflows can run on schedules — daily reports, hourly health checks, event-triggered automations.

#### 4.1 Schedule Configuration

- New `smithers.config.ts` (or YAML) in workspace root:
  ```ts
  export default {
    schedules: [
      {
        workflow: "./workflows/daily-review.tsx",
        cron: "0 9 * * 1-5",           // weekdays at 9am
        input: { repo: "main" },
        timeout: "30m",
        onFailure: "retry-once",        // or "notify", "self-heal"
        notify: ["toast", "slack"],
      },
      {
        workflow: "./workflows/health-check.tsx",
        cron: "*/15 * * * *",           // every 15 minutes
        input: {},
        onFailure: "self-heal",
        selfHealPrompt: "Analyze the failure, identify the root cause, and apply a fix",
      },
    ],
  };
  ```

#### 4.2 Scheduler Service

- New `SchedulerService` in `packages/core`:
  - Parses cron expressions (use `cron-parser` or similar)
  - Maintains next-fire-time priority queue
  - On tick: calls `SmithersService.runWorkflow()` with configured input
  - Persists schedule state to AppDb (last run, next run, consecutive failures)
- Desktop app shows scheduled workflows in sidebar with next-run countdown
- Manual "Run Now" override button

#### 4.3 Schedule Management UI

- Sidebar section: "Scheduled Workflows" with enable/disable toggles
- Schedule editor: visual cron builder or plain text with preview ("Next run: tomorrow at 9:00 AM")
- Run history per schedule: success rate, average duration, failure trends

---

### Part 5: Self-Healing & Auto-Recovery

**Goal:** When a workflow fails, the system can automatically diagnose and fix the issue — or at minimum, triage and report.

#### 5.1 Failure Analysis Agent

- On workflow failure, optionally spawn a diagnostic agent that:
  1. Reads the failed task's error, stack trace, and last agent conversation
  2. Reads the workflow source code
  3. Reads relevant workspace files (guided by error context)
  4. Produces a structured diagnosis: root cause, suggested fix, confidence level
- Diagnosis stored as a special output on the run

#### 5.2 Auto-Fix Pipeline

- If `onFailure: "self-heal"` is configured:
  1. Run the Failure Analysis Agent
  2. If confidence > threshold, apply the suggested fix (edit workflow or workspace files)
  3. Resume the run from the failed node
  4. If the fix fails, escalate to human (toast + approval gate)
- All auto-fix attempts logged with full diff for auditability
- jj integration: each fix attempt is a separate VCS snapshot for easy revert

#### 5.3 Degradation Modes

- `retry-once` → Simple retry of the failed node
- `retry-with-backoff` → Exponential backoff retries
- `self-heal` → Full diagnostic + fix cycle
- `notify` → Alert human, pause run
- `fallback` → Run an alternative workflow path
- Configurable per-task via `onFail` prop or per-schedule in config

---

### Part 6: Observability Dashboard

**Goal:** Aggregate view of workflow health across the workspace — the "ops center" for AI automations.

#### 6.1 Dashboard View (URL scheme: `smithers-dashboard://`)

- **Overview Cards**: Total runs today, success rate, active runs, pending approvals
- **Timeline**: Gantt-like chart of recent runs with duration bars, color-coded by status
- **Failure Log**: Recent failures with one-click jump to run detail
- **Approval Queue**: All pending approvals across all workflows, sorted by urgency
- **Resource Usage**: Token consumption, tool call counts, agent time per workflow

#### 6.2 Alerts & Thresholds

- Configurable alerts:
  - Workflow failure rate exceeds X% over Y period
  - Run duration exceeds expected baseline by Z%
  - Token spend exceeds budget
- Alert channels: toast, macOS notification, Slack/Telegram (via webhook), email

#### 6.3 Reporting

- AI-generated daily/weekly summaries:
  - "12 workflows ran this week. 2 failures in `health-check` (API timeout — self-healed). `daily-review` produced 5 reports. Total: 45k tokens."
- Export run data as JSON/CSV for external analysis
- Trend charts: success rate over time, duration distribution, token spend

---

### Part 7: Agent-in-the-Loop — AI Cron Monitoring

**Goal:** A persistent background agent that watches workflow health and proactively takes action.

#### 7.1 Workflow Supervisor Agent

- Long-running agent (not a workflow itself) that:
  - Subscribes to all workflow events
  - Detects patterns: repeated failures, increasing durations, stuck approvals
  - Can trigger actions: restart stale runs, ping for approvals, adjust schedules
  - Produces periodic health reports
- Runs as a background Codex session (ties into issue #007 background agents)

#### 7.2 Proactive Improvement Suggestions

- After N runs of a workflow, the supervisor can:
  - Identify common failure modes and suggest hardening
  - Recommend caching strategies for expensive agent calls
  - Suggest splitting large workflows into smaller, composable pieces
  - Detect unused output columns and recommend schema cleanup
- Suggestions surfaced as non-blocking notifications or a dedicated "Suggestions" panel

#### 7.3 Self-Improving Workflows

- Experimental: workflows that refine their own prompts based on output quality
  - After each run, a meta-agent evaluates output quality
  - If below threshold, rewrites task prompts with improvements
  - Changes tracked in jj for rollback
  - Human approval gate before applying prompt changes

---

## Implementation Phases

### Phase 1: Runtime Bridge (Foundation)
- `SmithersRuntimeService.swift` — process management + JSON-RPC
- Swift RPC client types
- `WorkspaceState` workflow properties
- Basic "list workflows" in sidebar

### Phase 2: Run & Monitor
- Run workflow from sidebar/command palette with input dialog
- Runs panel with event timeline + status badges
- Approval flow (approve/deny buttons)
- Toast notifications for completion/failure

### Phase 3: Workflow Graph Visualization
- DAG renderer for workflow node graph
- Real-time state updates on nodes
- Output table inspector
- Tool call log viewer
- Agent conversation viewer (streaming)

### Phase 4: AI Workflow Creation
- `/workflow` chat command for generating `.tsx` files
- Template gallery
- Inline editing assistance (autocomplete, validation, run button)

### Phase 5: Scheduling
- `smithers.config.ts` schedule format
- `SchedulerService` in core
- Schedule management UI in sidebar
- Run history per schedule

### Phase 6: Self-Healing
- Failure Analysis Agent
- Auto-fix pipeline with confidence thresholds
- Degradation mode configuration
- Fix audit trail with jj snapshots

### Phase 7: Observability & Supervisor
- Dashboard view with aggregate metrics
- Alert thresholds and notification channels
- Workflow Supervisor Agent (background)
- AI-generated reports and improvement suggestions

---

## Technical Notes

### Why not embed the SolidJS web UI via WebView?

We could ship the existing `packages/ui` inside a `WKWebView`, but native SwiftUI views are preferable because:
- Consistent look and feel with the rest of the editor (themes, typography, spacing)
- Native macOS interactions (drag-and-drop, context menus, keyboard shortcuts)
- No web-to-native bridge complexity for approval actions and file navigation
- Better performance for real-time event streaming
- The web UI can remain as a standalone option for remote/headless use

### RPC transport

Reuse the existing `JSONRPCTransport.swift` pattern. The workflow runtime exposes the same RPC surface already defined in `packages/shared/src/rpc.ts`. We just need a Bun-side stdio adapter (the current runtime likely uses HTTP — add a `--stdio` flag for embedded mode).

### Workflow file detection

Use the existing `WorkspaceService.ts` glob pattern (`**/*.tsx` excluding `node_modules`, `.git`, etc.). The desktop app's file watcher can also detect new/changed workflow files and refresh the sidebar.

### Database access

Each workflow run has its own SQLite database. The `queryRunDb` RPC allows arbitrary SQL — useful for the output inspector and debugging. The AppDb (workflow_runs, workflow_events, etc.) is the central index.

---

## Open Questions

1. **Notification channels**: Should we support Slack/Telegram/email out of the box, or rely on workflow tasks to send notifications (more flexible but more work per workflow)?
2. **Multi-workspace**: If multiple workspaces are open, should there be one global scheduler or per-workspace? (Probably per-workspace, matching the current `WorkspaceService` design.)
3. **Remote execution**: Should workflows always run locally, or should we support remote execution (cloud workers, SSH boxes) for resource-intensive tasks?
4. **Workflow marketplace**: Should users be able to publish/share workflows like npm packages? (Deferred — but worth designing the module system to support it.)
5. **Cost controls**: Should there be a hard token budget per workflow/schedule to prevent runaway agent spend?

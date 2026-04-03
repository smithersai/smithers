# Product Requirements Document: Smithers DevTools

## Problem

Today, the only way to understand what a running Smithers workflow is doing is to have an agent read the SQLite database and report back. There is no visual interface for watching workflows execute, no way to inspect task details without writing queries, and no way to intervene in a running workflow without restarting it or relying on hot-reload. This is unacceptable for a workflow engine that targets external adopters.

## Vision

Smithers DevTools is a real-time visual debugging and monitoring interface for Smithers workflows. It gives you full observability into every layer of a running workflow — from the high-level DAG down to individual agent chat logs and tool calls — without needing an agent as intermediary. It also enables direct intervention: retrying failed tasks, editing inputs, and steering agent conversations mid-run.

## Target User

Smithers adopters — developers building and operating multi-agent workflows with Smithers. The devtools must be polished and self-explanatory, not an internal debugging hack.

## Delivery Surfaces

### 1. Electrobun Native App (GUI — primary)

A native desktop application built with [Electrobun](https://github.com/blackboardsh/electrobun) — a Bun-first desktop framework using CEF or native webview. The devtools frontend is a web app running inside Electrobun's renderer with full browser capabilities (SSE, WebSocket, fetch). The Bun main process can also access SQLite directly for deep queries. Typed RPC between the main process and webview handles any native-layer needs.

### 2. Pi Plugin TUI (secondary)

A text-based interface delivered through the existing Pi plugin. Mirrors as many GUI features as possible in a terminal context. The Pi plugin already has MCP bridging and HTTP client connectivity to Smithers — devtools extends this with richer inspection and control commands.

Both surfaces consume the same data from the same backend (HTTP API, SSE streams, SQLite, Prometheus metrics). No new protocols are required for v1.

## Package Architecture

Smithers DevTools ships as a separate internal package (`@smithers/devtools`) that is a dependency of the main `smithers-orchestrator` package. From the user's perspective, devtools is included out of the box — no additional install step.

## Core Experience

### Main View: Live Workflow Tree

The primary view is the React fiber tree — the literal component tree that Smithers' reconciler produces — rendered as a live, interactive graph. This is the first thing you see when you open devtools. Since Smithers *is* React, the fiber tree *is* the workflow structure.

- **Nodes** represent Smithers host fibers: `smithers:workflow`, `smithers:task`, `smithers:sequence`, `smithers:parallel`, `smithers:loop`, `smithers:branch`, `smithers:approval`, `smithers:worktree`, `smithers:merge-queue`
- **Edges** represent parent-child relationships in the fiber tree and execution dependencies
- **Node state** is reflected visually in real-time: pending, running, finished, failed, retrying, waiting-approval, skipped, cancelled
- **Props** from each fiber's `memoizedProps` are inspectable — `__smithersKind`, agent references, labels, output schemas, iteration counts
- **Re-render tracking** — see when the tree updates (frame commits), what changed between renders
- **Layout** follows the natural nesting of the workflow definition — sequences flow top-to-bottom, parallel groups fan out horizontally
- The tree updates live as the engine emits events via SSE

#### Loop Handling

Loops are represented as a single collapsible node showing the current iteration with a badge (e.g., "47/100"). Clicking expands to show the current iteration's subgraph. Users can browse previous iterations through a selector. The tree does not render all iterations simultaneously — only the selected one.

### Secondary View: Timeline

A horizontal timeline/Gantt view showing every task execution across all iterations and parallel branches. This gives a historical, temporal view complementary to the structural tree view. Useful for understanding performance, identifying bottlenecks, and reviewing past loop iterations.

## Node Drill-Down

Clicking any node in the tree opens a detail panel with full observability. Everything the system knows about that node should be accessible — clean top-level summary with the ability to drill into progressively deeper detail.

### Level 1: Summary

- Node type, ID, label
- Current status and duration
- Agent name and model
- Iteration number (if inside a loop)
- Output data preview (structured output from schemas/tables)

### Level 2: Execution Detail

- **Prompt**: the fully rendered MDX prompt that was sent to the agent
- **Chat log**: the full agent conversation (messages sent and received), read from the agent's native storage (Claude Code, Codex, Gemini, etc. each store conversations differently — devtools uses agent-specific adapters to locate and read them)
- **Tool calls**: ordered list of every tool call — name, arguments, result, duration
- **Token usage**: input/output/cache tokens, per-attempt and cumulative
- **Attempts**: if retried, each attempt shown separately with its own prompt/response/error
- **Timing**: start time, end time, wall-clock duration, time spent waiting for dependencies or approval

### Level 3: State & Context

- **Approval state**: who approved/denied, when, reason
- **Error details**: failure message, stack trace, which attempt failed
- **Dependencies**: which nodes this node waited on, what data it received
- **Worktree context**: if running in a worktree — ID, path, branch, base branch
- **Cache**: whether the result was cached, cache key, cache hit/miss
- **Raw fiber props**: the underlying React fiber's `memoizedProps` for advanced debugging

## Steering (v2 — design for it in v1)

The devtools should not only observe but also control running workflows. These features require new Smithers engine APIs and will be built incrementally, but the devtools architecture must support them from day one.

### Planned Steering Capabilities

- **Retry**: re-run a failed node with the same or modified inputs
- **Edit & retry**: change a node's prompt, agent, parameters, or other inputs before retrying
- **Chat follow-up**: open a conversation with a completed or failed node — send additional messages, ask it to revise its output, give it new instructions. Requires a new engine capability to start a chat session with a previous node ID.
- **Roll back subgraph**: mark a node's output as invalid, cascade-cancel downstream nodes that consumed it, and re-run from that point
- **Force-approve / force-deny**: manually resolve approval gates from the devtools
- **Skip node**: mark a pending node as skipped so the workflow proceeds without it

### Engine APIs Required

The Smithers engine needs new capabilities to support steering:

- `POST /v1/runs/:runId/nodes/:nodeId/retry` — retry with optional input overrides
- `POST /v1/runs/:runId/nodes/:nodeId/chat` — send a follow-up message to an agent session
- `POST /v1/runs/:runId/nodes/:nodeId/skip` — skip a pending node
- `POST /v1/runs/:runId/nodes/:nodeId/rollback` — invalidate output and cascade
- Agent session persistence — today agents are fire-and-forget child processes; steering requires the ability to resume or message a session by node ID

## Multi-Run Dashboard

When connected to a Smithers server (or reading from SQLite), the devtools shows a list of all runs:

- Run ID, workflow name, status, start time, duration
- Active runs at the top with live status
- Click any run to open its tree view
- Filter by status, workflow name, date range

## Metrics & Observability Integration

The devtools has full access to all Prometheus metrics that Smithers exposes. Every metric defined in the engine is available in the devtools.

### Run-Level Metrics

- Token usage (input, output, cache read, cache write, reasoning) aggregated by run, agent, and model
- Task success/failure/retry rates
- Task and attempt duration (with p50/p95/p99 from histograms)
- Active concurrency vs. configured limits
- Cache hit/miss rates
- Cost estimation (if token pricing is available)

### System Metrics

- Process memory (RSS, heap)
- Uptime
- DB query latency
- HTTP request latency and counts
- Scheduler queue depth and concurrency utilization
- Hot-reload counts and failures

### Agent & Tool Metrics

- Tool call counts, durations, and error rates
- Per-tool breakdown (which tools are called most, which are slowest)
- Prompt and response sizes
- Token usage per model and per agent
- Output truncation events

### Visualization

Metrics are shown as:
- Summary cards on the multi-run dashboard
- Overlays on the tree view (e.g., color nodes by duration, size by token cost, highlight expensive agents)
- Dedicated metrics panel with time-series charts for any metric
- Per-node metric badges (tokens used, duration, retry count)

The devtools reads metrics from the `GET /metrics` Prometheus endpoint and can also consume them from the existing OpenTelemetry pipeline if configured.

## Chat Log Adapters

Each agent type stores conversation transcripts in its own format and location. The devtools includes adapters for reading chat logs from each supported agent:

- **Claude Code**: reads from Claude Code's native conversation storage
- **Codex**: reads from Codex's conversation storage
- **Gemini CLI**: reads from Gemini's conversation storage
- **Custom agents**: extensible adapter interface so users can add support for their own agent types

The adapter interface is part of the `@smithers/devtools` package API, allowing third-party agent integrations to provide their own chat log reader.

## Connectivity

The devtools connects to Smithers using existing infrastructure:

| Mechanism | Used For |
|-----------|----------|
| `GET /v1/runs` | List all runs |
| `GET /v1/runs/:runId` | Run status + node summary |
| `GET /v1/runs/:runId/events` (SSE) | Real-time event stream for live tree updates |
| `GET /v1/runs/:runId/frames` | Render frame history |
| `POST /v1/runs/:runId/nodes/:nodeId/approve` | Approve from devtools |
| `POST /v1/runs/:runId/nodes/:nodeId/deny` | Deny from devtools |
| `GET /metrics` | All Prometheus metrics |
| SQLite (direct) | Deep queries — attempts, tool calls, output data, chat logs |

The Electrobun app connects via HTTP to the Smithers server. The Bun main process can also read SQLite directly for deep queries (same pattern as the CLI).

## Non-Goals for v1

- **Workflow editor** — devtools is for observing and debugging, not authoring workflows
- **Multi-machine distributed view** — v1 assumes a single Smithers instance
- **Mobile app** — desktop only via Electrobun
- **Alerting/paging** — use Grafana/PagerDuty with the existing Prometheus metrics for that
- **Steering** — designed for but not implemented in v1 (requires engine API work)

## Success Criteria

1. A Smithers user can open the devtools app, see their running workflow as a live tree, and understand what every node is doing without asking an agent
2. A user can click any task node and see its full chat log, tool calls, and output within 2 clicks
3. A user can approve/deny pending nodes directly from the devtools
4. A user can browse past loop iterations without the tree becoming overwhelming
5. All Prometheus metrics are accessible and visualized in the devtools
6. The Pi plugin TUI provides equivalent inspection capabilities (list runs, show node details, browse tool calls) via text commands
7. Devtools adds zero overhead to workflows that aren't using it — it's a read-only consumer of existing data streams

## Open Questions

1. **Graph layout algorithm** — what library/approach for rendering a live, animated DAG that handles the variety of Smithers workflow shapes (deep sequences, wide parallel fans, nested loops)?
2. **Agent chat log formats** — what exactly does each agent store and where? Need to audit Claude Code, Codex, and Gemini CLI conversation storage to design the adapter interface.
3. **Agent session persistence for steering** — what's the feasibility of keeping agent sessions alive or resumable? This varies significantly by agent type and is the main blocker for v2 steering features.
4. **Internal builder parity** — do all workflow sources produce identical fiber trees, or are there internal differences the devtools needs to account for?

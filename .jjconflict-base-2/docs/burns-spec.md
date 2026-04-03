# Burns Specification

> Status note: this document describes the target product direction. For implementation-accurate docs, use `README.md`, `docs/codebase-layout.md`, and `docs/daemon-api-reference.md`.

## Document type

Reference-style product and technical specification for the first implementation of **Burns**.

## Audience

Developers designing and implementing the Burns desktop/web app and its local backend services.

## Goal

Define a practical V1 for **Burns**, a workspace-first control plane for Smithers that can:

- manage multiple repos/workspaces
- author and edit Smithers workflows
- start, monitor, resume, and cancel workflow runs
- review live events and frame history
- handle human approvals
- supervise long-running orchestration with health and recovery features inspired by `takopi-smithers`

## Scope

This spec focuses on:

- orchestration functionality
- workspace management
- workflow authoring
- workspace flows for workflows, runs, events, and approvals
- useful patterns borrowed from `takopi-smithers`

This spec does **not** fully define:

- billing or multi-tenant SaaS concerns
- cloud sync
- permissions beyond local/operator auth
- final visual design system details
- a marketplace or workflow sharing platform

---

# 1. Product summary

## 1.1 What Burns is

Burns is a GUI and local control plane for Smithers.

It gives an operator one place to:

- register repos as managed workspaces
- keep workflow files under each repo at `.smithers/workflows`
- scaffold and edit workflows with agent assistance
- launch runs against a selected workspace
- watch live run progress through Smithers events and frames
- approve or deny gated nodes
- supervise the runtime health of local Smithers servers and active runs

## 1.2 Product positioning

Burns should be closer to **`takopi-smithers`** than to a simple run dashboard.

That means the product is:

- **workspace-first**, not run-first
- **supervision-oriented**, not just observability-oriented
- **operator-centric**, with health, restart, logs, and recovery surfaces
- **workflow-authoring capable**, not only a passive monitor

## 1.3 Core value proposition

An operator can move from repo setup to workflow editing to run supervision without leaving the app.

---

# 2. Primary users

## 2.1 Solo operator

A developer or technical operator who manages multiple local repos and wants a visual way to run and supervise Smithers workflows.

## 2.2 Workflow author

A developer who writes or iterates on Smithers workflows and needs a code viewer/editor plus a chat-assisted workflow editing loop.

## 2.3 Approver

A human reviewer who needs to inspect pending gates and approve or deny nodes with notes.

---

# 3. Design principles

1. **Workspace first**: everything meaningful happens in the context of a selected repo.
2. **Smithers-native**: use Smithers concepts and APIs directly instead of inventing parallel orchestration abstractions.
3. **Local by default**: operate safely against local repos and local services first.
4. **Observable and controllable**: every run should be easy to inspect, resume, cancel, or approve.
5. **Authoring in context**: workflows live with the code they automate.
6. **Operational resilience**: expose heartbeat, health, logs, and restart/recovery patterns.

---

# 4. Information architecture

## 4.1 Global navigation

- **Workflows**
- **Add workspace**
- **Settings**

## 4.2 Workspace selector

A persistent selector shows the active workspace and lets the user switch between managed repos.

## 4.3 Workspace-scoped pages

For the selected workspace:

- **Overview**
- **Runs**
- **Approvals**

## 4.4 Notes

- There is no separate Code page in the current IA.
- Workflow authoring happens on the global **Workflows** page, but it is always bound to the currently selected workspace.

---

# 5. Functional areas

## 5.1 Workspaces

Burns must manage a registry of workspaces.

A workspace is a local repo plus the metadata needed to operate Smithers against it.

Each workspace includes:

- display name
- local filesystem path
- git remote metadata when available
- default branch
- workspace status and health
- configured Smithers server information
- default CLI agent for workflow scaffolding/editing
- location of workflow files at `.smithers/workflows`

### Supported workspace creation modes

When adding a workspace, the user must be able to:

1. **Add existing local repo**
2. **Clone GitHub repo into the Burns workspace root**
3. **Create a new repo in the Burns workspace root**

### Workspace setup flow

The Add workspace flow has four steps:

1. **Workspace**
   - workspace name
   - optional description
2. **Source**
   - choose folder
   - clone repo
   - create new
3. **Workflows**
   - choose starter workflows/templates to include
4. **Confirm**
   - review path, source, selected agent, and included workflows

### Workspace responsibilities

A workspace must provide enough information for Burns to:

- resolve workflow paths safely inside the workspace root
- launch Smithers runs against local workflow files
- show run history and current status
- connect approvals and event streams back to the repo context
- support workspace-specific supervision and recovery

---

## 5.2 Workflow authoring

Workflows are stored inside each workspace at:

```txt
<workspace>/.smithers/workflows
```

### Workflow page requirements

The Workflows page must include:

- a **workflow list/table** on the left
- a **workflow viewer/editor** on the right
- a **chat box** below the viewer for prompting updates

### Authoring capabilities

Burns should support:

- browsing workflow files in `.smithers/workflows`
- viewing syntax-highlighted Smithers workflow code
- creating a new workflow
- saving edits
- agent-assisted edits from chat prompts
- template insertion for common Smithers patterns
- validation feedback for malformed workflow files where possible

### Authoring conventions

Burns should guide authors toward Smithers best practices:

- keep task IDs stable for resume support
- prefer structured output schemas
- use approval gates for sensitive actions
- keep larger workflows modular
- preserve hot-reload-safe edits where possible

### Agent-assisted editing

The workflow chat box should support prompts like:

- “Add an approval gate before deploy”
- “Split this loop into plan, implement, validate”
- “Convert prompt text into an MDX prompt file”
- “Keep task IDs stable while refactoring”

Agent edits should be reviewable before save.

---

## 5.3 Orchestration functionality

Burns is not just a file editor. It is an orchestration surface for Smithers.

### Required orchestration actions

For a selected workflow and workspace, the app must support:

- start run
- resume run
- cancel run
- inspect current run state
- inspect live events
- inspect frame history
- approve or deny waiting nodes
- reopen historical runs

### Smithers backend contract

Burns should build around the documented Smithers HTTP server interface.

Core routes:

- `POST /v1/runs`
- `POST /v1/runs/:runId/resume`
- `POST /v1/runs/:runId/cancel`
- `GET /v1/runs/:runId`
- `GET /v1/runs/:runId/events`
- `GET /v1/runs/:runId/frames`
- `POST /v1/runs/:runId/nodes/:nodeId/approve`
- `POST /v1/runs/:runId/nodes/:nodeId/deny`
- `GET /v1/runs`

### Server expectations

Burns should assume Smithers is started with a configuration equivalent to:

- `authToken` enabled for protected deployments
- `rootDir` narrowed to the intended workspace or workspace root set
- server-level SQLite `db` configured to support aggregated run listing
- `allowNetwork: false` by default unless explicitly required

### Orchestration model

At runtime, Burns needs to manage four layers:

1. **Workspace**
2. **Workflow**
3. **Run**
4. **Node/Event/Approval**

This must be visible in the UI and persisted in the local Burns state.

---

## 5.4 Workspace flows

### 5.4.1 Workflow flow

The workflow flow starts when a workspace is selected.

The operator can:

- view all workflows in `.smithers/workflows`
- select one workflow
- inspect the code
- prompt for modifications
- save changes
- start a run from that workflow

### 5.4.2 Run flow

A run is an execution instance of a workflow for a workspace.

The operator can:

- start a new run
- supply input payload
- monitor summary state
- resume if paused/failed
- cancel if active
- review terminal outcome

Run statuses should align with Smithers documentation:

- `running`
- `waiting-approval`
- `finished`
- `failed`
- `cancelled`

### 5.4.3 Event flow

Burns must treat the SSE event stream as the primary source for live updates.

Event flow requirements:

- subscribe to `GET /v1/runs/:runId/events`
- read `event: smithers` payloads
- track `afterSeq` for reconnect
- handle keep-alives cleanly
- auto-close the stream after terminal delivery
- maintain polling fallback through `GET /v1/runs/:runId`

Events should power:

- live timeline views
- node status transitions
- activity feed on Overview
- run detail status updates
- operator notifications

### 5.4.4 Approval flow

When a run reaches a human approval gate, Burns must surface it in the workspace approval queue.

Approval flow requirements:

- show pending approvals per workspace
- show run, node, iteration, wait time, and note context
- allow approval with note and `decidedBy`
- allow denial with note and `decidedBy`
- reflect the result back into the run timeline and event stream

The approvals page should support:

- inbox view
- filtering/sorting
- decision note entry
- recent decision history

---

# 6. Domain model

## 6.1 Core entities

### Workspace

Represents one managed repo.

Suggested fields:

- `id`
- `name`
- `path`
- `repoProvider` (`local`, `github`, `none`)
- `repoUrl`
- `defaultBranch`
- `workspaceRoot`
- `workflowDir` default `.smithers/workflows`
- `defaultAgent`
- `serverBaseUrl`
- `serverAuthMode`
- `serverStatus`
- `createdAt`
- `updatedAt`

### Workflow

Represents one workflow file inside a workspace.

Suggested fields:

- `id`
- `workspaceId`
- `name`
- `relativePath`
- `entryPath`
- `description`
- `tags`
- `lastEditedAt`
- `lastRunId`
- `status` (`draft`, `active`, `hot`, `archived`)

### Run

Represents one Smithers workflow execution.

Suggested fields:

- `id` (`runId` from Smithers)
- `workspaceId`
- `workflowId`
- `workflowName`
- `status`
- `startedAtMs`
- `finishedAtMs`
- `summaryFinished`
- `summaryInProgress`
- `summaryPending`
- `serverId` or `serverBaseUrl`
- `lastSeqSeen`

### Node instance

Represents a task/node occurrence within a run.

Suggested fields:

- `id`
- `runId`
- `nodeId`
- `iteration`
- `attempt`
- `type`
- `status`
- `startedAtMs`
- `finishedAtMs`
- `outputRef`
- `needsApproval`

### Event

Represents a Smithers event persisted for UI and diagnostics.

Suggested fields:

- `id`
- `runId`
- `seq`
- `type`
- `timestampMs`
- `nodeId`
- `iteration`
- `attempt`
- `payloadJson`

### Approval

Represents an approval decision point.

Suggested fields:

- `id`
- `runId`
- `workspaceId`
- `nodeId`
- `iteration`
- `status` (`pending`, `approved`, `denied`)
- `requestedAtMs`
- `resolvedAtMs`
- `decidedBy`
- `note`

### Authoring session

Represents a local workflow editing/chat session.

Suggested fields:

- `id`
- `workspaceId`
- `workflowId`
- `agent`
- `messagesJson`
- `pendingPatch`
- `status`
- `updatedAt`

---

# 7. Recommended architecture

## 7.1 High-level architecture

Burns should have three layers:

1. **Frontend app**
   - routes, lists, editors, dashboards, approvals
2. **Burns local service**
   - workspace registry
   - repo/file operations
   - workflow scaffolding/editing helpers
   - Smithers server process management
   - event ingestion and local cache
3. **Smithers server(s)**
   - execution engine
   - SSE stream source
   - run control endpoints
   - approval endpoints

## 7.2 Why a Burns local service is useful

A Burns-owned local service can:

- normalize workspace metadata across repos
- securely proxy Smithers server calls
- keep auth tokens off the UI layer
- manage server startup/shutdown/restart
- maintain a local index of runs and events across workspaces
- implement supervisor behaviors not owned by Smithers itself

## 7.3 Multi-workspace model

Burns may support either:

- **one Smithers server per workspace**, or
- **one shared Smithers server** with an indexed server-level DB and careful `rootDir` handling

V1 recommendation:

- start with **one managed Smithers server per workspace** for simpler path safety and process isolation
- aggregate workspace summaries in Burns

---

# 8. Takopi-inspired functionality

Burns should borrow the most useful operational ideas from `takopi-smithers`.

## 8.1 Supervisor concept

Each workspace should have a lightweight supervisor record with fields conceptually similar to:

- `status`
- `summary`
- `heartbeat`
- `last_error`

This status should be shown on workspace Overview and used for health badges.

## 8.2 Auto-heal behavior

Burns should optionally detect unhealthy orchestration situations and suggest or perform recovery actions such as:

- restart disconnected event stream subscribers
- retry connection to a stopped local Smithers server
- surface stale heartbeats
- offer resume for paused/failed recoverable runs
- surface stuck approval waits

Auto-heal should begin as **operator-assisted** rather than fully automatic.

## 8.3 Operator commands, translated to UI

Useful `takopi-smithers` command ideas should appear as UI actions:

- **init** → Add workspace / initialize Burns files
- **start** → Start workspace supervisor / server
- **status** → Overview health and run summary
- **restart** → Restart workspace server or run watcher
- **stop** → Stop workspace server or active watching
- **doctor** → Diagnostics page or modal
- **logs** → Logs drawer / diagnostics viewer

## 8.4 Worktree awareness

If the repo uses git worktrees, Burns should remain aware of:

- current branch/worktree path
- active implementation branches
- run-to-branch association when relevant
- recovery implications when a worktree disappears or changes

This can start as read-only visibility in V1.

## 8.5 SQLite-backed state

Like `takopi-smithers`, Burns should favor SQLite-backed local state for:

- workspace registry
- run index
- event cache
- approval history
- supervisor heartbeats and health snapshots

This improves restart resilience and allows fast UI bootstrapping.

---

# 9. Detailed page requirements

## 9.1 Workflows page

Purpose: author and iterate on workflows for the selected workspace.

Required UI sections:

- workflow list
- selected workflow path and metadata
- code viewer/editor
- workflow chat box
- save action
- new workflow action

Optional V1.1 additions:

- template library
- diff review panel
- validation panel
- prompt history

## 9.2 Add workspace page

Purpose: create a new managed workspace.

Required sections:

- stepper
- source selection
- workflow template selection
- summary sidebar
- confirm/next/back controls

## 9.3 Overview page

Purpose: summarize workspace health.

Required sections:

- branch / repo status
- workflow count
- active runs count
- recent workspace activity
- quick actions
- workspace health / supervisor status

## 9.4 Runs page

Purpose: monitor active and recent runs.

Required sections:

- run summary cards
- recent runs list
- status filters
- approval queue summary
- live stream preview
- server health card

## 9.5 Approvals page

Purpose: process human approval gates.

Required sections:

- pending approval list
- approve/deny controls
- decision note field
- recent decisions
- wait time / SLA indicators

## 9.6 Settings page

Purpose: configure Burns and Smithers defaults.

Required settings:

- workspace root
- default CLI agent
- Smithers server auth token configuration
- default `rootDir` policy
- default `allowNetwork` policy
- diagnostics/logging preferences

---

# 10. Backend behaviors

## 10.1 Workspace discovery and indexing

On workspace add or refresh, Burns should:

- verify the path is a git repo or initialize one if creating new
- ensure `.smithers/workflows` exists
- index known workflow files
- record workspace metadata
- test Smithers connectivity if configured

## 10.2 Run launching

When launching a run, Burns should:

- resolve the workflow path relative to the selected workspace
- validate that it stays inside the allowed root
- capture the input payload
- call `POST /v1/runs`
- persist the returned `runId`
- open event streaming immediately

## 10.3 Event ingestion

Burns should persist incoming events to local storage with `seq` tracking.

This enables:

- reconnect with `afterSeq`
- timeline reconstruction
- local notifications
- post-mortem debugging

## 10.4 Approval actions

When approving or denying a node, Burns should:

- collect `decidedBy`
- collect optional note
- call the appropriate approval endpoint
- optimistically update the UI
- reconcile against subsequent events

## 10.5 Resilience behavior

Burns should detect and surface:

- server unreachable
- SSE disconnected
- heartbeat stale
- mirrored DB lag where relevant
- run status mismatch between polling and events
- workflow path outside allowed root

---

# 11. Safety and security

## 11.1 Filesystem safety

Burns must keep workflow execution scoped to the intended workspace.

Requirements:

- never resolve workflow paths outside the configured root
- keep Smithers `rootDir` narrow
- make the workspace path explicit before run launch

## 11.2 Auth

If Smithers auth is enabled, Burns must use:

- `Authorization: Bearer <token>` or
- `x-smithers-key: <token>`

Tokens should not be exposed in plaintext in general UI surfaces.

## 11.3 Network policy

Default Smithers server behavior should be:

- `allowNetwork: false`

Any workspace requiring network access should opt in explicitly.

---

# 12. V1 non-goals

The first version does not need to include:

- collaborative multi-user approvals
- cloud-hosted orchestration
- RBAC
- remote repo hosting abstractions beyond GitHub clone support
- deep prompt artifact management
- automatic workflow synthesis from natural language without review

---

# 13. Acceptance criteria

Burns V1 is successful if an operator can:

1. add a local repo or clone a repo as a workspace
2. see the workspace in the selector
3. browse workflows under `.smithers/workflows`
4. edit a workflow and save changes
5. prompt an agent to revise the workflow
6. start a Smithers run from the selected workflow
7. watch live events update the run view
8. inspect run summary and frame history
9. approve or deny a waiting node
10. recover from a disconnected or stale workspace/server state using supervisor tools

---

# 14. Open questions

These should be resolved before implementation hardens:

1. Should Burns ship as desktop-only, web app + local daemon, or both?
2. Should each workspace own its own Smithers DB, or should Burns maintain an aggregate mirror DB as well?
3. Should workflow editing be read/write text editing in V1, or code view plus chat-generated patches only?
4. What is the minimal diagnostics surface for the first release: logs panel, doctor report, or both?
5. How much worktree awareness is required in V1?
6. Should agent-assisted workflow edits be immediate patches or staged diffs requiring explicit apply?

---

# 15. Recommended implementation order

1. Workspace registry and Add workspace flow
2. Workflow indexing and viewer/editor
3. Smithers server connection and run launch
4. Live event ingestion and runs page
5. Approval queue and decision actions
6. Supervisor health model
7. Diagnostics, restart, and auto-heal assistance

---

# 16. One-sentence product definition

**Burns is a workspace-first Smithers control plane for authoring workflows, supervising runs, and operating human-in-the-loop orchestration across multiple repos.**

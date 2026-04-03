# Workspace + Smithers Runtime Gap Handoff (Next Agent)

Last updated: 2026-03-11 23:58:00Z (UTC)  
Base commit reviewed: `3cb019c`

## Progress update (2026-03-11)

Phase 1 reliability items have been implemented in current branch:

- Resume payload now includes `workflowPath` for Smithers `resume`.
- Run event persistence no longer depends on active `/events/stream` clients.
- Approval service no longer seeds runtime rows from mock data.
- Run mapping handles additional Smithers state/status variants with deterministic timestamp fallback.
- Workflow path resolution supports both `workflow.tsx` and `workflow.ts`.
- Start/resume run input schemas now require object-like payloads.
- Web run-event hook reconnects SSE with `afterSeq` tracking.

## Purpose

This document captures:

- Confirmed runtime/workflow/SSE issues
- Workspace UX/API feature gaps vs current product spec
- A concrete execution plan for the next agent

Use this as the source of truth for the next implementation pass.

## Current State Summary

What is already in place:

- Per-workspace Smithers process management exists (`smithers-instance-service`)
- Runs API exists: start/list/detail/resume/cancel
- SSE stream proxy exists and run events are persisted locally
- Workspace pages exist: Overview, Runs, Approvals

What is not yet complete:

- Several correctness issues in run/resume/event logic
- Workspace section is still missing multiple spec-required operational features

## Confirmed Issues (Fix First)

## 1) Resume contract mismatch (blocking)

Burns resume currently posts only `{ input }` to Smithers.  
Smithers server `0.9.1` expects `workflowPath` for `/v1/runs/:runId/resume`.

Files:

- `apps/daemon/src/services/smithers-service.ts` (resume payload composition)

## 2) Event ingestion only when client is actively streaming

Events/approval sync are persisted only via `/events/stream` proxy path. If no UI client is connected, local event timeline + approval queue can drift or stay empty.

Files:

- `apps/daemon/src/server/routes/run-routes.ts` (`createEventProxyStream`, persistence path)

## 3) Mock approvals seeded into runtime data

Approval service still seeds from `domain/workspaces/mock-data` when table is empty. This pollutes real workspace approval queues.

Files:

- `apps/daemon/src/services/approval-service.ts`
- `apps/daemon/src/domain/workspaces/mock-data.ts`

## 4) Run mapping inconsistencies with Smithers response fields

Run timestamp/summary mapping is too permissive and can produce incorrect values (`startedAt` fallback to now, missing state-key mapping such as `in-progress`/`waiting-approval`).

Files:

- `apps/daemon/src/services/smithers-service.ts`

## 5) Workflow path resolution is TSX-only

Run start currently assumes `workflow.tsx`; workflows saved as `workflow.ts` cannot run.

Files:

- `apps/daemon/src/services/smithers-service.ts`
- `apps/daemon/src/services/workflow-service.ts` (already has TS/TSX lookup logic to reuse)

## 6) SSE client reconnect behavior is incomplete

Client closes `EventSource` on first error and never reconnects with `afterSeq`. Polling exists, but SSE-first behavior is degraded.

Files:

- `apps/web/src/features/runs/hooks/use-run-events.ts`

## 7) Run input validation is too loose

`startRunInputSchema` / `resumeRunInputSchema` accept `unknown`; Smithers expects JSON object input.

Files:

- `packages/shared/src/schemas/run.ts`

## Workspace Feature Gaps vs Spec

Spec source:

- `docs/burns-spec.md` sections 5.4 and 9.3–9.6

Missing in Workspace section implementation:

1. Overview page lacks:
- recent workspace activity
- quick actions
- supervisor/server health status

2. Runs page lacks:
- status filters
- approval queue summary
- live stream preview card
- server health card
- structured run input payload editor

3. Approvals page lacks:
- filtering/sorting
- recent decisions/history view
- stronger SLA/wait-time visibility patterns

4. Workspace control-plane actions missing:
- explicit start/restart/stop server actions per workspace
- richer health endpoint payload (process + heartbeat + restart stats)

5. Settings coverage is too shallow:
- no Smithers auth token config
- no rootDir policy control
- no diagnostics/logging preference controls

6. Workspace lifecycle management APIs missing:
- no delete/archive workspace endpoint
- no refresh/reindex workspace endpoint

## Next Agent Execution Plan

Implement in this exact order.

## Phase 1: Correctness + Reliability

1. Fix resume payload contract.
2. Remove mock approval seeding from runtime services.
3. Normalize run mapping for Smithers server response fields.
4. Support `workflow.ts` and `workflow.tsx` path resolution for start/resume.
5. Tighten run input schema to object-like payloads only.
6. Add reconnect logic to `useRunEvents` using `afterSeq`.

Acceptance criteria:

- Resume works against real Smithers server.
- Approvals list is empty by default unless real approval events/decisions exist.
- Timestamp + summary display aligns with Smithers payloads.
- Runs can launch for TS and TSX workflows.
- SSE reconnect resumes from last seq after transient disconnect.

## Phase 2: Workspace Section Features

1. Overview page:
- add activity feed (use persisted run events)
- add quick actions (start run, open workflows, restart server)
- add server health card (heartbeat/status)

2. Runs page:
- add status filters
- add approval queue summary
- add server health card
- add run input JSON editor

3. Approvals page:
- split pending inbox and recent decisions
- add filters (`pending/approved/denied`)
- add sort by wait time / updated time

Acceptance criteria:

- Workspace pages meet spec sections 9.3–9.5 at minimum viable level.
- Data is workspace-scoped and refreshes correctly.

## Phase 3: Workspace Operations API

1. Add daemon endpoints:
- `POST /api/workspaces/:id/server/start`
- `POST /api/workspaces/:id/server/restart`
- `POST /api/workspaces/:id/server/stop`
- `GET /api/workspaces/:id/server/status`

2. Extend health/supervisor model to include:
- smithers process state
- last heartbeat
- restart count / crash count
- bound port/baseUrl

3. Expose in UI controls (Overview page quick actions).

## Test Requirements for Next Agent

Run and pass:

```bash
bun run typecheck
cd apps/daemon && bun test
cd apps/web && bun run lint
```

Add/expand tests for:

- Resume payload includes workflowPath
- SSE reconnect path in web hook
- Approval service no mock seeding in runtime mode
- TS/TSX workflow path resolution in run start
- New workspace server control routes

## Implementation Notes / Guardrails

- Keep per-workspace Smithers lifecycle ownership in Burns (do not revert to global shared base URL model).
- Do not reintroduce mock runtime data in production routes/services.
- Prefer explicit, deterministic data contracts in shared schemas.
- Preserve workspace path safety checks (no path traversal outside workspace root).

## Suggested First PR Slice

If splitting work:

1. PR 1: reliability fixes only (Phase 1)  
2. PR 2: workspace UI feature completion (Phase 2)  
3. PR 3: server control endpoints + health model (Phase 3)

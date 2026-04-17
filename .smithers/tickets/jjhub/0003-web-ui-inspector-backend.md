# JJHub Web UI: Smithers Inspector Surface

> Target repo: **jjhub**
> Source: memo §4, §5 · roadmap Phase 2

## Problem

Operators who run Smithers on JJHub workspaces today can see the
workspace but not the run. Any inspector must be the *same* inspector
the TUI and GUI use — otherwise the three views drift and nobody trusts
any of them (memo §1, §4).

## Goal

JJHub's web UI renders the canonical Smithers inspector by consuming
the Gateway streams defined in smithers/0023 and the DevTools
snapshot/delta contract from smithers 0010.

## Scope

### Read path

- `GET /runs/:runId` — SSR shell that hydrates from a single
  `getRun` + initial snapshot.
- WebSocket to Gateway `streamDevTools(runId, afterSeq?)` for live
  updates. Reconnect with `afterSeq`; handle `GapResync` per
  smithers/0023.
- WebSocket to `streamRunEvents(runId)` for the activity feed.
- On-demand `getNodeOutput` / `getNodeDiff` for the inspector tabs.

### UI surface (mirrors live-run-devtools-ui.md)

- Tree pane (virtualized, search, keybindings).
- Inspector pane: props, state, iteration, tool-call list with
  side-effect badges (smithers/0019), Output / Diff / Logs tabs.
- Header: dual heartbeats (smithers/0016), `RunStateView.reason`
  (smithers/0015), owner + epoch + viewers.
- Frame scrubber for time travel (view-only by default).
- Rewind button gated behind a confirm modal + scope check.
- Ghost state preservation for unmounted nodes.

### Write path

Via Gateway (not a separate API):
- Approve / deny approvals (scope: `approval:submit`).
- Submit signal (scope: `signal:submit`).
- Cancel / resume (scope: `run:write`).
- Hijack / rewind (scope: `run:admin`).

All actions return the audit row id so the UI can jump to the
transition in the history pane.

### Multi-viewer

The viewers list (from 0016) is rendered live — users see who else is
watching. Two people clicking "approve" at the same time → one wins,
the other gets an `AlreadyDecided` error surfaced as a toast, not a
crash.

## Files

- `apps/ui/` (existing) — new route `/runs/:runId`
- `apps/ui/src/features/run-inspector/` (new)
- `packages/ui-core/` — shared components with GUI (0001) where we can
  reuse typescript logic; Swift GUI gets a parallel native impl.
- No new API routes in JJHub server — all I/O is through Gateway.

## Testing

- Component tests for tree virtualization at 10k nodes.
- Integration: reconnect after network drop → `afterSeq` replay works;
  no event gap visible in the activity feed.
- Integration: ghost state — unmount a node while it's selected; the
  inspector retains last-known props + output.
- Integration: approve from two tabs; second click surfaces a clear
  error.
- Accessibility: keyboard nav matches React DevTools conventions
  (referenced in live-run-devtools-ui.md §2).
- Visual regression: snapshot of header, tree, inspector for a fixture
  run.

## Acceptance

- [ ] `/runs/:runId` consumes Gateway only; no server-side DB reads
      bypass the contract.
- [ ] Inspector matches the fields in smithers/0015 RunStateView.
- [ ] Time-travel view-only works without any mutation.
- [ ] Rewind requires `run:admin` scope and a confirm modal.
- [ ] Visual regression + integration tests passing.

## Blocks

- Depends on smithers/0015, 0016, 0017, 0018, 0023, and the DevTools
  snapshot/delta tickets (smithers 0010–0013).

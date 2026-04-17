# Gateway Reference Deployment + Stable RPC Contracts

> Target repo: **smithers**
> Source: memo §5 · roadmap Phase 1

## Problem

Running Smithers remotely is possible via Gateway, but the contract is
unstable, auth/scopes are under-specified, and reconnect semantics are
implementation details rather than product guarantees. Users who want
remote Smithers assemble their own auth + proxy + reconnection layer.

## Goal

A documented, versioned Gateway RPC contract and a reference deployment
pattern that works end-to-end for authenticated humans and bots.

## Scope

### Stable RPCs

Freeze and version the Gateway surface:

- `launchRun(workflow, input, options)`
- `resumeRun(runId, options)`
- `cancelRun(runId)`
- `hijackRun(runId, options)` (0018; requires elevated scope)
- `rewindRun(runId, frameNo)` (0018)
- `submitApproval(runId, nodeId, decision)`
- `submitSignal(runId, correlationKey, payload)`
- `getRun(runId) → RunStateView`
- `listRuns(filter) → RunSummary[]`
- `streamRunEvents(runId, afterSeq?)` — WebSocket / SSE; protocol
  heartbeat every 1s (0016).
- `streamDevTools(runId, afterSeq?)` — DevTools snapshot/delta stream.
- `getNodeOutput(runId, nodeId, iteration?)`
- `getNodeDiff(runId, nodeId, iteration?)`
- `cron*` — list/create/delete/run.

Each RPC has: typed request, typed response, versioned error codes,
OpenAPI entry.

### Auth and scopes

Scopes:

- `run:read`, `run:write`, `run:admin` (hijack/rewind/repair)
- `approval:submit`
- `signal:submit`
- `cron:read`, `cron:write`
- `observability:read`

Tokens: short-lived bearer, rotatable via `smithers token issue/revoke`.
Per-token audit trail on every mutation.

Webhook signals require HMAC signature over the request body; invalid
signatures log and reject (tested by 0022 row 17).

### Reconnect semantics

- Every stream accepts `afterSeq`. Server stores a bounded per-run event
  window (default 10k events, configurable) for late subscribers.
- Client library documents the reconnect protocol: on disconnect,
  reconnect with last-seen seq; server either replays missed events or
  emits `GapResync { fromSeq, toSeq }` followed by a snapshot (when the
  window has been truncated).
- `Heartbeat` frames distinct from events (matches 0016).

### Reference deployment

Ship a `deploy/reference/` directory:

- `docker-compose.yml` — Gateway + SQLite + reverse proxy.
- `caddy.example.Caddyfile` — TLS + auth-aware reverse proxy.
- `systemd/` units for a single-host install.
- `k8s/` manifests for a minimal cluster install.
- `docs/deployment/reference.mdx` walking through the options.

JJHub becomes the preferred higher-level deployment; this ticket covers
the lower-level story for users who don't want JJHub (see jjhub/0004
for the JJHub path).

### Versioning

- RPC surface carries a `X-Smithers-API-Version: v1` header.
- Breaking changes require `v2`; old version supported for two minor
  releases.

## Files

- `packages/gateway/src/rpc/*.ts` — freeze signatures, typed errors
- `packages/gateway/src/auth/scopes.ts` (new)
- `packages/gateway/openapi.yaml` — generated, committed
- `deploy/reference/` (new)
- `docs/deployment/reference.mdx` (new)
- `docs/rpc/` — one `.mdx` per RPC, all `stable` (see 0021)

## Testing

- Contract: every RPC round-trips via the client library used in the
  CLI.
- Fault: missing/invalid scope → `Forbidden` with the scope required in
  the error.
- Fault: expired token → `Unauthorized` with refresh hint.
- Fault: reconnect after window truncation → client receives
  `GapResync` + snapshot; test verifies no silent drop.
- Soak: 1h continuous stream with induced disconnects every 30s; no
  event loss, bounded memory.

## Acceptance

- [ ] OpenAPI generated from types, committed, versioned.
- [ ] Scopes documented and enforced per RPC.
- [ ] Reference deployment boots via a single command.
- [ ] Reconnect with `afterSeq` works; `GapResync` emitted when needed.
- [ ] Every RPC has a docs page at maturity `stable`.

## Blocks

- jjhub/0003 (web UI consumes this)
- gui/0001, gui/0002 (GUI consumes this)

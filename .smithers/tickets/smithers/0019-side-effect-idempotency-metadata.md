# Tool Side-Effect and Idempotency Metadata

> Target repo: **smithers**
> Source: memo §2, §9

## Problem

Resume, retry, and rewind can re-execute tool calls that already ran. The
engine has no uniform way to know whether re-running is safe. Users
discover this by surprise (duplicate PR comments, double merges).

## Goal

Every tool declares side-effect classification; the engine uses it to
decide whether replay is safe, and to warn operators when it is not.

## Scope

### Metadata

Tool definitions gain:

```ts
sideEffect: "none" | "read" | "write"
idempotent: boolean
idempotencyKey?: (args) => string        // optional stable key
externalResource?: string                // e.g. "github:pr-comment"
```

### Engine behavior on replay / rewind / retry

- `sideEffect: "none" | "read"` → replay freely.
- `sideEffect: "write", idempotent: true` → replay, log a
  `ToolCallReplayed` event.
- `sideEffect: "write", idempotent: false`:
  - With `idempotencyKey`: engine deduplicates on the key (stores keys in
    `tool_call_keys` table keyed by `(runId, toolName, key)`).
  - Without: engine pauses the run and raises a
    `ReplayUnsafeApproval` — operator must explicitly approve replay or
    choose "skip this tool call".

### Inspector surface

- DevTools task inspector shows each tool call's classification and, on
  replay, a badge: `replayed`, `deduped`, `needs-approval`.
- `smithers why` cites `ReplayUnsafeApproval` when it's the block reason.

### Migration path

- Built-in tools (bash, file-read, file-write, http, gh, jj) get
  classifications in this ticket.
- User-authored tools default to `sideEffect: "write", idempotent: false`
  (safe default — forces the decision).
- Log a deprecation warning when a tool lacks explicit metadata.

## Files

- `packages/core/src/tools/metadata.ts` (new)
- `packages/core/src/tools/builtin/*` — add classifications
- `packages/db/migrations/0015_tool_call_keys.sql`
- `packages/react-reconciler/src/reconciler/` — check on replay
- `packages/devtools/src/snapshot.ts` — embed classification
- `docs/tools/side-effects.mdx` (new)

## Testing

- Unit: dedupe on `idempotencyKey` — second call with same key is a no-op
  and returns cached result.
- Integration: retry a non-idempotent write tool → run pauses on
  `ReplayUnsafeApproval`; approval records a decision.
- Integration: rewind past a side-effect write → event surfaces in
  inspector as `abandoned` but external state is NOT rolled back (the
  engine doesn't claim that); warning logged.
- Property: replaying `none`/`read` tools N times yields identical
  outputs (no persistence side effects).

## Acceptance

- [ ] Every built-in tool classified.
- [ ] User tools without classification trigger a warning.
- [ ] `ReplayUnsafeApproval` is a first-class `ReasonBlocked` variant.
- [ ] Dedupe table persists across restarts.
- [ ] Inspector shows classification on every tool-call card.

## Blocks

- 0018 (rewind integrates with this)
- jjhub/0003, gui/0001 (inspector renders badges)

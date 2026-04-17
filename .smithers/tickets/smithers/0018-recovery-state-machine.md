# Recovery State Machine

> Target repo: **smithers**
> Source: memo §2 · roadmap Phase 0

## Problem

Resume, retry, hijack, continue-as-new, rewind, auto-resume, and
approval-unblock are each implemented as ad hoc operational flows. They
don't share invariants, aren't uniformly audited, and their semantics
under concurrency (two resumes racing, rewind during supervisor takeover)
are undefined.

## Goal

One typed recovery state machine with a published transition table and an
audit log every mutator writes to.

## Scope

### Transitions

```
running         → waiting-*    (blocked by node)
running         → stale        (heartbeat SLO)
stale           → recovering   (supervisor takeover; 0017)
orphaned        → recovering   (supervisor takeover; 0017)
recovering      → running      (replay complete, epoch bumped)
recovering      → failed       (replay exceeded budget)
waiting-approval→ running      (decision recorded)
waiting-event   → running      (correlated signal)
waiting-timer   → running      (timer fires)
running         → succeeded | failed | cancelled   (terminal)
any             → running (new epoch)   (hijack)
succeeded|failed→ running (new lineage) (continue-as-new)
any non-running → running (frame n)     (rewind)
```

Every transition: `{ runId, from, to, actor, reason, epoch, at }`.

### Mutators

- `resume(runId, opts)` — caller must hold lease or invoke via supervisor
  after takeover. Idempotent within an epoch.
- `hijack(runId, newOwnerId)` — forces lease takeover + resume. Requires
  explicit `--force` in CLI; audit includes reason.
- `rewind(runId, frameNo)` — truncates event log past frameNo, restores
  VCS pointer if available, starts a new epoch, emits
  `RunRewound { fromFrame, toFrame, truncatedEvents }`.
- `continueAsNew(fromRunId, ...)` — links lineage, carries selected state,
  original run stays terminal.
- Approval / event / timer unblock — publish a typed transition event.

### Supervisor policies

Surface the supervisor as a product, not a detail:
- `staleThresholdMs`, `orphanThresholdMs`
- `maxConcurrentRecoveries` (global), `maxRecoveryAttempts` (per run)
- `backoffSchedule` (e.g. `[5s, 30s, 2m, 10m]`)
- `replayBudgetMs`
- `onReplayExceeded: "fail" | "escalate-approval"`

Config lives in `smithers.config.ts`; runtime values visible via
`smithers doctor run`.

## Files

- `packages/core/src/recovery/stateMachine.ts` (new)
- `packages/core/src/recovery/mutators/` (new) — `resume`, `hijack`,
  `rewind`, `continueAsNew`
- `packages/scheduler/src/supervisor.ts` — use mutators + policy
- `packages/db/migrations/0014_recovery_audit.sql`
- `packages/gateway/src/rpc/` — expose mutators with typed errors
- `apps/cli/src/resume.ts`, `hijack.ts`, `rewind.ts` — thin wrappers

## Testing

- Unit: transition table — every allowed transition round-trips; every
  disallowed transition returns `InvalidTransition`.
- Integration: resume during supervisor takeover → one wins, the other
  gets `EpochMismatch`.
- Integration: rewind during active tool call → tool call is marked
  `abandoned` in its iteration; downstream frames truncated; new epoch
  runs cleanly.
- Integration: `continueAsNew` with carried state → lineage chain visible
  in `smithers inspect --lineage`.
- Integration: replay exceeds budget with `onReplayExceeded: "fail"` →
  run ends `failed` with typed cause.
- Soak: 50 resume/retry cycles on a fixture run, no leaked leases, no
  duplicate side effects (combine with 0019).

## Acceptance

- [ ] Transition table published in `docs/recovery.mdx`.
- [ ] Every mutator writes an audit row with `actor` and `reason`.
- [ ] Supervisor policy is configurable and visible in `doctor run`.
- [ ] `hijack` requires `--force` in the CLI.
- [ ] `rewind` truncates the event log atomically (no partial state).

## Blocks

- 0020 (`smithers why` / `doctor` / `repair` read from audit log)
- 0022 (E2E matrix depends on transition table for test coverage)
- jjhub/0003, gui/0001 (inspectors render transition history)

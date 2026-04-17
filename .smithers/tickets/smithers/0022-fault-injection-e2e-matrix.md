# Fault-Injection E2E Test Matrix

> Target repo: **smithers**
> Source: memo §7 · roadmap Phase 0 → Phase 2

## Problem

Every reliability claim in the memo needs a reproducible test, or it
regresses. "We think we fixed it" is not enough for an orchestrator users
leave running unattended.

## Goal

A named, maintained E2E matrix covering the crash/recovery failure modes
enumerated in the memo. Runs on every PR; soak subset runs nightly.

## Scope

### Crash / resume / stale ownership (§A)

1. Kill engine mid-task; assert run → `stale` within SLO, supervisor
   takes over, resume completes with exactly-one delivery of side effects
   (verified via 0019 dedupe keys).
2. Kill sandbox; engine alive. Heartbeat timeout → documented retry/fail.
3. Restart during `waiting-approval`; approval persists; decision resumes
   the correct node at the correct iteration.
4. Restart during `waiting-event`; signal correlates after restart.
5. Restart during `waiting-timer`; timer fires exactly once post-restart.
6. Concurrent `resume` + supervisor takeover; one wins via epoch (0017).
7. `continueAsNew`; lineage traversable via `smithers inspect --lineage`.

### Inspector truthfulness (§B)

8. Active run with frequent tool calls; inspector never shows `idle`.
9. Subscriber disconnect → reconnect with `afterSeq`; no event gap; no
   manual refresh.
10. Node unmount after selection; ghost state preserved (0015 fields).
11. Frame scrub for view-only time travel; engine state untouched.
12. `rewind`; VCS reverted; subsequent frames reflect rewound state;
    audit entry exists (0018).
13. Error bubble-up: collapsed ancestor shows failure marker.

### Remote control plane (§C)

14. Gateway: launch/approve/signal/cancel/resume round-trip over
    authenticated RPC.
15. Drop WebSocket mid-stream → reconnect with `afterSeq`; no gap, no
    dup.
16. N=5 subscribers on one run; bounded memory; consistent state.
17. Webhook signal with invalid signature → rejected + audited.
18. Cron + manual trigger overlapping; documented dedupe/concurrency.

### Runtime / sandbox (§D, blocked on jjhub/0002)

19. Auth persistence across workspace suspend/resume.
20. Browser automation task in reference runtime.
21. File + VCS pointer integrity across repeated runs.
22. Secret injection; no secrets in logs (redaction test).
23. Network-denied task vs policy-allowed task behavior.

### Safety / side effects (§E)

24. Retry a `sideEffect: write, idempotent: false` tool without a key →
    blocks on `ReplayUnsafeApproval`.
25. Approval scope denial; audit record.
26. Diff-review-required sandbox mode; accept / reject semantics.
27. Scorer failure blocks destructive downstream step.

### Soak (§F, nightly)

28. 10+ min live stream on busy run; RSS within budget (publish
    budget in the test).
29. Repeated cron runs over 2 hours; no stuck scheduler.
30. Long-lived JJHub workspace, repeated runs; stable behavior.

## Files

- `e2e/faults/` (new) — one file per test case, named after its row.
- `e2e/harness/` (new) — fault-injection primitives: `killProcess`,
  `dropWebSocket`, `freezeSqliteLock`, `stallSandbox`, `skewClock`,
  `corruptHeartbeat`.
- `e2e/budgets/` (new) — memory/latency budgets as JSON.
- `.github/workflows/faults.yml` (PR), `faults-nightly.yml` (soak).

## Testing (meta)

- Each fault primitive has a unit test proving it actually injects.
- Flake budget: 0 flakes per 100 CI runs before a fault is promoted from
  nightly-only to per-PR. Track in `e2e/flake-log.md`.

## Acceptance

- [ ] All 30 cases implemented or explicitly skipped with a ticket link.
- [ ] Per-PR subset < 10 min wall time.
- [ ] Nightly soak < 2h wall time.
- [ ] Budgets enforced (test fails on regression, not just recorded).
- [ ] Every fault primitive reusable from any test.

## Blocks

- Some rows depend on 0015–0020, jjhub/0001–0002, 0019.
- Matrix grows as new failure modes are discovered — this is not a
  one-shot ticket; it's the home for ongoing reliability coverage.

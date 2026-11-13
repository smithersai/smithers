---
title: Client stack round-3 recovery findings
status: in-progress
area: local-first
owner: Codex GPT-6.1 Sol
updated: 2026-11-02
links: [../decisions/0023-device-ownership-and-queued-authority.md]
---
Fix legacy ordering, atomic admission through leadership transfer, failed wipe marking, and stale held indexes.
Use the library catalog entry `@smthrs/effect-tanstack-db` for the durable outbox.
Use `@smthrs/ui`'s shared EmptyState and Button for the wipe failure's Retry outside the stopped runtime.
Red regressions precede fixes. Validate only through mini-run on the Mac mini. No landing, deployment, or lane-owned review.

Red evidence against `43fde3c1b300`, executed through mini-run:

- Legacy timestamp tie: `expected undefined to be type of 'number'` at `test/Outbox.test.ts:1572`, the persisted sequence assertion.
- Leadership transfer: `expected 1800000000000 to be greater than 1800000000000` at `test/Outbox.test.ts:1625`, after paused admission and native Web Lock transfer.
- Wipe marker failure after 204: `expected +0 to be 1` at `src/wipe.test.ts:453`, the program stop count.
- Empty-backlog follower repair, retry and notification: `expected true to be false` at `test/Outbox.test.ts:1669`, the held-status assertion.
- Interrupted migration: `expected false to be true` at `test/Outbox.test.ts:1697`, the admission-refusal assertion.

The first full package run executed 210 tests, with 209 successful and one failure
in unreadable-row parking. Payload recovery now precedes ordering recovery so
unreadable rows can still be parked before the replay gate opens.

The dependency patch remains 292 lines and has not changed. Ownership filtering,
send-time ownership checks, and the server's device-person check remain in force.
Package validation on the mini: 17 files, 210 successful tests, zero skips.
Package source and test typechecks completed with exit 0. Independent re-review
is outside this lane.

The full app run exposed a synchronous Retry boundary regression, reproduced
alone in chat telemetry: `AsyncFiberError: An asynchronous Effect was executed
with Effect.runSync`. The SDK retry signal is synchronous again; index repair
joins its existing serialized storage chain. The empty-backlog regression also
exercises that synchronous public boundary.

The subsequent full app run executed all 870 tests: 861 successful, seven
failures, two existing expected failures, and zero skips. Isolated runs confirmed
unavailable-lock startup, follower payload parking, handoff admission, and delayed
delete regressions. Recovery now reads follower status without an admission lock,
locks only actual admissions, installs the sequence barrier before publishing
leadership, and avoids deleting an absent held index. Package validation after
those changes again executed 210 tests with zero skips and both typechecks at
exit 0.

Resumed final validation, executed only through mini-run on the Mac mini:

- App: 67 files and all 870 tests executed, with 867 successful, two existing expected failures, one failure and zero skips. Counts by area: device 86, coedit 34, issues 160, todos 148, runs 236, auth 37, chat 152 and wipe 17.
- The one full-run failure was `src/features/coedit/coedit.test.ts:300`, waiting for the read-only viewer's collaborator cursor: `expected [] to deeply equal [ ObjectContaining {"name": "member"} ]`. Running that test alone succeeded in 2.6 seconds: one successful and 30 filtered skips. It did not reproduce in isolation. No retry, sleep or source change was added to pass it.
- Package: all 210 tests across 17 files successful, zero skips.
- App client, worker, infra and eval typechecks, and package source and test typechecks: exit 0.
- The initial slot requests timed out before execution. Capacity retries used the same source. No tests ran on the MacBook or Latitude servers.
- The dependency patch and lockfile are unchanged above `09e9388d18b9`; patch size is 292 lines before and after. The ownership and send-time isolation regressions remain successful.

No browser E2E or coverage measurement was run. No reviewer, landing, push or
deployment has been run in this lane. Independent re-review belongs to the
coordinator, and no lane-owned review verdict is claimed. Raw lane-owned test
output files are removed after recording these receipts.

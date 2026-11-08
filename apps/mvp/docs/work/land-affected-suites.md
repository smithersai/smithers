---
title: Full affected validation precedes FIFO landing admission
status: done
area: tooling
owner: Codex (land gate snapshot and completed failure repair)
updated: 2026-11-05
links:
  - ../../../../.smithers/flows/land/affected.mjs
  - ../../../../.smithers/flows/land/affected-receipt.mjs
  - ../../../../docs/devx/parallel-agents.md
---

The affected gate tests the exact stored commit against its fork point with the
observed main, before FIFO admission. It never syncs, rebases, regenerates the
index or snapshots the workspace. Changes behind main can be gated unchanged.

Under the publication lease, workspace landing syncs first, records the new
main base, regenerates the target index when present and snapshots the result.
Receipt inspection then classifies moved main as `main-advanced`. A refused receipt or proven regression blocks even
when main has moved: that failure was proven on this change's own diff. Passed
evidence for the same diff and main prints `gate: passed`. All other evidence
proceeds as `gate: incomplete, stage=<stage>`: `main-advanced`, `source-changed`,
`receipt-unreadable`, or the incomplete gate's own stage. Completed proof counts
print, and incomplete lands use the existing `land-log.jsonl` and proxy inbox
line. A missing or unreadable receipt proceeds without claiming PASS.

Over 72 h, 67 percent of gaps between apps/mvp lands were under 12 minutes, so a
receipt is often stale by the time it is read. Only a proven failure of this
change blocks the affected gate. Typecheck, explicit validation and publication
protections still apply.

Catalog entry: repository chores in `.smithers/flows`; the existing source-only
bootstrap, without a new module, library, runtime or persisted state.

Validation: the unguarded land test glob ran natively on nyc-01, using an
installed copy of the jj-listed tree without repository metadata. Head had 470
passed, zero failed and one macOS-only skip; substituting `965a4b23`'s land
directory yielded 343 passed, zero failed and the same skip. The failing-name
diff is empty. Git 2.43.0 and jj 0.45.1 ran the real throwaway fixtures; HOME,
audit inboxes and identities were isolated. Six focused contract cases passed.
This supersedes the earlier cfbox runs that skipped the Git and jj fixtures.

The single real `ea01367a` gate compared its own diff against parent `5ed238da`
on historical main. It ended `incomplete`, stage `pg-admission`, after 918.254 s,
waiting behind a retained ticket with unconfirmed remote termination. Its receipt
permitted proceeding, with zero proven targets, files or shared failures. No real
suite ran; this is incomplete evidence, not PASS. No land or push.

Astra found a publication ancestry check lost with sync. Both entrypoints now
check remote main's ancestry under the FIFO lease before publication. The two
new regressions failed on the unguarded code and pass with the fix: the divergent
change is gated at its fork, and remote history survives publication refusal.

Astra's `c5adddca` receipt found missing completed counts and stale fixture
assertions. Passed receipts now retain execution counters: one target, one file
and a shared failure survive main advancement into the existing audit. Both
new regressions fail against `c5adddca`, without injecting counters or rewriting
receipts. Callers explicitly snapshot edits; workspace landing syncs stale
lanes under the lease. The fixtures assert incomplete audits and preservation
of remote history. No module or
separate persisted state was added. No land or push.

Runner destinations now use sourcePath before writes; ordinary comparison errors
retain completed counters. Four regressions failed first. Final unguarded nyc-01
head: 478 pass, 0 fail, 1 skip; known main: 343 pass, 0 fail, 1 skip. No land or push.

Run-level errors retain completed failed assertions for refusal and comparison; interrupted runs and unproven passing files stay incomplete. nyc-01 head: 494 pass, 0 fail, 1 skip. Six focused cases pass after the real Vitest case failed first.

The first real land exposed missing leased preparation: this change removed
sync and index regeneration after admission as well as before it. Restore
965a4b23's workspace preparation under the FIFO lease; the pre-admission gate
stays read-only and the final publication ancestry check stays in place.
Main's commit entrypoint had no sync or projection equivalent to restore; its
pre-admission immutability and ancestry refusal remain covered. No new runtime,
module or library is used (catalog entry: repository chores, `.smithers/flows`).

Leased-sync regression validation on nyc-01: the stale-land, conflicting-rebase
and concurrent-land tests failed before restoration (3 fail, 1 pass including
the admission immutability check). All five focused cases pass after it. The
unguarded head land glob passed 496 tests, with zero failures and one macOS-only
skip; known main 965a4b23 remains 343 pass, 0 fail, 1 skip and was not rerun.
All 56 land source hashes matched the tested remote tree. No land or push.

Snapshot once under the commit lease before reading the validation baseline.
Completed assertion, module and suite-hook failures survive unrelated run errors.
Line-by-line comparison with main found no other dropped post-admission operation
in commit or landWorkspace. nyc-01: 3 regressions failed first; 9 focused pass;
full land suite 501 pass, 0 fail, 1 skip. All 56 source hashes match. No land/push.

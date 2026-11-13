---
title: Run change-feed progress
status: done
area: sdk
owner: Codex GPT-6.1 Sol
updated: 2026-10-22
links: []
---

## Revised design — 2026-10-21

**What:** Keep the run page and steer delivery current while `todo/Implement`
works inside one action attempt.

**Evidence:** the 2026-10-21 live steer test saw no change notification from
22:31 to 22:41 UTC while the journal grew from 19 to 201 events. The run page
and Delivered lagged for the whole attempt.

**Cause:** `todo/Implement` is one action attempt. `AgentAction.record` and
`AgentSession` emit the in-process model/tool trail through `journal.emitLossy`.
Its background batch writer inserts `flows_journal_events`; there are no inner
engine dispatches. `flows_attempts` changes only at attempt start and finish.
Migration 0003 watches only `flows_runs`, so the feed stays silent during work.

**Fix:** migration `0005_run_progress` (1005, after base 1004) adds nullable
integer `flows_runs.progress_at_ms` and an AFTER INSERT trigger on
`flows_journal_events`, for SQLite and PostgreSQL:

```sql
UPDATE flows_runs SET progress_at_ms = <now ms>
WHERE run_id = NEW.run_id
  AND (progress_at_ms IS NULL OR progress_at_ms <= <now ms> - 2000);
```

Use database insertion time, not the event timestamp. Both lossy and durable
entries participate. Zero matching rows fire no existing row revision trigger;
journal-driven bumps are bounded to once per two seconds per run. Other run
transitions still advance revisions immediately. Rollback undoes the event and
its progress bump. No AttemptStore change, engine option, timer, new lock,
plan digest change or implementation version change is needed. Readers stay
unchanged.

**Migration ordering:** journal owns the event table (migration 1).
`RunStore.Migrations.run/layer` compose journal IDs 1–6 before run-store IDs
1001–1005. `EngineStore.Migrations.sets` likewise lists journal before run-store.
Manual compositions using the run-store set must include the journal set first.

**Regression:** `engine-store/test/RunChangeProgress.test.ts` holds one action
open, emits lossy entries through a test gate after the baseline read, proves the trail persists while
only the outer attempt-start exists, and checks the revision before settlement.
A burst must coalesce and a later entry must advance again. Run on SQLite and
Postgres. Also cover durable entries, independent runs, absent runs and rollback.

**App proof:** `src/features/runs/remote.test.ts` checks a page re-read after
persisted trail progress during `probe/Pause`. It needs Postgres and Electric,
but no browser. Live steer delivery remains separate end-to-end evidence.

**Libraries:** catalog entries `@smthrs/engine-store`, `@smthrs/journal`, and
`@smthrs/run-store`.

**Earlier validation (2026-10-21):** restoring the run-store migration list from
`123aac80af55` makes the live regression fail with revision 5 → 5. With 1005,
the focused engine matrix passes all five tests on both SQLite and PostgreSQL,
including the unsettled action regression. The full run-store matrix passes
(313 passed and one skipped on SQLite; 314 passed on PostgreSQL), with merged
100% statements, branches, functions and lines. The browser-free app proof
passes all three tests against real Postgres and Electric. Both packages' type
checks and the changed tests' formatting checks pass. `pnpm docs:sync` and
`pnpm docs:check` pass, including all 51 published package tarballs.

Astra identified timing assumptions in the burst assertions. They now use a
single-statement burst and explicitly controlled eligibility, and gate the live action's next journal emission after its baseline read. Fable review was attempted
but its configured accounts failed or were cooling down. Full engine suites,
browser, production and live steer tests were not rerun after reboot; the
pre-reboot note reported baseline/intermittent PostgreSQL engine failures.

## Lander repair — 2026-10-22

Restored D and F onto `main@origin` `7f16c873`. D is a work/design note,
not a new numbered decision; the existing 0026 steering text and tracker
history are retained. Site projections are regenerated from current sources.

The app proof holds the last real probe action behind a gate, requires the
persisted journal entry and a newer feed revision, and checks the journal
insert advanced `progress_at_ms` independently of other run writes. It waits
for the feed's final revision and two quiet long-poll responses before asserting
no further reads. This removes the fixed sleep and the terminal read-count
race. Gates are released on assertion failure and at scope cleanup.

Astra's two test findings are fixed: require a newer feed revision, and gate
the SDK's second emission after its baseline instead of sleeping. Fable review
was attempted; all configured accounts were cooling down.

Executed regression receipts: disabling migration 1005 made the original SDK
case fail at revision 5 → 5; disabling the real journal trigger makes the
strengthened app case fail with progress 1 → 1. The gated SDK case passes.
The full run-store SQLite/PostgreSQL matrix passes (313 + 314 tests, one
SQLite-only skip), with merged statements, branches, functions and lines 100%.
Final tip commands and results (Node 26.5.0, frozen pnpm install):

| Command | Result |
| --- | --- |
| `pnpm --filter @smthrs/run-store coverage` | SQLite 313 passed / 1 skipped; PostgreSQL 314 passed; merged coverage 100% in all four metrics |
| `pnpm --filter @smthrs/engine-store coverage --fsModuleCache --maxWorkers=1` | SQLite 2,185 passed; PostgreSQL 2,185 passed; merged coverage 100% in all four metrics |
| `pnpm --filter @smthrs/mvp exec vitest run --fsModuleCache src/features/runs --coverage.enabled=false --maxWorkers=1` | 120 passed, 11 files |
| `pnpm --filter @smthrs/mvp typecheck` | Passed |
| `pnpm exec smithers-build test '//apps/mvp:importRules'` | Passed; no rule changes or exceptions |
| Both packages' `check` scripts and changed SDK tests' `dprint check` | Passed |
| `pnpm docs:sync` and `pnpm docs:check` | Passed; 51 published-package tarballs checked |

Build prerequisite: `cargo build --locked --release -p smithers-ffi --bin smithers-jj-export`.
Early engine runs lacked that helper. An interim two-worker run then timed out
in `ConnectionLoss.test.ts`; both cases passed when isolated on main and on
the tip. The final one-worker matrix passes the complete suites and coverage
gate, including connection-loss recovery. No assertion, timeout or threshold
was relaxed.

Plain `main@origin` (`7f16c873`, separate clean workspace): app typecheck,
import rules and the original Member watch test passed. All 2,183 engine tests
passed on its SQLite configuration. Its single-backend coverage command was
red (99.96% lines; no PostgreSQL merge), so that is not a passing full coverage
gate. The reported terminal read-count failure did not reproduce in that run;
F's original assertion still left the terminal feed race unguarded, which the
feed completion barrier above fixes.

Browser, production and live steering tests were not run in this repair.

## Earlier tracker history from main

## Tracker reconciliation — 2026-10-21 21:10 PDT

**What:** Publish run progress during a long unresolved action.

**Why:** Run pages must update before an agent action finishes.

**Current state:** Recovered report hands off commit 66491a243035, not pushed. It records red-to-green SQLite/Postgres regressions, 313 SQLite passes/1 skip, 314 Postgres passes, focused engine and real app proofs, merged run-store coverage 100%, and passing docs. Astra timing finding fixed; Fable unavailable. Full engine, browser/live steering and production proofs were not rerun.

**Next step:** Land the reviewed change, complete outstanding review and live/browser validation; do not equate handoff with deployment.

**Open questions for Will:** None.

Evidence: script-filtered user text and lead replies, 19:06–21:06 PDT; current rulings and queue answers through 21:06; surviving briefs and reports. Product results are reported receipts, not rerun here. Implementation ownership retained; Codex curates documentation. Wiped scratch files are not missing work.

## Earlier tracker history (retained)


## Tracker reconciliation — 2026-10-21 20:34 PDT

**What:** Publish run progress before a long agent action settles.

**Why:** Run pages and steering delivery must not stay stale for the whole action.

**Current state:** The recovered RUN-PROGRESS-BRIEF.md resumes the surviving run-progress workspace. The intended run-store migration adds progress_at_ms and a journal-insert trigger throttled to one change-feed bump per two seconds per run, on SQLite and Postgres. At 20:30 the lead says the run-page fix is still going; no completed proof or landing receipt.

**Next step:** Prove the regression red on the base and green during an unresolved action; retain ordering/recovery/coverage receipts and hand off the commit.

**Open questions for Will:** None.

Evidence: lead text replies script-filtered from session 6253ecf2, approximately 18:34–20:34 PDT, and recovered briefs where named. Automated notifications and tool content are excluded. Current rulings and queue answers prevail over older plans. Existing implementation ownership is retained; Codex curates the tracker. Product results are reported evidence, not tests rerun by this refresh.

## Earlier tracker history (retained)

## Tracker reconciliation — 2026-10-21 17:23 PDT

**What:** Publish run progress while a long agent action remains open.

**Why:** Run pages and steering delivery must update before the action finishes.

**Current state:** At 17:16 the lead reports the Codex builder still running after 51 minutes with eight files changed. Its legitimate MacBook test lock holds other checks. There is no completed validation or landing receipt. The revised brief traces progress to journal events during one long attempt, rather than repeated flows_attempts writes.

**Next step:** Finish the revised SDK journal-event progress implementation, prove updates during an open attempt and retain recovery, ordering and contention receipts.

**Open questions for Will:** None newly identified; retained unresolved decisions remain with their owning workstreams.

Evidence: script-filtered user-typed messages and lead text replies from session 6253ecf2, approximately 15:23–17:23 PDT. Automated notifications and tool content excluded. Rulings and queue answers govern over older briefs, designs and planning docs. Implementation ownership retained; Codex maintains tracker documentation. Product results are lead-reported.

## Earlier tracker history (retained)


## Tracker reconciliation — 2026-10-21 16:33 PDT

**What:** Publish progress while a long durable agent step remains open.

**Why:** A long step leaves the run page and steering Delivered mark stale.

**Current state:** At 16:25 PDT the lead restarts the Codex Sol builder to test on the MacBook after its Latitude attempt stalled. The journal builder also moves its eight-run lock measurement to the MacBook. No implementation pass or landing receipt is reported; the prior design and no-deadlock assessment remain applicable.

**Next step:** Finish SDK implementation and tests; prove updates before step completion, recovery and ordering, then check the TODO view locally and live.

**Open questions for Will:** None.

Evidence: lead text replies in session 6253ecf2, script-filtered through 16:33 PDT from its latest two hours; automated notifications, tool records and compaction summaries excluded. Rulings and queue answers take precedence over historical briefs. Implementation ownership retained; Codex curates tracker documentation. Product results are lead-reported.

## Earlier tracker history (retained)


**What:** Persist and publish live run progress while a durable step remains open.

**Why:** A ten-minute agent step leaves its run page and steering Delivered mark stale until the step ends.

**Current state:** The local TODO-steering E2E exposed this gap at 16:09. At 16:12 the lead reports a written SDK design and a Codex Sol build underway. The journal builder confirms the two changes cannot deadlock; the remaining shared-row bottleneck is being measured with eight runs. The revised RUN-PROGRESS-BRIEF.md traces this to in-process agent turns emitting lossy journal events while the run-change cursor stays silent. It specifies a journal-insert trigger updating progress_at_ms at most every two seconds per run in SQLite and Postgres, without changing the plan digest. Migration ordering must be checked.

**Next step:** Finish SDK implementation, prove progress arrives before step completion with recovery and ordering checks, then validate the TODO view locally and live alongside journal changes.

**Open questions for Will:** None.

Evidence: script-filtered lead replies at 16:09–16:12 PDT in session 6253ecf2, plus RUN-PROGRESS-BRIEF.md. Rulings and queue answers prevail. No passing implementation receipt yet.

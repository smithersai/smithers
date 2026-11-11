# Invariants

Every promise the merge queue makes, and the Lean theorem that proves it.
`lake build` checks this file: each `Proved` row must name theorems that exist
in the model (`MergeQueue/Matrix.lean`), and no declaration may rest on `sorry`
or on an axiom beyond Lean's own three (`MergeQueue/Audit.lean`).

A row, and what the build does with it:

```text
invariant  The target is always green
status     Proved
theorems   main_always_green, ...
build      fails if a named theorem is gone, renamed or rests on sorry
```

- **Proved**: the named theorems state it for the model and the build checks them.
- **Assumed**: true of the world around the queue; the model takes it as given and says so.
- **Open**: not proved yet. The row says what is missing.

## The model in one paragraph

A **tree** is the list of change revisions applied to the target, in order.
The queue's state is the target's tree, every change ever enqueued, the CI
runs it holds (each on one exact tree, with the results streamed so far), the
record of landings and a bounded history of check durations. `step` applies one
event; an event whose guard fails changes nothing. `plan` picks the queue's
next decision from the state alone. `Reachable` is every state `step` can
produce from the empty queue, and `Inv` is the invariant proved for all of
them by induction over events.

## Safety

| Invariant                                                                                                                                                                                | Status | Theorems or reason                                                                                                                  |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| **Main is always green.** The target's tree is the empty tree it started from or exactly the tree of a recorded landing whose result was complete and green.                             | Proved | `main_always_green`, `landings_form_one_chain`, `green_checked`, `Reachable.inv`                                                    |
| **The tested tree is the merged tree.** Only a landing moves the target; it moves it onto the tree of one run the queue holds, whose result is complete and green for that tree.         | Proved | `land_tree_was_tested`, `main_moves_only_by_land`, `unknown_run_never_lands`                                                        |
| **The target only grows.** No event reorders or removes what has landed.                                                                                                                 | Proved | `main_only_grows`                                                                                                                   |
| **Streaming never lets a partial result merge.** A run that misses a required check, or has a failed check, cannot land.                                                                 | Proved | `partial_result_never_lands`, `failed_result_never_lands`, `green_complete`, `green_not_failed`                                     |
| **Fixing starts at the first failure.** One failed check lets the lone suspect of a run be blamed, without the run being complete.                                                       | Proved | `blame_at_first_failure`                                                                                                            |
| **No change is lost.** A change the queue has seen stays in its record under the same id, arrival number and priority, and an ended change never changes again.                          | Proved | `never_lost`, `ended_is_final`                                                                                                      |
| **Every change ends.** When the queue is quiet (nothing to decide, no run pending, no fix agent working) every change is merged, unmergeable or withdrawn.                               | Proved | `quiet_means_done`                                                                                                                  |
| **No change merges twice.** The target's tree applies each change at most once, and a change is recorded as merged exactly when the tree holds it at that revision.                      | Proved | `merged_at_most_once`, `merged_iff_in_main`                                                                                         |
| **Order and priority are respected.** The ready list is sorted by priority, then arrival; a run tests the first ready changes; nothing ready is overtaken; a fix keeps a change's place. | Proved | `State.ready_sorted`, `State.ready_exact`, `start_takes_the_first`, `nothing_overtaken`, `earlier_arrival_first`, `fix_keeps_place` |
| **Unmergeable only with a recorded reason.** Every unmergeable change carries written words; a verdict without words is refused.                                                         | Proved | `unmergeable_has_reason`, `wordless_verdict_refused`                                                                                |
| **A fix is tested afresh.** After a fix answer, no run the queue holds is live with the fixed change in it; the new revision lands or is blamed only on a run started after the fix.     | Proved | `fix_is_tested_afresh`                                                                                                              |
| **Stale answers are refused.** A fix answer or a verdict for another attempt changes nothing.                                                                                            | Proved | `stale_fix_refused`, `stale_verdict_refused`                                                                                        |
| **Fix attempts are bounded.** No change uses more fix attempts than `maxAttempts`.                                                                                                       | Proved | `attempts_bounded`                                                                                                                  |
| **Runs are bounded.** No more undecided runs than `maxRuns`; run ids are never reused; a run holds one result per required check.                                                        | Proved | `runs_bounded`, `run_ids_unique`, `results_are_clean`                                                                               |

## Crash and restart

| Invariant                                                                                                                                                           | Status | Theorems or reason                                      |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ------------------------------------------------------- |
| **Every event keeps every invariant**, whatever it is and whenever it arrives.                                                                                      | Proved | `Inv.step`, `Reachable.inv`                             |
| **A crash keeps every invariant.** Losing any set of runs at any moment leaves a state that satisfies the invariant, with the target and every change as they were. | Proved | `crash_keeps_invariant`, `crash_keeps_main_and_changes` |
| **Delivering an event twice is delivering it once**, so a driver that does not know whether its last event was recorded can send it again.                          | Proved | `step_idempotent`                                       |
| **Losing or cancelling a run forgets that run and no other.**                                                                                                       | Proved | `cancel_keeps_other_runs`                               |
| **The next decision is a function of the durable state.** A restart resumes from the state alone.                                                                   | Proved | `plan_ignores_history`                                  |

## Progress

| Invariant                                                                                                                                                                | Status | Theorems or reason                                                                                                                                                                                                                                                               |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **No deadlock.** With something to check and a run slot, a queue with nothing to decide and a change still waiting has a pending run: it waits on CI, never on itself.   | Proved | `no_deadlock`                                                                                                                                                                                                                                                                    |
| **Every decision takes effect.** The policy never proposes an event the queue refuses.                                                                                   | Proved | `plan_takes_effect`                                                                                                                                                                                                                                                              |
| **Fix loops terminate.** Every blame, fix answer and landing that takes effect strictly lowers a budget that only a new change can raise.                                | Proved | `budget_blame_lt`, `budget_fixed_lt`, `budget_land_lt`, `budget_never_rises`, `budget_unchanged`                                                                                                                                                                                 |
| **Bisection terminates.** A bisection run is strictly between the longest prefix not known to fail and the shortest prefix known to fail.                                | Proved | `bisection_narrows`                                                                                                                                                                                                                                                              |
| **One measure for the whole queue.** A single number that strictly decreases on every decision and every answer, so that fair CI and fix agents imply every change ends. | Open   | The budget covers landings, blames and fixes, and `bisection_narrows` covers each bisection step. Still to prove: starts and cancels between two budget drops are bounded by one measure. The implementation checks it by fuzz (`test/Invariant.test.ts`, "the policy settles"). |

## Predicted durations

| Invariant                                                                                                    | Status | Theorems or reason                                                                       |
| ------------------------------------------------------------------------------------------------------------ | ------ | ---------------------------------------------------------------------------------------- |
| **Scheduling never drops or adds a check**, and orders them slowest first.                                   | Proved | `schedule_perm`, `schedule_slowest_first`, `mem_remaining`, `remaining_nil_iff_complete` |
| **The estimate is a duration that happened**, or the configured default with no samples.                     | Proved | `estimate_is_a_sample`, `estimate_default`                                               |
| **The ETA covers every check still to run**, and is zero for a complete run.                                 | Proved | `eta_covers_remaining`, `eta_zero_when_complete`                                         |
| **Predictions never decide what lands.** Two queues that differ only in duration history take the same step. | Proved | `predictions_never_decide`, `plan_ignores_history`                                       |
| **The duration history is bounded** to `window` samples per check.                                           | Proved | `history_bounded`                                                                        |

## What the model assumes

| Invariant                                       | Status  | Theorems or reason                                                                                                                                                 |
| ----------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Only the queue writes the target branch.        | Assumed | The driver moves the target with a compare-and-swap from the previous tree and stops, loudly, when the branch is not where the queue left it.                      |
| A tree is determined by its parts in order.     | Assumed | The driver builds a candidate by applying exactly those revisions in that order, and lands the commits CI tested, never a rebuild.                                 |
| CI reports a verdict for the tree it was given. | Assumed | A result names its run, and a run names one tree; `step` records a result only on the run it names (`results_are_clean`).                                          |
| CI and fix agents eventually answer.            | Assumed | Progress theorems say the queue is never the one that is stuck; they cannot make the world answer. A lost run is `cancel`, after which the policy starts it again. |

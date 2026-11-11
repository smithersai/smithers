# Mutation results

Written by `node scripts/mutants.ts --write`. Do not edit: run it again.

43 planted bugs; 43 caught on both sides.

Each bug is planted in the Lean reference and in the TypeScript kernel. In Lean it must break a proof, or, when
every proof still holds (the bug changes the policy, not a guarantee), make the differential fuzz differ. In
TypeScript the recorded reference digests or the theorem checks must notice.

| Mutant | The bug | Lean reference | TypeScript kernel |
| --- | --- | --- | --- |
| `land-without-green` | Land a run whose result is not green. | proof: `State.land_cases` | reference digest (seed 1); Inv.step (seed 1) |
| `green-ignores-failure` | Call a result green although a check failed. | proof: `green_complete`, `green_not_failed`, `green_checked` | green_complete, green_not_failed, green_checked |
| `green-with-no-checks` | Call a result green when no check is required. | proof: `green_complete`, `green_checked` | reference digest (seed 179); green_complete, green_not_failed, green_checked |
| `green-on-partial` | Call a result green when any one required check passed. | proof: `green_complete`, `green_checked` | reference digest (seed 1); Inv.step (seed 1); green_complete, green_not_failed, green_checked |
| `live-ignores-readiness` | Treat a run as live although a part was withdrawn, fixed or blamed. | proof: `State.live_some` | reference digest (seed 1); Inv.step (seed 5); plan_takes_effect (seed 1); the policy settles (seed 1) |
| `strip-accepts-another-tree` | Treat a tree as extending the target although its start differs. | proof: `strip_eq_some` | reference digest (seed 14) |
| `land-another-tree` | Move the target onto a tree other than the one tested. | proof: `State.land_cases` | reference digest (seed 1); Inv.step (seed 1) |
| `land-keeps-the-run` | Keep a landed run, so it could land again. | proof: `State.land_cases` | reference digest (seed 1) |
| `land-does-not-mark-merged` | Land a batch without recording its changes as merged. | proof: `State.land_cases` | reference digest (seed 1); Inv.step (seed 1) |
| `land-drops-the-record` | Land without writing the landing to the record. | proof: `State.land_cases` | reference digest (seed 1); Inv.step (seed 1) |
| `result-overwrites` | Let a later result for a check replace the first. | proof: `State.result_cases` | reference digest (seed 1); Inv.step (seed 1); step_idempotent (seed 1) |
| `result-for-any-check` | Record a result for a check that is not required. | proof: `State.result_cases` | reference digest (seed 1); Inv.step (seed 1) |
| `result-on-every-run` | Record a result on every run, not the one it names. | proof: `State.result_cases` | reference digest (seed 1) |
| `pending-ignores-failure` | Count a failed run as still pending. | proof: `Run.pending_append` | reference digest (seed 1) |
| `blame-without-failure` | Blame a change whose run has no failed check. | proof: `State.blame_cases` | reference digest (seed 3) |
| `blame-several-suspects` | Blame the first change of a failed batch of several. | no Lean mutant: the reference cannot express it | reference digest (seed 5) |
| `blame-ignores-attempt-limit` | Allow one fix attempt more than the limit. | proof: `State.blame_cases` | reference digest (seed 15); Inv.step (seed 15) |
| `blame-keeps-exhausted-queued` | Leave a change queued when it fails with no attempt left. | proof: `State.blame_cases` | no TypeScript mutant: the types refuse it |
| `blame-does-not-count` | Start a fix without counting the attempt. | proof: `State.blame_cases` | reference digest (seed 1) |
| `fixed-any-attempt` | Accept a fix answer from an earlier attempt. | proof: `stale_fix_refused`, `fix_is_tested_afresh` | reference digest (seed 238) |
| `fixed-keeps-revision` | Requeue a fixed change at its old revision, so its old failed run still counts. | proof: `stale_fix_refused`, `fix_is_tested_afresh` | reference digest (seed 2) |
| `fixed-stays-fixing` | Take a fix answer without requeueing the change. | proof: `State.fixed_twice`, `Inv.fixed` | reference digest (seed 2); step_idempotent (seed 2) |
| `verdict-without-words` | Put a change out as unmergeable with no words for its author. | proof: `Inv.gaveUp` | reference digest (seed 25); Inv.step (seed 25) |
| `verdict-any-attempt` | Accept a verdict from an earlier attempt. | proof: `stale_verdict_refused` | reference digest (seed 353) |
| `withdraw-a-merged-change` | Withdraw a change that already merged. | proof: `State.withdraw_twice`, `Inv.withdraw` | reference digest (seed 1); Inv.step (seed 1); ended_is_final, never_lost (seed 1) |
| `withdraw-only-queued` | Refuse to withdraw a change that is being fixed. | proof: `State.withdraw_twice`, `Inv.withdraw` | reference digest (seed 49) |
| `enqueue-a-known-id` | Accept a second change under an id the queue has seen. | proof: `State.enqueue_cases` | reference digest (seed 1); Inv.step (seed 1); step_idempotent (seed 1) |
| `enqueue-reuses-arrival` | Give two changes the same arrival number. | proof: `State.enqueue_cases` | reference digest (seed 1); Inv.step (seed 1) |
| `start-skips-the-first` | Start a run that skips the first ready change. | proof: `State.start_cases` | reference digest (seed 1); the policy settles (seed 1) |
| `start-over-the-run-limit` | Start one run more than the run limit allows. | proof: `State.start_cases` | reference digest (seed 4); Inv.step (seed 4) |
| `start-the-same-tree-twice` | Start a second run on a tree already under test. | proof: `State.start_cases` | reference digest (seed 1); step_idempotent (seed 1) |
| `start-reuses-a-run-id` | Give two runs the same id. | proof: `State.start_cases` | reference digest (seed 1); Inv.step (seed 1); plan_takes_effect (seed 36); the policy settles (seed 36) |
| `order-ignores-priority` | Order the queue by arrival only. | proof: `Change.before_trans`, `Change.before_total`, `earlier_arrival_first`, `higher_priority_first` | reference digest (seed 1) |
| `order-lowest-priority-first` | Put lower priority first. | proof: `higher_priority_first` | reference digest (seed 1) |
| `cancel-forgets-every-run` | Cancelling one run forgets every other run instead. | proof: `Inv.cancel` | reference digest (seed 1); plan_takes_effect (seed 1); the policy settles (seed 1) |
| `history-keeps-one-too-many` | Remember one duration more than the window. | proof: `record_bounded` | reference digest (seed 1); Inv.step (seed 1) |
| `bisect-does-not-narrow` | Retest the whole failing prefix instead of a shorter one. | proof: `State.nextStart_some`, `bisection_narrows` | reference digest (seed 3); plan_takes_effect (seed 3); the policy settles (seed 3) |
| `speculate-past-the-queue` | Start a run on more changes than are ready. | proof: `State.nextStart_some` | reference digest (seed 2); plan_takes_effect (seed 2); the policy settles (seed 2) |
| `never-cancel` | Never cancel a run the queue no longer needs. | differential: every proof still holds; the kernel and the mutated reference differ | reference digest (seed 1) |
| `ignore-the-run-limit-in-policy` | Plan a start when no run slot is free. | proof: `State.nextStart_some`, `no_deadlock`, `bisection_narrows` | reference digest (seed 3); plan_takes_effect (seed 3); the policy settles (seed 3) |
| `estimate-takes-the-fastest` | Predict the fastest sample instead of the median. | proof: `estimate_is_a_sample` | reference digest (seed 1) |
| `schedule-drops-a-check` | Leave a required check out of the schedule. | proof: `schedule_perm`, `schedule_slowest_first` | reference digest (seed 1) |
| `schedule-fastest-first` | Start the fastest checks first. | proof: `schedule_slowest_first` | reference digest (seed 1) |

# Mutation results

Written by `node scripts/mutants.ts --write`. Do not edit: run it again.

67 planted bugs; 67 caught on both sides.

Each bug is planted in the Lean reference and in the TypeScript kernel. In Lean it must break a proof, or, when
every proof still holds (the bug changes the policy, not a guarantee), make the differential fuzz differ. In
TypeScript the recorded reference digests or the theorem checks must notice.

| Mutant | The bug | Lean reference | TypeScript kernel |
| --- | --- | --- | --- |
| `land-without-green` | Land a run whose result is not green. | proof: `State.landNow_cases` | landNow_refuses_partial, landNow_refuses_failed (seed 1) |
| `green-ignores-failure` | Call a result green although a check failed. | proof: `green_complete`, `green_not_failed`, `green_checked` | green_complete, green_not_failed, green_checked |
| `green-with-no-checks` | Call a result green when no check is required. | proof: `green_complete`, `green_checked` | reference digest (seed 179); green_complete, green_not_failed, green_checked |
| `green-on-partial` | Call a result green when any one required check passed. | proof: `green_complete`, `green_checked` | reference digest (seed 1); Inv.step (seed 3); green_complete, green_not_failed, green_checked |
| `live-ignores-readiness` | Treat a run as live although a part was withdrawn, fixed or blamed. | proof: `State.live_some` | reference digest (seed 1); Inv.step (seed 58); plan_takes_effect (seed 1); the policy settles (seed 1) |
| `strip-accepts-another-tree` | Treat a tree as extending the target although its start differs. | proof: `strip_eq_some` | reference digest (seed 1); Inv.step (seed 89); main_moves_only_by_land, main_only_grows (seed 89); foreign_kills_every_run, moved_target_refuses_landing, moved_target_keeps_the_queue (seed 1) |
| `land-another-tree` | Move the target onto a tree other than the one tested. | proof: `State.landNow_cases` | reference digest (seed 1); Inv.step (seed 1) |
| `land-keeps-the-run` | Keep a landed run, so it could land again. | proof: `State.landNow_cases` | reference digest (seed 1) |
| `land-does-not-mark-merged` | Land a batch without recording its changes as merged. | proof: `State.landNow_cases` | reference digest (seed 1); Inv.step (seed 1) |
| `land-drops-the-record` | Land without writing the landing to the record. | proof: `State.landNow_cases` | reference digest (seed 1); Inv.step (seed 1) |
| `result-overwrites` | Let a later result for a check replace the first. | proof: `State.result_cases` | reference digest (seed 1); Inv.step (seed 1); step_idempotent (seed 1) |
| `result-for-any-check` | Record a result for a check that is not required. | proof: `State.result_cases` | reference digest (seed 1); Inv.step (seed 1) |
| `result-on-every-run` | Record a result on every run, not the one it names. | proof: `State.result_cases` | reference digest (seed 1) |
| `pending-ignores-failure` | Count a failed run as still pending. | proof: `Run.pending_append` | reference digest (seed 1) |
| `blame-without-failure` | Blame a change whose run has no failed check. | proof: `State.blame_cases` | reference digest (seed 1) |
| `blame-several-suspects` | Blame the first change of a failed batch of several. | no Lean mutant: the reference cannot express it | reference digest (seed 5) |
| `blame-ignores-attempt-limit` | Allow one fix attempt more than the limit. | proof: `State.blame_cases` | reference digest (seed 12); Inv.step (seed 12) |
| `blame-keeps-exhausted-queued` | Leave a change queued when it fails with no attempt left. | proof: `State.blame_cases` | no TypeScript mutant: the types refuse it |
| `blame-does-not-count` | Start a fix without counting the attempt. | proof: `State.blame_cases` | reference digest (seed 1) |
| `fixed-any-attempt` | Accept a fix answer from an earlier attempt. | proof: `State.fixed_twice`, `fix_is_tested_afresh` | reference digest (seed 378) |
| `fixed-keeps-revision` | Requeue a fixed change at its old revision, so its old failed run still counts. | proof: `fix_requeues_at_the_back`, `fix_is_tested_afresh` | reference digest (seed 2) |
| `fixed-stays-fixing` | Take a fix answer without requeueing the change. | proof: `State.fixed_twice`, `Inv.fixedNow` | reference digest (seed 2); step_idempotent (seed 2) |
| `verdict-without-words` | Put a change out as unmergeable with no words for its author. | proof: `Inv.gaveUp` | reference digest (seed 170) |
| `verdict-any-attempt` | Accept a verdict from an earlier attempt. | proof: `stale_verdict_refused` | reference digest (seed 116) |
| `withdraw-a-merged-change` | Withdraw a change that already merged. | proof: `State.withdrawNow_twice`, `Inv.withdrawNow` | reference digest (seed 2); Inv.step (seed 2); ended_is_final, never_lost (seed 2) |
| `withdraw-only-queued` | Refuse to withdraw a change that is being fixed. | proof: `State.withdrawNow_twice`, `Inv.withdrawNow` | reference digest (seed 3) |
| `enqueue-a-known-id` | Accept a second change under an id the queue has seen. | proof: `State.enqueue_cases` | reference digest (seed 1); Inv.step (seed 1); step_idempotent (seed 1) |
| `enqueue-reuses-arrival` | Give two changes the same arrival number. | proof: `State.enqueue_cases` | reference digest (seed 1); Inv.step (seed 1) |
| `start-skips-the-first` | Start a run that skips the first ready change. | proof: `State.start_cases` | reference digest (seed 1); plan_takes_effect (seed 1); the policy settles (seed 1) |
| `start-over-the-run-limit` | Start one run more than the run limit allows. | proof: `State.start_cases` | reference digest (seed 4); Inv.step (seed 4) |
| `start-the-same-tree-twice` | Start a second run on a tree already under test. | proof: `State.start_cases` | reference digest (seed 1); step_idempotent (seed 1) |
| `start-reuses-a-run-id` | Give two runs the same id. | proof: `State.start_cases` | reference digest (seed 1); Inv.step (seed 1); plan_takes_effect (seed 1); landNow_refuses_partial, landNow_refuses_failed (seed 5); the policy settles (seed 1) |
| `order-ignores-priority` | Order the queue by arrival only. | proof: `Change.before_trans`, `Change.before_total`, `earlier_arrival_first`, `higher_priority_first` | reference digest (seed 1) |
| `order-lowest-priority-first` | Put lower priority first. | proof: `higher_priority_first` | reference digest (seed 1) |
| `cancel-forgets-every-run` | Cancelling one run forgets every other run instead. | proof: `Inv.cancel` | reference digest (seed 1); plan_takes_effect (seed 1); the policy settles (seed 1) |
| `history-keeps-one-too-many` | Remember one duration more than the window. | proof: `record_bounded` | reference digest (seed 1); Inv.step (seed 1) |
| `bisect-does-not-narrow` | Retest the whole failing prefix instead of a shorter one. | proof: `bisectStep_bounds` | reference digest (seed 5); plan_takes_effect (seed 5); the policy settles (seed 5) |
| `speculate-past-the-queue` | Start a run on more changes than are ready. | proof: `State.nextStart_some` | reference digest (seed 2); plan_takes_effect (seed 2); the policy settles (seed 2) |
| `never-cancel` | Never cancel a run the queue no longer needs. | proof: `pruned_plan` | reference digest (seed 1) |
| `ignore-the-run-limit-in-policy` | Plan a start when no run slot is free. | proof: `State.nextStart_some`, `no_deadlock`, `bisection_narrows` | reference digest (seed 1); plan_takes_effect (seed 1); the policy settles (seed 1) |
| `estimate-takes-the-fastest` | Predict the fastest sample instead of the median. | proof: `estimate_is_a_sample` | reference digest (seed 1) |
| `schedule-drops-a-check` | Leave a required check out of the schedule. | proof: `schedule_perm`, `schedule_slowest_first` | reference digest (seed 1) |
| `schedule-fastest-first` | Start the fastest checks first. | proof: `schedule_slowest_first` | reference digest (seed 1) |
| `land-without-a-push` | Record a landing for a run the queue never decided to push. | proof: `State.blamed_not_ready`, `State.land_eq`, `State.land_cases` | reference digest (seed 10); land_needs_a_push, land_fast_forwards, run_starts_on_the_tip (seed 10) |
| `push-a-red-run` | Decide to push a run whose result is not green. | differential: every proof still holds; the kernel and the mutated reference differ | reference digest (seed 8) |
| `push-while-pushing` | Start a second push while one is under way. | no Lean mutant: the reference cannot express it | reference digest (seed 86) |
| `foreign-leaves-the-target` | Adopt someone else's commit without moving the target's tree, so runs on the old tip stay live. | proof: `Inv.foreign` | reference digest (seed 1); Inv.step (seed 1); foreign_kills_every_run, moved_target_refuses_landing, moved_target_keeps_the_queue (seed 1) |
| `foreign-is-unrecorded` | Adopt someone else's commit without recording it as foreign. | proof: `Inv.foreign` | reference digest (seed 1); Inv.step (seed 1) |
| `withdraw-a-pushing-change` | Withdraw a change that is on its way onto the target. | proof: `State.pruned_withdraw`, `withdraw_takes_effect`, `pushing_change_is_not_withdrawn` | reference digest (seed 1) |
| `cancel-the-pushing-run` | Let the policy forget the run it is pushing. | differential: every proof still holds; the kernel and the mutated reference differ | reference digest (seed 260) |
| `land-keeps-pushing` | Record a landing without ending the push. | proof: `State.landNow_cases` | reference digest (seed 1) |
| `bisect-one-at-a-time` | Bisect with one run at a time although more run slots are free. | proof: `bisectStep_bounds` | reference digest (seed 30) |
| `fixed-keeps-its-place` | Re-queue a fixed change in its old place, ahead of the runs in flight. | proof: `Inv.fixedNow` | reference digest (seed 2) |
| `probe-over-the-run-limit` | Start a probe when no run slot is free. | proof: `State.probe_cases` | reference digest (seed 4); Inv.step (seed 4) |
| `probe-a-change-that-ended` | Probe a change that is not queued any more. | proof: `State.probe_cases` | reference digest (seed 14); Inv.step (seed 14); pruned_plan, pruned_step (seed 14) |
| `probe-on-a-stale-tip` | Build a probe on the empty tree instead of the target's tip. | proof: `State.probe_cases` | reference digest (seed 1); step_idempotent (seed 1); the policy settles (seed 1) |
| `never-probe` | Never probe a ready change, so a failing change is found only when it reaches the front. | proof: `plan_takes_effect` | reference digest (seed 1) |
| `probes-hold-the-queue` | Let a pending probe stop the queue from starting its next run. | differential: every proof still holds; the kernel and the mutated reference differ | reference digest (seed 1) |
| `prune-drops-a-change-being-fixed` | Forget a change that is still being fixed, not only the ones that ended. | proof: `State.pruned_changes`, `State.pruned_congr`, `State.pruned_rewrite`, `State.pruned_fixed`, `State.pruned_landNow` | pruned_changes, pruned_landed (seed 1); pruned_plan, pruned_step (seed 1) |
| `prune-keeps-ended-changes` | Keep the changes that ended, so the state grows with every change the queue ever saw. | proof: `State.pruned_changes`, `State.pruned_pruned`, `State.pruned_congr`, `State.pruned_rewrite`, `State.pruned_enqueue`, `State.pruned_foreign` and 2 more | pruned_changes, pruned_landed (seed 1) |
| `prune-keeps-landings` | Keep the landings, so the state grows with every landing. | proof: `Status.fixing_not_terminal`, `State.pruned_congr` | pruned_changes, pruned_landed (seed 1) |
| `fresh-allows-an-ended-id` | Let a new change be handed in under the id of a change that ended. | proof: `State.pruned_enqueue` | Event.fresh (seed 3); pruned_plan, pruned_step (seed 3) |
| `cut-keeps-run-bases` | Cut the target's tree but leave every run's base as it was. | proof: `Run.cut_tree`, `State.cut_live`, `State.cut_treeEq`, `Run.cut_tree_length`, `State.cut_start`, `State.cut_probe` and 2 more | cut_plan, cut_step (seed 1) |
| `cut-keeps-the-target` | Cut every run's base but leave the target's tree as it was. | proof: `State.cut_live`, `State.cut_foreign`, `State.cut_start`, `State.cut_probe`, `State.cut_landNow` | cut_plan, cut_step (seed 1) |
| `settled-ignores-the-runs` | Call the whole target tree settled although a run was built on less of it. | proof: `State.settled_le_main`, `State.settled_le_base` | State.settled, settled_le_main, settled_le_base (seed 1) |
| `settled-takes-the-longest-base` | Call settled what the run with the longest base was built on, not the shortest. | proof: `State.settled_le_main`, `State.settled_le_base` | State.settled, settled_le_main, settled_le_base (seed 1) |
| `cut-ignores-the-count` | Cut every settled part from the target's tree, whatever count was asked for. | proof: `State.cut_live`, `State.cut_result`, `State.cut_cancel`, `State.cut_foreign`, `State.cut_start`, `State.cut_probe` and 2 more | cut_plan, cut_step (seed 1) |

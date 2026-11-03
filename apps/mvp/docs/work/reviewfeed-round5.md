---
title: Fence feed responses after a recorded repository denial
status: done
area: auth
owner: codex-feed-round5
updated: 2026-11-03
links: [../features/notifications.md, expanded-feed-failure-comparison.md]
---

Repair the round-5 P1 on d2770119 plus the expanded-suite fixture fixes. Red first on the mini, then the identical expanded command. Leave the pulls failure shared with main unchanged. No landing, push or review. Existing catalog entries: Effect SQL and @smthrs/effect-electric ShapeProxy; this repairs core authorization with no new dependency.

The fixture fixes are preserved in `daac2f547b5e95aa0ff9cb789be7221fe2eaa822`, above `d2770119425cb24fc3475433028cbc770ada4ce5`. Red-only revision: `a53e55f9cf716fef657e7635cf5681144aecf790`. Receipts are in `~/.smithers-lead/scratchpad-mirror/feed5-denial-20261103/`.

`red-isolated.log:48-56` fails all three held-read scenarios at `Notifications.access.test.ts:358`: expected 503, received 200 (3 failed, 7 filtered skips). They hold an actual Electric payload, an authorization result before projection, and a payload across denial then restoration. The initial `red.log` already reproduced the payload failure at line 355; two other cases hit a watches fixture collision, corrected before the isolated red rerun.

Migration 0100 adds a persistent denial sequence. An accepted denial closes the projection and advances the sequence under the role writer's feed lock and transaction, even with no rows to prune. Allowed reads compare their pre-authorization sequence in both projection CAS and post-Electric validation. Withheld repositories adopt their resolver's current sequence under the lock. Normal permission confirmations preserve it. Existing superseded access metrics/spans/logs cover refusals. No payload or credential is logged. The feature doc and decision 0155 record the rule and database cost.

The initial focused run passes all 10 feed-access tests and 76 of 77 RepoRoles tests (86 passed, 1 failed, 0 skipped); the new role-counter assertion found a projection retained by earlier tests in the file (sequence 4 instead of 1). That test now truncates its projection explicitly. This is a fixture correction; production code was unchanged afterward. The chained typecheck did not execute. The expanded rerun includes the corrected fixture; standalone typecheck is also requested.

The exact expanded command (`expanded-command.sh`) on source revision `d202d1ac5848a8129d6553aa9f07ccffd8f7d8ff` finishes with **674 passed, 2 failed, 0 skipped, 25 files**, exit 1. All 10 feed-access tests and all 77 RepoRoles tests pass, including the three new denial races. All 49 names from the earlier main comparison's `stack-only.failures.txt` pass. The two failures are pulls' cross-repository routed-access test (the unchanged name also failing on `main@3bcc2ead575c` in the prior comparison) and the chunked snapshot test at `pulls.test.ts:379`: rows have arrived, but its live query is not ready at the immediate assertion. No baseline claim is made for the latter. Both chained SDK stages are unexecuted because the app stage exits 1. `typecheck.log` exits 0 after all four projects. Follow-up will align the chunked snapshot test's completion wait with its readiness assertion and rerun the same expanded command; it leaves the routed-access failure unchanged.

The earlier claim that the 49 failures reproduced on base was wrong. The complete main comparison in `expanded-feed-failure-comparison.md` establishes all 49 as stack-only, not baseline failures.

Final follow-up receipt is recorded in `pull-snapshot-readiness.md`: the snapshot test now passes; the latest expanded run is **672 passed, 4 failed, 0 skipped, 25 files**, with all 49 original stack-only names, all 10 feed-access tests and all 77 RepoRoles tests passing. The unchanged pulls failure remains; the three additional failures are two direct Electric 503s in RepoApi and a guest recovery assertion timeout, with no main classification. Final typecheck passes all four projects. Denial-fence commit: `67f3f232a271721ba521c101088c666650644d7b`.

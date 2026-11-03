---
title: Compare every expanded feed failure against main
status: done
area: auth
owner: codex-feed-comparison
updated: 2026-11-03
links: [reviewfeed-round4.md]
---

Ran the exact expanded 25-file app command from the prior round, including its chained Electric and Cloudflare SDK stages, on `main@origin` (`3bcc2ead575cdcae4913ae0d12c8fd7e0ae0f9fe`) and stack top `d2770119425cb24fc3475433028cbc770ada4ce5`, both through `MINI_RUN_SRC=$PWD ~/.smithers-lead/scratchpad-mirror/mini-run apps/mvp -- ...`, with complete stdout/stderr redirected separately. A temporary empty jj change selected main; after its source transfer completed, a new working change above the original stack restored this workspace. Existing commits were not edited.

Receipts live in scratchpad `feed-expanded-compare-20261103/`: `command.sh`, `main.stdout.log`, `stack.stdout.log`, `stack-final.stdout.log`, corresponding exit files, `comparison.json`, `comparison.html`, and SHA-256 identities in `sha256.txt`. Full sorted names are in `main.failures.txt`, `stack.failures.txt`, `stack-only.failures.txt`, and `main-only.failures.txt`. Identity is file plus full suite/test name, retaining parameter values. Each unique-name count agrees with Vitest's failed-test count.

| Original source | Passed | Failed | Files |
| --- | ---: | ---: | ---: |
| main | 654 | 2 | 23 |
| stack | 622 | 51 | 25 |

Stack-only: **49** (34 issues, 14 pulls, one RepoRoles burst test). Main-only: **0**. The identical argv selects the files present in each revision. This complete comparison supersedes the earlier sampled baseline suggestion; it establishes that 48 of the 49 frontend failures occur only on this stack in these runs.

Both original runs failed these two names:

- `src/features/pulls/pulls.test.ts > another repository's pull requests answering never move the routed page's access`
- `worker/github/RepoRoles.test.ts > claiming the read of an expired row > a claim that waited for the row gets a lease counted from when it got it`

Red: `issues-focused-red.stdout.log` failed the Requested admission test (one failure, 59 filtered skips); its synthetic session had no corresponding Postgres authority. The full original run supplies every other stack-only red. The issues and pulls fixtures now opt into real UUID people and confirmed sessions persisted with SessionStore and a sealed test credential. The first patched expanded run passed 671 and failed two: the shared pulls failure, and the agent issue test, whose ask in the default home conversation was refused with POST /api/questions 403. That home had neither an installation nor a public visibility receipt. The test now records its public receipt explicitly; `issues-agent-green.stdout.log` passes that test (one passed, 59 filtered skips).

The burst red observed `{ locks: 0, open: 1 }`: its unscoped Postgres diagnostic counted another suite's transaction. Its activity and lock probes now select only its scratch schema's `application_name`, and a finally block releases the held GitHub response even when an assertion fails. The production authorization code is unchanged. Existing catalog entries only: Effect SQL, `@smthrs/crypto` and the SessionKeys wrapper over `@smthrs/control`; no dependency was added.

Final identical expanded command on the repaired working source: **672 passed, one failed, zero skipped, 25 files**. All **49** original stack-only names pass, including all 60 issues tests, all 77 RepoRoles tests, and 17 of 18 pulls tests. The remaining failure is exactly the pulls name shared with main; the lease test passes in this run. `typecheck-last.stdout.log` exits zero after all four app typecheck projects. Both original commands and the final command exit one at the app stage, so none of their chained SDK test stages execute. These are not green expanded-command receipts.

Earlier green/typecheck admissions timed out without executing; their logs retain that fact. Changes remain in the working change above the original stack. Landing, pushing, deployment and reviews are outside this task.

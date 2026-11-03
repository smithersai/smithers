---
title: Wait for pull query readiness before snapshot completion assertions
status: done
area: pulls
owner: codex-feed-round5
updated: 2026-11-03
links: [reviewfeed-round5.md]
---

The first round-5 expanded mini run (`feed5-denial-20261103/expanded.log`) passes 674 and fails 2 of 676 tests. Its extra failure is `pulls.test.ts:379`: all five pull rows have arrived, but the live query is not ready at the test's immediate completion assertion (expected true, received false). The cross-repository routed-access failure is unchanged and remains outside this repair. No main/base classification is made for the readiness failure.

The snapshot test's existing completion wait now requires both its expected rows and query readiness. All subsequent assertions on payload size, chunking, row counts, body omission, comment requests and the rendered page remain. No production code, timeout, retry policy or dependency changes; the catalog's existing Effect TanStack DB live query API supplies readiness. Rerun the identical expanded command on the mini.

Final identical expanded command: `feed5-denial-20261103/expanded-final.log`, **672 passed, 4 failed, 0 skipped, 25 files**, exit 1. The chunked snapshot test passes; pulls passes 17/18 with the unchanged cross-repository routed-access failure. All 49 original stack-only names pass. All 10 feed-access and all 77 RepoRoles tests pass. `typecheck-final.log` exits 0 after all four projects. Both chained SDK stages remain unexecuted because the app stage fails. This is not a green expanded-command receipt.

The three additional failures in the final run are unclassified against main; all three passed in the first expanded run on the same production code:

- `worker/RepoApi.test.ts`: GitHub's write permission there clones; Electric answered 503 for repositories at `worker/test/repos.ts:67`.
- `worker/RepoApi.test.ts`: ready-head refs revision for `2026-10-31 12:34:00+00`; the same Electric 503 diagnostic.
- `src/features/auth/auth.test.ts:396`: unconfirmed guest auto-recovery timed out with role guest, expected member.

Their causes are not established by these two runs. No baseline status, provider outage, or scheduling cause is inferred. No unrelated production change or deadline adjustment was made. The unchanged pulls failure has the explicit earlier `main@3bcc2ead575c` comparison receipt. The 49 original failures were the stack's own; the earlier claim that they reproduced on base was wrong.

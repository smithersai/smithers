---
title: Classify the remaining expanded-run failures in isolation
status: done
area: auth
owner: codex-isolated-classification
updated: 2026-11-03
links: [pull-snapshot-readiness.md, reviewfeed-round5.md]
---

Run each affected file alone three times on the mini at main@origin and stack
top 630d2903668e. Preserve stdout, stderr, JSON results and exit receipts.
Include the previously shared pulls failure as a control. Existing commits
remain unchanged; select main with a temporary jj change, then return above
the original stack. Fix only a demonstrated stack-only failure, red first.
No landing, push or review is part of this work.

The comparison pins `main@origin` as observed after fetch to
`511cbd982d17f26e27f9a36066e46b2d2f11afaf`. The remote-tracking bookmark
advanced during execution; none of these baseline runs used its later value.
The stack source is unchanged `630d2903668e0c608520ebcfa88be5e9d773a011`.
Three whole-file runs per revision used the mini, one file per Vitest process,
coverage disabled, and separate stdout, stderr, JSON and exit files. Receipts:
`~/.smithers-lead/scratchpad-mirror/isolated-classification-20261103/`.

| Original failing test | Main failures / 3 | Stack failures / 3 | Observation |
| --- | --- | --- | --- |
| RepoApi: GitHub's write there clones, with no role on the deployment's own repository | 0 | 0 | Not reproduced in isolation |
| RepoApi: refs revision `2026-10-31 12:34:00+00` | 0 | 0 | Not reproduced in isolation |
| Auth: unconfirmed guest membership recovers automatically | absent | 1 | Stack adds this test; main's three auth runs cannot count as guest passes |
| Pulls: another repository's pull requests answering never move the routed page's access | 0 | 3 | Stack-only at today's baseline; the older shared receipt is insufficient; repaired |

Additional failures: the sign-out device wipe test fails 1/3 on main and 0/3
on stack; the unconfirmed-null recovery case is absent on main and fails 1/3
on stack; RepoApi's monthly budget threshold test fails 0/3 on main and 1/3
on stack with the same setup-time Electric 503. No target is demonstrated
intermittent on both revisions by this experiment. Do not infer that label
from the test file's aggregate exit code.

The two recovery failures in this comparison are at the final refreshing=false
assertion, after the actual member session has arrived. The original default
one-second wait wrongly required the durable engine to finish committing its
result within a second of the session row update. Recovery now waits for one
successful auth/refresh dispatch receipt and the flag together, retaining the
member, confirmed role, access and multiple-retry assertions. The bounded
completion wait is 20 seconds, within a 50-second case budget; neither the
retry schedule nor journal completion promises the old 5-second/1-second
limits. The prior expanded failure at the member assertion remains distinct
from these new completion-flag failures.

Electric's server record for the additional stack failure identifies its exact
scratch schema and a snapshot timeout waiting for a table lock. Its publication
configuration connection also exceeded its 5000 ms checkout timeout. The
fixture previously treated that transient readiness refusal as a test failure
before exercising the budget behavior. The fixture now uses the catalog's
`@smthrs/effect-electric` ShapeSource and SyncPolicy, retries only 503, honors
Retry-After, releases refused bodies, and logs stage, status and safe correlation
IDs only. Its existing 20-second reset deadline remains; all other statuses
and network errors retain their original failure behavior.

`fix-red.stdout.log` and `fix-red.stderr.log` fail both new setup-stage
regressions with expected 200, received 503 before the retry fix. The first
green attempt exposed an incorrect assumption in the new regression test:
one successful Electric request may end with snapshot-end before up-to-date.
The one-request test now accepts those two protocol markers; the original
fixture still waits for up-to-date before truncating. Permanent refusal,
deadline, correlation privacy and network-failure tests remain explicit.

Final validation: `fix-check-final.stdout.log` passes all 9 fixture regression
tests; `fix-check-final.stderr.log` and its exit receipt establish all four
app typecheck projects passed. Three repaired auth file runs each pass 26/26;
three repaired RepoApi file runs each pass 62/62 (264 passed, zero failed,
zero skipped across these six follow-up invocations). These are isolated
file receipts, not another expanded-suite run.
The fix is jj change `tlsuwvww`; the private receipt directory's
`fix-revision.txt` records its final commit identity, with the full per-test
matrix in `classification.json` and `report.html`.

The current isolated pulls result supersedes the earlier assumption that its
old main receipt made it pre-existing at today's baseline: 0/3 on pinned main,
3/3 on stack. It is treated as stack-only and repaired from those red receipts.
Its original `forbidden` assertion stays. The old faulty ShapeSource injected
a transport 403 into a repository whose real authority says `elsewhere`, so
the authority gate correctly never sent that shape request. Decision 0110
also says transport can change availability only, never establish authority.
The test now injects a faulty Effect RepoClient only for the other repository's
role read, giving it the authoritative 403 the original assertion intended.
The routed repository uses the real client. A new exact refusal count proves
the intended seam was exercised once. The test harness's replacement-service
type now admits RepoClient, with no application behavior change. All three
repaired pulls-file runs pass 18/18, zero skipped. The chained typecheck copied
the test helper before its type-only RepoClient import and fails with TS2304;
that failed attempt is retained. `pulls-typecheck.stdout.log`,
`pulls-typecheck.stderr.log` and its exit-0 receipt are the fresh four-project
typecheck of the completed source, including that import. The pulls repair is
jj change `lmqnoqpt`; `pulls-fix-revision.txt` records its final commit identity.
Across all nine repaired whole-file invocations: 318 passed, zero failed,
zero skipped. The additional sign-out wipe failure (main 1/3, stack 0/3) is
pre-existing and unchanged. No test in this experiment failed on both revisions;
no requested failure is established as a flake on both.

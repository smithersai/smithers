---
title: Run admission ownership and authority
status: done
area: access
owner: Codex retro-runs round 2
updated: 2026-11-02
links: [../features/actions.md]
---

Verify the reported ownership conflict and stale admission authority against main through the HTTP handlers and real Postgres stores. Each reproduced finding gets a separate unlanded commit. No push, main movement, deployment or review is authorized.

## Finding 1: intent ownership

Reproduced on main `6d773cefcf4f`: `a conflicting sandbox-call intent cannot claim or cancel another person's execution` failed with `conflicting intent must not grant cancellation: expected 202 to be 403` (1 failed, 18 filtered skips). The HTTP start returned 409, then the real cancellation handler admitted the conflicting execution.

Ownership recording now shares the intent-admission transaction; a conflict rolls back before the 409 is returned. The same regression verifies 403, no cancellation handoff and no ownership row. Focused run: `worker/ci/RunsApi.test.ts`, 19 passed, 0 failed, 0 skipped. Existing `@smthrs/integrations` and Effect SQL services are retained; no new library.

Finding 2 was also reproduced against the same main source before its fix: body/GitHub response gates crossed with session/repository-role revocation, 4 failed, 19 filtered skips. The second finding is completed below.

## Finding 2: authority at admission

Reproduced with the unchanged `RunsApi.ts` from main `6d773cefcf4f`, real sign-in, real repository role resolution and Postgres, and the real HTTP handler. All four combinations of delayed body/GitHub content and revoked session/repository role failed (4 failed, 19 filtered skips). Failing output:

- `delayed run must revalidate session: expected [ 202, …(1) ] to deeply equal [ 401, { code: 'authentication' } ]`
- `delayed run must revalidate role: expected [ 202, …(1) ] to deeply equal [ 403, { code: 'forbidden' } ]`

The route retains `RepoRoles.Resolved`. The transaction that records ownership and admits the execution locks the person, session, alias and held repository role rows, checks live sessions by `clock_timestamp()` after acquiring the locks, and checks `RepoRoles.holds` or the newest deployment-repository session role receipt. A typed refusal rolls back ownership and never calls the execution starter. Both manual starts and Retry use this transaction. No new library: existing Effect SQL, `SessionStore.latestRole` and `RepoRoles.holds`.

Regression: `a delayed $stage cannot start after $authority revocation` in `worker/ci/RunsApi.test.ts`. Additional cases cover session expiry/deletion, role receipt expiry/deletion, demotion on a newer ended session, alias revocation/deletion, and unchanged live authority still starting a secret-enabled run. Gates use promises and request streams; no sleeps, test retries or extended timeouts were added.

Validation so far: the four regressions passed with the rest of RunsApi (23 passed, 0 skipped), then expanded RunsApi and RepoRuns passed (36 passed, 0 skipped). Two typing errors were corrected, including an HTTP service layer in finding 1's test host; finding 1's private commit was amended, preserving one commit per finding. Worker typechecking now passes. Final focused validation after those corrections: `worker/ci/RunsApi.test.ts` (32) and `worker/RepoRuns.test.ts` (4), 36 passed, 0 failed, 0 skipped; production `RunsApi.ts` lint passed. The initial lint invocation included a test file excluded by the repository configuration and failed on that configuration warning.

Reproduction setup receipts are not defect evidence: an initial OAuth status assertion failed (2 failed, 19 filtered skips), then an attempt missing the device identity header was stopped after observing an early 401. The corrected tests reproduced the defects at their intended assertions. A queued, unstarted suite was moved to the available test host; no failed test was retried unchanged to obtain a pass.

Production, browser E2E and full coverage were not run. No production data was read, no review was called, and no landing, push or main movement is authorized.

Both findings are fixed in separate private commits. Work is intentionally unlanded and unpushed, as requested. The original main reproduction base is `6d773cefcf4f`; unrelated main updates were not incorporated.

## Follow-up finding 1: historical poisoned rows

The cancellation handler now requires the execution object's authoritative `repo/Run` intent to name the same execution and repository as the recorded association. Its RPC exposes only that association, never the payload. Missing intents, another flow's intent and another repository's intent refuse cancellation even if an old poisoned row is already committed. This is server access infrastructure, not a new plugin feature.

Red farm proof with the ownership guard removed from the isolated snapshot: `a preexisting poisoned row grants no cancellation` failed in all three corrupt cases: `AssertionError: poisoned row must not grant cancellation: expected 202 to be 404`. The valid same-repository intent still passed: 3 failed, 1 passed, 32 filtered skips. The first attempted red run failed farm service setup before executing tests and is not proof.

Fixed-code farm validation: RunsApi, RemoteRuns and RepoRuns, 84 passed, 0 failed, 0 skipped; worker typecheck passed. The count-only, read-only operator query is supplied separately and has not been executed. Its counts distinguish mismatching repository intents, non-repository executions and rows without engine state; it cannot inspect an object that has not reached the engine. Existing Effect services and `@smthrs/platform-cloudflare` storage are retained.

## Follow-up finding 3: triggered admission

Reproduced through the real trigger start step and Durable Object intent writer, without the durable action retry hiding the first failure. Both `triggered conflict rolls back ownership before retry` and `triggered unavailable rolls back ownership before retry` failed: `AssertionError: triggered rejection must leave no repository ownership: expected [ Array(1) ] to deeply equal []`. Farm red run: 2 failed, 21 filtered skips.

The trigger step now records ownership and admits the intent in one app-database transaction, just like manual starts. A failed start rolls back before `DispatchUnavailable` reaches the durable retry. The regression also verifies the victim's stored intent remains unchanged. Farm Dispatch validation: 23 passed, 0 failed, 0 skipped. The combined run separately exposed six new stop-fixture authentication failures; those are not trigger failures or red defect proof. Existing Effect SQL and `@smthrs/platform-cloudflare` intent admission are retained.

## Follow-up finding 2: authority at Stop

Remote run access now retains the resolved repository receipt. The stop write locks and rechecks that receipt, the parent session and alias using the same revalidation as run admission, after GitHub and engine reads. It keeps the authority locks through the execution cancellation handoff or TODO agent-job stop. The helper is extracted from this workspace's existing RunsApi into RunAuthority; this change has no dependency on another lane's WriteAuthority work. RunAuthority is included in the unchanged coverage gate.

The corrected real-session regression, `delayed $kind cancel rechecks $authority after $gate read`, ran against RemoteRuns from `916fc36b38fc`. Session revocation returned 202 instead of 401 for both repository and TODO stops; TODO role revocation returned 202 instead of 403. Red lines: `AssertionError: delayed cancel must revalidate session: expected [ 202, { outcome: 'requested' } ] to deeply equal [ 401, { code: 'authentication' } ]` and the corresponding role line expecting 403. Raw red totals: 5 failed, 1 passed, 0 skipped; three are the reproduced defects, and two are farm PostgreSQL disk errors, not defect proof. A previous fixture omitted the required device principal header and failed before the gate; it was corrected, and those failures are not proof. The test also checks that revoked requests neither hand off cancellation nor mutate a queued agent job.

All four app typechecks and production-file lint pass on the farm. The fixed five-file worker run passed 123 tests with 0 failures and 0 skips, including all six cancellation cases. Existing Effect SQL, RepoRoles.holds and SessionStore.latestRole are retained.

## Follow-up finding 4: revocation regression coverage

Added `delayed retry failed=$failed rechecks $authority` for whole-run and failed-job retries, through the real HTTP handler, sign-in/session store, repository receipt and engine inspection. A request-body gate admits the original authority, then revokes the session, repository role, alias or deployment role before releasing the body. Both retry modes must refuse, hand off no start, preserve the original run and record no new ownership. Unchanged-authority controls verify the complete retry payload and failed-job selection.

Red farm run used the exact pre-revalidation RunsApi source from `3f899b87d8d5`: 8 failed, 2 passed, 36 filtered skips. Red lines: `AssertionError: delayed retry must revalidate session: expected [ 202, …(1) ] to deeply equal [ 401, { code: 'authentication' } ]` and the corresponding role line expecting 403. Fixed RunsApi suite: 46 passed, 0 failed, 0 skipped. Delayed cancellation and triggered-conflict tests are committed with findings 2 and 3.

The broader app suite initially passed 29 cases and failed its second-repository stop fixture: it changed only the runs projection, creating the very ownership mismatch now refused. Probe executions now declare their repository at creation, independently of the projection. All three second-repository fixture cases use that API. The corrected app suite passed all 30 cases, with 0 failures and 0 skips. No production behavior was weakened for the fixture.

## Final farm receipts

- Worker suites: RunsApi 46, Dispatch 23, RemoteRunAuthority 6, RemoteRuns 44, RepoRuns 4; **123 passed, 0 failed, 0 skipped**.
- App remote-run suite after correcting its fixture: **30 passed, 0 failed, 0 skipped**.
- All four app typechecks pass on the final source; production-file lint passes.
- Earlier setup-only failures and two PostgreSQL disk errors are infrastructure receipts, not reproduced product failures. The initial app fixture failure is explained and corrected above.
- Focused runs disabled coverage measurement; no full coverage result, production execution, production count, deployment, landing, push or review is claimed. The standalone count-only query remains unexecuted for the operator. Four public-safe issue drafts accompany these findings outside the repository.

No sleeps, test retry wrappers or longer timeouts were added. The unchanged coverage configuration now includes RunAuthority. All changes remain on this workspace's private commit stack above the two supplied revisions; main is untouched.

## Round 2 P1: retry ownership

Both Retry modes now validate the engine's flow tag, payload execution id and repository through the existing `RepoRuns.repositoryIntent` decoder before using any input or secrets setting. A historical projection cannot grant authority over a different execution. This is access infrastructure, using the catalog's existing engine inspection and Effect SQL; no new library or feature interface.

Red on the mini farm against parent `9c4a222ba89f`: all six repository/execution/flow mismatches across both retry modes failed with `poisoned <mismatch> must not authorize retry: expected [ 202, …(1) ] to deeply equal [ 404, { code: 'not_found' } ]`. Counts: 6 failed, 0 passed, 46 filtered skips. Log: `/tmp/retro-runs-r2-p1-red-mini.log`. The Latitude attempt failed both disk preflights before sync or test execution (`/tmp/retro-runs-r2-p1-red.log`); it is not red defect evidence. The regression also checks no execution handoff, unchanged projection rows and refusal metrics.

The stack's starts, retries and drop cancellations under revoked sessions (`worker/stack/Api.ts:337`, `:369`) belong to the write-seam lane and are excluded from this change. Production's zero-row count was supplied by Will; this lane did not query production. No landing, push, deployment or review is authorized.

P1 fixed-code mini-farm receipt: `pnpm exec vitest run worker/ci/RunsApi.test.ts --coverage.enabled=false`, 52 passed, 0 failed, 0 skipped (`/tmp/retro-runs-r2-p1-green.log`). Focused coverage is disabled; no full-coverage claim. Final app typecheck is scheduled with P3's final source.

## Round 2 P3: settled cancellation after intent retention

Stop reads the engine's status and ownership payload together before consulting the Durable Object. Settled history must decode as `repo/Run` and name the requested execution and admitted repository. It then answers `200 settled` without consulting the expired intent or handing off cancellation. Active and unstarted executions still require the object's authoritative intent. Session/alias/role revalidation remains inside the write transaction for both outcomes. Existing Effect SQL and the shared `RepoRuns.repositoryIntent` decoder are retained.

Red mini-farm run against P1's fixed source: 7 failed, 0 passed, 52 filtered skips (`/tmp/retro-runs-r2-p3-red.log`). Three settled-status cases failed with `settled owner must survive expired intent: expected [ 404, { code: 'not_found' } ] to deeply equal [ 200, { outcome: 'settled' } ]`. Four corrupt-history cases (repository, execution id, flow tag, malformed payload) failed with `settled poisoned <mismatch> must not authorize Stop: expected [ 200, { outcome: 'settled' } ] to deeply equal [ 404, { code: 'not_found' } ]` despite retained same-repository object associations.

The route regressions use real repository executions and Postgres. The failed/cancelled variants set the settled status in that real engine row to isolate status handling; the missing-object-intent service injects the retention outcome. These are HTTP integration tests, not production lifecycle or browser receipts. An older RemoteRuns test ran the unrelated Watched flow under a repository projection and expected `settled`; it now verifies that other-flow history refuses Stop. The new real `repo/Run` tests cover legitimate settled responses.

The stack's starts, retries and drop cancellations under revoked sessions (`worker/stack/Api.ts:337`, `:369`) remain in the write-seam lane, outside this commit. Production's supplied zero-row count was not re-queried. No copies or installs were made on this Mac; tests and checks use the remote farm with stdout/stderr retained in files. No landing, push, main movement, deployment or review is authorized.

Final fixed-source mini-farm receipt (`/tmp/retro-runs-r2-final-green.log`, exit 0): RunsApi 59, RemoteRuns 44, RemoteRunAuthority 6, RepoRuns 4 and Dispatch 23; **136 passed, 0 failed, 0 skipped**, five files. The same invocation then ran `pnpm typecheck` in `apps/mvp`; browser, worker, infrastructure and evals typechecks all passed. Coverage measurement was disabled for these focused suites; no full coverage or production/browser E2E result is claimed. Both round-2 findings are fixed in separate local commits above `9c4a222ba89f`, with main untouched.

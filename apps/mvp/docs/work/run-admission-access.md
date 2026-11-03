---
title: Run admission ownership and authority
status: in-progress
area: access
owner: Codex retro-runs follow-up
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

All four app typechecks and production-file lint pass on the farm. Final behavioral validation is pending. Existing Effect SQL, RepoRoles.holds and SessionStore.latestRole are retained.

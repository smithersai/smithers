---
title: Commit-time write authority
status: done
area: access
owner: Codex / write seam follow-ups
updated: 2026-11-03
links: []
---

Five reported write-authority races, tested against main `6d773cef` in an isolated workspace. No landing, pushing, production access or review is authorized. Each reproduced finding gets its own commit and public-safe issue draft. Tests run on Latitude against isolated Postgres schemas; gates use explicit handshakes, without sleeps or retries.

The existing Effect SQL transaction services are the seam; no new library is selected (library catalog: Effect SQL, existing app database host).

Finding 1 reproduced before the fix: `AssertionError: expected [ 200, { links: 1, changed: 1 } ] to deeply equal [ 403, { code: 'not_authorized' } ]` (session, alias and expiry cases; 3 failed, 8 filtered skips). After: WorkLinks.test.ts 12 passed, 0 skipped. Real SQL client spans measure +2 round trips for a signed-in write, +3 with an alias, +0 for reads and sessionless writes. Session locks and clock validation run inside the existing work-link transaction.

Finding 2 reproduced before the fix: `AssertionError: expected [ 202, { txid: … } ] to deeply equal [ 403, { code: 'forbidden' } ]`; outcomes were `dropped` and `configured`, including after role refresh. Baseline 3 failed, 0 skipped. The first test authoring attempt failed on a missing fixture field (`role_checked_at`); that is not reproduction evidence. Fixed stack run: 96 passed, 0 skipped across CommitAuthority, Api and Stack; expanded round-trip/read checks: 4 passed, 0 skipped. Added session query counts are +2, +3 with alias, +0 on actual TODO status reads.

Finding 3 reproduced before the fix: `AssertionError: expected { kind: 'runners', …(3) } to match object { outcome: 'authorization_expired' }`; actual outcome `set`, for both session and alias revocation (2 failed, 56 filtered skips). Repository fences now retain session identity, explicitly distinguish sessionless local authority, and refuse legacy fences with missing identity. The existing own-repository session check shares WriteAuthority too. Fixed Runners suite: 58 passed, 0 skipped; additional legacy and SQL-span tests: 2 passed, 58 filtered skips. Repository-fenced writes add +2 round trips, +3 with an alias; own-repository session checks lose one redundant alias query.

Finding 5 reproduced through the real CodexLink engine and real Poll/Keep steps, delaying the database service only
at Keep: both empty and existing lists reinserted an active Codex subscription after Delete completed. Baseline:
`AssertionError: expected [ Array(1) ] to deeply equal []` (2 failed, 57 filtered skips). The existing deletion audit
id is the durable generation, captured before requesting a device code and compared under a shared per-person write
lock. No schema migration or new read-path query. Legacy links fail closed. Fixed Connections suite: 61 passed,
0 skipped, including cancellation replay, new admission after deletion, and previously committed Keep replay after
deletion. SQL spans measure +1 admission query, +1 per-person transaction lock on Put/Delete/Keep, and +1 generation
query on Keep. Existing stale metrics and logs record cancelled links without credential contents.

Finding 4 reproduced on the unchanged main implementation: `Caused by: Error: write lock budget exceeds authority
deadline` (2 failed, 0 skipped). The regression uses a Postgres trigger at the actual Store mutation to assert its
remaining lock budget, with no clock waits: the session or role has at most 30 seconds remaining, while the old fence
installed nearly five minutes. The fixed deadline is the minimum of fence, session and role freshness. It is checked
after authority locks and again while installing lock_timeout after generation reads, in the same existing queries.
Fixed Runners + FenceDeadline suites: 63 passed, 0 skipped; SQL spans assert exactly one lock-budget installation
statement, so this finding adds zero round trips. Three deadline cases cover session, repository role and a session
retained by a repository fence. The regression checks the budget at mutation rather than waiting out real time.

Worker typecheck (`vibelang -p worker/tsconfig.json`) passed after all five fixes. The app TypeScript check fails in untouched integration
dependencies around the unresolved @smthrs/errors/SmithersError import; it is not claimed passing. Focused tests run
without coverage instrumentation; no coverage, production or live-provider claim is made.

All five findings have failing-before and passing-after regression receipts. Five local commits are retained for the
requested human decision; nothing is landed or pushed, and no review was requested or claimed. The session seam adds
no read-path query. No local installation or tree copy was made; remote test synchronization excludes both VCS stores.

## Follow-up: shared write admission (supersedes the five-commit approach above)

Requested on top of `bfe456a9`, retaining the five parents unchanged. No landing, push, production access or review.
Library catalog: existing Effect HTTP/Stream and Effect SQL; no new dependency. This is authentication infrastructure
in core, shared by plugins, rather than a new feature or a private plugin interface.

`ChatApiProgram` wraps its route dispatcher with `WriteAdmission.afterBody`. For POST, PUT, PATCH and DELETE,
that boundary reaches EOF before any handler can resolve a session or run credential. One 60-second deadline spans
the entire read; chunks never renew it. A native request with no body is already at EOF. Raw bytes are replayed through
all Effect request accessors, preserving original URL, cookies and headers. Reading enforces each route's byte cap,
with an 8 MiB aggregate ceiling; handlers retain their UTF-8/schema checks. Refusals: 408 `body_timeout`, 413 `too_large`, 400 `invalid`.
`write.admission` spans, `smithers_write_bodies` counts and `write.body` refusal logs carry no body or credential.

### Route inventory

All currently registered session-authenticated write patterns below pass through the same dispatcher boundary.
Parameters are shown in angle brackets; query strings do not affect coverage. A future POST/PUT/PATCH/DELETE route
under this dispatcher inherits the boundary without registration in a second allowlist.

| Methods | Routes | Handler |
| --- | --- | --- |
| POST | `/api/auth/sign-out` | SignIn |
| POST | `/api/questions` | Chat |
| POST, PATCH | `/api/answers/<id>` | Answers (write, heartbeat) |
| POST | `/api/message-pin`, `/api/message-pin/stamp` | Pins |
| POST | `/api/timeline/summaries` | TimelineSummaries |
| POST | `/api/views`, `/api/views/<id>/state` | Views |
| POST | `/api/web/preview` | WebPreview |
| POST | `/api/model/<role>` | ModelEndpoint |
| POST | `/api/runs/<id>`, `/api/runs/<id>/answer`, `/api/runs/<id>/credential` | Runs |
| POST | `/api/watches`, `/api/notifications/ack` | Notifications |
| POST | `/api/alert-channels` | AlertChannels |
| POST | `/api/sandbox-limits` | branch/BudgetApi |
| POST | `/api/flows/save`, `/api/flows/write`, `/api/flows/<id>/delete` | PersonalFlows |
| POST | `/api/flow-drafts/<id>`, `/api/flow-drafts/<id>/delete`, `/api/flow-drafts/<id>/answers` | PersonalFlows |
| POST | `/api/branches`, `/api/branches/<id>/shares` | branch/Branches, Shares |
| POST | `/api/conversations/archive` | branch/ConversationApi |
| POST | `/api/texts/<id>` | branch/Texts |
| POST | `/api/terminals` | branch/Terminals |
| POST | `/api/sandbox/calls` | branch/SandboxCalls |
| POST | `/api/repos`, `/api/repos/launch` | RepoApi |
| POST | `/api/repos/<owner>/<name>/writes` (all ops, including triage/enable and triage/pause) | github/Api |
| POST | `/api/repos/<owner>/<name>/issues/<number>/links` (person or runner) | github/WorkLinks |
| POST | `/api/repos/<owner>/<name>/pulls/<number>/review` | github/Review |
| POST | `/api/repos/<owner>/<name>/stack` (all ops) | stack/Api |
| PUT, DELETE | `/api/repos/<owner>/<name>/secrets/<NAME>` | secrets/Api |
| PUT, DELETE | `/api/me/model` | personal/Api |
| POST | `/api/me/model/test`, `/api/me/model/codex`, `/api/me/model/jev` | personal/Api |
| PUT, DELETE | `/api/repos/<owner>/<name>/runners/<name>`, `/api/repos/<owner>/<name>/agents/<name>`, `/api/repos/<owner>/<name>/overflow/cloudflare` | runners/Admin |
| POST | `/api/bugs` | bugs/Api |
| POST | `/api/repos/<owner>/<name>/feeds/answers` | feeds/Api |
| POST | `/api/repos/<owner>/<name>/domains` | domains/Api |
| DELETE | `/api/repos/<owner>/<name>/domains/<hostname>` | domains/Api |
| POST | `/api/repos/<owner>/<name>/runs` | ci/RunsApi |
| POST | `/api/remote-runs/<id>/steers`, `/api/remote-runs/<id>/stop` | RemoteRuns |

Also buffered, but not session-authorized: POST `/api/auth/arrive` (handoff code), `/api/github/webhook` (signature),
`/api/repos/<owner>/<name>/feeds` (collector key), `/api/runners/{claim,heartbeat,settle,events,git-credential}`
(runner token), and `/api/telemetry/<kind>` (telemetry admission). Their own authentication stays in place.

Outside this seam: `BranchSandboxes.answerBox` is dispatched before user routes, with the host's box props and its own
machine/claim/egress policy; it must preserve streaming git/vendor traffic and is not a session-cookie route.
The optional `options.door` is a test-deployment-only callback before production routing; production sets none.
GET/HEAD/OPTIONS, including socket upgrades and OAuth callback/handoff reads, are outside this method contract;
socket messages and Durable Object calls have their own authority policies. No registered session-authenticated
POST/PUT/PATCH/DELETE route is excluded.

### Admission versus delayed execution

Removed the WorkLinks and Stack session arguments and transaction rechecks from the five parents. Their writes
execute synchronously after shared admission, under the fixed bounds below. Kept their runner/installation and
repository-role policies, which answer different questions. Replaced the old tests of post-admission lock/refresh
revocation with shared streamed-body regressions and real database timeout tests; SQL spans still check write/read costs.

These deferred authority-sensitive writes can start long after admission and revalidate retained session and alias
under locks in their final writing transaction:

| Deferred write | Delay | Final transaction |
| --- | --- | --- |
| `secret/Put`, `secret/Delete` | durable start, crash recovery; store retry up to 30 min | secrets/Store |
| `model/Put`, `model/Delete` | durable start, recovery; store retry up to 30 min | personal/Store |
| `model/CodexLink` Keep | device approval/polling up to 15 min, then store retry up to 30 min | personal/Store.link |
| triage/enable, triage/pause through `github/Write` | durable dispatch and retry | transaction enclosing authority, settlement and triage projection in github/Write |
| Admin runner/agent/overflow actions | durable dispatch and retry; five-minute admission fence | runners/Store and Overflow; existing repository role/generation fences retained |

Missing legacy authority is refused; explicit null represents sessionless local development. Successful replay returns
its existing receipt without a new mutation. Credential refresh and accounting settle an already-admitted call under
their existing ciphertext/invocation identity; they do not admit a new connection. `chat/Expire`, `bug/Report`, repository
clone/run/checks, domain verification/removal and sandbox/terminal execution are continuation of an admitted durable
operation, with their own run/resource/provider policy, rather than these deferred credential/settings commits.
Their continuation is not newly made contingent on keeping a browser session alive. GitHub writes retain their existing
live-token/permission checks before external effects; this change adds the missing check to tokenless triage settings.
The HTTP seam covers admission to every one of these operations, without treating the lifetime of an admitted job as a
request-body wait.

PUT list replacement now advances the existing Codex link generation (`delete` or `replace` audit events).
That includes removing only Codex while retaining an API connection; delayed Keep and replay cannot restore it.
All list replacements conservatively supersede pending links; audit action names remain accurate. No migration or
additional generation query. Completed Keep replay still answers its prior result and writes nothing after removal.

### Actual database wait bounds

The old WorkLinks/Stack paths and the initial runner resource/authority waits had no timeout: trigger regressions
observed `lock=0, statement=0, transaction=0`. The expiry-derived runner lock budget also failed to bound an entire
multi-statement transaction. Those paths now install, before their first lock, in one SQL round trip:

```
lock_timeout         1 second / lock acquisition
statement_timeout    2 seconds / statement (all lock acquisitions in it included)
transaction_timeout  5 seconds / complete transaction, across all statements
```

The total is **at most 5 seconds per writing transaction**, not 1 second total and not 2 seconds total. Multiple
locks/statements cannot accumulate an unlimited wait. Overflow's outer transaction installs the bounds before its own
locks; its nested runner write preserves an already-running transaction timer. Statements installing the bounds take no
application table/row locks. This is a Postgres 17 contract, matching the declared database; BEGIN/connection acquisition,
wire/cancel-drain latency and work outside that transaction are not represented as lock waits.

WorkLinks has one writing transaction (5 s). A runner/agent/overflow attempt has one outer writing transaction (5 s).
Stack can apply twice after its single stale-role refresh. The Astra repair below adds complete application wait
budgets outside these server transaction caps, including database acquisition, retry status and role refresh.
No write transaction holds locks across a network role refresh. A durable retry is a new attempt.
Natural session expiry and explicit revocation after shared admission are both accepted during the bounded
synchronous Stack/WorkLinks window. Deferred actions still revalidate in their final transaction.
No per-route session rechecks or expiry-derived lock timeouts are added.

Actual blocked-write tests retain a lock on a second real Postgres connection until the writer fails; no release sleep
or query mock. The first passing run measured WorkLinks 1009 ms, Stack 1009 ms and runner 1003 ms. Mutation triggers
independently assert all three installed settings, including the 5-second total cap. These are farm/Postgres receipts,
not production latency or transport bounds.

### SQL round trips at c16da997, before the Astra repairs

| Path | Added round trips |
| --- | --- |
| Shared body admission, all GET/read paths | 0 |
| WorkLinks, Stack: local / session / alias | +1 / -1 / -2 per apply (fixed bounds replace +2/+3 session rechecks) |
| Fenced runner/agent write | 0 (one fixed-bound statement replaces untilExpiry) |
| Fenced overflow | +1 (outer bound before its own locks; nested bound replaces untilExpiry) |
| Personal Put/Delete/Keep, secret Put/Delete, tokenless triage: local / session / alias | +1 / +3 / +4 (fixed bounds + retained authority's 2/3 statements) |
| Codex generation admission/check | 0 additional; existing queries reused |

Existing client-span regressions assert WorkLinks/Stack have identical local/session/alias query counts and no extra
read query; runner spans assert the retained 2/3-statement authority cost and one bounds statement. Timing and settings
regressions run against real Postgres. Focused tests disable coverage; no coverage, production, provider-live, E2E browser,
review or landing claim is made.

### Red receipts

All regression cases were also run together with the relevant production files restored to the exact `bfe456a9`
parent inside a reserved farm slot; the shared boundary was the identity until implemented. Parent source bytes were
streamed in memory from `jj file show`; no baseline checkout, install or source copy was created on the Mac.
The final parent comparison is `/tmp/retro-authority-red-parent.log`, farm run `52903` / slot 1:
**34 failed, 0 passed, 138 filtered skips, 6 failed files**. Every selected regression failed behaviorally, without
fixture/import/type errors. Earlier fixture failures and guard-disabled isolation runs are not substituted for this receipt.

| Regression | Red line in parent-comparison stdout |
| --- | --- |
| POST/PUT/PATCH/DELETE admission after EOF | line 457: `expected { admitted: true, body: 'firstlast' } to deeply equal { admitted: false, body: 'firstlast' }` |
| Fixed body-read deadline | line 479: `expected [ 200, '' ] to deeply equal [ 408, '{"code":"body_timeout"}' ]` |
| Secrets, connections, triage/enable, triage/pause routes | line 556: `expected 202 to be 401` |
| Delayed personal/secret Put, Delete, Keep; session, alias and expiry; replay | lines 399/420/438: `expected 'replace'/'deleted'/'set' to be 'stale'` |
| Deferred triage settings | line 576: `expected { status: 'done', itemNumber: null } to match object { status: 'refused' }` |
| Individual removal generation | line 630: `expected '0' not to be '0'` |
| Real Poll/Keep delayed past individual removal | line 598: `expected [ …(2) ] to deeply equal [ { kind: 'api_key', active: true } ]` |
| Database timeout settings at mutations | line 520: `unbounded write: lock=0, statement=0, transaction=0` |
| Real blocked writes | line 534: `expected false to be true` (writer reached the 2.5-second test guard rather than its 1-second database timeout) |

The generic boundary's GET case is a positive control, not counted as a reproduced failure. Regressions use real
Postgres and handlers; the Codex engine uses the repository's existing scripted provider seam and real Poll/Keep.


Final validation: `/tmp/retro-authority-final.log`, farm run `53237` / slot 1: **426 passed, 0 failed, 0 skipped,
14 passed files**. Worker `pnpm exec vibelang -p worker/tsconfig.json` and targeted ESLint on WriteAdmission,
WriteAuthority and the changed delayed-flow implementations passed; the combined farm command exited 0.
`/tmp/retro-authority-green6.log`, run `51708`, independently passed all 31 boundary/route/bounds/retained-authority
cases after expanding session/alias/expiry coverage, plus worker typecheck (0 skips).
All test stdout/stderr was redirected to files. Farm admission refused a full Latitude host; the mini farm ran the
receipts. No other lane's data was removed. No install, baseline tree or source copy was created on the Mac.
One local commit is retained above the five parents. Nothing is landed or pushed; no review is claimed.

### Astra repair 1 — request ordering

The dispatch seam captures runner/agent resource and coding-selection generations before reading a write body;
it resolves session and repository authority only after EOF. The final Store transaction compares the captured
generations, so DELETE completing during PUT upload supersedes that PUT (including overflow's runner).
Library entry: existing Effect SQL and Context services; no new dependency.

Red: `/tmp/retro-repair-1-red-mini.log`, 2 failed, 60 filtered skips. Both exact-order regressions expected
`outcome: superseded` and received `outcome: set`, at Runners.test.ts:690.

Green: `/tmp/retro-repair-1-green.log`, Runners 62 passed, 0 skipped, farm command exit 0.

### Astra repair 2 — delayed privileges

Secrets retain deployment scope and require Admin at the final transaction. Triage retains the repository role row
(or explicit deployment scope) and requires Maintainer or Admin there. Checks lock the person's role-observation
serialization row or repository role row, and the admitting session/alias; replay returns its existing receipt.
Missing protected scope fails closed. Library entry: existing Effect SQL, SessionStore.latestRole and RepoRoles.holds.
Red: `/tmp/retro-repair-2-red.log`, 6 failed, 93 filtered skips. Secrets expected `stale`, received `replace`/`deleted`
at DurableAuthority.test.ts:63; deployment and repository triage expected `refused`, received `done` at Triage.test.ts:91.

Green: `/tmp/retro-repair-2-green-final.log`, DurableAuthority, Triage and Secrets 135 passed, 0 skipped.
The first broad run exposed a fixture that claimed Maintainer in the actor but stored Member in its session;
the fixture now records the same role in both. The final run exercises the real retained privilege.

### Astra repair 3 — slow uploads

The fixed body deadline is 60 seconds, never renewed per chunk. A 1 MiB file seed expands to roughly 1.33 MiB
in base64 JSON and exceeds 10 seconds at 1 Mbit/s; a 65,000-character issue can exceed it on a slower phone.
Authority is checked only after EOF, so this longer upload budget retains no old authorization. Memory stays capped.
Red: `/tmp/retro-repair-3-red-valid.log`, 2 failed, 6 filtered skips: expected `[200, 1]`, received `[408, 0]`
at WriteAdmission.test.ts:91. The valid CRDT seed and issue each arrive in 16 paced chunks over 11.2 seconds.
Green: `/tmp/retro-repair-3-green.log`, 8 passed, 5 filtered skips (item 4 regressions not selected).

### Astra repair 4 — cheap refusal before buffering

The dispatcher calls its existing edge throttle before body admission. A throttled telemetry request consumes zero
stream chunks and reaches no handler. Admission selects each registered route's existing byte limit before reading;
it checks Content-Length and accumulated bytes, and stops at the first chunk that crosses that limit. Limits come
from shared feature contracts, including the configured model request cap. The aggregate ceiling remains 8 MiB.
Model oversize refusals retain ModelProxy.ErrorBody and its request-id header. Library entry: @smthrs/model ModelProxy,
existing Effect Stream and feature contracts. The admission span covers buffering, so it adds no parent to a handler's
request trace. Early refusal logs/counts belong to write.body/smithers_write_bodies, before feature handlers run.

Red: `/tmp/retro-repair-4-red.log`, 5 failed, 8 filtered skips. Throttled telemetry expected `[429, 0, 0]`, received
`[204, 1, 1]`; route oversize expected `[413, 1, 0]`, received `[204, 2, 1]` (status, pulls, handler calls).
The first combined green run: `/tmp/retro-repair-4-green.log`, 94 passed, 0 skipped. Broader checks found and fixed
stale early-refusal assertions and an import cycle in the new protected-role helper; ProtectedAuthority now keeps
role dependencies out of the persisted session schema's module. Receipts below supersede intermediate failed runs.

Expanded green: `/tmp/retro-repair-4-green-complete.log`, 249 passed, 0 skipped across seven files.

### Astra repair 5 — every synchronous wait

No session/alias rechecks were restored in Stack.ts or WorkLinks.ts. Each awaited service between completed
authentication and commit now has an Effect deadline around the entire operation, outside database layer provision.
This includes pool/layer acquisition and BEGIN/COMMIT, rather than starting the timer after a connection is obtained.
Timeouts cancel the operation, answer retryable unavailable, and emit `write.wait` with a finite stage and budget,
plus `smithers_write_wait_timeouts{stage}`. No detached writer or background timeout cleanup is introduced.

| Stack wait, in execution order | Maximum |
| --- | --- |
| Initial repository role resolution: cached-row read or GitHub read, record and cleanup | 10 s |
| Retry candidate database lookup, only for Retry with a run host | 2 s |
| Remote run host isStopped, only for a candidate | 2 s |
| First complete apply, database acquisition through transaction end | 6 s |
| One stale-role refresh, including its GitHub read, record, feed locks and cleanup | 10 s |
| Second complete apply | 6 s |
| **Total, conservative sum including all optional waits** | **36 s** |

| WorkLinks wait | Maximum |
| --- | --- |
| Person's repository role resolution, including GitHub when needed | 10 s |
| Runner token lookup instead of the person's role resolution | 2 s |
| Complete writing transaction, including database acquisition | 6 s |
| **Person total / runner total** | **16 s / 8 s** |

**The largest bound is 36 seconds, exceeding 10 seconds.** The body is already buffered when authentication runs;
its UTF-8 replay adds no network wait. Parsing, hashing and clock reads are synchronous. Logs/metrics use the
in-process services. Stack's run starts/stops happen after commit and do not extend this authority window.
Repository roles retain their own 10-second whole-read budget; the new outer role budgets also cover the first
layer acquisition, cached read and injected role service. GitHub's client's 30-second default cannot extend them.
Every SQL writing transaction additionally retains lock=1 s, statement=2 s, transaction=5 s on Postgres 17.
These are application/SQL operation budgets, not a promise of network delivery time to the browser: transport and
cancellation drain can delay the returned response while the cancelled operation unwinds. No further application
write proceeds during that unwind. The tests exercise stuck interruptible services and actual blocked Postgres writes;
production transport and Hyperdrive cancellation latency are not measured here.

Red: `/tmp/retro-repair-5-red-final.log`, 8 failed, 0 skipped. Every stalled service was entered; each failed
`expected 499 to be 503` at CommitWaits.test.ts:44 or :66. 499 is the test observer's 12-second sentinel, not an HTTP
response from Smithers. The earlier `/tmp/retro-repair-5-red.log` hit all eight 16-second test timeouts; it is not used
instead of these explicit failing assertions. Faulty Effect services stall initial role reads, refresh, transaction
acquisition, retry lookup, remote status, runner lookup and WorkLinks transaction acquisition.


Green for the wait repair: `/tmp/retro-repair-5-green.log`, 62 passed, 0 skipped across five files.
`pnpm typecheck` in apps/mvp passed all four configurations on the farm (`/tmp/retro-repair-typecheck-final.log`).
The timer repair adds zero SQL round trips. Protected secret/deployment-role writes add a person lock and latest-role
read to the earlier session checks; repository triage adds RepoRoles.holds. Neither introduces a new read-path query.

### Final farm receipts for the Astra repairs

The combined 23-file run (`/tmp/retro-repair-final-tests.log`) executed 738 cases with 737 passed, 1 failed,
0 skipped. Its only failure was Connections' old assertion of 400/invalid for a body over the Jev route cap;
the new shared admission correctly answered 413/too_large before the handler. That assertion is updated.
The complete Connections rerun (`/tmp/retro-repair-connections-final.log`) passed all 63 cases, 0 skipped.
The other 22 files in the combined run passed all 675 cases. Thus **738 distinct cases across 23 files have passing
final receipts, with 0 skipped**; the combined run itself is not described as green. Stack Api/CommitAuthority were
also rerun after removing an unintended read-route timer: 39 passed, 0 skipped (`/tmp/retro-repair-stack-final.log`).

Final `pnpm typecheck` in apps/mvp passed all four configurations with command exit 0 on the farm:
`/tmp/retro-repair-typecheck-complete.log`. Tests use the existing remote Mini farm because Latitude's disk admission
refused both hosts before source transfer. Test stdout/stderr is retained in the named files. No local install or
repository copy was made. Coverage instrumentation was disabled; these are API/engine/Postgres tests, not production
or browser E2E evidence. This note records implementation and executed checks, not an external review result.

### Final-transaction session follow-up (2026-11-02, blocked before red)

Base: `eeca93293f51fc4ab958a2022c72d94a27067ba4`; working change `ltllymkvtntynxulxwpluvxykxwwtluo`.
Library catalog: existing Effect SQL and `WriteAuthority.holds`; no new dependency.
Prepared 39 revocation/expiry cases plus one SQL-span/read-query case in `stack/CommitAuthority.test.ts`.
They cover Commit, Retry, Drop and Configure during role resolution, refresh and receipt replay,
plus Retry's remote status wait. Receipt cases retain real starts and drop cancellations.

Red command, pinned to `LAT_RUN_HOSTS=nyc-02`, was refused by farm disk preflight before source sync:
97% used, limit 95%, exit 2 (host probe exit 73). Stdout/stderr: `/tmp/retro-liveness-red.log`.
`pnpm typecheck` in apps/mvp was independently refused at the same preflight, then reporting 98% use;
stdout/stderr: `/tmp/retro-liveness-typecheck.log`. Neither command executed its requested checks.
Executed test counts: 0 passed, 0 failed, 0 skipped; the 40 prepared cases were not collected.
No failing assertion/red-line receipt exists. Production source remains unchanged to honor red first.

The planned Stack guard precedes both mutation and receipt lookup in its final transaction; the caller must
retain session/alias identity in its existing options. `WriteAuthority.holds` would add two SQL round trips
for a session, three with an alias, zero for sessionless calls and reads; these are source-derived, unmeasured.
WorkLinks has no retained session argument, so adding the guard there requires a signature and caller change
as well as the guard. That exceeds the requested one-line condition; WorkLinks is unchanged.

Repeated the requested red-first validation on 2026-11-02, still pinned to `LAT_RUN_HOSTS=nyc-02`:
`/tmp/retro-liveness-red-2.log` and `/tmp/retro-liveness-typecheck-2.log` both exited 2 before
reservation, sync or installation. Each log's line 1 reports `FARM_HEALTH DISK_FULL`, 98% used
against the 95% limit; line 2 reports host probe exit 73. Neither invocation received a farm run id.
Tests: 0 collected, 0 passed, 0 failed, 0 skipped (40 prepared cases unexecuted); typecheck did not run.
Production code remains unchanged: there is still no failing assertion receipt and no measured added round trips.
Static inspection confirms the guard must precede receipt lookup in Stack.apply: a repeated receipt reaches
Api.ts:369's stop/start dispatch, bypassing the existing role-only guard after receipt lookup. The one caller's
options at Api.ts:338 must retain session/alias identity; no separate check at run dispatch is planned.

### Mac mini continuation: final transaction liveness (2026-11-02)

The mini supersedes the unavailable Latitude hosts for every test and typecheck below. Base remains
`eeca93293f51fc4ab958a2022c72d94a27067ba4`, change `ltllymkvtntynxulxwpluvxykxwwtluo`.
Library catalog: existing Effect SQL and `WriteAuthority.holds`; no new dependency.

Red ran before production edits: 40 failed, 0 passed, 0 skipped in `stack/CommitAuthority.test.ts` (6.87 s).
Receipt: `~/.smithers-lead/scratchpad-mirror/retro-liveness-red-mini.log`, mini execution PID `42616`, slot 1.
Log lines 154 and 167: SQL span deltas `[0, 0, 0]` instead of `[0, 2, 3]`, assertion at test line 46.
Lines 178/195: a revoked-session Commit returned 202 instead of 403 (test line 101).
Lines 234/251: receipt replay returned 200 instead of 403 (test line 101).
Lines 402/419: Drop receipt replay returned 200 instead of 403 (test line 101).
Test line 123 also rejected Retry's 202 after revocation in the remote-status wait.

One `WriteAuthority.holds(options.session)` guard now runs in Stack.apply's final transaction, after its bounds
and before its first mutation or receipt lookup. The existing Api.ts:338 caller retains `sessionOf(who)` in options;
there is no separate route check or dispatch change. This covers Commit/Retry starts, Drop stops and starts,
Configure starts and receipt replay. Existing `stale` logs and metrics record refusal. The regression matrix
asserts unchanged stack/receipt/attempt/link/notification rows and no additional run starts or stops.

WorkLinks is unchanged: its `write` signature retains only runner identity, so a session guard would require an
argument and caller change as well as the guard. This exceeds the requested one-line condition; its 16 s person
and 8 s runner wait bounds still apply.

Green: `retro-liveness-green-mini-4.log`, mini execution PID `84167`, slot 3: six files, 154 passed,
0 failed, 0 skipped (76.65 s), including all 40 liveness cases, Stack, Api, status reads, TodoRuns and CommitWaits.
SQL client spans confirm +2 round trips per signed-in apply, +3 with an alias, +0 for sessionless applies and reads.
A role refresh can apply twice, adding at most +4/+6 for its two successful liveness checks.

Intermediate `retro-liveness-green-mini-3.log` (PID `62443`, slot 3) had 151 passed, 3 failed, 0 skipped:
the three Commit/refresh snapshots included initialization of the empty stack by the first, still-authorized apply.
The fixture now establishes that stack before the snapshot; every response, row and dispatch assertion remains.
Green admission attempts 1–2 and typecheck admission attempts 1–6 timed out on occupied mini slots (exit 75),
before executing checks. No reservation was removed or stolen. All logs are in
`~/.smithers-lead/scratchpad-mirror/`; the requested commands used `MINI_RUN_SRC=$PWD`, `apps/mvp`,
`--coverage.enabled=false` for vitest, and redirected stdout and stderr to their named files.

Full `pnpm typecheck` in apps/mvp passed (exit 0), including app, worker, infra and evals configs:
`retro-liveness-typecheck-mini-7.log`, mini execution PID `88145`, slot 2. Tests and typecheck ran only on the mini.
No coverage, production or external-review evidence is claimed; no local installation or repository copy was made.

### Write seam follow-ups (2026-11-02)

Three requested corrections, one commit each, red first; then rebase onto `main@origin`.
No landing, pushing, review, published-migration edits or local installs/copies.
Library catalog: existing Effect timeout/SQL, `@smthrs/flow` retries, and
`@smthrs/integrations` GitHub permission reads; no new dependency.

1. Role-check start: `SignIn.resolve` bounds its start acknowledgment to one second, cancels a
   stalled start and logs/counts `start_timeout` before returning the live session.
   Red: `/tmp/write-seam-1-red.log`, mini PID 91525 slot 2, lines 140–160:
   `expected 'unbounded' to match object`, test line 609 (both stale and unconfirmed).
   Counts: 58 passed, 3 failed, 0 skipped; the third failure was an existing test
   comparing Postgres time with the mini's clock. That assertion now brackets the read
   with Postgres timestamps. First green had 60 passed/1 clock failure; corrected green:
   `/tmp/write-seam-1-green-2.log`, PID 95680 slot 2, 61 passed, 0 failed, 0 skipped.

2. Deferred triage: the GitHub flow host supplies `RepoRoles`; queued Enable/Pause
   resolves a fresh observation outside its transaction, then validates the currently
   permitted role and session/alias under the final locks. A promotion still permits
   the write. Stale-at-commit observations and real read failures raise retryable
   `WriteUnavailable`, retaining Retry-After; confirmed permission loss refuses.
   Synchronous admission retains exact-role checks.
   Red: `/tmp/write-seam-2-red-2.log`, PID 97754 slot 3: 7 failed, 3 passed, 0 skipped.
   Lines 136–154: promoted/stale Maintainers returned refused rather than done
   (test line 49). Lines 171–199: failed reads settled refusal rather than raising
   the retryable error (test line 67). Lines 201–215: no refresh was reached.
   `/tmp/write-seam-2-red.log` timed out awaiting capacity before collecting tests.
   First broad green: `/tmp/write-seam-2-green.log`, PID 495 slot 2, 159 passed,
   2 failed, 0 skipped (161 tests): 82 Triage and 4 Host tests passed; the new
   race fixture passed a Promise instead of the service's `hold` callback. Corrected.
   The other failure compared a persisted Postgres deadline with the host clock;
   that regression now uses Postgres time with its original 2.6–3.4 s bounds.
   Corrected runs: `/tmp/write-seam-2-additional.log`, PID 6607 slot 1, 13 passed;
   `/tmp/write-seam-2-roles.log`, PID 7586 slot 2, 65 passed. Both: 0 failed, 0 skipped.
   Added final-transaction promotion/demotion and expiry-after-refresh checks.
   Full mini typecheck passed: `/tmp/write-seam-typecheck-2.log`, PID 7221 slot 1.
   Initial `/tmp/write-seam-typecheck.log` failed on the corrected fixture callback type.

3. Handoff: `/api/auth/handoff` has the handler's 4 KiB cap at body admission.
   Red `/tmp/write-seam-3-red.log`, PID 94986 slot 3, 4 failed, 2 passed, 0 skipped.
   Lines 26–44: cap 8388608 instead of 4096 (test line 8); lines 46–64: declared
   and streamed 4097-byte uploads returned 200 instead of 413 (test line 23).
   Green `/tmp/write-seam-3-green.log`, PID 97007 slot 2: BodyLimits and Body,
   10 passed, 0 failed, 0 skipped, including 4096-byte admission and query strings.

Rebased the local write-seam chain onto fetched `main@origin` (`45e4f5e4dec6`).
Resolved conflicts in their owning commits: Stack/ChatApi imports retain request-ray
correlation and write admission/authority; runner fences use the shared session/alias
identity and fixed write bounds, retaining main's final deadline check and rollback;
the runner documentation states both. No migration file differs from `main@origin`.
No unresolved conflict remains in the rebased chain. Final mini checks follow.

While final checks waited for mini capacity, `main@origin` advanced to
`cbd72272bce7`; rebased the chain again without conflicts. Migration contents
still match origin exactly. The post-rebase typechecks caught and corrected two
integration points in their owning commits: Stack timeout failures cannot be passed
to the upstream-role-only diagnostic formatter, and one new runner regression from
main needed the shared `session` fence shape instead of top-level sessionId/alias.
`/tmp/write-seam-rebased-typecheck-3.log` (PID 24012 slot 3) passed after these
corrections; `/tmp/write-seam-final-typecheck.log` (PID 25215 slot 2) passed on
the newer base. Overflow: `/tmp/write-seam-rebased-overflow.log`, PID 23673
slot 2, 9 passed, 0 failed, 0 skipped. `/tmp/write-seam-rebased-tests.log`
reached its 600-second capacity deadline before executing or collecting tests.
No lock or reservation was stolen. Final 12-file run retried on the newer base.

Final regressions: `/tmp/write-seam-final-tests.log`, mini PID 26692 slot 2,
12 files, 320 passed, 0 failed, 0 skipped (112.29 s). Coverage disabled as requested.
Includes SignIn 61, BodyLimits 6, Body 4, deferred triage 13, RepoRoles 65, Host 4,
Stack API 39, Stack commit authority 40, CommitWaits 8, runner deadlines 3,
Runners 68 and Overflow 9. No production or browser evidence is claimed.
Origin advanced again during this run: rebased cleanly onto `c2412875cc63`.
Compared the tested revision `833eaaef3e4cc6d8fe526758ab1111700e3dd565` with
the rebased result: no worker or SDK source changed. The new origin changes
are coding-flow maintenance and deployment/e2e tooling. Migration contents remain
identical to this origin base. Full typecheck on this last base follows.

Resumed after the account switch: the interrupted c241 typecheck was terminated
before execution. `/tmp/write-seam-resume-typecheck-c241.log`, mini PID 34683
slot 3, passed the full `pnpm typecheck` (exit 0). The 320-test receipt above
remains valid for the identical worker/SDK sources. Origin then advanced to
`ec64fab12052` (TODO leaves/attachment); integrating that base follows.

Rebased onto `ec64fab12052`. The overlap was Stack's new `attach` dispatch
beside the earlier session fence. Resolved it in the original commits, retaining
the session check before mutation and `attachIssue` after repository authority.
Later admission refactoring and the final Stack liveness repair retain their
intended order. No unresolved conflict remains; migrations match this base byte
for byte. Final mini runs add Stack and LeafTrigger to the 12-file regression set.

Full typecheck on `ec64fab12052` passed: `/tmp/write-seam-final-typecheck-ec64.log`,
mini PID 43967 slot 2, exit 0 (app, worker, infrastructure and evals configs).
`/tmp/write-seam-final-tests-ec64.log` reached the 600-second capacity limit,
exit 75, before execution or collection. No reservation was removed. Retrying
the identical 14-file command in `/tmp/write-seam-final-tests-ec64-2.log`.

That run (mini PID 16082 slot 3) executed 399 cases: 394 passed, 5 failed,
0 skipped, plus one unhandled rejection. All three requested regressions passed.
The first RepoRoles failure at log lines 6787–6807 counted another schema's idle
transaction (`open: 1`); its assertion skipped the gate release and caused three
later duplicate-key failures. Diagnostics now filter by the fixture's
`application_name`, and a `finally` releases and drains the in-flight burst.
The Overflow lock-order test used two 300 ms sleeps; with a one-second lock bound
and concurrent suites it timed out and left an unhandled rejection. Its real SQL
span now signals the old writer when the new writer attempts the runner lock,
with no sleep, and both results are joined. The success assertion retains the
lock-order check under the same fixed production deadlines.
These test-only corrections are folded into the owning deferred-role and bounded
write commits. No production bound or assertion was relaxed. Re-running the same
14 files and full typecheck; logs end `ec64-3.log` and `typecheck-ec64-2.log`.

`/tmp/write-seam-final-tests-ec64-3.log`, mini PID 20638 slot 1: 398 passed,
1 failed, 0 skipped, no unhandled errors (399 total, 142.27 s). The remaining
failure was the new Overflow assertion using Effect Result's serialized `value`
instead of its actual `success` field; the real write returned `set` in 191 ms.
Corrected that assertion and rerunning Overflow alone; the other 13 files have
390 passing cases, including all 65 RepoRoles and both new Stack/leaf suites.

Final full typecheck after the test-only corrections passed, exit 0:
`/tmp/write-seam-final-typecheck-ec64-2.log`, mini PID 70143 slot 2. No check
or installation ran on the MacBook. Overflow-only validation remains queued.

Final Overflow validation passed: `/tmp/write-seam-final-overflow-ec64.log`,
mini PID 73517 slot 1, 9 passed, 0 failed, 0 skipped, no unhandled errors
(17.12 s). Final test evidence is the other 13 files' 390 passing cases from
`write-seam-final-tests-ec64-3.log` plus these 9: 399 distinct cases across
14 files, all passing, 0 skipped. This is two receipts, not a claim of a single
all-green 14-file invocation. Full typecheck is green on the final source.

Complete, kept local and unpushed. The three requested fixes remain three commits
on top of the prior write seam, rebased onto origin's `ec64fab12052`. All conflicts
are resolved, and migration files match that base exactly. No landing, pushing,
review, production, browser, coverage, MacBook installation or tree-copy claim.

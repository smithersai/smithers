---
title: Commit-time write authority
status: completed
area: access
owner: Codex / retro-writes follow-up
updated: 2026-11-02
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
that boundary reaches EOF before any handler can resolve a session or run credential. One 10-second deadline spans
the entire read; chunks never renew it. A native request with no body is already at EOF. Raw bytes are replayed through
all Effect request accessors, preserving original URL, cookies and headers. The aggregate cap is 8 MiB; handlers
retain their smaller byte/UTF-8/schema limits. Refusals: 408 `body_timeout`, 413 `too_large`, 400 `invalid`.
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
Stack can apply twice after its single stale-role refresh: at most 10 s in writing transactions, plus the separate
role refresh's existing 10-second deadline (and initial role resolution, also separately bounded). No write transaction
holds locks across a network role refresh. A durable retry is a new admission attempt, not an extension of one transaction.
Natural session expiry after shared admission, or after a deferred action's single final authority check, may race
this short bounded work. No absolute-deadline checks after each lock wait, or expiry-derived lock timeouts, are added.

Actual blocked-write tests retain a lock on a second real Postgres connection until the writer fails; no release sleep
or query mock. The first passing run measured WorkLinks 1009 ms, Stack 1009 ms and runner 1003 ms. Mutation triggers
independently assert all three installed settings, including the 5-second total cap. These are farm/Postgres receipts,
not production latency or transport bounds.

### SQL round trips, relative to the five-commit parent

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

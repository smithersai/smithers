---
title: Bring the held device privacy stack to ready-to-land
status: review
area: local-first
owner: Codex
updated: 2026-11-05
links: [../decisions/0023-device-ownership-and-queued-authority.md]
---
Rebase the local dependency patch and never-drop 401 client change onto current
main, include the held step 1b server change, and compare the affected app and SDK
suites by failing name on cfbox. Obtain exact-diff review receipts. Do not land,
push, deploy, or run heavy work locally. The catalog entry used is
`@smthrs/effect-tanstack-db`; chat delivery now lives in `chat/writes.ts` on main,
so its hold and dependency keys move there with the existing regressions.

Original client: ee094bec. Original dependency patch: 5fff6bc8. Original step 1b:
6ec1653b. The patch remains its own bottom commit and retains the existing entry
in the private UPSTREAM.md tracker. Original test-first commits remain in jj
history and the earlier work notes retain their red evidence.

Astra client review 01a1a876-2f45-7d82-a770-84b8ed91b318 found two bugs.
The cfbox `client-red` run executed three new regressions and failed all three:
real runtime disposal stranded sign-out before its retry action, an internal
401 confirmation resent early, and expired-gate verification reread too early.
Shutdown now runs outside the sign-out finalizer while the page stays sealed;
all stale credential responses share serialized Retry-After persistence.
The regressions use a real local HTTP server, native Web Locks and a real Effect
runtime. Raw run artifacts and exact revision IDs live in the coedit401 runner
directory. The `client-green` cfbox run passed all 72 wipe and identity tests with zero
skips. Readiness requires the retained full-suite comparison and exact-diff
review receipts.

Client review 01a1a88d-37fc-79d2-bd0a-a0f786c4fe7b found lost privacy-gate
classification and a lost local deadline after storage-write refusal. The
`privacy-red` cfbox run failed all four new cases before their fixes and passed
typechecking. `privacy-green` then passed all 105 tests across credential privacy,
identity, wipe, auth and repository visibility, with zero skips. The regressions drive boundFetch, real HTTP, AuthClient, auth load
and the real collection data gate, plus absent and already verified credential
records with an injected storage-write failure. AuthClient now preserves the
credential-stale classification; failed publications retain a local hold and are
published by later outbox-driven attempts before any further send.

Client review 01a1a8a1-a576-76e3-bde4-0aa2c97311a8 found that slow
publication could become a generic session timeout before the privacy gate
learned of the stale response. `privacy-delay-red` failed both stalled-storage
and stalled-lock regressions at the unverifiable-row assertion. Reporting the
observed refusal now happens immediately; one serialized publication continues,
with the local hold blocking later writes until it completes. The real HTTP and
collection-gate regressions also cover a subsequent network failure and a fresh
session answer, without releasing the stalled publication first.

Client review 01a1a8b2-f708-78d3-a6b8-b2aa446ce707 found that a successor
could bypass another transport's unpublished hold. `successor-red` reproduced
both lock and storage stalls: a second transport sent one HTTP write before
publication completed. Write-gate reads now take the shared credential lock,
including the final revision check after owner verification. The regressions
also require the exact deadline and a matching owner before the successor sends.

Step 1b keeps main's role-freshness rules and token-generation fences. The real
SessionAdmission regressions failed before moving cookie authorization behind
throttling, body collection and maintenance admission, then passed all three.
Astra server review 01a1a886-64aa-7c83-84a4-512c4f00ad3b found that an older
callback renewed a newer role receipt's timestamp. `role-red` failed the new
out-of-order callback regression and passed the full app typecheck. Reauthentication
now updates role_verified_at only when its role observation wins; otherwise the
winning receipt retains its original authorization deadline.

Server review 01a1a89e-274f-7b40-9b5e-0539c0eb0f75 found that the cookie
guard rejected explicit sign-out after a lost rotation response. The
`signout-red` cfbox run reproduced both home and alias refusals (503 instead of
204); its role-freshness and three admission regressions passed. Sign-out now
uses its own configured-signature, origin and device-owner checks through both
the shared admission boundary and route dispatch. The HTTP regressions retain
wrong-origin, wrong-owner and invalid-signature refusals and check the distinct
home and alias revocation scopes.

Server review 01a1a8b2-fab6-79f0-8e95-24080d09431f found that the
terminal's independent expiry timer closed a viewer while its authority check
was confirming renewal. `socket-red` failed all four production-timer cases at
the premature 4401 close: extended, ended, unavailable and timed out. Both timers
now request the same bounded, single-flight check. The unchecked close path and
its obsolete metric helper are removed; every verdict is counted by socket.lease.
Tests exercise both timers, both frame directions, real Postgres authorization,
the five-second check bound and exactly one outcome count.

The full comparison found two new session-lifetime contract failures. Main's
buffered notification emission query still checked only expiry and revocation;
`emission-red` reproduced disclosure after the home session or alias exceeded
its absolute deadline or lost its configured signing key. All four cases use
real Postgres and Electric, pause after body collection, and assert both an
empty response and the existing emission metric without losing the cursor.
The final query now uses SessionStore.sessionLive for the parent and alias.
The reader inventory also classifies latestRoleVerifiedAt with latestRole as
historical receipt metadata: ended sessions intentionally retain their role
observation and its verification time.

Server review 01a1a93d-545e-74c3-b8d0-99acedc59a15 found that the shared
predicate's transaction-start time could extend a deadline while waiting for a
feed lock. `emission-lock-red` failed all four real SQL/Electric regressions,
with typechecking passing. They observe the actual blocked transaction, let the
database clock cross home/alias absolute or sliding deadlines, then release the
lock. Both shared liveness comparisons now use clock_timestamp() so validation
uses the time after acquisition. The response and existing emission metric
must withhold all rows while preserving the Electric cursor.

Server review 01a1a949-5f9e-72d0-b8c8-862a091ffc69 found that configured-key
membership alone let a buffered request survive its presented row being
restamped by reauthentication. `emission-key-red` failed the home and alias
regressions with three disclosed rows; the alias-parent control passed. These
requests use real signed cookies through SignIn's Sessions, real reauthentication
and rotation stores, Postgres and Electric. Emission now checks Actor.cookieKey
against the presented row, retaining the parent's independent configured-key
check for aliases. Fresh cookies still read, and changing only the parent key
does not invalidate a valid alias cookie.

Server review 01a1a955-1462-7ac1-85ce-40288b37efab found two remaining
inconsistent key checks. `authority-key-red` reproduced home/alias role
revalidation accepting an old key after reauthentication, and alias discovery
and a protected request accepting a parent whose key was no longer configured.
The alias-parent rotation control passed. freshRole now forwards Actor.cookieKey
to authority; findHostLive independently validates the parent's configured key
before checking the presented alias key. Real signed-cookie regressions cover
the refused requests and recovery after the current credential or parent
reauthentication arrives.

Server review 01a1a95e-b5e4-74b2-98d8-5519151a7ac2 found that rejecting an
old key at freshRole returned a permanent permission denial. The real coedit
outbox then deleted the write. `coedit-reauth-red3` reproduced both home and alias
losses; its live-session permission-removal control passed, as did typechecking.
The first two attempts had fixture defects and are not red evidence. Missing
authority now fails retryably, with a fixed `session_authority` diagnostic;
a live confirmed null role still denies permission. The regression resolves a
real signed cookie, pauses the actual HTTP write, reauthenticates in place,
asserts durable retention and diagnostics, then delivers once with the current
cookie. Existing role-expiry tests now distinguish unavailable authority from
confirmed denial. The focused green suite also includes repository roles and
the runner audit; exact-diff review and full comparison are still required.

The completed four-shard comparison at 9625200d ran 6,864 app cases: 6,755
passed, 87 failed and 22 skipped. All 84 baseline failures remained, with three
additional names: runner expiry behind an alias lock, feed document hiding, and
signed-out TODO access. SDK 241/241 and all typechecks passed. Focused repetitions
did not reproduce all three consistently; none is dismissed as a flake. The
original full-run failures and subsequent runs remain in the runner evidence.

Their test synchronization now follows the boundaries being asserted. The runner
test observes its actual PostgreSQL blocker and transaction start, waits on the
database clock for expiry, and releases the lock immediately; it no longer sleeps
800 ms against a one-second lock timeout. The feed test settles the startup
session check before manually controlling the session row. The signed-out TODO
test gives the asynchronous session check an explicit 30-second deadline. Failure
diagnostics retain fixed SQL error categories, phase timings, session/access states
and row counts, without identities or content. Production behavior and the
no-write/no-private-row assertions are unchanged. A fresh full comparison and
exact-diff server review are required for these changes.

Server review 01a1a9c1-61d4-7450-8784-e20c53c7170e found that delayed
writes still used sliding expiry alone and dropped the admitting cookie key.
`delayed-authority-red` reproduced ten invalid HTTP-to-flow writes and two
commits crossing an absolute deadline while blocked on a real unique index;
both independent parent-rekey controls passed. Two inventory assertions also
failed, and all app typechecks passed. `stack-authority-red` separately proved
that home and alias rekeys could still commit a queued TODO; its confirmed
permission-denial control passed.

WriteAuthority now retains the captured key and uses SessionStore.sessionLive
after locking the authority rows. Both runner fence variants preserve that
key, and the final commit includes SessionStore.sessionDeadline. Optional
fields keep older recorded payloads readable. An unconfirmed stale TODO write
answers retryable 503; a confirmed permission denial remains 403. Fixed
write.authority span fields and a session_authority warning explain a refusal
without recording credentials or content; the existing request counter records
the unavailable outcome. The regression also resends the same operation with
current authority and checks exactly one committed TODO. A fresh review and
full failing-name comparison remain required.

Server review 01a1a9db-584c-7cd0-a9a1-4a5955a5d0f9 found three remaining
commit and host-composition gaps. `commit-host-red` reproduced six coedit inserts
committing after home/alias expiry, rekey or revocation during a unique-index
wait. It also reproduced the production flow host refusing valid nonlegacy
sessions when ambient Config disappeared; the removed-key control passed.
The TODO home-deadline case failed correctly, but its other two cases initially
had a fixture reset defect. `stack-deadline-red2` then reproduced all three
home, alias and sliding deadline commits, with typechecks passing.
`socket-insert-red` reproduced both production socket checkers losing their
captured key map and both real coedit outboxes failing to retry after rekeying
behind an insert lock; the permission-denial control passed. Typechecks passed.

TODO and coedit transactions now check the shared authority deadline after
all potentially blocking writes and roll back before returning retryable 503.
Coedit retains the admitting Actor through insertion and checks its authority
under locks; current-authority resends remain idempotent. Runners share the same
deadline expression. The flow host receives the configured verifier's key IDs,
and socket construction captures its key IDs for later checks. Production host
composition tests remove ambient runtime Config; the socket test's host binding
points at the real test database. No SQL behavior is replaced. Existing stale
authority assertions now expect retryable refusal, while actual null-role and
permission denials remain 403. Catalog entries remain the existing flow runtime,
Effect SQL and effect-tanstack-db outbox; no new runtime or retry loop is added.

`commit-host-green` ran 806 cases: 759 passed and 47 failed, with all typechecks
passing. Forty-five failing names were already on main. The two additional
ExecutionHost failures exposed test isolation defects: the new cases reused a
globally unique runner token and left sessions selected by a later auth test.
They now use unique tokens, remove their own rows in a finalizer, bound the
host's drive and report a fixed stage on failure. They are not dismissed as
flakes. The stack fixture also now includes main's role_verified_at so its
authority cases reach their intended transaction. `stack-receipt-green` passed
all 40 cases and typechecks; its budget accounts for main's request-time role
query and the final write deadline query. The original test name is retained
for the exact-name comparison.


The rebase onto main `965a4b23` preserves its published `0108_issue_tree` and moves this lane’s eight unpublished session migrations to `0109`–`0116`. The new `db/SessionUpgrade.test.ts` first failed both numeric-identity uniqueness and the real Postgres upgrade (`Found duplicate migration id's`) before renumbering. It seeds main’s issue relation and home/alias session rows, checks their preservation and session defaults after the upgrade, and verifies that a second migration run applies nothing. The session/metrics import conflict preserves both additions; the client documentation conflict preserves cold search and held-write ordering.


Review `01a1aa14-4cb7-7a72-b7ba-ab4e045508f9` found final deadline gaps in secret and personal-model writes and a socket renewal that rejected a fresh live lease when the database expiry had not changed. `final-writers-red` reproduced all fifteen save/delete/link deadline crossings (home, alias and sliding), plus both home/alias socket failures after a real Postgres lookup wait; all app typechecks passed. The socket preconditions independently confirmed a live lease and unchanged database expiry before the old renewal returned `session`. All five stores now check at transaction completion and roll back mutations and audit rows on expiry. The socket uses the fresh unexpired lease and reports `keep`. Auditing the remaining callers also found the local triage settings path; its first six tests failed a payload-hash fixture constraint before the behavior and are not counted as proof.


The corrected triage regressions (`triage-deadline-red3`) reproduced all six home/alias/sliding deadline commits, with app typechecks passing. The final check now runs after settings, settlement and notification writes inside the transaction, before success logging/counting. The writer/socket run passed all 23 new cases; four existing socket tests needed to expire the real database row as well as advance the independent Worker test clock. After that correction all 88 tests passed; the guard’s initially narrow error annotation failed typechecking and now uses its actual return type, including SQL errors.

The main-5 comparison (`965a4b23`) completed with 6,581 app passes, 84 failures and 22 skips; candidate `5f59523a` had 6,914 passes, 46 failures and 22 skips. Exactly two failing names were new: chat’s immediate sign-in-pill assertion after successful delivery, and the reader matrix receiving Electric 409. Chat now awaits its separate connection subscription. The reader fixture follows bounded must-refetch responses with or without a replacement handle and counts each physical request’s authority check. Two injected-failure regressions first returned 409 on the old helper; successful responses use the real handler and Electric. Catalog entry: `@smthrs/effect-electric`, using its public `ShapeSource` Effect service for failure injection. A preceding real-truncation test attempt failed its own invalidation-count assumption and is not product evidence. Final comparison and exact review receipts remain required.

The next full comparison at `d0d44909` passed those three regressions but exposed
one new failing name in branch-conversation delivery: the queued row existed,
while the view read `[]`. The test first started that branch query inside its
immediate assertion. It now starts the query when the branch opens, as rendering
does, and awaits both the queued view before releasing stalled Electric and the
delivered view afterward. Both row assertions, the two HTTP receipts and the
single persisted question remain checked. The complete failed run is retained;
this is a diagnosed fixture ordering defect, not a flake claim. The combined
writer/socket/reader/chat suite passed 259 tests and all four app typechecks
before this fixture correction. A fresh full comparison follows it.

That comparison (`a308b129`) completed with 6,941 app passes, 44 shared failures,
22 skips and no new failing names; SDK 241/241 and all typechecks passed. Client
receipt `01a1aa69-3fe6-7a02-8ea1-9f960f0fab2a` passed. Server review
`01a1aa69-4d65-7270-ae15-36e51fa39bf5` found two more gaps: old recorded writes
without `cookieKey` accepted a newer session stamp, and a triage retry before
authority recovered permanently refused its pending write. `review14-red`
reproduced all 22 assertions: ten home/alias rekey commits, six deadline retries,
four stale-key retries and two permission-denial classifications. Typechecks
passed. Legacy payloads now retain `legacy`; protected checks distinguish held,
unavailable and denied authority, with a bounded outcome metric, log and span.
Triage retries unavailable authority through its existing durable policy, keeping
the original ID. Confirmed permission denial remains terminal. Catalog entries
remain `@smthrs/flow` and Effect SQL; no runtime or retry loop was added.

`review14-green` passed all new regressions and typechecks (162 passed, four
failed overall). Two older triage tests expected terminal sign-in refusal and
now assert retryable failure with the row still pending. Two repository-demotion
tests exposed an incomplete distinction: `RepoRoles.checkHeld` now returns the
fresh locked observation's held/denied/unavailable decision, with the existing
`holds` API preserving boolean admission. Missing, expired and older observations
cannot confirm denial; six recovery cases cover those boundaries. Live current
repository and deployment denials remain terminal and record `not_allowed`.

The complete m comparison exposed an older deferred-triage assertion and a reader
fixture that treated an initial empty Electric 200 as the seeded result. The
triage case now checks retryable failure, retained pending state on a second
attempt, and no settings mutation. `reader-seed-red` failed its new ordering
regression: seed returned before reading Electric. The fixture now commits its
rows together and uses the catalog's `@smthrs/effect-electric` collection
`awaitTxId` receipt for items, comments and TODO leaves before testing readers.
A held Effect source proves the wait; successful requests use real Electric.
The bounded delivery diagnostic records only table and stage.

The complete n comparison found one additional failing name in the runner-fleet
test. Correlated `fleet.alert.delivery` records showed two Telegram sends for
the same offline incident, 2 ms apart. Its fixture built a new durable engine
for every start, losing execution-ID deduplication across concurrent job probes.
The first explicit double-start attempt passed and is not red proof. The
held-channel regression then failed with two sends admitted where one was
expected; `fleet-host-red3` repeated it with all app typechecks passing. The
fixture now shares the existing Node-host incarnation from the catalog's
`@smthrs/flow` runtime, propagates execution failures, and closes it after the
runs settle. Both concurrent admission and replay must deliver once. The full
fleet scenario forces duplicate starts and reports extra deliveries directly.

The complete o comparison reproduced the API starter-conflict test rejecting
Electric's 409 must-refetch as though its starter had failed the read. That
single-request test now accepts 200 or a verified must-refetch control message,
as its neighboring concurrent-reader test already does. Other statuses still
fail, and the exact one-start log/metric and private-error-text assertions stay.
No response is retried, hidden or relabeled as an authorization success.

Server review 01a1aafc-4b90-78d2-9a47-099766c7bcdf found bearer admission
could outlive its session while starting a role check. `bearer-deadline-red2`
failed all four cases with HTTP 200 instead of 401 after proving the database
deadline crossed during the held start (sliding/absolute, completed/timed out).
All app typechecks passed. Bearer resolution now measures elapsed monotonic time
from before the lookup through role recovery, matching cookie admission. The
regressions use real Postgres and the HTTP model route, verify a live control,
and require an expired call to leave provider calls, usage and budget unchanged
while recording the existing ended-proof count and model refusal. The earlier
red attempt stopped at an unregistered fixture flow and is not regression proof.
The focused `bearer-deadline-green` run passes all four new cases and all app
typechecks: 200 passed, three failures already present by exact name on the
main baseline, zero skips. The full comparison and fresh review remain required.

The next complete comparison (`change-q`) found one new failing name in
AlertChannels: the Admin control read returned no rows before the test waited
for Electric to deliver its committed write. Both shape fixtures now await
the exact shape's transaction with the catalog's `@smthrs/effect-electric`
`ElectricCollection.awaitTxId`, bounded and logged by table/stage. Raw response,
column, audience, count and access-denial assertions remain unchanged. The
`alerts-delivery-green` cfbox run passes all 26 tests and all app typechecks.
The observed failure is retained; no passing rerun is called a flake.

Server review 01a1ab45-2c7e-7a72-85e5-a03706c137f7 found a pending triage
write could not recover its captured key after real reauthentication. The
`triage-reauth-red` run failed all four actual home-callback/alias-handoff cases
after a fresh same-ID resubmission kept the legacy authority; typechecks passed.
The writes route now explicitly reauthorizes only matching pending triage writes,
checks fresh authority under the same row lock execution uses, and leaves old-key
refusals intact. Late role results cannot settle a replaced admission. The old
test that restored a legacy database stamp no longer claims recovery; real
reauthentication tests cover it. `triage-reauth-green` passed all 254 focused
tests and every app typecheck, including the real Postgres blocking-chain race.
Additional regressions cover other owners/repositories, unchanged payloads,
bounded contention, settled repeats and late allow/deny/App-absent role results.
The catalog services remain the existing flow, Effect SQL and crypto libraries;
no retry loop, second scheduler or flow version was introduced.
`triage-reauth-green2` passed 258/258 tests and all app typechecks, including
the expanded negative and late-result cases. The final retry stage had the same
retention defect: `triage-final-hold-red` failed all four home/alias enable/pause
cases because GiveUp terminalized the unavailable write. For local triage only,
that step now uses the same guarded execution; its existing unbounded durable
retry policy retains the write through reauthorization. External GitHub writes
retain their failure policy, and no flow shape or retry policy changed.
The final focused `triage-reauth-green3` run passed 307/307 tests and all app
typechecks, including all 12 reauthorization cases and the ordinary GitHub
flow suite. The full comparison and a fresh server receipt remain required.

Astra server review 01a1ab84-4e2a-7230-a14e-fa6eef23b738 found stale role-denial settlement and permanently failed operator execution IDs. `triage-denial-red` failed all six new write-lock races (expiry, replacement and session expiry for enable/pause), with all app checks passing. `key-operator-red` failed all four real-engine failure/correction/reinvocation cases (stage, promote, retire and emergency-drop), with all app checks passing. The operator dispatch was only extracted before that red run; its permanent execution identity was unchanged. The triage fix retains negative observations for locked validation; the operator uses the catalog entry `@smthrs/flow` / `Flow.retryFrom` and public run inspection, admitting one execution per command. Focused green and the complete comparison are required again.

The review17 focused triage suites passed all 313 tests. Key-operator recovery then passed 40/40 tests with all four app typechecks after two diagnosed integration corrections: run inspection belongs in the engine registration database scope, and retry selection must use an executed ActionCall, not a failed wrapper node. The public installation writer restores the triage fixture's installation receipt before recovery; a provider change alone correctly leaves it pending. The operator retains failed receipts, retries again after a second failed attempt, joins concurrent active calls, reuses completion and refuses a changed emergency replacement before admitting work. Intermediate failures remain in the runner evidence. Final readiness still requires a complete comparison at the final revision and its PASS receipt.

Astra review 01a1abc5-08a1-7391-9ef2-77481d815800 found deployment role observations were not aged at delayed execution, and repository roles could expire during subsequent session/alias or settlement waits. `role-deadline-red` failed all 34 regressions at behavior assertions with all four app typechecks passing; every lock case proved the real database deadline crossed while blocked. The shared protected authority check now checks the configured deployment window and rechecks repository freshness after authority locks. Its final guard checks both role and session deadlines after every mutation/receipt fold, including denial, secret writes and same-ID reauthorization. The tests require unchanged pending state/settings/notifications, zero token calls and same-ID recovery, with separate initial/final authority counters. Catalog entries remain Effect SQL and the existing Smithers durable flow; no new library or retry mechanism. Focused green, a complete comparison and a new receipt remain required.

The first focused role-deadline green run exposed hard-coded fixture generations: sixteen recovery calls were ignored as older observations, and eight deployment-lock cases selected the newer session receipt instead of the seeded receipt. This is not product evidence or a flake. The corrected fixture uses `SessionStore.roleObservation` and explicitly checks the selected receipt. With old production restored, `role-deadline-red2` failed all 34 behavior assertions with all app checks passing; that corrected run is the complete regression evidence. The same production fix was then restored for green validation.

The corrected `role-deadline-green2` run passed 360 tests, with zero failures and six existing skipped secret cases; all four app typechecks passed. All 34 new authority expiry/recovery cases passed, including their separate initial/final counter assertions. The complete frozen comparison and exact review receipts are retained in the coedit401 runner evidence; this note remains in review while the stack is held, with no land or push authorized.

Will narrowed this held change after the two client commits landed at `77ff9a76`: only `kkrskzzz` remains, with no land or push. Server-19 found runtime configuration could widen the deployment role window; Fable found a failed credential publication could strand other contexts' writes on its held lock. `carry-red` reproduces all ten cases on cfbox with four app typechecks passing. The server now captures the role window in the existing host/request services. Shared credential read-lock acquisition uses a two-second bound and the caller's cancellation, retaining the publisher's privacy fence while returning the waiting write to its existing retry owner. No migration or module was added. Further exports use `run-rev.sh`; validation compares four app shards with main-5, followed by at most two completed server reviews. Capacity responses are retried after waiting. Only P1 and person-reachable P2 findings are in scope.

The narrow `carry-green3` run passed all 293 focused tests and all four app typechecks, with no skips. Production-host regressions retain the pending write and recover it under the same ID after fresh authority. Recovery uses the live clock because durable retries follow database time. Native lock diagnostics show cancelled requests settle without a late credential read; queue metadata remains until the publisher releases, then drains. The earlier fixture and type errors remain recorded. The complete comparison and review receipts are kept in the coedit401 runner directory.

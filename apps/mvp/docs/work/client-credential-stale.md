---
title: Hold queued writes for stale credentials
status: in-review
area: local-first
owner: Codex GPT-6.1 Sol
updated: 2026-11-03
links: [../decisions/0023-device-ownership-and-queued-authority.md]
---
Consume the server's 503 stale-credential contract in the bound transport.
Use the library catalog entry `@smthrs/effect-tanstack-db` for durable retries.
Keep the dependency patch unchanged. Record red evidence before implementation.
The device's existing ownership record retains the optional session tag; it grants no authority.
Only mini-run executes tests. Independent re-review is outside this lane.
No reviewer, landing, push, or deployment is authorized.

Follow-up: advertise `x-smithers-accepts: credential-stale` on every same-origin
API request from `boundFetch`, including its session rereads. Requests outside
that API receive no added capability header. Add the real-HTTP regression first;
leave authority checks and the dependency patch unchanged.

Header red evidence: `identity.test.ts:437` expected `credential-stale` but
received the caller's `unsupported` on API requests and no header on session
rereads. The mini executed one failing regression with 41 filtered skips.
An initial fixture scope error was corrected before this valid reproduction.

Header implementation and validation (2026-11-03):
- `ACCEPTS_HEADER` names `x-smithers-accepts` in the shared auth contract.
  `boundFetch` sets `credential-stale` on every same-origin API send and internal
  session reread. Other origins and paths receive no added capability header.
  Ownership logic, the durable outbox SDK and the dependency patch are unchanged.
- Real-HTTP regression: GET, POST, HEAD, explicit session reads and internal
  rereads carry the capability; assets and another origin do not. All 42 identity
  tests, including the existing stale-contract tests, executed successfully.
- Full app selection: 67 files, 883 executed, 880 successful, two existing
  expected failures, one unexpected failure, zero skips. Counts: device 93,
  co-edit 35, issues 160, TODOs 148, runs 236, auth 37, chat 152, wipe 22.
- The co-edit collaborator assertion at `coedit.test.ts:302` failed under load
  with an empty collaborator list. Its first isolated run succeeded: one test
  executed, 31 filtered skips. This does not erase the full-run failure. No test
  retries, sleeps or speculative product changes were added.
- Package: 17 files, 214 successful tests, zero failures and zero skips.
  App `pnpm typecheck` and package `pnpm check` both exited 0 on the mini.
- Admission timeouts were retried before execution. The patch remains 292 lines,
  and patch and lock entries still match bottom commit `09e9388d18b9`.
- Only the mini ran tests and checks. No reviewer, landing, push or deployment
  was run. Independent re-review remains outside this lane. Browser E2E and
  coverage measurement were not run. Own raw outputs are removed after recording
  these receipts. The header advertises support and grants no authority.

Red evidence on the mini, before implementation:
- Transport: `promise resolved Response { status: 503 ... } instead of rejecting`, identity.test.ts:606 (seconds and HTTP-date cases).
- Inconclusive/different-session cases: the same resolved 503 at identity.test.ts:637.
- Recorded tag: all four reports lacked it, identity.test.ts:655.
- Queued co-edit: `expected 0 to be greater than 0`, coedit.test.ts:884, reproduced with that test alone.
- Isolated red runs: identity 6 failures / 35 filtered skips; co-edit 1 failure / 31 filtered skips. These reproduce missing behavior, not suite validation.

Implementation:
- `boundFetch` consumes only 503 plus the stale header as `credential_stale`, before feature status classification. Its reversible gate enforces seconds or HTTP-date Retry-After, then rereads the session with the caller's cancellation signal before sending any held write. The existing outbox owns all retries; no transport resend loop or timer was added.
- Only a reread naming the bound person releases the gate. Inconclusive answers retain the write; signed-out and different-person answers follow existing paths. Send-time owner checks, owner filtering and server device-person binding remain intact.
- The existing bootstrap ownership record adds nullable `session_tag`; verified activation records it and supplies it to page and worker bindings. Offline activation retains it, and another person's answer never replaces it. A missing tag produces no header. It is never logged and grants no authority.

Validation, executed only through mini-run on the Mac mini:
- Full app selection: 67 files, 882 tests executed, 878 successful, two existing expected failures, two unexpected failures, zero skips. Counts: device 92, co-edit 35, issues 160, TODOs 148, runs 236, auth 37, chat 152, wipe 22. All seven new cases executed successfully.
- The two unexpected failures were chat's queued-question restore at chat.test.ts:920 and remote-run Guest-session access at remote.test.ts:470. Each succeeded on its first isolated run: one executed chat test with 83 filtered skips, and one executed remote-run test with 30 filtered skips. Neither failure reproduced alone. No test retries, sleeps or product changes were added for them. These filtered runs do not replace full-suite evidence.
- Package: 17 files, 214 successful tests executed, zero failures and zero skips.
- App `pnpm typecheck`: client, worker, infra and eval checks exited 0. Package `pnpm check`: source and test checks exited 0; this package declares `check`, not `typecheck`.
- Capacity timeouts occurred before execution and were retried. No tests, builds, installs or caches ran on this Mac or either Latitude server.
- Patch lines: 292 before and 292 after. Patch and lock entries are unchanged above 09e9388d18b9, so no bottom-commit squash was needed.

Independent re-review remains outside this lane. No reviewer, landing, push or deployment was run. Browser E2E and coverage measurement were not run. No review verdict is claimed. Raw output files are removed after retaining these receipts.


Round-5 client findings (2026-11-03), red first:
- Preserve the original working change and its documentation in `9b151d97aeaa`;
  all round-5 work is in child changes. No reviewer, landing or deployment.
- Chat: opt into transport session confirmation and propagate `sessionCheck` to
  the shared durable hold. Red: `chat.test.ts:1445`, the sign-in prompt remained
  false. Corrected the fixture's person id before the isolated red reproduction.
- Follower: revalidate cached hold membership with indexed rows regardless of its
  dirty flag, retaining repair information. Red: `Outbox.test.ts:1855`, held became
  false while its owned row remained stored.
- Reopen: eligibility no longer changes the sessionStorage mark. The browser
  records accepted reopens only and retains a pending request at its deadline.
  Red: `identity.test.ts:971`, repeated suppressions deferred the minute boundary.
- Successor: owner-keyed credential deadlines and revisions live beside outbox
  writes. Every page and worker reads them; a successor honors Retry-After and
  verifies the same owner. Red: `identity.test.ts:998`, a new transport sent
  immediately instead of remaining gated. The same regression also exercises a
  different-person reread, which never sends the retained owner's write.
- Memory: a verified current person can authorize a transient memory-only send;
  the no-device-data sentinel grants no retained authority. Red:
  `identity.test.ts:1027`, the retry remained blocked as credential_stale.
- Admission: recover a durable high-water counter once, then atomically persist
  its increment with the write through required `storage.setMany`. No scan or
  non-atomic fallback occurs per admission. Red: `Outbox.test.ts:1526`, 1,000
  admissions read 499,500 predecessor rows instead of fewer than 4,000 rows.
  The final bound counts all storage reads, not only transaction reads.
- Use the catalog entry `@smthrs/effect-tanstack-db`. The new batch capability is
  a public host boundary; the browser uses one IndexedDB transaction. Existing
  admission fault fixtures now target that batch so they still exercise failure,
  cancellation and duplicate input. No feature's ownership checks were relaxed.
- Package validation: 17 files, 216 successful tests, zero skips; `pnpm check`
  exited 0 on the mini. Includes an aborted batch retaining neither counter nor
  write, and the follower and bounded-read regressions.
- The initial app snapshot was stopped after its storage fault fixtures were
  superseded. Its results are not validation of the final tree. The final app
  selection also includes affected branch, attention and command admission suites.
- Dependency patch remains 292 lines and is byte-unchanged, as are its lock entries,
  above `09e9388d18b9`. No bottom squash is needed. Final app evidence follows.

- The strengthened memory-only ownership regression also failed first at
  `identity.test.ts:1046`: a page that had verified A released its transient held
  write after a reread named B. The gate now retains the verified transient person,
  including in its state record. That person must match before sending; the
  sentinel never substitutes for them. All 46 identity tests then executed
  successfully with zero skips, and app typecheck exited 0 on the mini.


Final round-5 receipts (Mac mini only):
- Full selection: 70 files, 950 executed, 946 successful, two existing expected
  failures, two unexpected failures, zero skips. Required-area counts: device 96,
  co-edit 35, issues 160, TODOs 148, runs 236, auth 37, chat 153, wipe 22.
  Additional affected suites: branch conversation 19, attention background 24,
  command admission 20.
- Chat's retained-owner test failed again alone at `chat.test.ts:801`: it counted
  the admission counter as a queued question. Its assertion now checks transaction
  rows and still verifies A's row stays stored, is never shown to B, and never
  reaches the server as B. The entire final chat file then executed successfully:
  85 tests, zero skips. The confirming 401 hold/reload/sign-in test succeeded too.
- Remote steer failed at `remote.test.ts:290` under load, then succeeded on its
  first isolated execution: one executed, 30 filtered skips. No retry or sleep was
  added to a test, and no product change was made for this non-reproducing failure.
- Final identity file: 46 successful, zero skips. This adds the transient-person
  fencing case to the full selection's 45. Final per-file coverage therefore
  contains 951 distinct tests: 949 ordinary successes and two expected failures,
  with the full-run failures and replacement executions disclosed above.
- Final required-area inventory: device 97, co-edit 35, issues 160, TODOs 148,
  runs 236, auth 37, chat 153, wipe 22 (888 distinct). The three additional
  affected suites add 63. All unfiltered runs had zero skips; filtered isolation
  runs classify failures only and do not replace an entire suite.
- Package: 216 successful tests in 17 files, zero skips. App `pnpm typecheck`
  and package `pnpm check` both exited 0, including a final app check after the
  memory-person fence and chat assertion correction.
- The stack is conflict-free and remains local. No reviewer, landing, push or
  deployment occurred. Independent re-review remains outside this lane. Browser
  E2E and coverage measurement were not run. Own raw outputs are deleted after
  retaining these receipts.

---
title: Commit-time write authority
status: completed
area: access
owner: Codex GPT-6.1 Sol
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

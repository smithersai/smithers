---
title: Durable browser engine (B1)
status: in-progress
area: sdk
owner: Opus browser-engine repair builder assigned by lead
updated: 2026-10-21 21:44 PDT
links: [agent-root-browser-safe.md, ../decisions/0011-the-agent-runs-in-the-browser.md, ../decisions/0003-flows-and-the-agent.md, ../decisions/0002-local-first.md, ../rules.md, flows-and-agent.md, durable-answering.md, model-endpoint.md, pwa.md, local-first.md, host-agnostic-flows.md, everything-is-a-durable-flow.md, notifications-and-live-work.md, one-sqlite-one-leader.md, b1-follow-ups.md, flows-root-platform-neutral.md, plan-identity-across-deploys.md, plan-identity-minified-builds.md]
---

## Tracker reconciliation — 2026-10-21 21:44 PDT

**What:** Preserve durable writes and tab handover in the browser.

**Why:** Completed writes must survive handover without duplication or tampering.

**Current state:** At 21:36 the lead reports eight completed commits with the lander, 331 passing tests at full coverage and passing docs checks. Third Astra review found cross-tab overwrite, rename/delete, and burst-overflow accounting defects; all are reported fixed. Landing and hosted recovery acceptance are not yet reported.

**Next step:** Land the reviewed stack and collect browser recovery and deployed validation receipts.

**Open questions for Will:** None newly required.

Evidence: script-filtered recent human text and lead replies through 21:43 PDT in session 6253ecf2, current rulings and queue answers; surviving reports where cited. The supplied continuation path is absent; post-reboot replies are in the available transcript. Product results are reported receipts, not rerun here. Existing execution owner retained; Codex curates documentation. Wiped scratch files are not missing work.

## Earlier tracker history (retained)


## Tracker reconciliation — 2026-10-21 17:14 PDT

**What:** Preserve browser durability across store preparation and tab handover.

**Why:** Writes must commit once and fail closed when persistent storage is unavailable.

**Current state:** At 17:06 five commits are queued, reviewed twice by Astra with reported 100% coverage; generated docs still need landing. Single-tab writes commit once. Failed upgrade preparation blocks local database writes while rows remain in memory, superseding the earlier proposed decision-0021 behavior. One fixed-200-ms runtime test flaked under load.

**Next step:** Land with regenerated docs, repair the flaky test through Sol and retain browser recovery E2E receipts.

**Open questions for Will:** None.

Evidence: script-filtered user-typed text and lead replies in session 6253ecf2, approximately 15:14–17:14 PDT. Notifications, relayed agents, tools and compaction summaries excluded. Rulings and queue answers supersede older briefs/designs and docs. Execution owner retained; Codex curates the tracker only. Product results are lead-reported.

## Earlier tracker history (retained)


## Tracker reconciliation — 2026-10-21 14:05 PDT

**What:** Preserve browser durability through tab handover and database initialization.

**Why:** Completed writes must not repeat and a failed store must refuse traffic.

**Current state:** At 13:55 PDT the lead reports three confirmed platform-browser defects: terminal reconnect has a handwritten retry loop, tab handover can repeat an already-finished write, and failed database setup still accepts traffic. A new Opus builder owns all three. Reopened from done; no repair receipt is reported.

**Next step:** Replace reconnect recovery with durable engine behavior; retain handover/replay and failed-setup refusal regressions, then validate real browser recovery.

**Open questions for Will:** None.

Evidence: user-typed text and lead text replies extracted by script from session 6253ecf2 for approximately 12:04–14:04 PDT on 2026-10-21; synthetic notifications and tool records excluded. Rulings and queue answers override historical briefs, designs, decisions, proposals, TODOs and rules. Product receipts are lead-reported; this tracker validates the maintainer-site build only. Engineering owners remain responsible; Codex owns this documentation reconciliation.

## Earlier tracker history (retained)


## What

`@smthrs/platform-browser` hosts the `@smthrs/flow` engine in the browser, so the agent and every local flow are durable in a tab:
- The engine's step record lives in SQLite on the origin's private file system (OPFS), through Effect SQL.
- One leader tab's dedicated Web Worker runs the engine, chosen with the Web Locks API. The other tabs follow over a `BroadcastChannel` and send their requests to the leader.
- When the leader tab closes, another tab takes the lock and resumes from the step record.
- A wake-up on load resumes due runs.
- The app requests persistent storage, because Safari may clear a site's storage after 7 days without a visit.
- `BrowserRuntime.layerHost` provides the whole host as one layer.

The proof is a test that kills the page mid-flow, reopens it, and sees the flow resume without re-running finished steps.

## Why

Will, 22:25 on 2026-10-19: "A syncronous change to storage is by default durable yea. In fact this kinda explains why we maybe should reconsider where the agent runs. The agent should run on frontend and the frontend itself should be durable."

Will, 22:29: "If smithers doesn't work in browser yet that's a bug it should work in browser via platform-browser." On tabs: "I think to handle multiple tabs we might want it running in a service-worker? You can decide this".

The lead chose a leader tab's dedicated worker over the service worker:

```
need                         dedicated worker (leader tab)   service worker
fast SQLite on OPFS          yes (createSyncAccessHandle)    no sync access handle
alive while a model streams  yes, while its tab is open      stopped after ~30 s idle
one runner across tabs       yes, through Web Locks          one instance, stopped when idle
```

The service worker only serves the app offline ([PWA](pwa.md)).

## State

- 22:31: decision [0011](../decisions/0011-the-agent-runs-in-the-browser.md) accepted; the lead started B1.
- Order: the tracer bullet first (kill mid-flow, reopen, resume), then leader election across tabs, the wake-up on load, persistent storage and `BrowserRuntime.layerHost`.
- Before B1, `@smthrs/platform-browser` had a file system, a shell and wasm jj (`BrowserFileSystem`, `BrowserChildProcessSpawner`, `BrowserServices`, `BrowserHost`). It had no engine store, leader election or wake-up.
- 22:36: no B1 file on disk yet in `packages/smithers/flows/platform-browser`, and no report.
- Related, from W1 ([durable answering](durable-answering.md)): `@smthrs/database`'s `PostgresDatabase.layer` now takes the `@effect/sql-pg` driver as a parameter so the adapter bundles for browsers and Workers, and `Dialect.readTransaction` opens a deferred `BEGIN` on SQLite.
- 0003's build plan named this piece F2, "engine and browser host" (`platform-browser/src/BrowserFlows.ts`), as an in-memory engine. 0011 replaced that with this durable engine.

- 22:40 to 22:42, B1's first files, uncommitted and unreported:
  - `package.json` adds `@effect/wa-sqlite` 0.2.1.
  - New `src/BrowserSqlite.ts`: SQLite on OPFS through wa-sqlite's synchronous build and its access-handle pool VFS, exposed as the Effect `SqlClient` the engine stores are written against. It runs only in a dedicated worker, where `createSyncAccessHandle` exists.
  - It wraps wa-sqlite itself instead of using `@effect/sql-sqlite-wasm` 4.0.5, because that package returns rows where `@smthrs/database`'s `DurableWriter.affectedRows` reads `{ changes }`, so a store's compare-and-set would read every write as a no-op. Integers wider than 32 bits bind as SQLite integers, so epoch-millisecond columns keep their type.
  - New `src/internal/AccessHandlePoolVFS.d.ts`.
  - No tracer-bullet test on disk yet.
- 22:42: the lead's 0011 docs agent revises 0003's build plan so the agent flow runs on this host, and 0009 so this host's runs join the run index through 0002's outbox ([flows and the agent](flows-and-agent.md), [notifications](notifications-and-live-work.md)).
- 22:43: the lead lists B1 as running.

- 22:45 to 22:54, B1's next files, uncommitted and unreported, in `packages/smithers/flows/platform-browser`:
  - New `src/BrowserEngine.ts` and `src/BrowserRuntime.ts` (the engine in the worker and the host layer), `src/WebLock.ts` and `src/internal/Leader.ts` (leader election), `src/TabChannel.ts` and `src/internal/Protocol.ts` (the tabs' channel to the leader), and `src/StoragePersistence.ts` (persistent storage). `src/BrowserHost.ts` and `src/index.ts` changed with them.
  - **The proof tests are written, in real Chromium over real OPFS** (`test/browser/Durability.test.ts`, `vitest.browser.config.ts`, with a test page and engine worker under `test/browser/app/`). Three cases:
    1. "resumes at the step a killed browser was in, and never runs a sealed step again" (the tracer bullet);
    2. "moves to a follower tab when the leader tab closes mid-run, and the follower finishes it";
    3. "wakes a durable sleep that came due while every tab was closed".
  - A unit test, `test/BrowserRuntime.test.ts`, covers `BrowserRuntime.layer`.
  - No result yet: nothing says whether the three cases pass.
- 22:49: the 0011 docs revision put this host into 0003's build plan (the `client` placement and the agent's flow `chat/Respond`) and 0009's run index (browser runs write `runs` rows through 0002's outbox) ([flows and the agent](flows-and-agent.md), [notifications](notifications-and-live-work.md)).

- 22:58 to 23:10, B1 still writing, uncommitted and unreported: `Durability.test.ts` and `Harness.ts` changed at 22:58; then unit tests and fixtures, likely the coverage push: `test/StoragePersistence.test.ts`, `WebCrypto.test.ts`, `WebLock.test.ts`, `TabChannel.test.ts`, `BrowserEngine.test.ts`, `index.test.ts`, `BrowserRuntime.test.ts` and `BrowserSqlite.test.ts`, with fixtures `MemoryOpfs.ts`, `MemorySqlite.ts`, `Engines.ts`, `Flows.ts` and `Telemetry.ts`. `src/WebLock.ts`, `BrowserEngine.ts`, `BrowserRuntime.ts`, `BrowserSqlite.ts` and `internal/Leader.ts` changed again by 23:10. Still no result for the three Chromium cases.
- 23:01: **L1 coordinates with B1** ([local-first](local-first.md)). Two OPFS SQLite users will share the origin: B1's journal on `@effect/wa-sqlite` and TanStack DB's replica, whose browser persistence uses `@journeyapps/wa-sqlite`. L1 checks whether TanStack takes an injected connection, so both use one wa-sqlite build, and whether TanStack's multi-tab coordination and this Web Locks leader can be one mechanism. L1 may not edit this package; it reports what it needs.
- 23:02: the lead lists B1 as building; the agent flow in the app waits on B1 and the [model endpoint](model-endpoint.md).
- 23:10 to 23:15: B1 still writing, unreported: `src/BrowserEngine.ts`, `src/BrowserSqlite.ts`, `src/internal/Leader.ts`, `src/internal/Protocol.ts` and `PACKAGE.ts` changed again, with `BrowserEngine.test.ts`, `BrowserRuntime.test.ts`, `WebLock.test.ts`, `StoragePersistence.test.ts` and a fresh `dist/` build. Still no result for the three Chromium cases.

- 23:14 to 23:18: **B1 is writing its docs**, unreported, in `packages/smithers/flows/platform-browser`:
  - `PACKAGE.ts` (23:14); `README.md`, `docs/README.md`, `docs/api.md`, `docs/installation.md`, `docs/troubleshooting.md` and `docs/testing.md`;
  - a new concept page, `docs/concepts/durable-browser-engine.md`, and a new guide, `docs/guides/run-flows-in-a-tab.md`;
  - a `CHANGELOG.md` entry for `BrowserRuntime`, `BrowserEngine`, `BrowserSqlite`, `WebLock`, `TabChannel` and `StoragePersistence`;
  - `docs/testing.md` names the Chromium suite as the `browserTest` target (`vitest run --config vitest.browser.config.ts`);
  - `docs/libraries.md` gained the package's job row, "Run flows in a browser tab, durably", at 23:18 ([library catalog](library-catalog.md)).
  - No `src` or test file changed after 23:15. Docs come last in the brief, so B1 looks close to its report. Nothing on disk says whether the three Chromium cases pass.
- 23:25: **L1's packages chose their own SQLite build** ([local-first](local-first.md)): `@journeyapps/wa-sqlite` 1.7.2 with `@tanstack/browser-db-sqlite-persistence` 0.2.36, beside B1's `@effect/wa-sqlite` 0.2.1. L1's outbox takes the library's `LeaderElection` as an option (`Leader.focusedTab` in a browser), so B1's Web Locks leader could be passed in. For now the origin would carry two wa-sqlite builds and two leader mechanisms; no report says whether they merge.

- 23:28: **the lead settled the SQLite and leader conflict** ([one SQLite, one leader](one-sqlite-one-leader.md)). One build, `@journeyapps/wa-sqlite`, because TanStack's persistence requires it. B1 switches its engine store to it, and the app opens one OPFS VFS for both. B1's Web Locks leader is the single leader, injected into L1's outbox.
- 23:30 to 23:33, on disk, unreported:
  - `package.json` swaps `@effect/wa-sqlite` 0.2.1 for `@journeyapps/wa-sqlite` 1.7.2. `src/BrowserSqlite.ts` opens the database through `@journeyapps/wa-sqlite`'s synchronous build and its `AccessHandlePoolVFS`.
  - `src/BrowserRuntime.ts`, `src/internal/AccessHandlePoolVFS.d.ts`, `test/BrowserSqlite.test.ts`, `test/fixtures/MemorySqlite.ts` and `test/browser/Harness.ts` changed with it.
  - The README, `docs/api.md`, `docs/installation.md`, `docs/testing.md`, the concept page, the guide and the changelog changed again.
  - Still no result for the three Chromium cases.

- 23:38: `src/BrowserSqlite.ts` changed again.
- About 23:41: **done, reported.**
  - A real Chromium test SIGKILLs the browser after step 1, and the run resumes at step 2 without re-running step 1: 3 of 3 cases, repeated 9 times. Leader handoff between two pages finishes at once, and a durable sleep that came due while every tab was closed fires on reopen.
  - API: `BrowserRuntime.run`, `serve`, `layer` and `layerHost`; `BrowserEngine.layer({ name, worker })`; and the injectable `BrowserSqlite`, `WebLock.hold`, `TabChannel` and `StoragePersistence`.
  - 197 tests at 100% coverage, on `@journeyapps/wa-sqlite` 1.7.2.
  - Four follow-ups wait until the child-flow and [flows root](flows-root-platform-neutral.md) agents finish ([B1 follow-ups](b1-follow-ups.md)): the engine-store README and `Ownership` docs still say browsers can't run flows; `BrowserRuntime.isAlive` duplicates `CloudflareHost.isAlive`; three copies of a WebCrypto `Crypto` layer should become one in `@smthrs/crypto`; the support matrix still says browsers are bundle-only.
  - The lead told Will: "Durable flows now run in the browser." It unblocked the critical path: F1 and F4+F5 started ([flows and the agent](flows-and-agent.md)).
- By 23:44: L1 was told to wire the app's persistence and outbox to `BrowserSqlite`, as a second database file on the shared service, and to `WebLock`, removing the redundant leaders ([one SQLite, one leader](one-sqlite-one-leader.md)).
- About 00:55 on 2026-10-20: three of B1's follow-ups are done: the engine-store and run-store docs, one liveness helper (`Ownership.singleIncarnationLiveness`, replacing `BrowserRuntime.isAlive` and `CloudflareHost.isAlive`) and the support matrix. About 01:00: the one `Crypto` layer, the `BrowserSqlite.ts` fix, the shared `execute` service, `WebLock.hold` with `steal` and lazy engine loading started ([B1 follow-ups](b1-follow-ups.md), [one SQLite, one leader](one-sqlite-one-leader.md)).

- About 02:05 on 2026-10-20: **every B1 follow-up is done** ([B1 follow-ups](b1-follow-ups.md)), and the `platform-browser` agent added `SharedSqlite` and `WebLock.hold` with `steal` on this host; the engine and its wasm load only in the worker ([one SQLite, one leader](one-sqlite-one-leader.md)). 02:14, on disk, unreported: `BrowserEngine`'s `start`, `result`, `cancel` and `signal` take a `BrowserEngine.FlowReference`, so a tab can run a flow it doesn't import, such as the agent ([agent root in the browser](agent-root-browser-safe.md)).
- **About 05:25 on 2026-10-20: a parked run doesn't survive an app update.** The engine's plan record includes each node's `declaredAt` (bundle path and line), and the journal compares records by content. A tab that resumes `chat/Answer` from OPFS under a new build whose lines moved fails `plan_changed`, and the answer stays "Smithers is answering". Found on the server through `chat/Expire`; the defect is in the shared engine store, not this host, and an SDK agent is fixing it ([plan identity across deploys](plan-identity-across-deploys.md)). Status stays done for this host; the resume after an update is proven only once that fix lands.
- **05:57:59 on 2026-10-20: the shared engine-store fix is done** for rebuilds that move declarations; `platform-browser` passes in Node and Chromium, including resume after a kill ([plan identity across deploys](plan-identity-across-deploys.md)). A minified app update can still rename locals inside an unchanged callback and fail a tab's resumed `chat/Answer` with `plan_changed`; a follow-up agent closes that from about 05:58 ([plan identity in minified builds](plan-identity-minified-builds.md)). Status stays done for this host.

## Next

From about 05:25 on 2026-10-20: the [plan identity](plan-identity-across-deploys.md) fix, then a browser case where a run parked under one build resumes under the next.

Until about 05:25 on 2026-10-20: nothing here. Next come the [B1 follow-ups](b1-follow-ups.md); L1 putting the app on `BrowserSqlite` and `WebLock` ([one SQLite, one leader](one-sqlite-one-leader.md)); and F5's agent flow on this host ([flows and the agent](flows-and-agent.md)).

Until 23:41 the next step was: B1's report: the three Chromium cases passing on `@journeyapps/wa-sqlite`, 100% coverage, the docs, and the leader and VFS the app shares with L1's outbox and replica ([one SQLite, one leader](one-sqlite-one-leader.md)). Then the walking skeleton on this host ([flows and the agent](flows-and-agent.md)).

Until 23:28 the next step was: B1's report: the three Chromium cases passing (kill and resume, leader handoff, a sleep that came due with every tab closed), `@smthrs/platform-browser` at 100% coverage, and its docs. Then the walking skeleton on this host ([flows and the agent](flows-and-agent.md)).

Until 22:54 the next step was the tracer-bullet test passing in a real browser, then a test that closes the leader tab mid-flow and sees another tab resume; both are now written.

## Questions for Will

None. Will left the worker choice to the lead.

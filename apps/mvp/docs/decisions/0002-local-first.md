# 0002: Local-first: a device store, a durable outbox, and answers through Postgres

Status: accepted (Will, 2026-10-19; design panel: Opus as lead, and Sol). This replaces the "Writes need the network" consequence of [0001](0001-electric-postgres-tanstack-db.md); 0001's other decisions stand. The per-point comparison of the two designs is in [0002-local-first-comparison.md](0002-local-first-comparison.md).

## Decision

1. **Every read comes from the device.** `messages` is an Electric collection wrapped in TanStack DB's SQLite persistence: OPFS, through `@tanstack/browser-db-sqlite-persistence`. It syncs eagerly, one shape per conversation, and a reload resumes the shape from its stored offset and handle.
2. **Every write goes through one durable outbox, `@tanstack/offline-transactions`.** An ask is an offline transaction, stored in IndexedDB before it is sent, retried by the library's own backoff, and restored after a reload or restart.
3. **A queued question never overlays a synced row.** It lives in an in-memory `asking` collection, and views read `messages ∪ (unsent − messages) ∪ (asking − messages − unsent)` (the `unsent − messages` part since 2026-10-20: a delete the device store lost in a leader handover must not show a question twice). Only the server's routes write answer rows; since decision 0011, the asking browser's agent writes through them.
4. **The focused tab leads the outbox, and an ask is accepted only into durable storage.** A custom `LeaderElection`, an option the library documents, takes the Web Lock with `steal` on focus; other tabs queue. An ask never takes the library's online-only path. As built (2026-10-20): `Outbox.lockLeader` over `@smthrs/platform-browser`'s `WebLock`, whose `take` steals the lock when the window gets focus, when anything in it gets focus (the composer), or when a person asks in a tab that doesn't lead; the tab that led stops sending and waits in line again.
5. **A question the server refuses stays on the device** in a persisted `unsent` collection until the person edits or discards it.
6. **Answers stream as Postgres row updates through Electric.** Durable Streams waits for a measured need.
7. **The server answers a conversation's questions one at a time, in `position` order.** The composer never blocks.
8. **A service worker precaches the app shell, so a reload works offline.** It never caches `/api/*`.

## Why

- **Will's requirements (2026-10-19):** the app reads and writes only its local store, shows no spinner except while Smithers answers, and never loses an ask made offline, across reloads and restarts. 0001 rolled such an ask back with a failure.
- **Each piece is a library's documented mechanism, configured:** TanStack persistence keeps the rows and Electric's resume state ([1]), offline-transactions keeps the outbox and its retries ([2]), and the flow engine answers ([HOST-PLAN]).
- **The app adds only two pieces:** an anti-join on the question id (Electric's "shared persistent optimistic state", [4]) and a leader-election adapter.

## Consequences

- **Two browser stores, each owned by its library:** OPFS SQLite for the replica, IndexedDB for the outbox. "Configure each system for the storage it owns" ([2]).
- **A device downloads its whole conversation on first open.** On-demand paging, subset proxying and the `keepOffset` workaround are deleted.
- **Answers run in turn,** so a burst of offline questions, or several people asking, get answers that see each other.
- **An offline restart needs one earlier online visit,** when the service worker installed the shell.
- **New dependencies:** `@tanstack/offline-transactions` 1.1.3, `@tanstack/browser-db-sqlite-persistence` 0.2.36, `@tanstack/db-sqlite-persistence-core` 0.4.11, `@journeyapps/wa-sqlite` and `vite-plugin-pwa`; for tests, `@tanstack/node-db-sqlite-persistence` 0.2.36. The TanStack set was published on 2026-10-18 and pins `@tanstack/db` 0.15.1. Under the 7-day rule it lands on 2026-10-25, alone at the bottom of the stack.

## 1. Architecture

```
TAB (any)                                              CLOUDFLARE (Alchemy)                  NEON
React ◀── live queries: conversation = messages ∪ (unsent − messages) ∪ (asking − …)
actions ─▶ ask = outbox.transact("ask", {id: q}, () => asking.insert(row))      (sync; no network)
  memory     asking     optimistic rows of pending outbox transactions
  OPFS       messages   Electric rows + electric:resume {offset, handle, shapeId} + seen txids
  OPFS       unsent     questions refused by the server or not admitted
  IndexedDB  outbox     {id = idempotencyKey = questionId, row v1, retryCount, lastError, spanContext}
  focused tab leads ── POST /api/questions {id, answerId, text} ─▶ ChatApi ─▶ chat/Ask ─▶ INSERT q + a ─▶ Postgres
                         202 {txid} │ 200 existing │ 400 │ 409 │ 413         chat/Answer: wait turn ─▶ ModelStep
                                                                            └ fenced text updates, chat/Settle ─▶ Postgres
messages ◀── /api/shapes/messages?offset&handle&live (proxy) ◀── Electric 1.8 ◀── replication ◀── Postgres
service worker: precached shell, fonts, wa-sqlite WASM, OPFS worker; /api/* network only
```

| Store | Holds | Survives | Owner |
|---|---|---|---|
| Postgres | `messages`, the engine journal (`smithers_flows`) | everything | source of truth |
| OPFS `smithers.sqlite` | `messages`, Electric resume state, `unsent` | reload, restart | `BrowserCollectionCoordinator`: one tab writes, the others route writes to it |
| IndexedDB | the outbox | reload, restart | the outbox leader |
| Tab memory | `asking`, composer, sync health, window | nothing | the tab |

- **Read:**
  - Views are live queries over local collections. Opening the app restores rows from SQLite (`persistedStatus: ready`), then Electric resumes from the stored offset; `electric-db-collection` 0.6.2 persists `electric:resume` and the txids it has seen.
  - On-demand caches are excluded: "an on-demand cache is not yet a certified offline snapshot" ([1]).
  - Load earlier moves a local window. Until the first restore or snapshot, the conversation is blank, never shown as an empty state.
- **Write:** `ask` validates, picks `questionId` and `answerId`, and inserts the `asking` row inside an offline transaction, all synchronously. The leader writes the IndexedDB entry (**admitted**), then runs the `ask` mutation (§3) until Postgres has the row and Electric delivered it (**settled**).
- **Answer:** HOST-PLAN's `chat/Ask` → `chat/Answer` → `ModelStep` → `chat/Settle`, plus the turn wait and the history bound (§3).
- **Tabs:** the SQLite coordinator and the outbox elect leaders separately, as the guide prescribes. A page restored from the back/forward cache reloads, because the persistence README requires fresh database connections then.
- **One writer per shape (2026-10-21):** one tab of a device stores what each synced collection's shape syncs: the tab holding its Web Lock `persisted-sync:<collection>`, which a tab waits for and never steals (`Collection.make` with `Persistence`'s `lock`, `@smthrs/effect-tanstack-db`). Every other tab's shape only watches: it tells the tab how the network is and when it is ready, and the tab's rows come from the device store through the coordinator. Before, every tab stored its own shape, and a tab's fresh snapshot, taken before a question arrived and stored after another tab had stored that question, erased it from the device and, by the reload that followed, from both tabs ([local-first conflicts](../work/local-first-conflicts.md), stale tab).

## 2. UX states: exact behavior and copy

The connection pill sits in the header, in an `aria-live="polite"` region, and announces each change once.

| State | Behavior | Copy |
|---|---|---|
| Online, up to date | conversation only; the one animation is the dots on a streaming answer | none |
| Asking online | the question shows in the same frame and the draft clears; the answer row shows once Postgres has it | none |
| Offline | pill | `Offline` |
| Asking offline | the question shows at the end, marked; the count rises; no answer placeholder, since nothing is answering; Edit (added 2026-10-20) takes it out of the outbox under the outbox's lock and moves its text to the composer ([chat](../features/chat.md#message-controls)) | pill `Offline · 2`, badge `Queued` + `Edit` |
| Reading offline | the whole conversation from the device; Load earlier is instant | `Offline` |
| Reload or restart offline | the shell from the service worker, rows from OPFS, queued questions restored | `Offline · 2` |
| Reconnecting | no state of its own. `Queued` badges clear as each question reaches Postgres, then its answer streams; the pill hides once the shape is up to date and the outbox is empty | none |
| Online but Smithers unreachable (shape or send failing for 10 s) | as offline; Retry syncs and sends now | `Offline` + `Retry` |
| Electric refused the shape (4xx, unreadable) | rows stay; Retry restarts the shape | `Sync failed` + `Retry` |
| A queued question is refused (400, 413) | it stays where it was; Edit moves the text to the composer and removes the row | `Not sent` + `Edit` + `Discard` |
| Conflict: the `id` already holds other content (409) | as refused | `Not sent` + `Edit` + `Discard` |
| Not admitted (outbox storage failed) | the question stays, unsent; Retry admits it again | `Not sent` + `Retry` + `Discard` |
| Smithers answered while you were offline | the answer appears whole on reconnect; past tokens aren't replayed | none |
| Offline mid-answer | the text so far stays; the dots stop | `Offline` |
| Several tabs | the same conversation everywhere; the focused tab leads and restores every question queued in this browser | none |
| Several devices | each shows its own queued questions; the others see them once Postgres has them, in Postgres order | none |
| The model failed (unchanged) | the answer is marked; Retry asks again under new ids | `Couldn't answer` + `Retry` |
| This tab's engine worker failed (added 2026-10-20 with the browser's agent, decision 0011) | for good: the device can't answer, and its rows stay in memory; the device store stops waiting for a leader at once | `Smithers can't run in this browser` + `Reload` |

`Queued` shows only while the pill shows, so an online ask never flashes it. No other loading, saving or syncing copy exists.

## 3. The write path

**Idempotency.**
- `questionId` and `answerId` are picked once and stored in the outbox row; the transaction id and the idempotency key both equal `questionId`. Every replay sends a byte-identical body.
- The server keeps today's contract: it inserts `ON CONFLICT (id) DO NOTHING` and compares, answering 200 for the same content and 409 for other content. `chat/Ask` starts under the answer id, and the Durable Object treats the same intent as a no-op ([HOST-PLAN]).
- Restarts, leadership changes and lost responses all replay safely. The `messages` primary key is the dedupe record.

**The `ask` mutation** is an Effect, and the wrapper maps its errors onto the executor:
1. POST, with one 15 s deadline over the whole request.
2. On 202 or 200, start this device's agent, `chat/Answer` under the answer id (decision [0011](0011-the-agent-runs-in-the-browser.md)), and wait until its engine has recorded the run; the run goes on in the background. So the outbox entry outlives every moment the server holds a question no run will answer: a tab closed between the POST and the engine's record leaves the entry, and the next page sends it again (200) and starts the run. The engine starts an execution once. A start that fails (no engine in this tab, refused, the tab closing) is **Retry** (added 2026-10-20, review P1-1).
3. On 202 or 200, wait until the question's row shows in `messages`, there already or once it arrives (`messages.awaitRow`), for 15 s counted from the device's restore, which it waits for 15 s at most (a device store in memory restores from the network). The row reaches every tab, the one that stores the shape's rows and the ones that watch, so the wait is on the row, never on this tab's own stream (2026-10-21; before, `awaitTxId` on 202 waited from the POST and timed out behind a slow restore, so the question was sent twice).
4. **Refused (400, 409, 413):** upsert an `unsent` row keyed by `questionId` (a crash replay is harmless), then fail with `Refused`, which becomes `NonRetriableError` and rolls back `asking`.
5. **Retry (network, 5xx, 408, 429, delivery timeout, a run not recorded):** fail with `Retry`. The library retries 1 s doubling to 60 s, with jitter, FIFO and one at a time; delays reset on `online` or on Retry.

**Library rules the wrapper defuses.** In `retry/RetryPolicy.ts` (1.1.3), an `AbortError` is never retried, and our deadline aborts `fetch`. An error whose message contains "400", "401", "403" or "422" is never retried either. The wrapper throws only its own error names, with fixed messages, and has a regression test for each rule.

**Admission.**
- `transact` succeeds only when this tab leads and the outbox storage is durable. Steal-on-focus makes the composer's tab the leader before anyone can type. An ask that still finds another tab leading is kept `unsent` (`not_admitted`) for the moment the steal takes, then sent from this tab.
- A tab learns whether it leads from the lock, never from a timer (2026-10-21): the outbox starts once a Web Locks `ifAvailable` request has answered, so a tab alone leads before its first ask, however slowly the browser grants the lock. Before, `lockLeader` answered "follower" after 100 ms, and a lone tab's first question showed `Not sent` until the grant arrived.
- In 1.1.3, a follower falls back to an online-only transaction, with no outbox and no retry. The wrapper never takes that path.
- If the IndexedDB write fails, the commit rejects, `asking` rolls back, and the wrapper writes an `unsent` row with reason `not_admitted`.

**Reconciliation.**
- **Queued:** an `asking` row plus an IndexedDB entry.
- **Stored:** this device's engine has recorded the answer's run, Electric delivers the row, the anti-join hides `asking` in the same frame, and the mutation returns, so the transaction settles.
- **Confirmed:** the library deletes the entry.
- **Why `asking` is separate:** TanStack layers optimistic rows as whole-row snapshots ([3]), so an overlay on `messages` would mask the streamed answer and the server's `position`.
- **A tab that loses leadership mid-send** leaves its own transaction unsettled. The new leader restores the entry and resends it, and the server dedupes. The stale `asking` row stays hidden by the anti-join until reload.

**Order.**
- One device sends FIFO, one at a time, so its order reaches Postgres intact, even across a leadership change, because the new leader replays in creation order.
- Across devices, Postgres arrival (`position`) decides.
- Queued questions sort after every synced row by local `queuedAt`, then take their server position. No device clock orders the conversation ([state.md](../state.md) rule 6).

**Late writes on the server.**
- A question is accepted at any age and positioned on arrival; the 10-minute deadline counts from arrival.
- **Turn wait:** `chat/Answer` first waits for the previous answer in its conversation to settle. That is a `WaitFor` over a `DurableDeferred`, resolved by the previous run's `chat/Settle`. Both the settle and the turn check run under the conversation's ask lock, so no signal is missed. A failed answer counts as settled.
- `chat/LoadHistory` takes only exchanges below the question's `position`.
- A replay of a question whose answer failed doesn't answer again.

## 4. Answer streaming: row updates or Durable Streams

| | Row updates through Electric | Durable Streams |
|---|---|---|
| Truth | Postgres only | the stream is the session's truth ([6], [7]), or a second log beside Postgres |
| Offline and reload | covered by the persisted `messages` | a second client store that TanStack persistence doesn't cover |
| Cost | the whole `text` column per update, O(n²). At HOST-PLAN's ≤1/s, an 8 KB answer is about 20 updates, about 80 KB per watcher | O(n) appends, token-smooth |
| Host | Electric 1.8, already running | Electric Cloud, or `@durable-streams/server-cloudflare` 0.1.1 (one release, Aug 2026) |

**Decision: keep row updates.** The engine already seals the model's events, so a stream would hold a third copy of the tokens and a second truth. The client doesn't depend on the write cadence; `pnpm bench` measures WAL bytes, fan-out and time to first text.

**Revisit when** watchers need token-smooth text, or presence and typing exceed about one write per second per person. Then add a stream for ephemeral deltas only, keyed by answer id. The settled row stays the truth.

## 5. Multiplayer prompting and collaborative editing

**Prompting together** (later; no change to this design):
- A `conversations` table and `messages.conversation_id`, with one shape per conversation (`where conversation_id = $1`). Electric's optimized clauses hold about 5,000 changes/s at any shape count ([5]).
- `author_id`, null while signed out.
- **Steer and cancel** become outbox mutations (`steer`, `cancel`), idempotent by client id. The running `chat/Answer` reads them between model turns as flow signals targeting its run id. Until `cancel` exists, a queued question can't be removed while it is being sent; one not being sent can be taken back with Edit (`Outbox.withdraw`, 2026-10-20).
- The turn wait is already the queue several people need.
- Presence and typing are ephemeral TTL rows, never outbox entries.

**Files:**
- One Yjs document per file, through `@electric-sql/y-electric` 0.1.54: `ydoc_updates(doc_id, op bytea)` and `ydoc_awareness` in Postgres, one shape per document, writes appended by a flow step ([8]).
- Yjs updates commute and tolerate duplicates. y-electric resends from the stable state vector and y-indexeddb keeps edits offline, so a CRDT needs no outbox.
- Compaction keeps a checkpoint and runs as a write-flow step every N updates, never as a sweep.
- The first mutable shared record that isn't text gets `Keep mine` and `Use latest`.

**Why nothing blocks this:** the same truth, transport, device store and outbox, with new mutation names, through generic wrappers. Moving from the single global shape to one per conversation costs one fresh sync, through `schemaVersion`.

## 6. The Effect wrappers' new surface

**`@smthrs/effect-tanstack-db`.** The TanStack libraries are optional peers, and host factories arrive as arguments, so the root import runs in a browser, a Worker, Node and Bun.

```ts
Persistence.layer({ open: Effect<SQLiteDatabase, PersistenceUnavailable>,     // OPFS in a tab, a file in Node tests
                    make: (db) => PersistedCollectionPersistence,            // createBrowser… / createNode…Persistence
                    coordinator?: () => PersistedCollectionCoordinator })    // BrowserCollectionCoordinator in tabs
  : Layer<Persistence, PersistenceUnavailable>                               // closes the coordinator, then the database
Collection.persisted(schema, { id, getKey, schemaVersion })                  // local, persisted (needs Persistence)
Collection.make(schema, options, { persist?: { schemaVersion } })            // wraps persistedCollectionOptions
Outbox.layer({ start: typeof startOfflineExecutor, collections, leader: Outbox.Leader, storage?: Outbox.Storage,
               mutations: Record<string, (p: { rows, idempotencyKey }) => Effect<void, Outbox.Refused | Outbox.Retry, R>> })
Outbox.lockLeader({ lock, name })  // over a lock service (WebLock): queued request; `take` steals; re-queue when stolen
interface Outbox {
  transact(name, ids: { id, idempotencyKey }, mutate: () => void): Effect<Transaction, NotAdmitted>  // sync
  admitted(tx): Effect<void, NotAdmitted>   // the IndexedDB write; distinct from settlement
  readonly status: Stream<{ leader: boolean; durable: boolean; failing: null | "network" | "server" }>
  readonly retryNow: Effect<void>           // the online detector's notifyOnline()
}
```

- **Errors:** `Refused` becomes `NonRetriableError`, `Retry` an error named `OutboxRetry`, and a defect is non-retriable and logged.
- **Tracing:** each attempt is a span `outbox.send {name, attempt, outcome}`, linked to the ask through the stored `spanContext`.
- **Metrics:** `outbox.attempts{name,outcome}`, `outbox.refused{status}`, `outbox.queued_ms`, `outbox.leader_changes` and `persistence.restore_ms`. None carries text.

**`@smthrs/effect-electric`:**
- `ElectricCollection.make({ …, persist: { schemaVersion } })` needs `Persistence`; its type allows `eager` and `progressive` only.
- `restored` waits for SQLite; `preload` waits for the network. `sync`, `reconnect`, `awaitTxId` and `awaitMatch` stay.
- **Deleted:** `syncMode: "on-demand"`, `internal/subset.ts`, `internal/keepOffset.ts` and ShapeProxy's `subset__*` policy, once the deletion test shows no consumer is left.

## 7. Test plan

**Unit (`pnpm test`).** Real Postgres and Electric, Node SQLite (`@tanstack/node-db-sqlite-persistence`), a real outbox over a Node `StorageAdapter`; the model is the only scripted seam.
- **Persistence:** survives close and reopen; the next session's first shape request carries the stored `offset` and `handle`; a `schemaVersion` bump refetches; a `must-refetch` never blanks the conversation.
- **Outbox:** a queued ask survives a new executor and is sent once. A POST delivered twice, or a leadership handoff mid-send, stores one row. 409 and 400 leave `unsent` and no `asking`. An aborted fetch and an error text containing "400" are retried. A failed admission leaves `unsent` with reason `not_admitted`. A streaming answer is never masked.
- **Machine:** `ask` shows its row inside the same `runSync`; no local read has a loading state; a burst of three is answered in order, each history holding the earlier answers.

**End to end (`pnpm e2e`).** Real browsers and stack, persistent profiles, `context.setOffline`, video for every test.
- **E1:** offline, ask two, reload offline (`Offline · 2`), online: two rows, answered in order.
- **E2:** relaunch the profile offline: restored, then sent on reconnect.
- **E3:** two tabs in one profile, offline. Ask in the newly focused tab, close the other, reconnect: one row, shown in both.
- **E4:** two devices ask offline and reconnect in reversed order: both stored, the same order on both, each answered.
- **E5 (conflict):** queue Q offline; the harness inserts a different row with Q's id into Postgres; online: `Not sent`, and Edit fills the composer.
- **E6:** offline mid-answer freezes the text; online, the full answer arrives.
- **E7:** with Electric stopped at boot, the conversation renders from OPFS and the pill shows.
- **E8:** Retry sends within 1 s.
- **E9:** kill the page after admission, before the POST: the ask is restored and sent once.
- **E9b (added 2026-10-20):** kill the page after ChatApi took the question, before the engine recorded its run: the page opened again sends it again and the agent answers (`e2e/local-first.spec.ts` "closed before its run started").
- **E3b (added 2026-10-20):** two tabs online: a question asked in the tab that didn't lead is answered with the other tab still open, and asking back in the first works too (`e2e/local-first.spec.ts` "two tabs").
- **E10:** a back/forward-cache restore reloads and shows the same state.
- **Conflicts (added 2026-10-20, Will: "I'd prefer to see all of them"):** `e2e/local-first-conflicts.spec.ts`, one test per class, on two devices or two tabs: one question id from two writers (E5, 409); one TODO dropped on two devices offline; two devices back in either order (E4); a duplicate send after a lost reply (200); a stale tab that leads again (`sent_elsewhere`); Edit taking a question out of another tab's outbox before it is sent; a new build refusing a parked answer (`payload_changed`); a device clock a day behind. Marked broken: Edit after ChatApi took a question the device hasn't seen arrive (both taken back and answered); a question taken back in one tab still `Queued` in the tab that led; and a clock stepping back between two offline asks (the next question shown twice, writes ordered by that clock). Still to come: access lost while offline (403). Not classes here: an edit against a delete (a stored message is never edited or deleted; Amend on a TODO is slice 2 of 0016), and a co-edited draft, until co-editing lands.

**No-spinner proof:**
- With every remote request held open, the shell, the conversation, the composer and a new ask render and stay interactive.
- In every e2e test, an init-script `MutationObserver` records any `[aria-busy=true]`, `[role=progressbar]` or Suspense fallback once a frame paints it; only `[data-answer=streaming]` and the router's navigation bar are allowed. Since [0020](0020-one-loading-pattern.md), every loading state stays unpainted for its first 300 ms, so one that ends sooner never counts.
- `pnpm bench`: input-to-row p95 under 50 ms; first frame from OPFS at 1k and 10k messages, p95 under 150 ms; drain time of 50 queued asks.

## 8. Migration and what is deleted

1. **Dependency change** (see Consequences), alone at the bottom of the stack; it lands 2026-10-25.
2. **Wrappers (§6) with tests** in `@smthrs/effect-tanstack-db` and `@smthrs/effect-electric`. Done 2026-10-19; `src/lib/collections.ts` is deleted.
3. **Server, with HOST-PLAN W5:** the turn wait and the history bound. The POST contract is unchanged.
4. **App:** `messages` becomes read-only, eager and persisted. Add `asking` with the outbox, `unsent`, the pill and the service worker. The composer stays enabled while an answer streams. Done 2026-10-20, with two changes the lead made on 2026-10-20: the outbox's leader is `Outbox.lockLeader` over `@smthrs/platform-browser`'s `WebLock`, and the device store stays on `@journeyapps/wa-sqlite`, the build the browser engine uses too. The lead first built the leader without steal, so a tab that didn't lead kept its question `Not sent` until the leading tab closed, against Will's answer 1; review P2-3 restored steal the same day (`lockLeader`'s `take`, §1 item 4).
5. **Docs and tests:** update [state.md](../state.md) and [chat.md](../features/chat.md), and add a status line in 0001 pointing here. In `e2e/local-first.spec.ts`, rewrite "offline ask", "flapping network" and "sync down while asking", which expect offline asks to fail. Done 2026-10-20.

**Deleted:**
- the `onInsert` on `messages`, the optimistic answer row and `QuestionNotTaken.unconfirmed`;
- `keepFailed`, `failures`, `asks`, `pendingQuery` and `PENDING_POSITION`, and `waitingQuery` with the streaming gate;
- `loadWindow`, `setWindow`, `WindowFailed`, `History.loading` and the Load earlier `loading` button;
- the `useLiveSuspenseQuery` gate, `AppLoading` (`aria-busy`), `AppLost` and `AppFailed`, and the `SYNC_LOST` and `COULD_NOT_OPEN` prose;
- on-demand subset sync and `keepOffset`.

## 9. Risks and open questions

| Risk | Recommended answer |
|---|---|
| Persisted collections are 0.x: a 7,000-line core with weekly releases | E3, E7, E10 and a 10-tab soak in CI. Without OPFS, reads fall back to memory; the IndexedDB outbox still keeps asks |
| offline-transactions 1.1.3: followers are online-only; `WebLocksLeader` never queues, so no tab takes over when the leader leaves; the `AbortError` and substring retry rules | `Outbox.lockLeader` with `take`, no online-only path, error mapping and regression tests; file both issues with TanStack |
| Eager first open of a long conversation | Accept it at chat sizes; switch to `progressive` if first open takes over 1 s at 10k messages |
| Storage eviction (Safari clears script storage after 7 days without use) | Call `navigator.storage.persist()` at boot and record the grant as a metric |
| An app update while asks are queued | Stable mutation names, collection ids and row `v`; a test queues on build N and sends from build N+1. Since 2026-10-20, every stored collection and outbox payload declares its versions and migrations, and the new build brings them forward before it reads them ([0021](0021-local-first-migrations.md)) |
| Text kept on the device | Fine while signed out. With auth, one database per account, wiped on sign-out |
| Abuse of the open, signed-out endpoint | Existing input bounds, plus per-conversation admission limits in the flow |

**Will's answers (2026-10-19):**
1. **The composer always sends.** Messages queue the way Claude Code and Codex queue, and Smithers answers them in turn.
2. **Each device stores its whole conversation,** so reading works offline. A size limit with LRU eviction is deferred: see the TODO list.
3. **The new TanStack packages land now,** under Will's same-day exception, recorded in `pnpm-workspace.yaml` until 2026-10-26.

## File-tab completion (2026-10-23)

File-tab actions await the local collection transaction's `persisted` receipt while
holding the store's write permit, before navigation or a successful flow reply.
An optimistic deletion is insufficient: reloading before SQLite commits can restore
the closed tab. The repository-view follower handles a failed persistence receipt
per event and keeps listening; explicit actions fail without navigating. The SDK
already logs and counts the refused write. No new storage or schema is introduced.
The real-SQLite regressions live in `src/features/files/persistence.test.ts` and
`src/features/files/files.test.ts`.

## Sources

[1] https://github.com/TanStack/db/blob/main/docs/guides/sqlite-persistence.md, and the browser package README at 0.2.36 · [2] https://github.com/TanStack/db/blob/main/docs/guides/offline-transactions.md, and `OfflineExecutor.ts`, `coordination/WebLocksLeader.ts`, `retry/RetryPolicy.ts` and `executor/TransactionExecutor.ts` in the 1.1.3 tarball · [3] https://github.com/TanStack/db/blob/main/docs/guides/mutations.md · [4] https://electric.ax/docs/guides/writes · [5] https://electric.ax/docs/guides/shapes · [6] https://electric.ax/blog/2026/01/12/durable-sessions-for-collaborative-ai · [7] https://electric.ax/blog/2026/03/26/stream-db · [8] https://github.com/electric-sql/electric/tree/main/packages/y-electric (README at 0.1.54) · [9] https://doc.replicache.dev/concepts/how-it-works · [HOST-PLAN] the lead's durable-answering plan, 2026-10-19.

## Issue-create admission correction (2026-10-27)

The button records a recoverable receipt containing the write identity and payload before asking the device outbox to admit it. Create returns after local admission, with network delivery independent of the initiating tab and its engine startup. The public flow joins the admitted write under the same derived id. A reload during admission retains Not sent and Retry; a retry keeps that id. This uses the existing outbox and device collections, without an application retry loop.

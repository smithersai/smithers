---
title: "The durable browser engine"
description: "How one dedicated worker per origin runs the durable flow engine over SQLite in OPFS, how tabs elect it and reach it, and how a new leader resumes runs."
---

The durable engine is the same `@smthrs/flows` composition the Node, Bun and
Cloudflare hosts build: `Runtime.layer` over the journal, run, attempt and
cache stores, with retries, durable timers, waits and replay. In a browser,
`BrowserRuntime` hosts it in a dedicated Web Worker and keeps its store in
SQLite on the origin private file system.

## Why a dedicated worker

| Need                                   | Dedicated worker                                               | Service worker                      |
| -------------------------------------- | -------------------------------------------------------------- | ----------------------------------- |
| Fast SQLite on OPFS                    | yes: `createSyncAccessHandle` exists only in dedicated workers | no synchronous access handle        |
| Stays alive while a model call streams | yes, as long as its tab is open                                | stopped after about 30 seconds idle |
| One engine across tabs                 | through a Web Lock                                             | one instance, but stopped when idle |

`BrowserSqlite.layerSqlite` loads `@journeyapps/wa-sqlite`'s synchronous build
and opens its access-handle pool VFS, and `BrowserSqlite.layer` opens the
database on it. Each database keeps its writes in a write-ahead log under an
exclusive lock (`locking_mode = EXCLUSIVE`, `journal_mode = WAL`,
`synchronous = FULL`): the pool has no shared memory, and its one worker opens
each file once. Every commit appends to the log and flushes it, so a recorded
step survives a killed browser, at a third of the rollback journal's cost per
transaction. A build from before the write-ahead log (1.0.0-rc.16 and earlier)
cannot open a database left in write-ahead mode; its worker runs on memory
until a newer build serves the device.

The worker hands the build over as lazy imports, and `BrowserRuntime` imports
the engine itself only when a worker builds one. A waiting worker loads
neither, and a tab that imports the package's root for `BrowserEngine` or
`SharedSqlite` loads no engine module and no wasm.

## One leader per origin

Every tab starts its own worker, and every worker asks for the exclusive Web
Lock named after the engine. The worker that holds it is the leader: only it
opens the store and builds the engine. The others wait in the lock's queue,
having opened nothing.

A browser releases a lock when the context holding it ends, so when the
leader's tab closes or crashes, the next worker in the queue gets the lock.
It then:

1. Opens the store. If the old worker's OPFS access handles are not released
   yet, it opens the pool again for up to about five seconds.
2. Builds the engine and registers the flows. Registration re-arms every
   durable timer, so a sleep that came due while no tab was open fires now.
3. Drives every unfinished run once, in the background, two at a time (see
   [Resumed runs wait their turn](#resumed-runs-wait-their-turn)). A run the
   old leader held is taken without waiting, because the engine's liveness check,
   `@smthrs/run-store`'s `Ownership.singleIncarnationLiveness`, declares every
   other incarnation of the same engine dead: only the lock holder runs, and the
   old one no longer holds the lock. Without that answer the engine would wait
   out the old owner's 30-second lease.
4. Posts `Leader` on the engine's channel.

From then on the engine sweeps its own store once a second, as on a server, so
timers fire and stalled runs are reclaimed while the tab stays open.

### Resumed runs wait their turn

The engine has one connection to its store, and one run costs it about 100 ms
of SQL and engine work from admission to settlement (`pnpm bench`, over the
in-memory OPFS). An engine that resumed every unfinished run at once would make
a run a tab starts next queue behind all of them: with 60 runs resumed
together, a newly started three-step run reached its first step after 447 ms
and settled after 2.8 s. A page cut off with that many runs, as a branch page
with one summary run per conversation entry was, showed its conversation
seconds late.

So the leader's engine resumes runs two at a time (`@smthrs/engine-store`
`EngineStore.Options.resumeConcurrency`, its
[resume lane](../../../engine-store/docs/api.md#resume-lane)), and a tab never
waits for that backlog:

- **A run a tab starts goes ahead.** `BrowserEngine.start` drives the run at
  once; it shares the connection with at most two resumed runs. With the same
  60 runs waiting, it reached its first step after 60 ms and settled after
  133 ms.
- **A run a tab asks for again goes ahead too.** Starting a run that still
  waits its turn, with the execution id it had, drives it at once. A tab that
  waits on a run the old leader was cut off in starts it again rather than only
  waiting for its result. A signal to a waiting run, or `BrowserEngine.cancel`
  of one, drives it at once as well.
- **Every resumed run still runs once.** The backlog drains in the background,
  two runs at a time, and each run resumes at the step it was in. The
  leader's first drive and the engine's own sweep, which reclaims released
  runs and runs whose lease lapsed, share the same two turns.
- **A turn lasts until the run settles or parks.** A resumed run inside a long
  step, such as a model call, keeps its turn for as long as the step takes, so
  two of them hold the rest of the backlog back until one ends. A run that
  parks on a timer or a signal gives its turn up.

Another context can take the lock with `WebLock.hold(name, { steal: true })`.
The leader whose lock is stolen stops leading at once, closing its engine and
store, logs `browser.runtime.lost`, and waits for the lock again. Lock loss
also interrupts unfinished engine initialization and database preparation.

## A tab whose worker fails

A tab whose own worker fails cannot lead, so it does not wait for a leader
that may never come. The worker fails when it throws, as when its module fails
to load, which the tab sees as the worker's `error` event, or when it cannot
build the engine, as without OPFS, which the worker tells its tab in a message
before it stops. Every request the tab is waiting on then fails with `EngineUnavailable`, whose `reason` is `worker-failed` or
`engine-failed`, and `BrowserEngine.unavailable` completes with it, so the app
can show the failure instead of hanging. A new leader announcement restores
requests from this tab, even though its own worker stopped. OPFS handles still
held by a previous worker are retried through Effect resource acquisition until
released or cancelled, rather than permanently stopping the worker.

## The app's shared database

The leader also opens the app's own database, `app.db`, beside `engine.db` in
the same pool, on a connection of its own, and runs every tab's
`SharedSqlite.execute` on it, over the channel `<name>/sql`. An app that keeps
TanStack DB collections on the device hands that database to TanStack's
browser persistence, so it loads one SQLite build and opens one pool.

- A tab sends one statement at a time, and the leader runs each request once.
- A transaction is one tab's from the statement that opens it to the one that
  ends it, by SQLite's own autocommit flag. Another tab's statement waits, so
  it never runs inside the transaction or reads what it has not committed.
  If abandonment cannot roll back the transaction, the connection fails closed:
  abandonment fails and waiting statements fail instead of hanging. The failure
  logs `browser.runtime.statement` and counts `statements` with outcome
  `abandon_failed`, without SQL or user content.
- Each tab holds a Web Lock of its own while it lives. When a tab ends with a
  transaction open, the leader takes that lock and rolls the transaction back.
- A transaction open when the leader's tab closes ends with that connection.
  Its tab runs the transaction's statements again on the new leader, in
  order, and carries on if each returns the rows it returned before, so the
  handover is invisible to the caller. If one returns other rows, because
  another tab wrote in between, the tab rolls the transaction back and the
  statement fails with a `ConnectionError`.
- Every change a request commits carries the request's receipt, in the same
  SQLite transaction, in the table `shared_sqlite_commits`. A transaction a
  request opens is receipted at once, inside it, and again after a rollback
  to a savepoint takes the receipt. A write outside a transaction would
  commit on its own, so SQLite's commit hook refuses it and the leader runs
  the request again inside a transaction it opens with the receipt: all of
  the request commits, or none of it. The hook also refuses a commit before a
  request's last statement, so a request commits at most once. A read commits
  nothing and pays for no receipt. The rows a committed request returned are
  kept beside its receipt, in `shared_sqlite_replies`. A tab's statement may
  not change either table, hang a trigger or an index on it, create a table
  or view by its name, or set `PRAGMA writable_schema`: SQLite's authorizer
  refuses it, and the leader names them as `main.` tables.
- So a handover never runs a committed request twice. A statement that
  committed a transaction just as the old leader ended is answered as
  committed by the new one when the receipt names the request that opened
  the transaction. A tab's first request to the new leader, outside a
  transaction, is answered as committed when the receipt names it. Either is
  answered with the rows it returned.
- A tab can send a request again only while it lives, holding its Web Lock,
  so a receipt is kept, however old, until the tab's lock comes free; then
  the leader deletes it and its reply.
- The receipt fails closed. A leader that can't write it rolls the change
  back, and the request fails with `TransactionUnrecorded`. A leader that
  can't read whether an earlier leader committed a request commits nothing of
  it: a write fails with `TransactionUndecided`, a read still runs, and a
  statement of a transaction the old leader held fails the same way, so the
  tab's next statement asks again. A leader that can't create the table still
  runs reads.
- A statement that fails after it opened a transaction, such as
  `BEGIN; <refused>`, leaves that transaction open and the tab's: the reply
  says so, and the leader rolls it back if the tab ends.
- A request that writes outside a transaction and opens one of its own, such
  as `INSERT ...; BEGIN`, fails as a nested `BEGIN` does, and one that commits
  before its last statement, such as `BEGIN; ...; COMMIT; SELECT ...`, fails
  with `TransactionUnrecorded`. Send them apart.

## Preparing the app's database before any tab reads it

`BrowserRuntime.run({ prepare })` gives the leader work to do on `app.db`
before it answers any tab's statement, such as bringing the app's stores to
this build's versions (`@smthrs/effect-tanstack-db`'s
`Migrations.prepare(registry)`). After it wakes unfinished runs, the leader
runs `prepare.run` over its own connection as the durable flow
`device/prepare`, execution `device/prepare/<epoch>`, and waits for it; a
tab's statement waits meanwhile.

- **Once per epoch.** The next leader of the same build finds the run
  finished and goes on at once; a build with a new `epoch` prepares again.
- **Resumable.** A leader that dies mid-way leaves the run unfinished, and the
  next leader runs the step again. A transaction the step left open ends with
  the old connection, and the step rolls back any transaction it leaves open.
- **Fails closed.** The step is tried three times, 200 ms apart, then 400 ms.
  If it still fails, the leader logs `browser.runtime.prepare` with
  `outcome: failed` and the failure's tag, and refuses every tab's statement,
  read or write, with `PrepareFailed` (counted as `statements` with
  `outcome: fenced`): nothing runs on a database this build could not bring to
  its versions. A tab's statement fails with a `ConnectionError` whose `cause`
  names `PrepareFailed`, so `SharedSqlite.open` rejects and the app keeps its
  rows in memory. The failed run is the epoch's answer, so the fence holds for
  every leader of that build; the next build's epoch prepares again.
- An engine without the app's database, such as `BrowserRuntime.layer`'s,
  skips it (`outcome: skipped`).

## Checking the app's database before the engine starts

`BrowserRuntime.run({ authorize })` gives the worker a check to run on
`app.db` each time it is about to lead, before it builds the engine. The app
decides what it checks, such as whether the stored data belongs to the person
signed in.

- **Before anything runs.** No run resumes, no flow registers and no tab's
  statement runs until the check succeeds.
- **Every activation.** Unlike `prepare`, the check is never recorded as
  done: each new leader runs it again.
- **Fails closed.** A failure ends the activation as an engine that cannot be
  built does: the worker logs `browser.runtime.stopped` and tells its tab
  `EngineStopped`.
- **Leaves nothing open.** A transaction the check opens is rolled back
  before the engine is built.
- **Checks again later.** The `database` a successful check was given stays
  usable while that activation serves, so the worker can check again without
  restarting the engine, such as to record a new owner once its person signs
  in. Each such statement commits on its own.

## Tabs reach the leader over a channel

A tab never talks to the engine directly, not even its own worker. It posts
requests on the engine's `BroadcastChannel`, under its own client id and a
request number, and only the leader answers. On `Leader`, every tab posts its
unanswered requests again. That is safe because every request is idempotent:
starting an execution id twice admits it once, a poll reads, a cancellation
and a signal record the first answer.

A start carries the door and actor kind the tab started it with, read from
the caller's `RunMetrics.CurrentOrigin` (`@smthrs/flow`). The leader admits the
run under it, so the run's usage metrics (`flows_runs_started`,
`flows_runs_settled` and the `flow.run.*` log lines, placement `browser`) say
how it started.

The leader also posts the execution id and event type of every event its
engine commits. `BrowserEngine.result` waits on those rather than on a timer:
it polls once, then again after each event for its execution and after each
new leader.

Each port holds at most 10,000 messages its subscriber has not taken
(`TabChannel.defaultCapacity`). A subscriber that falls that far behind is
ended, never dropped from silently: after what it holds it fails with
`TabChannelOverflow`, and the channel logs `browser.tab_channel.overflow` and
counts `smithers_browser_tab_channel_overflows` by channel. A leader that falls
behind stops leading, logs `browser.runtime.lost` with `reason: overflow`, and
waits for the lock again; whichever worker leads next announces itself, and
tabs send it what went unanswered. A tab that falls behind hears no answer
again: its `SharedSqlite` fails every statement with a `ConnectionError` naming
`TabChannelOverflow` and lets go of its Web Lock, so the leader rolls back a
transaction it left open and other tabs carry on, and its `BrowserEngine`
becomes unavailable with reason `channel-overflow`, until it reloads.

Payloads, values and results cross the channel as JSON, encoded and decoded
with the flow's own schemas. The channel is open to every script of the
origin, which is the app's own trust boundary; the leader runs only the flows
it was given, and only with a payload their schema decodes.

## Tabs read runs through the leader

A run page reads the engine's runs the same way: `BrowserEngine.inspect(runId,
{ afterSeq, limit })` posts `Inspect`, and `BrowserEngine.list({ limit,
cursor, roots })` posts `List`. Neither names a flow. The leader answers from
its engine's `RunInspection` (`@smthrs/engine-store`), so every value is
redacted and cut to 16 KiB before it reaches the channel, and a failure travels
as its closed code. `inspect` returns the run, its steps with their attempts,
the runs it started and one page of its journal; page on by passing the
reply's `journal.nextSeq` as `afterSeq`. A run the engine never held is
refused with `@smthrs/engine-store/RunNotFound`. The tab decodes each reply with
a declaration of its own, so a tab bundle never loads `@smthrs/engine-store`.

The engine host gives every registered flow `RunInspection` as well, so a flow
running in the engine, such as one that retries another run, can read it. The
reads know the flows `BrowserRuntime.run` serves, and each action their plans
call, so a `Schema.Redacted` value in a run's input or result, a step's output
or a journal preview reads as `<redacted>`, and a value its schema no longer
decodes as `<withheld>`.

## Observability

Every operation is logged, traced and counted with ids, counts and error tags,
never content:

| Signal                                                                | Where                                                                                                                           |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `browser.runtime.elect` span                                          | the wait for the lock                                                                                                           |
| `smithers_browser_runtime_leaderships`, `browser.runtime.leader`      | each worker that becomes leader                                                                                                 |
| `smithers_browser_runtime_wakes`, `browser.runtime.wake` span and log | each unfinished run a new leader finds, by outcome                                                                              |
| `smithers_browser_runtime_requests`, `browser.runtime.request` span   | each request the leader answers, by request and outcome                                                                         |
| `smithers_browser_engine_requests`, `browser.engine.request` span     | each request a tab sends                                                                                                        |
| `run.inspect` span and log                                            | each `Inspect` the leader reads: host `local`, outcome (`read`, `not_found`, `failed`), events, bytes, clipped values, duration |
| `smithers_browser_engine_storage`, `browser.engine.storage`           | whether the origin holds persistent storage                                                                                     |
| `smithers_browser_runtime_statements`, `browser.runtime.statement`    | each shared-database statement, by outcome                                                                                      |
| `smithers_browser_runtime_preparations`, `browser.runtime.prepare`    | each preparation a new leader ran, by outcome (`prepared`, `failed`, `skipped`), with the epoch and a failure's tag             |
| `smithers_browser_engine_unavailable`, `browser.engine.unavailable`   | a tab whose own worker failed, by reason                                                                                        |
| `browser.runtime.stopped`                                             | an engine that stopped                                                                                                          |
| `browser.runtime.lost`                                                | a leader whose lock another context stole                                                                                       |

The engine's own journal, run and attempt telemetry comes from `@smthrs/flows`
as on every host. A worker's records stay in the worker unless `run` gets a
`telemetry` layer, such as `Otlp.layerFetch` from `@smthrs/observability`,
which receives every log line, span and metric of the leader, the engine and
the flows it runs. The engine records many spans of its own, its store's
statements among them; an exporter's `spans` list keeps the ones you send.

```ts
BrowserRuntime.run({
  name: "smithers",
  sqlite,
  flows,
  registerFlows,
  telemetry: Otlp.layerFetch({
    baseUrl: `${self.location.origin}/api/telemetry`,
    serviceName: "engine",
    spans: ["browser.runtime.wake", "browser.runtime.request"]
  })
})
```

## Limits

- **All tabs closed pauses every run.** Nothing runs while no tab of the app is
  open. A flow that must run while every device is off belongs on Cloudflare or
  a sandbox.
- **Storage can be cleared.** Without persistent storage, a browser may clear
  the origin's OPFS under pressure, and Safari clears it after seven days
  without a visit. `BrowserEngine.layer` asks for persistent storage; the
  browser decides.
- **A run belongs to one browser profile.** Two profiles, or two devices, have
  two stores.

## Failure boundaries

Synchronous worker startup failures reach `BrowserEngine.unavailable` and its
request errors as `EngineUnavailable`. Runtime import and telemetry setup
failures send `EngineStopped` to the tab, with only the failure's tag or name.

Cancelling a shared SQLite caller stops waiting without discarding the accepted
statement's reply. The tab keeps processing that reply and recording transaction
ownership before sending the next statement. Closing the tab interrupts this
work and releases its ownership lock.

Language-server request deadlines cancel the worker's current request and its
workspace reads, so an unresolved read does not hold later requests. Interrupted
workspace and library loads discard their incomplete cache additions; a later
request reloads their imports and can finish project-wide references. Malformed
percent encoding in a file URI makes `pathOf` return `undefined`.

The worker composition imports its engine and leader statically. A bundled lazy
chunk that imports the worker entry back can evaluate that entry twice in WebKit,
creating two incompatible Effect Schema missing-value sentinels. Keep the worker
in one static module graph; the SQLite build remains lazy. Tree shaking removes
the unused worker composition from a tab importing BrowserEngine or SharedSqlite.

At an input boundary, `PendingSnapshot.make(storage, key)` can stage a pending
value synchronously in tab-scoped session storage. Restore with the consumer's
schema and acknowledge only after its durable write receipt. Acknowledging an
older token never removes a newer value. Clear snapshots when their owner signs
out; storage refusal returns no snapshot without failing the input handler.

For private input, pass an owner callback as make's third argument. Unverified
owners cannot stage or restore a snapshot; a changed owner cannot restore the
previous owner's input. The owner is part of the receipt, so an old receipt
cannot clear another owner's newer value.

A worker reopening offline must not fetch its own SQLite modules from the
network. Bundle the SQLite API, VFS and factory into the worker entry. Load the
immutable WASM URL with `BrowserCache.readAsset(url)` provided by
`BrowserCache.layerAssets()`: it reads the origin's existing PWA precache before
native fetch. WebKit worker fetch can bypass the document's service worker even
when its shell and WASM are cached. A cache refusal falls through to the network;
network, HTTP and body failures are typed without URLs or content. Reads log,
trace and count their source and outcome, including cancellation.

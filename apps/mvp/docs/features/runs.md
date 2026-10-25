# Runs

Every flow this device runs is a run of its durable engine. `/app/runs` lists them, and a run's page shows what it did: its steps with each one's input and output, its timeline and its journal, with Stop, Retry and Resume. A TODO's run on Cloudflare has the same page, live ([a run on Cloudflare](#a-run-on-cloudflare)). Decision: [0014](../decisions/0014-flows-authoring-debugging-and-home-view.md) §3, §5 and §6.

## Where a run is read

```
/app/runs/<runId> ─ beforeLoad ─▶ openRun ─▶ BrowserEngine.inspect(runId, { limit: 500 })
   the leader tab's engine worker ─▶ RunInspection (@smthrs/engine-store) over SQLite on OPFS
   every value: Redaction, Schema.Redacted as <redacted>, a value its schema won't read as <withheld>, cut at 16 KiB
BrowserEngine.events ─ debounced 200 ms ─▶ the open run, and the list while it shows, read again
```

- **The engine holds the journal.** No journal is copied into Postgres: the page reads this device's engine through `BrowserEngine.inspect` and `list`, which `@smthrs/platform-browser` answers from the leader's `RunInspection`. A run the engine doesn't hold reads `On another device`; an engine that can't be reached, `Couldn't read this run`.
- **Values are content.** The leader releases every value through `@smthrs/journal`'s `Redaction`, renders it through its flow's or step's own schema so a `Schema.Redacted` value reads as `<redacted>` at any depth, withholds one its schema no longer decodes (`<withheld>`), reduces a failure to its closed code, and cuts it to 16 KiB. The page shows values as text, collapsed. The engine records no input for an action step; a child run's input is its step's input.
- **Live.** Every event the leader commits reads the open run, and the list while it shows, again, at most once per 200 ms. Nothing polls.
- **Not built in this slice:** runs of other devices, and of Cloudflare beyond a TODO's and a repository's ([a run on Cloudflare](#a-run-on-cloudflare), [a repository's runs](actions.md)); the read-only scrubber, and Answer in place: a run waiting on a person links to the conversation, where the agent's question is (decision 0015).

## A run on Cloudflare

A TODO's `todo` run works on Cloudflare, not on any device ([the run](todos.md#the-run)). While it runs, its TODO links to its page, `/app/runs/todo:<attempt id>`, and the page reads it from there: a person watches the agent work, live (ruling TODO-3, decision [0026](../decisions/0026-watching-a-todo-run.md)).

```
/app/runs/todo:<attempt> ─ beforeLoad ─▶ openRun ─▶ RemoteRunsClient.inspect ─▶ GET /api/remote-runs/<run id>
   ChatApi: signed in, a Member or above, a TODO's attempt started this run ─▶ RunInspection (@smthrs/engine-store)
   over the engine's schema, smithers_flows, read-only ─▶ the same read a device's engine answers its run page with
openRun ─▶ follow ─▶ Electric: GET /api/shapes/remote-runs?run=<run id> ─▶ smithers_flows.flows_run_changes, the run's row
   its revision moves on run-row writes; journal inserts also advance it at most once per 2 s per run
   each change, at most once per 200 ms, while the page shows it ─▶ the run read again
```

- **Which runs.** A run whose id is a TODO's, `todo:<attempt id>` (`isRemoteRun`), reads from Cloudflare; every other run from this device's engine. The routes serve only a run some TODO's attempt started (`todo_attempts`), to a signed-in Member or above, as the TODO itself ([who reads](todos.md#who-reads-who-writes)).
- **The same read.** ChatApi's read is the engine's own `RunInspection` over the engine's Postgres schema, through a read-only client (`ExecutionHost.readDatabase`): every value redacted, rendered through its flow's or step's schema (`<redacted>`, `<withheld>`), a failure reduced to its code, cut to 16 KiB. The browser decodes it with the engine's wire shape (`BrowserEngine.Inspection`), so the page, its steps, timeline and journal, is the one a device's run gets. The agent's model turns and sandbox calls inside one `todo/Implement` attempt are journal trail entries, not inner engine attempts.
- **Live, with no polling.** The engine keeps a change feed, `flows_run_changes`: one row per run whose revision moves whenever the run's row is written. Run-store migration 1005 also touches the run from journal inserts, durable or lossy, at most once per two seconds per run; the feed therefore moves during one long action attempt. Other run state changes advance it immediately. The tab follows the run's row through Electric, as it follows every synced table, and reads the run again on each change. A settled run changes no more, so nothing reads it again. Electric sets the table's `REPLICA IDENTITY FULL` itself, as the owner of the engine's tables.
- **What it shows.** Its header says `Cloud` where a device's says `This device`, and it offers no acts but Steer ([steering](#steering)): Stop, Retry and Resume run on this device's engine. A TODO's run stops when its TODO is dropped. Until the engine begins a run its TODO started, the page reads `Not started`; a run no TODO started, or one this person may not read, `Not found`. It is never one of this device's runs, so the list doesn't show it.

### Routes

`worker/RemoteRuns.ts`; ChatApi routes these paths to it.

| Route | Answers |
|---|---|
| `GET /api/remote-runs/<run id>?afterSeq=<n>&limit=<n>` | `200` the run as `RunInspection` reads it: the page of its journal after `afterSeq` (`-1` unless set), at most `limit` events (1 to 500, 500 unless set). Never cached |
| `GET /api/shapes/remote-runs?run=<run id>` | the run's row of `flows_run_changes`: `run_id`, `revision`. Signed out `401`; not a Member, or a run no TODO started, `403`; sessions or Postgres unreadable `503` |

The read's refusals are `{ code }`, `Cache-Control: no-store`:

| Status | `code` | When |
|---|---|---|
| 400 | `invalid` | `afterSeq` below `-1`, or `limit` outside 1 to 500, or either not a whole number |
| 401 | `authentication` | signed out |
| 403 | `forbidden` | not a Member |
| 404 | `not_found` | no TODO's attempt started this run |
| 404 | `not_started` | its attempt is recorded and the engine hasn't begun it |
| 503 | `unavailable` | sessions, Postgres or the engine couldn't answer; `Retry-After: 5` |

## Steering

While a TODO's agent works, a Member sends it a message from the run's page, and the agent reads it at its next turn (ruling TODO-3, decision [0026](../decisions/0026-watching-a-todo-run.md) §6). The message is the run's own: it lives in the run's durable notification queue (`@smthrs/notifications`), in the engine's journal, never in the app's tables.

```
run page ─ Steer ─▶ run/steer { runId, body } (client flow, door composer; the agent may call it too, ruling FLOW-3)
   run/steer/queue: id = UUIDv5(execution id) ─▶ the tab that asked ─▶ the device's outbox, mutation run-steer (Sending)
   outbox ─▶ POST /api/remote-runs/<run id>/steers { id, body } ─▶ ChatApi (worker/RemoteRuns.ts)
      a Member or above; the run a TODO's attempt; it and its todo/Implement step not ended
      NotificationQueue.admit(run id, Notification.humanSteer(...)) over the engine's journal in smithers_flows   (Sent)
todo run's agent (worker/flows/TodoAgent.ts) ─ at each turn boundary ─▶ Notifications.layerForExecution drains the
   queue of the execution it works in, keyed by its agent session ─▶ the message is a user message of its next model
   request; the queue journals flows/notifications/Promoted ─▶ that turn acts (a cell call, or its answer)   (Delivered)
run page ─▶ the run's journal: Admitted (who, what), Promoted (when), the turn's act ─▶ Next step selects its step
```

- **When.** The composer shows on a TODO's run until the run settles or its `todo/Implement` step ends, and the route admits a message only then (`steerable`, `src/features/runs/contract.ts`). A message reaches the agent at its next turn boundary: a turn already in flight, such as a long `sandbox/run`, finishes first. One the agent never read, because it ended first, reads `Not delivered`.
- **Once.** Admission and the check that the run still accepts steers share one engine writer transaction. An already admitted message returns its original receipt even after the run ends. The message's id is its `run/steer` run's, so a step run again or an outbox resend names the same message; the queue admits an id once, and refuses the same id with other words (`409 conflict`). A replayed turn delivers what its first drain delivered. Each drain is keyed by the agent session as well as the boundary, so a retry or a correction of the agent's step, which numbers its turns from the start again, drains afresh rather than being handed an earlier session's drain. A run holds at most 128 unread messages; the outbox sends the next one again once the agent reads some.
- **Who.** A Member or above, in person or through an agent acting for them. The agent's steer goes from the tab with its run's credential and without the person's session (decision 0017 slice 0), so ChatApi reads it as the agent's, for the person; a run with no credential to send queues nothing. The run's model reads it as `[notification <id> from person:<id> at todo:<attempt> turn 0 attribution {"login":…,"via":…}]`, then a line saying it is a newer instruction from this person that wins where it conflicts with earlier ones, the TODO's included, then the words. The eval `evals/todo-steer.eval.ts` holds the real model to that.
- **States.** `Sending` (in the outbox), `Sent` (taken; then the run's journal holds it), `Delivered` (the queue handed it to a turn, and that turn acted: the journal records a cell call after it, or the agent's answer), `Not delivered` (the agent ended first), and `Not sent` with why: `The agent finished`, `Sent before`, `Too long`, `Members only`. A Not sent message is kept on the device (`steer-sent`), so a reload still shows its words. Delivered offers `Next step`, which selects the agent's first step after it: its response.
- **Live.** The sender sees a message at once. Another Member's page shows it at the run's next step, since admitting it writes the run's journal, not the run's row the page follows; a long tool call delays that.

| Route | Answers |
|---|---|
| `POST /api/remote-runs/<run id>/steers { id, body }` | `202 { id, seq }` taken; `200` the same for an id it has. `id` is a UUID, `body` 1 to 4,000 characters, not blank, at most 12 KiB as JSON. Never cached |

| Status | `code` | When |
|---|---|---|
| 400 | `invalid` | the body isn't `{ id, body }`, the id isn't a UUID, or the message is blank |
| 401 | `authentication` | signed out |
| 403 | `forbidden` | not a Member |
| 404 | `not_found` | no TODO's attempt started this run |
| 409 | `not_working` | the engine hasn't begun the run, or it or its agent's step has ended |
| 409 | `conflict` | the id was sent before with other words |
| 413 | `too_large` | over 4,000 characters or 12 KiB as JSON, or a body over 32 KiB |
| 429 | `full` | the run holds 128 unread messages |
| 503 | `unavailable` | sessions, Postgres or the engine couldn't answer; `Retry-After: 5` |

## Flows

Above the list, one line per flow on this device: its runs, the share of its settled runs that succeeded (`Success`), and the 95th percentile of their durations from admission to settlement (`p95`, `–` until one settles). Acts on runs (`run/*`) are left out. It reads the same `runs` collection the list does, the engine's newest 50 runs (`flowSummary`, `src/features/runs/summary.ts`). A completed `flow/new` round or `chat/Answer` can return failed work even when the engine completed it. The list keeps Success unknown until a person opens that run and its bounded result establishes `succeeded` or `failed`; after a failed detail read, the list row says `Failed`. The list read itself never waits for those results. Across devices and hosts, the engine's usage metrics count engine settlements ([flow usage](../observability.md#flow-usage)).

## The run page

| Part | What it shows |
|---|---|
| Header | The flow, its state in 0009's words (`Queued`, `Working`, `Waiting`, `Stopping`, `Stopped`, `Failed`, `Done`), the time it took, `This device`, and the acts |
| Input, Result | The run's payload and its answer |
| Steps | The plan's action calls and child boundaries, and the runs this run started (an agent's cell calls, a person's flow's pinned child), in the order they started. The selected one's input, output, attempts (`1 ✕ FlowsUnavailable · 2 ✓`) and wait; a child links to its own page |
| Timeline | One bar per step on a shared axis |
| Journal | Sequence, type and time of each event, its payload on demand, and More for the next 500 |

A Cloud TODO's engine can complete after settling the TODO as failed. A `flow/new` round or `chat/Answer` can likewise complete after recording failed work. In each case the header shows `Failed`, matching the work's result. A failed TODO's Retry action starts a fresh stack attempt.

An answer's debug info in the conversation opens its run's page, `/app/runs/<answer id>`, since an answer's id is its run's ([chat](chat.md#message-controls)).

The pure model of the page is `src/features/runs/page.ts`; the components come from `@smthrs/ui` (`RunHeader`, `SpanTree`, `SpanDetail`, `RunWaterfall`, `RunJournal`, `JsonValue`, `RunList`).

## Acts

Each act is a registered flow on this device's engine, model-invocable, so a person's button and the agent's cell run the same declaration (`src/features/runs/flows.ts`). A refusal is `RunActRefused { code }`, and the page says it in a line.

| Act | Shown | Does |
|---|---|---|
| `run/cancel { runId, seq, host? }` | Stop: while the run hasn't settled and no stop was asked | Records the cancellation and interrupts the run (`FlowRuntime.interrupt`). A run that settled meanwhile answers its final status, `{ outcome: "settled" }`; a `seq` past the run's journal is `stale`. With `host: "cloud"`, a repository's run, stopped on Cloudflare ([acts](actions.md#acts)) |
| `run/retry { runId, version }` | Retry, and Retry latest for a person's flow: once the run settled | Runs the same flow with the same payload as a new run of its own: `pinned` runs exactly what the run ran, and for a person's flow that is the flow id and revision its load pinned (read from its `flow/run/code` child, or the `flow/run/prompt` child of a run recorded before code ran in the realm), even when the run named no revision or the flow was deleted and its name went to another; `current` drops both and runs the latest. The act runs as `retry:<runId>:<n>`, the n-th retry from this device, and its new run is `<act>/run`, so a second press starts no second run. Its page opens. `not_settled`, and `not_retryable` for a flow only a person or the app starts (an answer, a draft's answers, a pinned child) or an act |
| `run/resume { runId, seq }` | Resume: while it waits, or runs and has recorded nothing for a minute | Drives it again (`FlowRuntime.resume`); a durable timer is never skipped. A run that moved since the page read it is `stale`; a settled one, `settled` |
| `run/list {}`, `run/inspect { runId }` | the agent | The newest runs, acts left out; one run's status, steps and result text |

`seq` is the run's last journal sequence the page read (`RunSummary.lastSeq`). Every act is refused `not_found` for a run this engine never held and `not_here` for a flow it doesn't run. A store that can't be read, or can't record a cancellation, fails the act's step instead, and the page says `Couldn't reach the engine.` A retried run, and a draft's next round, start without the step's `FlowInstance` in their context (`startRoot`, `src/features/runs/start.ts`), so the engine records no parent: each outlives the act that started it and lists among the person's runs.

## The browser

`src/features/runs/` follows the [state rules](../state.md): `RunsStore` holds the list (`runs`), each open run's read (`run-pages`) and the run view (`run-view`: the run shown, the step selected, the tab, an act in flight and why one was refused), all local collections; `Runs` binds them for frontends. The routes call `openList` and `openRun` ([navigation](navigation.md)); Stop, Retry and Resume dispatch through `FlowDispatch`, door `button`. Nothing is kept on the device: a reload reads the engine again.

## Observability

| Record | Kind | Fields |
|---|---|---|
| `run.inspect` | log, span (engine worker) | `host` (`local`), `outcome` (`read`, `not_found`, `failed`), `events`, `bytes`, `clipped`, `durationMs` |
| `run.read` | log (tab) | `act` (`run`, `list`), `outcome`, `events`, `durationMs` |
| `smithers_run_reads` | counter (tab) | `read`, `outcome` |
| `run.act` | log (engine worker) | `act` (`cancel`, `retry`, `resume`), `runId`, `outcome` (`requested`, `settled`, `retried`, `resumed`, or the refusal's code) |
| `smithers_run_acts` | counter | `act`, `host`, `outcome` |
| `run.inspect` | log, span (ChatApi, [a run on Cloudflare](#a-run-on-cloudflare)) | `host` (`remote`), `runId`, `outcome` (`read`, or the refusal's code), `events`, `bytes`, `clipped`, `status`, `durationMs`, `errorCode` |
| `smithers_remote_run_reads` | counter (ChatApi) | `outcome` |
| `runs.shape.remote`, `smithers_remote_run_shape_requests` | log, span; counter (ChatApi) | `status`, `live` |
| `run.steer`, `smithers_run_steers` | log, span; counter (ChatApi, [steering](#steering)) | `host` (`remote`), `runId`, `steerId`, `via` (`person`, `agent`), `outcome` (`taken`, `existing`, or the refusal's code), `bytes`, `status`, `durationMs`, `errorCode` |
| `runs.steer.queue`, `smithers_run_steers_queued` | log, span; counter (engine worker) | `steerId`, `runId`, `via`, `door`, `outcome` (`kept`, `not_kept`, `tab_gone`, `no_credential`), `durationMs` |
| `run.steer.send`, `smithers_run_steer_sends` | log, span; counter (tab) | `steerId`, `runId`, `outcome` (`taken`, `existing`, `retry`, `refused`), `status`, `code`, `durationMs` |

A read of a run on Cloudflare is the tab's `run.read` with `outcome` `read`, `not_found`, `not_started` or `unavailable`. No record carries a value of a run, nor a message to its agent.

## Tests

| Test | Proves |
|---|---|
| `packages/smithers/flows/engine-store/test/RunInspection.test.ts` | One read on SQLite and Postgres: redaction, the 16 KiB cut, no `Schema.Redacted` value at any depth (a sentinel), `<withheld>` for a value its schema won't read, closed failure codes, gap-free paging while the run appends, `RunNotFound`, and the list |
| `packages/smithers/flows/platform-browser/test/RunReads.test.ts` | `inspect` and `list` through the real worker protocol, the sentinel never on the wire |
| `src/features/runs/runs.test.ts` | Every act on the Node host's engine: Stop on a live run and on a settled one, a stale fence, Retry once per act, pinned (carrying the revision and flow id that ran) and current, every refusal, Resume of a run whose engine died, and runs of a flow the engine doesn't run |
| `src/features/runs/summary.test.ts` | The flows summary: runs, success over settled runs, p95 by nearest rank, no rate or p95 before a run settles, acts left out, the order |
| `src/features/runs/page.test.ts` | The steps, the selected step, the journal with More, the acts a run offers, and the list's rows; a run on Cloudflare's header, its empty states and no acts |
| `worker/RemoteRuns.test.ts` | Through the real handler, over a real engine on its own schema: a Member reads a TODO's run as `RunInspection` reads it, a page at a time, a `Redacted` sentinel never sent and a long value cut; every refusal; `503` when sessions, Postgres or the engine can't answer; the shape's table, filter and columns, its refusals, and a live request answered when the run's next step begins; records without values |
| `src/features/runs/planned.test.ts` | A flow shaped like the `todo` run, held mid-step on the real engine: the steps after it, which the engine schedules with the plan, read Queued and have no bar until they start; settled, every step is done |
| `src/features/runs/remote.test.ts` | A tab on ChatApi's real handler and Electric: a TODO's run reads `Not started`, then each step as the engine takes it, then done, read again only when its change-feed row moves; a Guest reads `Not found`. A Member steers it: the composer empties, the message goes through the device's engine, outbox and ChatApi into the run's queue and reads `Sent`, then `Not delivered` once the run ends; a later steer reads `Not sent` with `not_working` |
| `worker/RemoteRuns.test.ts` "steers" | The steer route over a real engine: a Member's message in the run's queue once as their steer, a resend answering the same, another message under its id `409 conflict`, an agent acting for a Member, every refusal, `not_working` once the run or its agent's step ended, `429 full` at 128, `503` when sessions, the app's database, the engine or its writer can't answer; a sentinel message in no record |
| `worker/flows/Todo.test.ts` "steer" | The `todo` run's real agent on the Node host's engine over Postgres: a steer admitted through a journal of its own while the agent's first turn is in flight reaches its second turn, once, and its words are in the merged README; the queue is empty after. Fails with the old empty steering source |
| `src/features/runs/steer.test.ts` | The page's fold of the run's journal and this device's messages into states; the composer's rule; the response step; which refusals are final; the steer step's id, the agent's door, a tab that won't keep it and none at all |
| `packages/smithers/agent/test/AgentActionSteering.test.ts` | `@smthrs/agent`'s action with `Agent.layerSandbox` and `Notifications.layerForExecution`: a message admitted while turn 1 streams is in turn 2 only, once; another execution's never arrives |
| `src/features/runs/store.test.ts` | The store's reads over a test engine and a test remote runs client: pages, More, refusals, the list, following events; a run on Cloudflare read from ChatApi with the runs it started, never this device's engine or list, and each of ChatApi's refusals as the page's state |
| `src/features/runs/api.test.ts` | The remote runs client against a local server: the route and its paging, a refusal's status and code, a body that isn't a run, a stalled body and nothing listening |
| `src/features/flows-ui/tab.test.ts` | The run page from a tab following a run to its answer, Retry opening the new run, the list, Stop, and Resume refused |
| `e2e/flow-usage.spec.ts` | In a real browser, no model or sign-in: the theme button runs `app/theme/set`, and the Runs page's flows summary counts it at 100% |
| `e2e/flows.spec.ts` | In a real browser: create a flow, run it, watch its run page, stop a run and retry it; open a drafted flow's code, run it, relabel its step, and run the edited code to Done in the QuickJS realm |

Run them with the compose Postgres and Electric up (`pnpm db:up`): `pnpm exec vitest run src/features/runs src/features/flows-ui`.

## Read-only graph (flows UI slice 1)

The Steps pane draws `FlowGraph` above `RunWaterfall`, with `StepInspector` beside it (below it on a phone). `JournalScrubber` selects a read-only journal prefix: graph states, output, attempts and timeline share that prefix. The Journal pane remains available. Arrow keys follow graph dependencies, `[` and `]` move by event, Shift with either moves by step boundary, `L` follows live, `i` or Enter opens the inspector and Escape closes it. Whole-run Stop, Retry, Retry latest and Resume retain their existing flows. No step retry is offered: Retry from here (ruling FLOW-11) is not built yet.

The app adapts redacted engine events through `@smthrs/gateway`'s `InspectionJournal`, then uses `RunTrace.monitorFromJournal`; there is no second state fold, table or engine event. Child calls are represented once as a boundary and link to their own run. A personal `flow/run` run uses its recorded input's flow name for its header and step labels; engine tags remain intact. Missing or clipped evidence never becomes invented data. Action inputs absent from the journal are left absent.

The public `@smthrs/ui` components accept data and callbacks and have no app registry, plugin name, or mutation dependency. Future `runs` and `flows` plugins can use them directly on decision 0017's public surface. Graph layout uses PLAN.md's small-DAG exception, because the library catalog contains no graph renderer and xyflow would introduce an independent node-state store.

The page loads descendant journals by execution identity and merges their recorded evidence through `inspectionForest`. No child is joined by its display name. Each child's steps link to its own run; agent cells become nested timeline rows and canonical waits become hatched rows. Replay freezes that read snapshot until Live, including when new children appear. Attempt settlement during replay requires prefix journal evidence, so events sharing a millisecond cannot disclose a later completion. Replay selection logs and counts mode and sequence only (`smithers_run_replay_selections`, `run.replay.select`); values never enter diagnostics.

Step logs join the engine's real `runId` and validated `stepKey` annotations to recorded dispatch digests, alongside the canonical agent-cell output. The evidence projection is memoized independently of the presentation clock. Live event batches refresh during a continuous stream; unchanged descendants and previously loaded journal tails are reused.

### Route timings

The browser relays `run.route.stage` logs and spans and the `smithers_run_route_ms`
histogram. A random, content-free `routeAttempt` groups a navigation's records without a run,
repository, URL, payload or credential. `stage` is `match`, `page` (the local
collection), `inspection` (each root, child or journal request), `changes` (each
live run subscription), `repo-runs` (the repository list subscription), or `render`
(the committed route frame). `phase` is `start`, `ready`, `rows` (first nonempty
collection batch), `loaded` (a repository list's rows restored and its first sync
answered or failed, with its row count), `failed`, or `reused` (an existing
subscription). For shapes, `ready` means collection construction, not remote
synchronization; `rows` is applied-row evidence. `elapsedMs` starts at route entry and `rows` is a count. Empty subscriptions need not ever report rows. The first committed frame
records once per navigation. The real remote-run regression can save these
content-free records with `RUN_ROUTE_TIMINGS=/tmp/run-route.json`.

Opening a run commits its frame immediately, even while inspection or Electric
is unavailable. Its repository's cached row supplies the header while inspection
is pending. The root inspection, then each child's journal, fills the live page
without keeping the router pending. Reopening a cached run keeps its last read;
a failed refresh follows the existing refusal rules. Replay freezes the latest
visible snapshot, including a parent whose child has not arrived yet (decision
[0097](../decisions/0097-run-page-progressive-inspection.md)).

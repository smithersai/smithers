# The agent

Smithers answers in the browser. The agent is `chat/Answer`, a `@smthrs/flow` flow on this device's durable engine, started with the answer's id as its execution id. The asking tab starts it: once ChatApi takes the question (`202`, or `200` for a resend), chat's outbox dispatches `chat/Answer { answerId }` (door `composer`) and waits until the engine has recorded the run, then for Electric; the run goes on in the background. So the outbox keeps the question until a run exists to answer it: a tab closed in between leaves it in the outbox, and the next page sends it again and starts the run. The engine starts an execution once, so a resend that dispatches again starts no second run. Its model calls go through the server's metered model endpoint, role `agent`, and its writes through ChatApi's answer routes. Closing the tab pauses an answer; the next tab or visit resumes it where it was, and a model call that sealed is never paid for again. An answer never streams forever: the run settles it however it ends, and the server's `chat/Expire` settles one whose run never does ([settling](#settling)). Decisions: [0003](../decisions/0003-flows-and-the-agent.md), [0011](../decisions/0011-the-agent-runs-in-the-browser.md).

## How an answer runs

```
chat/Answer { answerId }                               (execution id = answerId; no flow deadline)
  chat/LoadTurn ─ GET /api/answers/<id> ─▶ { question, history }   409 { not_your_turn, waitedMs }: retried until
                  earlier answers settle, or TurnOutOfTime once the queue before it hasn't moved for the turn wait (10 minutes)
  chat/Respond  ─ AgentAction over @smthrs/agent's cell loop, profile "conversation", at most 8 frames
                  each model call: a sealed ModelStep ─ ModelProxy client ─▶ POST /api/model/agent
                  each ctx.call: an app flow from the agent's catalog, as a child execution (flows.md)
                  EventSink ─▶ AnswerProgress ─ POST /api/answers/<id> { streaming, text, parts }, at most once a second
  chat/Settle   ─ POST /api/answers/<id> { done, text, parts, tokens } or { failed, failure }

ChatApi, when it takes the question ─▶ chat/Expire { answerId } on its Durable Object (remote-flows.md)
  each round: chat/ExpiresIn ─ ANSWER_EXPIRY (25 minutes) after the queue last moved ─▶ durable sleep ─▶ chat/Abandon
    queue still ─▶ failed, abandoned, if still streaming        queue moved meanwhile ─▶ the next round (.to)
```

| File | What it holds |
|---|---|
| `src/features/agent/flows.ts` | `chat/Answer` and its steps: `chat/LoadTurn`, `chat/Respond`, `chat/Settle`. It imports `@smthrs/agent`, so only the engine worker and the Node host load it |
| `src/features/agent/close.ts` | `chat/Close` and its step `chat/CloseWrite`, which settle an answer whose run can no longer finish ([settling](#settling)), and `SETTLE_RETRY`, the settles' retry policy. It imports no agent, so the tab dispatches it by the declaration itself |
| `src/features/agent/reference.ts` | `chat/Answer`'s reference: its tag and schemas, which the tab dispatches by and the declaration is made from ([flows](flows.md#how-a-dispatch-runs)) |
| `src/features/agent/instructions.ts` | `CHAT_SYSTEM`, the agent's system teaching, and `SLASH_COMMANDS`, the composer's commands from the registry ([what the agent is told](#what-the-agent-is-told)) |
| `src/features/agent/words.ts` | `ProductWords`, the answer's declared type: text that names no flow, cell, failure code or id |
| `src/features/agent/host.ts` | What the flow runs on: the `agent` seat, the catalog, the policies, the sink and the turn wait |
| `src/features/agent/progress.ts` | The fold of the agent's events into the answer's streaming text and parts, and the writer that sends them |
| `src/features/agent/answers.ts` | `AnswerApi`, the answer routes over Effect `HttpClient` |
| `src/features/agent/contract.ts`, `schema.ts` | The routes, limits, turn wait, settle window and wire shapes the browser and ChatApi share |
| `src/features/model/contract.ts` | The `agent` role's liveness bound, `agentLiveSeconds` ([turn by turn](#turn-by-turn)) |
| `worker/Answers.ts` | The answer routes, in ChatApi |
| `worker/flows/Expire.ts` | `chat/Expire`, the remote flow that settles an answer no run settled ([settling](#settling)) |
| `db/migrations/0006_answer_parts.ts` | `messages.parts` and the `unfinished` failure |
| `db/migrations/0008_browser_answering.ts` | Settles the answers ChatApi left `streaming` as `failed`, `abandoned`; drops `attempts` and the sweep's index; indexes the turn wait |

## The host

One composition (`AgentHost.layer({ origin })`) serves every host; the host supplies its engine (`FlowRuntime`), `Crypto` and an `HttpClient`. In the browser that is the engine worker (`src/flows/engine.worker.ts`), on the page's origin; in the tests, the Node host.

- **The seat.** `chat/Respond` declares the seat `agent`, which resolves to `ModelProxy.makeClient` on `<origin>/api/model/agent`, keyed by `ModelProxy.prepare`: the credential-free request the client sends. The endpoint picks the role's model ([model endpoint](model-endpoint.md)). Any other seat is unresolved. Under the dev server only, `/app?agent=<script>` names the engine worker `agent:<script>`, and the seat's model is that scripted agent (`src/test/scriptedAgent.ts`, `HostOptions.model`), for the end-to-end tests; a production build drops the branch.
- **Its status.** `chat/LoadTurn` reports the run `waiting` while an earlier answer holds its turn and `working` when its turn comes, and `chat/Settle` reports `done` or `failed`, through `RunReporter`; a report never fails the step ([agent status](agent-status.md#reporting)).
- **The catalog.** The registry's model-invocable client flows (`src/flows/catalog.ts`); nothing else. Among them, `app/navigate` takes the tab whose composer asked to a page of the app, for "open octocat/Spoon-Knife" or "go to line 12 of …", and refuses any other site ([navigation](flows.md#navigation)). `file/open` shows the person code: a file of the repository their tab views, opened as a tab with lines highlighted, and `file/close` closes one ([file tabs](files.md)). `app/web/open` shows an outside https page for "show me the Effect docs" or "open https://… in a new tab": in the chat with its origin above it, or as a card whose Open button the person clicks, never a tab opened on its own ([web pages](web-pages.md)). `app/jev/classify` and `app/jev/evaluate` put Jev, Smithers' judge, in its hands for decisions over a list, such as "which of these issues are bugs": a verdict per item or per criterion, each judgment one sealed model step through the endpoint's `judge` role ([Jev](jev.md)). `app/agent/ask` asks the person a question or for an approval and waits for the answer, a durable wait of at most 10 minutes ([agent status](agent-status.md)). `todo/inspect` reads a TODO's shared status (state, step, failure, branch, pull request and Cloud run) under the repository's Member policy, so an answer about a TODO never rests on this device's run list, which can't see a Cloud run ([decision 0093](../decisions/0093-agent-reads-shared-todo-status.md), [TODOs](todos.md)). The sandbox tools (`sandbox/run`, `sandbox/read`, `sandbox/write`, `sandbox/list`, `sandbox/status`, `sandbox/diff`) are its hands on the branch of the conversation it answers in: each runs on that branch's machine as the person who asked, and only when they may edit the branch ([sandbox tools](sandbox-tools.md)).
- **The policies.** A plain rate limit parks the step durably (`QuotaPolicy.layerDefault`); exhausted quota or credit, including HTTP 402, ends the answer promptly. The server holds the budget, so the device's own is unbounded. The cell loop runs no judge of its own (`claimCap` 0, `Evaluator.layerUnavailable`); the agent asks Jev through the catalog.
- **The sandbox.** QuickJS, at most 8 flow calls a cell; no steering yet, so a new question waits its turn.

## What the agent is told

`chat/Respond`'s system teaching (`CHAT_SYSTEM`) is short: its name; a few short sentences in the person's words, never a flow's name, an error code, an id or JSON outside a fenced block of code the person asked to see, saying what it did and offering nothing more; change something only through the flow that changes it, and say so only after the flow answered; call only the flows the request needs, and a flow with a side effect only when the person asked for that effect; when a flow fails or is refused, say so and stop, never reaching for another flow in its place; a flow that needs the person's approval asks them itself, and once they say no the agent leaves it; the person's own acts, every registry flow with a `userOnlyReason` that a person runs (`PERSONS_OWN`, by the first sentence of each description), for which it calls nothing and says the person does it; the person sees only the answer, so what they ask to see goes in it; no promise to do something later; nothing said that no flow answered and the person didn't say; people merge, approve and move `main`, and the agent never does or looks for a way round it; asked how to do something a flow does for a result they name, do it and name the slash command in a few words, and asked only what a command does, explain it; the composer's slash commands, each with the flow it runs, read from the registry the slash menu reads (`SLASH_COMMANDS`, [slash commands](slash-commands.md)); and prefer a ready-made view. Each flow's own description, in the catalog, carries the rest, and four rules are structural rather than taught:

- **Product words.** The answer is declared `ProductWords` (`src/features/agent/words.ts`): text naming a registered flow, the cell's names (`ctx.call`), a failed call's code (`flow_failed`), a typed failure's kind (`WebPageRefused`) or an id is refused by `@smthrs/agent`'s output check, which hands it back to the agent in the same session with the names it used and "Say the same thing in their words". The agent's earlier calls stay done and aren't made again. After `WORD_CORRECTIONS` (2) such corrections the answer fails rather than reach the person. A fenced code block, closed as Markdown closes it (the same character, at least as long, either fence indented up to three spaces), is read past: what a person asked to see, such as their own flow's code, may name the flows it calls.
- **Side effects.** Each flow in the catalog says what it changes, or nothing for a read; one only the person decides on asks them first ([flows](flows.md#the-agents-catalog)).
- **A no stands.** Once the person denies an approval in an answer, the agent's own approval ask (`app/agent/ask`, kind `approval`) reads `{ answered: true, approved: false }` and a call of the `confirm` flow they denied fails `NotApproved`, neither asking again (`src/flows/approvals.ts`). The refusals are read from the answer run's `app/agent/ask` children in the engine's record, so a resumed run keeps them.
- **Well-known docs.** `app/web/open` names the page for each well-known docs site ([web pages](web-pages.md#well-known-docs)).

The [agent evals](agent-evals.md) measure each: before 2026-10-20 the agent told a person there was no `/theme`, quoted `app/web/open` and `flow_failed`, cloned a repository it was only asked to open, saved and ran a flow it was only asked to create, and opened a guessed Effect docs site in three runs of eight.

## Streaming

The model's text reaches the answer while it streams. The agent's `EventSink` records each event against the run's execution id, the answer's, and folds it (`progress.ts`):
- each `text-delta` is appended to the current reply, and a new model call or a retry starts the reply over;
- the answer's text is `DoneText.project(reply)` from `@smthrs/harness`: the literal passed to the reply's last `ctx.done(`, decoded as far as it has arrived. Only a reply whose fenced blocks, of any tag, are one `ctx.done(` of one literal with no `${` streams its text at once; any other holds it until the cell settles, and drops it when the cell raised, and a reply seen to do more after its text streamed takes that text back to what the answer showed before the reply (an empty text, written, when nothing): until then a call may fail or wait on the person's approval, and "Deleted your flow" would show while the delete hadn't run (the agent evals, 2026-10-22);
- each flow call is a part, `{ id: "<frame>.<ordinal>", kind: "step", flow, status }`, `running` until it settles `done` or `failed`. A resumed run replays a sealed call's settlement without its start, so a settlement adds its part.

A writer sends each changed answer's text and parts at most once a second (`partsEvery`). A streaming write the routes refuse is dropped: `chat/Settle` writes what counts. Parts hold only what a person sees: never a cell's code, a flow's input or its result.

## Settling

An answer never streams forever. Every way its run ends settles it, as a step of the same run, and what the run can't settle, the server does.

`chat/Settle { answerId, ending }` writes, for how the run ended:
- `done`, with the text, the parts and the tokens the run's model calls reported, when the agent answered. Token counts are whole; a provider's fractional count is rounded, where it once killed the step and left the answer streaming;
- `failed`, `empty`, when it answered nothing;
- `failed`, `quota`, `rate_limited` or `model_error`, when its model failed, and `unfinished` when it ran out of frames;
- `failed`, `unfinished`, when the turn wait ran out ([turn by turn](#turn-by-turn)).

A quota refusal is carried in the sealed ending, so a crash before settlement preserves its reason without another model call. A settle the routes already took is answered as taken, so a step run again after a crash changes nothing. A run resumed after its agent step sealed has no parts to send; the settle then keeps the parts the answer has.

`chat/Answer` declares no flow `deadline`. The engine ends a run past its flow deadline with a defect, and a defect settles nothing: a plan's `Node.catch` sees typed failures only, by the engine's design (`@smthrs/flow`'s `Interpreter.ts`, the `Catch` node), and a flow's finalizers aren't durable. A plan can't race a durable timer against running work either: a member parked on a timer waits for the next drive, so a run that never parks would never see it.

A run the engine refused because the app changed under it ends with no settle of its own: parked under one build and resumed under the next, its plan no longer matches the one it recorded, and the interpreter refuses it `plan_changed`, or `payload_changed` when its recorded payload no longer decodes (`Interpreter.refusalCode`). The tab that asked reads that end and starts `chat/Close { answerId }` under its own execution id (`<answerId>/close`, `src/features/agent/close.ts`), which settles the answer `failed`, `unfinished`, so it reads `Couldn't answer` with Retry at once; an answer that settled some other way stays as it is. A resend finds a run refused before, so it closes an answer an earlier build left streaming too. Any other defect is left to `chat/Expire`.

What the run can't settle, `chat/Expire { answerId }` does (`worker/flows/Expire.ts`, [remote flows](remote-flows.md)). ChatApi starts it on its Durable Object when it takes a question, one execution per answer (`chat-expire-<answerId>`), and answers `202`, or a resend's `200`, only once the start is recorded; it never waits for the flow, and the same start again is a no-op. A start the host refuses is a `503`, which the outbox sends again: the resend finds the question stored and starts the expiry. So an answer the server acknowledged always has its expiry (Codex review 4). The question's write and the start run as one uninterruptible unit, so a caller that goes away between them doesn't stop the start. One window stays: the Worker dies between the write and the start; the device that asked got no answer, so its outbox sends the question again and starts it, unless that device never comes back. It settles the answer `failed`, `abandoned` once its queue has been still for `ANSWER_EXPIRY` (25 minutes) and it is still `streaming`, and changes nothing otherwise; in the same transaction the answer's run fails and the feed folds it ([notifications](notifications.md#the-routes)). The queue is the answer and every earlier answer in its conversation; it moves when one of them is written or settles, so the clock starts again when the answer before it settles, as the turn wait's does ([turn by turn](#turn-by-turn)), and while its own device writes or waits its turn. Each round of the flow reads how long until the expiry as things stand (`chat/ExpiresIn`, a wait on Postgres' clock, so the host's clock never has to agree), sleeps that long on a durable timer, and then settles the answer in one statement that checks the queue again; when the queue moved meanwhile (`waiting`), it hands off to the next round (`Expire.to`), which waits again, at most 1,000 rounds. No sweep runs: each answer's own lineage decides. Before this, the expiry counted from the ask, so the tail of a burst whose earlier answers each settled in time was abandoned while it waited its turn (the regression from the client-fix review: 25 answers, each settling 250 ms after the one before, against an expiry of 1.5 s). That covers a device that never comes back (a closed browser profile, an e2e context, a phone left shut), a run that ended in a defect, and a run whose settle couldn't land. It runs on the server because it must happen while every device is off ([`flows.local-first-placement`](../rules.md#flowslocal-first-placement), need `devices-off`).

The expiry is longer than any live run that doesn't wait behind others: its turn starts when the answer before it settles, which moves its queue; it waits at most its turn wait (10 minutes) while the queue before it doesn't move, its agent's few model calls take seconds (each at most 3.0 s in ChatApi's dev logs of 2026-10-20), and its settle retries at most `ANSWER_SETTLE_WITHIN` (10 minutes). About 20 minutes of a still queue at worst; 25 leaves room for an agent ten times slower. A device that comes back after the expiry finds its answer settled: its turn, streaming writes and settle are refused `409 settled`, and its run fails `AnswerSettled`.

## The answer routes

Only the person who asked the question may call them for its answer, and only while they are a Member or above (asking is `repo:ask`, [0007](../decisions/0007-roles-and-tags.md) §2), like the model endpoint and `POST /api/questions`. ChatApi records the asker on the question from the session that asked (`asked_by`, [chat.md](chat.md#messages-postgres)), and each write checks it in the statement that writes, so another Member can't read the turn of, write, settle or learn the outcome of someone else's answer. An agent acting for the asker is the asker. An answer changes only while it is `streaming`.

| Route | Answers |
|---|---|
| `GET /api/answers/<id>` | `200 { question, history }`: the finished exchanges before it, oldest first (at most 19, 24,000 characters). `409 { code: "not_your_turn", waitedMs }` while an earlier live answer streams, with how long its turn has waited ([turn by turn](#turn-by-turn)); `409 { code: "settled" }` |
| `POST /api/answers/<id>` | `200 { txid }`; `200 { txid: null }` for a settle that already landed; `409 { code: "settled" }` for any other write to a settled answer; `400` for a body that isn't an answer write; `413` over 256 KiB |
| `PATCH /api/answers/<id>` | `200 {}` renews the host lease without content; `409 { code: "settled" }` after terminal settlement |
| all | `401` signed out; `403 { code: "forbidden" }` for a Guest, a person with no role, or anyone but the asker (logged `not_asker`), whatever the answer's state; `404` for an id that isn't an answer; `405` for another method; `503 { code: "unavailable" }` when Postgres can't be reached |

## Turn by turn

Answers come in order, one question at a time (decision 0002). `chat/LoadTurn` asks for its turn and, while an earlier answer streams or the routes can't be reached, fails `NotYourTurn` or `AnswersUnavailable`, which its retry policy retries (250 ms, doubling to 4 s). Each `409 not_your_turn` says how long the turn has waited since the queue before it last moved: since the latest earlier answer settled, or since this one was asked if that is later (`waitedMs`, on Postgres' clock). Once that reaches the turn wait (`ANSWER_TURN_WAIT`, 10 minutes, or the host's own), the step answers `TurnOutOfTime` instead, and the run settles the answer `failed`, `unfinished`, without calling a model. So a burst is answered in turn however long it is, as long as each answer ahead settles within the turn wait of the one before it; only a queue that stops moving runs it out. A run resumed after a crash counts the time it waited before, since the wait is Postgres' record. While the routes can't be reached, the step retries with no bound: nothing could be written anyway, and `chat/Expire` settles the answer of a device that never comes back. An answer that settled some other way fails the run with `AnswerSettled`, and no model is called.

Before 2026-10-20 the wait counted from the run's first start (a sealed `chat/TurnDeadline` step), so a long enough burst settled its tail `unfinished` while the queue was still moving. At the worst observed pace (8 frames of 3 s, and up to 4 s from one answer settling to the next turn request), that was from about the 23rd queued question; at a typical one or two frames, past the 75th.

An earlier answer holds up a turn while its host lease is fresh: `ANSWER_TURN_LIVE_SECONDS` defaults to 30 and accepts integers of at least 5 seconds. This measures host connectivity, independently of model reasoning, text projection or tool output. `@smthrs/flow`'s public `Interpreter.ExecutionOptions.onHeartbeat` installs the receipt around every interpretation, including resumed runs whose sealed `chat/LoadTurn` is replayed. The durable engine renews its ownership every second, then dispatches one bounded receipt without blocking that writer. A pending receipt prevents overlapping requests. Completion, cancellation, suspension and ownership loss interrupt the receipt; the next drive reinstalls it.

`PATCH /api/answers/<id>` renews the answer's timestamp at most once a third of the lease window. It applies the same asker, role, branch-access and run-binding checks as writes, and contains no question, reasoning, answer text or tool payload. A queued turn request also renews its own lease. Reasoning-only calls and quiet tools therefore keep later answers waiting as long as the host stays connected.

Turn admission, heartbeat and content writes serialize on the conversation's row. Before granting a turn, the route changes expired earlier answers to `failed`, `abandoned`, updates their runs and folds notifications in the same transaction. An explicit `needs_you` wait is exempt: decision0015 lets a later question start beside it after thirty seconds while its original card remains answerable. A transition back to `working` supplies first-pulse grace through its fresh run timestamp, under the same lock. Their old hosts cannot resume writing after a successor starts: terminal answers refuse heartbeats and writes with `409 settled`. Another conversation has its own lock. A disconnected host releases the queue after the configured lease window; `chat/Expire` remains the durable fallback for an abandoned answer with no later question.

## Durability

| What happens | What the agent does |
|---|---|
| The tab closes, or the browser dies, mid-answer | The next tab's engine takes the run over at once and resumes it: sealed model calls and flow calls replay from their record; the call in flight runs again |
| A model call streams nothing for 300 s (`defaultModelIdleMs` in `@smthrs/agent`'s `ModelStep`) | It fails, and the step's retry policy decides |
| The answer routes are unreachable | `chat/LoadTurn` retries until they answer; `chat/Settle` retries for up to 10 minutes (`ANSWER_SETTLE_WITHIN`) |
| The queue before an answer doesn't move for the whole turn wait | `chat/LoadTurn` answers `TurnOutOfTime`, and the run settles the answer `failed`, `unfinished` |
| The run ends in a defect | Nothing in the run can settle it ([settling](#settling)); `chat/Expire` settles it `failed`, `abandoned` |
| The device that asked never comes back | After `ANSWER_TURN_LIVE_SECONDS` without a write it no longer holds up later answers ([turn by turn](#turn-by-turn)); once its queue has been still for `ANSWER_EXPIRY`, `chat/Expire` settles it `failed`, `abandoned` |
| That device comes back after the expiry | Its writes are refused `409 settled`, and its run fails `AnswerSettled` |

## Configuration

| Variable | Default | |
|---|---|---|
| `ANSWER_TURN_LIVE_SECONDS` | `30` | a positive integer: how long an earlier `streaming` answer holds up later turns since its last write, the `agent` role's liveness bound (`src/features/model/contract.ts`) |
| `ANSWER_EXPIRY` | `25 minutes` | a duration: how long a `streaming` answer's queue (it, and the earlier answers in its conversation) stays still before `chat/Expire` settles it `abandoned` (`worker/flows/Expire.ts`). Read by the `FlowExecution` Durable Object |

The turn wait (`ANSWER_TURN_WAIT`, 10 minutes, counted from when the queue before an answer last moved) and the settle window (`ANSWER_SETTLE_WITHIN`, 10 minutes) are constants in `src/features/agent/contract.ts`; the browser has no environment to read. A host may pass its own turn wait (`HostOptions.turnWait`).

## Observability

`ModelStep`'s and `ModelProxy`'s records cover every model call ([model endpoint](model-endpoint.md)). The answer routes add:

| Record | Kind | Fields |
|---|---|---|
| `chat.answer.turn`, `chat.answer.write` | log | `answerId`, `status`, `durationMs`; `historyExchanges`; `waitedMs` on a `409 not_your_turn`; `write` (`streaming`, `done`, `failed`), `parts`, `bytes`, `existing`; `errorCode` on a 503, and `not_asker` on a 403 to anyone but the asker |
| `chat.answer.request` | span | `smithers.chat.answer_id`, `http.response.status_code` |
| `smithers_answer_requests` | counter | `route` (`turn`, `write`), `status` |

`chat/Expire` and ChatApi's start of it add:

| Record | Kind | Fields |
|---|---|---|
| `chat.answer.expire` | log | `answerId`, `outcome`: Info `abandoned`, `settled`, `missing` once the flow decides, and `waiting` for a round that found the queue moved; Warn `failed` (one step's attempt, with `errorCode`, `sql:<reason>`) and `not_started` (ChatApi couldn't start it and answered `503`, with `errorCode`: the host's code, or `conflict`) |
| `chat.answer.expire` | span | `smithers.chat.answer_id`, one per step attempt |
| `smithers_answer_expiries` | counter | `outcome`: `abandoned`, `settled`, `missing`, `waiting`, `failed`, `not_started` |
| `chat.question` | log field | `expiry`: `started`, on every question ChatApi acknowledged; a refused start is `status` 503 with `errorCode` `expiry_not_started` |

The Durable Object's own `cloudflare.execution.start` and `cloudflare.execution.alarm` records show the expiry's start, its park on the timer and its end ([observability](../observability.md#remote-flow-executions)). No record carries a question, an answer's text or a cell (sentinel tests).

## Tests

| Test | Proves |
|---|---|
| `src/features/agent/agent.test.ts` | `chat/Answer` on the Node host over the compose Postgres, against ChatApi's real model endpoint and answer routes, with a scripted model: an answer; a theme call as a journaled step whose receipt the agent answers from; text and parts streaming to the row; resume after the tab is killed, with 3 model calls (one sealed, one cut off, one after) and one theme write; replay of a settled run without a model call; answers in turn; `model_error`, `unfinished`, `empty`, `AnswerSettled`; a turn whose queue doesn't move settling `unfinished` at the turn wait with no model call; a burst's tail whose queue keeps moving waiting past the turn wait counted from its start, then answered; a run killed while it waits settling on resume by the wait Postgres recorded; fractional token counts settling `done`; the seat |
| `worker/flows/Expire.test.ts` | `chat/Expire` on the Node host: a streaming answer settles `abandoned` with its text kept, only once its queue was still for the expiry; a burst of 25 whose answers each settle in time leaves its last answer streaming until the expiry after the one before it settled, over several rounds; the queue's last movement is an earlier answer's settle or write, or the answer's own write; a settled answer is left as it is; a missing one is `missing`; a device that comes back after it fired fails its run `AnswerSettled`; its records by outcome without the text; `ANSWER_EXPIRY` and its default |
| `worker/Chat.test.ts` "chat/Expire" | Asking starts the expiry once per answer, and a resend starts the same execution; a start the host refuses (a fault-injected `FlowStarter`) is `503`, logged and counted `not_started`, and the resend starts it and is `200`; a caller that goes away after the question is stored still gets its expiry started; a question ChatApi doesn't take starts nothing |
| `worker/ExecutionHost.test.ts` "the deployed flows run chat/Expire" | The deployed host parks the expiry on its durable timer with the alarm armed for it, then settles the answer `abandoned` at the alarm |
| `src/flows/engine.test.ts` | The same agent on the browser's architecture in Node: started through `BrowserEngine`, run by the leader, its theme call painting the tab through the tab port |
| `src/features/navigation/navigation.test.ts` "the agent's call moves the tab whose composer asked, and no other" | The agent's `app/navigate` call moves the asking tab and not the device's second tab, and its call for an outside site fails as a step while the answer settles `done` |
| `src/features/chat/chat.test.ts` "the agent" | The whole app on a Node device whose engine leads: asking dispatches the answer, which streams then settles; a resend answered `200` runs once; a tab closed after ChatApi took its question but before its engine recorded the run, or whose engine failed, leaves the question in the outbox, and the next page's agent answers it; a signed-out (`401`) or Guest (`403`) ask stays Not sent |
| `src/features/jev/jev.test.ts` "the agent", `e2e/jev.spec.ts` | A cell's `app/jev/classify` call is a journaled step whose judgment goes through the `judge` role, and the agent answers from its verdicts; in a real browser, a verdict per item ([Jev](jev.md#tests)) |
| `src/features/agent/close.test.ts` | `chat/Close` on the Node host: a streaming answer settles `failed`, `unfinished`, and a second close changes nothing; an answer that settled `done` stays as it is |
| `src/features/chat/chat.test.ts` "app changed under it" | A run whose end reads refused `plan_changed` or `payload_changed` has its answer closed `failed` through `chat/Close`; any other defect closes nothing |
| `src/features/agent/agent.test.ts` "machinery", `words.test.ts`, `instructions.test.ts` | An answer naming a flow and a code goes back to the agent once with the names and settles in plain words; one that names them after every correction fails; which names `ProductWords` refuses and which it passes (slash commands, repositories, paths, URLs, a person's flow, a commit SHA); the teaching lists every command the slash menu offers, with its flow, and marks the person's own |
| `src/features/agent/progress.test.ts`, `answers.test.ts` | The fold, the settlement, the prompt, the writer, the sink, and every refusal `AnswerApi` reads |
| `worker/Answers.test.ts` | Every route and status, a Guest's and a roleless person's `403`, another Member's and an Admin's `403` on someone else's answer (the forged settle reproduced from the 2026-10-20 review, and the asker's own settle landing after it), an agent writing for its asker, idempotent settles, history, turns, the liveness bound (a quiet answer stops holding up later ones; a waiting one stays live, written at most once a third of the bound; `ANSWER_TURN_LIVE_SECONDS` and its default), the waited time a refusal reports (since the latest earlier settle, else since the ask), records without the text |

Run them with the compose Postgres up (`pnpm db:up`): `pnpm exec vitest run src/features/agent src/flows/engine.test.ts worker/Answers.test.ts worker/flows/Expire.test.ts`.

What the agent does when asked, with the real model rather than a scripted one, is the [agent evals](agent-evals.md)' job: `pnpm eval`.

### Host lease records

`chat.answer.heartbeat` records `answerId`, HTTP `status`, `durationMs` and `renewed` (whether this request changed the lease timestamp); `smithers_answer_requests` counts route `heartbeat`. Turn admission records `abandonedPredecessors`. A transport failure on the device records `chat.answer.heartbeat.failed` with answer id and status only. The SDK counts `flows_engine_heartbeat_receipts` by `completed`, `skipped` (one already pending) and `failed`, and warns `run heartbeat receipt failed` with run id when a callback fails or times out. Records never contain model reasoning, user text, credentials or tool payloads.

The regression `e2e/answer-ordering.spec.ts` drives the real browser engine and answer routes with the dev-only faulty model service: forty seconds of private reasoning leaves visible progress unchanged, and the follow-up must receive the first completed exchange. Unit route tests prove abandoned-host release, authorization, open-question preservation, unblocked heartbeats during a stalled write body, and stale-writer fencing; the real durable host suite holds a child tool with no new output and additionally kills and resumes a model call after the sealed turn read, and verifies heartbeat renewal on the new incarnation. Injected browser transport failures (offline, `503`, then terminal `409`) leave ownership responsive, and a later successful receipt renews the still-running answer before it settles. The crash fixture permanently gates the old engine’s SQL transport and terminates every connection tagged with that incarnation’s unique application name, including an idle reserved transaction; the old engine cannot reconnect or keep a writer lock while its replacement resumes.

### Answer exchange deadlines and progress isolation

`AnswerApi.layerHttp(origin, within)` bounds each complete exchange (request and any decoded body) to 15 seconds by default. A stalled GET, PATCH, POST or refusal body becomes `AnswersUnavailable`; the existing durable action retry policy remains the only retry owner, including `chat/CloseWrite`.

Progress writes run independently across answers, with one in-flight write per answer. Changes during that write coalesce into the next tick. A terminal `AnswerSettled` refusal releases the retained progress in both the streaming writer and settlement handler; transient failures retain it for a later durable retry. When settlement retries expire, the graph calls `chat/ForgetProgress` before returning the original failure.

The client records `chat.answer.exchange` spans, `chat.answer.exchange.timeout` warnings and `smithers_answer_exchange_timeouts` by operation. Progress records `chat.answer.progress` spans, `chat.answer.progress.failed` warnings with answer id and status, and `smithers_answer_progress_writes` for accepted writes. No text or body is recorded. Fault-injected Effect HTTP/answer services in `answers.test.ts` and `progress.test.ts` cover stalled requests/bodies, cross-answer isolation and terminal cleanup; the NaN refusal is supplied directly as an Effect response because JSON encodes NaN as null.

Saved-flow catalog outages leave successful memory recall available to the opening step. Access refusals still stop the opening. Outages emit `memory.catalog_unavailable` as a warning and span and increment `smithers_memory_catalog_unavailable`; no catalog content is logged.

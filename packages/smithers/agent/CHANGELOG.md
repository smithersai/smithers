# @smthrs/agent

## [Unreleased]

### Added

- `Agent.Options.environment`, `AgentSession.Options.environment` and
  `AgentAction.Host.environment`: what the host measured or declares about
  the checkout and container, rendered into the run's teaching. No host
  passed `CellTurn.Environment` before, so its facts were never stated.

- `ModelStep.run` calls a model as one durable, sealed step of the running
  flow. Its key digests the credential-free prepared request (route, protocol,
  URL, public headers and canonical body bytes) with the encoded request, so a
  different API key keys the same step and a changed history, model id or base
  URL keys a new one. Transport faults are retried inside the step with
  byte-identical bodies; a capacity refusal such as a 429 fails it unsealed for
  `retryPolicy` to retry (by default one second doubling to thirty, for two
  minutes); every other provider error is sealed as `Result.error`. Each
  streamed event is a heartbeat against `heartbeatTimeoutMs` (sixty seconds by
  default), `onEvent` receives events while the call runs and the recorded
  events on a replay, and a call cut off mid-flight is made again on resume and
  counted by `agent_model_step_redispatches`. The guide is
  `docs/guides/durable-model-call.md`.
- Markdown children: `ctx.call("<markdown flow>", { args })` runs that flow as
  a nested run of the caller's own agent loop when `Agent.Options.children` is
  set, which `AgentSession.Options.markdownChildren` and
  `AgentAction.Host.markdownChildren` turn on. The child runs inside the
  caller's durable call, so a replay is served its recorded answer; on the
  flow's `model:` and `effort:`, or the caller's; with the host's flows and no
  `wait`, `ask` or markdown flow; and on the caller's budget, never parking it.
  Its answer is the call's value, and a child that fails or runs out of frames
  resolves `flow_failed`. A run is never offered itself. `AgentSession.childTracer`
  journals each child event as `control.child.*` with
  `child: { callId, flow, scope }`. The guide is `docs/guides/subagents.md`.

### Changed

- `FlowEngineLike`'s `sealStep` dispatches through `ModelStep`'s
  implementation, so the agent loop and `ModelStep.run` share one key, one
  recorder and one action. Step keys are unchanged. A step tells a re-issued
  call from a first one by `@smthrs/flow`'s `Action.CurrentRedispatch`, and
  each step opens a `ModelStep` span, logs each provider
  call at debug level, and updates the `agent_model_step_calls`,
  `agent_model_step_replays` and `agent_model_step_redispatches` counters. A
  failure crossing a span opened inside a step records only its tag and code.

### Fixed

- `StandardFlows.shell` hands the cell what a timed-out `bash` command printed
  as `error.output`, and its message says so: "The command timed out;
  error.output holds what it printed before it was stopped." It used to answer
  "The command timed out." and nothing else, so a test loop that printed a
  line per case and hung returned none of them.
- A markdown child no longer runs with more authority than its caller. The
  call boundary read a declared `capabilities:` entry as one exact resource,
  so a caller holding `fs:read:/app/?.txt` admitted a child declaring
  `fs:read:/app/*.txt`, which the child then used as a pattern to read
  `/app/secret.txt`. Each declaration is now admitted only where one grant of
  the caller's envelope covers the whole pattern.
- A markdown child runs every call through its caller's `Agent.Options.authorize`
  hook. The child ran with no hook, so a host that denied `fs/write` but
  permitted the child flow was bypassed when the child called `fs/write`. A
  call the hook would park for approval is refused in the child's cell with
  `capability_refused`, so a child still never parks its caller.
- A markdown child no longer drains its caller's steering queue, parks on its
  caller's `Budget.Parking` handler, or emits to its caller's
  `AgentEvent.Observer`. The child's runner provided the caller's whole
  captured context inside its overrides, which restored all three; it now
  provides only the run services a child needs, outside the overrides.

- `fail-only-report` retains commands that cannot start, exceed the output buffer,
  or terminate by signal as failed results for the analyzer, instead
  of dropping them and claiming the remaining commands all passed. Captured
  output and measured duration reach the analyzer, and quiet summaries claim
  success only when every requested command has a successful result.

- `EventSink` and its docs said model deltas reach a sink only after the
  provider stream settles. They arrive live, while the provider is still
  streaming, and a replay emits the recorded events. The docs now say so, and
  `test/AgentAction.test.ts` proves a delta reaches the sink before its call
  settles.

- The `jev` flow sends each question as `<id>: <instructions>`. Jev reads a
  question's instructions and the state, never its id, so a cell that keyed
  one instruction ("Does this file need to change?") by each path asked the
  same question of every file and got the same answer back. On the paired
  SWE-bench Pro run of 2026-10-14 all 42 file picks posed that way came back
  flat (median spread 0.02; NodeBB-1ea9481a read 0.77 to 0.80 for 107 files),
  ranking the gold patch's files no better than chance (AUC 0.49). Replayed
  through the gateway with each id named, they spread a median 0.47 and scored
  a gold-patch file above another file in 77% of pairs; questions that already
  named their item read the same as before (#3992).

### Added

- `StandardFlows.filesystem` takes `{ remote: true }` for services that act on a
  tree the host does not hold, such as a container's. Every file flow is then
  bound `irreversible`, so no write runs inside a host jj snapshot that could
  not restore it and no read replays an earlier call's record of a tree that
  may have changed. A host sealed to a container binds its file flows this way.

- A hosted turn's journal callbacks now record the transport phase each attempt
  reached (#3812). An unanswered callback was a single fact — `chat_callback
  pending` — that a request the dispatcher never took, a connection that never
  came up and a journal that took the bytes and said nothing all produce alike;
  production turn 2d851bdd ended on exactly that ambiguity, and its guest's
  IPv4 socket table, read once at 180 s, could not separate them either. The
  producer now reads Node's own `undici` diagnostics channels, scoped to this
  turn's callback origin, and each attempt's end record carries how far it got
  (`none`, `created`, `sent`, `responded`, `received`), whether its socket was
  reused, how many connections its origin began, completed and failed while it
  was open, and a failure's short code. Nothing it writes names a path, header,
  body, destination or credential. `test/CallbackTransport.test.ts` pins each
  phase against a real journal over real sockets, including a reused keep-alive
  connection, a cancelled commit and a retry the journal answers `duplicate`.

  That record now carries the resolution too, so `created` separates the two
  faults it used to merge (#3812). A name that never resolves and a SYN that is
  never answered both report one connection begun and none ended; the socket
  that dial created tells them apart, because it reports the name's answer
  before the connection is attempted. `lookupBegan` without `lookupEnded` is a
  name still in the resolver, `lookupEnded` with no connection ended is a name
  answered and a connection that never came up, and `lookupCode` names a
  resolution that failed. That split holds for a dial this host makes itself;
  no resolution record at all means either a dial to an address or a dial a
  connector carried, and the two are not distinguished. `net.client.socket` carries no
  origin, so a socket is attributed only when the dispatcher created it in the
  same synchronous turn as the dial this observer counted, and one that arrives
  later is left alone rather than guessed at.

  A turn whose callback failed now answers the caller with that phase, because
  the record itself does not outlive the turn (#3812). The attempt's record is
  written to the guest's own log, and the guest is deleted when its turn ends:
  reading the phase meant catching the stall alive, which the production case
  that motivated this record did not survive. A transport failure now carries
  the phase it reached on the failure itself, so the host's refusal of the
  turn — the one connection a callback fault does not break — carries it to the
  API, whose bounded read of that body is already recorded against the turn.
  One reading, not two: the failure's fields and the guest's own record come
  from the same report. An observer that watched nothing adds no field, so a
  caller-driven producer still answers exactly as before.

  Three limits remain. A hosted guest is always proxied, so the resolution
  split is not available to it at all: `created` with one connection begun and
  none ended is the proxy hop that has not come up, and the name behind it
  belongs to the egress proxy's own records. A hang after the name is answered
  is a connection the kernel is still retrying, and whether that is a dropped
  SYN, a silent middlebox or a filtered route is in no record this host takes.
  And the connection and resolution counts belong to the callback origin rather
  than to one request, so two of a turn's callbacks simultaneously waiting for
  a connection to the same origin each count both of their dials. An attempt
  that already has its socket is no longer one of them.

### Fixed

- A callback's transport record no longer reports a name resolution this host
  never performed (#3812). Every hosted guest reaches its journal through the
  sandbox's egress proxy, and under a proxy the dispatcher dials the journal's
  origin and then hands that dial to a connector, which dials the proxy: the
  socket the dial produced is the proxy's, so its resolution — or its absence,
  when the proxy is an address — is not the journal's name. The observer
  claimed it anyway. Measured on the pinned Node 26.5.0 through a real CONNECT
  proxy, a **healthy** callback reported one resolution begun and none ended,
  which this record's own reading calls a name still stuck in the resolver, and
  with the proxy named it reported the proxy's resolution as the journal's. A
  dial for a host no open attempt named now releases the claim, so a proxied
  attempt records its connection counts and no resolution, and the record no
  longer sends a reader after DNS for a fault that is not there. The direct
  dial's split is unchanged.

  A proxy has a second shape, and the fix above does not reach it: an `http`
  journal under `NODE_USE_ENV_PROXY=1` is sent absolute-form, so the
  dispatcher names the proxy as the request's own origin, publishes no dial for
  the journal at all, and the one socket there is resolves the **proxy's**
  name. Measured the same way through a named proxy, a healthy callback still
  reported `lookupBegan 1, lookupEnded 1` — the proxy's resolution, read as the
  journal's. A dial whose host is not the attempt's own callback origin no
  longer claims a resolution either, so no proxied shape reports one, while the
  connection counts stay the hop's as documented. Production's journal is
  `https` and therefore tunnelled; this is the shape a plain-HTTP journal
  takes. `test/CallbackTransport.test.ts` replays the record order real
  transport publishes in both shapes; the measurements are in
  `diagnostics/continuation13/repro` (`after-fix-tls.log`,
  `red-absolute-named.log` and `after-fix-http-named.log`).
- A callback that the journal already answered no longer reports a later
  callback's connection as one of its own (#3812). The connection counts are an
  origin's, so every attempt open to that origin counted every dial for it,
  including attempts whose headers were already on a socket. Measured on the
  pinned Node 26.5.0 with two callbacks of one turn in flight to one journal
  origin through a real CONNECT proxy — the overlap production turn `2d851bdd`
  had, and the shape the single-attempt readings could not take — the
  dispatcher opened a second tunnel for the second callback and the first,
  already answered `204` with its body ended, reported `connectBegan 2,
  connectEnded 1`: a connection that never came up, on a callback that
  received its answer. A dial is now counted only by an attempt still at
  `created`, which is the state the count was built to read; the waiting
  attempt keeps its own unfinished connection and its failure code, and the
  direct and both proxied shapes are unchanged. The same measurement settles
  one thing about the turn itself: a second concurrent callback to one origin
  is not queued on the first one's connection, so a dispatcher pool with
  nothing to spare is not what that turn's missing second socket was. What it
  was is still unknown, and nothing here claims otherwise. Measurements in
  `diagnostics/continuation14/repro` (`concurrent-before.log`,
  `concurrent-after.log`).
- A refused sealed model stream no longer carries a field that route cannot
  produce (#3812). `streamRefused` spread the status a journal refused a
  callback with, and a sealed stream commits nothing: its only failures are a
  refused resolve, a model failure and an oversized stream, none of which has a
  status. The branch was unreachable, which is why the package's own 100 %
  coverage threshold could not be met with it there. The cause type is narrowed
  to what the route can fail with, so a producer failure at that call site is a
  type error rather than a status the response would silently drop, and the
  provider's own code — the one field beyond the tag the route does carry — is
  now pinned by a test.
- The journal callback bound now covers the receipt, not just the request
  (#3812). `fetch` resolves as soon as headers arrive, so a journal that
  answered a commit's status and then stopped sending its receipt left a second
  unbounded wait on the same socket. The deadline interrupted that read, so the
  turn did end — but the half-sent response was never closed, and every stalled
  turn leaked a connection to the journal for the life of the guest. Each
  attempt now runs against an `AbortSignal` of the bound's own, which the
  expiring deadline aborts: the request and any receipt still arriving on it
  both end, and the retry asks for a connection of its own. Proved on the
  published bundle: before the fix a journal sending headers and no receipt
  held both attempts' sockets open with the turn already failed; after it, both
  closed at 15 s and 30 s. `test/ProducerTransport.test.ts` holds the shape
  against a real journal over real requests.
- A journal callback a hosted chat turn cannot get an answer to now ends that
  turn instead of holding it open forever (#3812). `fetch` has no deadline of
  its own and nothing below the host supplied one, so an unanswered commit
  spent the person's whole turn in silence: production turn 2d851bdd sat on one
  attempt for half an hour and turn 7e5fc00f for 1 h 19 m, both producing
  neither output nor a receipt. Each attempt now has 15 s — two orders of
  magnitude over the 424 ms the slowest healthy callback this investigation saw
  — and the attempt is retried once on a request of its own before the turn
  fails as `ProducerUnreachable`, which the host boundary turns into a terminal
  receipt. The bound closes the attempt's socket rather than leaking it, and
  the guest's own record names the bound that fired, so an operator does not
  have to infer it. Removing the buffer below or this bound re-creates the
  stall; `test/ProducerTransport.test.ts` holds both against a real journal
  over real requests.
- A hosted chat turn no longer deadlocks against its own journal (#3812).
  Writing a frame stopped reading the provider's response, and a commit issued
  in that state never answered: production turn 2d851bdd attempted its first
  commit 1 ms after its first event and was still waiting half an hour later
  with the response's last bytes unread, and turn 7e5fc00f spent 1 h 19 m there
  and committed nothing. `runModelTurn` now buffers the provider's side in its
  own fiber, so the response keeps draining while a frame is in flight. The
  buffer is unbounded on purpose: a finite one suspends its producer when it
  fills, which is the same stall one buffer-length later, and nothing bounds a
  turn's event count to a figure the host could pick — `fastModelFallback`
  strips the output token limit for a route that does not support one. Long
  replies were the ones that hung, because a long answer is still arriving when
  the first frame is committed.

### Added

- A hosted chat turn records what it consumed and what it called back (#3812).
  `@smthrs/model-host` writes bounded diagnostics to the guest's own standard
  error: the provider stream it subscribed, that stream's first event and the
  events and characters it took off it, and each `provider-started` and
  `commit` callback the host attempted, by batch, with its answer. An operation
  that has not finished repeats as pending, so a turn stuck between an upstream
  response and a journal commit is readable while it is still stuck. A record
  carries counts, flags and short tokens only.

- A run's records say where its time and tokens went (#3844). Every field is
  optional on read and listed as late in the trail's identity, so a run
  journaled before it resumes without re-publishing its prefix.
  - `control.agent.model-settled`: `scope`, `frame`, `attempt`, `purpose`,
    `reask`, `stages` (`firstEventMs`, `firstThinkingMs`, `firstOutputMs`,
    `lastOutputMs`), `tries`, `output` (`thinking`, `written`), and `timing`
    and `servedTier`, the model package's wire record of the same call.
    `control.agent.model-requested`: `reask`.
    `control.agent.model-failed` is a new record: a model call that began
    and did not settle, with `scope`, `frame`, `attempt`, `purpose`, `reask`,
    `code`, `httpStatus`, `durationMillis`, `stages`, `tries` and `timing`. It
    takes no ordinal in its frame, so a run journaled before it resumes with
    every later row where it was. The engine port reports a failed try's wire
    timing through `EngineLike.FailedTimings`, because the failure it re-raises
    from its record no longer carries it.
    `control.agent.model-retried`: `elapsedMs` and `httpStatus`. Both retry
    emitters now fill them on `ModelEvent.Retry`: the boundary that retries a
    try on the same seat, and the failover to the next seat.
  - `control.agent.compaction-settled`: `causes`, `scope`, `frame`,
    `durationMillis`, `context` (`before`, `after`), `marksCall`,
    `summaryCall`.
  - `control.agent.supervisor-settled`: `triggers`, `compact`,
    `compactSuppressed`, `costUsd`, `costSource`, `timing`.
    `control.agent.decision-settled`: `timing`.
    `control.agent.steering-drained`: `compact`.
    `control.agent.claim-demanded`: `costUsd`, `costSource`.
  - `control.agent.turn-closed`: `frame` and `time` (`wallMs`, `modelMs`,
    `cellMs`, `judgeMs`, `compactionMs`, `otherMs`; the last five add up to
    the first).
  - `control.agent.cell-settled`: `work` (`kind`, `calls`, `callMs`).
    `control.agent.cell-call-settled`: `durationMillis`, `code` (why a failed
    call failed; `flow_failed` for a flow's own failure) and `reason` (the
    `tag` and `code` of the handler's failure, identifiers only).
  - `control.agent.cell-call-started`: an `input` too large to journal keeps
    its scalar fields of at most 256 bytes each (4,096 together) beside
    `truncated`, `bytes` and `digest`, so a truncated `bash` call still says
    its `container`, `cwd` and `interpreter`. The record's identity hashes
    the marker alone, as it did.
  - `flows.agent.usage.v1` (`Budget.UsageRecord`): `purpose` and `frame`, read
    from `EngineLike.Spend` where the call is made, and `parts` (`purpose`,
    `spent`, `costUsd`) when one charge covers readings of more than one
    purpose. A reader totalling by purpose takes `parts` in place of
    `purpose`; the totals add up to the run's spend. This is a durable wire
    addition: records without the fields still decode and recover.

- `AgentSession.Options.reentryCheckpoint` runs host controls before entering
  or resuming a retained module, including an unfinished child holding a question.

- `control.agent.model-requested` journals the step's `task` (its task system
  part) bounded on its own, so the monitor keeps a step's input when the whole
  system text is too large to journal (#3514).

- `AgentAction.make` accepts `claimCap`, overriding `Host.claimCap` for one
  step. A module flow can now mark a step whose completion is an answer
  (`claimCap: 0`) so the completion claim brake does not refuse it as an
  unrecorded claim, and the step runs without a reachable judge.

- `AgentAction.implement` attaches the existing agent implementation to a
  canonical prompt flow's declared action without rebuilding its flow (#1799).

- Budgets accept `onExceeded: "park"`. Hosts provide `Budget.Parking` to
  request approval; `Budget.raise` and `raisedBy` apply approved ceilings.
  Exhaustive `OnExceeded` matches must handle `park` (#1843).

- `AgentAction.Host.serverTools` and `Agent.Options.serverTools`: provider-run
  tools, such as the provider's web search, forwarded to every frame.

- `RunawayGuard.layerFlowLimit(flowName, limitMillis)` bounds each drive of a
  registered module flow by the tool-call guard: past the limit the run parks
  on `Stuck` `tool-call` facts for Continue or Stop (#2279).

### Changed

- M-49 relocates exported `decisionsDirectory` and template/effect path literals
  to the `.smithers/` layout. Update consumers to the relocated paths and stop
  relying on the old literal types.

- `AgentAction` and `Agent` arm no completion judge by default: `claimCap`
  omitted on the action and the host leaves the claim brake off, and a
  positive cap arms it. A workflow that wants a model to read its completions
  says so (#3993).

- `control.agent.compaction-settled` writes the tokens its removed messages
  held as `removed`. It wrote `removedTokens`, a name the journal reads as a
  credential, so every stored row held a placeholder in its place (#3844).

- Model step keys moved when `ModelEvent.Settle` gained `timing` and
  `servedTier` and `Retry` gained `elapsedMs` and `httpStatus` (1ae37f2b82). A
  run journaled before that commit and resumed after it asks the provider
  again for the model calls in its prefix; finish in-flight runs on their
  original revision.

- Sealed model/cell identities changed when the harness added
  `approval_unavailable` (#3161, #3317). The preceding rc.115 model key
  `key1_91d1fb4d…` and cell key `key1_425bb2ae…` are preserved as historical
  vectors; the current keys are `key1_3f683043…` and `key1_1e7f6586…`.
  Both changes come solely from the error declaration fingerprint. The same
  Effect lock alone does not preserve these cache addresses: in-flight runs
  must retain their original producer/declaration snapshot. A current host
  uses new addresses and must not treat an old recorded call as their answer.
  SQLite reopen regressions retain each declaration and verify replay without
  redispatch; unchanged wire schemas still replay through the current agent port.

- **Breaking:** `Seat.auto` routes by the maintainer's routing graph. Jev
  answers phase, size, clarity and binary success (plus the variant) in one
  call, and `SeatRouter.plan`, `backupsOf` and `fit` pick the seat, its
  backups and, for important plans and reviews, an Opus/Fable/Astra panel
  merged by Fable. `SeatRouter.Service.candidates` is now the available seat
  ids; `SeatRouter.Candidate`, `seatInstructions`, `maxCandidates`,
  `State.parent`, the `only` decision and `too_many_candidates` are removed.
  `Decision` records `answers`, `backups` and `panel`; `SeatRouted` gains
  optional `backups` and `panel`. `route` takes `panel: false` for a caller
  that does not fan out, which `AgentSession` passes. `AgentAction` takes an
  optional `phase`, runs a panel's members in parallel and then the merger on
  the survivors' answers (`SeatRouter.mergePrompt`), and fails over along the
  route's backups. `fit` gives panel members that land on one seat the union
  of their backups, less the seats on the panel, and a panel reduced to one
  member is that member's chain. One member's quota park still suspends the whole
  execution, so its siblings wait for that reset.
- The recorded `agent/route-seat` decision moved with `DecisionSchema`, which
  its key folds in. A run recorded before this change asks Jev again when it
  resumes and may route to a different seat.
- `AgentAction`'s recorded quota park is named per session
  (`agent/quota-park/<session>`), so parallel panel members park independently.
  A run parked before this change classifies its refusal again when it resumes.
- The sealed model step key moved to `key1_71b2f391…` because
  `@smthrs/capability`'s `Action` union gained `memory:read` and
  `memory:write`. Runs recorded under the old key re-dispatch their model calls.
- The sealed model step key moved to `key1_674672c5…` because
  `ModelEvent.Settle` gained `sessionId`, which `RecordedModelStep` embeds.
  Runs recorded under the old key re-dispatch their model calls.
- The sealed model step key moved to `key1_15a4c259…` because
  `ModelErrorCode` gained `out_of_credit`, which the step's error schema
  embeds. Runs recorded under the old key re-dispatch their model calls.

### Fixed

- A terminal credit refusal (`quota_exceeded` or `out_of_credit`) skips its
  account in later frames of the same agent invocation; explicit model scope
  skips only that model. Timed quota cooldowns still recover on durable resume,
  including when a backup must wait after the primary exhausts credit. Fresh
  runs can retry replenished credit; cancellation remains terminal for
  the cancelled execution (#3043).

- A latency budget's clock starts at the run's first budget decision again.
  The resume an engine port records when it is built had started it, so setup
  before the first model call was charged to the allowance.

- Workspace observation can omit exact host-owned paths without hiding other
  files with the same basename. The TUI excludes its session subtree and log
  from mutation accounting ([#2009](https://github.com/smithersai/smithers/issues/2009)).

- Ordered fallback seats now try the next model after context overflow or HTTP
  5xx failure without inventing a quota park ([#1797](https://github.com/smithersai/smithers/issues/1797)).

- `AgentAction.Host.approvalChannel` forwards the attended-host setting into
  agent steps. TUI and served hosts arm it; unattended hosts default to false
  ([#1784](https://github.com/smithersai/smithers/issues/1784)).

- A run the engine re-drives for a host that died mid-run is claimed in the
  control plane before it executes, so its status writes are its own instead
  of failing `ClaimLost`.

### Added

- Agent actions and markdown flows accept an ordered model list. The first seat
  is primary; the remaining seats are fallbacks, preserved through durable
  invocation and replay ([#1796](https://github.com/smithersai/smithers/issues/1796)).

- `control.agent.model-requested` and `control.agent.decision-settled`: the
  request a model call was asked and the decision a classifier made, journaled
  with the `scope` and `frame` that join each to its turn.
  `GenerationParams.maxTokens` is written as `maxOutput`, because the journal
  redacts a key ending in `token`. On a module step both are step facts,
  committed inside the step's own boundary. The executor writes them without
  advancing the frame ordinal, so a run journaled before they existed still
  deduplicates its prefix when resumed.
- A `model-requested` record holds what its call added to the previous record
  of the same `scope` and `purpose`: `prefixCount` and `prefixDigest` name the
  leading messages the two share, `messages` is the rest, and `system` is
  written only where `systemDigest` moved. A hundred-frame run journaled its
  system teaching a hundred times and its transcript quadratically, and once
  the transcript passed one field's bound every later call was unreadable; the
  trail now grows with the transcript, and a reader rebuilds a call by walking
  back until `prefixCount` is `0`. `AgentSession.tracer()` is the fold that
  keeps the previous record's digests, one per incarnation, and
  `AgentSession.trace(event, previous?)` stays pure. `AgentSession.RequestTrail`
  is what it keeps.
- Each rebuildable field travels with its pre-journal digest (`systemDigest`,
  `messagesDigest`, `paramsDigest`, `stateDigest`, `questionsDigest`,
  `answersDigest`). The journal's redaction rewrites text that only looks like
  a credential (`maxTokens: 4096`, `secret = hunter2`) and marks nothing, so a
  reader re-digests what it read and treats a mismatch as "redacted, not
  re-askable", the way it treats `truncated`.
- Bounds: `system`, `params`, `state`, `questions` and `answers` are each
  bounded by `AgentSession.maxTracedBytes`; the messages of one record share
  one such bound and each is replaced by its own marker past it. A record with
  any marker carries `truncated: true` so a reader reports it unavailable
  rather than rebuilding it from what fit.
- `decision-settled` writes `questions`, `answers`, a choice question's
  `criteria` and an answer's `probabilities` as arrays of entries (`{ id, ... }`,
  `{ option, description }`, `{ option, p }`). They were records keyed by names
  the classifier's author chose, and the journal replaces the value under a key
  such as `auth` or `session`.
- `FlowEngineLike` implements `EngineLike.resolve` from the credential-free
  prepared request, and `Agent` wraps it so the recorded request is the one its
  `cellModelRequest` plugins rewrote. The waterfall's exit is held per request,
  its failure included, so each plugin runs once per model call on success and
  on failure. A waterfall that fails, or a request no route accepts, resolves
  to none: no `model-requested` is written and the sealed step reports the held
  failure, so no record presents a request that was never sent.

- `ScriptedJudge.layer` is an explicit completion-only offline fixture that
  compares command claims with recorded evidence and refuses other questions.
  Whole-host scripts must dispatch all their classifier question IDs; see
  `flows/test/fixtures/scripted-judge.ts`.

- `StandardFlows.classify(services, options?)`: the cell's doors to Jev as the source `std/classify`, binding the ad-hoc `classify` flow and one `classify/<id>` flow per curated classifier (the three from `@smthrs/std` by default) over the `Evaluator` service. An explicit classifier outage fixture binds `Evaluator.layerUnavailable()` and every call resolves `{ ok: false, error: { code: "flow_failed", message } }` with a message containing `unreachable:` after the binding's `Flow classify failed:` prefix.

- `StandardFlows.memory(services, scope?)` and `StandardFlows.MemoryScope`
  (#1700, in part). With a scope, `remember` and `recall` are bound through
  `WithMemory.withMemory` and `Flows.handlersFor`: a bank outside
  `scope.policy.namespace` fails with `invalid_namespace` before any I/O, a
  recall naming no bank reads the policy namespace, and `recall: "none"` and
  `retain: "never"` behave as `@smthrs/memory` defines them. `scope.provenance`
  is recorded on remembered facts. The policy and provenance are the bindings'
  declaration identity, so a sealed recall recorded under one scope or run is
  never replayed into another. An invalid policy binds nothing and fails
  catalog composition with `assembly_failed`. Without a scope, the binding is
  unchanged.

### Changed

- `control.agent.vacuous-verification-observed` now projects `callDigest` where
  it projected `signature`. The journal's redactor treats `signature` as a
  sensitive field name, so the identity the row is reconciled against its
  `cell-call-settled` record by was written as `[REDACTED]`.
- **`Agent.run` and every `AgentAction` layer now require
  `Evaluator.Evaluator`** from `@smthrs/model`. The harness's sixth brake on a
  completion never falls back: a claim nothing could judge fails the run as
  `HarnessError` `completion_unjudged` rather than standing, so a host that
  binds no transport does not compile instead of quietly losing the brake.
  Bind `Evaluator.layerFromEnvironment(process.env, "my host")` before opening
  resources, or deliberately bind an evidence-based scripted judge. A host
  missing `AI_GATEWAY_API_KEY` now fails to boot instead of every completion. `Agent.layerDefaults` is unchanged and
  still supplies only the sandbox and the steering source: the evaluator is a
  decision about where the host's key comes from, not a default.
- `SeatResolver.contextWindowTokensFor` now re-exports
  `ModelCatalog.contextWindowTokensFor` from `@smthrs/model`, where the provider
  window table now lives. The resolved numbers are unchanged.
- `AgentSession.trace` types every event type it journals as
  `Transcript.ControlEventType`, so the `control.agent.` namespace this package
  writes and the one `Transcript.validateJournal` reads back cannot drift apart
  without a compile error.

- Preserve the sealed cell-call key and encoded result schema from before A2
  admission hardening. Success/failure validation remains at construction and
  decoding, and the port validates host results before persistence with typed
  causes. The pre-A2 golden `key1_8ab29627...` is unchanged, with canonical
  material and SQLite reopen/resume regressions. Intermediate builds with the
  result-schema filter require finishing their runs on that build; no stored
  key or approval is rewritten.

- Approval asks now read the explicit durable `Approved` or `Denied` token
  instead of inferring a decision from grants. Pending or unreadable decisions
  fail closed; denial still returns `approved: false` to the caller.

- `AgentSession.requestCancel` now records logical-run intent atomically across
  trampoline rounds. A completed predecessor no longer makes a live successor
  look terminal. Execution observation follows the current round's lifecycle
  while preserving the requested run's identity; see the API's snapshot and
  separate-control-database limits.

- Validate every supplied usage counter before choosing or aggregating a token
  total. Negative or non-finite components cannot be hidden by a valid total or
  cancel against another attempt. `tokensOf` returns `NaN` for malformed
  components; durable accounting refuses them without poisoning the tally.
- Budget acquisition now validates and snapshots its configuration, failing with
  `Budget.ConfigurationError` for invalid ceilings, exceeded policies, or cache
  bounds. `make`, `layer`, `layerFromEnvelope`, and `AgentSession.Options.budget`
  expose that typed failure. Omit ceilings for no limit; infinity is not valid.
- Reported usage before an unsealed capacity refusal or stream interruption is
  charged under a distinct invocation receipt. It survives journal recovery
  without giving a later provider retry a paid sealed-step marker. Partial
  failed text is still discarded; cumulative counters count once per attempt.
- The model action's encoded failure contract includes infrastructure failures
  from receipt allocation and usage persistence. Corrected its stale unreleased
  golden to `key1_b5b3584a…`: review baseline `a49b68ef7d` and the release fixes
  produce byte-identical canonical preimages under Effect `4.0.0-rc.112`, with
  the cell-call golden unchanged. This is a fixture correction for the first
  release, with no runtime or schema alteration. Schema representation is key
  material, so future dependency upgrades must verify these vectors as well.

### Fixed

- A model rate limit no longer cools every model on the same account route.
  Cooldowns use route and model identity, preserve longer waits across resume,
  and honor explicit `ModelError.quotaScope`. Generic rate limits default to
  model scope; shared quota and overload retain account scope. Hosts that
  know a rate limit is shared must mark it `quotaScope: "account"` instead of relying on the previous broad default.

- A parked run is re-driven only when a resume has actually been delegated.
  Every engine round for a run parked on its own ask used to claim the park,
  replay every settled frame, and suspend on the same ask again, once per
  heartbeat, for as long as the run waited on a human. Nothing had asked for
  that resume, and the incarnation that eventually consumed the operator's
  decision could be one that had read the run's durable history before the
  operator touched it, so a check the body makes on entry (the journal format
  refusal) was made against a history the completing incarnation never saw.
  `Control.approve` records the delegation before it hands over the decision,
  and `drainPendingResumes` polls for delegations taken in another process, so
  no resume loses its host.

- An ask answered through `Control.signal` re-drives the run that asked it.
  `Control.approve` is not how a `HumanTask` or `WaitFor` park is ever
  answered: the gateway's `Approval.Submit` routes a human-wait target to
  `Control.signal` (`ControlExecutor.answerableWait`), `smithers signal` calls
  it directly, and every flow-authored ask parks on one. That path completes
  the engine's durable wait point and recorded no resume delegation, so the
  round the engine scheduled next was refused as unrequested and the run stayed
  `waiting-approval` on the question the person had just answered — a job that
  never resumed when somebody approved it. `AgentSession.deliverSignal` now
  records the delegation on every `delivered` answer, including the retry of an
  answer whose first attempt died after the completion, and the
  `ControlExecutor.deliverSignal` port takes it up in the call that answered,
  so an in-process answer does not wait for the one-second poll and an answer
  delivered in another process still reaches the host that parked the run. The
  round that takes a delegation up now clears it, so one answer buys exactly
  one re-drive and a later park is not re-driven by a standing row.

## [1.0.0-rc.0] - 2026-09-01

### Added

- Added `defaultModelRetryWindowMillis` (45,000 ms), a wall clock on the transport retry ladder. Five rungs bounds how many attempts are made, not what they cost: r92 of the SWE-bench full benchmark burned ten `transport` retries and $0.85 across two instances against a socket that stayed dead for half a minute, and each of those attempts re-sent a whole prompt and streamed a partial body before dying. The window is the declared ladder's own jittered ceiling plus a rung's headroom, so a transport that fails fast still gets all five rungs, while one whose attempts are slow stops when the window closes. Elapsed time is the schedule's own, on the injected clock.

- `AgentSession.trace` now journals `control.agent.vacuous-verification-observed` with its payload — the stored check, the flow, and the controller's identity for that call — rather than letting it fall through to an empty one. The control that emits it is unwired from `CellTurn` as of the r93 verdict, so no new run produces the row; the mapping stays so the r93 journals that carry it keep reading and so a controlled re-measure needs no change here.

- Added `StandardFlows.tests`, which binds `@smthrs/std`'s `test` flow to a
  host's `TestRunner` declaration. A tool no production composition offers is a
  tool that does not exist, which is the same reason all seven filesystem flows
  are bound rather than two.

- `StandardFlows.shell` now supplies a `Container` transport, defaulting to the
  docker/podman CLI, so `bash`'s `container` field means something in the
  production composition. Without one the field resolves `{ ok: false }` with
  "this host has no container transport", and the agent goes back to typing
  `docker exec c bash -lc '…'` itself — the quoting stack that cost the measured
  SWE-bench program twelve failed probes and one instance's most expensive frame.
  A host with a different route passes its own transport; a host with neither
  docker nor podman fails the spawn with the shell's own "not found", which is
  the honest answer.

- Journaled `control.agent.discipline-armed` once at run start with the
  read-only and frame caps and every effective sandbox limit, so a run that
  never reaches completion still proves what it armed.

- Added `Agent.Options.readOnlyCap`, armed by `AgentSession` for every task run
  (`AgentSession.Options.readOnlyCap`, default `CellTurn.defaultReadOnlyFrames`).
  It caps consecutive frames that write nothing; a run that is meant only to
  answer leaves it unset.
- Journaled `durationMillis` on `control.agent.model-settled`, the wall-clock
  duration of that one sealed model call.
- Added `Seat`: the resolved seat record, `Seat.modelIdOf`, and the typed
  `Seat.SeatUnresolved` failure. The declared half stays an unvalidated string,
  because the resolver owns the seat vocabulary.
- Added `SeatResolver`, the host seam that turns a declared seat string into a
  live model. `AgentSession` and `AgentAction` both take it as a service instead
  of a `resolveSeat` option, so a composition installs one resolver rather than
  threading a function through every entry point. The context-window catalog
  moved here as `SeatResolver.contextWindowTokensFor`.

- Placed the run's task prompt in a prefix segment so it survives every frame; it previously lived in the rebuilt tail and vanished after frame one.
- Widened the sealed step's transient retry to five one-second-doubling attempts; a destroyed HTTP/2 session outlives a half-second backoff.

- Made agent reasoning effort configurable: the flow's `effort:` frontmatter wins, then the host's `Options.reasoningEffort`, then the `high` default.

- Defaulted every executor-launched run to medium reasoning effort; an unset effort left the model with near-zero thinking budget.

- Added durable `control.agent.*` trail projections with occurrence timestamps
  and bounded failure causes for executor runs.
- Added workspace-relative file boundary conversion for cell calls.
- Added transient sealed-model retries while preserving non-retryable model
  failures.

- Added package-owned documentation: `docs/Manifest.ts`, `docs/`, and
  `scripts/docs.mjs` generate `docs/pages/api/agent.md` from the package's own
  JSDoc and prose, so the API page has one source rather than three.

### Changed

- Production `Agent.run` now reports each failed `configResolved` observer as
  one warning with only its stable code, plugin, and hook. Startup remains
  nonfatal and the observer cause is never copied into the log record.
- Renamed the cost field of the durable `flows.agent.usage.v1` payload from
  `tokens` to `spent`, and gave the payload an owning schema,
  `Budget.UsageRecord`. `@smthrs/journal`'s redactor strips one trailing plural
  and tests the suffix, so `tokens` read as a credential and the production
  `SqlJournal` persisted `"[REDACTED]"` where the number was. Every usage record
  written under a real journal therefore came back unreadable, and the old read
  side dropped it silently, so a resumed run recovered nothing and was handed
  its whole token allowance again. Records written under the old name do not
  decode; they never carried a readable number either.
- Made durable budget recovery fail closed. A `flows.agent.usage.v1` or
  `flows.agent.budget-started.v1` record that does not decode now raises
  `Budget.AccountingUnavailable` naming the entry's sequence and journal source,
  instead of contributing nothing to the ledger.
- Made the latency budget's clock zero durable. The first budget question of a
  run writes `Budget.budgetStartedEvent`, and a later incarnation recovers the
  earliest recorded zero, so a park, reclaim, or process restart no longer
  re-arms the whole `milliseconds` allowance.
- Fixed `QuotaPolicy.parseDelay` reading "retry after 5 minutes" as five
  seconds. The `retry-after` pattern made its unit optional, so a minute- or
  hour-scale wait woke sixty or thirty-six hundred times too early and burned
  every park the step was allowed.
- Fixed the bare `Retry-After` pattern reading a PREFIX of a number whose unit
  it does not know. Its trailing lookahead forbade a unit word but not a digit,
  which a shorter capture satisfies: `Retry-After: 120ms` parked for twelve
  seconds and `Retry after 12 days` for one. An unknown unit now falls back to
  `defaultWaitMillis`, which is what the module always claimed it did.
- Made `StandardFlows.clock` clamp an invalid `maxSeconds` to
  `defaultMaxWaitSeconds` instead of comparing against it. `NaN` made every
  ceiling test false and `Infinity` admitted an unbounded park, so a host could
  remove the wait bound while the documentation said hosts may only lower it.
- Bounded the remaining two trail fields at `AgentSession.maxTracedBytes`:
  `cell-call-started`'s input and `cell-call-settled`'s failure message. A
  `write` carries its whole file in the input and a test runner writes megabytes
  of message, so only the result value was actually bounded.
- Made `AgentSession.launch` carry the registry's typed failure on
  `LaunchFailed.cause` rather than its `toString`. `body_unavailable` and
  `body_unreadable` need different operator answers and a stringified cause
  offers no field to route on.
- Made `AgentSession.settlementFailure` render a non-JSON PRIMITIVE as text.
  `JSON.stringify` does not refuse `Infinity` and `NaN`, it rewrites both to
  `null`, so an arithmetic failure settled as the same recorded value as a run
  that failed with a literal `null`. The JSON round trip is now reserved for
  objects.
- Made a child start that succeeds without creating a run row a
  `ChildError { code: "failed" }`. `not_found` is the answer that tells a cell
  the flow does not exist here, and the declaration had already been found, so
  spending it on a runtime's refusal told the cell to give up on a flow it has.
- Made a latched `skip-remaining` budget report the refusal it actually latched
  on. A latency latch previously answered every later call with a fabricated
  `tokens` scope and `max: 0`.
- Added `cause` to `Budget.AccountingUnavailable`, so the journal error under an
  accounting failure keeps its tag and fields instead of being stringified.
- Taught `packages/agent/scripts/docs.mjs` to follow named re-exports. It read
  documented declarations and `export *` forms only, so
  `FlowEngineLike.defaultModelOverruns`, published with an `export { }` clause,
  had no row in the generated table. A re-exported member the target module does
  not document now fails the generator rather than disappearing from the page.
- Renamed the package from `@smthrs/engine-harness` to `@smthrs/agent`. The
  package is named for what it ships: the Smithers agent, plus the two adapters
  that run it.
- Renamed `CellHarness` to `Agent` and made it a `Context.Service`. The loop is
  reached through the `Agent` tag rather than a bare `run` export, so a future
  agent that drives a foreign CLI is another implementation of the same service.
  `Agent.layer` provides the production one, `Agent.layerNoop` a silent one, and
  `Agent.layerDefaults` the browser-safe sandbox and steering defaults the old
  `CellHarness.layer` provided.
- Renamed `HarnessExecutor` to `AgentSession`, and its durable flow id from
  `engine-harness/agent` to `agent/run`.
- Collapsed `Options.seat` / `model` / `route` / `contextWindowTokens` into one
  resolved `Seat.Seat`. There is now exactly one resolved-seat record, produced
  only by a `SeatResolver`.
- Changed the composition identity folded into every step key this package
  derives from `flows/engine-harness/composition/v1:` to
  `flows/agent/composition/v1:` (`FlowEngineLike.ts`). Every step cached under
  the old prefix therefore misses. That is intentional: pre-release identity
  strings track module paths, and the package moved.
- Changed the failure an `AgentAction` reports when the host cannot serve its
  declared seat. It is now `Seat.SeatUnresolved` rather than a `HarnessError`,
  and `AgentAction.AgentFailure` carries the new member.

### Removed

- Removed `FlowEngineLike.ChildRunner`, `FlowEngineLike.appendBatch`,
  `FlowEngineLike.Options.children`, and `FlowEngineLike.Options.plan`.
  `splice` now refuses an elaborated batch because the cell loop superseded
  the provider-tool-call path, and rc.0 does not ship API it does not support.

## [0.1.0] - 2026-08-05

### Added

- Initial release.

# @smthrs/opencode

## [Unreleased]

### Added

- A bounded retry over the evaluator this server binds
  (`Health.evaluatorRetry`, `Health.retryable`, `Health.retrying`,
  `Health.retryingLayer`): three requests, 250 ms apart, 2500 ms over each,
  8000 ms over all of them, which is exactly three deadlines plus the two
  waits, so the ceiling never truncates a request the count allows.

  The harness's completion brake never falls back: `CompletionClaim.read`
  fails the whole turn as `completion_unjudged` on any transport failure, and
  `Evaluator.layerVercelGateway` makes one request with no retries and says
  the caller decides the retry policy. This server is that caller, so one
  HTTP 429, one 5xx, or one connection that never opened used to end a task a
  person had waited through. Jev answers in about 300 ms, so the realistic
  failure is a blip and not slowness, and a blip now costs a wait instead of
  the run.

  Only a failure a second request can mend is asked again: `unreachable`,
  `timeout`, and `refused` carrying 429 or a 5xx. `invalid_question`,
  `invalid_answer`, `empty`, and `refused` carrying 401 or 403 are answered
  once, because asking again spends a person's seconds to reach the same
  sentence. The last failure is the one that surfaces, so the error still
  names what actually happened.

  The retry covers the whole evaluator the run shares, health included. The
  health dot cannot become slower to fail: `Health.evaluate` puts its own
  1.5 s deadline over the service call, so a gray dot still arrives within a
  second and a half, and what changes is only that a blip inside that
  deadline now has a second chance to answer. The keyless arm is not
  retried, and must not be: its `unreachable` is a key nobody exported.

- A startup preflight. `smithers opencode` refuses to start when the host can
  bind no evaluator, with `EngineDriver.noEvaluator` and exit 2:
  "smithers opencode needs AI_GATEWAY_API_KEY, because the harness asks Jev to
  judge every completion and fails a run it cannot judge. Export
  AI_GATEWAY_API_KEY (Vercel AI Gateway) and start again, or pass --scripted to
  replay the recorded turn without a model." `EngineDriver.evaluatorRefusal`
  asks what the host can provide, not what one variable says: a host that
  injects its own evaluator, which is what the tests and any scripted judge do,
  starts whatever the environment holds, and `--scripted` runs no model and
  needs no key.

  Before this, a keyless server started, answered a conversation, and failed
  the first real coding task. The turn ran two frames and settled the
  assistant message with `UnknownError` and "A completion no evaluator could
  judge (unreachable): health unavailable: set AI_GATEWAY_API_KEY to turn on
  health and classify", finish `error`, and the bug in the repository was
  still there. The harness made the completion brake mandatory and has no
  fallback by design, so the refusal belongs at startup, an hour earlier.

### Changed

- The completion brake's deadline is this server's own number, not an
  inherited one. `Health.evaluatorLayer` passes `timeoutMs: 2500` to
  `Evaluator.layerVercelGateway` in place of the library's
  `defaultTimeoutMs` of 1500 ms, which was chosen for a health dot on one
  frame and reached the completion brake only because the brake declares no
  deadline of its own. 2500 ms is about ten times Jev's measured answer,
  which is the room a judgement a whole task ends on deserves without
  waiting on a transport that is plainly gone. `@smthrs/model` is unchanged:
  only this host's option moved.

- `AI_GATEWAY_API_KEY` is documented as required to run a model, not as an
  optional key that grays the health dot. The docs, the verb's help text, and
  the banner say so.
- The verb passes its `--environment` through to the evaluator
  (`EngineDriver.Options.environment`), so the preflight and the layer read
  the same environment instead of the preflight reading the options and the
  layer reading `process.env`.

- The engine driver arms the harness's read-only cap at six frames
  (`EngineDriver.readOnlyCap`; the harness default is twelve): a turn that
  only reads or only prints is demanded an action at six read-only frames
  and stopped at twelve as `read_only_cap`, which closes as a red `stopped`
  health decision. The day-one drive on Cerebras spent 27 frames and 290k
  input tokens on "Say B" because the model printed the answer instead of
  calling `ctx.done` and nothing bounded the streak.
- Every turn carries the host's teaching (`EngineDriver.hostTeaching`) in
  its system context: answer a conversational request, or one the printed
  output already answers, with `ctx.done` in that same cell; call flows only
  when the request needs them; never run a command the person did not ask
  for.

### Fixed

- A rename or an archive made while a turn runs stays. `PATCH /session/:id`
  is applied on the turn's own queue and folded into the open turn
  (`Turns.update`, `Projection.adopt`), so the turn's next `session.updated`
  carries the new title behind one dot, or the archive stamp, instead of the
  title the turn opened with. The projection wrote the session from the
  title it captured when the turn opened, so a rename mid-turn answered
  with the new title and was gone on the next event (day-one drive, step
  k2, finding health-classify-6).
- Aborting a turn that is parked on a permission card takes the card down and
  leaves nothing spinning. `Turns.abort` now answers every pending request of
  the session with `permission.replied` and the reply `reject`, which is what
  the app reads to remove the card and what removes the row from the store,
  and the projection keeps the parked frame's cell open across the park so the
  close settles it as an error under the frame it opened in. Before this, an
  abort on that path settled the turn server side but the app kept the card
  and read the session as busy, and the cell part stayed `running` in the
  history forever.
- A gray health card names why and the way out: `health unavailable: set
  AI_GATEWAY_API_KEY to turn on health and classify` without a key, the
  transport's words or the deadline otherwise (`Health.unavailable`). The
  card was titled `health unavailable` and said nothing a person could act
  on. A card is still emitted on a color change only: one gray card at the
  first frame, one red card on a park, one gray or green card after.
- A rename that arrives with a dot in front of it (the app echoes the
  dotted title back, with U+FE0F after the dot) is stored behind the
  session's own dot, or without one when the session has no color yet
  (`Health.retitle`). Stored verbatim, the app's dot stayed in front of the
  words and the next color change put the server's dot in front of that.
- The message a rejected call settles with says the harness's generic
  `capability_refused` hint beside it ("This run cannot reach that flow")
  is about the flow, not this call, and that the flow stays available for
  commands the person allows (`EngineDriver.deniedMessage`).

- A route the server does not mount answers the JSON 404 the mounted routes
  answer, with the allow headers when the origin is allowed: the router
  failed an unmatched route past the CORS middleware, so every v1 route the
  app calls that this server lacks (revert, fork, share, and the message and
  file reads below) surfaced in the browser as a CORS network error the app
  retried instead of a 404 it handles.
- `GET /session/:id/message/:messageID` answers `{info, parts}` (the app
  fetches a reply's prompt by id when the prompt lies outside the last
  twenty messages), `GET /file/content` answers a file under the served
  directory (a click on a file in a read card), and `PATCH /project/:id`
  echoes the project (a rename from the app).
- Message paging names its cursor: a `GET /session/:id/message?limit=N`
  page with older messages left sends `X-Next-Cursor` and a `Link`, exposed
  to the app, and no limit answers the whole history, the way 1.18.31 does.
  The app marked the history complete when the header was absent, so a
  session longer than twenty messages lost its beginning on reload.
- A failed call card leads with what was called: the app's error card
  shows the words before the first `:` of the error in its header and the
  rest in its body, so a failed shell reads as the command and the reason
  (`node test.mjs: This host pins no trees ...`) instead of "Shell Failed"
  over nothing.
- The `/file` listing behind the app's folder picker leaves out directories
  whose name starts with a dot, so the picker no longer offers to open the
  project at `.git` or `.smithers`.
- `GET /event` streams the bare `Event` (`{id, type, properties}`) of the
  1.18.31 OpenAPI; `/global/event` keeps the `{directory, project, payload}`
  envelope the app folds. A v1 client on `/event` (the SDK's
  `event.subscribe`, the TUI) read `event.type` as undefined on every frame.
- Each event stream's live queue is bounded to the replay depth (256),
  sliding: a stalled consumer (a backgrounded tab, a half-closed socket)
  keeps the newest events instead of every event of every later turn for
  the life of the server.
- A classify card's title leads with the door it went through
  (`triage/relevance · 1 state · 3 questions · 212 ms`, or `ad hoc`), so a
  check/verdict card is told from an edit/risk card without opening it.
- The health dot reads the facts before the answers: a run parked on a
  permission, a question or quota, or ended by a cap, is red even when Jev is
  unavailable or unconfident (day one, with no gateway key, a park showed
  gray).
- A store write that found the engine holding the database is retried:
  `Turns.isLocked` reads the lock off the `SqlError` reason, where
  `String(cause)` never said "locked", so a bash card no longer stays running
  after its call completed.
- `EngineDriver.layer` builds the engine once: the notification queue is
  carried out of the registration instead of building a second engine over
  the same file, so the process holds one connection and one coordinator.
- Stop settles the turn at once: an interrupted turn no longer waits ten
  seconds for a result a cancelled run never publishes, `Projection.close`
  ends every open cell and call card as an error, and a resume the engine
  cannot drive (a row that is gone or already cancelled) settles the turn
  instead of leaving the session busy.
- A prompt the running turn could not take (typed right after Stop) opens
  the next turn once the projection closes instead of vanishing; the
  conversation tail skips the synthetic run summary.
- Allow always covers the pattern the card showed (`bash cat *`), not the
  whole flow; a later command with another first word asks again.
- A seat the provider refuses is reported with the seat, the code, the HTTP
  status and the provider's message verbatim on the assistant message (a
  refused key as `ProviderAuthError`) and on the server log with the hint to
  pass `--seat` or set `SMITHERS_SEAT`.
- Shutdown ends every event stream first (`Events.close`, a `Connection:
  close` on the SSE response, a two second `Serve.shutdownTimeout`), so
  Ctrl-C with the app attached exits at once instead of after twenty seconds.
- The user message echoes the app's own text part id, so the app confirms
  its optimistic part instead of keeping two.
- A prompt retried with the same `messageID` runs once: the answer's id is
  derived from the prompt's (`Ids.reply`), so the same execution answers
  from its row, and `Turns.prompt` takes a stored prompt once. Part ids
  carry the message tail so a prompt and its answer never share one.
- The frame budget the engine arms is the budget health reports
  (`discipline-armed`), and the run summary counts frames, calls and Jev
  calls once across a replay.
- `Serve.layer` fails a refused bind with `BindRefused`; every fiber a
  driver or the turns start ends with its scope.
- `Health.strip` drops the emoji presentation selector (U+FE0F) the hosted
  app writes after the dot, and the space behind it, so a renamed or
  archived session no longer keeps an invisible character in front of its
  title. A rename to an empty title keeps the title the session had.
- Health cards sort under the frame whose settlement or park produced
  their facts. The engine re-drives a parked turn from frame zero and the
  journal replays what settled; every replayed settle asked Jev again with
  the park cleared, so after each park a gray card landed under frame 1, and
  the replay counted the frame, its calls and its demand a second time in
  the facts Jev reads. A replayed frame now hands out nothing and counts
  nothing twice, a park no longer consumes the demand flag the parked frame
  reads when it settles, and a turn closed while parked marks the last
  frame that opened.
- The assistant message reports the last model step's tokens, the way
  OpenCode does, and a `message.updated` follows every model settlement
  with them. The header summed every frame's tokens, so the app's context
  tooltip, which divides the message's tokens by the model's context limit,
  read `Usage 372%` after a long turn. The session keeps the turn's totals
  for cost, and a frame the journal replays after a park is counted once:
  every park doubled the tokens and the cost of the frames before it.

### Added

- `Pricing.pricingOf`: the published list prices of the starter seats, so
  the header's cost is a number; a host may still pass its own price.
- `Health.noGatewayKey`: without `AI_GATEWAY_API_KEY` the health card and a
  refused classify call say what to set; a refused evaluation is not
  counted as a Jev call.

- `Health`: the health color. After every frame the server asks Jev where
  the run is, whether it is repeating itself, and whether it needs a person,
  and prefixes the session title with 🟢, 🟡, 🔴, or ⚪. The rule is a pure
  function; the evaluation runs on its own fiber with a 1.5 s deadline and
  never touches the turn; a `health` card is emitted on every color change;
  a rename keeps the dot and an archive drops it; every decision is kept in
  the store as a `flows.opencode.health.v1` record.
- The cell's `classify` flows, with the three curated classifiers of
  `@smthrs/std`, bound over `Evaluator.layerVercelGateway` when
  `AI_GATEWAY_API_KEY` is set and `Evaluator.layerUnavailable()` otherwise.
  A classify call renders as a `classify` card.
- Cost: `session.updated` carries tokens and cost on every model settlement,
  the assistant header and the step-finish parts carry the seat's cost when
  the host names a price, and every turn ends with a synthetic run summary
  (frames, calls, classify calls, Jev calls, latency, spend).
- `EngineDriver`: the driver over the durable flow engine. One `Agent.run`
  per prompt as one execution of the `opencode/turn` flow in
  `<directory>/.smithers/opencode.sqlite`, shared with the store. A `bash`
  call asks the person first: Allow once is keyed by the call, Allow always
  is kept per session in the store, Deny settles the call as a failure the
  cell reads. Abort interrupts the execution and closes the message. A
  prompt on a busy session is a durable steer drained at the next frame
  boundary; a prompt on an idle session carries the conversation tail. A
  restart re-drives every turn that was open, and the projection updates
  the cards the app already has instead of drawing them again.
- `Store` keeps permission grants and open turns; `Turns` folds the
  projection on its own fiber, retrying store writes while the engine holds
  the database, and re-opens the turns the driver finds at boot.
- `Serve.layer` and `Serve.host` take the store from the host, so the engine
  driver and the routes share one database connection.
- Initial package: an OpenCode protocol v1 server over the Smithers agent
  loop for the hosted OpenCode app. Routes with the 1.18.31 response shapes,
  the `/global/event` stream with heartbeats and replay, a SQLite store for
  sessions, messages, parts and pending permissions, the pure projection from
  harness events to OpenCode events, the `Driver` seam, and a scripted driver
  that replays a recorded turn with a permission park.

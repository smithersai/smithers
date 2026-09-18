# @smthrs/opencode

## [Unreleased]

### Fixed

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

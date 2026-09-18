# @smthrs/opencode

## [Unreleased]

### Added

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

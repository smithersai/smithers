# @smthrs/opencode

## [Unreleased]

### Added

- The six routes the shipped OpenCode TUI asks for and the hosted app never
  did, so `opencode attach http://127.0.0.1:4096 --dir <the directory>` is a
  second client: `config.providers`, the synchronous prompt
  `POST /session/:id/message` the TUI prompts through, the permission answer
  `POST /permission/:permissionID/reply` it presses a card through,
  `GET /project/:projectID/directories`, `GET /experimental/capabilities` and
  `GET /experimental/console`. The first three are what a client cannot work
  without: a 404 on `config.providers` ended the TUI at boot with
  `Error: Route not found`, a 404 on the prompt route painted
  `Failed to send prompt`, and a 404 on the reply route left every permission
  card unanswerable. `POST /session/:id/message` answers with the finished
  assistant message and its parts, which is what `session.prompt` declares, so
  it holds the request for the length of the turn; `Turns.settled` is the wait.
  Proven by attaching the real TUI through a pseudo-terminal: one turn read a
  repository, ran `bun test`, fixed the bug the test caught and ran it again.

- `/skill`, `/formatter`, and `/provider/auth`, the three bootstrap routes the
  hosted app asks for on every boot and this server did not mount. The app's
  own route mock (`packages/app/e2e/utils/mock-server.ts` in OpenCode main)
  answers all seven of that group; four of them were mounted here and three
  answered a 404 the app retried.

- `Cors.preflightVary`: a preflight answer now varies on
  `Access-Control-Request-Headers` as well as `Origin`. The answer echoes both
  back, so naming only the origin let a shared cache serve a preflight cached
  for one requested header set against a request that named a different one.
  This is the defect OpenCode's own `corsVaryFixLayer` exists to repair.

- Two suites of assertions ported from OpenCode's own tests, each case keeping
  its upstream file and name so its provenance is readable:
  `test/AppContract.test.ts` from the hosted app's route mock, which is the
  minimum contract a server must answer for that app, and
  `test/UpstreamServerParity.test.ts` from `packages/opencode/test/server/**`.
  Shapes the 1.18.31 OpenAPI declares are asserted against the declaration
  (`test/OpenApi.ts` over `test/fixtures/opencode-1.18.31.schemas.json`)
  rather than against a hand-written literal.

- `test/LiveBugFix.test.ts`: the live end-to-end proof. It spawns the real
  verb over a real git repository with a planted one-character bug, on the
  real seat with a real Jev key, drives one prompt the way the hosted app
  does, and asserts the turn finished `stop`, the bug is fixed on disk, the
  repository's own test passes, a classify call answered with probabilities,
  a health decision carries a color, and nothing went `completion_unjudged`.
  It skips with a message naming both keys when either is absent.

### Fixed

- A crash the instant after a permission answer no longer strands the turn.
  `Turns.permission` publishes the reply, which takes the card down, before it
  forks the driver's answer, so a server lost in that window leaves a run row
  annotated `waiting: approval` with no card in the store and, when the fork
  never ran, no grant either. `resumeOnBoot` honored the annotation: it set the
  turn parked and re-drove nothing, `GET /permission` listed nothing for the
  app to answer, and the session stayed busy for good. A park is now honored
  across a boot only while its card still stands unanswered. Otherwise the turn
  is re-driven: a recorded `once` or `reject` grant carries the call through the
  gate the person already passed, and a park whose answer was lost is asked
  again under the same request id, which stands the card the app needs.
  Requirement R11. Reproduced live on 2026-09-19 on `cerebras:gpt-oss-120b`
  with a live gateway key, over a cell that ran `node marker.mjs` and then
  `sleep 20`, with the server killed the instant the second card was answered:
  the old code never finished the turn inside three minutes, and the new code
  finished it twice, in 21.0 s and 20.9 s, each time with `replay.log` still
  holding the marker's one line, one card per settled call, no part duplicated,
  and no second assistant message.

- A permission card can no longer outlive the turn that asked for it. A turn
  ends in two places and only one of them swept: the body's exit closed the
  projection through a `close` job that answered every card the person never
  answered, and the fold closed it too, on the harness's own `Aborted` and on
  a resolve. A turn that ended in the fold deleted its state there, so the
  exit that followed found no state and its `close` was dropped, and with it
  the sweep. That is the shape a Stop makes: the frame asks a moment after the
  Stop, `Aborted` closes the turn, and the row the ask wrote is still there.
  Measured on the final live drive: `GET /permission` listed
  `per_..._sleep 1 && echo late` for minutes while `GET /session/status`
  answered `{}`, and the hosted app pressed Allow more than forty times, 1.3 s
  apart, against a card nothing could clear. The sweep now runs wherever a
  turn ends, and a `close` whose turn is already gone sweeps rather than being
  dropped. `test/Turns.test.ts` drives the interleaving itself: a driver that
  asks and then reports `Aborted` before its exit, which reproduces the
  escaped row every run.

- An answer to a card whose turn is gone takes the card down instead of being
  refused forever. `Turns.permission` refused any row whose session had no
  live turn here, on the reasoning that a second server over the same
  directory must not answer the first one's cards. `Ownership` already
  settles that: a second server over a directory refuses to start. What the
  refusal actually produced was the only thing worse than a wrong answer, a
  card that can never be cleared, answering
  `Permission ... belongs to no turn this server is running` to every press.
  The row now goes down and `permission.replied` is published, which is what
  takes the card off the screen; the driver is not asked, because there is no
  parked execution to resume. Proven live on 2026-09-19 over HTTP with the
  real seat and a real gateway key, against a card standing over an idle
  session: the old server answered 404 with that sentence and left the row,
  and the new one answered `true`, published `permission.replied`, and left
  `GET /permission` empty.

- An ended run's reason names what ended it. `Projection.decided` writes a
  `health` card only when the color changed, which keeps a long run from
  growing one card a frame, and the end of a turn is the one decision that
  rule is wrong about. A run whose frame budget ran out while a permission
  card was open ended red under the red the park had earned, so the reason an
  operator read said `waiting for approval` about a card that was gone. The
  same silence masked every other terminal reason a red turn can end on: a
  seat out of quota, a claim the harness refused, a run it stopped. The
  turn's last reading is now exempt from the color rule and always writes its
  card, so `stopped: the frame budget of 2 is exhausted` is what the operator
  reads. The color rule itself is unchanged; it was never what lied. Measured
  live on 2026-09-19 at `--max-frames 1`: on the old server a run that ended
  `The frame budget of 1 is exhausted` carried one health card and it read red
  `waiting for approval`; on the new one the park's red is followed by red
  `stopped: the frame budget of 1 is exhausted`.

- The conversation tail marks a turn the person stopped. A stopped turn left
  a prompt in the tail with no answer under it, and the next turn's model read
  that as work still outstanding: the live drive pressed Stop on a parked
  `bash` call and the very next prompt asked for the same command again, twice.
  The fact the tail was missing is not that a call was denied, it is that the
  person ended the turn, so `Turns.history` says so
  (`Turns.stoppedTurn`) and the model stops treating the abandoned work as a
  request. The denial memory `EngineDriver` keeps is deliberately the turn's
  own and stays that way: a Stop is a verdict on the turn, not on one call,
  and a denial that outlived its turn would refuse a call the person's next
  prompt explicitly asks for. Measured live on 2026-09-19, a Stop on a turn
  parked on `sleep 30 && echo late` and then "Reply with only the letter A":
  three runs on the old server parked on `sleep 30 && echo late` again and
  never answered inside three minutes, and three on the new one answered `A`
  in 2.75 s with no card at all.

- The health dot tells the truth about a run that is over. Gray says one
  thing, "health is unavailable", and an operator who walked away reads it on
  an idle session as Jev having been down while the run carried on. Nothing
  was carrying on. Measured on 2026-09-18: a run the harness killed on an
  unproven claim kept a gray dot whose reason line read `failed`, which is the
  same dot a missing gateway key writes. Every turn that ends without an
  answer is red now, and the reason names what ended it, off a typed code
  every time and never off a sentence: `stopped: the run could not prove its
  claim`, `stopped: the run read for too many frames without writing`,
  `stopped: nothing could judge the completion`, and one line per remaining
  `HarnessError` code in a record the compiler keeps total. Only the
  operator's own Stop stays gray, because nothing about it is theirs to act
  on. `Driver.Outcome` carries the harness's own code as `HarnessStop` and
  `EngineDriver.harnessStop` reads it, live or as the JSON projection a
  replayed failure arrives as; 091697c6 typed the provider's code and left
  this one on the floor.

- A run its frame budget ended is red naming the budget, instead of green over
  the budget notice. The turn's last reading overwrote `lastTransition` with
  `complete` before it read the rule, so a run that answered nothing took the
  rule's arrival clause and finished green on `The frame budget of 40 is
  exhausted. The run stops here`. The real transition is kept now, and a
  resolved turn whose last transition is not `complete` is a turn its budget
  ended (`Projection.budgetEnded`): the run that finished says so first, and
  the run that ran out says nothing. Read off the transition, never off the
  notice. The loop's other budget exit, the check at the top of a frame that
  emits the answer and returns without closing the turn, reaches
  `Projection.close` as a body that exited `completed` and is read there the
  same way.

- A turn that finishes in one frame ends with a color. It ended with none: the
  turn is over before the frame's evaluation answers, and the final reading
  returned early when there were no answers to read. No dot is not honesty, it
  is a hole an operator cannot read. The rule has an answer without Jev,
  because rule 6's second clause is a fact and not a judgement: the harness
  handed a completion back, nothing is parked, and no demand is outstanding.
  Such a turn reads green `answered`, which does not claim a `done` nobody
  said.

- The completion the brake handed back is in the transcript. Until now the
  only copy was a `complete` transition inside `opencode.sqlite`, so a correct
  answer the brake refused was gone as far as the person was concerned, and
  the brake is not always right. The `demand` card carries it word for word,
  under a title that carries the two probabilities Jev read
  (`claim · complete 0.21, overclaims 0.96`) in place of the single word
  `claim`, which was the whole of that card when collapsed.

- One health call over its 1.5 s deadline no longer flickers the dot gray
  mid-run. It came up in four of sixteen measured turns and changed nothing
  about any of them. The deadline is not what is wrong: Jev answers in about
  300 ms end to end, the deadline is five times that, and the retry already
  gives a blip a second chance inside it. Calling one missing measurement
  "unavailable" is what was wrong, so a missed deadline keeps the color the
  run already had and every other transport failure still repaints gray at
  once, because those are the gateway saying it cannot serve the call.
  `Health.deadlineMisses` in a row does go gray, naming the streak, so a dot
  is never more than three frames older than something that confirmed it.

- A harness `Aborted` closes the turn as the interrupt it is. It is the event
  `CellTurn` sends from `Effect.onInterrupt` and nothing else, and it used to
  close as a failure, which reached the app as `UnknownError`.

- One Stop ends a turn whose frame parks a moment after it. The park and the
  Stop race: the engine records the cancellation before it interrupts
  anything, so a cancellation recorded ahead of the park's own commit turns
  that commit into a guard failure and cancels the run, and a park that
  commits first is swept for the same request. Either way the turn is over,
  but the driver reported the park its body saw, so `Turns` left the
  projection open, the session read busy for good with no card to answer, and
  only a second Stop got out of it. The park of a turn the person stopped is
  now read as that stop, and the wait for the engine to publish the park ends
  with it, which also takes ten seconds of polling off the abort. This is the
  race behind the flaky `EngineDriver > aborts a parked turn through the
  composition`: the card reaches the store before the park commits, so a
  test that aborts as soon as it sees the card was aborting inside the window.

- A driving turn is no longer closed twice by its own Stop. `interrupt` read
  whether there was a body to exit after telling the engine, and telling the
  engine ends the body, so a turn that settled while that call was in flight
  was settled again by the caller.

- One park announces one card. The engine drives a suspended execution once
  more of its own accord, which replays the frame and asks the same question
  again, so every permission park published `permission.asked` twice and a
  second card stood beside the one being answered. The ask is announced once
  per request id now, not once per drive; the replayed call itself still
  reaches the projection, which is what keeps the card's own part up to date.

- A second server over a directory another live server already serves refuses
  to start, names that server, and exits 2, the way the missing key does. Both
  came up with no refusal and no warning before: they share the directory's
  store and do not share their event hubs, so each client was told half of what
  happened, and the second server answered a card the first one had parked, took
  the row down on its own hub and left the parked turn busy for good. The new
  `Ownership` module records the server that holds a directory in
  `<directory>/.smithers/opencode.server.json` as an `OwnerId`, and asks the
  question the engine asks before it takes a run from a peer owner, with the
  engine's own probe: is that process still there, with `ESRCH` the one answer
  that means death (`Ownership.sameHostPidProbe` in `@smthrs/run-store`). A
  record whose process is gone is what a killed server left behind, so the next
  server replaces it instead of obeying it and nobody is locked out of their own
  directory. The claim is taken before the driver opens the store, because a
  second server that got that far has already re-driven the turn the store holds
  open. Two servers over different directories still serve, and so does stopping
  a server and starting it again.

- A history read reads the parts of the page it returns, not every part of the
  session. `Store.listMessages` paged the message headers and then read the
  whole parts table for the session, so one `GET /session/:id/message` on a long
  session took the entire transcript off disk, and paging back through it took
  it again per page. A page is the run of message ids between its first and its
  last, so the read is that range, over the index the parts table already has,
  and it takes three parameters whatever the page holds. A page with no
  messages in it reads no parts at all.

- A finished session keeps the color its last state earned. Three of eleven
  finished, idle sessions on a live keyed drive sat red "waiting for approval"
  with nothing pending, because `Health.decide` short-circuits on
  `facts.parked` before it reads any answer and `parked` was cleared only at
  the next `turn-opened`. Two changes. `Projection.replied` clears the park at
  the moment a person answers a permission or a question and asks for the
  color again from the same frame, because the answer is when the fact stops
  being true. And a turn that resolves reads the rule once more over its own
  final facts, nothing parked and `lastTransition` `complete`, and the last
  answers Jev gave, so the dot the session is left with is the color of its
  last state rather than of a park it has since passed. That last reading is
  the rule, not a gateway call, so the footer's count stays true and the turn
  ends when it ends; a turn nothing ever judged keeps no color. Design F6: the
  dot turns green and stays.

- The color rule no longer contradicts the answers it read. `stuck` was tested
  before `progress`, so the live drive ended a finished bug fix yellow
  "repeating itself (69%)" over `progress: done (89%) · stuck: yes (69%) ·
  needs a person: no (12%)`. A run that re-read a file on its way to a correct
  answer is not stuck, so arrival now beats repetition: a confident `done`
  (`Health.arrived`, at or above the confidence floor) or a resolved turn is
  green even when `stuck` is over its threshold. A demand issued this frame
  moved up with it, ahead of both, because a completion the harness handed
  back is a fact and not a judgement. The whole order is in `decide`'s
  docblock, in design section 3.3, and pinned by a table test over the real
  answer shapes.

- The run summary's `Jev N calls` counts every Jev call the run made. It
  counted the health evaluations and the classify calls only, so every
  completion-brake reading was missing: across a live drive the footers
  totalled 50 calls while at least one uncounted brake call happened per
  completion attempt, and a turn that failed because the gateway answered 401
  printed `Jev 0 calls · 0 ms · $0.0000`. Counting was the fix, not renaming:
  the brake is the run's most expensive question and the field would be a lie
  either way. `claim-demanded` now counts one call with the latency the event
  carries, counted once across a replay. And every health evaluation is
  counted where the fold asks for it rather than where its answer lands: the
  evaluation runs on a fiber of its own, a slow answer arrives after the turn
  ended and is recorded without being folded, so counting answers left the
  footer short of calls the run had already made. An instrumented live drive
  caught exactly that: the footer read `Jev 3 calls` where the gateway log
  held four requests. The time and the spend still come off what the gateway
  answered (`Health.gatewayAnswered`; only `unreachable` and `timeout` mean
  nothing came back, and spend counts only reported usage), so the brake and a
  refusal add calls and milliseconds without dollars.

- A batched `classify` card reports how long the batch took. Single-state
  calls read 319, 264 and 265 ms while every batch read about 1 ms, because
  the batch output carried no top-level `latencyMs` and the only fallback was
  the gap between the call's start and settle events, which the harness
  publishes in one tick. `@smthrs/agent-std`'s `Classify.askAll` now times
  itself and the batch output carries `latencyMs`, which the card and the
  summary's Jev latency already prefer.

- A turn the gateway refused to judge is a typed failure. A
  `completion_unjudged` reached the app as a bare `UnknownError`, against the
  house rule that every failure carries its class: a 401 on the judge is as
  fixable as a 401 on the seat, and the person fixing it has to be told which
  key. `EngineDriver.judgeRefusal` gives it the shape every other refusal has,
  against the judge's own seat (`judgeSeat`, never the run's), with the code
  off the transport's own (401 and 403 are `authentication`, 429 is
  `rate_limited`), the status, and the words verbatim, so the projection
  renders it as `ProviderAuthError` and a usage limit as a red dot naming the
  limit. `judgeFailureLine` logs it: the way out is `AI_GATEWAY_API_KEY` and
  the gateway's status, never another seat. A gateway that answered nothing
  names no provider, because the message already says whether it was
  unreachable, slow, or never installed.

- A `bash` call the cell wrote as program text no longer asks the person to
  approve a blank line, and no answer to it hands over the shell. `Bash.ts`
  takes a command line or a `script` an interpreter reads on standard input,
  and the projection read only `command`: a live keyed drive parked
  `{"permission":"bash","patterns":[""],"metadata":{"command":""},"always":["*"]}`
  for a legitimate hermetic call, so the card was an empty line and "Allow
  always" granted every command in the session. `Projection.bashSubject` now
  derives the subject from `script` and `interpreter` when `command` is
  absent, so the card reads `bash script: node -e 'console.log(1)'` and
  carries the interpreter, the arguments, the container, the working
  directory and the program itself. Such a call offers no `always` pattern at
  all, `EngineDriver.alwaysKey` is `undefined` for it, and an "always" answer
  is stored as the one request it answered. A containerised command now
  qualifies its pattern (`pytest * in container ci`), so allowing it in a
  container never allows it on the host, and a `bash *` row written by an
  older build matches nothing.

- The person is asked about a rejected call once. After a rejected `pytest -q`
  the very next frame called `pytest -q` again and parked a second identical
  card. The turn now remembers the subjects it had rejected, and a call that
  repeats one settles as `capability_refused` with
  `EngineDriver.repeatedDenialMessage` instead of parking, so the run reads
  that it was already refused and the person is not asked twice. The memory
  belongs to the turn; a new turn asks again.

- Every card this server invents now leads with the one line a reader needs.
  Neither client reads a card's `title` for a tool it does not know: the
  hosted app's `GenericTool` takes its subtitle from `input.description` and
  has no expanded body at all, and the TUI prints every scalar of the input
  untruncated. So the health card read "Called `health`" over `color=red`
  with its reason nowhere, the `cell` card put the whole frame program in
  its collapsed line, and the `classify` card put the task, the file and the
  excerpt in its own. The four cards now carry `description` first, so they
  read `needs you: approve the write`, `frame 1 · 3 calls · read-only`,
  `triage/relevance · relevant: yes (0.93)` and `read-only · 1/1`. The frame
  program and the classify call's state moved to the card's metadata.

- `Health.strip` drops every leading dot, not only the first. A person
  renaming a session pastes the echoed title back over a dot the app already
  wrote, so the words can arrive under two or three dots at once. Dropping
  one left the rest inside the stored words, where `Health.dotted` rendered a
  title with two dots in it (`🔴 ⚪⚪ New`) and `Health.colorOf` read a color
  out of the person's words that the server never decided.

- A stream that names no `Last-Event-ID` is replayed nothing. Every fresh
  `/global/event` connection was served the whole 256-event buffer, and the
  server sends no `id:` line, so no browser sends that header and every
  reconnect took the whole buffer. A second tab opened after four turns
  received four `permission.asked` for permissions already answered, showed
  four cards, and could take none of them down, because each card's
  `permission.replied` is in the same replay or older than it; clicking one
  answered 404. A stream that does name an id still gets the replay after it.

- A stream is told what is open as it connects: `Events.stream` takes an
  `opening` effect, and `Routes` fills it with the permission requests still
  pending. A turn parked on a permission published its ask before that stream
  existed, and a server restarted while a turn was parked re-drives the turn
  and publishes nothing, so the app reconnected to a session that read busy
  with no card it could act on and no way back but a page reload. Live proof:
  a turn parked, `SIGTERM`, restart, the reconnecting stream is greeted with
  the card, the answer resumes the turn and it finishes.

- A permission answer is refused when no turn of that session is running in
  this process. Two servers started over one directory share the store, so the
  second one found the first one's pending request, answered `200 true`, took
  the row down, published the reply on its own hub, and handed the answer to a
  driver with no turn to resume: the parked turn on the first server stayed
  busy for good and its own answer then 404ed. The answer is now refused with
  the reason, the row survives, and the server that owns the turn can still
  take it.

- A card the person never answered is taken down when the turn closes, not
  only when the abort sweeps. A frame that parks a moment after Stop writes
  its request after the sweep has run, and that card outlived the turn on a
  session the app reads as idle.

- `GET /session/:id/message` answers 400 when `before` is not a message id of
  that session. Such a cursor sorted below every row, so the answer was an
  empty page and the app read a broken cursor as the end of the history.
  1.18.31 answers 400, and so does the app's own route mock.

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

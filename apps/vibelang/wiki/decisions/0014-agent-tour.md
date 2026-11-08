# 0014. Learn more is a tour the agent drives

**Status:** accepted, 2026-11-07. **Rulings:** VL-28 (and VL-13, VL-16, VL-17); repository rules FLOW-3 and FLOW-5.
**Changes:** 0003 (three intents, three events, `pane`), 0010 and 0011 (two routes, three flows).

**Decision.** The splash's primary action is **Learn more**; **Ask the agent** (⌘K) and **Contribute** are secondary.
Learn more turns the page into the chat, and the agent tours VibeLang: it opens VibeLang's docs in a pane of the
conversation, says what each page is, and moves the pane as it goes. While it drives, a glow surrounds the screen and
an **Esc** button shows; Escape or Esc ends the tour at once.

```
Learn more ─▶ vibelang/StartTour   record (StartTour → TourStarted t<seq>) ─▶ dispatch
                                   ─▶ vibelang/Tour  tour/t<seq>
                                        race ┬ speaker: per stop, vibelang/docs/open (OpenPane → PaneOpened)
                                             │          then vibelang/tour/say (AppendReply → ReplyDelta), durable reading hold; FinishReply
                                             └ the tour ends (TourEnded, ReplyFinished or ReplyFailed)
Escape / Esc ─▶ vibelang/EndTour   end (EndTour → TourEnded)   the race interrupts the speaker
```

- **The state machine** (0003). A tour is an agent entry that answers no post (`inReplyTo` is `""`), so it streams,
  finishes and fails as a reply does, and while it runs the agent is `working`: a post asked meanwhile waits and is
  answered after it, and a second Learn more is refused `busy`. `OpenPane` moves the conversation's `pane` only while
  the agent's entry streams; `EndTour` ends only a tour, keeping what it said. Contracts prove each, and fourteen
  mutations of the new code are rejected (`pnpm verify`, `pnpm verify:broken`).
- **The flows** (`src/core/flows.vibe`). `vibelang/StartTour` and `vibelang/EndTour` run in the request that asks, as
  `vibelang/Post` does (0011). `vibelang/Tour` is dispatched like a reply: its own execution, in the conversation's
  object live (one execution at a time, 0010) and on the in-memory engine in mock. Its body races the speaker against
  the tour's end, so ending it interrupts the speaker wherever it is, mid-model-call included.
- **Live and mock run the same tour.** The stops are `STOPS`. The mock supplies the script's words (`TOUR`, `mockReplies.vibe`).
  The live speaker (`worker/Tour.vibe`) is smithers.sh's agent (0012), producing a schema-checked array of five real
  paragraphs as a durable `AgentAction`. Both feed `walk`, the same controller: open the stop, record its paragraph,
  await its reading hold, then advance. The day's budget admits the live narration first, as it does a reply.
- **The page** (`src/web`). Learn more opens this tab's own conversation, `tour-<session>`: the home conversation is
  shared by every visitor, and one person's tour must not take its agent. `tour` in the Model is the person's side of
  control (the glow and Esc); it ends at once on Escape or Esc, and when the tour's entry settles. The docs pane is an
  `iframe` of `pane`, with the splash pane's maximize and minimize. During the tour it uses that maximized pane,
  with the current narration beside it on desktop and below it on phones. Reduced motion: the glow is still.
- **Contribute** links to `CONTRIBUTING.md` on GitHub until the factory's own contribution features exist (roadmap
  bricks 2 to 4). It navigates, so it is a link styled as a secondary button.

## Design twice: how a server-side agent's pane action reaches the page

1. **A numbered event of the one state machine (chosen).** The tool records `OpenPane`; the sequencer decides it,
   numbers `PaneOpened` and publishes it on the conversation's event stream, and every client applies it with
   `receive`. Live and mock take the same path, a reconnect replays the pane with everything else, and the contracts
   prove that only the agent's streaming entry moves it.
2. **A directive in the agent's text.** The page would parse a marker out of the streamed answer and open the page it
   names. Rejected: the page would act on text, not on state; an answer quoting the marker would move the pane;
   `decide` could not refuse it; nothing could be proved; and a replay would have to re-parse history.

A third shape, smithers.sh's client-placed tools (`app/web/open` on `Placement.client`, 0012's table), needs the tab
to run the agent's tool and a channel back to it: the side channel the ruling forbids.

## Other choices

- **Ending is an event, not `ExecutionObject.cancel`.** Cancellation writes a permanent tombstone in the object,
  which would refuse every later reply execution in that conversation. `TourEnded` settles the tour in the state
  machine, the race ends the flow, and the execution completes normally, so the next post's reply starts after it
  (`test/live.workerd.test.vibe`).
- **The controller owns page timing.** The initial version let the model call open/say tools; it completed all five
  stops in seconds in production. The live agent now writes the five paragraphs once, as a journaled AgentAction,
  and the common controller presents them. This gives both backends identical ordering and holds, prevents concurrent
  model tool calls from skipping a hold, and keeps model spending separate from timer suspension and replay.
- **An ended tour still pays.** The race interrupts the agent before its journaled spend step, so a finalizer
  (`charged`, `worker/Tour.vibe`) records what it spent; the day's ledger adds a tour's tokens once.
- **Keep the docs and the words in view (production fix, 2026-11-08).** The tour automatically uses the existing
  maximizable pane (VL-17), outside the inert chat. At 1280×800 it puts the docs on the left and the current stop's
  paragraph on the right; on phones the docs fill the remaining height above that paragraph. Both stay inside the
  viewport independently of transcript following. The full transcript remains in the chat. Natural completion keeps
  the docs maximized until the person minimizes them; Escape or failure returns to chat. A fixed pane was chosen
  because a growing transcript cannot keep both its first pane and its latest words visible. This also preserves the pane's normal maximize/minimize behavior after the tour.
- **One paragraph per narration call.** Both speakers call the same whole-stop narration function. The sequencer
  adds a blank line before each paragraph after the first. The mock no longer adds separators its live counterpart
  lacks; neither the model nor the view owns paragraph boundaries.
- **Reading time belongs to the flow.** `narrate`, shared by live and mock `vibelang/Tour`, records a paragraph, then
  waits with `DurableClock.sleep` (`inMemoryThreshold: 0`): `max(4000, ceil(words × 60000 / 200) + 1000)` milliseconds,
  counting nonempty whitespace-separated words. This allows 200 words per minute plus one second to orient, with a
  four-second minimum. The final stop gets the same hold before control returns. The timer has the stop's stable
  identity and survives replay. The controller alone advances the pane, so model output cannot skip a hold. The live
  output schema bounds each paragraph to 65 words and 560 characters to fit phone narration. Escape wakes a parked tour through the memory
  engine's resume or the live object's resume and alarm, then the existing race and running guard end it. The full
  mock flow test advances the clock one stop at a time, awaiting each paragraph before advancing because Web Crypto
  digest promises are external to TestClock.
- **Escape inside the docs.** While the agent drives, the iframe is inert, outside the tab order, and cannot receive
  pointer input. Clicking it or attempting to focus it keeps keyboard control on the parent page, so Escape always
  reaches the tour. Ending releases the iframe. No cross-origin keyboard listener or document cooperation is needed.
- **Maximized means isolated.** Both automatic tour maximization and manual maximization make the background chat
  inert; the pane stays outside that subtree. Minimizing or ending releases the chat.
- **The tour is not a chat question.** Reply history excludes agent entries whose `inReplyTo` is empty. The visible
  tour transcript is retained, while later replies see only person posts and their successful answers.
- **Announce control without extra visible copy.** A persistent, polite, atomic Tour status region announces
  “Agent controlling. Escape to stop.” and “Tour ended. You have control.” The glow and Esc remain the visible UI.

**Observability.** Each step logs `vibelang.tour.<step>` (`start`, `end`, `wake`, `open`, `say`, `hold`, `run`) with its outcome and
counts `vibelang_tour_steps{step, outcome}`; the flows run in `vibelang.tour.start`, `vibelang.tour` and
`vibelang.tour.end` spans, reading holds run in `vibelang.tour.hold` spans; the live agent logs `vibelang.tour.agent` with its outcome and tokens, and dispatch logs
`vibelang.dispatch` with the tour's id. None carries what the agent said, a docs path or a person's words.

**Proof.** `test/conversation.test.vibe` (properties over the new intents, and the tour's transitions);
`test/tour.test.vibe` (the mock's whole tour through `Factory`; ending it; a post during it; the flows over the live
sequencer, the race interrupting a speaker that never ends, docs-only pages, logs with no words, and the live
speaker's budget, model and unreachable-budget faults by injected services); `test/app.scene.test.vibe` (the
buttons, the glow and Esc, the pane opening and moving, Escape and Esc, a second Learn more, the natural end, a refusal,
maximizing); `test/live.workerd.test.vibe` (the live tour's flows in local workerd, and ending it while its agent waits
on a model nobody answers); `e2e/tour.spec.ts` (all of it in a browser, reduced motion included). With
`CEREBRAS_API_KEY` set, the opt-in workerd case asks the real model for the tour; no key was available on the build
host, so it was not run.

**Coverage regression (2026-11-07).** Ending a tour now returns keyboard focus to the composer after the render.
The removed Esc button previously left focus on the page body, including after an unavailable end was retried.
Scene checks require the focus command; browser checks require the actual composer focus after Escape or Esc.
**Post/tour acceptance ordering (coverage lane, 2026-11-07).** A tour could win the interval between the mock
actor choosing an unanswered post and that reply's first durable action. The reply journaled a refused start as
complete, so the accepted post never received an answer. The start action now runs that already accepted tour as
a child execution, then uses the engine's retry policy to start the same reply. This preserves oldest-post ordering
and lets the tour finish naturally or be ended. The five public-Factory regressions vary fair scheduler boundaries,
require every accepted post's complete answer, and require an accepted tour in the natural-completion case.
The contended start emits a span, outcome-only log and counter; no prompt, author or conversation labels.

**Production regression tests (tourfix).** `e2e/tourfix.spec.ts` checks viewport bounding boxes at every stop in
1280×800 and phone projects, separate paragraphs through the common live/mock narration path, inert chat while
maximized, pointer/keyboard attempts to focus the docs followed by Escape, and polite/atomic accessibility-tree
status properties. `test/tour.test.vibe` advances Effect's `TestClock` to one millisecond before the reading deadline
and then across it, running `vibelang/Tour` on the memory engine over the real sequencer. It also checks a finished
tour is excluded from later reply history. Each regression was run failing before its fix; receipts are in the lane
report. No dependency was added. Catalog entries used: `@smthrs/flow` (durable clock), `@smthrs/engine` (product mock
and flow tests), and `@smthrs/ui-css` (existing chat presentation).

**Park-boundary regression (Astra review).** A workerd test delays the real `Tours.ended` service during timer
parking, ends the tour while its row is still Running, releases the delay, and requires the tour to settle within
two seconds rather than its thirteen-second reading hold. The end step records a durable resume for both Running
and Suspended tours before arming the alarm; an alarm-only wake can be overwritten as the previous invocation parks.

The accompanying SDK fix records operator/delegated resume requests in the engine's durable completion state and
consumes them on activation, using the committed journal decision sequence as identity. No migration is needed.
See [engine-store's durable waits](../../../../packages/smithers/flows/engine-store/docs/concepts/durable-waits.md).

**Reading policy proof (tourfix).** `flowDecision.readingHold` proves the exact hold and its four-second floor for
integral word counts from zero through the JavaScript array-length limit. The actual word tokenizer remains a
documented JavaScript string/regexp boundary. Three executable mutations separately remove the floor, change the
rate, and remove orientation time; each must fail the production contract.

The app suites use three Vitest workers, matching the browser pool. This bounds native Web Crypto/compiler and
real-engine contention without reducing workloads or assertions. The inherited full-history seed replay keeps all
6000+ commits and has the proof lane's finite 20-second integration budget; the default five seconds expired during this bounded
replay under load. The natural-tour ordering integration retains all eight rooms and assertions, with its stream
budget derived from the sum of all reading holds plus ten seconds, and twenty more seconds for the outer test.
The other behavioral timeouts are unchanged.

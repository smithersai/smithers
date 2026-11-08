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
                                             │          then vibelang/tour/say (AppendReply → ReplyDelta); FinishReply
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
- **Live and mock run the same tour.** The stops are `STOPS`. The mock's speaker (`MockFactory.vibe`) opens each stop
  and says the script's words (`TOUR`, `mockReplies.vibe`). The live speaker (`worker/Tour.vibe`) is smithers.sh's
  agent (0012) with an instruction naming the stops and two tools, `vibelang/docs/open` and `vibelang/tour/say`, each a
  flow; their bodies (`openDocs`, `say`) are the mock's steps. The day's budget admits the tour first, as it does a reply.
- **The page** (`src/web`). Learn more opens this tab's own conversation, `tour-<session>`: the home conversation is
  shared by every visitor, and one person's tour must not take its agent. `tour` in the Model is the person's side of
  control (the glow and Esc); it ends at once on Escape or Esc, and when the tour's entry settles. The docs pane is an
  `iframe` of `pane`, inside the conversation, with the splash pane's maximize and minimize. Reduced motion: the glow
  is still.
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
- **Live tools run in the agent's run, not as child executions.** A conversation's object drives one execution, and
  its runtime refuses any other (`@smthrs/platform-cloudflare`'s routing), so `vibelang/docs/open` can't start a child
  run there. Its call is a journaled step of the agent's run, and its handler is the flow's own body.
- **An ended tour still pays.** The race interrupts the agent before its journaled spend step, so a finalizer
  (`charged`, `worker/Tour.vibe`) records what it spent; the day's ledger adds a tour's tokens once.
- **Escape inside the docs.** A cross-origin frame keeps its own keystrokes, so Escape pressed inside the docs page
  never reaches this page; the Esc button always does.

**Observability.** Each step logs `vibelang.tour.<step>` (`start`, `end`, `open`, `say`, `run`) with its outcome and
counts `vibelang_tour_steps{step, outcome}`; the flows run in `vibelang.tour.start`, `vibelang.tour` and
`vibelang.tour.end` spans, the live agent logs `vibelang.tour.agent` with its outcome and tokens, and dispatch logs
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

# Conversation timeline

The chat's timeline rail: a vertical scrubber beside the conversation, ruling [FE-16](../../rulings.md). [Interactive mock](timeline.html). Library catalog entries: `@smthrs/ui` for the rail and transcript slot; `@smthrs/flow` for durability; `@smthrs/agent` `ModelStep` for summary calls; `@smthrs/model` `ModelProxy` for the metered role; `@smthrs/effect-tanstack-db` for the device projection; `@smthrs/crypto` for content identity.

## What the rail shows

These are the product's facts as built on 2026-10-20. Every element of the mock traces to a line here.

**Entries.** One entry per conversation message, in conversation order: each question the person asked (`role: user`, kind `ask`) and each answer from Smithers (`role: assistant`, kind `answer`). Views the agent adds to the conversation (`role: view`) are not entries. Sources: `railEntries` in `apps/mvp/src/features/timeline/view.ts` and its test `view.test.ts`. A question and its answer are inserted together and take adjacent positions (`position` steps by 2), so the conversation is a run of exchanges, each a question followed by its answer (`apps/mvp/docs/features/chat.md`, contract). An entry carries its text (`RailMessage.text`), so the rail knows its length. It also carries its time (`created_at`) and, for an answer, its token total (`view.ts`). The steps inside an answer (`parts`), tool calls, flow runs, toasts and views never reach the rail (`view.ts` reads none of them). A run's own step timeline lives on its run page (`apps/mvp/docs/features/runs.md`).

**Summary.** Each settled entry gets a summary: 1 to 8 plain words, at most 96 characters, on one line (`cleanSummary`, `timeline/steps.ts`). A question's summary says what the person wanted; an answer's says only what was observed to happen. The durable flow `timeline/summarize` writes it through one sealed `ModelStep` call to `/api/model/summary`, once per message revision for every device (`timeline/flow.ts`, `steps.ts`). A message that is streaming, failed or queued never gets a summary. Until a summary arrives the rail shows the entry's label as a placeholder, in italics. When summaries can't be made, the app says so with a toast and the rail marks what is missing one, with the reason on hover.

**Phases and arcs.** Outer levels are logical phases of the conversation, with sizes that follow what happened (FE-19), never a fixed stride. The durable flow `timeline/phases` has the cheap `summary` model divide the conversation at changes of goal and write each phase a short title ("Researching issue 450") and a sentence. Arcs group phases the same way. They are stored on the message each one starts at, so every device shares them. A stretch not yet divided shows its first entry's label, marked pending or unavailable, and never a count (decision [0138](../../decisions/0138-timeline-phases.md)).

**States.** From `railEntries` (`view.ts`), with the words the transcript shows:

| Message | Rail state | Transcript shows (source) |
|---|---|---|
| done | `done` | the message; the rail shows its summary |
| answer streaming | `working` | the text growing; the rail's mark pulses (`chatTimelineCss.ts`) |
| answer whose run asked the person (`app/agent/ask`) | `waiting` | the Needs you card; `◆ Needs you` (`agent-status.md`) |
| answer waiting for its turn | `queued` | `○ Waiting` under it (`agent-status.md`) |
| question queued in the outbox | `queued` | `Queued` (`chat.md`) |
| answer failed | `failed` | `Couldn't answer` with Retry (`chat.md`) |
| question the server refused | `failed` | `Not sent` (`chat.md`) |

A block takes its most urgent member's state, in the order failed, waiting, working, queued, done (`ChatTimeline.tsx`). Needs you is gold and failures are ember (`.specs/product/mvp.md` §6.4, `chatTimelineCss.ts`).

**Viewport.** The viewport is the transcript's scroll area (`[data-slot="message-scroller-viewport"]`). Entries whose boxes cross it are in view (`aria-current="location"`), and the band follows scroll and resize (`ChatTimeline.tsx`). Clicking an entry centers it in the transcript; clicking a block jumps to its first entry (`ChatTimeline.tsx`).

**Levels.** Level 0 holds entries in rows of a fixed 34 px. A further level appears only when the one inside it no longer fits, and the mock's three is the limit. `n` is the entry count, `p` the phase count and `H` the rail's height (`timelineLevelCount`, `packages/smithers/ui/src/chat/timelineZoom.ts`):

```
capacity(H) = max(2, floor(H / 34))          rows or blocks a column holds

levels = 1   when n <= capacity(H)           entries fit
levels = 2   when p <= capacity(H)           phases fit
levels = 3   otherwise                       phases group into arcs

H = 804 (1440 x 900):  capacity 23
H = 704 (1280 x 800):  capacity 20
```

So level 1 appears once the conversation no longer fits level 0, and level 2 once its phases no longer fit level 1. Every level shows only what fits around the viewport, and the outermost covers everything.

**Hover.** Hover adds detail only. An entry adds its actor (`Person` or `Smithers`), time and tokens; a block adds its sentence and "N messages · time – time" (`ChatTimeline.tsx`, `view.ts`). The projection has no duration or cost, so the rail shows none (`view.test.ts`).

**Keyboard.** Entries are native buttons. Enter or Space jumps. Up, Down, J and K move to the neighbor and jump, and Home and End reach the ends. Left and Right move to the containing block in the next level out or in. Escape focuses the transcript entry (`chat-timeline.md`, `ChatTimeline.tsx`).

**Where it appears.** The rail appears on desktop at a viewport width of 1,180 px or more, when the transcript column is at least 600 px wide. It sits outside the message column and takes no width from it. On narrower screens it is closed, and the conversation's `Timeline` control opens it as a sheet over the chat without narrowing the chat. Touch, Enter and Space open it, and Escape closes it (`chatTimelineCss.ts`, `ChatTranscript.tsx`, `e2e/timeline.spec.ts`).

## The design

```
 level 2          level 1             level 0, beside the chat
 Code tour  ▌  ╭─ Auth tests    ▌  ╭─┃ ▌ Run the checkout e2e tests
 Issue      ▌  │  Review #101   ▌  │ ┃ ▌ 17 passed, 2 failed
 Login     (▌)─╯  Flaky saved  (▌)─╯ ┃ ▌ Find where issue 450 happens
 Test fixes(▌)    #450 flaky   (▌)   ●─▌ Couldn't answer
 Search    (▌)─╮  Coupon tests (▌)─╮ ┃ ▌ Run the branch tests
 Release    ▌  │  Review #104   ▌  │ ┃ ▌ 19 passed, 0 failed
               ╰─ …                ╰─┃
 (▌) lens on a level's strip; ┃ track with the thumb over what the chat shows; ● the reading line
```

- **Placement.** A vertical rail left of the chat, with time running down and a 32 px gap to the messages. No card or panel; the chat keeps its width.
- **A quiet companion.** The chat is the main content (Will, 2026-10-20: "it needs to be less prominent"). At rest the rail's summaries use the muted and faint text tones at 11 px (10 px in outer levels), its marks are 3 px wide at about half strength, off-screen entries drop to 85 % opacity, and the thumb, dot, lens and funnel lines are soft. No accent is bright. Hovering the rail or focusing it from the keyboard brings it to full contrast in 150 ms. Summaries stay visible either way.
- **Level 0** touches the chat and holds entries in fixed 34 px rows. Each entry has a mark whose height grows with the message's length (log scale), neutral for a question and teal for an answer, and its summary of up to two lines. Level 0 holds still while the viewport stays inside it. When the viewport leaves, it pages to recenter, animated, so scrolling never drags it along.
- **Viewport.** Level 0's left edge is a track. A thumb on it covers what the transcript shows, a dot marks the middle, and a short cursor line crosses the marks. In-view entries are a step brighter. Clicking an entry jumps; dragging the thumb scrubs.
- **Level 1** appears by the rule above and usually covers the whole conversation. Each block is one phase: its title, then a strip on the right with one mark per exchange, as tall as the phase is long against the longest. Blocks are all one height, so a two-line title always fits and the column doesn't reflow when level 2 arrives (decision 0138). A lens, a capsule on the strip, marks the stretch level 0 shows. Two lines run from the lens's ends into level 0's track ends, with a faint fill between them. Dragging the lens scrubs, and level 0 follows.
- **Level 2** appears by the rule above. Its blocks are arcs of phases, and its lens marks the stretch level 1 shows. A title whose words don't fit its column is hidden rather than cut. On a rail under 300 px wide (a 1,280 px window), level 2 is a strip without labels; hover still shows them.
- **A level appears.** The new column slides in 18 px from the left and fades in over 240 ms while the existing columns ease to their new positions and widths. Level 0's window pages to the new message in the same motion. Then the lens fades in and the funnel lines draw from the lens to the inner level over 220 ms. Nothing jumps: rows are fixed, blocks are uniform, and each window animates from where it was.
- **A level leaves** (the chat got shorter, which is rare). The same steps run in reverse: the funnel lines undraw and the lens fades in 150 ms, then the column slides out and fades over 220 ms while the others ease back.
- **Reduced motion.** No slide and no line drawing: the column, lens and lines fade in or out over 120 ms, and the other columns move at once.
- **States.** Streaming pulses teal, Needs you is gold, Couldn't answer is ember and Waiting is hatched, all at reduced strength until the rail comes forward. In level 0 those words replace the summary; outer strips show the colors.
- **Look.** The 22:02 mock's palette, Inter type, rounded pills, lens, funnel lines and cursor dot (`reference-2202/look-and-position-ui.png`). It keeps nothing else from that mock: no lanes, models, handoffs, retries, time axis, legend or totals.
- **Phone.** `Timeline` at the transcript's top right opens the same levels in a sheet over the chat, at full contrast; Escape closes it.

Screenshots: `screenshots/scrubber-{short,medium,long}-{light,dark}.png` (1440 × 900) and `screenshots/scrubber-long-phone.png` (390 × 844). `screenshots/scrubber-level-appears.png` shows level 1 arriving as the 12th exchange makes 24 entries: before, at 150 ms (column sliding in, no lens yet) and after (lens and funnel drawn, level 0 paged to the new message). A 19 s recording at 1280 × 800 in dark mode scrolls the long conversation, grows it from 79 to 82 exchanges so level 2 appears at 81, then hovers the rail: `~/Desktop/smithers-mvp/gifs/timeline-scrubber-long.gif` (25 fps) and `~/Desktop/smithers-mvp/videos/timeline/timeline-scrubber-long.mp4`. The mock's controls sit top left and are hidden in screenshots (`#shot`): Short, Medium and Long; − and + to remove or send one message; Grow to keep sending, pausing when a level appears; Light and Dark. `#n=<exchanges>` opens any length. Mock data is illustrative.

## Trace: every visible element

| Element | Proof the product has it |
|---|---|
| One rail entry per question and per answer | `timeline/view.ts` `railEntries` |
| Summary text on every settled entry, always visible | `timeline/steps.ts`, `store.ts`; FE-16 22:09 |
| Mark height from message length | `RailMessage.text` (`view.ts`) |
| Question neutral, answer teal | entry `kind` `ask`/`answer` (`view.ts`) |
| `Working` with a pulsing mark | `working` state (`view.ts`), pulse (`chatTimelineCss.ts`) |
| `Needs you`, gold | `waiting` state from `needs_you` (`view.ts`); `agent-status.md` |
| `Couldn't answer`, ember | `failed` state (`view.ts`); copy from `chat.md` |
| `Waiting`, hatched | `queued` state from the run's `waiting` (`view.ts`); `○ Waiting` (`agent-status.md`) |
| Thumb and dot on the track; brighter in-view entries | visible band, `aria-current="location"` (`ChatTimeline.tsx`) |
| Levels 1 and 2, added only as the chat grows | `timelineZoom.ts`; FE-16 21:05 |
| A block per logical phase, an arc of phases beyond it | `messages.phase`, `messages.arc`; `timeline/marks.ts`; FE-19 |
| Phase titles and sentences | `timeline/phases` (`timeline/steps.ts`); FE-19 |
| Block mark color from its most urgent member | `ChatTimeline.tsx` |
| Lens and funnel lines | FE-16 21:14 and 22:10 |
| Fixed 34 px rows; levels added by the rule above | `timelineZoom.ts`, `tests/timeline-geometry.test.ts` |
| Level slides in, then the funnel draws; the reverse on removal | Will, 2026-10-20: "we should make sure we animate them in when they do appear" |
| Quiet at rest, full contrast on hover or focus | Will, 2026-10-20: "it needs to be less prominent" |
| Hover: Person or Smithers · time · tokens; sentence, N messages · time – time | `ChatTimeline.tsx` preview, `view.ts` |
| Chat: bubbles, hidden time and Copy, Retry, Needs you card, `○ Waiting` | `chat.md` (message controls), FE-13, `NeedsYouCard.tsx`, `agent-status.md` |
| Header: Flows, Runs, Settings, bell, theme | the running app, 2026-10-20 |
| Phone `Timeline` control and sheet | `ChatTranscript.tsx`, `chatTimelineCss.ts`, `e2e/timeline.spec.ts` |

## Self-check: `scrubber-long-dark.png`

Will's seven FE-16 quotes, in order, the facts above, then his two notes on this mock.

| Check | Result |
|---|---|
| 1. Graphical; the inner level shows what fits and the viewport; outer levels appear as the chat grows | Yes: three levels, thumb and dot on level 0 |
| 2. The top level reads as a slice of the less granular one | Yes: lens on each strip, lines into the next level's ends |
| 3. A vertical scrubber, like the chat | Yes |
| 4. No tool calls | Yes: questions and answers only |
| 5. Summaries visible without hovering | Yes: every entry and block |
| 6. The 22:02 look and where-you-are UI, turned vertical | Yes: palette, pills, lens, funnel lines, dot |
| 7. The tweet is not the spec | Yes: no lanes, models, handoffs, legend or totals |
| Entries, summaries, viewport, levels as above | Yes |
| States | Yes: Couldn't answer in level 0; Working and Waiting in level 2's last block; Needs you in the medium shots |
| Levels appear only when needed | Yes: short has one level, medium two, long three |
| A level animates in | Yes: `scrubber-level-appears.png` and the GIF |
| Less prominent than the chat | Yes: muted 11 px text, 3 px marks, soft cursor; full contrast only on hover (GIF, 15 s) |

## Settled since

1. **Who writes group summaries?** The durable flow `timeline/phases` (decision 0138).
2. **What does the rail span?** The whole conversation (`everythingQuery`). Jumping to an entry above the transcript's window widens the window first.
3. **Which words?** The transcript's: `Couldn't answer`, `Waiting`, `Queued`, `Not sent`.
4. **Height.** The rail fills the column, as in the mock.

## Durable summary contract and cost

[The feature page](../../features/timeline.md#cost) holds the contract and cost; decision [0138](../../decisions/0138-timeline-phases.md) holds the phases' design.

## Plugin boundary

Decision 0017: the first-party `timeline` plugin contributes `timeline.rail` to `chat.rail` (`plugin.json`). `ChatTranscript.rail` and `ChatTimeline` are public `@smthrs/ui` interfaces; the contribution gets its data from the host and has no private access. The Manifest/PluginHost loader isn't in this checkout yet, so chat mounts the contribution explicitly (`Conversation.tsx`).

Earlier rounds (19:57, 21:12, the 22:02 horizontal mock) are superseded by FE-16.

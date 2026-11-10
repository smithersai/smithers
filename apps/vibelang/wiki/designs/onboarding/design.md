# Onboarding walkthrough for vibelang.smithers.sh

Product and design spec. Replaces the current docs-only "Learn more" tour (decision 0014) with a
theatre-mode walkthrough in which the agent drives the real app. Dark only (VL-27). Runs in mock and
live (VL-13). Sound is optional and off by default; subtitles carry every word.

## 1. Audience and outcome

Primary audience: the **Viewer** — not signed in, arrived from vibelang.sh or a link, wondering what
this site is. Starting a tour is a Viewer-level action (0019's table: "Start or end a personal tour —
Viewer"), so the whole walkthrough must work with no sign-in, no role, no minutes.

Secondary: **New** (just signed in with GitHub, has no privileges yet) — the same walkthrough answers
"what can I do here now?".

Not the audience: Contributor and Maintainer already know the app; Community knows the basics. Nothing
in the walkthrough requires their privileges — every screen it shows is Viewer-readable.

After the walkthrough a Viewer can:

1. Ask the agent a question (⌘K or the composer).
2. Read the issue tree, tell a task from an issue and a VIP, and open one issue.
3. Find the wiki (rulings, decisions, roadmap) and the mythical history.
4. Know that `/` lists actions and that their role gates which run.
5. Know that contributors get metered sandboxes.
6. Know the one next action: sign in and file an issue.

## 2. Where it starts, how it ends

**Starts.**

- **Learn more** (splash primary button, VL-28) — starts the walkthrough. It no longer starts the old
  docs-iframe tour; that tour is cut (§7).
- **⌘K / slash** — `/tour` ("Explore VibeLang") already exists in the slash menu for Viewers
  (0023's action inventory). It now starts this walkthrough instead of the docs tour. Same flow, same
  entry as Learn more.
- **First visit** — when this browser has no `vibelang:toured` localStorage flag, the walkthrough
  auto-starts 1.2 s after the splash renders, exactly as if Learn more were pressed: glow, Esc pill,
  sound off. Esc or Exit ends it and sets the flag. Auto-start is the product's primary action
  introducing itself, not an ad; it never restarts once seen, and never starts over someone's
  in-progress chat.

**During.** The app switches into theatre mode (§3). The agent drives the real UI through the same
messages a person sends. The person can pause, go back, skip, and exit at any moment.

**Ends — one next action.** After the last step, theatre mode lifts, the glow fades, and keyboard focus
lands in the composer (the existing `FocusComposer` command, the post-Escape behavior 0014 already
regression-tests). The final subtitle stays as the agent's last chat line: "Ask me anything, or sign in
to file your first issue." No modal, no confetti, no survey.

## 3. Theatre mode layout

Theatre mode = the app's own screens, live, plus four layers. It reuses 0014's proven pieces: the
`.vl-glow` screen ring, the `.vl-esc` pill, the inert-chat isolation of a maximized pane, and the
polite/atomic status region that announces "Agent controlling. Escape to stop."

```
DESKTOP (1280×800)                                    PHONE (390×844)
┌──────────────────────────────────────────────────┐  ┌────────────────────────────┐
│ ▓▓ progress: 9 segments, current pulses ▓▓        │  │ ▓ progress segments ▓       │
│ VibeLang   Issues Wiki History Docs  [Sign in]   │  │ V  ⊙ Wiki History Docs ↗   │
│  ┌────────────────────────────────────────┐      │  │            [Esc]           │
│  │                                        │      │  │ ┌────────────────────────┐ │
│  │   the real app, live                   │      │  │ │                        │ │
│  │   everything except the spotlight      │      │  │ │   app, live; spotlight │ │
│  │   sits under a 55% dark scrim          │      │  │ │   ring on the driven   │ │
│  │        ┏━━━━━━━━━━━━━━━━━━━┓           │      │  │ │   element; rest dimmed │ │
│  │        ┃ spotlight: driven ┃           │      │  │ │                        │ │
│  │        ┃ element, undimmed ┃           │      │  │ └────────────────────────┘ │
│  │        ┗━━━━━━━━━━━━━━━━━━━┛           │      │  │                            │
│  └────────────────────────────────────────┘      │  ├────────────────────────────┤
│   violet glow ring around the whole screen       │  │ 3 of 9              🔇 Exit │
│  ┌──────────────────────────────────────────┐    │  │ Subtitle text, 15–16 px,    │
│  │ 3 of 9    subtitle text            🔇 Exit│   │  │ max 2 lines                 │
│  │           ⏮   ⏯   ⏭                       │   │  │   ⏮      ⏯      ⏭           │
│  └──────────────────────────────────────────┘    │  └────────────────────────────┘
└──────────────────────────────────────────────────┘  └────────────────────────────┘
```

- **Scrim.** `position:fixed; inset:0; background:rgba(6,10,9,.55)`. One hole: the spotlight.
  Implemented as the spotlight element's own shadow — `box-shadow: 0 0 0 9999px rgba(6,10,9,.55), 0 0
  24px var(--vl-violet)` — so the driven element stays fully lit and interactive-looking. Scrim and
  spotlight are `pointer-events:none`; the person's clicks do nothing to the driven app while the agent
  drives (same rule as 0014's inert docs iframe), except the subtitle bar's controls.
- **Spotlight.** A 2 px `--vl-violet` ring with `--r-2` (10 px) corners, positioned over the driven
  element's live `getBoundingClientRect()`, re-measured on every render and on resize. When a step
  drives a whole pane (issues, wiki, sandbox) the ring wraps the pane; when it drives the composer or
  palette, it wraps that.
- **Subtitle bar (the theatre's stage front).** Bottom-center on desktop, above the composer: `width:
  min(100% - 32px, 640px)`, `--surface` background, 1 px `--border`, `--r-bubble` corners, 16 px text
  at 1.55 line-height, maximum two lines. On phone it becomes a bottom sheet: full width, safe-area
  padding, 15 px text. Carries: "n of 9", the subtitle, and the controls.
- **Controls.** Five buttons, all ≥44 px targets: **Back** (⏮ / ←), **Play–Pause** (⏯ / Space),
  **Skip** (⏭ / →), **Sound** (🔇/🔊, off by default, one toggle, `speechSynthesis`), **Exit** (Esc,
  labeled "Exit", sits where 0014's Esc pill sits on desktop; on phone the Esc pill stays at the top
  and Exit also lives in the bar). Focus order: Back, Play, Skip, Sound, Exit. Every control has a
  visible `:focus-visible` ring (`--ring`), matching the app's existing pattern.
- **Progress bar.** Nine segments pinned to the top edge under the header, 3 px tall, `--surface-2`
  track, completed segments `--brand` (#45c4b2), current segment violet and gently pulsing. Reduced
  motion: no pulse, no glow animation, no scrim fade — states change instantly (the app already does
  this for `.vl-glow` under `prefers-reduced-motion`).
- **Status announcements.** The existing polite, atomic tour live region announces "Agent controlling.
  Escape to stop." on entry, each "Step n of 9: <first six words of subtitle>", and "Tour ended. You
  have control." on exit. Subtitles themselves are `aria-live="polite"`.

## 4. Steps

Ten steps, ~2 min 40 s at the reading holds below. One idea per step. Subtitle is the final wording —
every word is on screen, sound off is the default experience. The voice line is what `speechSynthesis`
reads when sound is on; it may be one clause warmer, never longer than the hold.

Timing: each step's hold is the app's existing rule — `max(4000, ceil(words × 60000 / 200) + 1000)`
ms (`readingHold`, `src/core/flowDecision.vibe`; 200 wpm plus a second to orient, 4 s floor). The
durations below count the subtitle's words. The agent's drive action lands at step start, before the
hold.

| # | Goal | Subtitle (final wording) | Voice line (optional) | What the agent does | Message / flow (file · name) | Hold |
|---|------|--------------------------|--------------------------|---------------------|------------------------------|------|
| 1 | Orient: this is a live tour, you can leave | "I'm the VibeLang agent. I'm driving for two minutes — Esc anytime." | "Hi — I'm the VibeLang agent. I'll drive for about two minutes. Press Escape any time to take over." | Glow on, scrim on, spotlight on the splash's Learn more button | existing `ClickedLearnMore` → `vibelang/StartTour` (src/core/flows.vibe:134); theatre state `NEW` | 7 s |
| 2 | ⌘K and the chat | "This is the chat. ⌘K opens it anywhere — ask me about VibeLang." | "This is the chat. Command-K opens it from anywhere. Ask me anything about VibeLang." | Opens the palette, types "What makes VibeLang different from TypeScript?", submits; the real (mock) answer streams in | existing `PressedCommandK`, `UpdatedDraft`, `SubmittedDraft` (src/web/main.vibe:171–177) → `vibelang/Post` → `vibelang/Reply` (flows.vibe:30,38); typing-as-drive `NEW` | 22 s |
| 3 | Issues are a tree; tasks vs issues | "Issues grow as a tree. A task is an issue we've committed to — it has an assignee." | "Issues grow as a tree: big problems split into smaller ones. A task is an issue the project committed to, and it always has an assignee." | Opens the Issues screen; ring wraps the list | drive event `NEW` → existing `ClickedIssues` (main.vibe:161); data via existing `vibelang/issues/read` (src/core/issueFlows.vibe:21) | 15 s |
| 4 | Agents do tasks; people decide | "This task is assigned to me. People decide the work; agents do it." | same as subtitle | Opens issue #48's detail; ring wraps the card | drive event `NEW` → existing `OpenIssueCard{48}` (main.vibe:166) | 12 s |
| 5 | VIPs change the language | "A change to the language is a VIP: one feature, its examples, its prior art." | "A change to the language starts as a VIP — one feature, with examples and prior art. Community members propose them." | Filters Issues to VIPs, opens #45 (VIP · In review) | existing `IssueUi{action:"kind",value:"vip"}` then `OpenIssueCard{45}` (main.vibe:162,166) | 14 s |
| 6 | Wiki = working memory | "The wiki is the project's memory: Will's rulings and every decision, beside the code." | same as subtitle | Opens the wiki home page in the pane | existing `vibelang/wiki/open {page:"index"}` (flows.vibe:307) — the same flow people and the agent already share | 14 s |
| 7 | Mythical history | "History holds every commit of main, folded into epics you can read." | "History is the mythical history — every commit of main, folded into epics you can actually read." | Spotlight on the History nav link (a plain link to `/history`; no pane exists — 0020: "no inline pane in the chat yet") | spotlight only; no flow needed | 11 s |
| 8 | Actions and slash commands | "Type / anywhere. Actions are registered workflows — this tour is one. Your role decides which run." | "Type a slash anywhere. Actions are registered workflows — this tour is one of them. Your role decides which ones run." | Focuses the composer, types "/", the real slash menu opens showing `/tour Explore VibeLang` | existing `UpdatedDraft{value:"/"}` (main.vibe:176) → slash menu; registry from `ClickedActions`/`LoadActions` (main.vibe:201,206) | 15 s |
| 9 | Sandboxes and minutes | "Contributors get a sandbox: a real machine, metered in minutes each month." | "Contributors get a sandbox — a real machine of their own, metered in minutes each month." | Opens the Sandboxes pane showing the minute allowance | drive event `NEW` → existing `ClickedSandboxes` (main.vibe:193); reads via existing `vibelang/sandbox/meter` (flows.vibe:282) | 12 s |
| 10 | One next action | "That's the factory. Ask me anything — or sign in to file your first issue." | "That's the factory. Ask me anything — or sign in, and file your first issue." | Theatre lifts, glow fades, focus to the composer; last line remains in chat | existing natural finish `vibelang/tour/finish` (flows.vibe:231) + existing `FocusComposer` | 12 s |

Total hold ≈ 2 min 14 s plus transitions ≈ 2 min 40 s. Inside the 2–3 minute budget.

Steps 2's 22 s includes the agent's answer streaming; if the answer finishes early the hold still
completes (reading time belongs to the flow — 0014), so live and mock keep identical pacing.

## 5. Rules: timing, control, resume

- **Auto-advance.** The controller (0014's `walk`, extended) runs: record step → drive the UI → say the
  subtitle → hold → next. Only the controller advances.
- **Pause (Space / ⏯).** Records a pause intent; the current hold freezes the moment it lands. The
  subtitle, spotlight and scrim stay; the progress pulse stills. Pressing again resumes the hold's
  remainder. Pause is durable — it survives reload — because the hold belongs to the flow, not the tab.
- **Back (← / ⏮).** Seeks to the previous step: the current hold is interrupted (the same race that
  ends a tour), the step's drive and subtitle re-run from its journaled Action, so a re-run is
  idempotent. Step 1's Back does nothing.
- **Skip (→ / ⏭).** Same mechanism, forward. Skipping step 10 exits as a natural finish.
- **Exit (Esc / Exit button).** The existing `vibelang/EndTour` (flows.vibe:150): ends at once,
  mid-word included, keeps what was said, returns focus to the composer. Works with sound off, on
  phone, and while paused.
- **Sound.** Off by default. The one toggle flips `speechSynthesis` on or off; turning it off mid-line
  calls `speechSynthesis.cancel()`. Voice lines are the table's. No other audio. The toggle state is
  presentation state and persists in localStorage (`vibelang:tour-sound`, default `"off"`).
- **Resume after reload.** Walkthrough progress is conversation state: the step index is derivable from
  the journaled step Actions (`vibelang/tour/step/<n>`), pause from its event, the driven pane from
  `PaneOpened`/the drive event — all replay through the existing event stream, as the docs pane does
  today (0014). A reconnecting tab re-enters theatre mode at the current step; a finished or ended
  walkthrough never auto-restarts.
- **Concurrency.** The existing rules stand: while the agent drives, its entry is `working`, a person's
  post waits and is answered after, and a second start is refused `busy` (0014). The walkthrough runs
  in the tab's own `tour-<session>` conversation, so one person's walkthrough never takes the shared
  home conversation's agent.
- **Reduced motion.** No glow pulse, no scrim fade, no progress pulse; spotlights jump instead of
  gliding. All content identical.
- **Phone.** Bottom-sheet subtitle bar, 44 px controls, Esc pill under the header (existing `.vl-esc`
  phone rule), spotlight re-measured on scroll and orientation change.

## 6. What the implementer must add (`NEW:`)

The walkthrough reuses the tour machinery wholesale. The gaps, honestly named:

1. **`NEW: WalkthroughDriven` — a numbered conversation event** beside `PaneOpened`
   (src/core/conversation.vibe), carrying `{ step, target }` where target names a UI destination
   (`splash`, `palette`, `composer`, `issues`, `issue:<n>`, `issues:vips`, `history-nav`,
   `sandbox-pane`, `wiki:<page>`). The view applies it by dispatching the *same* Messages a person's
   clicks send (`ClickedIssues`, `OpenIssueCard`, `ClickedSandboxes`, …). This follows 0014's
   design-twice rule: the page acts on a numbered event, never on parsed text; reconnects replay it;
   `decide` can refuse it. Without it, steps 3, 4, 7 and 9 have no live path — those Messages are
   client-only today.
2. **`NEW: src/core/walkthroughSteps.vibe`** — the step catalog, the sibling of `tourStops.vibe`:
   `{ target, subtitle, voice }` per row of §4's table. Shared by the mock script, the live speaker's
   schema (65-word bound, as today), and the view's spotlight mapping.
3. **`NEW: vibelang/tour/pause and vibelang/tour/resume` intents + events**, and the controller's
   per-step gate: `narrate`'s hold becomes a race of (hold elapsed, paused) as it already races
   (speaker, ended). Back/skip are a `seek` intent naming a step; the controller interrupts the current
   hold and re-runs that step's journaled Action. (src/core/flows.vibe `walk`/`narrate`.)
4. **`NEW: theatre view state and Messages` in src/web/main.vibe** — `ClickedPauseTour`,
   `ClickedBackStop`, `ClickedSkipStop`, `ToggledTourSound`; `tour` in the Model gains
   `{ step, paused, sound }` (today it is a boolean). `PressedEscape` and `ClickedEndTour` are unchanged
   — Esc already takes control back first (main.vibe:371).
5. **`NEW: .vl-theatre-* styles`** in src/web/styles.css — scrim, spotlight, subtitle bar, progress
   segments, phone sheet, reduced-motion rules — next to the existing `.vl-glow`/`.vl-esc` block.
6. **`NEW: a speech command`** in src/web — `speechSynthesis.speak(utterance)` per step when `sound`
   is on, `cancel()` on toggle-off, seek or exit. Client-only; no flow, no telemetry with text (say the
   step number only, per the tour's privacy rule: "logs with no words").
7. **Changed, not new:** `/tour`'s registered action and Learn more now dispatch the walkthrough
   script instead of the five docs stops. `STOPS`/`TOUR` (docs tour content) are deleted once the
   walkthrough catalog lands; the 0026 media table's stop rows go with them (splash and empty-chat
   media stay).

## 7. What I cut, and why

- **The five-stop docs-iframe tour (the whole current experience).** It shows vibelang.sh's marketing
  pages, not the app Will built; Will: the current tour "is not very good." The language story survives
  as step 2's live answer and step 6's wiki; the docs themselves stay one click away in the header.
  This removes STOPS, TOUR and the per-stop media placements — less to maintain, and the tour finally
  teaches the factory.
- **A sandbox terminal demo.** Starting compute needs Contributor (0019/0024); the primary audience
  can't run it. The walkthrough shows the pane and the minutes and moves on.
- **A sign-in walkthrough.** OAuth leaves the app; narrating a redirect teaches nothing. Sign-in is the
  final subtitle's words, not a step.
- **Roles/People and the mythical-history page itself.** People management is maintainer-only; History
  is a separate program with no chat pane (0020), so the agent can't drive it in-conversation — it's a
  spotlight on the nav link and one honest sentence.
- **Running an action for real.** Actions need Contributor (0023). Typing "/" and showing the real
  menu — with `/tour` in it — makes the point without a permission wall.
- **Video, background music, typed-text effects.** Sound-off is the default experience; subtitles are
  the product. Music adds nothing a Viewer asked for.

## 8. How to test it

One browser e2e (`e2e/walkthrough.spec.ts`, alongside `e2e/tour.spec.ts`), audio muted, asserting that
each agent drive call changed the app — not that pixels moved:

1. **Drive assertions per step.** Start with `?agent=mock`. For each step: wait for the step index,
   then assert the driven state — step 2: a post and a streaming reply exist; step 3: the issues screen
   is open; step 4: issue #48's detail; step 5: the VIP filter and #45; step 6: the pane's path is the
   wiki's; step 8: the slash menu lists `/tour`; step 9: the sandbox pane is open. Each assertion reads
   app state/DOM, never the subtitle.
2. **Controls.** Space pauses: the step index and the app are unchanged across 5 s. → skips: the next
   step's driven state appears. ← backs: the previous step's state returns. Esc and the Exit button
   both end: glow gone, status announces "Tour ended. You have control.", focus in the composer
   (the existing regression's assertion).
3. **Sound off by default.** A `speechSynthesis.speak` spy records zero calls through a full run;
   flipping the toggle calls `speak` once per step; flipping it off calls `cancel`.
4. **Resume.** Reload mid-step 4: the tab re-enters theatre mode at step ≥3 with the issues detail
   still open, no duplicate posts. A completed walkthrough plus reload does not restart.
5. **Phone (390×844).** Subtitle bar within the viewport at every step, controls ≥44 px, Esc reachable,
   spotlight inside the viewport.
6. **Reduced motion.** `prefers-reduced-motion: reduce`: no glow or pulse animation, all steps still
   complete.
7. **Mock/live parity.** The scene/flow suites run the same catalog through the memory engine and
   workerd, as 0014's `test/tour.test.vibe` does today; the live speaker's schema keeps the 65-word
   bound per subtitle.

## 9. Prototype

`prototype.html` in this folder is the clickable, dependency-free build of §3–§5 over a faithful mock
of the app: Learn more or first-load starts it; Space/←/→/Esc and the bar's buttons control it; the
sound toggle speaks with `speechSynthesis`; it lays out at desktop and phone widths and honors reduced
motion. `shots/` holds the reference screenshots of the real app.

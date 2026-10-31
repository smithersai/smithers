---
title: Timeline rail beside the conversation
status: in-progress
area: app
owner: CL-timeline-fe19
updated: 2026-10-31 18:40 PDT
links: [../decisions/0138-timeline-phases.md, old-app-feature-gaps.md, conversations-and-history.md, notifications-and-live-work.md, model-endpoint.md, ../decisions/0009-notifications-and-live-work.md, everything-is-a-plugin.md, ../rulings.md]
---

## FE-19 rebuild — 2026-10-31

**What:** Will's FE-19 ruling: the rail looks like the approved mock, every message has a model summary, outer levels are logical phases, and summaries that can't be made say so.

**Current state:** Rail ported from the mock, phases on `timeline/phases` (decision 0138), toasts per cause, Jev eval committed.

**Open questions for Will:** None here; the model choice is in the builder's status.

## Tracker reconciliation — 2026-10-21 01:54 PDT

**What:** Provide a quiet conversation timeline with progressive detail.

**Why:** Navigate long conversations without overwhelming chat.

**Current state:** The 01:49 lead update explicitly includes the timeline rail in c6940ac5. This supersedes the prior mock-only state. The summary does not establish that the requested progressive levels and durable group summaries are complete; production smoke is pending.

**Next step:** Inspect the landed rail against the approved progressive-zoom design, smoke-test production and retain any missing behavior as follow-up.

**Open questions for Will:** None.

Evidence: script-filtered user-typed messages and lead text replies, session 6253ecf2, 23:53–01:53 PDT; current rulings and queue answers through 01:19 PDT; shared briefs and designs, decisions, proposals, TODOs and rules. Completion and test receipts are reported evidence; this tracker validates only the site build. Execution ownership retained.

## Earlier tracker history (retained)


## Tracker reconciliation — 2026-10-20 23:34 PDT

**What:** A quiet vertical chat scrubber with always-visible summaries and progressive zoom levels.

**Why:** Navigation must stay visually behind the chat.

**Current state:** Will approved the direction at 23:00 and requested levels two and three only when the prior level outgrows available height, with entrance animation. At 23:03 he requested quieter styling and a GIF. At 23:26 the lead reports full-size light GIF (1280×800, 38.6 MB), Twitter copy (14.1 MB) and MP4 ready; dark copies already exist. These are mock/media receipts, not a shipped progressive rail.

**Next step:** Build after deploy: message/answer summaries only, viewport marker, progressive animated columns, keyboard access, reduced motion and mobile disclosure. Add durable group summaries and whole-conversation input; retain current passing slice history.

**Open questions for Will:** None.

Evidence: script-filtered user-typed text and lead text replies in session 6253ecf2, approximately 21:34–23:34 PDT; queue answers through 23:33:36, current rulings, decisions, proposals, TODOs, rules and shared briefs/designs. Notifications and teammate messages excluded from human evidence. Product receipts are lead-reported; this tracker verifies the site build. Existing execution ownership retained.

## Earlier tracker history (retained)


## Tracker reconciliation — 2026-10-20 23:25 PDT

**What:** Build the approved vertical chat scrubber with always-visible summaries.

**Why:** Give context without competing with chat.

**Current state:** Direction approved at 23:00/23:03: levels appear only when the conversation outgrows the prior level, animate in, and stay visually quieter than chat. At 23:19 the lead opened a 19-second dark GIF and MP4; at 23:22 a 14.6 MB Twitter GIF was ready. Will then requested full-size light mode. At 23:25 the designer is recording 1280×800 at 1:1 plus a Twitter copy; no light-mode completion receipt or shipped rail implementation.

**Next step:** Finish requested light recording. Build after deploy with durable group summaries and whole-conversation projection; retain mobile click-away and reduced motion.

**Open questions for Will:** None; approved direction stands.

Evidence: script-filtered human messages and lead text replies through 23:25 PDT; queue answers through 23:16, current rulings, decisions, proposals and shared briefs/designs. Automated notifications excluded. Product receipts are lead-reported; tracker validation is the site build. Execution owner retained; Codex curates the note.

## Earlier tracker history (retained)


## Tracker reconciliation — 2026-10-20, 23:04 PDT

**What:** Keep the vertical conversation scrubber readable but visually behind the chat.

**Why:** Will wants visible summaries and context without competing with the conversation.

**Current state:** Will approves the vertical direction at 23:00 and 23:03 PDT. Second and third levels appear only when the conversation outgrows the previous level and animate in. His latest request makes the rail less prominent; the designer is muting text, pills and cursor, restoring contrast on hover or keyboard focus while keeping summaries visible. A requested long-context GIF is being prepared; no completed GIF or product implementation receipt exists.

**Next step:** Finish mock polish and the requested 15–20 second dark-mode GIF showing scrolling, level appearance and hover. Build after deployment, with durable group summaries and a whole-conversation projection beyond the loaded 50 messages. Preserve mobile click-away access and reduced motion.

**Open questions for Will:** None; direction is approved. Do not ask again whether the corrected vertical mock is acceptable.

Evidence: script-filtered user-typed messages and lead text replies from session 6253ecf2, 21:03–23:03 PDT; synthetic notifications and tool blocks excluded. Current rulings and queue answers (latest 19:38 PDT) prevail over historical briefs/designs. Execution ownership is retained; Codex tracker curator reconciles documentation only. Product receipts are lead-reported; this pass verifies the site build.

## Earlier tracker history (retained)


## Tracker reconciliation — 2026-10-20, 22:54 PDT

**Current state:** At 22:46 the corrected vertical mock was opened for Will: always-visible question/answer summaries, viewport cursor, exchange/session groupings and draggable brackets. No tool-call lanes. Design approval is still absent. Implementation must add durable group summaries and the whole-conversation projection rather than only the loaded 50 messages.

**Next step:** Await Will’s direction on the corrected mock; build after deployment, including group summaries and whole-conversation data.

**Open questions for Will:** Is the corrected vertical mock the direction to build after deployment?

Evidence: lead text replies extracted by script from session 6253ecf2, approximately 20:54–22:54 PDT; user-typed text only for human messages, synthetic notifications excluded. Rulings and queue answers (latest 19:38 PDT) prevail. Execution ownership retained; Codex tracker curator records reported receipts.

## Earlier tracker history (retained)


## Tracker reconciliation — 2026-10-20, 22:15 PDT

**What:** Keep a vertical conversation scrubber with readable one-line message and answer summaries, a moving viewport marker and progressively coarser exchange summaries to its left.

**Why:** Will’s 22:06–22:10 corrections reject horizontal orientation and treating the Twitter reference as a complete specification.

**Current state:** Design remains unapproved. Will says the visual design and where-you-are treatment are good, but the orientation is wrong and summaries must remain visible without hover. At 22:14 the lead replaced the prior designer; the fresh designer must read product docs, the real rail and running app. Actor lanes, tool-call waterfalls and a time-axis card are not requested scope. Earlier orientation choices in this history are superseded.

**Next step:** Check a fresh vertical mock against all seven corrections before showing it to Will. Preserve the bracket, funnel and cursor treatment where useful; add coarser levels only as context grows, and keep mobile one tap away. Implementation waits until after burn-down deployment.

**Open questions for Will:** Review the corrected mock when ready; orientation and always-visible summaries are already decided.

Evidence: script-filtered user-typed text and lead text replies from session 6253ecf2, approximately 20:15–22:15 PDT; synthetic notifications, relayed agents and compaction summaries excluded. Rulings and all 75 queue answers (latest 19:38 PDT) take precedence over historical shared briefs, panel designs, decisions, proposals, TODOs and rules. Execution ownership and status retained; Codex tracker curator reconciles documentation only. Product results are reported evidence; this pass validates the site build.

## Earlier tracker history (retained)


## Current specification — 2026-10-20, 21:54 PDT

**What:** Build the tweet-style graphical timeline with actor lanes, pill segments, hatched waits, handoffs and a scroll cursor. Detailed levels must visibly zoom a slice of the coarser overview; add levels as context grows.

**Why:** Will rejected the text-box sketch; FE-16 governs the replacement mock.

**Current state:** The replacement remains designing pending Will’s mock review. At 21:46 the lead identifies an additional dev failure: no summary model is configured, producing 258 refusals by 21:22 and durable retries of permanent refusals. The timeline brief now requires a configurable default summary model and no retries of refused calls. No finished replacement mock or runtime fix is reported.

**Next step:** Show the tweet-matched mock in both orientations, themes and screen sizes before implementation. Fix summary configuration and refusal classification with regression receipts; retain durable flow boundaries and server model proxy.

**Open questions for Will:** Review the replacement mock when ready.

Evidence: script-filtered user text and lead replies from session 6253ecf2, approximately 19:54–21:54 PDT; compaction summaries, tool blocks and relayed agent messages excluded. Current rulings and queue answers take precedence over historical briefs, decisions and proposals. Execution ownership retained; reconciliation by Codex tracker curator. Product receipts are reported evidence; tracker validation is the maintainer-site build.

## Earlier tracker history (retained)

## Current specification — 2026-10-20, 21:15 PDT

**What:** Build a graphical multi-level conversation timeline in the tweet’s visual style: actor lanes, colored pill segments, hatched waits, handoff connectors and a cursor that follows scrolling. Each detailed level is visibly a slice of its coarser overview, marked by a bracket and connector lines; add coarser levels only as context grows.

**Why:** Will rejected the text-column sketch at 21:07 and clarified the overview/detail relationship. FE-16 supersedes the earlier single-column folding design.

**Current state:** At 21:09 the lead stopped the previous design job. At 21:14 it reports a new Opus designer building vertical-rail and horizontal-strip mocks, comparing screenshots against the tweet frame and recommending an orientation. TIMELINE-TWEET-DESIGN.md requires Will’s mock approval before implementation. Earlier implementation receipts remain history and do not validate this replacement design.

**Next step:** Present short, medium and long conversations in both themes and on desktop and phone, with the overview/detail lens and moving viewport visible. Keep the rail quiet at rest, expand detail on hover/focus and disclose it by a tap on mobile. After mock approval, implement and obtain coverage, real-browser recordings and reviews.

**Open questions for Will:** Review the replacement mock when ready; no new orientation decision is needed before the designer compares both variants.

Evidence: script-filtered user-typed text and lead text replies in session 6253ecf2, approximately 19:15–21:15 PDT; current rulings (especially FE-16), queue answers through 19:38 PDT, decisions 0001–0021, proposals, TODOs, rules and shared feature/host/panel briefs and designs. Latest Will text and queue answers prevail. Execution ownership follows the lead’s assignment; reconciliation by Codex tracker curator. Product checks are reported evidence; this pass validates the maintainer-site build.

## Earlier tracker history (retained)

## Current specification — 2026-10-20, 21:04 PDT

**What:** Show a graphical conversation map with progressively coarser summary layers and a viewport marker.

**Why:** Will’s latest message at 21:04 PDT specifies how long conversations should remain navigable without crowding chat.

**Current state:** At 20:59 the lead says the feedback job stopped without end-to-end recordings or full coverage and was relaunched. Earlier scoped tests and first-build receipts remain history. At 21:04 Will adds a new requirement: the rightmost layer shows the smallest detailed section that fits and marks the current viewport; a layer behind it shows a larger section, usually the whole conversation. Summarize larger blocks at coarser scales and add further zoomed-out layers only as context grows. No implementation or validation of this new requirement is reported.

**Next step:** Update the design and mock for adaptive summary layers, viewport relationships and keyboard jumps, preserving quiet styling, rich hover/focus details and mobile disclosure. Complete the resumed browser journey, coverage and recording before claiming completion.

**Open questions for Will:** None; settle layer thresholds and grouping as implementation choices and record them.

Evidence: script-filtered user-typed text and assistant text replies from session 6253ecf2, 19:04–21:04 PDT on 2026-10-20; rulings and queue answers through 19:38 PDT; decisions through 0021, proposals, TODOs, rules and shared feature/host/panel briefs and designs. Later Will text and queue answers prevail. Product receipts are reported evidence; this tracker verifies the site build. Execution ownership retained; reconciliation by Codex tracker curator.

## Earlier tracker history (retained)


## Current specification — 2026-10-20, 20:02 PDT

**What:** Keep a quiet conversation map with rich hover/focus details and a closed-by-default mobile disclosure.

**Why:** Will’s 19:38 review says the timeline must remain secondary to chat and one click away on phones.

**Current state:** The feedback builder reports quiet 11px styling, a neutral viewport marker, keyboard/Escape mobile disclosure, eight screenshots, six UI tests with 50 assertions, standalone Chromium checks and two projection tests at full module coverage. The full mini browser recording and docs check remain queued. Existing first-build evidence remains valid; no new feedback GIF is claimed. Chat supplies timestamps and token totals but lacks per-step duration and billed cost. PluginHost loading and cross-device summary work remain unbuilt.

**Next step:** Finish the feedback browser journey, replacement recording and docs check. Keep absent cost/duration omitted, then complete the public-plugin integration through its owning workstream.

**Open questions for Will:** None.

Evidence: script-filtered user-typed text and assistant text replies in session 6253ecf2, 18:02–20:02 PDT; queue answers through 19:38 PDT; rulings, decisions 0001–0020, proposals, TODOs, rules and shared feature/host/panel briefs and designs. Timeline validation also uses its builder report. Latest Will text and queue answers prevail. Product receipts are reported evidence; this tracker verifies the site build. Execution owner retained; reconciled by Codex tracker curator.

## Earlier tracker history (retained)


## Current specification — 2026-10-20, 19:44 PDT

**What:** Keep a quiet conversation map with richer hover/focus details and mobile disclosure.

**Why:** Will’s 19:38 review says the rail must remain secondary to chat and be one click away on mobile.

**Current state:** The lead reports the first build finished at 19:38. The execution owner records a passing browser journey, 14 logic tests at full coverage, and media receipts. The 19:58 owner entry records quieter styling and responsive disclosure implemented with validation queued. Manifest/PluginHost loading and cross-device summaries remain unbuilt.

**Next step:** Validate the feedback changes and re-record the mock and walkthrough. Show duration and billed cost only when the host provides them; current chat projection lacks those fields.

**Open questions for Will:** None.

Evidence: script-filtered user-typed text and lead replies from session 6253ecf2, approximately 17:44–19:44 PDT; queue answers through 19:38 PDT; rulings, decisions, proposals, TODOs, rules and shared feature/host/panel briefs and designs. Latest Will text and queue answers prevail. Product receipts are lead-reported; tracker validation is the site build. Existing execution ownership is preserved.

## Earlier tracker history (retained)


## Current specification — 2026-10-20, 19:14 PDT

**What:** Elevate the old conversation rail with cached short summaries, live states, keyboard navigation and run details in chat.

**Why:** Will requested the old timeline and careful study of his visual reference.

**Current state:** At 19:10 the lead reports the design/mock in the queue, rail and durable summary steps implemented and branch chat wired. Fourteen logic tests pass at 100% coverage; this is not React or production coverage. The browser test and recording remain queued behind the shared test lock. A cheap summary model role needs configuration; direct wiring is an interim implementation until the plugin host exists.

**Next step:** Finish browser proof and recording, configure the summary model role, and move the contribution onto the public plugin host when available. Retain cost/cache and failure evidence.

**Open questions for Will:** Review the timeline mock when ready; no new blocking product question is reported.

Evidence: latest approximately two hours of user-typed messages and lead text replies extracted by script from session 6253ecf2, through 2026-10-21 02:14:18 UTC; queue answers through 01:57:13 UTC; rulings, shared briefs/designs, decisions, proposals, TODOs and rules. Later Will answers supersede older proposals. Product validation is reported evidence; this pass verifies the site build only. Reconciled by Codex; execution owners retained.

## Earlier tracker history (retained)


## Current specification — 2026-10-20, 18:44 PDT

**What:** Restore and elevate the old chat timeline as a plugin, with cached short summaries, scroll tracking, scrubbing and keyboard jumps.

**Why:** At 18:40 Will explicitly requested the old timeline, thoughtful study of its implementation and visual inspiration from his linked example.

**Current state:** At 18:41 the lead assigned Codex Sol to study Timeline, TimelineZoom, TimelineSummary and ShellRail, inspect the example, produce a design/mock, then build the first slice. No completed design, source study or browser proof is reported. The historical question about waiting for several conversations is superseded by this request.

**Next step:** Study old entry selection, 3–8-word summaries and caching, grouping, scroll sync and keyboard behavior. Verify what the reference actually shows (https://x.com/eliakuratli/status/2112614855484358982?s=20); document inaccessible evidence honestly. Produce a mock covering live answers, waiting questions and failures, then implement the summary flow and shared rail with browser tests and a recording. Summaries use durable model steps with stated cost and cache identity.

**Open questions for Will:** None.

Evidence: user-typed text and lead replies extracted by script from session 6253ecf2 for 23:45–01:44 UTC (16:45–18:44 PDT); queue answers through 18:30 PDT; current rulings, decisions, proposals, TODOs, rules and shared feature/host/panel briefs and designs. Latest words and queue answers supersede older plans. Product receipts are reported by the lead; this tracker verifies only the maintainer-site build.

## Earlier tracker history (retained)


## What

A rail beside a long conversation, one short line per entry, to find your place and jump.

Old app (`apps/app/src/mainview/Timeline.tsx`, `TimelineZoom.ts`, `TimelineSummary.ts`, `ShellRail.tsx`):
- One line per entry, with a 3- to 8-word summary written by the fast model ("Switch to dark mode", "Quickstart opened").
- Live entries pulse, Needs you is gold, failures are ember.
- A band marks the entries on screen; clicking a line scrolls to it.
- Past 60 entries, distant lines fold into groups ("12 entries · 11:48 – 12:05") with summaries of their own.
- Shown on desktop only, at 1180 px and up.
- The rail's home line reads "<repo> · N need you · M working".
- Journey: `apps/app/e2e/real/timeline.spec.ts`.

Spec mvp.md §6.4, Timeline (Will).

Already planned, so not part of this gap: decision 0009 names "the timeline (later)" as one view of its notification rows, and its §4 covers the edges that show live work scrolled out of view.

Not planned: the rail, the summaries and the folding.

## Why

`main`'s shared conversation is long (spec §6.4). Without the rail, a person scrolls to find where they left off.

## How it fits

- Summaries: one fast-model `ModelStep` per entry, through the model endpoint under a `summary` role ([model endpoint](model-endpoint.md)), stored as rows that sync to every device.
- Folding is a pure function of entries and the visible band.
- An `@smthrs/ui` component, desktop only.

## Size

L.

## Questions for Will

- Build it after [several conversations](conversations-and-history.md)? It pays off only once conversations are long and shared. Recommended: yes, after.

## 2026-10-20 · elevated timeline slice

Owner: codex-timeline. Request: Will via lead at 18:55; no commit, shared checkout.
Design: [DESIGN.md](../design/timeline/DESIGN.md), [Paper mock](../design/timeline/timeline.html) (opened).
Inspected the old rail, zoom/title seams, summary admission/backfill/metering, and the public reference video's contact sheet.
Added public UI rail/slot, compiled first-party contribution, separate durable summary flow and content-keyed device projection; summary model role requires explicit configuration.
Validation so far: 3 summary contract tests passed locally and on mini; 2 UI helper/render tests passed locally; 3 real-engine replay/failure tests passed on mini. Initial registry failures revealed stale enumerated lists; updated them. Mini typecheck exposed and fixed a captured FlowDispatch requirement and test stream types.
Still running: final typecheck/tests and the queued mini e2e/video. No 100% coverage or production e2e receipt yet. Shared cross-device summary storage and Manifest/PluginHost loading remain outside the implemented slice; see design for exact boundaries.

Additional receipt: real-engine/TanStack projection integration passes locally and on mini (unchanged caching, changed-entry refresh, streaming/empty suppression). First measured timeline logic coverage: 96.15% lines, 88.88% branches; added faulty-service and stale-result cases and rerunning.

Mini receipt: all 14 timeline tests passed with 100% statements, branches, functions and lines over the five timeline logic modules (flow, identity, steps, store, view). This does not measure React component coverage, the model-role migration or production e2e. Typecheck reported no timeline findings after fixing the test host types.

UI receipt: 3 tests / 29 assertions pass (real React mount, keyboard focus/jump/Escape). Optional model-role endpoint tests added; first mini transfer failed before execution and was retried. Narrow branch side panes hide the rail to preserve the code view.

Model endpoint receipt: both summary-role tests pass on mini, proving an absent setting refuses without calling the default model, and an explicit setting reaches the real metered proxy/provider path. `pnpm docs:sync` completed, durable run-313. `docs:check` remains queued on the heavy lock.

First browser run failed before rail assertions: the chat/Answer flow did not produce its first answer; browser recorded a run-credential warning and `Unknown mutation function: text-update`. Timeline summary runs did complete. Updated the rail journey to seed asks/answers through the real public API (the existing local-first-conflicts pattern), independently of the agent-answer journey; no request interception or fake backend. The runner initially copied that trace to mini-farm/results/slot1/test-results; the next shared slot run overwrote it. The failure summary is retained in this note and the tool receipt.

Documentation receipt: `pnpm docs:check` passed all 51 published-package tarballs; durable run-317 completed. UI now has 4 passing tests / 34 assertions, including precise pending/failure labels by entry kind. Revised real-API-seeded browser journey remains queued on the mini.

## Final slice receipts

- Mini e2e `timeline.spec.ts`: passed in 24.3s, real public question/answer API + Postgres/Electric + browser durable engine; scripted model is the sole seam. Covers long history, summary arrival, fixed transcript width / 34px rail rows, Home/Down/End jumps, viewport band, phone hiding.
- Media checks: passed. MP4 `/Users/williamcory/Desktop/smithers-mvp/videos/timeline/conversation-timeline.mp4`; GIF `/Users/williamcory/Desktop/smithers-mvp/gifs/timeline-conversation-timeline.gif` (5 chapters). Stable test receipt copy: scratchpad/timeline-validation.
- Latest mini logic suite: 14 tests pass, 100% lines/branches/functions/statements over the five timeline logic modules. Registry: 13 pass. Real metered summary endpoint: 2 pass. UI: 4 pass / 34 assertions.
- `pnpm docs:sync`: completed run-313. `pnpm docs:check`: completed run-317; all 51 published tarballs passed. No commit made.
- The original agent-answer browser setup failed before rail assertions, with credential/outbox errors; the passing rail journey uses the same real API seeding pattern as local-first-conflicts. This is not a claim that the chat/Answer issue is fixed.
- Design review remains open. The public rail slot and compiled first-party contribution are built; Manifest/PluginHost loading and shared cross-device summaries are not built. No production e2e or live-dollar claim. Progressive folding and drag-preview stay in design review.

## 2026-10-20 · 19:58 design feedback

Owner: codex-timeline-feedback; in progress, shared checkout, no commit. Implemented quieter margin styling, hover/focus evidence and closed-by-default responsive disclosure. Updated mock/screenshots and browser regression journey; mini validation queued. Library catalog: @smthrs/ui. Per-step duration and billed cost remain unavailable in the current chat projection; the shared component accepts them when a host supplies them.

Feedback validation: 6 UI tests / 50 assertions pass. Projection: 2 tests pass at 100% lines/branches/functions/statements for view.ts (targeted scope, not whole-app coverage). Standalone Chromium confirms desktop keyboard preview and mobile closed/open behavior. Eight mock screenshots captured and inspected. docs:sync completed run-321; mini e2e and locked docs:check remain queued. An initial single-file vitest invocation passed its assertions but failed the global coverage gate because it selected the whole app; the subsequent module-scoped coverage run passed without changing thresholds.

## 21:08 zoom implementation
Owner: codex-timeline-zoom; in-progress. Preserving prior work; design-first FE-16 update in progress. No commits in the shared checkout.

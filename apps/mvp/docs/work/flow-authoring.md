---
title: Creating flows (a form card, the agent builds, a PR activates)
status: in-progress
area: app
owner: Flows repair builder assigned by lead
updated: 2026-10-21 20:34 PDT
links: [review-round-4.md, land-to-main.md, ../decisions/0014-flows-authoring-debugging-and-home-view.md, flow-debugging.md, repository-declared-home.md, flows-and-agent.md, slash-commands.md, scratch-branches.md, sandboxes.md, todos-and-stack.md, pull-request-list-and-tabs.md, agent-ui-rendering.md, roles-and-labels.md, old-app-feature-gaps.md, decisions-for-will.md, ../decisions/0003-flows-and-the-agent.md, ../decisions/0004-agent-ui-codemode-and-rendering.md, ../decisions/0005-sandboxes-secrets-and-the-forge.md, ../decisions/0011-the-agent-runs-in-the-browser.md, ../proposals/mvp-gaps.md, dev-stack-hygiene.md, smithers-playground.md, prompt-flows-are-code-flows.md, docs-truth-pass.md]
---

## Current specification

Draft, save, edit and run `Flow.make` modules through one flow model. The 2026-10-21 fixes cover default answers, failed-round diagnostics, Draft again, duplicate Draft presses, draft deletion and concurrent Save (`src/features/flows-ui/actions.ts`, `failure.ts`, `round.ts`, `steps.ts` and `store.ts` in that folder; `worker/PersonalFlows.ts`). [Flows](../features/flows.md#your-own-flows) documents the behavior.

### Evidence: 2026-10-21

Production run 1 at 11:13 reached Done in both flows tests. The production test failures came from the spec: it looked for the removed Steps listbox, then for a Pages navigation that a deployment's branch page does not have. The spec now opens `/app/flows` directly and checks the run graph's `<name>/load, Done` and `<name>/prompt, Done` nodes. It requires `member` and `liveModel`, reports a failed or stopped round with the card's words, and includes draft deletion (`e2e/flows.spec.ts`, `e2e/target.ts`).

Fixes, by subject:

- **Spec repair:** Direct navigation, run graph assertions, model requirements and immediate failure diagnostics (`e2e/flows.spec.ts`, `e2e/target.ts`).
- **Answer with defaults:** Answer includes each unanswered blocking question's shown default (`src/features/flows-ui/actions.ts`; `src/features/flows-ui/tab.test.ts`).
- **Why a round failed and failed checks:** Closed failure codes, card words, failure telemetry and checks that fail the round while keeping its file (`src/features/flows-ui/failure.ts`, `contract.ts`, `metrics.ts` and `steps.ts` in that folder).
- **The card follows its round, Draft again and no double Draft:** Read this device's round status, restart at a free round and join duplicate Draft presses to one execution (`src/features/flows-ui/round.ts`, `store.ts` and `actions.ts` in that folder).
- **Delete a draft:** Stop this device's round, delete the draft and reject late writes (`src/features/flows-ui/steps.ts`, `worker/PersonalFlows.ts`, `db/migrations/0040_flow_draft_deleted.ts`).
- **One save per draft:** Claim the ready draft inside the transaction; simultaneous saves return the one revision, and a claim that finds the draft no longer ready refuses `not_ready` (`worker/PersonalFlows.ts`, `worker/PersonalFlows.test.ts`).

### Evidence: 2026-10-22, production

`e2e/flows.spec.ts` against https://smithers.sh on main 6ea8caeea2fa (01:05 to 01:12 PDT): draft, save, run, the run graph, Stop and Retry passed in 1.7 min, and deleting a draft while it drafts passed in 45 s. The code test failed: a toast the test account's other runs left in the toast stack covered the code page's Save button, below a 28-row file, for the rest of the test's 5 minutes. Save now sits in the code card's header, by the file's name (`components/FlowCodeCard.tsx`). GIFs: `flows-flows-draft-a-flow-save-it-run-it-watch-its-run-page-then-st.gif` and `flows-flows-delete-a-draft-while-it-drafts-and-it-leaves-your-draf.gif`.

Rerun on main 4de8f49ecfb9, which carries that fix (03:12 PDT): all three flows tests passed in production in 3.5 min, the code test in 58 s.

**Remaining:** nothing for hand-edited code: the QuickJS realm flow host ([decision 0017](../decisions/0017-everything-is-a-plugin.md), slice 5; [sandbox work](personal-code-flow-sandbox.md)) runs it on 2026-10-25, and `FlowNeedsSandbox` remains only for code that needs a machine.

## Earlier tracker history (retained)

## Specification — 2026-10-20, 17:14 PDT
## Tracker reconciliation — 2026-10-21 20:34 PDT
**What:** Create, save and run flows with recoverable drafts.
**Why:** A person and the agent need a complete authoring path.
**Current state:** At 20:32 the lead reports drafting, saving and running a flow finish in production. Additional Flows fixes are still in the landing queue; this summary does not establish their deployment or resolve earlier active-run plan compatibility constraints.
**Next step:** Land the outstanding repairs with safe deployment ordering, then rerun the repaired draft and run-view journeys.
**Open questions for Will:** None.
Evidence: lead text replies script-filtered from session 6253ecf2, approximately 18:34–20:34 PDT, and recovered briefs where named. Automated notifications and tool content are excluded. Current rulings and queue answers prevail over older plans. Existing implementation ownership is retained; Codex curates the tracker. Product results are reported evidence, not tests rerun by this refresh.
## Tracker reconciliation — 2026-10-21 16:25 PDT
**What:** Make draft, answer, save and run recoverable and truthful.
**Why:** Keep implementation and validation claims tied to evidence.
**Current state:** At 16:08 three reviewed Flows fixes are queued. One changes plans and would fail mid-flight agent runs with plan changed; deployment must wait until no agent or TODO run is active. Stale step-list and branch-home tests remain distinct from product defects.
**Next step:** Collect landing receipts, drain active runs before deployment, then prove repaired drafts and run-graph selectors locally and live.
**Open questions for Will:** None.
Evidence: script-filtered human messages and lead text replies, 14:25–16:24 PDT, session 6253ecf2; tool blocks, notifications and compaction summaries excluded. Rulings and queue answers govern over historical designs. Existing implementation owner retained; Codex maintains this note. Product receipts are lead-reported.
## Tracker reconciliation — 2026-10-21 14:54 PDT
**What:** Make drafting and saving flows recoverable.
**Why:** Draft failures and concurrent saves must not strand or duplicate work.
**Current state:** At 14:41 the panel finishes and its builder starts. Production drafting, saving and running reach Done; old tests use removed step-list selectors and start on a branch with no Flows link. Real bugs remain: suggested blocking defaults cannot be accepted, drafting can hang, failed drafts cannot retry/delete or record a reason, and simultaneous saves can duplicate revisions.
**Next step:** Fix those regressions, update the production tests, then run hand-edited code flows in QuickJS under the already answered decision 0017.
**Open questions for Will:** None for this repair. Existing pending decisions remain in the retained history.
Evidence: script-extracted user-typed text and lead replies from session 6253ecf2, 12:54–14:54 PDT; automated notifications excluded. Rulings and queue answers govern over historical briefs and proposals. Product receipts are lead-reported; this pass verifies only the maintainer-site build. Implementation owners remain assigned; Codex maintains tracker documentation.
## Tracker reconciliation — 2026-10-21 14:05 PDT
**What:** Create, save and execute flows through the single durable Flow.make model.
**Why:** Authored flows must complete through the real product boundary.
**Current state:** At 14:01 PDT the lead starts a Sol/Astra/Opus/Fable panel for production draft/save/run/stop/retry timeouts and drafts stuck as drafting. At 14:03 six confirmed review findings are routed to this panel; implementation and passing receipts are pending.
**Next step:** Finish four independent diagnoses, synthesize and build the repair, then retain local and production regressions for draft, save, run, stop and retry.
**Open questions for Will:** None.
Evidence: user-typed text and lead text replies extracted by script from session 6253ecf2 for approximately 12:04–14:04 PDT on 2026-10-21; synthetic notifications and tool records excluded. Rulings and queue answers override historical briefs, designs, decisions, proposals, TODOs and rules. Product receipts are lead-reported; this tracker validates the maintainer-site build only. Engineering owners remain responsible; Codex owns this documentation reconciliation.
## Tracker reconciliation — 2026-10-21 13:38 PDT
**What:** Create and run flows through the shared durable authoring path.
**Why:** A saved flow must run successfully through the real product boundary.
**Current state:** At 13:15 PDT the production report says both Flows tests time out after 300 seconds. Other remote flows completing does not prove these authoring journeys pass. The harness owner is porting and rerunning specs; no diagnosis or repair receipt exists for these timeouts.
**Next step:** Separate fixture failure from product failure in the rerun, retain both timeout cases, and panel/build confirmed defects with local and production proof.
**Open questions for Will:** None.
Evidence: lead text replies extracted by script from session 6253ecf2, 11:37–13:37 PDT on 2026-10-21. Automated notifications and tool records excluded. Rulings and queue answers override historical briefs, panel designs, decisions, proposals, TODOs and rules. Product results are lead-reported. Existing execution owners retained; Codex owns tracker reconciliation only.
## Current specification — 2026-10-20, 17:14 PDT

**What:** Draft, save, edit and execute Flow.make modules through one flow model.

**Why:** Prompt flows are code flows, and authored code needs safe execution.

**Current state:** At 16:36 both flows browser tests pass; a prompt draft saves a real module with an agent step, using the shared execution and run page. Saving waits for device sync. Hand-edited source still cannot run; Will’s 17:05 QuickJS answer resolves the placement decision, with implementation after plugin reviews.

**Next step:** Finish reviewed QuickJS authored-code execution in personal-code-flow-sandbox.md; preserve the passing draft/run evidence and current honest refusal until then.

**Open questions for Will:** None.

Evidence: script-extracted human text and lead replies from session 6253ecf2, latest two hours through 2026-10-21 00:13:56 UTC; queue answers through 00:06:34 UTC; current rulings, decisions, proposals and shared briefs. Queue answers supersede older design proposals. Test results are lead-reported; this tracker runs the site build only.

## Earlier tracker history (retained)


## Current specification — 2026-10-20, 16:44 PDT

**What:** Create, save, edit and run flows through one Flow.make source model.

**Why:** FLOW-2 makes prompt flows a kind of code flow.

**Current state:** At 16:36 the lead confirmed prompt drafts save as Flow.make modules with one agent step, run through the shared run path/page, and open in the source editor. Both browser tests pass. The save waits for device sync, fixing disappearing entries. Hand-edited code saves but cannot execute and shows Needs a sandbox. Repository activation and arbitrary code execution remain unfinished.

**Next step:** Retain passing recordings and implement safe sandbox execution after the plugin design’s sandbox choice; see personal-code-flow-sandbox.md.

**Open questions for Will:** Decision 0017’s sandbox-only versus device QuickJS choice remains with Will; do not reopen the settled single-model ruling.

Evidence: user-typed text and lead text replies extracted by script for 21:43–23:43 UTC from session 6253ecf2; rulings and queue answers override older briefs. Product receipts above are reported by the lead; this tracker ran only the site build.

## Earlier tracker history (retained)


## Current specification — 2026-10-20, 16:35 PDT

**What:** Create, save and run flows through one Flow.make model, including prompt flows.

**Why:** FLOW-2 makes prompt flows a kind of code flow.

**Current state:** At 16:24 two passing chaptered flows videos returned to the queue. At 16:34 the lead confirmed the flows browser test passes: saving waits for the flow to reach the device, fixing its disappearance from the list. This supersedes the 16:02 failures. Full repository activation and flow-unification work have no new completion receipt here.

**Next step:** Retain the passing save-sync regression and review videos; finish the remaining code-flow unification and activation receipts.

**Open questions for Will:** None; the prompt-flow ruling is settled.

Evidence: lead text replies extracted by script from the session’s latest two hours through 23:34:16 UTC; current rulings and queue answers take precedence over older designs. Reported product-test receipts only; this tracker ran no product tests.

## Prior tracker record (retained)


## Current specification — 2026-10-20, 16:04 PDT

**What:** Create, save and run flows using one Flow.make model; prompt flows are code flows.

**Why:** FLOW-2 forbids a second flow model; the authoring experience must pass real browser tests.

**Current state:** At 16:02 the lead reported both flows browser tests failing, superseding the earlier passing run and 15:56 replacement-video claim. At 16:03 the flows review was removed pending passing recordings. No later repair receipt is present.

**Next step:** Assigned builder reproduces and fixes both failures, retains regressions and records passing chaptered journeys before returning the review.

**Open questions for Will:** None; the unification ruling is already settled.

Evidence: user-typed messages and lead text replies extracted with a script from session 6253ecf2 for the latest two hours through 23:03:42 UTC; rulings, queue answers, shared briefs/designs and current decisions, proposals, TODOs and rules. Reported receipts only; this tracker ran no product tests. Later rulings supersede older proposals.

## Prior tracker record (retained)


## What

People and the agent author new flows: a repository's `.smithers/flows/<name>/flow.ts` (M-49), or a person's or the app's own flows.

```
/flow.new ─▶ form card: Name · Goal · Scope (Repository | Personal | App)
               │ agent builds the draft as durable steps; optional grill-me questions inline
               ▼
           validate + test in a no-credential sandbox, on a scratch branch
               ▼
           propose: a TODO on a branch ─▶ PR ─▶ a person merges
               ▼
           refresh activates that exact revision ─▶ registry, slash menu, agent catalog
```

**Decided in 0014 (07:02, proposed):**
- **Three kinds of flow, and the kind decides where it runs.** App flows (`src/features/<f>/flows.ts`, the team's) run as today. Prompt flows are a `SKILL.md` (frontmatter `name`, `description`, `flows`, optional `model`, plus instructions) that the trusted agent loop reads; they run on the person's own browser engine. Code flows are `.smithers/flows/<name>/flow.ts` and run only in a job sandbox.
- **Your own flows ("Mine") are prompt flows** stored in Postgres and synced to your devices. There is no personal code flow. (Superseded 14:26:24 by Will's ruling: one flow model, a person's flow is `Flow.make` source; see [prompt flows are code flows](prompt-flows-are-code-flows.md).) A repository's flows reach its default branch only through a PR a person merges.
- **`flow/new` is one durable flow on the browser engine.** A form card (where, name, what it should do) starts it, with the current repository as default. Each round drafts, asks optional questions with the default it assumed, checks the draft and saves the draft row; only a blocking question parks it on `HumanTask`. **Try** runs the draft once, **Save** stores a personal flow, **Propose** opens a PR through 0012.
- **Activation receipt:** when the mirror's head moves, `flow/refresh` finds `.smithers/flows/` without running it, checks each flow, and moves its active revision in `flow_bindings` by compare-and-set; a failure shows `Merged · not active`.
- **One catalog:** the slash menu, the Flows pages and the agent read one join of the app registry, the person's flows and the repository's active bindings; every non-app flow runs through `flow/run { ref, input }`. Nothing shadows an app flow.
- **People merge; agents propose.** The agent may author, try and save its person's flows and propose repository flows, never merge or activate.
- **Walking skeleton (F1):** `/flow.new` → the draft → Save → run it (for example `/release-notes`) → the run card → Inspect → each step's input and output → Retry. It needs no sandbox, no PR and no 0009 table. Repository flows (L1) wait for 0012's branch and PR flow; code flows (L2) for 0005's job sandboxes, built with 0013.

The best guess before 0014, from Sol's design (scratchpad `final/panel-f-sol.md`):
- **A form card.** `/flow.new` opens Name, Goal and Scope; the repository defaults to the current one. The browser agent builds the draft through durable steps. Only missing authority, a required input or an unsafe ambiguity parks the build on `HumanTask`; optional questions let work continue.
- **One shape.** `Flow.make("<name>", { … })` default-exported from `.smithers/flows/<name>/flow.ts`, tests beside it. No root `flows/`, no second graph model, no new runtime.
- **Scope doesn't confer trust.** Repository, Personal and App code all run in a sandbox, never in the app, the browser engine or the trusted Worker. Pure presentation TSX runs only in 0004's generated-view realm.
- **Validate, then test, an immutable revision.** Extract metadata in a sandbox with no credentials; check path, tag, schemas, imports, capabilities and protected tags; typecheck and run the flow's own tests. Test runs execute the real module on a scratch branch with explicit grants and no production writes.
- **Activation is a receipt.** Draft → Tested → Proposed → Merged → Active. A source edit is a TODO on a branch and becomes a PR; people merge, agents never approve or activate. Refresh loads the merged commit in isolation and moves the active pointer; a failure keeps the previous version active. Each run pins its source revision.
- **One catalog.** The existing registry gains references keyed by `(scope, owner, tag, revision)`. Buttons, slash completion, agent tools, CLI and API all derive from them. A repository can't shadow a system flow.
- **Flows:** `flow/new`, `flow/answer`, `flow/validate`, `flow/test`, `flow/propose`, `flow/refresh`, `flow/activate`, `flow/run`.

## Why

Will, 06:39:05 on 2026-10-20: "Stuff related to flows debugging flows creting flows which wasn't listed is another one."

His earlier ruling (2026-10-13, for the old app): a form card; the repository defaults to the current one; optional grill-me questions during the build; block only when truly blocked; global and per-repository flows.

Planned before only as `mvp-gaps.md` item 8: "Let teams author and safely activate their own flows and views." The old app had a flow card, plan card, form cards and the repository's flow list (`apps/app/src/mainview/cards/FlowCard.tsx`, `cards/FlowPlanCard.tsx`, `cards/FlowFormCards.tsx`, `repository/RepositoryFlows.tsx`). The old-app audit counted it as covered, which is why Will said it "wasn't listed".

## State

- 06:39:05 on 2026-10-20: Will's priority. 06:40: Sol's run started. 06:42:06: the lead started Panel F's Opus member and merger.
- 06:43: Sol's design finished (exit 0): decisions 1 to 6 cover authoring. It names no question for Will.
- By 06:55: Opus's design (`panel-f-opus.md`) and `0014-flows-authoring-debugging-and-home-view.md` aren't written.
- 06:56:49: Opus's design written. **07:02:13: decision 0014 written (status: proposed)**, with one question for Will (below). It differs from Sol on the main point: personal flows are prompt flows, so the first slice needs no sandbox.
- **07:30:21 on 2026-10-20, Panel F done; the lead to Will:** "The flows design is done (decision 0014), and building its first slice has started." Its list: "**Runs:** a run list and a run page showing each step, waits and failures, with Stop, Retry, Resume and Answer buttons. **New flows:** you create a flow from a form, and the agent can ask a few optional questions while building it. **Running it:** save the flow, run it, and watch its run page. **Repository home:** a repository's own home page comes from a small data file in the repository, with the file tree one tab away."
- 07:30:21, the lead relayed Q1 (below), "built with the recommended answer until you say otherwise". The slice builds personal flows as prompt flows.
- By 07:37: no slice file on disk (no `RunInspection`, `src/features/flows/`, `src/features/runs/` or `flows` migration). Migration 0013 is taken by agent status's `runs` table ([agent status](agent-status.md)), so the `flows` tables take the next free number from the lead.
- **Status moved from designing to in-progress** at the 07:30:21 start.
- 07:42:44 on 2026-10-20: the branch workspace took migration 0014 ([conversations](conversations-and-history.md)), so the `flows` tables take 0015 or later.
- 07:43:00 on 2026-10-20: migration `0015_flows.ts` (skeleton step 3): `flows`, one row per name a person owns; append-only `flow_revisions`, where a run pins a revision and `digest` is the SHA-256 of `source`; and `flow_drafts`. A person's flow "is a `SKILL.md` of instructions and the flows it may call; it never holds code (decision 0014 §2)".
- 07:54:58 to 08:02:20, on disk: `src/features/flows-ui/` declares `flow/new`, `flow/answer`, `flow/save`, `flow/run`, `flow/run/prompt`, `flow/delete` and `flow/list` (steps 4 and 5). Steps 1 and 2 are in [flow debugging](flow-debugging.md).
- No screen, e2e or report by 08:07. Kept out of landing round 2 at 07:53:57 as still in flight ([land to main](land-to-main.md)).
- **About 08:15 on 2026-10-20: the Claude usage limit stopped the builder** ("Build 0014 first slice: runs page + flow/new", 15:14:01Z) with every other Claude agent, unreported. The limit reset at 10:40.
- **10:42: the lead resumed it** from where it stopped ("flows and runs"). 10:42:02 to 10:43:48: `src/features/flows-ui/flows.test.ts` and `steps.ts` changed. No screen, e2e or report by 10:44.

- **11:01 to 11:04 on 2026-10-20: [review round 4](review-round-4.md), Claude Fable P3-3 and Claude Opus P3-12 (source-verified): two saves of one draft commit two revisions.** `worker/PersonalFlows.ts:401-435`: `saveRefusal` checks `draft.status === "ready"` outside the transaction (`:198-209`), and `save` (`:216-246`) raises `flows.revision` and marks the draft `saved` with no `status = 'ready'` guard. Two `flow/save` runs for one draft (a double click, two tabs) both read `ready`: an existing flow's revision goes up twice with two identical `flow_revisions` rows; a new flow's second save hits `flows_owner_name`, answers `409 name_taken`, which `src/features/flows-ui/steps.ts:227-231` maps to the non-retryable `NameTaken`, so that run fails although the flow exists. Fix: open the transaction with `UPDATE flow_drafts SET status = 'saved' WHERE id = $1 AND status = 'ready' RETURNING id` and answer `existing` when it updates nothing; a concurrent-save test. Unrouted by 11:07.
- Also round 4: Fable's R4-12 lists `PersonalFlows`' shapes (`worker/PersonalFlows.ts:513-517`) among those that swap to an empty definition when the session lookup fails ([local-first](local-first.md)). Opus: flows and drafts are scoped to their owner, and `owner_id` stays off the shapes.
- 11:05 to 11:25 on 2026-10-20, on disk, unreported: `src/features/runs/` (`store.ts`, `actions.ts`, `runs.ts`, `components/RunListView.tsx`, `RunPageView.tsx` and `RunsContext.tsx`, 11:08 to 11:22) and `src/features/flows-ui/` (`store.ts`, `round.ts`, `steps.ts`, `actions.ts`, `flowsUi.ts`, `components/DraftCard.tsx`, `FlowsPage.tsx`, `NewFlowCard.tsx` and `FlowsUiContext.tsx`, 11:16 to 11:22); both `contract.ts` files 11:25:10.
- 11:42:48, the lead: flows wasn't reported stopped by either weekly limit, so it kept running.
- 11:44:47 to 11:50:25: tests `flows-ui/tab.test.ts` (new 11:44:47, changed 11:48:45), `flows-ui/api.test.ts` (new 11:49:40), `runs/page.test.ts` (new 11:50:18) and `flows-ui/flows.test.ts` (11:50:25).
- Not yet by 11:55: a flows e2e (none in `e2e/`), a GIF or a report. R4-22's file `engine-store/src/RunInspection.ts` changed at 11:13:25; no fix on record.
- 11:59 to 12:44 on 2026-10-20, on disk, unreported:
  - **12:10:42: the new `e2e/flows.spec.ts`**, decision 0014's F1 and F7 in a real browser with its own durable engine and the real model, no mocks: draft a prompt flow from `/app/flows`, save it, run it, watch its run page to its answer, then stop a live run and retry it.
  - `src/features/flows-ui/` `callable.ts` and `flows.test.ts` (12:18:58), `faults.test.ts` (12:22:08), `actions.ts` and `api.ts` (12:37:43), `tab.test.ts` (12:37:55).
  - `src/features/runs/` `runs.test.ts` and `store.test.ts` (12:22:08), `actions.ts` (12:30:19), `contract.ts` (12:37:43), `steps.ts` (12:39:48).
  - `docs/features/flows.md` (12:35:17) and `docs/features/runs.md` (12:37:43) rewritten; the shared `src/flows/registry.ts` changed at 12:42:44.
  - `worker/PersonalFlows.ts` and its test changed at 12:18; `save` still marks the draft `saved` with no `status = 'ready'` guard, so round 4's double-save finding stays open. R4-22's `engine-store/src/RunInspection.ts` is unchanged since 11:13:25.
- Not yet by 12:45: a recorded run of `flows.spec.ts` (no video under `test-results/`), a GIF or a report. Status stays `in-progress` until the e2e passes.
- **13:05 on 2026-10-20: 0014's builder reported the first slice built** (notification 13:07:56; the lead to Will at 13:09:31: "You can now create, save, run and debug flows"):
  - `/app/flows`: `flow/new` with its questions, Draft and Save; personal flows in migration `0015_flows`. The agent, `/flow.new` and `/flow.run` run the same flows. The slash menu now honors a command's `hints`, which other entries set but which had no effect until then.
  - The run page is in [flow debugging](flow-debugging.md).
  - **Differs from 0014:** a blocking question ends the round as `needs_you`, and the answer starts the next round; nothing parks on a `HumanTask`.
  - Proof: 105 tests pass, 100% coverage on every new file; app, worker and both SDK packages typecheck; `pnpm docs:check` passes. Docs: `docs/features/flows.md` and the new `docs/features/runs.md`. One `importRules` violation, in `worker/ExecutionHost.test.ts`, isn't this slice's.
  - **The e2e was written but couldn't finish:** the local dev server refused every model call with 429 "Today's model budget is spent": `model_budget_days` held 1,022,891 committed tokens against the 1,000,000 cap, of which 496,311 were spent and the rest were killed runs' reservations, held until midnight UTC ([dev stack hygiene](dev-stack-hygiene.md)). Before the budget ran out, the spec drafted a flow with the real model and saved it.
  - Shared files touched: the registry, declarations, registrations, `catalog.ts` (now scoped per run), boot, main, router, `AppShell`, `worker/Chat.ts`, the vitest coverage list and three test harnesses.
  - Will's try-it steps (the lead, 13:09:31): Flows → New flow; name `count`; What: "list the numbers from one to fifty in words"; Draft; Save; Run on the Flows page; watch the run page; start a second run, Stop, then Retry.
- Round 4's double-save finding is still open: `worker/PersonalFlows.ts` (unchanged since 12:18:01) marks the draft `saved` with no `status = 'ready'` guard.
- **13:13 on 2026-10-20: the lead raised the dev budget to 10,000,000 tokens** (`apps/mvp/.env`, not committed) and restarted the shared dev server; a first restart at 13:11 left two servers running until 13:13:19.
- **13:12:05 to 13:12:56: the repository home builder's first run of `flows.spec.ts` failed** (scratchpad `home-view/flows1.log`), during the two-server window: after Save the page returned to `/app/flows`, but the new flow's `Run count-…` button didn't appear within 5 s; the table showed only an earlier run's flow. 13:15:34 to 13:16:44: `src/features/flows-ui/` `actions.ts`, `store.ts` and `faults.test.ts` changed. No passing run by 13:17. Status stays `in-progress` until the e2e passes.
- **13:17:41 to 13:20:39 on 2026-10-20: `e2e/flows.spec.ts` passed** on the restarted dev server: "flows: draft a flow, save it, run it, watch its run page, then stop a run and retry it", 1 passed in 2.9 min (scratchpad `home-view/flows2.log`). GIF: `~/Desktop/smithers-mvp/gifs/flows-flows.gif` (13:20:55). The walking skeleton works end to end on a personal prompt flow. Not built yet: Propose (a repository flow through a PR, L1), code flows (L2) and the home view.
- **13:31:14, Will on flows:** "Flows are the most important part of oour product and technology and should be supported very very well but we should be thoughtful and high quality with adding support to flows." To help, he asked for the [Smithers Playground](smithers-playground.md), whose flows page gets the deepest treatment. 13:32:34, the lead: "Given that flows are the core of the product, I'll hold every flow feature to a higher bar."
- 13:26:18: 0014 Q1 asked again as quick question 4 of 4. 13:31:14: Will answered the other three, not this one. 13:32:34, the lead: "You didn't answer question 4 (personal flows are prompt-only for now), so I'll build on the recommended yes."
- **14:26:24 on 2026-10-20, Will answered 0014 Q1 in the queue, reversing the recommended yes:** "No everything is a flow this ruling is clear prompt flows are just a type of code flow". The lead's yes from 13:32:34 no longer holds.
- **14:27:52, the lead:** "an agent is merging the two into one flow model, built with `Flow.make` from `@smthrs/flow`. A flow drafted from a prompt is saved as flow source you can open, edit and run like any other flow. Hand-edited personal code stays refused, with the reason shown, until a host can run it safely." Tracked in [prompt flows are code flows](prompt-flows-are-code-flows.md).

## Next

From 14:30 on 2026-10-20: the unification agent's report ([prompt flows are code flows](prompt-flows-are-code-flows.md)), the flows e2e rerun on the new model, and 0014 rewritten to match; then the [home view](repository-declared-home.md), the double-save fix in the [P3 cleanup](review-round-4-p3-cleanup.md) and landing in round 3 ([land to main](land-to-main.md)). Repository flows (L1) wait for [pull requests](pull-request-list-and-tabs.md).

Until 14:30 on 2026-10-20 the next step was, from 13:20 on 2026-10-20: the builder's report; the [home view](repository-declared-home.md); the double-save fix in the [P3 cleanup](review-round-4-p3-cleanup.md); landing in round 3 ([land to main](land-to-main.md)). Repository flows (L1) wait for [pull requests](pull-request-list-and-tabs.md); code flows (L2) for [sandboxes](sandboxes.md). Every flow feature meets the higher bar Will set at 13:31.

Until 13:46 on 2026-10-20 the next step was, from 13:09 on 2026-10-20: the repository home builder gets `e2e/flows.spec.ts` passing on the restarted dev server, with its GIF, then builds the [home view](repository-declared-home.md). The double-save fix goes with round 4's routing ([review round 4](review-round-4.md)). The slice lands in the lander's app round ([land to main](land-to-main.md)).

Until 13:09 on 2026-10-20 the next step was, from 11:07 on 2026-10-20: the walking skeleton as before; the double-save fix goes with round 4's routing ([review round 4](review-round-4.md)).

Until 11:07 on 2026-10-20 the next step was, from 07:30 on 2026-10-20: the walking skeleton in 0014 §9's order, until F1 passes on `alchemy dev`:
1. `RunInspection` in `@smthrs/engine-store`, and `inspect` and `list` on `BrowserEngine`.
2. `/app/runs` and the run page, with `run/cancel` and `run/retry` on local runs ([flow debugging](flow-debugging.md)).
3. The `flows`, `flow_revisions` and `flow_drafts` migration and shapes.
4. `flow/new`, `flow/answer`, `flow/try` and `flow/save` for personal flows.
5. `flow/run` for prompt flows, in the slash menu and the agent's catalog.

F1: `/flow.new` → the draft → Save → `/release-notes` → the run card → Inspect → each step's input and output → Retry. Repository flows (L1) wait for 0012's pull-request flow; code flows (L2) for 0013's sandboxes.

Until 07:30 on 2026-10-20 the next step was, from 07:02 on 2026-10-20: Will answers 0014's question; then one owner builds the walking skeleton in order (`RunInspection`, the run page, the `flows` tables, `flow/new` and `flow/save`, `flow/run`) until F1 passes on `alchemy dev`.

Until 07:02 the next step was: Opus merges both designs into 0014 (status: proposed). Sol's walking skeleton: a Member creates a harmless typed flow through the form, validates and tests it on a scratch branch in the sandbox host, inspects its journal and opens a PR; a person merges; refresh activates it; it shows in the slash menu and the agent catalog. It depends on Panel G's branch and PR slice ([pull requests](pull-request-list-and-tabs.md)) and a sandbox host ([sandboxes](sandboxes.md)).

## Questions for Will

None. 0014 Q1 answered 14:26:24 on 2026-10-20: no; prompt flows are a type of code flow.

Until 14:30:

- Q1 of 0014: your own flows, usable in any repository, are prompt flows (a `SKILL.md` of instructions plus the flows it may call, stored in Smithers and synced to your devices); code flows (`flow.ts`) live only in repositories and run only in a sandbox. Recommended: yes. It ships the first slice before sandboxes exist; Sol's alternative, every authored flow as sandboxed code, waits for sandboxes and pull requests. (Relayed by the lead at 07:30:21 on 2026-10-20; the first slice builds on yes until Will changes it. Asked again 10:42:03 and 13:26:18; not answered at 13:31:14, when Will answered the other three quick questions; the lead builds on yes, 13:32:34.)

Until 07:02: None yet. Panel F sends at most 3 with 0014. Sol's recommended defaults: repository scope first; Personal flows are owner-only; App flows are published by a human Admin.

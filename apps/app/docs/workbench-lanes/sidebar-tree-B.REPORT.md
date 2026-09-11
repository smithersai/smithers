# Lane B report — flows surface, file panel, maximize offset, Restore (2026-09-02)

Brief: `docs/workbench-lanes/sidebar-tree.md`, the four items marked
`owner: lane B` — asks 5, 6, 7 and 8. TDD: every item got a failing test
first, then the smallest implementation that turned it green.

## Ask 5 — the Flows surface

`session.surface` gains `"flows"`, the composer's surface menu gains a fourth
entry (`Workflow` icon, label `Flows` in `SURFACE_LABELS`, `data-flow="flows"`),
and `App.tsx` renders a pane beside `world` and `connectors` that mounts the
`flow.list` card's OWN rows component (`WorkflowListCardBody`, now exported
from `ChatCards.tsx`) — one list, two mounts, per-row `Run` still bound to
`flow.run`.

- Flow `flows` (userOnly): toggles the pane like `world`/`connect` and runs
  `listWorkspaceWorkflows()` on the way in, so the pane shows what the seam
  answered and the seam's own refusal ("Sign in with GitHub first…", "No
  repository is loaded yet…") lands in the chat beside it. It is user-only
  because the model already has `flow.list`, whose answer is an embedded card
  (THE EMBED LAW); a pane stays the human's act.
- With no listing yet the pane body is empty. That is deliberate — NO
  INVENTION: no placeholder copy the seam did not say.

**Name collision, decided and recorded.** `flows` was already a HIDDEN alias
of `chat.commands` ("List everything Smithers can do"). One word cannot mean
both. The brief specifies flow id `flows` for the surface, so the surface took
the bare name and the catalog's bare spelling moved to `commands`
(`/chat.commands` is unchanged and still canonical). `SURFACE_FLOWS` now lists
four switches; `registry.test.ts` pins moved with it.

## Ask 6 — the file panel

`FileCardBody` and `FileListCardBody` carry `world-card-panel`; `cards.css`
caps it at `max-height: 60vh; overflow: auto` and drops the nested `pre` cap so
the panel is the ONE scroller. Maximized lifts the cap (`max-height: none`)
like the other maximized rules.

## Ask 7 — maximize beside the sidebar

`.app-shell` owns `--chrome-bar-width: 200px`; `chrome.css` reads it
(`width: var(--chrome-bar-width, 200px)` — the only chrome.css change);
`.smithers-card[data-maximized="true"]` starts at
`left: calc(var(--chrome-bar-width, 200px) + 1.5rem)` and
`.card-maximize-backdrop` at `left: var(--chrome-bar-width, 200px)`, so the
sidebar stays visible and clickable while a card is maximized.

## Ask 8 — always-visible Restore

The maximized header's minimize control is now a NAMED `Restore` button
(`Minimize2` + the word, `aria-label`/`title` "Restore"), still
`data-flow="card.minimize"` and `data-testid="card-minimize-<id>"` — the
restore flow that already existed, no new flow. The maximized card's header is
`position: sticky; top: 0`, so Restore stays on screen while the body scrolls.
Escape (the shell's keyboard path, no `useEffect`) and a backdrop click already
restored; both are now pinned by tests.

## Files changed

- `src/mainview/Composer.tsx` — `Surface` type, `SURFACE_LABELS.flows`, menu entry.
- `src/mainview/App.tsx` — the flows pane, the newest-listing derivation, `Workflow` import.
- `src/mainview/ChatCards.tsx` — export `WorkflowListCardBody`; Restore button copy.
- `src/mainview/cards/FileCards.tsx` — `world-card-panel` on both bodies.
- `src/mainview/state/AppState.ts` — `surface` enum + `"flows"` (surface lines only).
- `src/mainview/state/controller/workflows.ts` — `showFlows`.
- `src/mainview/state/AppController.ts` — `showFlows` on the controller surface.
- `src/mainview/flows/Flows.ts` — the `flows` flow, `USER_ONLY_VISIBLE`, `commands` alias.
- `src/mainview/flows/registry.ts` — `SURFACE_FLOWS`, `CommandState.surface`.
- `src/mainview/styles/cards.css`, `chat.css`, `chrome.css` (the var only).
- `packages/rpc/src/AgentContext.ts` — the runtime-context `surface` enum (the app tells the model which pane is open; it could not say "flows" otherwise).

## Tests added

- `styles/Layout.test.ts` — "the file panel caps at 60vh and scrolls itself";
  "the panel is the one scroller: a fenced body inside it has no second cap";
  "maximized lifts the cap, because the card is the viewport then";
  "the sidebar's width is a variable the shell owns"; "the card and its
  backdrop both start past that width"; "the header sticks to the top of the
  scrolling card".
- `cards/FileCards.test.tsx` — "a file body is the scrolling panel, markdown
  and fenced alike".
- `state/CardFrames.test.tsx` — "a maximized card names its way back: a Restore
  button on card.minimize".
- `state/CardRestore.test.tsx` (new) — "the Restore button is on screen while
  the card is maximized, and puts it back"; "Escape restores a maximized card";
  "the backdrop restores a maximized card".
- `state/ComposerLayout.test.tsx` — surface list now asserts
  `[chat, connect, world, flows]`; "choosing Flows opens the flows pane and the
  pill reads Flows"; "the flows pane renders the flow.list rows, each Run bound
  to flow.run".
- Pins moved with the change: `flows/registry.test.ts` (namespace exception,
  bare-alias pair, the ordered registry list), `flows/parity.test.ts`
  (App.tsx affordance count 13 → 14), `state/SlashTree.test.tsx` (four surface
  leaves before the first namespace row).

## Verification

`bun x tsc --noEmit -p .`: clean for this lane's files. One error remains in
the tree from a CONCURRENT lane — `cards/WorkspaceCard.tsx(193)` does not yet
accept the `"egress"` facet that lane L3 added to `packages/rpc/src/Cards.ts`
minutes ago. Untouched here on purpose: it is that lane's in-flight edit.

`bun test src`: 1548 pass, 3 fail — the three pre-existing
`TargetGraph.integration.test.ts` fixture failures the brief says not to chase.
(Baseline before this lane: 1534 pass, 4 fail, 1 error — the fourth was
`src/bun/Main.test.ts`'s native-process timeout, which is load-flaky and passed
in the final run.) Those counts are from the run taken immediately after the
last code edit; a confirming re-run was abandoned after 12 minutes because
several lanes were running suites on this machine at once (load average 7.5).

## Not built, honestly

- The pane has no "open" per-row action: the brief says "run, open", the
  `flow.list` rows carry only `Run`, and the brief also says reuse that rows
  component rather than write a second list. Adding an action the card does not
  have would be invention in both places.
- No bridge screenshot: the orchestrator owns the running app, so ask 7 is
  proved by the CSS pin, not by pixels.

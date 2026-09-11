# Lane `flow-forms` — REPORT

Brief: `flow-forms.md`. Laws: `apps/app/AGENTS.md` (EMBED, NO INVENTION,
THE THREE-DOOR LAW, and now THE FORM LAW), `apps/DESIGN.md`. Status: shipped
and green. Nothing committed; no `jj`/`git` write ran; the app was not
launched, relaunched, or quit.

## What shipped

1. **THE FORM LAW** is in `apps/app/AGENTS.md` under the three-door law: a
   flow invoked without its required input, by the agent or by a slash,
   renders a form card for the missing fields, prefilled with what was
   given; no door answers with a usage sentence; the agent's tool result says
   "rendered a form for <fields>: ask the user to fill it in".
2. **The generic card** `flow-form` (`packages/rpc/src/Cards.ts`; the brief's
   `apps/shared/src/Cards.ts` does not exist in this tree — `@smthrs/rpc` is
   where the card wire model lives). Payload: `{ flow, via: "user" | "agent",
   fields: [{ name, label, kind: text | number | boolean | select, required,
   placeholder?, options?: [{ value, label, disabled?, reason? }],
   optionsFrom? }], draft, given, error? }`. `FORM_OPTION_PROVIDERS` names the
   eight seams. The bespoke `agent-form` kind is deleted.
3. **Derivation** (`flows/FlowForms.ts`, pure): `formFieldsFor(input, hints)`
   walks the flow's `Schema.Struct` (String → text, Number → number, Boolean →
   boolean, `Literals` → select with the literals as options, `optional` → not
   required, `Array` → text) and overlays the flow's `form` hints (label,
   placeholder, `optionsFrom`, a `kind` or `required` override).
   `partialPayload` prefills from a slash line that failed to parse
   (positional in schema order; a `--flag` ends the read; leftover tokens ride
   the last text field; a flow may supply `partial`). `draftFrom`,
   `missingFields`, and `assembleArgs` (positional default: blanks skipped,
   a true boolean as `--name`, arrays space-joined; a flow may supply `args`)
   turn the filled form back into the one slash line the grammar parses.
   `text`, `flag`, `line` are the assembler helpers the hints use.
4. **Registry** (`flows/registry.ts`): `FlowMetadata.form?: FormHints`;
   `FlowEntry.input` keeps the input schema beside the binding (the
   descriptor does not carry it). `flows/Flows.ts` `flow()` sets it.
5. **The door** (`flows/Commands.ts`): when `payloadFor` refuses, `settle`
   calls `actions.renderFlowForm({ name, args, via: invoker, input, hints })`
   and returns `{ status: "form", flow, cardId, fields }` (`fields` = the
   required fields still missing, or every field when the line was malformed
   rather than short). The trace records `form` with "rendered a form for …"
   (`AppState.ts` `flow.invoked` outcome union gains `"form"`, one local
   hunk). `agentTools.ts` answers `rendered a form for <fields>: ask the user
   to fill it in`; `chain/FlowCatalog.ts` answers the same to a script;
   `controller/failures.ts` gives the slash door an ok toast titled "Fill in
   the form above" (no detail, self-dismissing). The W0 `explainAbsent` /
   `unavailable` path and the parity lane's user-only refusal are untouched
   (both pinned again in `Commands.forms.test.ts`). Buttons carry their args
   and never reach the door.
6. **The controller half** (new `state/controller/forms.ts`):
   `renderFlowForm` (card id `form-<flow>`, title `/<flow>`; a line the
   grammar parses whole prefills exactly, which is how `agent.new <id>`
   prefills `agent.edit`; the harness's own model list is read after the
   render and replaces the table's suggestions while the draft still names
   that harness), `setFormField` (`form.set <cardId> <field> [value]`: blank
   clears; number/boolean/select coerced; an option the seam did not offer
   or marked unpickable is refused with its reason; a commit clears the
   card's error; only a harness-changing field re-resolves options and
   re-reads the list), `submitForm` (`form.submit <cardId>`: required check
   onto the card, assembly, then the run path **as the actor that asked** —
   `runForAgent` for an agent-rendered form or an agent caller, `run` for a
   human's — and the card settles `acted` on success or `error` with the
   reason; the human's refused submit raises no toast, the agent reads the
   reason), `dismissCard` (`card.dismiss <cardId>`: form cards only; any
   other kind is refused by kind). Option providers, all read from the
   store's seams at render: `harnesses` (installed with credential state;
   `unavailable` → disabled "not installed", `binary-only` → disabled "no
   credential"), `agent-harnesses` (the same, plus disabled "no verified model
   flag" when the table verified none), `harness-models` (the draft's
   harness — or the harness of the agent the draft names — its verified
   suggestions, then its list), `open-repos` (`repos`: id, `name · path`),
   `cloud-repos` (`repositories`: `org/repo`), `bookmarks` (every loaded
   `branches` card, deduped by name), `workspaces` (`cloudWorkspaces`:
   `name · status`), `agents` (`roleMenuEntries` over the mirror; an
   unavailable role disabled with its reason). Harness rows are ordered as
   `HARNESS_IDS` lists them, whatever the collection's iteration order.
7. **Flows** (`flows/Flows.ts`, `flows/SlashPayload.ts`): `form.set`,
   `form.submit` (hidden, agent-invocable, no runtime gate), `card.dismiss`
   (hidden, beside `card.minimize`); `agent.form` is gone. `agent.new`
   renders the generic form for `agent.create`, prefilled from its line; an
   existing id renders `agent.edit`'s form prefilled from the row (model,
   purpose, label). `controller/agents.ts` lost the form card, `updateAgentForm`,
   `AGENT_FORM_*`, and the form-phase patches; `createAgent`'s label is the id
   humanized (`agent.edit --label` renames).
8. **The card** (new `cards/FlowFormCards.tsx`, mounted in `ChatCards.tsx`;
   `cards/AgentCards.tsx` keeps the Agents and models cards only): one
   control per field (text, number, checkbox, `<select>` for a select with
   options, text with a `<datalist>` for a provider-fed free-text field such
   as a model id), a required row marked by CSS, a disabled option reading
   `label · reason`, commits on blur/Enter/change through `form.set`, Submit
   (`form.submit`, disabled until the required fields are filled — a
   boolean never blocks), Cancel (`card.dismiss`), the error as `role=alert`,
   and an `acted` card that keeps its record with the controls disabled and
   no acts. `styles/cards.css`: `.agent-form*` became `.flow-form*`.
9. **Instructions** (`state/Instructions.ts`), one line after "The ask IS the
   permission": "When a command needs input you do not have, call it with
   what you have: it renders a form for the rest. Never ask the user to type
   arguments." `USER_ONLY_ALTERNATIVES` in `agentTools.ts` mentions no
   argument list, so nothing left it; the grammar's usage sentences stay as
   `Parsed.error` values that no door surfaces any more.

## The instruction stage

Measured on the InstructionsBudget fixture (local host, repository open,
every local capability): 188 registered, 153 callable, 128 disclosed (was
183 / 148 / 125). The prompt lands in **stage 2** (one line per namespace),
as before this lane: prompt 11,416 B, composed prompt + rendered context
14,172 B of the 16,384 B cap (2,212 B headroom); a stage-0 rendering of the
128-flow catalog would be 17,760 B. `InstructionsBudget.test.ts` is green.

## Field hints, by flow

Option providers and labels: `agent.create` (harness: agent-harnesses;
model: harness-models, free text), `agent.edit` (id: agents; model:
harness-models; flag assembler), `agent.remove` (id: agents), `agent.role`
(roleId: agents), `agent.delegate` (roleId: agents), `agent.models` (harness:
agent-harnesses), `tab.harness` (harnessId: harnesses), `review.request`
(reviewer label "Login or agent:name"), `workspace.open` (bookmark:
bookmarks; repo: cloud-repos; `--kind` assembler), `flow.run` (name label
"Workflow"; repo: cloud-repos), `issues.link-linear` (labels; repo:
cloud-repos), `linear.disconnect` (confirmKey label "Team key, typed back"),
`target.run` / `target.open` (repoId: open-repos; label "Target label";
`repoId [workspace] label` assembler), `target.run.pattern` (repoId:
open-repos; assembler), `target.runs.select` (`[repoId] runId` assembler),
`workspace.view` / `workspace.desktop` / `workspace.desktop.rotate` /
`workspace.facet` / `workspace.file` / `workspace.delete` (workspaceId:
workspaces; delete's confirmName label "Name, typed back"),
`workspace.template` (workspaceId: workspaces; `--name` assembler),
`files.read` (`path[:line[:col]]` assembler; repo: cloud-repos), `code.hover`
/ `code.definition` (`path:line:col` assembler; repo: cloud-repos),
`code.diagnostics` (repo: cloud-repos), `prs.create` (from: bookmarks, label
"From bookmark"; `from:` assembler; repo: cloud-repos), `prs.review` (text
not required; verdict spelling assembler), `repo.tree` (`copy#path`
assembler), `runs.list` (`by=`/`lineage=` assembler; repo: cloud-repos),
`issues.create` / `issues.comment` (repo: cloud-repos). 33 flows. Every
other flow with a required argument gets the derived form with plain fields
(the positional default assembles correctly for all of them: the round-trip
test below proves it against every registered flow that takes arguments).
`repo.open` got no hint: the folder dialog is the human's and a typed path is
free text, so there is nothing to say without invention.

## Deviations, with reasons

- **Submit is `form.submit`, not `data-flow` = the flow itself.** The brief's
  own requirement that "a confirm flow still confirms" after Submit cannot be
  met by a button that dispatches the target flow: the button door runs as
  the user, and user invocations never confirm. The submit therefore goes
  through the hidden `form.submit`, whose handler assembles the line and
  re-enters the run path as the form's actor (`via`): an agent-rendered form
  posts the confirm card and the human's Confirm click runs the flow; a
  slash-rendered form runs directly. The agent can never launder an act
  through a human's form (its own `form.submit` call runs as the agent).
  Args assembly lives with the controller (`assembleArgs`), not the card.
- **All fields render, given ones prefilled**, rather than only the missing
  ones. The law says both "exactly the missing fields" and "prefilled with
  whatever was given"; showing what the line was understood as lets the
  human correct a wrong token, and `given` stays in the payload for the
  record. The tool text names only the missing fields.
- **No default selection.** The old agent form preselected the first
  credentialed harness and read its models; the generic form prefills only
  what was given (NO INVENTION). Picking a harness reads its list.
- **`agent-harnesses` is an eighth provider.** `tab.harness` may launch a
  harness with no verified model flag; `agent.create` may not bind one. Two
  facts, two providers; the reason "no verified model flag" is the server's
  own vocabulary.
- **`card.dismiss` dismisses form cards only.** A general card remover would
  let the agent drop an approval card from the transcript; the handler
  refuses any other kind by name.
- **A provider-fed free-text field** (a model id) renders as text with a
  datalist rather than a strict select, because gemini and kimi take ids
  the table cannot enumerate; the hint's `kind: "text"` says so.
- **`agent.create`'s label** is the id humanized; the old form's separate
  Name field is gone because `agent.create`'s schema has none. `agent.edit
  --label` renames.
- **No asterisk copy.** A required row marks itself through CSS
  (`data-required` → `::after "*"`), not through label text.
- **`apps/shared` does not exist**; the card model is `packages/rpc`, so the
  verification ran `cd packages/rpc && bun test`.

## Files

Changed: `apps/app/AGENTS.md`, `apps/app/e2e/playwright/agents.spec.ts`,
`apps/app/src/mainview/ChatCards.tsx`, `cards/AgentCards.tsx`,
`cards/AgentCards.test.tsx`, `chain/FlowCatalog.ts`, `chain/FlowCatalog.test.ts`,
`flows/Commands.ts`, `flows/Flows.ts`, `flows/SlashPayload.ts`,
`flows/agentTools.ts`, `flows/registry.ts`, `flows/registry.test.ts`,
`flows/parity.test.ts`, `flows/agent-parity.test.ts`,
`state/AppController.ts`, `state/AppState.ts`, `state/Instructions.ts`,
`state/CustomAgents.test.ts`, `state/controller/agents.ts`,
`state/controller/failures.ts`, `state/seams/EnvironmentSeam.test.ts`,
`state/seams/RepoTreeSeam.test.ts`, `styles/cards.css`;
`packages/rpc/src/Cards.ts`, `packages/rpc/src/Cards.test.ts`.

New: `apps/app/src/mainview/flows/FlowForms.ts`, `flows/FlowForms.test.ts`,
`flows/Commands.forms.test.ts`, `cards/FlowFormCards.tsx`,
`cards/FlowFormCards.test.tsx`, `state/controller/forms.ts`, this report.
(`known-files.d.ts` regenerates at commit time.)

Untouched by instruction: `cards/FileCards.tsx`, `cards/ChangeCards.tsx`,
everything under `src/bun`.

## Tests

- `flows/FlowForms.test.ts` (9): derivation per schema kind (text, number,
  boolean, literal select, optional, array), humanized labels, the hints
  overlay (label, placeholder, optionsFrom → select, kind and required
  overrides), a non-struct schema, prefill (positional, leftover tokens on
  the last text field, a flag stops the read, a non-number stops a number
  field, a flow's own `partial`), draft coercion and missing fields (a
  boolean is never missing), assembly (positional default, `--name` for a
  true boolean, arrays, a flow's own `args`).
- `flows/Commands.forms.test.ts` (14): the agent door renders the form and
  answers "rendered a form for id, harness, model: ask the user to fill it
  in" with the harness seam's options and reasons and nothing run; partial
  args prefill and the harness's list feeds the model field; a complete call
  on a confirm flow still confirms (the form door never swallows confirm); a
  user-only flow without args is still refused by name; the slash door
  renders the same form with the "Fill in the form above" ok toast; the
  button door runs as before; `form.set` commits, coerces, refuses an
  unoffered or unpickable option, an unknown field, a missing card, and
  clears on blank; a slash-rendered form's Submit runs the flow as the human
  (no confirm card, PUT recorded, card `acted`, a second submit refused); an
  agent-rendered form's Submit posts the confirm card and the human's click
  runs it; the agent may submit its own form and reads the missing-field
  refusal and the confirm text; a refused flow's reason lands on the card
  with no toast; `card.dismiss` drops a form and refuses other kinds;
  `agent.new` renders `agent.create`'s form and, for an existing id,
  `agent.edit`'s prefilled from the row with the agents seam on the id field;
  and the round-trip pin: for every registered flow that takes arguments, a
  filled form assembles to a line its own grammar parses.
- `cards/FlowFormCards.test.tsx` (5): each field kind's control, the
  datalist, the required rows; disabled options with reasons and the empty
  choice on an unpicked select; every commit through `form.set` with the
  card id, blank clears, an unchanged field commits nothing, Cancel is
  `card.dismiss`; Submit is `form.submit`, disabled until filled, a boolean
  never blocks; an `acted` card keeps its record with no acts, an `error`
  card shows the reason and stays editable.
- `state/CustomAgents.test.ts` (6; three rewritten): `agent.new` renders the
  generic form with the harness and model selects fed by the harness seam
  (crush disabled "no verified model flag", opencode-kimi "no credential",
  nothing preselected, one list read on picking codex), `form.set` commits
  and refusals; the form's Submit PUTs the agent, settles the card `acted`,
  and the new agent is in the menu rule and the roles paragraph beside the
  new instruction line; the server's refusal lands on the card with no
  toast.
- `packages/rpc/src/Cards.test.ts` (12): the `flow-form` card parses, a bad
  kind, provider, or `via` is rejected, `agent-form` no longer parses.
- Pins updated: `flows/registry.test.ts` (names: `form.set`, `form.submit`,
  `card.dismiss`; `connector.remove` bare → the `form` outcome),
  `flows/parity.test.ts` (AgentCards 7 → 4, FlowFormCards 2),
  `flows/agent-parity.test.ts` (the form acts callable and undisclosed; the
  user-only allowlist is unchanged at 49 — no user-only flow was added),
  `chain/FlowCatalog.test.ts` (the journaled failure uses `card.dismiss
  nope`), `state/seams/EnvironmentSeam.test.ts` and
  `state/seams/RepoTreeSeam.test.ts` (bare `env.set`, blank `repo.tree`,
  blank `workspace.rename` → the `form` outcome).
- T1: `e2e/playwright/agents.spec.ts` rewritten to create an agent through
  the derived form (`flow-form-*` test ids, the disabled option's reason,
  `data-status=acted`). NOT RUN (needs a browser and the built SPA).

## Runs

- `cd packages/rpc && bun test`: 153/153 (14 files).
- `cd apps/app && bun x tsc --noEmit -p .`: clean apart from
  `src/bun/lsp/LspSession.ts` and `src/bun/routes/lsp.ts`, the code-intel
  lane's in-flight files (their `packages/rpc/src/LocalApp.ts` change added
  `digest`/`total` fields the Bun side has not caught up with); nothing this
  lane touched.
- `bun test src/mainview/flows src/mainview/cards
  src/mainview/state/InstructionsBudget.test.ts`: 432/432 (28 files).
- `bun test src/mainview --timeout 30000` once: 1548/1549 (146 files, 39 s).
  The one red, `tabs/ChromeBar.test.tsx` "the caret expands the copy's root
  …", expects a `repo-tree-state-<copy>#<path>` element reading "empty" that
  `ChromeBar.tsx` does not render (its only `.repo-tree-state` is the
  truncated line); neither file is in this lane's change set, so it is
  pre-existing. The six `CodeIntelSeam.test.ts` reds seen on an earlier run
  ("unreadable payload" from the real language server) belong to the
  code-intel lane and were green on the final run.

## Not built, and why

- The e2e spec was not run (above).
- `FlowCatalog.ts`'s `form` case (a chain script calling a flow without its
  input reads "rendered a form for …" as a success value) has no test of its
  own: the chain harness's observation shape was not worth guessing at; the
  same text is pinned at the tool boundary in `Commands.forms.test.ts`.
- `change.diff` and `egress.session` keep the positional default, which
  misaligns when an earlier optional token is blank and a later one is
  filled (`from` blank, `to` set); the grammars cannot express that line
  either, so no assembler was added.
- Provider options are resolved into the payload at render (and on a
  harness-changing commit), not read live by the component: the card stays
  a pure projection of its payload and tests mount it bare. A repository
  opened after the form rendered is not in an already-rendered select;
  re-rendering the flow (`agent.new`, or the slash again) refreshes it.

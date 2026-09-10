# Lane: flow forms. Missing input renders a form, never a usage sentence (2026-09-03)

Will, in the app at 12:2x, after the agent answered "/agent.create needs an
id, a harness, and a model (e.g., /agent.create reviewer codex
gpt-5.6-terra). I can't create a new agent without those required details":
"this is bad ux. It should just render an html form for selecting these.
This is a general pattern the agent is supposed to always follow. If the
agent wants input, create a form to solicit that input."

Laws (apps/ui/AGENTS.md incl. THE THREE-DOOR LAW, apps/DESIGN.md): EMBED LAW
(the form is a card in the chat), NO INVENTION (options come from seams:
installed harnesses, model lists, open repos, loaded bookmarks), no useEffect,
card state in the payload via the dispatcher, every act one flow with three
doors, consequential acts confirm (the form's Submit runs the same flow, so
the same confirm card follows).

## The rule, as law (add to apps/ui/AGENTS.md under the three-door law)

THE FORM LAW: a flow invoked without its required input, by the agent or by
a slash, renders a form card for exactly the missing fields, prefilled with
whatever was given. No door ever answers with a usage sentence. The agent's
tool result says "rendered a form for <fields>" so the model tells the human
to fill it in, never to type arguments.

## Today

`flows/Flows.ts` declares each flow's `input` (Effect `Schema.Struct`) and an
`args` string for the slash menu; `flows/SlashPayload.ts` parses argv per
flow; `flows/Commands.ts` `settle`/`parseSubmit` turn a parse failure into
`failed: /<name> needs …` (the composer line and, through `agentTools.ts`, the
model's tool result). The custom-agents lane built one hand-made form card
(`agent-form`, `cards/AgentCards.tsx`, fields committed through the hidden
`agent.form` flow) and a separate `agent.new` flow that renders it. The
agent chose `agent.create` with no args and hit the usage sentence instead.

## Design

1. **Generic form card** `flow-form` (`apps/shared/src/Cards.ts`): payload
   `{ flow, fields: Array<{ name, label, kind: "text" | "number" | "boolean"
   | "select", required, placeholder?, options?: Array<{ value, label,
   disabled?, reason? }>, optionsFrom?: string }>, draft: Record<string,
   string | number | boolean>, given: Record<string, unknown>, error?:
   string }`. Rendered by a new `cards/FlowFormCards.tsx`: one control per
   field, `Submit` (`data-flow` = the flow itself, args assembled from
   `given` + `draft`), `Cancel` (`card.dismiss`), field commits through a
   hidden `form.set <cardId> <field> <value>` flow (the `agent.form`
   pattern). A field with an option provider renders a select whose options
   the seam supplies at render (`optionsFrom`: `harnesses`, `harness-models`,
   `open-repos`, `cloud-repos`, `bookmarks`, `workspaces`, `agents`); an
   option the human cannot pick carries its reason (not installed, no
   credential).
2. **Field derivation.** `flows/FlowForms.ts`: `formFieldsFor(flow, given)`
   derives fields from the flow's `Schema.Struct` (string → text, number →
   number, boolean → boolean, `Schema.Literal` unions → select, `optional` →
   not required) and overlays the flow's new optional `form?: { fields:
   Record<string, FieldHint> }` declaration for labels, placeholders and
   `optionsFrom`. Flows keep `args` for the slash menu; the form is derived,
   never a second hand-written form. `agent.create`, `agent.edit`,
   `review.request`, `workspace.open`, `repo.open`, `flow.run`, `tab.harness`,
   `agent.delegate`, `issues.link-linear`, `linear.disconnect`, and every
   other flow with a required argument get field hints; a flow with no
   hints still gets a derived form.
3. **The door.** `Commands.ts`: when the agent or slash door fails to parse
   required input, render the `flow-form` card (prefilled from the parsed
   partial args) and return `{ status: "form", cardId, fields }`; the
   composer line reads "Fill in the form above" (no usage text); the agent
   tool result reads `rendered a form for <fields>: ask the user to fill it
   in`. Buttons always carry their args and never hit this. Submitting runs
   the flow through the normal path, including `confirm`. The hand-made
   `agent-form` card is replaced by the generic one (`agent.new` renders the
   generic form for `agent.create`); delete `agent.form` and the bespoke
   card if nothing else needs them.
4. **Instructions** (`state/Instructions.ts`): one line: "When a command
   needs input you do not have, call it with what you have: it renders a
   form for the rest. Never ask the user to type arguments." The
   `USER_ONLY_ALTERNATIVES`/failure texts that mention argument lists go.
   `InstructionsBudget.test.ts` stays green; report the stage.

## Tests

`flows/FlowForms.test.ts`: derivation per schema kind, hints overlay,
prefill from partial args, required/optional. `Commands` tests: agent door
with missing args → card + `form` outcome + tool text; slash door likewise;
button door unaffected; Submit runs the flow and a confirm flow still
confirms. `FlowFormCards.test.tsx`: each field kind, disabled options with
reasons, Submit args assembly, Cancel. `agent.create` with no args renders
the form with harness and model selects populated from the harness seam
(the existing AgentCards tests move to it). Parity/registry pins. A T1 spec
if `e2e/playwright/agents.spec.ts` exists: create an agent through the
derived form.

## Files

`apps/shared/src/Cards.ts`, new `flows/FlowForms.ts` (+test), `flows/Commands.ts`,
`flows/agentTools.ts`, `flows/Flows.ts` (field hints only; re-read before
each edit, the code-intel workflow edits it concurrently), `flows/registry.ts`
(`form` metadata), new `cards/FlowFormCards.tsx` (+test), `cards/AgentCards.tsx`
(remove the bespoke form), `ChatCards.tsx` (mount), `state/controller/agents.ts`,
a small `state/controller/forms.ts` for `form.set`, `state/AppController.ts`,
`state/Instructions.ts`, `apps/ui/AGENTS.md`.

## Verification

`cd apps/shared && bun test`; `cd apps/ui && bun x tsc --noEmit -p . && bun test src/mainview/flows src/mainview/cards src/mainview/state/InstructionsBudget.test.ts`, then `bun test src/mainview` once. Write `flow-forms.REPORT.md`.

## Named submission

Submit runs the flow with the form's own payload, not with the line it
prints. `flows/FlowForms.ts` `submissionPayload(input, fields, given, draft)`
builds that payload: every filled field under its own name, a blank optional
absent instead of shifting the next field's value onto it, a prefilled free
text field the human cleared as the empty string it now shows, a field the
schema requires and a `required: false` hint lets stand blank as that same
empty string, a structured field parsed back out of the JSON its text control
holds, and a list field split on the spaces `assembleArgs` joined it with.
Whatever the form could not represent stays as the invocation gave it.

`state/controller/forms.ts` `submitForm` hands that payload to
`flows/Commands.ts` `submit({ name, payload, actor, display, invocation })`,
which is the ordinary run path entered past the composer boundary:
availability, the requirement axis, the confirmation axis and the agent
authorization are the ones every other trigger meets, and the declaration's
input schema validates the payload inside the binding. `assembleArgs` still
writes the slash line, now as display copy only: the card's echo, the
`/verbose` trace, and the confirmation message. Nothing parses it back into a
payload.

The durable park and the confirmation action are still text shaped
(`deferCommand`, `requestFlowConfirmation` carry `args`), so a submission that
defers on a requirement or waits for a confirmation resumes from the display
line and is only as faithful as the flow's grammar. Grammar coverage is
gated: `flows/SlashPayload.test.ts` fails when a declaration carries an `args`
hint and no decoder, which is how `triggers.register` discarded a named
repository.

## Authorization on submission

Every agent form continuation resolves its target in the command registry and
checks that target's declared capabilities with the active chain authorization
service. The call slot and lineage stay in host memory, outside the card payload.
A nested approval requirement parks the outer call; resuming checks the target
again before its handler runs. A continuation without host authority applies the
default policy and cannot execute protected capabilities.

Approval decisions are user-only at every agent entry point. Forms shown or
patched by the model always retain agent provenance; their flow names, fields,
and drafts are input, never authority. Submitting a user's form from an agent
call also uses agent authorization.

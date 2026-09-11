# Lane `custom-agents` — REPORT

Brief: `custom-agents.md`. Laws: `apps/app/AGENTS.md` (EMBED, NO INVENTION,
THE THREE-DOOR LAW), `apps/DESIGN.md`. Sequenced after `agent-parity`.
Status: shipped and green. `bun x tsc --noEmit -p .` clean in `apps/app`
(outside the code-intel lane's in-flight `src/bun/lsp/*` files) and in
`packages/rpc`; the brief's verification set is green except one
pre-existing timing test (below); `packages/rpc` 153/153. Nothing committed;
no `jj`/`git` write ran; the app was not launched.

## What shipped

1. **Agents are rows** (`packages/rpc/src/AgentRoles.ts`). `AgentRoleIdSchema`
   is a validated string (`/^[a-z][a-z0-9-]{1,40}$/`); `AgentRoleSchema`
   gains `builtin`, `createdAt`, `updatedAt` and drops `launch`. The model
   id is guarded by `MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._/:-]{0,80}$/` (no
   spaces, no leading dash). `roleLaunchArgv(role, harnessSpec, task)`
   COMPOSES `[binary, ...modelFlag, modelId, task?]` and re-checks the model
   id at composition, so a row can never inject a flag. The six built-ins are
   the seed (`builtin: true`; the opencode rows now store the
   `provider/model` id the binary accepts: `kimi-for-coding/k3`,
   `cerebras/gpt-oss-120b`). New helpers: `isBuiltinAgentRoleId`,
   `findAgentRole(id, roles)`, `orderedAgentRoles` (built-ins in table
   order, then custom oldest first; an empty list is the built-ins),
   `agentIdFromLabel`. Wire schemas: `AgentsResponseSchema`,
   `AgentPutRequestSchema` (strict), `AgentResponseSchema`,
   `HarnessModelsResponseSchema`.
2. **The harness model table** (`apps/app/src/bun/Harnesses.ts`). Each
   detector may carry `models: { flag, suggestions, list? }`, every entry read
   off the installed binary's own `--help` on this machine (2026-09-03):
   `claude --model` (aliases `fable`/`opus`/`sonnet`, full name
   `claude-fable-5`), `codex -m` (the GPT-5.6 family from
   `packages/smithers/agent/model/src/DeferredTools.ts`), `gemini --model` and
   `kimi --model` (no ids named: free text), `opencode --model` with the list
   command `opencode models [provider]` for the three opencode entries,
   `cursor-agent --model` (its own examples), `hermes --model` (its own
   example). `crush` and `amp` name no model flag in their help (`amp -m` is
   a mode), and `pi` is not installed here, so those three have no entry and
   cannot host a custom agent (NO INVENTION). The wire `Harness` row gains
   optional `models: { suggestions, listable }` — never the flag.
   `harnessModels(id)` / `harnessModelSpec(id)` are the lookups.
3. **The store and routes** (new `apps/app/src/bun/routes/agents.ts`).
   `createAgentStore({ stateDir })` reads `<stateDir>/agents.json`, seeds from
   the built-ins on first read, merges built-ins a file lacks, validates the
   file (a corrupt file logs and starts from the built-ins), and is memory-only
   without a state dir. `PUT /api/agents/{id}` (201 create / 200 edit)
   validates the id, the strict body, that the harness is in the table WITH a
   verified model flag (`harness_no_model_flag`), and that a built-in keeps
   its harness (409 `builtin_harness_fixed`). `DELETE /api/agents/{id}`
   refuses a built-in (409 `builtin_agent`), 404 unknown.
   `GET /api/harnesses/{id}/models` runs the list argv (resolved binary,
   5 s cap, `NO_COLOR`) and answers one id per line; a harness without a list
   command answers the table's suggestions; a failed or slow list answers
   empty with the exit and first stderr line. `server.ts` registers the
   routes with `stateDir` and hands `roles: () => store.list()` to the PTY
   manager.
4. **PTY** (`apps/app/src/bun/Pty.ts`). `roles?: () => Promise<AgentRole[]>`
   (default the built-ins); a role id resolves against the store
   (`unknown_role` → 404), the argv is composed from the harness's model spec
   (`role_unlaunchable` when the harness has no flag or the id fails the
   guard). A custom agent launches exactly like a built-in.
5. **Renderer.** `app-agents` collection (`AppStore.ts`, `SchemaVersion.ts`
   inventory; no schema bump — every change is additive or a loosening),
   `agents.loaded` transition (same replace-in-place rule as the harnesses),
   loaded at boot beside the harness list (`ControllerBoot.client.ts`) and
   re-read after every mutation. New `state/controller/agents.ts`
   (`loadAgents`, `agentRoles`, `listAgents`, `newAgent`, `createAgent`,
   `editAgent`, `removeAgent`, `listHarnessModels`, `updateAgentForm`;
   `currentAgentRoles(store)` is the shared read). `controller/tabs.ts`
   resolves a role from the mirror (loading it on demand) and puts the role's
   `purpose` on the subagent card; `controller/turns.ts` builds the roles
   paragraph from the mirror; `AgentRoleMenu.ts` takes the agents list
   (built-ins until it loads); `ChatCards.tsx` reads the subagent card's
   purpose from the payload (older cards fall back to the built-in row).
6. **Flows** (`flows/Flows.ts`, `flows/SlashPayload.ts`), namespace `agent`,
   every one three doors, none user-only (the parity allowlist is unchanged):
   `agent.list` (every host; the web card reads "Agents run on the native
   app's harnesses"), `agent.new [id] [harness] [model] [purpose]` (an
   existing id opens the form in edit mode), `agent.form <field> [value]`
   (hidden; the form's commits), `agent.create <id> <harness> <model>
   [purpose]` (confirm: "create the agent <id> on <harness> with <model>"),
   `agent.edit <id> [--model] [--purpose] [--label]` (confirm),
   `agent.remove <id>` (confirm; a built-in refused with the reason),
   `agent.models <harness>`. `agent.role` and `agent.delegate` accept any
   well-formed id; the store's list refuses the rest ("There is no agent
   named poet. Agents: …").
7. **Cards** (`packages/rpc/src/Cards.ts`, new `cards/AgentCards.tsx`):
   `agents` (rows with harness name, model id, `● account` / `○ reason` from
   `roleMenuEntries`; Launch when available, Edit, Remove for custom rows,
   New agent), `agent-form` (draft, offered harnesses with their signal, the
   model list with its source and reason, phase), `agent-models`. The
   `agent` card payload gains optional `purpose`. Form state is the card
   payload: each field commits through `agent.form` on blur/Enter (the DOM
   holds keystrokes in flight, never React state), the harness chips and
   Cancel are `agent.form`, the submit is `agent.create` / `agent.edit`.
   Layout rows for the form are the only CSS added (`styles/cards.css`).
8. **The `+` menus.** `Composer.tsx` and `tabs/ChromeBar.tsx` list custom
   agents through `roleMenuEntries(harnesses, agents)` and end with a "New
   agent…" row → `agent.new` (`composer-add-new-agent`, `tab-add-new-agent`).
9. **Instructions** (`state/Instructions.ts`): the capability sentence names
   "create and manage agents (agent.new, agent.create)"; the roles paragraph
   lists every agent (custom ones ride the same rows) and says agent.list /
   agent.new / agent.create exist. `docs/LOCAL-APP.md` gains the four route
   rows.

## The instruction stage

Measured on the InstructionsBudget fixture (local host, repository open,
8 capabilities): 183 registered, 148 callable, 125 disclosed (was 176 / 141
/ 119). The prompt lands in **stage 2** (one line per namespace naming its
commands), the same stage as before this lane: prompt 11,139 B, composed
prompt + rendered context 13,895 B of the 16,384 B cap (2,489 B headroom); a
stage-0 rendering of the 125-flow catalog would be 17,219 B.
`InstructionsBudget.test.ts` stays green.

## Deviations, with reasons

- **Six built-ins, not five.** The brief says "the five built-ins"; the table
  has six (`orchestrator`, `explainer`, `implementation`,
  `trivial-implementation`, `ui`, `fast-ui`) and `ChromeBar.test` pins six.
  All six seed.
- **The composer's raw-harness row is renamed.** It read "New agent…" and
  launched the first available harness (`tab.harness`). With a real "New
  agent…" → `agent.new` row (the brief's), two rows with one label would be
  a defect, so the raw row now reads the way the sidebar's `+` already names
  raw harnesses: the harness's display name with its account or status
  ("Claude Code · will@example.com"). `ComposerLayout.test.tsx` pins it.
- **`agent.list` is not runtime-gated.** The brief wants the web host's card
  to read "Agents run on the native app's harnesses"; a `runtime`
  gate would render the registry's generic web-mode refusal instead. The
  flow registers on both hosts and the handler branches on
  `local.harnesses`. The other six agent flows are gated on
  `local.harnesses`.
- **Form field commits are a flow, not per keystroke.** Fields commit on
  blur/Enter through the hidden `agent.form` flow (agent-invocable, no
  confirm). Per-keystroke flow runs would write a transition and a toast per
  key; per-field commits keep "state in the card payload, no component
  state" without that cost.
- **The form has no id field.** The brief's mock shows Name, Purpose,
  Harness, Model; the id derives from the name (`agentIdFromLabel`:
  "Docs writer" → `docs-writer`). `agent.create` refuses an id that exists
  ("agent.edit changes it"), so a name that collides with a built-in cannot
  overwrite it.
- **`agent.create`'s label comes from the open form.** The slash grammar has
  no label slot; when the form card is open and its draft names the id, the
  controller takes the form's Name, else the id humanized.
- **A built-in's harness is fixed.** The brief makes a built-in's model and
  purpose editable; `agent.edit` has no `--harness`, and the server refuses a
  harness change on a built-in (409), so a built-in cannot drift onto a
  harness it was never verified on.
- **`models` on the wire is `{ suggestions, listable }`, never the flag.** The
  renderer needs to know which harnesses can host an agent and what to
  suggest; the flag stays server-side (the renderer never supplies argv).

## Files

Changed: `packages/rpc/src/{AgentRoles,AgentRoles.test,Cards,Cards.test,LocalApp}.ts`;
`apps/app/src/bun/{Harnesses,Harnesses.test,Pty,Pty.test,server}.ts`,
`apps/app/src/bun/routes/pty.ts`; `apps/app/src/mainview/{AgentRoleMenu,AgentRoleMenu.test}.ts`,
`ChatCards.tsx`, `Composer.tsx`, `ControllerBoot.client.ts`,
`tabs/{ChromeBar.tsx,ChromeBar.test.tsx}`, `chain/SchemaVersion.ts`,
`state/{AppState,AppStore,AppController,Instructions}.ts`,
`state/controller/{tabs,turns}.ts`, `state/{AgentRoles,ComposerLayout}.test.ts(x)`,
`flows/{Flows,SlashPayload}.ts`, `flows/{registry,agent-parity,parity}.test.ts`,
`styles/cards.css`; `apps/app/docs/LOCAL-APP.md`.

New (known-files.d.ts regenerates at commit time):
`apps/app/src/bun/routes/agents.ts`, `apps/app/src/bun/routes/agents.test.ts`,
`apps/app/src/mainview/state/controller/agents.ts`,
`apps/app/src/mainview/cards/AgentCards.tsx`,
`apps/app/src/mainview/cards/AgentCards.test.tsx`,
`apps/app/src/mainview/state/CustomAgents.test.ts`,
`apps/app/e2e/playwright/agents.spec.ts`, this report.

Untouched by instruction: `cards/FileCards.tsx`, `cards/ChangeCards.tsx`.

## Tests

- `packages/rpc/src/AgentRoles.test.ts` (7): the seed stores no argv; a
  custom row parses; a bad id, a model with a space, and a leading dash are
  refused (schema and PUT body); argv composes per harness; a flag-shaped
  model id throws at composition and a task rides as one argument;
  `orderedAgentRoles`; `agentIdFromLabel`.
- `packages/rpc/src/Cards.test.ts` (+4): the three card kinds; the subagent
  card with a custom id and purpose.
- `apps/app/src/bun/routes/agents.test.ts` (10, new): over a real local
  origin with a temp state dir — seed order, create persists to disk and
  reopens, edit (custom and built-in; built-in harness fixed → 409), bad id /
  unknown harness / no-flag harness / flag-shaped models refused, a custom
  agent launches through `POST /api/pty` with its composed argv and an
  unknown role is 404, DELETE (custom, built-in 409, unknown 404), the models
  route with a fake `opencode` script on disk (list, suggestions fallback,
  not-installed reason, no-flag reason, 404), a failing list command's
  reason, `parseModelLines`, a corrupt store file and the memory-only store.
- `apps/app/src/bun/Pty.test.ts` (+1): a custom role id resolves against the
  store and launches with its own composed argv; an unknown id is
  `unknown_role`; without a store only the built-ins resolve.
- `apps/app/src/bun/Harnesses.test.ts` (+1, one `toEqual` extended): the
  verified flag per harness, the three list commands, no entry for crush /
  amp / pi, every built-in's harness has a flag, the wire carries no flag.
- `apps/app/src/mainview/AgentRoleMenu.test.ts` (+1): custom agents after the
  built-ins under the same rule; an empty list is the built-ins.
- `apps/app/src/mainview/cards/AgentCards.test.tsx` (7, new): rows, acts and
  their flows, the web line, the kept error; the form's field commits
  (`agent.form label|purpose|harness|model`), the disabled submit, the
  datalist and chips, a filled draft's `agent.create` args and Cancel, edit
  mode's `agent.edit` flags and fixed harness, the saved / cancelled / failed
  phases; the models card.
- `apps/app/src/mainview/state/CustomAgents.test.ts` (6, new): the mirror
  loads; `agent.list` renders availability; `agent.new` prefill, the model
  list per harness, `agent.form` commits and refusals; `agent.create` PUTs
  with the form's name, re-reads, settles the form, the new agent delegates
  by role id with its purpose on the card and appears in the roles
  paragraph beside the capability sentence; the refusals (taken id, bad id,
  flag-shaped model, server refusal onto the form); `agent.edit` on a
  built-in, `agent.remove` refusing a built-in and removing a custom agent;
  `agent.models`.
- `apps/app/src/mainview/flows/agent-parity.test.ts` (+1 test, +6 policy
  rows): `agent.list` / `agent.new` / `agent.models` act without confirm,
  `agent.create` / `agent.edit` / `agent.remove` yield the confirm card;
  `agent.delegate` and `agent.role` with a custom id; `agent.form` callable
  and hidden. The user-only allowlist is unchanged (49).
- Pins updated: `flows/registry.test.ts` (seven names),
  `flows/parity.test.ts` (AgentCards 7 affordances, ChromeBar 24),
  `tabs/ChromeBar.test.tsx` (the `agent.new` row), `state/ComposerLayout.test.tsx`
  (the renamed raw row and the `agent.new` row), `state/AgentRoles.test.ts`
  (the unknown-role wording).
- T1: `e2e/playwright/agents.spec.ts` (new) — create an agent through the form
  against the server double, see it in the `+` menu with its availability and
  in the Agents card. NOT RUN (needs a browser and the built SPA); written to
  the `tabs.spec.ts` pattern with selectors that exist in the tree.

## Runs

- `cd packages/rpc && bun test`: 153/153 (14 files).
- `cd apps/app && bun x tsc --noEmit -p .`: clean apart from
  `src/bun/lsp/LspHost.test.ts` (the code-intel lane's in-flight file, not
  this lane's).
- The brief's verification set (`src/bun/routes src/bun/Pty.test.ts
  cards/AgentCards.test.tsx AgentRoleMenu.test.ts flows
  InstructionsBudget.test.ts`) plus `CustomAgents`, `AgentRoles`,
  `ChromeBar`, `ComposerLayout`, `SchemaVersion`: 254/255 (21 files) on a
  machine at load average 180 (other lanes' suites and tsc). The one red,
  `src/bun/routes/targetGraph.test.ts` "history lists a completed run and
  replay returns ordered events", sleeps a fixed 1,200 ms for a real
  `smithers-build` run and read `running`; rerun once the load fell it
  passes 5/5. It touches nothing this lane changed.
- `bun test src/mainview --timeout 30000` once, foreground: 1499/1499
  (141 files, 122 s). The per-test ceiling is there because the default 5 s
  turned load into reds: a first background run at load 180 timed out five
  `CustomAgents.test.ts` tests that pass 6/6 alone (29.6 s under that load,
  well under a second otherwise) and was itself killed at the 10-minute
  Bash cap before printing a summary.

## Not built, and why

- The e2e spec was not run (above).
- No `--harness` on `agent.edit` (a custom agent's harness is set at
  creation; changing it is `agent.remove` + `agent.create`), per the brief's
  grammar.
- The `+` menus do not show custom agents on the web host: they are gated
  on `tab.harness` (`local.harnesses`) as before, and the web has no local
  harness to launch on; `agent.list` states that on its card.

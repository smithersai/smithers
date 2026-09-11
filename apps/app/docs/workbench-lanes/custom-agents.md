# Lane: custom agents — create, configure, manage (2026-09-03)

Will, in the app at 11:46, after the agent listed the five built-in roles and
said adding new agents is not supported: "this is a bug it should be able to
create custom agents and we should have UI for configuring adding and
managing agents".

Laws (apps/app/AGENTS.md, apps/DESIGN.md, docs/workbench-lanes/agent-parity.md):
every act is ONE flow with three doors (slash, button, agent); consequential
acts confirm; EMBED LAW (management UI is cards in the chat, never a settings
page); NO INVENTION (credential and install state come from the harness
signals, never guessed); no useEffect; state in TanStack DB collections via
the dispatcher; the security boundary stays: the renderer never supplies a
launch argv, the Bun server composes it (`apps/app/src/bun/Pty.ts:247-251`).

## Today

`packages/rpc/src/AgentRoles.ts` is a hardcoded table of five roles
(`AGENT_ROLE_IDS`, `AGENT_ROLES`: id, label, purpose, model {provider, id,
label}, harness, launch argv). `AgentRoleIdSchema` is a `z.enum`, so nothing
outside the table can exist. Consumers: `AgentRoleMenu.ts` (the `+` menus,
availability from harness signals), `Composer.tsx`, `ChromeBar.tsx`,
`ChatCards.tsx`, `state/Instructions.ts` (the roles paragraph), `AppState.ts`,
`bun/Pty.ts` (resolves roleId → harness + argv), `bun/routes/pty.ts`,
`bun/CloudAgent.ts`, `flows/Flows.ts` (`agent.role`, `agent.delegate`).
`bun/Harnesses.ts` knows each harness binary and its credential signal, and
for opencode variants the `--model provider/model` launch.

## Target

Agents are data. The five built-ins stay as seeded rows (`builtin: true`,
editable model/purpose, not removable); the user adds any number of custom
agents, each = a harness the machine has + a model id that harness accepts +
a name and purpose. Everything the `+` menus, `agent.delegate`, the roles
paragraph in the instructions, and the subagent card do for a built-in works
for a custom agent.

```
┌ Agents ─────────────────────────────────────────────────── 7 ┐
│ Orchestrator      claude    claude-fable-5      ● signed in   │
│                   Launch   Edit                               │
│ Implementation    codex     gpt-5.6-sol         ● signed in   │
│ Reviewer (mine)   codex     gpt-5.6-terra       ● signed in   │
│                   Launch   Edit   Remove                      │
│ Docs writer       opencode  kimi-for-coding/k3  ○ no credential│
│                   Edit   Remove   (opencode: run `opencode auth login`) │
│                                              [ New agent ]   │
└──────────────────────────────────────────────────────────────┘

┌ New agent ──────────────────────────────────────────────────┐
│ Name      [ Reviewer                 ]                       │
│ Purpose   [ Reviews diffs for correctness and tests ]        │
│ Harness   ( claude ● ) ( codex ● ) ( opencode ○ ) ( gemini ○ ) │
│ Model     [ gpt-5.6-terra           ▾ ]  suggestions from the │
│                                          harness's model list │
│                              Cancel   [ Create agent ]       │
└──────────────────────────────────────────────────────────────┘
```

## Design

1. **Schema** (`packages/rpc/src/AgentRoles.ts`): `AgentRoleIdSchema` becomes
   a validated string (`/^[a-z][a-z0-9-]{1,40}$/`); `AgentRoleSchema` gains
   `builtin: boolean`, `createdAt`, `updatedAt`, drops `launch` from the
   stored row. Launch argv is COMPOSED, never stored:
   `roleLaunchArgv(role, harness)` = harness binary + the harness's
   `modelFlag` + the model id, where the model id must match
   `/^[A-Za-z0-9][A-Za-z0-9._\/:-]{0,80}$/` (no spaces, no leading dash: no
   flag injection). `bun/Harnesses.ts` gains per harness `models: { flag:
   ReadonlyArray<string>; suggestions: ReadonlyArray<string>; list?:
   ReadonlyArray<string> /* argv that prints one model per line */ }`
   (`claude --model`, `codex -m`, `opencode --model provider/model` with
   `opencode models` as the list command; gemini and the rest per their
   `--help`, verified against the installed binary, else `suggestions: []`
   and the field is free text).
2. **Storage and truth.** Native: `<stateDir>/agents.json` on the Bun host
   (`registerRepoTargetRoutes` shows the stateDir pattern) is the source of
   truth, seeded from the five built-ins when the file is absent. Mutations
   flush a unique sibling temporary file, rename it over `agents.json`, and
   sync the parent directory. Invalid JSON or schema data is renamed to
   `agents.json.corrupt-<timestamp>-<uuid>` and logged; reads and mutations
   reject for that store instance. A fresh launch can seed a new store while
   leaving the preserved bytes available for recovery. Other read errors
   propagate without replacing the store. Routes
   `GET /api/agents`, `PUT /api/agents/{id}` (create or edit; validates
   harness exists in the registry and the model id matches), `DELETE
   /api/agents/{id}` (refuses builtin), `GET /api/harnesses/{id}/models`
   (runs the list argv with a 5 s cap, returns lines; empty + reason on
   failure). Renderer: collection `app-agents` mirrors the route (loaded at
   boot with the harness list; re-read after every mutation); `Pty.ts`
   resolves `roleId` against the same file, so a custom agent launches
   exactly like a built-in. Web (`host: cloud`): no local harnesses, so the
   Agents card lists nothing local and reads "Agents run on the native app's
   harnesses" (the web-mode refusal path).
3. **Flows** (every one three doors; namespace `agent`):
   `agent.list` (renders the Agents card), `agent.new` (renders the New
   agent form card, prefilled from args if any), `agent.create <id>
   <harness> <model> [purpose…]` (confirm: it defines something that spends
   money), `agent.edit <id> [--model m] [--purpose p] [--label l]` (confirm),
   `agent.remove <id>` (confirm; builtin refused with the reason),
   `agent.models <harness>` (renders the model list card). `agent.role
   <id>` and `agent.delegate <id> <task>` accept custom ids. The `+` menus
   list custom agents through `roleMenuEntries` with the same availability
   rule and gain a last row "New agent…" → `agent.new`.
4. **Instructions.** The roles paragraph (`state/Instructions.ts
   orchestratorLines`) lists custom agents too, one line each, and the
   capability sentence names "create and manage agents (agent.new,
   agent.create)". `InstructionsBudget.test.ts` stays green; state the stage.
5. **Card state** lives in the card payload (`packages/rpc/src/Cards.ts`: a
   new `agents` card and an `agent-form` card with `draft` fields); form
   edits dispatch card-payload updates, never component state.

## Tests

`packages/rpc`: schema accepts a custom row and refuses a bad id or a model
with a space or leading dash; `roleLaunchArgv` composes per harness and
never includes renderer input verbatim. `apps/app/src/bun`: route tests over
a temp stateDir (seed, create, edit, delete, builtin refusal, unknown
harness refusal), models route with a fake list binary on PATH, `Pty.ts`
resolves a custom roleId (existing Pty test pattern). Renderer: Agents card
rows and actions; form card create path; `roleMenuEntries` includes custom
agents and the New agent row; `agent.delegate` with a custom id; parity and
registry pins. T1 spec (`e2e/playwright`): create an agent through the form,
see it in the `+` menu with its availability.

## Files

`packages/rpc/src/{AgentRoles,Cards}.ts` (+tests), `apps/app/src/bun/{Harnesses,Pty}.ts`,
new `apps/app/src/bun/routes/agents.ts` (+test), `apps/app/src/bun/server.ts`
(route registration, stateDir), `apps/app/src/mainview/{AgentRoleMenu,Composer,ChatCards}.tsx|ts`
(menu rows + card mount), new `cards/AgentCards.tsx` (+test),
`state/AppStore.ts` + `chain/SchemaVersion.ts` (`app-agents`),
`state/controller/agents.ts` (new) wired in `AppController.ts`,
`flows/{Flows,SlashPayload,registry}.ts`, `state/Instructions.ts`,
`tabs/ChromeBar.tsx` (the `+` menu's New agent row only). Sequenced AFTER
the agent-parity lane (same flow files); re-read shared files before each
edit regardless.

## Verification

`cd packages/rpc && bun test`; `cd apps/app && bun x tsc --noEmit -p . && bun test src/bun/routes src/bun/Pty.test.ts src/mainview/cards/AgentCards.test.tsx src/mainview/AgentRoleMenu.test.ts src/mainview/flows src/mainview/state/InstructionsBudget.test.ts`, then `bun test src/mainview` once. Write `custom-agents.REPORT.md`.

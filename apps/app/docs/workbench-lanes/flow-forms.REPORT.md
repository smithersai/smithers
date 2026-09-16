# Lane `flow-forms` — REPORT

Brief: `flow-forms.md`. Laws: `apps/app/AGENTS.md` (EMBED, NO INVENTION,
THE THREE-DOOR LAW, and now THE FORM LAW), `apps/DESIGN.md`. Status: shipped
and green. Nothing committed; no `jj`/`git` write ran; the app was not
launched, relaunched, or quit.

## What shipped

## The instruction stage

Measured on the InstructionsBudget fixture (local host, repository open,
every local capability): 188 registered, 153 callable, 128 disclosed (was
183 / 148 / 125). The prompt lands in **stage 2** (one line per namespace),
as before this lane: prompt 11,416 B, composed prompt + rendered context
14,172 B of the 16,384 B cap (2,212 B headroom); a stage-0 rendering of the
128-flow catalog would be 17,760 B. `InstructionsBudget.test.ts` is green.

## Field hints, by flow

## Deviations, with reasons

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

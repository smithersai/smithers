# Smithers `init` and Local Workflow Workspace Design

## Summary

This document proposes a simpler local-first Smithers experience centered on:

- `smithers init` to install an opinionated local workflow pack into `.smithers/`
- `smithers workflow <name>` to run a seeded or user-edited workflow from `.smithers/workflows/<name>.tsx`
- generated `.smithers/agents.ts` based on real agent availability on the current machine, preferring subscription-backed CLIs first and API-key-backed agents second
- a default workflow catalog that includes `implement`, `review`, `plan`, `ticket`, `tickets`, `ralph`, `improve-test-coverage`, `test-first`, and `debug`
- reusable shared infrastructure where components like `<Review />` get reused across multiple workflows

The key product insight is that users mostly want a ready-made folder of workflows they can use immediately and edit later if they choose. The hello-world path should feel like:

```bash
smithers init
smithers workflow implement --prompt "Commit the .smithers folder created with smithers init"
```

## Goals

- Make local Smithers workflows feel like a first-class project feature, not ad hoc TSX files.
- Let users run `smithers workflow implement` instead of memorizing file paths.
- Generate a usable default workspace on day one, including shared prompts, reusable review components, and practical starter workflows.
- Auto-configure agent roles from what is actually available on the machine.
- Reuse the model ordering and fallback philosophy already encoded in `~/codeplane`.
- Make code reuse visible by having multiple seeded workflows import the same shared components.

## Non-goals

- Replacing `smithers up <path>` or direct-file execution. Those remain supported.
- Solving remote workflow hosting or Burns authoring in this phase.
- Building first-class GitHub issue tools in core Smithers before the rest of the scaffold lands.
- Perfectly proving every provider login state without ever invoking a provider-specific command. Some CLIs expose only heuristic auth signals.

## Current State and Constraints

### 1. Smithers already reserves `.smithers/` for runtime artifacts

Today Smithers writes logs under `.smithers/executions/<runId>/logs` by default in the workflow root. The relevant runtime default lives in `src/engine/index.ts`.

Implication:

- `smithers init` can use `.smithers/` as the local workspace root
- but it must preserve `.smithers/executions/` and treat `.smithers/` as a mixed-purpose directory
- the generated `.smithers/.gitignore` must ignore runtime artifacts and dependencies

### 2. Burns already expects folder-based workflows

The Burns daemon already treats `.smithers/workflows/<workflow-id>/workflow.tsx` or `workflow.ts` as the canonical self-managed layout. This is implemented in `burns/apps/daemon/src/services/workflow-service.ts` and covered by daemon route tests.

Implication:

- Burns compatibility currently points one way
- but the simpler local CLI product points another way: flat workflow files under `.smithers/workflows/*.tsx`

This design chooses the simpler local workflow-pack model for Smithers CLI:

- keep `.mdx` in `.smithers/prompts/` and `.smithers/components/`
- keep workflow entrypoints as flat `.tsx` files in `.smithers/workflows/`
- treat Burns compatibility as a follow-up that can support both layouts later if needed

### 3. Smithers CLI currently has no workflow registry subcommand

`src/cli/index.ts` supports:

- `up`
- `ps`
- `logs`
- `inspect`
- `approve`
- `deny`
- `cancel`
- `graph`
- `revert`
- direct-file execution like `smithers workflow.tsx`

Implication:

- `smithers workflow` must be added as a new top-level command group
- discovery logic should live in shared code, not inline in the command handler
- existing direct-file behavior should remain intact

### 4. The machine already has a rich local agent footprint

Observed on this machine, without reading secrets:

- binaries present: `claude`, `codex`, `gemini`, `pi`, `kimi`, `forge`, `amp`
- env var names present: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `LINEAR_API_KEY`
- config/auth directories present: `~/.claude`, `~/.codex`, `~/.gemini`, `~/.pi`

Implication:

- the generated `agents.ts` should not assume only one provider
- the scaffold can safely generate first-class Claude, Codex, Gemini, and Pi roles on this machine
- Kimi, Forge, and Amp can be detected too, but they should start as opportunistic extras until auth detection is hardened

### 5. Smithers and Codeplane already encode model precedence

Smithers’ current guidance in `docs/guides/model-selection.mdx` says:

- `gpt-5.3-codex` for implementation and validation
- `claude-opus-4-6` for research, planning, and review
- `claude-sonnet-4-5-20250929` for lighter/faster tasks

`~/codeplane/specs/generate/index.tsx` goes further and encodes role-specific fallback chains:

- spec: `claude -> codex`
- research: `gemini -> kimi -> codex -> claude`
- review research: `claude -> kimi -> codex -> gemini`
- plan: `gemini -> codex -> claude -> kimi`
- review plan: `codex -> claude -> gemini -> kimi`
- implementation: dynamic primary, fallback order `gemini -> codex -> claude -> kimi`

`~/codeplane/specs/tui/generate/index.tsx` uses a simpler but consistent trio:

- spec: Claude Opus
- implement: Gemini 3.1 Pro
- review: Codex

Implication:

- `init` should generate role-based agent chains, not only one-off named agents
- `agents.ts` should encode fallback arrays or factories for role selection

## External Workflow Influence

Matt Pocock’s recent AI workflow material points in the same direction as the Smithers patterns already in this repo:

- plan-first workflows, not giant up-front context files
- tight review and feedback loops
- tests-first or tests-early prompting
- reusable iterative loops like Loop

Relevant references:

- AI Hero: `Never run Claude /init` recommends against giant static context dumps and favors smaller reusable workflow assets
- AI Hero: `Plan Mode Introduction` favors explicit planning passes before implementation
- AI Hero: `My AGENTS.md file for building plans you actually read` emphasizes structured, scannable plans
- AI Hero: `My Skill Makes Claude Code GREAT At TDD` pushes tests-first scaffolds
- AI Hero: `11 Tips For AI Coding With Ralph` aligns with Smithers’ own review-loop and iteration model

Implication:

- `smithers init` should create modular prompts/components/workflows
- not a single giant root context artifact
- and the default workflow set should include plan, review, TDD/test-first, and Loop-driven iteration

## Recommendation

## 1. Adopt a Flat Workflow-Pack `.smithers/` Layout

Recommended scaffold:

```text
.smithers/
  .gitignore
  package.json
  tsconfig.json
  bunfig.toml
  preload.ts
  agents.ts
  smithers.config.ts
  prompts/
    review.mdx
    plan.mdx
    implement.mdx
    validate.mdx
    coverage.mdx
    ticket.mdx
  components/
    Review.tsx
    Review.mdx
    ValidationLoop.tsx
    TicketRouter.tsx
    CommandProbe.tsx
  workflows/
    implement.tsx
    review.tsx
    plan.tsx
    ticket.tsx
    tickets.tsx
    ralph.tsx
    improve-test-coverage.tsx
    test-first.tsx
    debug.tsx
  tickets/
  executions/
```

Why this shape:

- it matches the product intuition users actually have
- it preserves Smithers’ current runtime artifact path
- it supports shared MDX prompts and shared TSX components
- it makes the workflow pack feel like a library, not a maze of folders
- it makes code reuse obvious because several workflows can import the same `<Review />`

## 2. Add a New `smithers workflow` Command Group

Recommended command surface:

```bash
smithers init
smithers workflow               # same as workflow list
smithers workflow list
smithers workflow <name>
smithers workflow run <name>
smithers workflow create <name>
smithers workflow path <name>
smithers workflow doctor [<name>]
```

Behavior:

- `smithers workflow` with no subcommand lists discovered workflows
- `smithers workflow implement --prompt "..."`
  - should resolve `.smithers/workflows/implement.tsx`
  - and delegate into the existing workflow execution path
- `smithers workflow run implement --prompt "..."` is an explicit synonym
- `smithers workflow create <name>` scaffolds a new flat workflow file at `.smithers/workflows/<name>.tsx`
- `smithers workflow path <name>` prints the resolved workflow entry file
- `smithers workflow doctor` validates discovery, agent availability, and MDX preload integrity

Recommended list output columns:

- workflow ID
- workflow display name
- entry file path
- source type: `seeded`, `user`, or `generated`

Do not remove:

- `smithers up <path>`
- direct path execution like `smithers ./workflows/foo.tsx`

## 3. Make `smithers init` a Deterministic Workflow-Pack Installer

`smithers init` should be boring and reliable.

It should:

- create `.smithers/` if missing
- preserve `.smithers/executions/` if present
- write baseline workspace files
- detect available agents
- write a seed `agents.ts`
- scaffold the default flat workflow pack
- never require network access to succeed

Repo-specific enrichment like lint/test/coverage inference is still valuable, but it should not be in the critical path for v1. That can be a later opt-in workflow or follow-up command.

## Agent Detection and `agents.ts`

## Generated `.smithers/package.json` and tooling

The generated `.smithers/` directory should be a real Bun workspace package.

Recommended dependency policy:

- runtime dependencies
  - `smithers-orchestrator`
  - `zod`
- dev dependencies
  - `typescript`
  - `@types/react`
  - `@types/react-dom`
  - `@types/mdx`

Recommended scripts:

```json
{
  "scripts": {
    "typecheck": "tsc --noEmit",
    "workflow:list": "smithers workflow list",
    "workflow:run": "smithers workflow run",
    "workflow:implement": "smithers workflow implement"
  }
}
```

Rationale:

- CLI agents do not require `ai` or provider SDK packages when the scaffold is CLI-first
- MDX support is first-class in the requested layout, so MDX types should be present from day one
- the package should stay minimal until the user opts into API-backed agents

## Detection precedence

Use this order:

1. Confirmed subscription-backed CLI auth
2. Likely subscription-backed CLI auth
3. API-key-backed provider availability
4. Binary-only availability
5. unavailable

### First-class detectors in v1

These have a reasonable local signal:

- Claude Code
  - binary: `claude`
  - likely subscription signal: `~/.claude/`
  - API fallback signal: `ANTHROPIC_API_KEY`
- Codex
  - binary: `codex`
  - likely auth/config signal: `~/.codex/`
  - API fallback signal: `OPENAI_API_KEY`
- Gemini CLI
  - binary: `gemini`
  - likely auth/config signal: `~/.gemini/oauth_creds.json` or `gcloud auth print-access-token`
  - API fallback signal: `GOOGLE_API_KEY` or `GEMINI_API_KEY`
- Pi
  - binary: `pi`
  - likely auth/config signal: `~/.pi/agent/auth.json`
  - provider/model selection happens inside Pi
- Kimi
  - binary: `kimi`
  - likely auth/config signal: `~/.kimi` or `KIMI_SHARE_DIR`

### Best-effort extras in v1

- Forge
- Amp

For these, binary presence can be recorded, but they should not become default role assignments until auth detection is less heuristic.

## Error behavior

`smithers init` should fail only when no usable agent exists after evaluating both subscriptions and API keys.

Recommended error contract:

- if no binary and no API key path exists for any supported agent, exit with a typed error
- the error should list what was checked
- the error should suggest concrete fixes, for example:
  - install `codex`
  - log in to `claude`
  - set `OPENAI_API_KEY`

## Generated `agents.ts`

Generate role-based exports, not only provider-based exports.

Recommended structure:

```ts
export const providers = {
  claude,
  codex,
  gemini,
  kimi,
  pi,
}

export const roleChains = {
  spec: [claude, codex],
  research: [gemini, kimi, codex, claude],
  plan: [gemini, codex, claude, kimi],
  implement: [codex, gemini, claude, kimi],
  validate: [codex, gemini],
  review: [claude, codex],
  fast: [claudeSonnet, geminiFlash, piFast],
}
```

Recommended default models, based on current Smithers and local Codeplane usage:

- Claude: `claude-opus-4-6`
- Claude fast: `claude-sonnet-4-5-20250929`
- Codex: `gpt-5.3-codex` with reasoning effort `high`
- Gemini: `gemini-3.1-pro-preview`
- Kimi: `kimi-latest`
- Pi:
  - provider chosen from detected auth
  - default model should mirror the best detected fast/high-capability pair, not invent a separate strategy

## Default Workflow Catalog

## Core set to ship in v1

- `review`
  - reusable multi-agent review of a patch, diff, file set, or repo change
  - backed by shared `components/Review.tsx`
- `implement`
  - the default “go build this” workflow
  - intended to be the most obvious first-run workflow
- `ticket`
  - implement exactly one ticket from input or one local markdown ticket file
- `tickets`
  - batch ticket runner that can source from `.smithers/tickets/*.md`, Linear, or GitHub based on flags
- `ralph`
  - generic iterative implement/validate/review loop template
- `plan`
  - research plus implementation plan workflow
- `improve-test-coverage`
  - identify and implement the 10 highest-impact missing tests
- `test-first`
  - Matt Pocock-inspired tests-first workflow that writes or updates tests before implementation
- `debug`
  - reproduce, isolate, and propose/fix a bug with explicit repro evidence

## Recommended optional set

- `create`
- `pr-feedback`
- `docs-update`
- `release-notes`
- `refactor-safely`
- `explain`

## User-requested behavior for ticket workflows

### `ticket`

Implements a single ticket from:

- `--file .smithers/tickets/foo.md`
- `--linear ISSUE-123`
- `--github 123`
- raw JSON input

### `tickets`

Discovers or reads multiple tickets from:

- local markdown files under `.smithers/tickets/*.md`
- Linear via custom tools or MCP-backed agent integrations, not a core `smithers-orchestrator/linear` export
- GitHub issues via `gh` CLI or HTTP integration

Important design note:

- Linear is already documented in Smithers
- GitHub issue support is not first-class in core Smithers today
- therefore GitHub in v1 should use a shell-backed adapter or a minimal wrapper around `gh`

## Reusable Review Substrate

The `Review.tsx` workflow component should be reused across all code-changing workflows.

Recommended shared components:

- `components/Review.tsx`
- `components/ValidationLoop.tsx`
- `components/CommandProbe.tsx`

Recommended shared prompts:

- `prompts/review.mdx`
- `prompts/validate.mdx`
- `prompts/implement.mdx`
- `prompts/coverage.mdx`

Recommended rule:

- every workflow that writes code should either call `Review.tsx` directly or compose `ValidationLoop.tsx`
- exceptions should be intentionally limited to read-only workflows like `plan` or `explain`

This matches Smithers’ existing `docs/guides/review-loop.mdx` recommendation and the worktree-feature example.

## Repo Command Discovery

The user asked for reusable config for lint, test, coverage, expected time, and expected tokens.

The right place for this is a generated `.smithers/smithers.config.ts`.

Recommended shape:

```ts
export const repoCommands = {
  lint: { command: "bun run lint", cwd: ".", expectedSeconds: 30, expectedTokens: 1200 },
  test: { command: "bun test", cwd: ".", expectedSeconds: 90, expectedTokens: 2400 },
  coverage: { command: "bun test --coverage", cwd: ".", expectedSeconds: 150, expectedTokens: 3200 },
}
```

### Future inference plan

Read, in order:

- root `package.json`
- workspace package manifests
- `bunfig.toml`
- `turbo.json`, `nx.json`, `moon.yml`, `justfile`, `Makefile`
- `.github/workflows/*.yml`
- README, CONTRIBUTING, docs mentioning lint/test/coverage

Then the `init` workflow should ask an LLM to synthesize:

- the best lint command
- the best test command
- the best coverage command
- expected runtime classes: `fast`, `medium`, `slow`
- expected token classes for review/validation prompts

Important constraint:

- the LLM should produce plain config data
- not executable prose
- and `smithers.config.ts` should remain human-editable

This should be a later explicit refinement step, not part of the initial `smithers init` success path.

## Proposed `smithers init` File Set

Minimum files to write in v1:

- `.smithers/.gitignore`
- `.smithers/package.json`
- `.smithers/tsconfig.json`
- `.smithers/bunfig.toml`
- `.smithers/preload.ts`
- `.smithers/agents.ts`
- `.smithers/smithers.config.ts`
- `.smithers/prompts/review.mdx`
- `.smithers/prompts/plan.mdx`
- `.smithers/prompts/implement.mdx`
- `.smithers/prompts/validate.mdx`
- `.smithers/components/Review.tsx`
- `.smithers/components/ValidationLoop.tsx`
- `.smithers/workflows/implement.tsx`
- `.smithers/workflows/review.tsx`
- `.smithers/workflows/plan.tsx`
- `.smithers/workflows/ticket.tsx`
- `.smithers/workflows/tickets.tsx`
- `.smithers/workflows/ralph.tsx`
- `.smithers/workflows/improve-test-coverage.tsx`
- `.smithers/workflows/test-first.tsx`
- `.smithers/workflows/debug.tsx`
- `.smithers/tickets/.gitkeep`

Recommended `.gitignore` entries:

```gitignore
node_modules/
executions/
*.db
*.sqlite
dist/
.DS_Store
```

## Open Questions

## 1. Flat local CLI workflows vs Burns-compatible folders

Recommendation:

- standardize local Smithers CLI on `.smithers/workflows/*.tsx`
- keep `.mdx` only for prompts and components
- if Burns needs folder-based workflows later, support both discovery styles rather than making local CLI worse now

## 2. Should `smithers init` infer repo commands immediately?

Recommendation:

- not in v1
- keep `smithers init` deterministic
- add inference later behind an explicit follow-up workflow or flag

## 3. How much GitHub issue support should land in v1?

Recommendation:

- Linear first-class in v1
- GitHub via `gh` adapter in v1
- native GitHub issue helpers later

## 4. Should Kimi, Forge, and Amp be generated into `agents.ts` on day one?

Recommendation:

- Kimi yes if binary and auth/config are present
- Forge and Amp only behind an `extras` section until auth detection is hardened

## 5. Where should reusable prompts live?

Recommendation:

- shared prompts in `.smithers/prompts/`
- workflow-specific prompts beside the workflow only when they truly diverge

## Implementation Plan: E2E TDD With Verification At Every Step

Rule for the whole implementation:

- every milestone starts with a failing end-to-end test
- implementation only proceeds until that test passes
- after the E2E passes, add narrower unit or integration tests if they improve diagnosis
- do not move to the next milestone until the current milestone’s full verification gate is green

### Step 0. Build the E2E harness first

Target behavior:

- we can create a temporary repo, run the Smithers CLI inside it, and inspect resulting files and run output

Failing tests to write first:

- `init.e2e.test.ts`: can create a temp repo and invoke the CLI
- `workflow-command.e2e.test.ts`: can invoke `smithers workflow ...` in that temp repo

Harness requirements:

- temp repo helper
- CLI runner helper
- fixture assertions for file existence and file content
- helper to prepend a fake `PATH`
- helper to create fake `claude`, `codex`, and `gemini` binaries that emit deterministic schema-valid output

Verification gate:

- the E2E harness can run the CLI, assert exit codes, and inspect filesystem changes

### Step 1. Add flat workflow discovery

Target behavior:

- Smithers discovers `.smithers/workflows/*.tsx`

Failing E2E tests:

- `.smithers/workflows/implement.tsx` appears in `smithers workflow list`
- `smithers workflow path implement` resolves to `.smithers/workflows/implement.tsx`

Implementation:

- add workflow discovery helpers for flat files
- keep direct-file execution intact

Verification gate:

- discovery tests pass
- existing direct-file CLI tests still pass

### Step 2. Add direct workflow invocation UX

Target behavior:

- `smithers workflow implement --prompt "..."` runs the `implement` workflow directly

Failing E2E tests:

- `smithers workflow implement --prompt "hello"` resolves and runs the workflow
- `smithers workflow run implement --prompt "hello"` is a synonym
- `smithers workflow` with no args lists workflows

Implementation:

- extend CLI parsing so unknown `workflow` subcommand names can resolve as workflow IDs
- keep explicit utility subcommands like `list`, `path`, `create`, `doctor`

Verification gate:

- all three behaviors pass end to end
- help and unknown-command error behavior remain coherent

### Step 3. Add deterministic `smithers init`

Target behavior:

- `smithers init` installs the workflow pack and shared infrastructure

Failing E2E tests:

- init in a clean repo writes expected files
- init in a repo with `.smithers/executions/` preserves executions
- init re-run does not clobber user-edited workflow files unless `--force` is passed

Implementation:

- scaffold writer for `.smithers/`
- `.gitignore`
- `package.json`
- `tsconfig.json`
- `bunfig.toml`
- `preload.ts`
- shared prompts/components
- flat workflow files

Verification gate:

- file snapshot assertions pass
- `bun --cwd .smithers run typecheck` passes in the temp repo

### Step 4. Add shared `<Review />` reuse

Target behavior:

- multiple seeded workflows import and reuse the same shared review component

Failing tests:

- static contract test: seeded workflows import `../components/Review` or equivalent shared path
- end-to-end graph/render test: `implement`, `ticket`, and `improve-test-coverage` all mount review nodes through shared composition

Implementation:

- build `components/Review.tsx`
- build `components/ValidationLoop.tsx`
- wire seeded workflows through the shared components instead of duplicating review logic

Verification gate:

- static reuse tests pass
- runtime graph or smoke execution confirms shared review composition is actually exercised

### Step 5. Add agent detection and generated `agents.ts`

Target behavior:

- `smithers init` writes `agents.ts` using subscription-first and API-key-second precedence

Failing E2E tests:

- with only fake `claude` binary and no keys, generated `agents.ts` prefers Claude
- with fake `codex` and `OPENAI_API_KEY`, generated `agents.ts` includes Codex implementation role
- with multiple fake binaries, role chains are ordered correctly
- with no usable agents, init exits with a clear typed error

Implementation:

- add agent detection registry
- detect local auth/config state without exposing secrets
- generate role-based exports and fallback chains

Verification gate:

- generated `agents.ts` snapshot matches expectations for each fixture
- the generated file typechecks

### Step 6. Add the seeded workflow pack

Target behavior:

- the default pack is actually usable on day one

Failing E2E tests:

- `smithers workflow implement --prompt "..."` completes using fake agent binaries
- `smithers workflow review --prompt "..."` completes
- `smithers workflow plan --prompt "..."` completes
- `smithers workflow improve-test-coverage --prompt "..."` resolves and runs

Implementation:

- scaffold `implement.tsx`
- scaffold `review.tsx`
- scaffold `plan.tsx`
- scaffold `ticket.tsx`
- scaffold `tickets.tsx`
- scaffold `ralph.tsx`
- scaffold `improve-test-coverage.tsx`
- scaffold `test-first.tsx`
- scaffold `debug.tsx`

Verification gate:

- each seeded workflow has at least one passing smoke E2E in a temp repo with fake agents
- generated logs still land under `.smithers/executions/<runId>/logs`

### Step 7. Add workflow creation for user-defined flat workflows

Target behavior:

- users can add their own workflows in the same flat style as the seeded pack

Failing E2E tests:

- `smithers workflow create foo` writes `.smithers/workflows/foo.tsx`
- `smithers workflow foo --prompt "..."` runs immediately after creation
- invalid names are rejected

Implementation:

- scaffold a minimal flat workflow template that imports shared components if useful

Verification gate:

- created workflow is discoverable, runnable, and typechecks

### Step 8. Final documentation and regression pass

Target behavior:

- docs match the product
- existing CLI behavior outside the new command surface is not regressed

Required checks:

- update CLI docs and examples
- rerun relevant CLI/unit/integration suites
- rerun all new E2E tests

Verification gate:

- new docs reflect `smithers init` plus `smithers workflow implement`
- all new E2E tests pass
- no previously passing core CLI tests are broken

## Approval Recommendation

The key product decision to approve before implementation is this:

- standardize local Smithers CLI on `.smithers/workflows/*.tsx`
- make `smithers init` a deterministic workflow-pack installer
- make `smithers workflow implement` the primary first-run UX
- treat `.mdx` as prompt/component assets, not workflow entrypoints

If that is approved, the rest of the design follows naturally and stays aligned with the simpler local Smithers CLI product direction.
If Burns later needs to consume the same workflows, it should add dual discovery rather than forcing the local CLI away from the flat-file UX.

## Sources

Local code and docs:

- `src/cli/index.ts`
- `src/engine/index.ts`
- `docs/guides/model-selection.mdx`
- `docs/guides/review-loop.mdx`
- `docs/guides/mdx-prompts.mdx`
- `burns/apps/daemon/src/services/workflow-service.ts`
- `burns/apps/daemon/src/domain/workflows/templates.ts`
- `~/codeplane/specs/generate/index.tsx`
- `~/codeplane/specs/tui/generate/index.tsx`

External references:

- https://www.aihero.dev/never-run-claude-init
- https://www.aihero.dev/plan-mode-introduction
- https://www.aihero.dev/my-agents-md-file-for-building-plans-you-actually-read
- https://www.aihero.dev/my-skill-makes-claude-code-great-at-tdd
- https://www.aihero.dev/11-tips-for-ai-coding-with-ralph

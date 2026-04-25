# `.smithers` workspace fails `tsc`; `AgentLike` arg shape diverges from generated types

> Target repo: **smithers**
> Source: 2026-04-25 hardening review

## Problem

`pnpm-workspace.yaml:1` includes `.smithers` as a workspace, but
`pnpm -r typecheck` fails inside it. The workspace cannot be a
template/example *and* be silently broken — either should be impossible.

Two concrete contract mismatches:

1. **`AgentLike` vs. generated agent types.**
   - `.smithers/agents.ts:12` declares `AgentLike[]`.
   - `packages/agents/src/AgentLike.ts:27` defines
     `generate(args: unknown)` (the wide contract).
   - The concrete generated agent classes in
     `packages/agents/src/index.d.ts:250` expose a narrower optional
     `AgentGenerateOptions`.
   - The arrays in `.smithers/agents.ts:13–15` and downstream workflow
     props at `.smithers/workflows/kanban.tsx:130` are rejected by
     TypeScript because the narrower types are not assignable to the
     wider `AgentLike` slot.

2. **Untyped `ctx.input` in workflows.**
   - `.smithers/workflows/kanban.tsx:111` reads `ctx.input` while the
     workflow context types `input` as `unknown`. There's no per-
     workflow input typing in the JSX context surface.

## Goal

`.smithers` typechecks cleanly under `pnpm -r typecheck`, and the
`AgentLike` contract is the single source of truth that all generated
agents satisfy by construction.

## Scope

### Reconcile `AgentLike` with generated agent classes

- Decide which direction to widen/narrow:
  - **Preferred:** make `AgentLike.generate` parameterized:
    `generate(args?: AgentGenerateOptions): Effect<...>`. Drop the
    `unknown` form. Update `packages/agents/src/AgentLike.ts:27` and
    every concrete agent's `.d.ts` to satisfy it.
  - Alternative: keep `unknown` and have generated agents declare
    `generate(args: unknown)` plus a typed `generateTyped` overload.
- Add a compile-time assertion in `packages/agents/src/__type-tests__/`
  that every concrete agent (`ClaudeCodeAgent`, `CodexAgent`,
  `GeminiAgent`, etc.) is assignable to `AgentLike`.

### Type the workflow context input

- Thread the per-workflow input schema into the context type so
  `ctx.input` is typed against the workflow's declared input zod
  schema instead of `unknown`.
- Update `.smithers/workflows/kanban.tsx:111` to use the typed shape.

### Keep `.smithers` honest

- Add `pnpm --filter ./.smithers typecheck` to CI (alongside the
  workspace typecheck) so the template never regresses.
- Document `.smithers` in the docs site as a working example, with a
  CI link confirming it builds & typechecks.

## Files

- `packages/agents/src/AgentLike.ts`
- `packages/agents/src/index.d.ts`
- `packages/agents/src/__type-tests__/AgentLike.assignability.test-d.ts`
  (new)
- `packages/components/src/types.ts` (or wherever `WorkflowContext` is)
- `.smithers/agents.ts`
- `.smithers/workflows/kanban.tsx`
- `.github/workflows/ci.yml` — add `.smithers` typecheck step

## Testing

- `pnpm -r typecheck` passes including `.smithers`.
- Type test: every generated agent satisfies `AgentLike` with no
  cast.
- Negative type test: a workflow that reads `ctx.input.foo` for a
  workflow whose input doesn't declare `foo` fails to compile.

## Acceptance

- [ ] `pnpm -r typecheck` is green from a clean clone.
- [ ] `AgentLike` is the contract; concrete agents satisfy it without
      cast.
- [ ] `ctx.input` is typed against the declared input schema in
      `.smithers/workflows/kanban.tsx` and any other workflow that
      reads it.
- [ ] CI includes `.smithers` typecheck.

## Blocks

- Adjacent to 0021 (docs as contracts). `.smithers` is the lived
  contract — it must compile.

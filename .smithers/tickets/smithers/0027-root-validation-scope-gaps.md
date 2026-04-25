# Root `pnpm typecheck` / `lint` scope is too narrow — false-green CI

> Target repo: **smithers**
> Source: 2026-04-25 hardening review

## Problem

Root validation gives false confidence:

- `pnpm typecheck` only covers the narrow `include` list in
  `tsconfig.json:208`.
- The root `lint` script at `package.json:60` only globs
  `packages/*/src packages/*/tests`, skipping `apps/*` and
  `.smithers` entirely.

Net effect: the root commands report green while package- and
workspace-scoped commands fail. Specifically, `pnpm -r typecheck`
fails inside `.smithers` (see 0026), and `pnpm -r ... test` fails in
`apps/cli` (see 0024) and `packages/agents` (see 0025), but a
contributor running just `pnpm typecheck && pnpm lint` at root sees
nothing wrong.

## Goal

The root scripts a contributor or CI runs as a quick gate must reflect
the truth: if any package or workspace fails its own checks, the root
gate fails too.

## Scope

### Typecheck

- Either:
  1. Replace the narrow root `tsconfig.json` `include` with a
     project-references setup that points at every package + app +
     `.smithers`, so `tsc -b` walks them all; or
  2. Make `pnpm typecheck` at root simply run
     `pnpm -r --include-workspace-root typecheck`, with each package
     owning its own `tsconfig`.
- Option 2 is simpler and matches the "each package is self-contained"
  invariant.
- Either way, `tsconfig.json:208` should not be the canonical
  validator scope.

### Lint

- Update `package.json:60` to lint `apps/*/src apps/*/tests
  packages/*/src packages/*/tests .smithers/**/*.{ts,tsx}` (or move to
  `pnpm -r lint`).
- Add a lint config to `.smithers` (or extend the root one) that
  matches its `tsx`/`ts` files.

### CI gate

- The CI matrix must run, at minimum:
  - `pnpm -r typecheck`
  - `pnpm -r lint`
  - `pnpm -r test` with a documented allowlist of skipped packages
    only when there's a tracked ticket.
- Drop the narrow root-only invocations from CI; they hide failures.

### Developer ergonomics

- Document the canonical pre-PR commands in `CONTRIBUTING.md` (or
  `docs/contributing/checks.mdx`).
- Add a `pnpm verify` alias that runs the recursive checks in the
  right order (typecheck → lint → test).

## Files

- `tsconfig.json` (root) — project references or scope reduction
- `package.json` (root) — `lint`, `typecheck`, new `verify` script
- `.smithers/tsconfig.json` and `.smithers/.eslintrc.*` if missing
- `.github/workflows/ci.yml`
- `docs/contributing/checks.mdx` (new)

## Testing

- Intentionally introduce a type error in `apps/cli/src/` and
  `.smithers/agents.ts`. Confirm `pnpm verify` (and CI) fail in both
  cases. Revert.
- Same for an ESLint rule violation in each scope.

## Acceptance

- [ ] Root `pnpm typecheck` / `pnpm lint` cover every workspace, or
      are replaced by `pnpm -r ...` equivalents.
- [ ] CI runs the recursive variants, not the narrow root ones.
- [ ] Introducing an error in `apps/*` or `.smithers/` is caught by
      the root gate.
- [ ] `CONTRIBUTING.md` (or equivalent) documents the canonical
      verification command.

## Blocks

- Precondition for 0024, 0025, 0026 to *stay* fixed. Without this
  ticket, the same class of regression returns the next time someone
  adds a workspace.

# `@mariozechner/pi-tui` is an undeclared import-time dep of `smithers`

> Target repo: **smithers**
> Source: 2026-04-25 hardening review

## Problem

`packages/smithers/src/pi-plugin/extension.js:37` imports
`@mariozechner/pi-tui`, but the package is **not** declared in
`packages/smithers/package.json` (`dependencies` ends at line 39 with
no `@mariozechner/pi-tui` entry) and is absent from the lockfile.

Consequences:

- Installing `smithers-orchestrator` from a clean cache and importing
  anything that pulls `pi-plugin/extension.js` fails at module
  resolution time.
- `packages/agents/tests/agent-contract.test.js:3` currently fails for
  this reason — its top-level import chain reaches the extension.
- The break is invisible inside this monorepo because the package is
  hoisted from somewhere else in `node_modules`.

## Goal

`pi-plugin/extension.js` either declares its dependency honestly, or
the dependency is moved out of the public smithers API surface so it
isn't loaded transitively.

## Scope

### Option A — declare the dep

- Add `@mariozechner/pi-tui` to `packages/smithers/package.json`
  `dependencies` (or `peerDependencies` if consumers should bring it
  themselves).
- Run `pnpm install` to lock it.
- Add a test that resolves `smithers-orchestrator/pi-plugin/extension`
  in a clean install (or with a mocked `node_modules` that contains
  only declared deps) and asserts the import succeeds.

### Option B — split the surface (preferred)

- Move pure prompt-building / spec exports into a dependency-free
  module (e.g. `packages/smithers/src/pi-plugin/spec.js`).
- Keep the TUI-rendering pieces in `extension.js` and gate them behind
  a lazy `await import("@mariozechner/pi-tui")` so the dep is only
  pulled when a TUI consumer actually invokes the renderer.
- Update barrel re-exports so the default import path doesn't pull the
  TUI code.

Pick Option B if the import-time cost of `pi-tui` is non-trivial or if
non-TUI consumers (CLI JSON paths, server-side workflows) shouldn't
pay for it.

## Files

- `packages/smithers/src/pi-plugin/extension.js`
- `packages/smithers/src/pi-plugin/spec.js` (new, if Option B)
- `packages/smithers/package.json`
- `packages/agents/tests/agent-contract.test.js` — verify it stops
  breaking once the fix lands.

## Testing

- Contract: clean-install resolution test (no hoisting) imports
  `smithers-orchestrator` and `smithers-orchestrator/pi-plugin/...`
  without error.
- Unit: re-enable / un-skip `agent-contract.test.js`.
- Optional bundle test: assert that the default
  `smithers-orchestrator` entrypoint does **not** bundle `pi-tui` (if
  Option B).

## Acceptance

- [ ] No import path published from `smithers-orchestrator` reaches
      `@mariozechner/pi-tui` without that dep being declared.
- [ ] `agent-contract.test.js` passes.
- [ ] Clean-install reproduction documented in the test suite.

## Blocks

- Adjacent to 0021 (docs as contracts) — package boundaries are part
  of the contract.

---
title: Registry resource, lockfile identity and pack validation fixes
status: done
area: registry
owner: codex-mini-451826
updated: 2026-10-22
links:
  - ../../../../packages/smithers/agent/registry
---

Reproduce the three reported registry bugs, retain regression tests, and fix
resource schema admission, measured lockfile declaration identity, and unresolved
pack-root confinement. Use the library catalog's `@smthrs/registry` entry and
Effect Schema and FileSystem services; add no dependencies. No device schema changes.

All three findings reproduced and fixed. Sandbox selection codecs now enforce
positive finite CPU and positive integer memory/lifetime ceilings. Declaration
identity includes measured lockfile root and digest, preserving historical
identities when absent. Pack sources refuse every unresolved root; a missing
source under a resolved root remains allowed. Refusals retain `invalid_pack`
receipts. The nested-source control now uses real scoped directories.

Validation on Node 26.5.0 after frozen offline pnpm installation:

- Before production edits, `pnpm --filter @smthrs/registry exec vitest run
  test/Descriptor.test.ts test/Pack.test.ts --coverage.enabled=false --maxWorkers=2`:
  23 failed, 158 passed. After: 181 passed.
- `PATH="$HOME/.bun/bin:$PATH" pnpm --filter @smthrs/registry exec vitest run --maxWorkers=2`:
  42 files, 1,262 tests passed; statements, branches, functions and lines 100%.
- `pnpm --filter @smthrs/registry run check`: passed.
- ESLint for both changed source files: passed. Dprint for changed package files: passed.
- `pnpm exec tsc --noEmit` in apps/mvp: passed before and after.
- apps/mvp `src/device/schemas.test.ts` with focused coverage disabled: 6 passed
  against both original and fixed registry code. No stored schema changed.
  The initial focused run also passed all six cases but failed the app's global
  whole-suite coverage threshold; the full app suite was not run.
- `pnpm exec smithers-build test '//packages/smithers/agent/registry:importRules'`:
  unavailable (`unknown_label`; this package declares no such target). Ran the
  repository's `ImportRulesCheck.run` directly for host imports, root imports,
  Effect execution boundaries and fixed test waits: the same 34 existing
  violations before and after, zero added (identical reports).
- Codex Astra review: no findings.
- E2e: not run (mini clone).

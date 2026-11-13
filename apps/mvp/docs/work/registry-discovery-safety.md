---
title: Registry discovery safety
status: done
area: registry
owner: codex-mini-483815
updated: 2026-10-21
links:
  - packages/smithers/agent/registry
---

Reproduce and fix confinement resolution, bounded entry reads, retired-root cycles,
and invalid markdown budget/deadline admission. Use the library catalog's
`@smthrs/registry` and injected Effect `FileSystem` services; add no dependencies.

Completed all five fixes. Failed confinement resolution now refuses discovery;
entry reads stop at 4 MiB plus one byte; retired-root probes track directory
identity and minimum visited depth; malformed markdown budgets and deadlines
refuse descriptors with warning receipts. Metadata listing remains import-free.

Validation on Node 26.5.0:
- Before production edits, DiscoverySafety and MarkdownLimitsSafety: 21 failed,
  1 passed; all five reported failure modes reproduced.
- After fixes, the same regression files: 22 passed.
- `PATH="$HOME/.bun/bin:$PATH" pnpm --filter @smthrs/registry exec vitest run --maxWorkers=2`:
  42 files, 1,236 tests passed; statements, branches, functions and lines 100%.
- `pnpm --filter @smthrs/registry run check`: passed.
- ESLint for production sources: passed. Full package lint reaches an existing
  dprint failure in unchanged `test/ModuleFlow.test.ts` (line 116).
- Astra review: no correctness or security issues found.
- E2e: not run (mini clone).

Offline installation lacked cached @astrojs/check metadata; the authorized
online `pnpm install --frozen-lockfile` retry succeeded. No dependencies changed.

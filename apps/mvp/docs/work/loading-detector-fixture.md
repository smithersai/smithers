---
title: Use the shared error-checking test for the loading detector
status: complete
area: app
owner: Codex GPT-6.1 Sol
updated: 2026-11-04
links:
  - ../../e2e/loading-detector.spec.ts
  - ../../e2e/target.test.ts
---

Use the documented `strictTest` from `e2e/watch.ts`: this static-page spec intentionally paints loading markers, while retaining server, console and page error checks. Keep the existing library catalog entry `@smthrs/ui` for real Skeleton markup and CSS; no new library.

Validated in a pg cfbox with four CPUs, via nyc-01, from a tree containing only jj-tracked files:

- Before: the fixture assertion failed with only `loading-detector.spec.ts` as an offender (one failed, 68 filtered out).
- After: all 69 tests in `e2e/target.test.ts` passed, with no failures or skips.
- `pnpm exec vibelang -p tsconfig.json` passed, including this spec. The tested spec's SHA-256 matched the local file.

The land tool's current path rules require no review receipt for either changed path. Local commit only; no land or push.

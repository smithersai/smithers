---
title: CLI run activity, progress, and usage regressions
status: done
area: cli
owner: codex
updated: 2026-10-21
links: []
---

Fixed snapshot-only execution rows, native correction of failed telemetry, skipped nodes outside the display window, and concurrent model usage attribution. Existing CLI projections and Effect collections; no new libraries. Native snapshots retain provenance checks. Scheduled identities survive label eviction. Unmatched usage stays in ledger totals, with token and dollar residuals reconciled independently.

Eight regression cases failed against the original code: missing snapshot rows, incorrect native corrections, inflated running counts, swapped scoped usage, and ambiguous legacy usage assigned to another execution. Astra review found two further timing cases (double-counted ambiguous labelled usage and lost unmatched dollars); both failed before correction and remain as regressions. Final Astra review: no findings. Fable is unavailable in the configured tools and models.

Validation in this clone with Node 26.5.0:

- `pnpm install --frozen-lockfile --offline`: passed.
- From `packages/smithers`, `pnpm exec vitest run --coverage.enabled=false test/RunActivity.test.ts test/RunProgress.test.ts test/RunTiming.test.ts test/RunTimingCommand.test.ts test/RunTimingStore.test.ts`: 104 passed across five files. This is the affected suite, without whole-package coverage measurement.
- `pnpm exec tsc -p tsconfig.test.json --noEmit`: passed.
- ESLint on the three changed source files: passed. Dprint checks the changed sources and tests.
- `pnpm exec smithers-build test '//packages/smithers:importRules'`: unavailable (`unknown_label`; the package declares no such target). The repository's deterministic ImportRules checker compared the six changed TypeScript files against their originals for root imports and fixed waits: nine existing violations before and after, zero added.
- `NativeRunActivityCancellation.test.ts` and `RunObservabilityCli.test.ts`: both fail on original and changed code because the clone lacks the native `smithers-jj-export` helper; neither reaches the changed behavior.
- E2E: not run (mini clone).

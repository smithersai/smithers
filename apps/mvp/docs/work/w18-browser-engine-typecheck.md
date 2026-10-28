---
title: W18 browser engine test typecheck
status: done
area: platform-browser
owner: codex-w18-check
updated: 2026-10-28
links: [background-progress.md]
---

Library catalog: `@smthrs/platform-browser`, the durable browser engine host.

Latitude reproduced TS2322 in `BrowserEngine.test.ts`: the window helper
accepted arbitrary strings, but `BrowserEngine.Service.runs` correctly requires
Effect's `Duration.Input`. The helper now uses that type. Numeric and `"1 hour"`
inputs, pagination, ordering and window assertions are unchanged. No public
declaration changes. Three whitespace-only dprint reflows in
`BrowserLanguageServer.ts` and `BrowserRuntime.test.ts` clear existing lint
failures.

The W18 lander's `w18-jobs.py` SDK recipe ran only
`pnpm vitest run --coverage.reportOnFailure`. Its static recipe ran typecheck,
lint and import rules in `apps/mvp`; that app's typecheck does not include the
SDK's tests. `W18-GATES.json` records SDK test coverage without SDK check or
lint receipts. Touched SDK packages need their own `pnpm check` and `pnpm lint`
alongside the full suite at the package's coverage configuration.

Proof on Latitude `nyc-02`: old `pnpm check` exited 2 with TS2322; fixed
`pnpm check` and `pnpm lint` passed, and `pnpm vitest run` passed all 390 tests
in 32 files at the unchanged 100% statements, branches, functions and lines
thresholds (exit 0). The consuming `apps/mvp`'s `pnpm typecheck` passed all
four projects (exit 0). Astra and Fable reviews found no actionable issues.

---
title: Platform browser internal regressions
status: done
area: sdk
owner: codex-platform-browser-851768
updated: 2026-10-21
links:
  - packages/smithers/flows/platform-browser
---

Reproduce and fix the nine reported receipt, leadership, rollback and TypeScript workspace bugs in an isolated jj workspace. Run regression and package checks on Latitude. Library catalog entries: browser language intelligence and durable browser engine (`@smthrs/platform-browser`). No new libraries.

## Validation

Latitude runs, all sourced from the isolated workspace:

- Original code: `pnpm exec vitest run test/TypeScriptWorkspace.test.ts test/BrowserRuntime.test.ts test/SharedSqlite.test.ts --coverage.enabled=false`: 9 expected failures, 35 passes.
- Original code: `pnpm exec vitest run test/SqlConnection.test.ts --coverage.enabled=false`: rollback regression failed, 6 passes.
- Original code: `pnpm exec vitest run test/Prepare.test.ts --coverage.enabled=false`: preparation cancellation regression failed, 6 passes.
- Fixed code: `pnpm exec vitest run`: 309 tests passed across 26 files, 100% statements, branches, functions and lines; the configured coverage gate passed unchanged.
- Fixed code: `pnpm run check`: passed.
- Full lint reports two pre-existing `consistent-type-imports` errors in unchanged `src/BrowserRuntime.ts:78` and `src/internal/Engine.ts:53`; both files match the workspace parent byte for byte. Changed-source lint and formatting are checked separately.

Commit receipts retain the existing persisted schema and no longer expire. A delayed tab has no upper bound on suspension time; deleting its receipt cannot safely distinguish rollback from commit. Rollback refusal poisons only that connection and releases waiters with errors, without lending the open transaction. No new library was introduced.

Astra review found two introduced edge cases: nested manifest loading could exceed the file cap, and interruption after caching a script could leave its imports undiscovered. Each received an independently failing Latitude regression. Storing each admitted batch before import discovery and traversing cached imports per request fixed both; Astra re-review reported no remaining findings.

Fable final review identified an additional edit case: resolution did not see a newly created overlay directory. Its regression failed on Latitude, then directory checks were extended to include live overlays; closing an overlay removes its directory contribution. The final suite passed 309 tests at 100% coverage.

Fable also flagged two unchanged, unverified follow-up concerns outside the nine requested fixes: cancellation while loading a referenced TypeScript lib can leave its dependency chain incomplete, and transactions opened by failed SQL or `COMMIT; BEGIN` batches may lack the right commit receipt. These paths are present in the original revision; no fix is claimed for them here.

Final combined Latitude command: `pnpm exec vitest run; pnpm run check; pnpm exec eslint src/internal/Leader.ts src/internal/SqlConnection.ts src/internal/TypeScriptWorkspace.ts --max-warnings=0` under `sh -ec`: exit 0. Scoped formatting check also passed.

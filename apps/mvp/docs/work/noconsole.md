---
title: Restore console guard and CLI fixture cleanup
status: blocked
area: testing
owner: codex-noconsole
updated: 2026-10-25
links: []
---
Pin the sandbox teaching examples without relaxing executable-console detection. Ensure quickstart CLI workspace cleanup survives setup and cancellation failures. Library catalog: @smthrs/observability (logs, metrics and traces); test filesystem operations stay at the Node test boundary.

`df649523` added the three explicit failure-output branches inside a sandbox teaching template. Those calls return cell results to the model, rather than emit host diagnostics. The guard now pins all six exact lines and still scans executable code in that file, including template interpolations.

The reported stale paths identify `UnifiedCli.test.ts` (`smthrs-unified-cli-*`) and `QuickstartGuides.test.ts` (`smithers-guide-cli-*`), beneath an inherited temporary parent. UnifiedCli already registers immediate afterEach cleanup. Quickstart previously allocated before its try block and removed its root only after cancel-all succeeded. Its outer temporary-directory scope now removes the root after setup or teardown failures. Regression cases write a real WORKSPACE.ts and assert its directory disappears after success and both failure paths.

Latitude observability: 19 files, 218 tests; 100% statements, branches, functions and lines at the existing coverage config. Full CLI ran at its existing coverage config: 309 files; 5,560 passed, eight failed, one expected failure and 38 skipped. Quickstart (three), UnifiedCli (eleven) and the cleanup regression (three) passed. The eight failures are in unchanged SeatResolution, HostEvaluator, NativeControlPlan, HistoryVerify, SkillsInstall and SkillsPaths tests. Vitest did not publish aggregate CLI coverage on failure; no green CLI coverage gate is claimed.

Final Latitude focused checks passed: the old three-line teaching expectation fails specifically on six lines; late cleanup fails exactly the setup/teardown regression cases; the fixed guard passes eight cases and the fixed cleanup helper passes three with 100% statements, branches, functions and lines. Explicit stdin dprint checks passed for every changed TypeScript file. `//apps/mvp:importRules` ran successfully (not cached). The only remaining gate is the unrelated full CLI failures above; no check or threshold was weakened.

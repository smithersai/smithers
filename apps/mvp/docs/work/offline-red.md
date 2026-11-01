---
title: Fix offline branch routing regression
status: done
area: navigation
owner: Codex GPT-6.1 Sol offline-red
updated: 2026-10-31
links: []
---

Reproduce the four offline branch failures introduced by d4e58f4e. Read the shown location from the navigating router, preserve branch file navigation without retracking, and validate against real Postgres/Electric on the mini.

Library catalog: existing TanStack Router for route state and @smthrs/effect-tanstack-db for branch state; no new dependency.

Cause confirmed: a direct visit captures `TypeError: Cannot read properties of undefined (reading '__store')` in its route match. `shownPath` read the exported singleton, which Node had never initialized with history. All four original failures happen before branch.open; the previous `ready` row belongs to another repository and cannot match its `kept` fast path.

Implementation: createAppRouter binds each instance into its route context. Repository reuse and branch workspace cleanup both read it. The offline harness now uses the production constructor; the terminal harness preserves instance context when updating its services. Original expectations stay unchanged. Decision 0139 records the ownership contract.

Evidence so far: baseline offline 0/4; direct-visit regression fails on the old code with the route TypeError; fixed offline original4 plus direct regression5/5, branch36/36 and paths23/23 (64/64 total). Broader selected suites and static checks run on the mini. Astra review: no findings.


Final validation on the mini: all six offline cases pass (the original four plus direct-visit and per-router tree/blob navigation regressions); paths23/23; branch36/36 in the focused64/64 run. The broader branch/repo/screens selection ran415 cases:413 passed, one SQL TRUNCATE setup hook timed out, and the new regression initially asserted on the home query wrapper. The corrected regression passes; the full repo file and terminal navigation passed45/45 in a serial follow-up, including the persisted-device test in4.1s. No original assertion or timeout changed.

V8 coverage:9/9 changed executable router lines covered (100%). The focused router report also includes unchanged callbacks; its full-file100% thresholds fail with57.94% line coverage. Thresholds and production coverage configuration remain unchanged. The app typecheck and configured source ESLint pass; test files are excluded by the existing ESLint configuration. Astra review found no defects.

After rebasing onto incoming main8188457648f9 (which changed branch screens, the offline renderer and shared boot code), the critical mini run passed68/68: offline6, branch36, paths23, terminal navigation3. The app VibeLang typecheck and configured source ESLint passed again. Decision renumbered0139 to retain incoming0137/0138.

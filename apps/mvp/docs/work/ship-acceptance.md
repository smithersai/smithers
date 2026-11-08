---
title: Ship acceptance requires executed end-to-end success
status: done
area: e2e
owner: codex-ship-gate
updated: 2026-11-04
links:
  - ../infrastructure.md#against-a-deployment
  - ../rulings.md
---

Implement the ship gate requested by Will on 2026-11-04. One SCOPE-6/SCOPE-7 manifest maps required features to real specs and required browser targets. Acceptance rejects missing prerequisites, skips and missing execution receipts; ordinary developer runs retain declared skips. Setup must label an absent personal model skipped.

Use the existing Playwright and Vitest harnesses; no added library or product runtime. The library catalog's `@smthrs/testing` entry covers scripted flow tests, not the existing Playwright reporter boundary exercised here.

Validation, 2026-11-04: the mini passed all four `pnpm typecheck` projects and 107 tests after integration with the production sharing changes. `e2e/ship.ts` and `e2e/summary.ts` each reached 100% statements, branches, functions and lines. Real Playwright integration cases prove the unfiltered JSON inventory round trip on both projects, focused-test rejection through the app config, developer skips, failed mandatory needs, skipped zero-work personal-model setup, and filesystem/invalid-inventory failures. The temporary focused fixture is inert outside collection mode. Teammate and Guest session fixtures are checked before launch.

One acceptance invocation targeting the production URL exited 2 with `E2E_PERSONAL_MODEL_KEY` named, before the account lock or any network work. No deployment. Private receipts are in the lane STATUS file, outside this repository.

This completes the acceptance gate, not production acceptance. The manifest still exposes deployment-unavailable journeys in mixed specs (`scriptedAgent`, `devPeople`, `devSignIn`, `faults`, `localServer`, `noGitHubApp`); these must gain deployment evidence or move to separate developer specs with the live proof mapped in the manifest. The secrets receipt maps the new production-capable `secrets-egress.spec.ts`; its explicit selection flag and scratch branch are prerequisites and do not enable server egress. SCOPE-6/3b maps real production agent behavior checks; the separate judged-baseline `pnpm eval` suite is not executed by this e2e gate.

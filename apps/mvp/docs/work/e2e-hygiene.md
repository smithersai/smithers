---
title: Truthful e2e target requirements
status: blocked
area: testing
owner: Codex e2e-hygiene
updated: 2026-10-25
links: []
---

Separate synced scratch repository journeys from second-repository issue creation. Require a writable stack for keyboard TODO editing. Record VibeLang home role failures on other deployments, and require successful real replies in the live timeline journey. Deployment-only specs document their real infrastructure requirements and how a credentialed local stack can run them.

Library catalog: `@smthrs/platform-browser`, the existing browser durable-engine host exercised by the real Playwright harness. No SDK or runtime dependency changes.

`githubScratch` permits a real issue write; `secondRepository` requires that scratch to differ from `E2E_SYNCED_REPOSITORY`. `syncedScratch` requires them to match for issue numbering across devices, triage, lifecycle and Make TODO. Those projected journeys need a dedicated scratch deployment while sync remains limited to the default repository; pointing them at an unsynced second repository cannot prove them. `writableStack` selects the keyboard journey's stack independently.

`vibelangRoles` marks deployments of another repository as expected failures, with unchanged audience assertions. A deployment naming VibeLang runs those assertions normally. The live timeline requires a completed answer containing the requested word and visible question-specific reply text; a failed reply fails the test. The personal-model removal chapter claims only removal, not an unasked fallback answer.

Validation: Playwright discovery lists 336 tests in 66 files; the target contract suite passes 45/45 on Latitude. Final app typecheck and `//apps/mvp:importRules` pass on Latitude. The changed local browser run is blocked before Playwright: the mini dev server cannot compile `packages/errors/src/SmithersError.vibe:15:36`; the setup was cancelled after capturing the diagnostic. No browser pass or GIF is claimed. The full suite was cancelled after the existing two-device durable-pin integration test failed; no complete-suite or 100% coverage receipt is claimed; discovery is not an end-to-end pass.

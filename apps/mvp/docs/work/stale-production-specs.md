---
title: Correct stale clone and navigation production specs
status: blocked
area: e2e
owner: Codex GPT-6.1 Sol (stale-specs)
updated: 2026-11-04
links:
  - ../../e2e/repo-clone.spec.ts
  - ../../e2e/navigate.spec.ts
---

Both clone paths declare the gated composer's personal model and the test account's own conversation. The agent path also declares a live model for local runs. Hover navigation starts at the actual click, checks the destination main's skeletons and spinners plus the global page bar, and requires painted content throughout. Repository recordings scope loading indicators to Repository. Frame attachments retain structural element diagnostics without message text or HTML.

Validation: all four ES2022 `pnpm typecheck` projects and all three `e2e/loading.test.ts` real Chromium tests pass through the remote compute runner. Astra and Fable reviewed the changes; transparent-content and region-scope gaps found in review have regressions or explicit route scopes.

Production proof is blocked. The first admitted attempt failed sign-in setup because the runner lacked its isolated test-account session. The session was then provisioned privately, but the retry could not pass an abandoned shared browser reservation: its owner process had ended and no slot held that reservation. The lane preserved that other run's lock and stopped only its own waiting client. No production feature case executed. The reservation needs its owner's recovery; model-dependent proof also needs Will's authorized `E2E_PERSONAL_MODEL_KEY`. Private lane status retains the exact blockers and receipts.

The audit's watch request was a real transport failure recovered by the same durable step on its next attempt, separate from the composer timeout. Private lane receipts retain its correlation and timing. A broad initial unit filter also selected two failing assertions in the untouched RunPage loading suite; those red receipts remain visible, and the final recorder run selects its exact path.

Library catalog: existing Playwright e2e harness; no new runtime, library or product feature.

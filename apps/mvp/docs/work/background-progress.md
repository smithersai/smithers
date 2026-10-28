---
title: Background progress as a projection of receipts
status: done
area: attention
owner: claude-opus-progress
updated: 2026-10-28
links: [docs/decisions/0124-background-progress.md, docs/features/notifications.md]
---

Library catalog: durable workflow (`@smthrs/flow`, `@smthrs/platform-browser`), outbox and device store (`@smthrs/effect-tanstack-db`), sync (`@smthrs/effect-electric`), toast stack (`@smthrs/ui`). Replaces the earlier progress-notice patch series: `/new`, Make TODO, Create issue and Commit show one toast from the press to the real result, projected from receipts the operations already write (decision 0124).

The server folds Create issue's and Commit's results into the person's notification in the same transaction. The device bridges with `progressOf`: this tab's staged inputs, the engine's runs (`BrowserEngine.runs`, new), recovery rows the route answered, the person's writes as the server has them, and a commit's synced TODO.

Codex Astra reviewed 15 rounds; round 15 found nothing actionable. Production proof is the lander's: `playwright.progress.config.ts` runs `background-progress`, `issue-progress` and `todo-progress` in Chromium and WebKit. The Mac mini's dev server failed the device fixture for an untouched spec (`flow-usage.spec.ts`) too, so no local e2e receipt exists.

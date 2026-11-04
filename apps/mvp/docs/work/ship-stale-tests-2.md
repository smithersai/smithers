---
title: Ship audit stale tests and Conversation landmarks
status: in-progress
area: e2e
owner: Codex GPT-6.1 Sol stale-tests-2
updated: 2026-11-04
links: [../features/issues.md, ../features/notifications.md, ../features/pulls.md, ../features/branch-workspace.md]
---

Fix five audited failures: queued issue completion, private spectator toast label, dev and built engine cache receipts with offline reopen, one Conversation landmark, and authoritative pull-list readiness. Use existing library catalog entries `@smthrs/ui`, `@smthrs/effect-tanstack-db`, and `@smthrs/effect-electric`; no new dependencies or runtime.

Remote validation and pushed revisions are recorded as each piece lands. No deployment is performed by this lane.

Baseline four-project `pnpm typecheck` passed on mini slot 3. The changed-source typecheck and toast run exhausted the mini’s four-slot admission window; fallback validation runs through nyc-01 `run-heavy`. Storage and landmark e2e remain queued on the mini. The production issue run owns the shared test-account lock only after earlier runs released it, and is waiting for the remote browser slot. No deployment is performed by this lane; only the selected e2e writes its test-account fixtures.

The first landed piece exposes only safe pull-list readiness attributes: issue/pull access, installation, query readiness, completed repository sync, and the rendered list readiness flag. No title, query, repository or person content is recorded. The four-project typecheck and the existing pull-view and real Postgres attention suites pass (39 tests); browser receipts remain pending in the private lane status.

Conversation landmarks: four focused real local e2e cases passed, home and branch on both Chromium and WebKit. The transcript is the sole named region; the shared device locator is strict. The branch interaction suites keep their isolation/layout assertions and add the uniqueness guard. This receipt certifies the landmark regression, not Code Storage or live-model branch operations.

Pull search: the production case passed after waiting for the unmatched search’s real sync-completion receipt. Completion arrives, so no product transition rewrite is needed. Safe access/query/sync attributes landed first; the assertion now waits for URL + zero matched rows + completed sync before the unchanged empty-state assertion. Four-project typecheck and 21 pull-view tests pass; the three real TCP relay tests also pass.

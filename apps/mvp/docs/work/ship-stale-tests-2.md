---
title: Ship audit stale tests and Conversation landmarks
status: done
area: e2e
owner: Codex GPT-6.1 Sol stale-tests-2
updated: 2026-11-04
links: [../features/issues.md, ../features/notifications.md, ../features/pulls.md, ../features/branch-workspace.md, ../features/flows.md]
---

Fix five audited failures: queued issue completion, private spectator toast label, built PWA engine cache receipts with offline reopen, one Conversation landmark, and authoritative pull-list readiness. Library catalog entries: `@smthrs/ui`, `@smthrs/effect-tanstack-db`, and `@smthrs/effect-electric`; no new dependency or runtime.

Issue creation: production two-device journey passes admitted offline request, real numbered completion, list identity and published comments.

Notifications: complete Chromium and WebKit journeys pass spectator privacy, delivery, answer, hide/read and dismissal. A completed answer removed the focused input, so Escape never reached the panel. The shared UI now handles unconsumed Escape at document bubble phase and removes its listeners on unmount. Both new regressions fail on the old component; all 32 panel tests and the UI check pass.

Conversation landmarks: four real local e2e cases pass, home and branch on Chromium and WebKit. The transcript is the sole named region. The shared device locator and branch interaction guards enforce uniqueness. This certifies the landmark regression, not Code Storage or live-model branch operations.

Pull search: production case passes after waiting for the unmatched search's real sync-completion receipt. Completion arrives; no transition rewrite is needed. Safe access/query/sync attributes contain no user content. Four-project typecheck and 21 pull-view tests pass; the real Postgres attention + pull-view run passes all 39 cases.

Offline engine: the real built PWA validates the strict hashed precache binary, proves network loss and restores its persistent draft offline on both browsers. The production reopen also exposed a forbidden busy/skeleton pending frame. The navigation frame now has neither; its rendered regression passes. Final four-project typecheck, seven pending-frame/real-relay tests and both built-PWA browser offline journeys pass. The old production build still needs the lead's deployment before its shared no-loading observer can pass.

All heavy work runs remotely. Private lane STATUS records pushed revisions and receipts. No deployment by this lane. Astra review has no findings. Fable review was attempted twice but timed out or had no available account; no Fable pass claimed.

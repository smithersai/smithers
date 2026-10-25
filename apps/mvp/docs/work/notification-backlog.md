---
title: Keep notification backlog in the bell
status: blocked
area: notifications
owner: notices
updated: 2026-10-25
links:
  - ../features/spend-alerts.md
---

Remove backlog overflow from inline notices. Deliver model spend in the bell plus configured email and Telegram channels. Libraries: catalog entries Render UI (@smthrs/ui) and Send a person a short message (@smthrs/notifications); existing durable channel delivery remains the single sender.


Implementation is saved. Inline overflow is gone; spend alerts use the bell and existing durable email/Telegram delivery.

Latitude typecheck and import rules pass. The DOM backlog and spend regressions have both old-code failure receipts and a passing focused run. A real Postgres/Electric regression adds 283 older unread notices and a spend alert. Its fresh run and the full coverage rerun could not acquire a farm app-test permit and were stopped. The earlier full suite failed 12 cases and did not meet 100% coverage; it is not a green receipt for this change.

Both browser attempts stopped before Playwright: the local Worker bundle cannot parse `packages/errors/src/SmithersError.vibe`. The desktop/phone spec is ready for local and deployed runs, but there is no passing browser receipt or GIF. Resume validation after the test infrastructure is available; production proof follows deployment.

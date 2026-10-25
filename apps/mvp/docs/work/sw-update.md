---
title: Open tabs discover production releases
status: blocked
area: app
owner: Codex sw-update
updated: 2026-10-25
links: [pwa.md]
---

Check the registered service worker when the tab becomes visible, receives focus, or the router resolves navigation. Deduplicate concurrent checks; failures wait for another browser signal. Record `pwa.update.check` with trigger and checked, failed, busy or hidden outcome, without content. Keep the existing safe activation/reload gate. No periodic timer or retry loop: lifecycle signals cover returning to and moving within an open tab; the browser owns worker script fetching and its cache rules.


Validation: Latitude typecheck and importRules pass; `src/pwa.test.ts` passes 8 tests with 100% statements, branches, functions and lines on `src/pwa.ts`. The mini-run attempt cannot start Playwright: the unchanged `packages/errors/src/SmithersError.vibe:15:36` fails parsing its inline type import, so the local backend never answers its readiness check. The VibeLang migration is a separate workstream. The two-production-build service-worker test is committed but has no execution receipt yet.

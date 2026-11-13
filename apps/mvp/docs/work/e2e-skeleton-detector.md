---
title: Detect painted skeletons in no-loading assertions
status: done
area: app
owner: Codex proofskel
updated: 2026-11-04
links:
  - ../../e2e/fixtures.ts
  - ../../e2e/loading-detector.spec.ts
---

Count painted `data-slot="skeleton"` elements through the existing no-loading observer and markup report. Keep the UI's 300 ms opacity hold and existing exemptions; ignore hidden and zero-sized markers. The library catalog's loading entry is `@smthrs/ui` (`Skeleton`, `smithersUiCss`); the static-page regression uses its real markup and CSS.

Validated against main `ab147d6824cf` using cfbox's Playwright image via the authorized relay after mini capacity refusal. The compiled frontend ran locally over HTTPS/HTTP2 against the real hosted API, with service workers blocked; this did not validate an isolated backend or deploy anything.

- Static regression: 3 passed; the parent detector failed both skeleton cases. Frontend typecheck and build passed. ESLint ignored both changed e2e files because no matching configuration applies; its zero exit is not lint validation.
- Five deploy-smoke groups: Chromium and WebKit cold-path and runner registration passed. Both first-paint groups failed on the issue page's skeletons while shape responses were deliberately held. Chromium: 2 passed, 1 failed; WebKit: 1 passed, 2 failed, including a separate missing placed list-row assertion.
- Proof (a) passed with 4,411 issues across 45 pages; opening an issue from the list took 415 ms and reported no loading markers.
- Additional direct issue check: normal sync passed; held shapes failed with skeletons.

Product findings, with screenshots retained in the private validation report: `RepoPendingScreen` reported at 4.655 s in Chromium and 2.746 s in WebKit; IssueScreen's “Syncing issue…” skeletons at 5.155 s and 4.062 s respectively. Times are since navigation. The extra held-shape check reported the same screens at 4.618 s and 5.124 s. Assertions remain strict; product fixes are outside this change.

One commit, reviewed with Codex Astra. All staging trees were deleted with guarded paths. Do not land or push.

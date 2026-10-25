---
title: Visitor mobile responsiveness
status: blocked
area: frontend
owner: Codex builder mobile
updated: 2026-10-25
links: [./mobile-responsiveness-sweep.md, ./prod-mobile.md]
---

Repair the visitor home overflow, verify docs and branch layouts, and audit every
routed screen at 390, 768 and 1280 pixels for both identities. Use the catalog's
`@smthrs/ui` entry and existing shared screen layouts; no new feature or dependency.

The hero glow extended 24 pixels outside its column, leaving the 16-pixel page
padding 8 pixels short. Its decoration now stays in the column. Install commands
wrap without truncation, Copy uses the shared control-height token, and example
source keeps its own horizontal scrolling. The real renderer's browser regression
measured 398 pixels at 390 and 776 at 768 before the fix; all 16 layout checks pass
afterward, on both test hosts.

The full-size view uses the shared Button for Back to chat and keeps the empty
page's header from filling the content area. The mobile sweep now visits every
route shape for both identities at all three sizes, including unavailable states,
and adds a real persisted full-size page. Existing populated issue, pull, TODO,
flow, run, and queue journeys remain. A deployment also audits an actual recorded
repository run’s graph and journal; unavailable item pages must settle before
their controls are audited. The visitor branch waits for its public code
pane: tracking requires sign-in, so its private workspace navigation is not a
visitor readiness signal. Conversations has an explicit viewport assertion.

Latitude: app typecheck and import rules pass. The full app suite passes 4,469
tests, with 3 expected failures and 17 skips, at 100% statements, branches,
functions and lines. UI typecheck and all 2,645 UI tests pass. The 249-case
deployment plan compiles. The real-renderer regression failed before the CSS
fix and passed all 16 checks afterward on both hosts.

Review found that link cards have no full-screen renderer; the persisted-view
fixture now uses a webpage and waits for its container instead of its transient
preview. The source-scrolling regression now actually scrolls horizontally.
Raw and TODO unavailable screens wait for an empty state or sign-in. The corrected
16-case browser regression passes on the mini. Unavailable
view and draft routes render their existing empty shells; populated routes have
separate journeys.

Local E2E was attempted through the mini runner but failed before Playwright:
the existing dev bundle hit a VibeLang parse error and then TS5096. A rerun waited for the mini's shared browser slot and was cancelled. The production
sweep likewise waited for the active test-account run and was cancelled. A direct public docs-index request currently returns
503 unavailable; no successful docs journey is claimed. No dependency, stored
schema, or public API changed. Landing and deployment validation remain required.

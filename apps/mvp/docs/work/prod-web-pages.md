---
title: Prove external web pages against production
status: in-progress
area: web-pages
owner: Codex GPT-6.1 Sol (e2e-webpage)
updated: 2026-11-04
links: [../features/web-pages.md, ../../e2e/web-page.spec.ts]
---

Replace the production spec's local-server dependency with reachable public
HTTPS fixtures, verified before use. Keep the real local servers for local
runs. Prove embedding, cross-device sync, full screen, framing refusal and
new tabs through both the composer and the real agent.

Library catalog entry: outside web pages (`@smthrs/views`, `@smthrs/ui`).
The test uses `WebPage.framing` and `WebPage.preview` to inspect real fixture
responses; product behavior continues through the existing durable flows.

Validation: all four ES2022 typecheck projects, 37 focused real-service
web/URL/view tests, and all five local non-model journeys plus setup passed
on the mini. Production's original run exposed a Worker-only fixture403,
a WebKit popup-receipt bug, and an undeclared notifications503. Fixtures and
the popup adapter are corrected; production rerun pending the shared account
lock. Both real-agent journeys remain enabled and use the account's saved
personal model. No deployment from this lane.

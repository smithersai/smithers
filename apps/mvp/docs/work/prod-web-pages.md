---
title: Prove external web pages against production
status: blocked
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

Person and agent specs are separated because production model leases are
per spec. The shared fixture module preserves all seven journeys and the
full isolated setup; only the two real-agent journeys need model access.
The production runner rejects setup-bypass flags, which this split avoids.

All five person journeys pass against the deployment with its full isolated
setup; all five videos/GIFs pass checks. The extracted fixture module also
passes the complete local WebKit spec. Four-project typecheck and resource
discovery/declaration checks pass. The two real-agent journeys remain
enabled in their own spec and need a working personal-model connection.
The private lane status holds the operational receipts and current blocker.

---
title: Give external tabs a real browser receipt
status: in-progress
area: web-pages
owner: Codex GPT-6.1 Sol (e2e-webpage)
updated: 2026-11-04
links: [../features/web-pages.md, ../../src/main.tsx, ../../e2e/web-page.spec.ts]
---

Production WebKit opens `/web <url> tab` but retains user activation. The
browser adapter incorrectly reports refusal and dispatches an additional link
card. Chromium consumes activation, so its path passed.

Library catalog entry: outside web pages (`@smthrs/views`, `@smthrs/ui`).
The preexisting browser host adapter obtains a controlled blank tab, severs
its opener and follows a noreferrer link. This stays at the app's browser
boundary (apps are exempt from SDK-4); no new SDK API or feature is needed.
The existing plugin, injected WebHost, durable fallback and opening metrics
remain the only product path.

Validation: isolated real Chromium/WebKit probes verify the receipt, null
opener and absent HTTP referrer. All four app typecheck projects, 37 focused
real-service tests and the five local Chromium journeys pass on the mini.
The actual local WebKit suite is queued. Production's old adapter demonstrably
failed the retained direct-tab regression. Astra reviewed the final adapter
without correctness/security findings. Fable's popup navigation race in the
test is fixed by awaiting its destination URL. Lead deploys the pushed
revision; this lane does not deploy.

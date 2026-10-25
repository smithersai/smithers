---
title: Transcript message locators
status: done
area: test
owner: Codex e2e-locators
updated: 2026-10-25
links: [prod-e2e.md]
---

Scope message lookup to @smthrs/ui ChatTranscript bubbles, excluding repeated Timeline text. Share question and answer pairing across specs and device helpers. No product behavior changes.

Validation: Latitude apps/mvp typecheck passed; target.test.ts passed 43 tests. Mini Playwright discovery listed 339 tests in 67 files; the real-component locator browser regression passed, including hidden Timeline copies and an answer quoting the question. A private transform cache avoided a shared-cache JSON error on the mini.

Local chat “ask” was attempted through mini-run, but the dev server failed before Playwright: TS5096 diagnostics and no ready auth session endpoint. No chat end-to-end pass is claimed. No product or SDK changes.

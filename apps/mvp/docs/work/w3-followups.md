---
title: Production visitor, contributor and summary follow-ups
status: blocked
area: browser
owner: w3-followups
updated: 2026-10-25
links: []
---

Three independent fixes with regression tests. Uses the library catalog entries for durable flows (`@smthrs/flow`), durable model calls (`@smthrs/agent`) and device state (`@smthrs/effect-tanstack-db`).

Credential roots now preserve signed-out state for person doors and their children. The Contribute spec follows decision 0079: no prompt on another repository, independent of BYOK. Taken summaries complete successfully and log at Debug; old failure decoding remains supported.

Latitude: typecheck and importRules pass; 46 focused tests pass with 100% statements, branches, functions and lines on credentials.ts, timeline/flow.ts and timeline/steps.ts. The credential-child and taken-summary regressions both fail against the prior implementations.

Browser proof remains blocked: the mini runner queued behind occupied shared slots and was cancelled before executing either spec. The exact file-page credential caller has not been confirmed in a browser; no end-to-end or GIF claim. No production requests were made.

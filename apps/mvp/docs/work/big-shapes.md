---
title: Reduce cold repository shape payloads
status: done
area: mvp
owner: big-shapes
updated: 2026-10-26
links: [../decisions/0116-shape-payloads.md]
---

Measure signed-out production shape bytes and rows, split list summaries from detail text, and gate detail demand. Preserve server authorization and persisted local-first reads. Catalog: @smthrs/effect-electric, @smthrs/effect-tanstack-db. Validation runs on Latitude; no deployment.

Production: signed-out smithers issues/pulls each opened 8,238,476 bytes of items and 8,969,563 bytes of comments. Homes and the observed vibelang lists opened neither. The real Electric fixture now opens 3,845 summary rows in 1,856,745 bytes, with zero body fields or comment requests. Full text remains persisted and opens on detail demand, including TODO drafts.

Latitude: typecheck, importRules and lint passed; 880 focused tests passed with every changed production file at 100% in all four coverage dimensions. The full suite ran once: 5,366 passed, two failures (the old auth demand expectation and missing route telemetry word), three expected failures and 23 skipped. Both failures and its sole uncovered branch were repaired and passed the final focused gate. Deployment E2E is declared in `e2e/shape-payload.spec.ts`; not run, since the mini is unavailable and deployment is excluded.

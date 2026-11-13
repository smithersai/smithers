---
title: Conversation view initialization and navigation ordering
status: done
area: views
owner: codex
updated: 2026-10-21
links: []
---

Reproduce concurrent first opens and stale navigation with real collections. Use the catalog's
`@smthrs/effect-tanstack-db` and `@smthrs/effect-electric` entries. Retain their collection telemetry.

All three findings reproduced on the base. Frequent scheduler yields exposed duplicate collections;
a Deferred-gated ViewsStore exposed stale navigation; the TypeScript JSDoc binding check exposed the misplaced comment.
First-open creation now uses an Effect semaphore through query publication. Navigation writes the selection
before initialization, preserving invocation order. The helper comment belongs to `open`.

Latitude A/B: `pnpm test src/features/views --coverage.enabled=false`: base 7/7; changed 10/10.
Regression-only base: 3/3 failed for the reported reasons. E2E: not run (mini offline).
Collection and mutation observability remains provided by the catalog wrappers; no new action or library.

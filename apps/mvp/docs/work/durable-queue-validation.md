---
title: Durable queue validation and diagnostics
status: done
area: flow
owner: codex-fix-packages-smithers-flows-flow-src-486957
updated: 2026-10-21
links: []
---

Reproduce and fix queue offer diagnostic disclosure, zero trace parents, and synchronous concurrency validation. Uses the library catalog's `@smthrs/flow` durable workflow entry.

All three findings reproduced on Latitude before their fixes. The flow suite
passed 912 tests with 100% aggregate coverage. DurableQueueCrash integration
passed all three cases with file-scoped coverage disabled (the initial file-only
run passed assertions but could not meet the engine-store whole-suite coverage gate).

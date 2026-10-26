---
title: Electric behind Workers Cache with live collapse
status: blocked
area: infra
owner: electric-s5c
updated: 2026-10-26
links: [../decisions/0115-electric-workers-cache.md, ../infrastructure.md, ../observability.md]
---

Implementation complete: private versioned Workers Cache, ten-second live hold, authoritative Electric TTL,
credential stripping, browser no-store, and no trial diagnostics.
Library catalog: @smthrs/effect-electric ShapeProxy; existing Alchemy host. No SDK changes.

Latitude: typecheck, importRules and lint passed. Focused cache/upstream logic reached 100% statements,
branches, functions and lines. Real workerd checks passed scoped snapshots, stale-handle recovery,
concurrent writes with 30% aborts, and two empty rounds. Production Worker bundles and settings checked.
Full app suite ran once: 403 files passed, 7 skipped; 5,388 tests passed, 3 expected failures, 23 skipped;
aggregate coverage 100% on all four metrics. Gateway host wiring is bundle-tested, not unit-instrumented.

Astra review found no concrete issues. Fable review could not launch: every configured account was cooling.
Remaining: lead's Fable review, then lander's deployment and edge load/collapse proof. No deployment or mini run.
The S5b numbers are historical evidence; initial freshness, production restart recovery and two-person
production isolation are not claimed solved here.

## Earlier credential-only landing


S5 production trials failed the mixed 70-device load bar. Finite Workers Cache hits work; live collapse and launch capacity remain unproven. A settled half-vCPU trial reduced failures to 25/2,789 but still missed freshness for 44 device/route pairs. Production was restored to main; no cache or instance-size activation is retained.

The independent credential-boundary fix strips legacy secrets and credential headers before the private binding. Focused tests cover the private and ordinary upstream behavior.

Remaining: diagnose same-key live cache misses, pass mixed load and write propagation, then two-person isolation, deliberate restart recovery and 30% live cancellation. The saved production sessions belong to one person; a second real test account is required for isolation.

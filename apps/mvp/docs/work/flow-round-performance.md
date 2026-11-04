---
title: Bound flow handoff cost
status: done
area: flows
owner: codex-roundperf
updated: 2026-11-03
links: []
---

Measure main and rc.16 with 50, 200 and 800 offline rounds on the remote test farm. Preserve the active file-tree run. Use the library catalog's durable flow and Node runtime entries (`@smthrs/flow`, `@smthrs/platform-node`), and retain a deterministic work-count regression if main needs a fix. Review the private change; do not land or push.

Both versions accumulate duplicate capability ceiling groups at each handoff: 148, 598 and 2,398 groups after 50, 200 and 800 rounds. The late-round profile identifies `BoundedJson.visit` beneath run-state validation/redaction; SQL row counts stay essentially constant while the returned state grows. Normalizing the persisted successor and in-process follower with `CapabilitySet.fromGroups` keeps the intersection at one group for this workload, preserving distinct restrictions and deny-all. Journal decisions and spans now expose group counts without patterns or payloads.

The deterministic regressions failed before the fix: stored group counts were `[1, 31, 118]`, and the follower read the repeated pattern 39 times rather than once at round 40. The fixed targeted engine and durable/recovery suites pass 90 tests; both test projects typecheck, and changed production modules pass ESLint. Full-suite coverage was not measured. The manual SQLite benchmark retains each round's timing and work counters; final report and review receipt belong to the requesting session. This change is intentionally unlanded and unpushed.

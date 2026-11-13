---
title: Relay serializes cfbox streams beyond the land-gate bound
status: todo
area: tooling
owner: Will (issue filing)
updated: 2026-11-05
links:
  - land-affected-suites.md
  - ../../../../docs/devx/parallel-agents.md
---

The relay reports Node 26.5.0 / Undici 8.7.0 serializing cfbox streams. Seven
requested pg jobs run one at a time. Two cold-issue shards measured 429.1 s and
382.6 s; the first file-tree shard measured 392.0 s. At roughly 400 s per job,
seven jobs take about 2,800 s (46m 40s), before parent comparisons. This relay
limit is separate from pg's eight-box cap and admission wait.

The docs-only gate passed in 17.1 s and the index-only gate in 348.1 s. The
cold-issue app comparison ended INCOMPLETE at pg admission in 998.7 s; the
file-tree comparison did so in 2,514.2 s, including a measured 971.6 s admission
wait. These are observed campaign timings, not throughput guarantees. Private
operations evidence stays outside this repository.

Will will file the issue. The requested follow-up is concurrent relay streaming
and a fresh bounded app head/parent campaign. Once complete proof fits the
thirty-minute whole-gate wall bound, revisit and tighten the temporary decision:
a proven failure blocks, INCOMPLETE proceeds and is audited with its stage.

Catalog entry: repository chores in `.smithers/flows`; this extends the existing
source-only bootstrap helper and adds no library or runtime.


After applying that policy, one real `ea01367a` gate reached `browser-setup`
and returned INCOMPLETE-and-proceed in 719.415 s including receipt checking
(703.141 s in the gate). The missing lockfile-matched Playwright executable is
separate from the serialized-stream limit. Complete app proof remains absent;
remote termination needs confirmation before its retained admission is released.

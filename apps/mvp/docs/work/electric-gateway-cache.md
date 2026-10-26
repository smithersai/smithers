---
title: Collapse duplicate Electric shape requests
status: blocked
area: infra
owner: electric-s5
updated: 2026-10-26
links: [../decisions/0114-electric-cache-trial.md, ../infrastructure.md]
---

S5 production trials failed the mixed 70-device load bar. Finite Workers Cache hits work; live collapse and launch capacity remain unproven. A settled half-vCPU trial reduced failures to 25/2,789 but still missed freshness for 44 device/route pairs. Production was restored to main; no cache or instance-size activation is retained.

The independent credential-boundary fix strips legacy secrets and credential headers before the private binding. Focused tests cover the private and ordinary upstream behavior.

Remaining: diagnose same-key live cache misses, pass mixed load and write propagation, then two-person isolation, deliberate restart recovery and 30% live cancellation. The saved production sessions belong to one person; a second real test account is required for isolation.

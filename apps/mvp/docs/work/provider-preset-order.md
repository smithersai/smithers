---
title: Provider presets follow saved connection order
status: done
area: models
owner: Codex
updated: 2026-11-12
links: [https://github.com/smithersai/smithers/issues/5280, ../features/personal-model.md, ../decisions/0132-model-connections.md]
---

For each tier, keep named models first, then use the first active connection with a matching preset.
Cover all tiers, both provider orders, ineligible connections, arbitrary saved lists and the sealed-key lookup.
Reuse the existing `presetOn` helper and the catalogued `@smthrs/model-host`/`@smthrs/rpc` lookup path.

Validation: 27 focused contract and real Postgres/sealed-key tests pass; eight fail against the original resolver.
Scoped typecheck and lint pass. Broader app typecheck/lint diagnostics match the unmodified base; the broader personal
model suite also encounters an existing `@smthrs/agent/AgentAction` import failure. Validation details are recorded in
[#5280](https://github.com/smithersai/smithers/issues/5280).

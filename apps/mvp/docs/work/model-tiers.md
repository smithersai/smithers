---
title: Model tiers for people's own keys (fast, implement, hard)
status: blocked
area: model
owner: claude-model-tiers
updated: 2026-10-25
links: [docs/decisions/0107-model-tiers.md, docs/features/personal-model.md, docs/features/model-endpoint.md]
---
A person saves up to one key per protocol and a model per tier; each role maps to a tier (decision 0107). Landed for
the lander: migration 0063, `worker/ModelTiers.ts`, roles `review` and `plan`, Settings' tier form, docs.
Library catalog: `@smthrs/model` (ModelProxy endpoint, Classifier for Jev) and `@smthrs/flow` (`model/Put`).

Proven on Latitude: typecheck, importRules, and the focused suites with every changed file at 100% coverage. Blocked
on the real end-to-end proof: `e2e/personal-model.spec.ts` (extended for tiers) needs `E2E_PERSONAL_MODEL_KEY`, which
no agent environment has. `src/device/schemas.test.ts` stays red until the lander records `personal-model` v2 in
`schemas.lock.json` (`UPDATE_DEVICE_SCHEMAS=1`).

Not done now (decision 0107): escalating a `todo` run from `implement` to `hard`, a dedicated Jev tier, more than one
key per protocol.

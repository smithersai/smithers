---
title: Engine store documentation contracts
status: done
area: sdk
owner: codex
updated: 2026-11-13
links:
  - https://github.com/smithersai/smithers/issues/4756
---

Align the engine-store documentation with its shipped implementation:
restore fencing's lifecycle-journal exception, PostgreSQL serialization and
runtime backing, durable-state results, scheduler refusals, and journal record
names. Keep recovery behavior and public APIs unchanged.

Extend the existing documentation contracts in
`packages/smithers/flows/engine-store/test/Docs.test.ts` and regenerate the
published API reference and LLM documentation.

Validation:

- The exact `Docs.test.ts` regression suite fails eight checks against the
  parent documentation and passes all 16 with the corrected pages.
- Engine-store `pnpm run check` and `pnpm run lint` pass.
- `pnpm docs:sync` and `pnpm docs:check` complete; all 52 published
  package tarballs pass their documentation checks.
- Generated API and LLM projections pass their drift checks.
- The full package suite was attempted. Its documentation assertion was
  corrected and rerun. The remaining global-suffix fixture in
  `test/DisasterRecovery.test.ts` also fails on unchanged parent
  `028b4815`: migration `4003_plan_forward_only_identity` is refused below
  already applied `4004`. That separate migration issue is unchanged.

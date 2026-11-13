---
title: Agent quota and host-port boundary regressions
status: done
area: sdk/agent
owner: codex-mini-fix-073840
updated: 2026-10-21
links:
  - packages/smithers/agent/src/QuotaPolicy.ts
  - packages/smithers/agent/src/SmithersPlugin.ts
---

Reproduce and fix the four supplied findings: NaN default wait, NaN maximum wait,
stateful list-port receivers, and arbitrary host error disclosure.

Use the library catalog entries for `@smthrs/agent` and `@smthrs/harness`;
the existing quota classifier and FlowBinding boundary own these behaviors.

Decisions: reject an unreachable deadline or an unordered ceiling comparison;
do not replace invalid settings with a guessed policy. Preserve the injected
port receiver. Discard arbitrary exception details at the host boundary and
use FlowBinding's existing opaque failure, retaining its failure observation.

Validation:
- Node 26.5.0; frozen offline installation succeeded.
- Before the fix: `pnpm --filter @smthrs/agent exec vitest run
  test/QuotaPolicy.test.ts test/SmithersPlugin.test.ts --coverage.enabled=false
  --maxWorkers=2`: 8 expected failures and 44 passes. Both NaN cases accepted
  parks, the stateful list call failed, and all five exception cases exposed
  the synthetic credential text.
- After the fix, the same command: 52 passes in 2 files. The exception matrix
  exercises list, run, and inspect, including their failure observations.
- ESLint on the two changed source files passed. The package's importRules
  target is absent (`unknown_label`); its requested command was attempted.
  The repository ImportRules checker passed the platform-neutral and Effect
  boundary rules on the changed sources and the no-fixed-sleeps rule on the
  changed tests (3 rules, 306 source files scanned).
- The full baseline suite was interrupted after repeated missing Postgres
  schema errors and stalled tests in unchanged ModelStep.test.ts. A broader
  post-change run excludes that file; its result is recorded below.
- Coverage was not measured. E2E: not run (mini clone).

Broader result: `pnpm --filter @smthrs/agent exec vitest run
--coverage.enabled=false --maxWorkers=4 --exclude test/ModelStep.test.ts`
reported 2,069 passes, 6 skips, and one assertion failure in Fault.sweep.test.ts.
The RunawayGuard.test.ts worker remained stalled after more than six minutes;
it was explicitly terminated, producing a worker error. This is not a green
full-suite receipt. The fault sweep reports the unregistered
`@smthrs/flow/EffectKeyUnavailable` in unchanged `flows/flow/src/Action/once.ts`.
Running Fault.sweep.test.ts with both changed source files restored to the
parent revision reproduces exactly the same failure (9 passes, 1 failure).
The fixed source was restored byte-for-byte afterward.

Formatting passed for all changed package files. All four supplied findings
are reproduced and fixed; the broader suite and missing importRules target
limitations above remain outside these fixes.

---
title: In-memory forced cancellation settles executions
status: done
area: flow engine
owner: codex
updated: 2026-11-13
links:
  - https://github.com/smithersai/smithers/issues/4696
---

The in-memory engine's `interruptUnsafe` must end active and parked executions.
`poll` returns a `Complete` carrying the interruption cause, including any
cleanup failure, and completion wakes each waiting parent. A later `resume`
does not execute cancelled work again. Cancellation also settles a parked run
whose handler registration has closed, while an ordinary wake still waits for
a registration.

The change uses the existing `@smthrs/flow` engine and Effect fibers; it adds no
runtime, host dependency or public API. Regression coverage exercises immediate
cancellation, active and parked children, multiple parents, grandparents,
cleanup defects, repeated cancellation and completed or unknown executions.

Validation completed with Node `26.5.0` and pnpm `11.25.0`:

- The regression file against the original engine: `6` failed and `38` passed.
- `pnpm exec vitest run --maxWorkers=2`: all `677` tests in `82` files passed;
  statements, branches, functions and lines each reached `100%` coverage.
- `pnpm run check` and `pnpm run lint` passed in
  `packages/smithers/flows/engine`.

The regressions include cancellation after a registration closes, retained flow
finalizers, and repeated cancellation without re-running the body.

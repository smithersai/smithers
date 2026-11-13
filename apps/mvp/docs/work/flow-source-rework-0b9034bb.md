---
title: Rework flow source regressions on durable item execution
status: done
area: flow
owner: codex
updated: 2026-10-21
links: []
---

Reapply 0b9034bb1b09 against current main. Library catalog: Make a durable
workflow (`@smthrs/flow`). Preserve payload reference source slots, inert
placement diagnostics, fatal draft refusal and deferred race replay boundaries.
Completion now runs in the durable item's completion action; remove raw defect
logging there and cause logging from the take recovery path. Keep the current
offer log and worker API. Obsolete completion/maxAttempts tests are omitted;
the current completion regression checks one handler execution across deliveries
and inspects logs, spans and metrics for private payload and failure markers.

The failing-first Latitude queue regression exposed the persistence defect and
handler failure in logs, and the recorded handler Exit in a successful action
span. Worker telemetry now withholds successful values and sanitizes failures,
without changing durable results. The regression also asserts the handler gets
the offered payload unchanged. No fixed test sleeps were introduced.

Latitude validation (LAT_RUN_REUSE_DEPS=1):
- `pnpm exec vitest run test/DurableQueue.test.ts`: expected privacy assertion
  failure before the fix (15 passed, 1 failed), after correcting bigint capture.
- `pnpm run check && pnpm run lint && pnpm exec vitest run`: passed, 71 files,
  924 tests, 100% aggregate statements, branches, functions and lines.
- `pnpm exec smithers-build test //packages/smithers/flows/flow:importRules`:
  failed with `unknown_label`; this base's PACKAGE.ts declares no importRules
  target. No target or threshold was bypassed or weakened.

The in-memory test runtime emits no run metrics; its registry is inspected
alongside the non-empty captured logs and spans. Existing RunMetrics tests also
passed in the full suite. Production deployment was not part of this rework.

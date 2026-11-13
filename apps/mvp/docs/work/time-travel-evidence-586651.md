---
title: Time-travel boundary and store evidence
status: done
area: sdk
owner: codex
updated: 2026-10-21
links:
  - packages/smithers/flows/time-travel
---

Reproduce and repair the eight reported boundary, frame, memory-store and SQL
truncation findings in an isolated jj workspace. Library catalog entry:
`@smthrs/time-travel`; no new dependencies.

Latitude regressions demonstrated conflicting outputs, duplicate terminal
receipts, mutable seeded history, carried-child lineage differences, future
attempt data and optional-table access. Documentation tests pin source-pair
allocation and inclusive fork offsets. Validation passed on Latitude: `pnpm run coverage --maxWorkers=2
--testTimeout=120000 --hookTimeout=120000` with the farm PostgreSQL service:
680 tests per backend, 1,360 total, and 100% statements, branches, functions
and lines. `pnpm run check` and `pnpm run lint` passed. The original regression
runs failed before the corresponding fixes. The first unrestricted matrix
hit Postgres timeouts under farm contention; the two-worker rerun passed.

Source allocation is an explicit two-coordinate caller contract; persisted
source identities are unchanged. Fork documentation now places the marker at
the inclusive prefix offset plus one, and subsequent child records at plus two.

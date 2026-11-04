---
title: Persist machine write refusal diagnostics
status: done
area: github
owner: codex-mtoken
updated: 2026-11-03
links:
  - ../features/machine-tokens.md
---

Persist the existing refusal cause and GitHub status on each machine write and
expose them through its status route. Failure values stay unchanged.
Library catalog: @smthrs/integrations (existing GitHub services), @smthrs/flow
(existing dispatcher), and @smthrs/database (real Postgres migration tests).

Migration 0106 adds nullable diagnostics without changing published migrations or
backfilling causes that are unknown. Refused writes persist the existing check
and available upstream status; failed writes persist exhausted/defect with no
upstream status. Done writes and retries clear both fields. GET and the e2e
failure message expose them; existing failure values stay unchanged.

Validation: the tests-only parent tree failed 7 of 51 machine-write tests;
the three new storage/GET cases each showed missing diagnostics. The initial
`db` filter also selected unrelated sandbox suites (262 tests passed overall).
The final targeted cfbox pg run through nyc-01 passed all 110 tests in
MachineWrite.test.ts and db/Database.test.ts, including upgrade preservation,
nullable defaults and migration idempotency. All four typecheck projects passed.
The land migration-numbering check passed. Production e2e was not run.

One commit for read-only review; no landing or push requested.

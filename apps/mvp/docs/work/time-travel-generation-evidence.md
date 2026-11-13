---
title: Bind rewind commit evidence to its journal generation
status: done
area: sdk
owner: codex-sol
updated: 2026-10-21
links: [../../../../../packages/smithers/flows/time-travel/docs/concepts/rewind-protocol.md]
---

Record the pre-truncation generation on rewind audits and match archive evidence
against it. Preserve generation-agnostic archive evidence for legacy audits and
journals without generations: rolling back a committed truncation reverses
compensation whose history is already archived. Use the catalog's
`@smthrs/time-travel` recovery and `@smthrs/database` real SQL test services.
Commit locally; do not push or move main.

Eight tests first reproduced false completion with archive evidence from an
earlier generation. The final 20 generation-evidence cases cover SQL and memory,
same/lower prior frames, matching evidence, legacy audits, and rewind failure
handling. Review regressions persist a real SQL handler's compensation receipt:
an archived legacy tail completes without reversing compensation, while a
missing archive row rolls back and restores the SQL effect. An injected service
wrapping the real SQL store also proves that a committed archive stays open for
recovery after a publication failure on a journal without generations. Updated
modern crash fixtures record their generations. The runtime documentation
assertion still follows the package manifest instead of a hard-coded version.

Validation: `pnpm run check` and `pnpm run lint` pass. Latitude's coverage matrix
passes 691 tests on SQLite and 691 on Postgres (1,382 total); merged statements,
branches, functions and lines are all 100%. The prescribed `lat-run` command
used `PG_BIN=/usr/lib/postgresql/18/bin` on nyc-01 after nyc-02 refused SSH.

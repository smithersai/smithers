---
title: Memory row-count and test-suite review
status: done
area: memory
owner: Codex
updated: 2026-11-13
links:
  - https://github.com/smithersai/smithers/issues/4720
---

Memory writes use the database library's `DurableWriter.affectedRows` rather
than silently interpreting an unsupported driver result as zero affected rows.
Fault-injected SQL results exercise real mutations and verify transaction
rollback; safe bigint counts retain correct write and deletion results.

The migration test checks the rebuilt message table's ID check and foreign key
without an unused schema-description helper. The projection timeout test uses
`TestClock` to distinguish a committed write from its awaited projection.

The remaining coverage cases cover lifecycle binding, test digest output,
and declarations without collaborators. Unreachable fallbacks are removed
where validated batch length, initialized vector buckets, and ordered bank
results already guarantee the value. The SQLite/PostgreSQL matrix earns
100% statements, branches, functions, and lines.

Validation: SQLite passes 460 tests with one PostgreSQL-only case skipped;
PostgreSQL passes all 461 tests. The native Bun affected-row regression runs
successfully in both matrix legs. Package lint and typecheck pass, as do the
conformance typecheck and all 321 coverage-conformance tests. Astra and Fable
reviews have no actionable findings.

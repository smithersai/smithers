---
title: Standing trigger approval on PostgreSQL
status: done
area: sdk
owner: Codex
updated: 2026-11-12
links: [https://github.com/smithersai/smithers/issues/5141]
---

Standing trigger consent must read the registered trigger on both supported
database backends. Preview, granting consent and admission revalidation use
the same declaration lookup.

Use the existing `@smthrs/database` library catalog entry and its
`Dialect.tables` query to check for the trigger table.

Regression coverage: `packages/smithers/test/ApprovalScope.test.ts` exercises
SQLite and PostgreSQL, including absent declarations, preview and grant,
idempotence, revocation and changed registrations.

PostgreSQL also needs quoted result aliases when approval checks read
camel-case fields. An appended migration widens the three approval timestamps
to the database library integer type, preserving existing grants and uses.

Validation uses the real SQLite and PostgreSQL drivers. The regression suite
covers a scheduler occurrence through standing consent and launch admission,
as well as upgrading the preceding persisted timestamp schema.

The four PostgreSQL cases fail on the unchanged production sources. With the
fix, all three affected CLI suites pass: 35 tests passed, with the SQLite
counterpart of the PostgreSQL-only migration test skipped. Source and test
typechecks, package lint and formatting checks pass. Two independent Codex
reviews found no issues.

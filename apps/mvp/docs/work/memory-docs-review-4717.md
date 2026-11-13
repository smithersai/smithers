---
title: Memory documentation and test descriptions
status: done
area: memory
owner: codex
updated: 2026-11-13
links:
  - https://github.com/smithersai/smithers/issues/4717
---

Correct the memory policy and recall troubleshooting, document note lifecycle
fields and acceptance conflicts, and describe the SQL projection guard accurately.
Rename the vector encoding and flow tier tests to match their assertions.
Keep runtime behavior and the public API unchanged.

Validation passed: the SQLite/PostgreSQL memory matrix (460 SQLite and 461 PostgreSQL tests passed;
one PostgreSQL-only case skipped on SQLite),
100% combined coverage, package typecheck and lint, site API and LLM bundle drift checks, redirect-map
check, and all 52 published package documentation tarball checks. Runtime source
is identical after removing comments; only two existing test descriptions change.

The broader site reference suite has the same release-pin failure on unmodified
`main`. The `docs-sync` flow wrapper also fails before execution on unmodified main
at the native filesystem directory-sync operation; the underlying documentation
checks pass.

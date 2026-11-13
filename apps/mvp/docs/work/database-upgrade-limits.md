---
title: Preserve converted flow instructions and database TLS policy
status: done
area: app
owner: Codex
updated: 2026-11-12
links:
  - https://github.com/smithersai/smithers/issues/5245
  - ../features/flows.md
  - ../infrastructure.md
---

Accepted legacy instructions can expand during TypeScript and JSON escaping.
The migration runner applies the new storage limits before the immutable `0025`
conversion. Raise source storage and validation to 512 KiB, serialized
draft storage and request bodies to 4 MiB, and the realm's encoded source input
to 4 MiB, with 512 KiB for emitted records and output so escaped controls fit. A later migration upgrades installations that already converted.
The largest legacy source expands by at most six bytes per original byte plus
the module wrapper; both storage formats remain bounded.

Hyperdrive development connections preserve `verify-ca` and `verify-full`.
Refuse CA file settings before binding construction, with a fixed diagnostic.

Regression evidence: real Postgres upgrades, source checks, realm execution and
receipts, and ChatApi draft/save/read/edit requests. Catalog entries: existing
Effect SQL database services, durable flows and the harness realm; no new library.

Validation: the regression fixtures fail against the original bounds and TLS
mapping. Real PostgreSQL upgrades and request round trips pass; the complete
harness suite and both package type checks pass. The database migration and TLS
module have full statement, branch, function and line coverage. Broader app checks
still report an existing navigation test failure and lint errors in other files.

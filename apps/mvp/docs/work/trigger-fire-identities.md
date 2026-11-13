---
title: Trigger fire identities and bounded history reads
status: done
area: triggers
owner: Codex
updated: 2026-11-13
links:
  - https://github.com/smithersai/smithers/issues/4909
  - ../../../../packages/smithers/agent/triggers/docs/api.md
---

A launch refused before creating a run stored its reservation token as a run
identity. Failure writes now keep the token in the ownership field; both
stores remove reservation tokens from settled run identities, and fire
summaries omit tokens in older rows. Invalid or overflowing fire pagination
reads at most one row.

Installation and troubleshooting now describe all five migrations, both SQL
backends, and per-attempt UUIDs. A webhook-ingestion test replaces the
literal-only channel tests and checks requests reaching Control.

The unchanged implementation failed seven regression assertions across the
scheduler, SQL and in-memory stores, fire summaries, pagination, and docs.
Validation passed: the SQLite/PostgreSQL matrix ran 874 tests with 100%
merged statement, branch, function, and line coverage. The package's
`check` and `lint` scripts passed. Astra review findings were fixed and
re-reviewed; Fable's work-note link finding was corrected.

The site API mirror and text export were regenerated and their drift checks
passed. All 52 published-package tarball checks passed. The docs flow wrappers
could not start because the environment lacks `smithers-jj-export`; the
underlying redirect-map and tarball checks passed directly. The optional site
reference tests passed 27 assertions; their existing flows-quickstart release
pin assertion failed on unchanged documentation.

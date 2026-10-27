---
title: Package bug bash 3 telemetry and data fixes
status: done
area: SDK
owner: bb3-obs
updated: 2026-10-27
links: []
---

Fix confirmed flowsdata-1 through flowsdata-4. Catalog entries: observability
(OTLP export), journal (redaction), time-travel (inspect), database (SQL).


Completed flowsdata-1/2 with one shared OTLP transport redactor; flowsdata-3
with bounded replay tail validation; flowsdata-4 with the driver's actual
console output. Each regression failed against the original behavior.

Latitude proof: observability 238 tests and 100% coverage; time-travel 744 tests
in each SQLite/PostgreSQL lane and 100% merged coverage; database's matrix
passes at 100% merged coverage. Typechecks pass. Time-travel/database lint
passes; observability ESLint and changed-file formatting pass, with three
pre-existing full-package formatting failures. Observability importRules
passes; time-travel/database have no declared importRules target.

The docs generator and all 51 package tarball checks pass directly. The
`pnpm docs:sync` / `pnpm docs:check` durable CLI invocations were interrupted
without receipts; their source generator/check modules passed on Latitude.
The redirect map is unchanged. Public declarations are unchanged.

The browser tab and engine worker use Otlp.layerFetch. The backend uses the
structured JSON logger and OtlpRelay, rather than this exporter. No app wiring
changed. Mini runs were skipped because the machine is unreachable.

Astra found numeric token counts were over-redacted; the exporter now reuses
the journal accounting policy. Its regression failed before the correction,
and the follow-up Astra review is clear. Fable was unavailable in this session.

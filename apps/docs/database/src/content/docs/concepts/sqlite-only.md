---
title: "Why 1.0.0-rc.0 is SQLite only"
description: "The backend contract this release states: the three opens the Node driver refuses, the connection strings it ignores out loud, and what a Postgres client does and does not get."
sidebar:
  order: 3
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/database/docs/concepts/sqlite-only.md"
---

1.0.0-rc.0 stores run state in local SQLite only. That is a release decision,
not a limitation of the write boundary, and the package enforces it in two
places: the driver refuses opens it cannot support, and the environment half
says out loud which names it is ignoring.

## The three opens the driver refuses

`NodeDatabase.layer` runs a guard before it creates a connection, and raises
`UnsupportedDatabase` as a defect in each of these cases:

| Code                        | Refused when                                                         | Message                                                                                  |
| --------------------------- | -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `unsupported_runtime`       | `process.versions.bun` is set                                        | `Use @smthrs/database/bun/BunDatabase under Bun; NodeDatabase requires Node.js >=26.4.0` |
| `unsupported_database_file` | the file has at least one table and no `flows_migrations` table      | `<path> is not a Smithers 1.0 database (1.0.0-rc.0 does not load a 0.x smithers.db)`     |
| `database_locked`           | a peer held the file for the whole open ladder, so it was never read | `<path> could not be inspected because another process holds it`                         |

A refusal is a defect rather than a typed failure on purpose. `layer` is a leaf
client layer whose error channel every durable package composes against as
`never`, and neither refusal is recoverable at run time: both are operator
mistakes fixed by selecting the matching native driver or another database file.
The value carried by the defect is still typed and matchable with
`isUnsupportedDatabase`.

The Node adapter checks runtime selection first and directs Bun callers to
BunDatabase. The shared durable engine runs on either native adapter; both use
the same file guard and retry policy.

### What the file check actually reads

The guard opens the file read-only and reads `sqlite_master`. A database whose
tables include `flows_migrations` is a Smithers 1.0 database and is waved
through. A database with tables but no ledger is a 0.x `smithers.db`: opening
it would add `flows_*` tables beside its `_smithers_*` ones and silently mix
two schemas, so it is refused.

Two details close bypasses that a naive probe leaves open:

- **`file:` URIs are probed by their path alone.** `node:sqlite` accepts a URI
  as a filename, which would slip past a filesystem check. The query says how
  to open the file, never which tables it holds, and a read-only open of
  `file:<path>?mode=rw` fails on the mode conflict before reading one, so the
  probe drops the query and the fragment. The exception is `mode=memory`, which
  names a pure in-memory database rather than a way to open a file. SQLite
  honors the last `mode` when a query repeats it, so only a URI whose final
  mode is `memory` skips the probe.
- **A locked file is not an unreadable file.** The probe retries on the same
  ladder the open uses, so a 0.x database is refused whether or not a 0.x
  writer held it at that moment. A lock nobody releases exhausts the ladder and
  is refused as `database_locked`, because the open would have waited the same
  peer out: reporting it as a transient driver error would make
  `isUnsupportedDatabase` answer `false` about a database this driver declined
  to open.

The guard says nothing when the file cannot be inspected at all: a path that
does not exist, a directory, an in-memory name, or a file SQLite refuses to
read. None of those is a 0.x database, so the driver's own open decides what
happens next.

### Why opening retries at all

`SqliteClient` opens the file, sets `PRAGMA busy_timeout`, and then issues
`PRAGMA journal_mode = WAL` inside its constructor. Two processes opening one
file concurrently collide there in two ways, and neither is reachable by the
write-retry policy, because the failure is a raw throw during layer
construction rather than the `SqlError` the policy classifies:

- `SQLITE_BUSY` on the mode change itself. SQLite converts a database into or
  out of WAL only with the file to itself. The change does consult the busy
  handler, so a contended attempt waits the whole `busyTimeout` and then
  reports `database is locked`.
- `SQLITE_BUSY_RECOVERY` when opening a WAL database whose log needs recovery
  while a peer is already recovering it.

Both clear as soon as the peer finishes, so the open retries on a fixed ladder
of 40 attempts with a 5 ms base delay capped at 250 ms. The ladder is
deliberately not configurable: it bounds a driver-internal race during layer
construction, before any service exists to configure, and its bounds come from
SQLite's WAL behavior rather than from your workload. Because a contended
attempt can spend up to the configured `busyTimeout` inside SQLite before the
ladder's own delay, the wall-clock cost of exhausting the ladder is bounded by
that timeout, not by the delays.

## The connection strings this release ignores

A project migrating from a 0.x PostgreSQL or PGlite deployment still exports
that deployment's connection strings, and rc.0 ignores them. Ignoring them in
silence is the failure the notice exists to prevent: the project would run
against SQLite believing it ran against PostgreSQL, and nothing in the run
would say otherwise.

`UnsupportedBackend.ignoredNames(process.env)` lists the names in play,
`SMITHERS_TEST_PG_URL` and every `SMITHERS_POSTGRES_*` name, sorted, with an
exported-but-blank name counting as unset. `ignoredNotice(name)` is the one
line each gets:

```text
ignored: SMITHERS_POSTGRES_URL has no effect in 1.0.0-rc.0 (SQLite only)
```

It is a notice, not a refusal. Nothing about the run changes and the exit code
does not move. Choosing a backend is the separate case: `SMITHERS_BACKEND` or
`--backend` with any value but `sqlite` exits 1 with `unsupported_database`, a
refusal the CLI owns.

The separator is part of the prefix. Every name 0.x actually read carries it,
so `SMITHERS_POSTGRESQL_URL`, a name neither release reads, is not announced as
one this release decided to ignore.

## What a non-SQLite client does and does not get

The package root bundles for browsers as a contract, and `DurableWriter.make`
accepts any Effect `SqlClient`. A Postgres or PGlite client wrapped by the
writer gets the full retry classification and the normalized error vocabulary,
including the SQLSTATE values and the server texts PGlite raises without a
code.

It does not get a schema. No browser, Postgres, or PGlite client layer ships
here, and the storage packages' migrations are SQLite-flavoured DDL, so there
is no runnable ladder for another dialect. Postgres and PGlite layers, and a
dialect-parameterized migration ladder, are planned and do not ship in this
release.

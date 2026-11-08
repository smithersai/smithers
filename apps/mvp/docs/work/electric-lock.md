---
title: ElectricCollection persisted SQLite lock failures
status: done
area: sdk
owner: codex-sol/electric-lock
updated: 2026-11-04
links: [../../../../packages/effect-electric/test/Sqlite.test.ts]
---

The test host was wrong: asynchronous `execute` around synchronous `node:sqlite` let independent connections on one JavaScript thread interleave transactions. `f1768aa0` added batched restore reads with `BEGIN IMMEDIATE`, exposing `SQLITE_BUSY` before the owning connection could resume and commit. Files were already unique and connections scoped; neither a leaked handle nor a product locking defect was found.

The fixture now matches `SharedSqlite`'s documented host contract: a real Web Lock per file remains held through the transaction, and a batch executes synchronously. Separate connections, real SQLite, real Postgres/Electric, and the existing coordinator tests remain. Fixture regressions cover concurrent TanStack restores, batch order and parameters, SQL failure and recovery, commit/rollback/close ownership, and independent files. The fixture joins the existing 100% coverage gate. No mocks, retries, timeout increases or skipped integration cases.

Catalog entries used: Electric collection sync (`@smthrs/effect-electric`), collection persistence (`@smthrs/effect-tanstack-db`), and the existing `@smthrs/platform-browser` shared SQLite host contract. No production API changed.

Mac mini history checks (complete suites, one worker):

| Revision | Result | Coverage |
| --- | --- | --- |
| `b1f018e0` (October 22) | 115/115 pass | 100% statements, branches, functions, lines |
| `262fbdd2`, parent of first bad revision | 234/234 pass | 100% on all four metrics |
| `f1768aa0`, first bad revision (November 2) | 231/234, same three SQLite lock failures | failed suite |
| `b9bf31eb`, reported revision | 257/260, same three SQLite lock failures | failed suite |

Current-main baseline `c3ada6a9` failed the same three cases (264/267); under Node 26.10 they surfaced as missing hydration/assertion failures. The new concurrent-restore regression independently fails with `database is locked` against the original fixture. After correction the initial seven fixture regressions pass with 100% on all four coverage metrics, and the three original ElectricCollection failures pass.

The first corrected complete run passes 274/274 tests. Its global coverage gate exposed untested branches already on main: malformed/protected proxy rows and watcher eviction before its first read. Added focused cases through the existing injected HTTP fault service; malformed inputs must never reach authorization, emit content or advance a cursor. The early watcher variant retains the real coordinator/device path. No production behavior changed and no threshold was lowered.

Fable found that closing a connection waiting for the file lock could later leak that lock when `isTransaction` threw on the closed database. Cleanup now checks `isOpen` first and unlocks even if close throws. Its regression verifies a third connection progresses after the closed waiter's request fails. TanStack's per-connection queue is documented as the fixture's caller contract. Codex Astra and Fable follow-up reviews report no actionable findings.

Formatting and VibeLang source/test typechecks pass for the initial corrected run. The expanded run passes 285/285 tests; fixture coverage is 100% on all four metrics. The last global branch gap is the guarded-response byte counter's impossible fallback after `HttpServerResponse.text`. The proxy now encodes JSON once, returns those bytes and records their actual byte length; the delete/filter regression uses a Unicode key and checks content type, decoded content and UTF-8 telemetry. Astra reviewed that change with no findings. Final Mac mini validation passes: all 285 tests (13 files), with 100% statements, branches, functions and lines, including every branch of the SQLite fixture. No skipped tests. `pnpm run check` passes both VibeLang projects. `dprint check test/sqlite.ts test/Sqlite.test.ts test/fixtures.ts vitest.config.ts README.md` passes. The complete test command is `node scripts/test-services.mjs --reporter=verbose`, with the real Postgres/Electric stack. Both Astra and Fable reviewed the byte-count cleanup with no actionable findings.

---
title: Diagnose runs larger than the CLI history budget
status: done
area: cli
owner: codex-runshow-resume
updated: 2026-11-04
links:
  - https://github.com/smithersai/smithers/issues/4438
---

Fix the bounded event-history read used by runs show. Preserve small-run output;
stream large histories with explicit field and history omission receipts.
Validation runs on the Mac mini. Do not land or push this change.

The failing bound was `src/internal/BoundedEvents.ts`: 16 MiB of collected
control history, with a separate 1 MiB event bound. `runs show` now consumes
that stream once, retaining a bounded recent window, explicit omission receipts,
and the last state node, round and error. Small-run output has a pre-change
golden. `--field` selects an event JSON pointer; strings support bounded pages.
`runs list`, `runs resume` and `runs cancel` have no matching collection bound;
the real SQLite CLI regression exercises all three (terminal resume/cancel).
Strict log, timing, DevTools and legacy forensic readers remain bounded failures.

Validation on the Mac mini: 156 tests passed across RunHistory, RunHistoryCli,
UnifiedControlCommands and BoundedEvents; ESLint and the test-project VibeLang
typecheck passed. Baseline regression: two failures including the exact
16777216-byte error, with the small-run golden passing. Artifacts and review
prompt are kept in the operator's requested external scratchpad. No landing,
push, deployment, or issue mutation is authorized for this work.

Astra's first review found four defects, now covered by regressions: bounded
metadata for oversized keys, unique pointers for derived watch members, a bounded
operational fold independent of window eviction, and shell-safe command quoting.
The final targeted run measured 100% statement, branch, function and line coverage
for the new RunHistory module; this is not a whole-package coverage claim.

Astra's second review found four additional diagnostic defects. Large histories
now expose a reduced diagnosis with unavailable content-dependent statistics;
round observations are scoped to the current execution and native evidence wins;
human output preserves structured error and omission details; fault-only error
receipts name their actual field. All four have regression coverage. The updated
Mac mini run passed 144 tests, lint and typecheck with the same 100% new-module
coverage. No publication is authorized.

The third review found native observation buffering and partial health/activity
claims, plus recursive byte accounting. Native snapshot and catalog SQL now
project lifecycle columns and only version/flow-name scalars from JSON, without
returning the serialized run state. Optional waiting-request column discovery
preserves read-only legacy schema compatibility. A real SQLite/PostgreSQL matrix
generates a 34 MiB native payload/result state and verifies a small returned row.
Partial histories omit health/activity with explicit unavailable receipts. The
JSON byte walker is iterative and tested at 20,000 levels.

Final execution: CLI 156 tests and 100% new-reader coverage; engine-store targeted
matrix 48 cases per SQLite/PostgreSQL leg. Both packages passed changed-source
ESLint and test-project typechecks. This change uses the catalog's engine-store
observation and database dialect entries as well as control and canonical JSON.

The next review found stale node hints and formatted field-output expansion.
Node evidence now follows event order, with stale hints retained only as
lastRecordedNode. Field reads measure pretty-printed output, reserve envelope
space and bound depth before returning data. The real CLI covers valid
200-level nested records whose formatted output would exceed 1 MiB. Reduced
large-run summaries skip execution batches they do not use. Final CLI checks:
156 tests, changed-source lint, typecheck and 100% reader coverage passed.

Control-plane terminal records and authoritative terminal run status now
invalidate current-node evidence even when native terminal facts are absent.
Historical state hints remain lastRecordedNode; late scheduling cannot resurrect
a current action. All three terminal statuses have reader and CLI regressions.
The final CLI run passed 156 tests, lint and typecheck with 100% reader coverage.

The full-suite regression follow-up found a fifth SQL statement in every run
page, plus a decoding counter that still watched the removed `state_json`
column. Optional-column discovery now shares the source/watermark statement;
the counter watches projected `state_version`. All cursor, filter, exact
decoding-bound and index-plan assertions remain. The full engine-store run has
the same 77 failing names as its main baseline, with 2,225 passes versus 2,220.
Focused SQLite and PostgreSQL runs each pass 11 cases, including construction
before migrations and a column added after a legacy page read.

The first completed CLI run exposed one additional failure: its new persisted
history fixture tried to execute a flow on a host without the native helper.
The fixture now uses the existing RunTimingStore pattern: real NodeRuntime
storage and NodeControl migrations, then persisted SQLite rows. All original
CLI assertions remain. The corrected test passes, and replacing only the CLI
reader with its parent revision still produces ResourceLimitError. This uses
the catalog's platform-node host and control entries; no model call is needed.

Astra then found terminal-safe JSON escaping could expand an admitted field
beyond its output budget. Formatted byte measurement now uses that same escaping,
and string pages reserve envelope space. Scalar, nested and paged control-text
fields have reader and real CLI regressions checking final stdout bytes. The
focused four-file run passes 157 tests. The final full CLI rerun is pending.

The next Astra review found stale current actions after native projection gaps
or rewind generations. The fold now invalidates affected evidence, rejects
older epochs and accepts fresh scheduling. Only positive generations consume
the bounded watermark map, preserving ordinary long histories with thousands
of children. Unknown or oversized evidence fails closed. The first focused
gap run passed 172 tests; final checks also exercise real CLI gap/rewind reads,
multiple rewinds, legacy unknown generations and the watermark boundary.

Child rewinds can also archive descendant journals. Because the bounded fold
does not retain ancestry, every rewind now clears all current-action evidence;
compaction gaps still invalidate only their named execution. A grandchild
regression covers a non-selected child rewind. The human suggested command now
uses terminal-safe rendering without changing structured data, covered by a
real persisted run ID containing OSC and cursor controls. Final focused checks
pass 180 tests, the test-project typecheck, and 100% statement, branch, function
and line coverage for RunHistory.ts. Production RunHistory ESLint has no errors;
the test files are outside its configured scope. Full CLI comparison is pending.

The resumed Astra review found terminal evidence survived a rewind and resume
forever. Confirmed rewinds and control resume receipts now reset that lifecycle
and clear stale current actions, preserving native generation fences. Regressions
cover all terminal statuses, both resume receipts, delayed older epochs and a
second rewind without a gap receipt; the real persisted CLI fixture exercises
failure, rewind, resume and fresh action. Final remote validation is pending;
its logs and comparison are retained in the requested external scratchpad.

Final regression validation completed on the rebased change. Engine-store:
2,225 passed, 77 failed, 3 skipped; main: 2,220 passed, the exact same 77
failing names, 3 skipped. All three independent 100/1,000/5,000-run cursor
reference cases pass, with zero added or removed failing names.

The complete CLI suite ran as all eight Vitest shards on both revisions, with
per-shard test summaries, actual Vitest statuses and completion/transport
receipts. Main: 210 failed, 5,642 passed, 3 expected failures, 99 skipped
(5,954 cases, 353 files, 212 distinct failing names). The fix: 209 failed,
5,724 passed, 3 expected failures, 99 skipped (6,035 cases, 355 files, 211
distinct failing names). No failing names were added. The unrelated GenerateCi
case, "generate ci renders the declared CiGen even beside an inert Workflow",
did not recur; this change does not claim to fix it. All five dispatch
failures from the focused run also fail on main.

Focused reader validation passed 78 tests, with 100% statements, branches,
functions and lines for RunHistory.ts; lint and the CLI test-project typecheck
passed. The five new lifecycle cases fail against the previous reader. The
earlier serial CLI stream ended without an exit receipt and is excluded from
completed evidence. The supplied main log disappeared during execution, so
the main comparison was rerun against the pinned base. No assertions or
timeout bounds were weakened for sharding. Astra passed the production diff;
the final documentation update receives its own exact-diff review. Every
staging tree has been removed with guarded paths. No landing or push.

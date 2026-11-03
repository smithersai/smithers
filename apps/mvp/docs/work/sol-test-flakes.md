---
title: Remove runner, idle probe, chat and store test flakes
status: in-progress
area: app
owner: Codex GPT-6.1 Sol (sol-flakes workspace)
updated: 2026-11-02
links: [app-flakes.md, engine-flake.md]
---

Investigate each named failure with red/green receipts on the real Latitude
Postgres and Electric fixtures. No retries, sleeps or increased timeouts.
One commit per reproduced flake, landed through the workspace landing flow.
The engine-store and eight-clone cases must be exercised with bounded CPU load.

## EffectBoundaryRecords

Reproduced the original exact-log-count assertion on the Postgres matrix leg
under bounded CPU load. A diagnostic-only pass retained the logger's message
in addition to its cause and identified the second record: Effect TestClock's
"A test is using time, but is not advancing the test clock" warning.
See `evidence/sol-test-flakes/boundary-red.txt`.

Fix classification: **test**. The warning test now uses `it.live` for real SQL
I/O, asserts the actual warning text as well as annotations, and separately
asserts its persisted provider cause. Product code, budgets and exact count
assertions are unchanged. Library catalog entry: durable flow engine/stores
(`@smthrs/engine`, existing TestStores) and the existing Effect test services.

Reproduction/validation (run on Latitude from the package directory):

```sh
python3 ../../../../apps/mvp/docs/work/evidence/sol-test-flakes/load.py 1 \
  node ../database/scripts/test-matrix.mjs test/EffectBoundaryRecords.test.ts \
  --coverage.enabled=false --reporter=verbose
```

Set `FLAKE_CPUS=1 FLAKE_BURNERS=8` on the runner. The helper creates only its
own bounded workers, pins them to the chosen CPU, and terminates and joins
them when the test command ends. Each independent invocation has a 240 s CPU
load bound; it stops on the first test failure. This is targeted behavioral
validation, not a package-wide coverage receipt.

Green: the first loaded SQLite/Postgres pair passed all 12 cases with the live
warning test, including its exact single-warning assertion. Further loaded
pairs and the landing check retain independent invocation receipts below.

Boundary validation completed: three independent loaded SQLite/Postgres pairs
passed (36 cases), plus the loaded landing pair (12). Landed `f0164418fabd`.

## chat.test.ts

Clean-baseline failure identified: **orders the conversation by Postgres
position, across devices**, line 260, waiting for the first answer's Electric
row. The first messages snapshot answered 503 after 5892 ms. Electric recorded
"Snapshot timed out while waiting for a table lock"; its same 32-second window
had 47 snapshot lock timeouts, 33 schema-change snapshot errors and 21 chat
schemas. The mini's unit commands share the long-lived Postgres/Electric
services with independent suites. Their DDL and publication changes contend;
this was a failed initial snapshot, not an incorrect message order.
See `evidence/sol-test-flakes/chat-red.txt`. The same baseline run also failed
unsent-question recovery and cross-person queue isolation under that load.

Fix classification: **test command**. `pnpm test` now uses the existing
`db/test-stack.sh` boundary by default, as the infrastructure docs already
recommended for complete runs. It owns a fresh real Postgres/Electric stack
and its WAL storage and preserves all test assertions, timeouts and retries.
No new library: the existing Compose fixture and Effect SQL/Electric services
from the library catalog are retained.

Other baseline receipts so far: named overflow passed in its complete file
and in three fresh two-overflow-test invocations; named idle probe passed
10 loaded repetitions; eight-clone DriveWrites passed five loaded runs in a
real shared fixture and three real disposable-Postgres matrix legs. One of
those matrix legs outlasted the CPU workers' 240 s bound, so only the initial
loaded portion counts as CPU stress. No causes or fixes claimed for these
three unreproduced failures.

Chat green: the same mini under concurrent load, through `pnpm test`, passed
all 111 cases in chat and TestEndpoints. All three previously failing chat
cases passed. Assertions and time budgets are unchanged; the owned stack
cleaned up its containers and network and the runner returned 0. See
`evidence/sol-test-flakes/chat-green.txt`.

The default entrypoint is `db/test.sh`: owned dependencies unless the caller
explicitly supplies `MVP_TEST_STACK=external` for an already isolated fixture.
Latitude's reserved-slot caller selects external mode; ordinary mini and local
commands own a fresh Compose stack. Invalid modes fail with exit 64 before
launching dependencies or tests. Both real-service modes passed the 27
TestEndpoints cases on Latitude; the default owned mode passed all 111 chat
and endpoint cases on the mini. The final landing check repeats that owned
run with the latest entrypoint. No retry, sleep or timeout was added.

Final unreproduced cases (see `evidence/sol-test-flakes/unreproduced.txt`):

- **Overflow 40P01:** nine executions passed, including five independent
  invocations with two CPU burners on two CPUs; each burner remained alive
  through every loaded invocation. No deadlock graph or 40P01 was captured.
- **Named idle probe:** ten loaded repetitions passed. The original combined
  run failed three *other* Probe cases launching their numeric-user process
  (exit 128/1); that is not evidence for the named idle failure.
- **Eight-clone DriveWrites:** ten executions passed: five direct Postgres,
  three disposable-Postgres matrix legs and two heavier matrix legs with
  eight CPU burners on one CPU. One moderate matrix leg exceeded its
  240-second load bound; nine invocations were fully loaded. SQLite legs of
  this Postgres-only suite were skipped and do not count as passes.

Those three reported causes remain unverified; their tests and product code
were left unchanged. Further work needs a failing receipt to diagnose. Two
Latitude slots also failed service provisioning before Vitest; those failures
are excluded from the test counts. No production e2e command ran.

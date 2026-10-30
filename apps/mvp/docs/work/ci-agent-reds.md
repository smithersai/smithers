---
title: Repair assigned CLI, agent, control, gateway and Electric CI targets
status: in-progress
area: sdk
owner: ci-agent
updated: 2026-10-30
links:
  - https://github.com/smithersai/smithers/actions/runs/40929998769
---

Reproduce the seven assigned target failures with the CI runner on Latitude.
Fix each root cause with regression evidence; retain the existing coverage and
timeout gates. Deliver separate commits by root cause for the CI repair batch.

Libraries: the CLI, agent, model-host, control, gateway, and effect-electric
entries in `docs/libraries.md`, plus flow, harness, database, journal, run-store and engine-store;
existing services remain their public seams.

The shared test setup preserves the CLI target's explicit Node compile-cache
path. Standalone runs still clean up their default cache. Real loader tests
cover success and failure with owned and shared caches. The original worker
probe disabled coverage and missed Vitest stripping the Node cache reference.
The actual V8 worker fixture now keeps that cache disabled in measured workers,
passes a separate run-owned reference to unmeasured CLI children, and checks
100% coverage of both branches of its measured source. Explicit opt-outs and
external Node coverage retain disabled caches and precise source ranges.

The CLI runner preserves the configured normal/fault split and schedules each
file in one Vitest pool with four workers. Independent runners repeated compiler
coordination and left a late static group holding the remaining suite budget.
The real discovery fixture retains every default file exactly once, keeps the
fault tier separate and preserves the configured coverage thresholds. Real
worker fixtures check queued progress, late failure propagation, both compiler
caches and cleanup.
The source-host startup profile exposed the offline preload entering esbuild's
worker through `NODE_OPTIONS`, despite the worker's empty `execArgv`. The preload
now applies to main threads only; the real-process regression retains inheritance
by child CLIs and exercises esbuild's synchronous transform. Per-file results
remain visible if a target ends before Vitest can print its final summary.
Native peer recovery retains its former early group priority through Vitest's
public sequencer. The previous size ordering started its first scenario 38
minutes into the 40-minute run, after the other 323 files had produced coverage.
Cold actual discovery rejects that ordering and verifies the recovery file is
first, retaining the same inventory, configured gate and four-worker pool.
The follow-logs assertion reproduced in a later four-copy run. Its follower
returned engine interruption events without `control.run.cancelled`: the engine
observation became terminal before the control transaction committed. Observed
summaries now retain `recordedStatus`, and following uses that committed status
for its final drain. Real control services exercise the gap for every terminal
status and both ordinary and past-terminal cursors; SQLite reconciliation checks
retain current engine truth beside the recorded state. Cache inheritance remains
a separate verified environment correction.
The next full CLI run completed within its original deadline (316 files passed,
three assertions failed). The raw environment execution assertion still expected
the measured worker's cache instead of the explicit child environment. The
cross-host takeover fixture started a same-host observer before aging the stopped
owner's lease; its legitimate live-PID confirmation could renew that lease.
The takeover now precedes that observer's registration. Health discovery also
reported an unregistered timer wake during host teardown; its probe scope now closes before discovery registration is released. A real
SQLite timer driven during a held probe finalizer rejects the old implementation
with that exact warning; all nine health cases pass with the correction, including
bounded admission and reopening the same discovery lineage. The nineteen
environment and peer-recovery cases, the real canonical-refusal warning case
and the CLI typecheck also pass. The next full CLI run reached its unchanged deadline with the binary suite
still launching processes. Those launchers bypassed the verified child cache
handoff, inheriting Vitest's disabled worker caches. Their real Node adapter
now applies that handoff to ordinary and deliberately narrow environments;
the V8 worker regression uses the same adapter, checks environment isolation,
and retains precise measured-source coverage. The next full CLI run again reached its original deadline with 325 files recorded and the binary suite still spawning. A live child had the native cache reference, caches enabled, and no external coverage. The binary contracts now occupy seven files in the same four-worker pool, sharing the existing fixtures; their cases, process deadlines and assertions are unchanged. Public discovery checks the distributed inventory, and verbose case timings survive an interrupted run. Public size ordering ranked the seven binary files 53rd through 133rd despite their process workload; the first distributed attempt was cancelled to correct that scheduling. The sequencer now dispatches all seven immediately after peer recovery. A cold public discovery regression checks that early dispatch while preserving the same inventory, worker limit, deadlines and fault split. Final validation is pending.
Native recovery probes wait for actual admission refusals before asserting a
park, retaining the explicit-consent and exactly-once execution checks.

The agent target declares its PostgreSQL service and keeps its full 100% gate.
Resume offers carry their durable delegation sequence; a per-run admission
permit checks and acknowledges that sequence around the handoff. Current wait
observations retain their grant tokens over unversioned legacy history.

Scaffold compilation uses VibeLang and exposes portable SDK declarations
without Node ambient types. The SDK host-probe typing fixes preserve runtime
behavior and the existing observable host-access contract.

The canonical spelling scan filters ordinary package imports before parsing,
keeps compiler decoding for escaped source, and resolves lines only for
relevant decoded text in an AST without parent links. Discovery includes
VibeLang. Real parser cases retain escaped commands, newline boundaries,
templates, shell arguments and migration warnings. Four concurrent instrumented
probes pass the unchanged deadline; old record behavior and TypeScript-only
discovery each fail the parser regression.

The native human-wait budget fixture uses the public Clock service for
provider time and parked time, retaining real scheduling. Replacement-host
adoption ages the persisted delegation by the public ownership grace. A
negative control charging the parked span still exceeds the unchanged ceiling.
External-worker lease checks retain every scenario execution while excluding
the observer's unrelated health-discovery release.

Metadata cancellation waits for the engine's fenced terminal transition,
retaining the no-import, no-replay and idempotency checks. An observing control
port does not disable the engine's metadata-only cancellation guard.

Native planning timeout injection follows catalog construction rather than
loader invocation count. The catalog deadline can expire during source
verification; its direct retry intentionally has no catalog deadline. Four
loaded coverage probes retain real timeout refusals, schema validation and
planning, including an initial load never reaching its loader.

The approval-gated image push passes with a real Docker registry and buildx.
Electric also passes its full coverage target after provisioning fresh real
Docker Compose services. Neither check relies on a simulated dependency.

Safe adoption diagnostics preserve strict response decoding and record bounded
process and status metadata. The earlier empty-document failure has not recurred
in the instrumented probes or the latest complete source-snapshot group; the
diagnostics remain evidence collection, not a claimed correction of its cause.

Native materialization shares the calling layer's memo map. The control-first
transaction regression fails on the previous graph with Effect 4.0.5; both
acquisition orders and standalone materialization pass with the existing fix.

Payload refusals retain both real CLI entrypoints. Their durable checks read
plans and executions directly and reject an action output, avoiding another
host startup. Bounded process and startup-stage receipts survive fixture cleanup.

The fresh agent gate completed 165 files with one signed-thread timeout.
Failure receipts now retain timer polling, virtual time, the persisted wake
and the clock-advance stage. Four loaded repeats did not reproduce it.
A real SQLite counterexample forces the caller to advance after reading the
clock: the old armer sleeps until 6000 ms against a persisted 3000 ms deadline.
The timer now samples time in its own fiber. Its committed completion is at
3000 ms, the focused clock suites pass, and all twenty loaded example cases
pass. The full SQLite/PostgreSQL engine-store matrix and the agent target now pass their original coverage gates, as do refreshed control, gateway and model-host targets. The original loaded example repeats did not reproduce the timeout.

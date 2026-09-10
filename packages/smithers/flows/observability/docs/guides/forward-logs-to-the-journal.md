---
title: "Forward logs to the run journal"
description: "Install JournalLogger.layerJournalForwarding so a run's Effect log records become durable telemetry.log entries, and read them back: capacity, bounds, redaction, observed losses, and admission limits."
sidebar:
  order: 3
---

`JournalLogger` turns a run's Effect log records into durable, structured
`telemetry.log` entries on that run's journal. It is the second delivery path
beside [OTLP export](./export-to-a-collector.md), and it is the one an operator
reads without a collector: the records land next to the run's lifecycle events
and are read back with the same `Journal.entries` call.

## Install the layer

The layer names one run, and requires a `Journal.Journal` service from
[`@smthrs/journal`](/api/journal):

```ts
import * as JournalEvent from "@smthrs/journal/JournalEvent"
import * as JournalLogger from "@smthrs/observability/JournalLogger"
import * as Schema from "effect/Schema"

const runId = Schema.decodeUnknownSync(JournalEvent.RunId)("deploy-status-1")

const journalLogs = JournalLogger.layerJournalForwarding({ runId })
```

`runId` is branded, so it comes from decoding a string rather than from a bare
literal. Decoding it here means a malformed id is reported where it was
written.

Provide the layer over your journal. In a test, the deterministic bundle is
enough:

```ts
import * as TestJournal from "@smthrs/journal/test/TestJournal"
import * as Layer from "effect/Layer"

const layer = Layer.provideMerge(journalLogs, TestJournal.layer())
```

In production, the journal is the one your durable engine already composed;
provide the forwarder over it the same way.

## Read the records back

Each record is one journal entry with `eventType` `telemetry.log`, written on
the journal's lossy channel by source `flows/observability/logger`. The payload
decodes with the exported schema:

```ts
import * as Journal from "@smthrs/journal/Journal"
import * as Effect from "effect/Effect"

const read = Effect.gen(function*() {
  const journal = yield* Journal.Journal
  const page = yield* journal.entries({ runId, limit: 200 })
  return page.entries
    .filter((entry) => entry.eventType === "telemetry.log")
    .map((entry) => Schema.decodeUnknownSync(JournalLogger.TelemetryLog)(entry.payload))
})
```

A decoded record carries the level, the logged message, the log annotations,
the fiber id, an ISO-8601 timestamp, the active span's `traceId` and `spanId`
when there was one, and a structural `cause` that preserves the order and the
kind of every failure reason:

```text
{
  version: 1,
  level: "Error",
  message: [ "deploy failed" ],
  annotations: { lane: "api", attempt: 2 },
  cause: {
    version: 1,
    reasons: [
      { _tag: "Fail", error: { code: "timeout" } },
      { _tag: "Interrupt", fiberId: 7 }
    ]
  },
  fiberId: 12,
  traceId: "0af7651916cd43dd8448eb211c80319c",
  spanId: "b7ad6b7169203331",
  timestamp: "2026-09-03T12:00:00.000Z"
}
```

The durable journal allocates the per-source sequence, so restarting the layer
or running two of them for one run cannot make two records collide on one
identity.

## Choose the queue depth

The logger callback never blocks. It snapshots the record synchronously when the
bounded queue has room, then offers it to that queue, which a forked worker
drains into the journal.

```ts
const journalLogs = JournalLogger.layerJournalForwarding({
  runId,
  capacity: 4096,
  minimumLogLevel: "Debug",
  mergeWithExisting: true
})
```

- `capacity` defaults to 256 and accepts 1 through
  `JournalLogger.maximumCapacity` (65,536). Raise it for a chatty run on a slow
  journal; a full queue drops the incoming record before snapshotting it, so
  saturation costs no traversal of the logged value.
- `minimumLogLevel` pins `References.MinimumLogLevel` for the whole
  application. Omitted, the layer leaves that reference alone and Effect's own
  `Info` default applies.
- `mergeWithExisting` defaults to `false`, which replaces the ambient logger
  set. Pass `true` to keep a console logger alongside the forwarder. See
  [Install a logger](./install-a-logger.md).

An invalid run id or capacity fails layer acquisition with
`InvalidJournalLoggerOptions`, before any worker starts.

## What the snapshot does to a value

The record is detached, bounded, and redacted before it joins the queue, so
mutating a logged object after the log call cannot change what is persisted,
and a hostile value cannot stall the logger.

| Ceiling                  | Value | What happens past it                             |
| ------------------------ | ----- | ------------------------------------------------ |
| `maximumSnapshotBytes`   | 1 MiB | Text is cut and marked `[Truncated]`             |
| `maximumSnapshotMembers` | 4,096 | Remaining members become one `[Truncated]` entry |
| `maximumSnapshotDepth`   | 64    | Deeper values become `[Deep]`                    |

Values that cannot be read at all, such as a throwing accessor or a revoked
proxy, become `[Unrenderable]`. Functions, symbols, and binary data are named
rather than serialized (`[Function]`, `[Symbol]`, `[Binary]`), and a cycle
becomes `[Circular]`. Text is bounded in one pass that never cuts a surrogate
pair, so a truncated string is still well formed.

An `Error` is projected to `name`, `message`, `stack`, and `cause` first, then
to every other own data property it carries, under the same member and byte
budgets. A `Schema.TaggedError` therefore keeps its `_tag` and its declared
fields, and a Node system error keeps `code`, `syscall`, and `path`. Accessor
properties become `[Unrenderable]`, and members past the budget become one
`[Truncated]` entry.

Container-shaped fields keep their shape. Annotations whose snapshot spent the
whole budget arrive as `{ "[Truncated]": "[Truncated]" }` rather than as a
scalar the schema would refuse. A projection that still fails `TelemetryLog`
degrades to a total record with an empty cause, so every durable
`telemetry.log` row decodes.

The journal's own redaction rules run before queue admission, the same scrub
durable events get, so a credential in a logged object never reaches a
permanent row.

## Watch for lost records

Forwarding is lossy on purpose: a telemetry backlog must not become application
backpressure. Each of these observed losses advances `Metric.droppedLogRecords`
(`flows/observability/log/dropped`) once:

1. **Forwarder queue overflow.** The queue was full when the record arrived.
   Counted only.
2. **Journal `Dropped` receipt.** The journal refused admission under its
   `drop-newest` policy. Counted only; `Accepted` and `Duplicate` receipts do
   not advance the counter.
3. **Journal delivery failure.** Admission failed. Counted, and reported as a
   warning with the run id and code `journal_forwarding_failed`.
4. **A defect from the journal implementation.** Counted and warned with the
   run id and code `journal_forwarding_defect`. The worker keeps draining.

Warnings carry fixed diagnostic codes instead of raw errors or causes, so
failure credentials do not reach ambient warning sinks. The worker is forked
before the forwarding logger is installed, so a warning cannot enqueue itself.

`emitLossy` reports admission, not durable delivery. The counter cannot observe
later `drop-oldest` evictions of admitted telemetry, asynchronous persistence
failures, or journal shutdown losses. An `Accepted.evicted` summary does not
identify the evicted record, so it cannot attribute that loss to telemetry.

Interruption stays fatal: closing the layer's scope ends the worker and can
drop records queued behind an in-flight write without advancing this counter.
See [Assert on a short-lived run](#assert-on-a-short-lived-run) for the shape a
test needs because of that.

A nonzero `droppedLogRecords` with a healthy journal usually means the capacity
is too small for the run's log volume. See
[Read the runtime metrics](./read-runtime-metrics.md) for how to read the
counter.

## Assert on a short-lived run

The forwarder exposes no drain barrier. `journal.flush` settles the entries the
journal has already admitted, so it returns while a record is still waiting in
the forwarder's queue or inside an admission the worker has not finished.
Closing the layer's scope then interrupts that worker and discards what is
left, so flushing before an assertion proves nothing about a record the journal
never saw.

Poll the journal for the records you expect while the layer's scope is still
open, and let the scope close after the assertion:

```ts
const forwarded = Effect.gen(function*() {
  const journal = yield* Journal.Journal
  yield* Effect.logInfo("first")
  yield* Effect.logInfo("second")
  for (let attempt = 0; attempt < 200; attempt++) {
    const page = yield* journal.entries({ runId, limit: 100 })
    const records = page.entries.filter((entry) => entry.eventType === "telemetry.log")
    if (records.length >= 2) return records
    yield* Effect.sleep("5 millis")
  }
  return []
}).pipe(
  Effect.provide(Layer.provideMerge(JournalLogger.layerJournalForwarding({ runId }), TestJournal.layer())),
  Effect.scoped
)
```

A bounded poll fails the assertion when a record never arrives, where a fixed
sleep only makes that failure intermittent. The same pattern is in
[Test telemetry without a collector](./testing.md), and the loss it guards
against is cataloged in [Troubleshooting](../troubleshooting.md).

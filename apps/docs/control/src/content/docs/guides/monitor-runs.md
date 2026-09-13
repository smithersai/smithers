---
title: "Monitor a run and heal it"
description: "Classify a run's health from durable evidence, beat over the control plane, and apply a bounded remedy: the seven healths, the two records a beat writes, and why autoHeal is empty by default."
sidebar:
  order: 10
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/control/docs/guides/monitor-runs.md"
---

A control plane answers "what is this run doing". `Monitor` answers the
question after it: is that all right, and if not, what now.

`classify` is pure, so the vocabulary an operator reads on a dashboard is the
one a heal loop branches on and the one a test can enumerate.

## Classify one observation

```ts
import * as Monitor from "@smthrs/control/Monitor"

Monitor.classify({
  summary,
  events, // the run's journal, oldest first
  beatsWithoutProgress: 3,
  stallBeats: 3
})
// "stalled"
```

The rules run in this order, and each earns its place by naming a different
response:

| Condition                                     | Health           | Because                                                               |
| --------------------------------------------- | ---------------- | --------------------------------------------------------------------- |
| No summary                                    | `unknown`        | Nothing to say, and nothing to do.                                    |
| `failed`                                      | `failing`        | The run itself reported the failure.                                  |
| `completed`, `cancelled`                      | `healthy`        | A finished run needs nothing.                                         |
| `waiting-approval`, or parked on `approval`   | `awaiting-human` | A human owes it an answer.                                            |
| Parked with no waiting reason                 | `awaiting-human` | Only an operator's own park writes no reason, so a person stopped it. |
| `roundOrdinal` at or past `roundBound`        | `runaway-loop`   | The lineage loops without converging.                                 |
| The last settled attempt failed               | `failing`        | The run is alive and its work is not landing.                         |
| No progress for `stallBeats`, an attempt open | `wedged-node`    | One attempt started and never settled.                                |
| No progress for `stallBeats`                  | `stalled`        | Nothing is happening and nothing is in flight.                        |
| Anything else                                 | `healthy`        | Entries are still arriving.                                           |

`awaiting-human` outranks `failing` on purpose. A run parked for approval after
a failed attempt is waiting for a person, and resuming or cancelling it would
take the decision away from them. A park with no reason is the same case: the
engine names every park it makes, so an unnamed one was an operator's, and
undoing a deliberate act is the worst thing an unattended loop can do.

Progress is measured from `flows.engine.attempt-started` and
`flows.engine.attempt-finished`, which the engine journals as a pair. An excess
of starts is an attempt still in flight. The classification reads durable
evidence only, never an in-process fiber, which is what lets a monitor watch a
run in another process.

`roundBound` defaults to 32 rounds.

## Beat over the control plane

`Monitor.run` requires `Control` and `Journal`, and nothing else. Its first
beat reads a finite snapshot. Later beats pass the last `event.cursor` as
`afterCursor` and fold only new events into an open-attempt count and the last
attempt outcome. Monitor beat and heal records advance the cursor but do not
count as progress. Providers that omit cursor metadata use `afterSequence`
after each completed snapshot. The loop retains no historical event array:

```ts
const report = yield * Monitor.run({
  runId: "run-17",
  monitorId: "oncall-supervisor",
  intervalMs: 5_000,
  maxChecks: 60,
  stallBeats: 3,
  autoHeal: ["stalled", "wedged-node"]
})
// { runId: "run-17", beats: [...], health: "healthy" }
```

| Option       | Default                                                |
| ------------ | ------------------------------------------------------ |
| `monitorId`  | `default`                                              |
| `intervalMs` | 1,000                                                  |
| `maxChecks`  | 10                                                     |
| `stallBeats` | 3                                                      |
| `roundBound` | 32                                                     |
| `autoHeal`   | none                                                   |
| `heal`       | `Control.resume` and `Control.cancel`, per `remedyFor` |

Each beat lists the run, replays its journal, classifies, and records
`control.monitor.beat` carrying the remedy it is about to attempt, _before_
applying it, so a monitor that crashes mid-heal leaves the evidence of what it
decided.

The remedy is a second record, `control.monitor.healed`, written only once the
heal returned an `Accepted` or `AlreadyApplied` receipt. A heal that failed,
was refused as a `Conflict`, or found the run already `Terminal` must not leave
a durable record saying the run was healed, and only an applied remedy resets
the stall evidence. A `Terminal` receipt ends the loop, because there is
nothing left to remedy.

Both records are excluded from the progress measurement. A monitor that counted
its own bookkeeping as progress could never observe a stall: the beat it wrote
at the top of the loop would be the new entry it congratulated the run for at
the bottom.

## Choose what it may do

`remedyFor` maps a health onto an action, and `autoHeal` decides which of those
the monitor may actually apply:

| Health                    | Remedy                                                   |
| ------------------------- | -------------------------------------------------------- |
| `stalled`, `wedged-node`  | `resume`: nobody is driving the run, so claim it.        |
| `failing`, `runaway-loop` | `cancel`: it will not get better by being driven harder. |
| everything else           | `none`                                                   |

`autoHeal` is empty by default, because a monitor that healed by default would
cancel a run the first time it looked at one.

A remedy resets the stall count, so one stall produces one resume rather than
one per beat.

## Two monitors on one run

Nothing on the control plane leases a run to one watcher. Two monitors both
beat and both remedy, so `monitorId` is what makes their evidence tellable
apart and their remedies distinct:

- Every record this monitor writes has source `/control/monitor/<monitorId>`
  and carries `monitorId` in its payload.
- The built-in remedies key on
  `monitor:<monitorId>:<remedy>:<runId>:<beat>`.

A remedy must be idempotent on the control plane. A custom `heal` owes the same
property:

```ts
const report = yield * Monitor.run({
  runId: "run-17",
  autoHeal: ["failing"],
  heal: ({ runId, health, beat }) =>
    control.cancel({
      runId,
      reason: `page-oncall:${health}`,
      idempotencyKey: `oncall:${runId}:${beat}`
    })
})
```

## Alert on what the monitor wrote

`Monitor.beatEventType` is a journal kind, so an alert policy in
[`@smthrs/notifications`](https://notifications.smithers.sh/reference/api/) can detect on it directly:

```ts
const rules = {
  defaults: { severity: "warning", owner: "oncall" },
  rules: { "wedged-node": { afterMs: 900_000, runbook: "https://runbook/wedged-runs" } },
  detectors: {
    "wedged-node": { field: "health", value: "wedged-node", eventTypes: [Monitor.beatEventType] }
  }
}
```

Narrowing the detector to the beat keeps the heal record, which names the same
health, from reopening a condition the next beat closed. The complete loop, with
two real durable runs, is
[`examples/src/38-monitor-and-alert.ts`](https://github.com/smithersai/smithers/blob/main/examples/src/38-monitor-and-alert.ts).

## Where to go next

- [Watch a run's events](/guides/watch-a-run/): the stream a beat reads.
- [Cancel a run, and restart one](/guides/cancel-and-resume/): the two default
  remedies.
- [Test against the control plane](/guides/testing/): classify is pure, so most of
  a monitor needs no stack at all.

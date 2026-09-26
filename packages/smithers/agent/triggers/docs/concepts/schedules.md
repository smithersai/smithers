---
title: "Cron schedules and occurrences"
description: "How @smthrs/triggers reads a cron expression: the satisfiability probe at declaration time, the occurrence instant an idempotency key is derived from, and the bounds every occurrence search runs under."
sidebar:
  order: 1
---

A schedule is a cron expression and an optional IANA timezone. Everything the
scheduler decides comes from answering one of three questions against it: what
is the next occurrence, what was the previous one, and which occurrences fall
in this interval. The `Cron` module is those three questions, and the care in it
is about two hazards that Effect's own cron leaves to the caller.

## An expression that parses is not an expression that happens

Effect's cron parser range-checks each field independently, so `0 0 30 2 *`
parses cleanly and then matches no date on any calendar. Its occurrence search
answers that by exhausting its bound and throwing, which inside `Effect.gen` is
a defect: the fiber dies instead of reporting.

`Cron.parse` closes both gaps. It reports a malformed expression as
`invalid_cron`, then probes for one occurrence forward from the current instant
and reports an exhausted search as `unsatisfiable_cron`:

```ts
import * as Cron from "@smthrs/triggers/Cron"
import * as Effect from "effect/Effect"

const nextNineAm = Effect.gen(function*() {
  const cron = yield* Cron.parse("0 9 * * *", "America/New_York")
  return yield* Cron.next(cron, new Date("2026-01-01T13:00:00.000Z"))
})
```

That probe is the same search every tick performs, so an expression that
survives parsing is one the scheduler can keep answering. It also moves the
refusal to where a person can act on it: `Trigger.make`, `Schedule.make`, and
`SqlTriggerStore.register` all run it, so `0 0 30 2 *` is refused at
declaration time rather than at the tick that would have fired it.

A parsed `Cron` keeps the expression text and the timezone beside the compiled
value, so a declaration round-trips through the store unchanged.

## The occurrence is the boundary, not the observation

`Cron.previousAtOrBefore` answers with the schedule boundary itself, with
milliseconds zeroed in UTC, even when the instant it was asked about carries a
sub-second offset:

```ts
import * as Cron from "@smthrs/triggers/Cron"
import * as Effect from "effect/Effect"

const boundary = Effect.gen(function*() {
  const cron = yield* Cron.parse("0 * * * *", "UTC")
  const observed = new Date("2026-01-01T01:00:00.457Z")
  return yield* Cron.previousAtOrBefore(cron, observed)
  // 2026-01-01T01:00:00.000Z
})
```

This is what makes an occurrence an identity rather than a timestamp. The
scheduler derives a launch's idempotency key from it, so two hosts that poll
the same boundary a few hundred milliseconds apart derive the same key and the
control plane sees one launch.

## Daylight saving moves the instant, not the wall clock

A timezone makes the expression a wall-clock schedule. `0 9 * * 5` in
`America/New_York` fires at 09:00 local every Friday: 14:00 UTC in winter,
13:00 UTC in summer. Day-of-week and day-of-month are read in the zone, so a
Friday 19:30 in New York stays a Friday even when it is Saturday in UTC.

| Wall time                       | Fires                                                                                   |
| ------------------------------- | --------------------------------------------------------------------------------------- |
| Skipped by spring forward       | Once, at the instant it would have had on the old offset: a daily 02:30 fires at 03:30. |
| Repeated by fall back           | Once, at its first instant. The second 01:30 is not an occurrence.                      |
| Repeated, hour field every hour | In both passes, so `30 * * * *` fires every elapsed hour and never stalls.              |

Occurrences are whole seconds in UTC, whatever the host's zone. A schedule
with no timezone follows the host's zone by the same rules.

## Every search runs under a bound

A satisfiable expression carries the opposite hazard from an unsatisfiable one.
`* * * * *` across a year is 525,600 occurrences, and materializing them costs
seconds and hundreds of megabytes.

`Cron.occurrencesBetween` returns the occurrences in `(from, to]`, in order, and
never searches unbounded:

```ts
import * as Cron from "@smthrs/triggers/Cron"
import * as Effect from "effect/Effect"

const window = Effect.gen(function*() {
  const cron = yield* Cron.parse("0 * * * *", "UTC")
  return yield* Cron.occurrencesBetween(
    cron,
    new Date("2026-01-01T00:00:00.000Z"),
    new Date("2026-01-01T02:00:00.000Z")
  )
  // [ 2026-01-01T01:00:00.000Z, 2026-01-01T02:00:00.000Z ]
})
```

Note that `from` is exclusive and `to` is inclusive. The interval above holds
two occurrences, not three.

The `limit` parameter decides which of two behaviors you get:

| Call                                        | Behavior                                                                                                     |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `occurrencesBetween(cron, from, to)`        | Fails with `catch_up_bound_exceeded` when the interval holds more than `Cron.maxOccurrences`, which is 1000. |
| `occurrencesBetween(cron, from, to, limit)` | Caps the result at `limit` silently. `limit` must be a non-negative safe integer, and 0 returns nothing.     |

A caller with a bound of its own passes one more than that bound and compares
the length, which is how `CatchUp.occurrences` tells "exactly at the bound" from
"over it". A `limit` that is not a count, such as `NaN` or `-1`, is refused with
`invalid_options` and `path: "limit"` rather than treated as "no limit".

`Schedule.maxCatchUpLimit` is the same 1000. A schedule may not owe more
occurrences than one search returns, so the declaration ceiling is the search's
own cap.

## Where this shows up

- A declaration is validated by `Schedule.validate`, which is the satisfiability
  probe applied to anything carrying `cron` and `timezone`.
- The scheduler calls `Cron.previousAtOrBefore` once per tick per trigger to
  find the current boundary, and `CatchUp.occurrences` to find the backlog
  behind it. See [Overlap and catch-up](./policies.md).

For the exact signatures, see the [API reference](../api.md).

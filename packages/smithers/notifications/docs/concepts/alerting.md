---
title: "How alerting decides"
description: "Why an alert is a function of journal time rather than wall time, how a detector opens and closes a condition, and why delivery is at-least-once rather than exactly-once."
sidebar:
  order: 3
---

The queue answers "tell this run something". An alert answers the question
nobody is around to ask: a run has been waiting an hour for an approval, and the
person who could grant it does not know.

The two are the same machinery. An alert is admitted as a coalesced system event
on the same durable queue, under the same idempotency and the same bound. They
differ only in who decides to write one.

## A condition is a payload field with a value

`Alerts.Detector` names a payload key, the value that means the condition holds,
and optionally the event types worth consulting at all:

```ts
import { Alerts } from "@smthrs/notifications"

const detector: Alerts.Detector = { field: "status", value: "waiting-approval" }
```

An entry that carries the field with the matching value **opens** the condition,
if it is not open already. An entry that carries the field with any other value
**closes** it. That symmetry is why a resume clears an approval alert without a
second vocabulary for "cleared": the run's next status entry says something
else, and the condition is gone.

An entry that does not carry the field at all is ignored entirely, which is what
stops a health report from closing an approval wait. `eventTypes` narrows
further, for a field two different producers write under different meanings. An
item ending in `.*`, such as `control.*`, names every event type with that
prefix.

`Alerts.defaultDetectors` ships four conditions, each of them one field and one
value: `waiting-approval` and `failed` read `status`, `stalled` reads `health`,
and `quota-parked` reads `waitingReason` for `quota`. Those are the fields
[`@smthrs/control`](/api/control) writes, and each default consults only the
`control.*` event types: a flow step or agent trace that writes a `status` field
into the same run's journal neither opens nor closes a default condition. A policy's own `detectors` are merged
over them, so a deployment that journals a different vocabulary names its own
rather than forking the module.

Only a condition the policy has a rule for is watched at all, and only own
properties count: a detector named `toString` reads no evidence off
`Object.prototype`.

## A probe is a condition a step reports

The four default conditions are things the control plane says about a run. A
probe is a check a flow step makes about anything else, and `Alerts.report`
journals what it saw into the run that owns the problem. Each probe writes
under its own event type, `flows.alerts.probe.<name>`, with a `state` of
`failing` or `ok`, and `Alerts.probes` builds the detector that reads it. So a
probe is one more condition: the first failing report opens it, later failing
reports leave its clock alone, and an `ok` report closes it.

A detector may also name a `summary` field. The string under that key on the
entry that **opened** the condition rides on the alert, cut to
`Alerts.maxSummaryLength` characters. Later entries never change it, so the
alert stays byte-identical on every attempt.

## Journal time, not wall time

A condition's clock starts at `emittedAtMs` of the entry that opened it.
`Alerts.decide(policy, open, now)` compares that against the rule's `afterMs`,
and the alert it produces is stamped `firedAt: since + afterMs`.

`now` decides **whether** an alert is raised. It never appears in one. The same
journal therefore raises the same alerts in any process, at any instant past the
delay, and a tick that runs an hour late produces the byte-identical alert the
on-time tick would have.

That is not a stylistic choice. Retries re-admit the same alert id, and the
queue refuses a reused id whose content changed. An alert stamped with the
reading time would become permanently undeliverable the moment one tick was
refused and time moved on.

The policy is the one input that is not journal time. When an operator changes a
rule's severity, owner, runbook, or delay between a refused page and its retry,
the queue keeps the alert it first admitted, and the retry still pages, with the
fields of the policy now in force.

## The delay is the policy

`Alerts.Rule.afterMs` is how long a condition must last before it is worth
paging about. Most stalls clear themselves, and a policy that fired immediately
would page on every one of them. `afterMs` is a whole, non-negative number of
milliseconds, checked by the schema when `Alerts.layer` builds, so an impossible
delay fails the composition by name instead of mis-paging at 3am.

## Delivery is at-least-once

One tick, for each alert past its delay that has not already been delivered:

1. Admits the alert to the notification queue as a coalesced system event.
2. Calls `Alerts.SinkService.deliver`.
3. Journals `flows.alerts.delivered` once the sink accepted it.

The order is deliberate. Admission is idempotent, so a crash between steps 1 and
2 costs a duplicate admission the queue drops. Recording the delivery before the
send would turn a crash into a page nobody ever receives, which for an alert is
the worse failure.

The cost of that choice is a duplicate page: a process that dies between an
accepted send and the delivery record pages again on the next tick. So the sink
owns the last mile. `deliver` must be idempotent on `Alerts.alertId(alert)`,
which is `alert:<coalescingKey>:<since>` and stable for the life of one
condition. A condition that clears and re-opens gets a new id, because the second
approval wait is not the first one.

## Acknowledged, or paged again

An alert pages once. A rule with `repeatMs` pages again for every whole period
the condition has stayed open past its delay. Each repeat is an alert of its
own: its `reminder` counts the periods, its `firedAt` is the journal instant
that repeat came due, and its id ends in `:r<n>`, so a sink that dedupes on the
id still sends it. A tick that runs late sends the latest repeat only.

`acknowledge(runId, alertId, by)` journals `flows.alerts.acknowledged` for an
open condition, and from then on a tick neither pages nor repeats that alert.
The id is the alert's without a repeat's ending. The first acknowledgement
stands, and a condition that clears and re-opens is a new alert nobody has
acknowledged. `standing(runId)` lists every open condition past its delay as
`raised`, `delivered` or `acknowledged`.

## Four outcomes, and only one is a failure

`Alerts.Tick` sorts every alert the tick considered:

| Field        | What it means                                                        |
| ------------ | -------------------------------------------------------------------- |
| `delivered`  | The sink accepted the page, and `flows.alerts.delivered` records it. |
| `suppressed` | This page was already delivered, or the alert is acknowledged.       |
| `failed`     | The sink refused or could not be reached. Retried on the next tick.  |
| `refused`    | The notification queue was at capacity. The sink was not called.     |

A refused page is not a delivered page, so it is retried. A refusal from the
queue pages nobody at all: the alert has nowhere durable to sit, and paging
about something the run will never read would send an operator looking in the
wrong place.

Both non-delivery outcomes journal `flows.alerts.failed`, one record per alert
per failure code, never one per tick. A webhook that stays down for an hour
leaves one row rather than a hundred and twenty every later tick has to read
past.

## The alerter never reads its own records

`flows.alerts.delivered`, `flows.alerts.failed` and `flows.alerts.acknowledged`
are written into the same journal the detectors read. The first two carry the alert's own vocabulary: a refusal
reports the answering HTTP `status`, which a detector watching the run's
`status` would read as the condition clearing. So all three event types are excluded
from condition detection outright. Without that exclusion, a page would close the
condition it paged about, the next tick would re-open it, and a webhook that
answered 503 once would alert forever.

A delivery record suppresses a repeat page only under the source the alerter
writes it with, `/notifications/alerts/<alertId>/delivered`, and an
acknowledgement counts only under `/notifications/alerts/<alertId>/acknowledged`. Another producer's
record naming the same `alertId` under its own source is ignored. The journal
does not bind a source to a writer, so this scopes records; it does not
authenticate the writer.

## Next

- [Alert on a stuck run](../guides/alert-on-a-stuck-run.md): a policy, a tick,
  and what each field of the result means.
- [Send alerts to a webhook](../guides/send-alerts-to-a-webhook.md): the shipped
  sink, its idempotency header, and its timeout.
- [Raise an alert from a flow step](../guides/raise-an-alert-from-a-step.md):
  probe reports, a page on Telegram, and acknowledgement.

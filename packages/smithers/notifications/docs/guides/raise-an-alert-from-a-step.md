---
title: "Raise an alert from a flow step"
description: "Report a probe result from a step, page a person once on Telegram or by email however often the probe fails, repeat the page until somebody acknowledges it, and list what is still open."
sidebar:
  order: 9
---

A probe is a check a step makes about something outside the run: a site that
lags its source, a disk that is nearly full, a deploy that failed. The step
reports what it saw, and the alert runtime pages a person once, however many
times the probe fails.

## Report what the probe saw

Call `Alerts.report` from the step, with the run that owns the problem:

```ts
import { Alerts } from "@smthrs/notifications"
import * as Effect from "effect/Effect"

export const reportFreshness = (ownerRunId: string, minutesBehind: number) =>
  Alerts.report({
    runId: ownerRunId,
    probe: "site-freshness",
    state: minutesBehind > 60 ? "failing" : "ok",
    summary: `site lags main by ${minutesBehind} minutes`
  })
```

`runId` is the run whose inbox the alert lands in. It need not be the run the
step belongs to. A scheduled probe starts a new run on every occurrence, and
reporting into one owning run is what makes its repeated failures one condition
instead of one alert per occurrence.

The first `failing` report opens the condition. Later `failing` reports leave
its clock and its summary alone, and an `ok` report closes it. A step that
retries may report twice: the second report changes nothing. `summary` is the
line a person reads in the page; the first 500 characters are kept.

## Name the probes in the policy

`Alerts.probes` builds the rules and detectors for a set of probes. The
condition an alert names is the probe's name:

```ts
import { Alerts } from "@smthrs/notifications"

export const policy: Alerts.Policy = {
  defaults: { owner: "oncall", runbook: "https://runbook.example/site" },
  ...Alerts.probes({
    "site-freshness": { afterMs: 0, repeatMs: 3_600_000, severity: "critical" },
    "disk-space": { afterMs: 600_000 }
  })
}
```

`afterMs: 0` pages on the first failing report. A probe that fails for a moment
and recovers is better served by a delay: `disk-space` pages only when it has
been failing for ten minutes.

A policy that also watches run conditions spreads `Alerts.probes(...)` into its
own `rules` and `detectors`.

## Page a person

`Alerts.layerChannels` is the sink that sends each alert as one message through
[`Channels`](./send-by-email-and-telegram.md):

```ts
import { Alerts, Channels, NotificationQueue } from "@smthrs/notifications"
import { Config, Effect } from "effect"
import * as Layer from "effect/Layer"

export const alerting = Effect.gen(function*() {
  const token = yield* Config.Redacted("ALERT_TELEGRAM_BOT_TOKEN")
  const chatId = yield* Config.String("ALERT_TELEGRAM_CHAT_ID")
  return Alerts.layer(policy).pipe(
    Layer.provideMerge(Layer.mergeAll(
      NotificationQueue.layer,
      Alerts.layerChannels({ destination: { _tag: "telegram", chatId } }).pipe(
        Layer.provide(Channels.layer({ telegram: { token } }))
      )
    ))
  )
})
```

The message's subject is the severity and the probe, and its text is the
summary, the run, when the condition opened, the owner, the runbook, and the
alert's id:

```text
[critical] site-freshness

site lags main by 979 minutes
Run: lane-site
Since: 2026-11-10T09:12:00.000Z
Owner: oncall
Runbook: https://runbook.example/site
Alert: alert:lane-site:site-freshness:1794215520000
```

Tick the owning run after the report, in the same step or on a schedule:

```ts
import { Alerts } from "@smthrs/notifications"
import * as Effect from "effect/Effect"

export const page = (ownerRunId: string) => Effect.flatMap(Alerts.AlertRuntime, (alerts) => alerts.tick(ownerRunId))
```

The tick admits the alert to the owning run's notification queue, sends the
message, and journals the delivery. A channel that fails comes back in
`tick.failed` and is sent on the next tick. Telegram takes no idempotency key,
so a process that dies between an accepted send and the delivery record sends
the same message again.

## Acknowledge it

An alert pages once. A rule with `repeatMs` pages again every period while the
probe keeps failing, with `(reminder 2)` in the subject, until a person takes
it:

```ts
import { Alerts } from "@smthrs/notifications"
import * as Effect from "effect/Effect"

export const take = (ownerRunId: string, alertId: string, person: string) =>
  Effect.flatMap(Alerts.AlertRuntime, (alerts) => alerts.acknowledge(ownerRunId, alertId, person))
```

`alertId` is the `Alert:` line of the message. `acknowledge` answers `true` once
the acknowledgement is journaled, and `false` when the run has no open condition
with that id, which is the case after the probe reported `ok`. An acknowledged
alert is neither paged nor repeated. A probe that recovers and fails again
raises a new alert with a new id, and nobody has acknowledged that one.

## List what is open

`standing` answers what a run has open now and who took it:

```ts
import { Alerts } from "@smthrs/notifications"
import * as Effect from "effect/Effect"

export const open = (ownerRunId: string) =>
  Effect.map(
    Effect.flatMap(Alerts.AlertRuntime, (alerts) => alerts.standing(ownerRunId)),
    (list) => list.map((item) => `${item.alert.condition}: ${item.state} ${item.acknowledgedBy ?? ""}`)
  )
// ["site-freshness: acknowledged will"]
```

| `state`        | Meaning                                                     |
| -------------- | ----------------------------------------------------------- |
| `raised`       | Past its delay. No sink has taken it yet.                   |
| `delivered`    | At least one page reached the sink. Nobody has taken it.    |
| `acknowledged` | A person took it. `acknowledgedBy` names the first who did. |

## Next

- [How alerting decides](../concepts/alerting.md): why the page names the first
  failure's time, and why delivery is at-least-once.
- [Send by email and Telegram](./send-by-email-and-telegram.md): the providers
  behind `Alerts.layerChannels`.
- [Page a person from a shell probe](../../../docs/guides/page-a-person-from-a-probe.md):
  the same report from a shell script or a cron job, with `smthrs alerts`.

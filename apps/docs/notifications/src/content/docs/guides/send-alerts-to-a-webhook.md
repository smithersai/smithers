---
title: "Send alerts to a webhook"
description: "Point the shipped webhook sink at an endpoint, set its headers and timeout, read the failure codes it reports, and write your own sink when the endpoint is not HTTP."
sidebar:
  order: 6
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/notifications/docs/guides/send-alerts-to-a-webhook.md"
---

`Alerts.layerWebhook` POSTs each alert to one endpoint. It is the shipped
implementation of `Alerts.Sink`. It constructs its own Fetch HTTP client.

## Point it at an endpoint

```ts
import { Alerts, NotificationQueue } from "@smthrs/notifications"
import * as Duration from "effect/Duration"
import * as Layer from "effect/Layer"

const sink = (token: string) =>
  Alerts.layerWebhook({
    url: "https://pager.example/alerts",
    headers: { authorization: `Bearer ${token}` },
    timeout: Duration.seconds(5)
  })

export const alerting = (policy: Alerts.Policy, token: string) =>
  Alerts.layer(policy).pipe(
    Layer.provideMerge(Layer.mergeAll(NotificationQueue.layer, sink(token)))
  )
```

`headers` is merged into every request. `timeout` defaults to
`Alerts.defaultWebhookTimeout`, ten seconds. An endpoint that never answers is a
failure at that bound, because a hung page is indistinguishable from silence and
waiting on one forever is not an option a pager may take.

`url` must be an absolute `http:` or `https:` url. It is checked when the layer
is built, so a `file:` or `javascript:` endpoint is a defect that fails the
composition with `sink_misconfigured` rather than a delivery failure at 3am. The
error names no url, because the value can carry basic-auth credentials.

The sink uses the platform's `fetch` and forces `redirect: "manual"`. A 3xx
response fails with `sink_rejected`; credentials and alert bodies are never
forwarded to the redirect target. Injected `HttpClient` layers, including clients
wrapped with `HttpClient.followRedirects`, are not used. Fetch defaults can be
set with `FetchHttpClient.RequestInit`; the sink overrides its redirect mode.
A custom `FetchHttpClient.Fetch` must honor the Fetch redirect and abort contracts.

Each delivery has its own scope. Completion, refusal, timeout, and interruption
abort the request and release any unread response body. Delivery depends on the
response status, so a body that never ends does not delay completion.

## What the request looks like

The body is the alert plus its `alertId`, and the same id is sent as an
`Idempotency-Key` header:

```text
POST /alerts HTTP/1.1
authorization: Bearer ...
idempotency-key: alert:run-1:waiting-approval:1700000000000
content-type: application/json

{
  "runId": "run-1",
  "condition": "waiting-approval",
  "since": 1700000000000,
  "firedAt": 1700000900000,
  "severity": "warning",
  "coalescingKey": "run-1:waiting-approval",
  "owner": "oncall",
  "runbook": "https://runbook.example/approvals",
  "alertId": "alert:run-1:waiting-approval:1700000000000"
}
```

The header is set after your headers, so it is always the one this sink sends.
The receiver must deduplicate on it: delivery is at-least-once, and every field
of the alert is derived from the journal, so the same alert is byte-identical on
every attempt. See [How alerting decides](/concepts/alerting/).

## Read the failure

Any non-2xx answer is a failure, not a delivery. `Alerts.AlertError.code` is the
stable half:

| Code               | What happened                                | `status`    |
| ------------------ | -------------------------------------------- | ----------- |
| `sink_rejected`    | The endpoint answered, and refused the page. | The answer. |
| `sink_unreachable` | The request never got an answer.             | Absent.     |
| `sink_timeout`     | No answer arrived inside the sink's bound.   | Absent.     |

`sink_misconfigured` is the fourth code and never appears here: it is raised
while the layer is built, before any alert exists. See
[Point it at an endpoint](#point-it-at-an-endpoint).

A failure is journaled as `Alerts.failedEventType`, one record per alert per
code, and the alert is retried on the next tick. The error carries the answering
status and a short `reason`, and never the request: a webhook request holds the
credential you handed `layerWebhook`, and an error is logged, encoded, and
journaled in places a credential must never reach.

## Write your own sink

`Alerts.Sink` is an ordinary service with one method, so an endpoint that is not
HTTP is a layer of your own:

```ts
import { Alerts } from "@smthrs/notifications"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"

export const consoleSink: Layer.Layer<Alerts.Sink> = Layer.succeed(Alerts.Sink)({
  deliver: (alert) =>
    alert.owner === undefined
      ? Effect.fail(new Alerts.AlertError({ code: "sink_rejected", message: "the alert names no owner to page" }))
      : Effect.log(`[${alert.severity}] ${alert.runId} ${alert.condition} -> ${alert.owner}`)
})
```

Two obligations come with the port:

- **Deduplicate on `Alerts.alertId(alert)`.** It is stable for the life of one
  condition and reaches the sink on every attempt. A sink that cannot deduplicate
  will occasionally page twice about one condition.
- **Fail when the page did not go out.** Succeeding on a dropped page is the one
  thing this port must never do: the delivery record would be written and the
  alert would never be raised again.

`Alerts.layerNoop` is the deliberate absence: it accepts every alert, sends
nothing, and still leaves the durable evidence.

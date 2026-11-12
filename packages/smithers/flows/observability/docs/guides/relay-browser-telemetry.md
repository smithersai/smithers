---
title: "Relay browser telemetry through your own Worker"
description: "Receive a browser's OTLP exports on your own server route with OtlpRelay.serve and re-emit each log record, span and metric data point as a structured Effect log line."
sidebar:
  order: 7
---

A browser cannot hold collector credentials, and a second telemetry backend for
one app is one more thing to run. `OtlpRelay.serve` lets your own server receive
the browser's exports instead: each log record, span and metric data point
becomes one `Effect.log` line on the server's loggers, so the server's log store
holds browser and server telemetry together.

## Export from the browser to your own origin

```ts
import { Otlp } from "@smthrs/observability"

const Telemetry = Otlp.layerFetch({
  baseUrl: `${location.origin}/api/telemetry`,
  serviceName: "web"
})
```

The exporter posts OTLP JSON to `/api/telemetry/v1/logs`, `/v1/traces` and
`/v1/metrics`.

## Serve the relay from a Worker

`serve` is an `effect/http` handler. It reads the `HttpServerRequest` and
answers any path that ends in `/v1/logs`, `/v1/traces` or `/v1/metrics`, so
mount it under whatever prefix the browser posts to:

```ts
import { OtlpRelay } from "@smthrs/observability"
import * as Effect from "effect/Effect"
import * as HttpServerRequest from "effect/http/HttpServerRequest"
import * as HttpServerResponse from "effect/http/HttpServerResponse"

const telemetry = OtlpRelay.serve()

export const fetch = Effect.gen(function*() {
  const request = yield* HttpServerRequest.HttpServerRequest
  if (request.url.startsWith("/api/telemetry/")) return yield* telemetry
  return HttpServerResponse.empty({ status: 404 })
})
```

The module imports `effect` and the journal's redaction rules
(`@smthrs/journal`), and no `node:` built-in, so it runs in a Cloudflare
Worker, Node, Bun or Deno. On Cloudflare, Workers Logs stores each relayed line with its
annotations as fields.

## What each line carries

The message is the log record's body, the span's name or the metric's name.
The level follows the record's OTLP severity (`OtlpRelay.severityLevel`); an
errored span logs at `Error`, other spans and metric points at `Info`.

| Annotation                                  | Present on                                |
| ------------------------------------------- | ----------------------------------------- |
| `otlp.signal`                               | every line: `logs`, `traces` or `metrics` |
| `service.name`                              | every line whose resource names a service |
| the record's attributes, nested keys dotted | every line                                |
| `otlp.severity`                             | log records                               |
| `trace_id`, `span_id`                       | log records inside a span, and spans      |
| `otlp.parent_span_id`, `otlp.duration_ms`   | spans                                     |
| `otlp.status_message`                       | errored spans                             |
| `otlp.metric_type`, `otlp.unit`             | metric points                             |
| `otlp.value`                                | sum and gauge points                      |
| `otlp.count`, `otlp.sum`                    | histogram and summary points              |

Join browser and server lines on `trace_id`, or on any attribute both sides
annotate, such as a request or answer id.

## Relay only what you name

The browser chooses every record name, attribute and resource field it sends.
To keep content out of the server's logs, name the records and fields the
relay may pass:

```ts
OtlpRelay.serve({
  allow: {
    records: ["chat ready", "question asked", "chat.ask"],
    fields: ["otlp.signal", "service.name", "trace_id", "span_id", "answerId"]
  }
})
```

- `records` names log bodies, span names and metric names. A record it does
  not name is dropped and counted. A log record whose body is not a string
  never matches.
- `fields` names the keys a relayed line keeps, the relay's own included. List
  `otlp.signal`, `trace_id` and the rest of the table above that you want.
  Every other field is removed.

A program that records many spans the relay drops, such as a durable engine's
storage spans, can send them only to have them dropped, and its exports can
pass `maxBodyBytes`. Give its exporter the same names with `spans`, so it sends
only the spans the relay keeps:

```ts
const allow = { records: ["chat.ask", "question asked"], fields: ["otlp.signal", "trace_id"] }

Otlp.layerFetch({ baseUrl: "https://app.example/api/telemetry", spans: allow.records })
```

## Limits and refusals

```ts
OtlpRelay.serve({
  maxBodyBytes: 256 * 1024, // default; counted while the body streams
  maxRecords: 1000 // default; the rest are dropped and counted
})
```

- A body past `maxBodyBytes` gets 413, even when it is chunked with no length.
- A body that is not OTLP JSON, or nests deeper than `OtlpRelay.maxNesting`,
  gets 400 with no echo of the parse error.
- A metric point whose value or sum is not a finite number (OTLP/JSON writes it
  as `"NaN"`, `"Infinity"` or `"-Infinity"`; an exporter that leaves it to JSON
  writes `null`) is relayed without that field; the rest of the request is
  relayed as usual.
- Another method gets 405 with `Allow: POST`; another path gets 404.
- Records off the allowlist or past `maxRecords` are dropped; the 200 answer
  carries an OTLP `partialSuccess` with the count.

With or without an allowlist, a key `Redaction.isSensitiveKey` names a
credential, such as `password` or `user.api_key`, is removed with any keys
nested under it. The finished line then passes `Redaction.redact`: its message
and every field, the ones the relay adds such as `service.name` and
`otlp.status_message` included, so a bearer token quoted in a browser log or a
span's status reaches the server's logs as `[REDACTED_TOKEN]`.

`flows_observability_otlp_relayed` counts records per `signal`, and
`flows_observability_otlp_relay_dropped` per `signal` and `reason`
(`not_allowed` or `over_limit`).

## Next steps

- [Export to an OTLP collector](./export-to-a-collector.md): the sending half.
- [Test telemetry without a collector](./testing.md): drive the exporter into
  a handler in a test.

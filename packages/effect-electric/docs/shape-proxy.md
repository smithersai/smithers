---
title: "Proxy Electric shapes through your server"
description: "Serve a browser's Electric shape requests from your own route with ShapeProxy.make: a host-chosen table, a parameter allowlist that drops subset requests, Electric's secret added on the server, and one log line per request."
---

A browser that syncs with Electric should not call Electric directly. Electric's
URL and secret would reach the browser, and the browser would choose which
table, rows and columns it reads. `ShapeProxy.make` puts your server in between:
the browser sends Electric's own shape requests to your route, and the proxy
forwards what the protocol needs, with the shape and credentials your server
chose.

## Mount it

`make` returns an `effect/http` handler for one shape. It requires the
`HttpServerRequest` it answers and an `HttpClient` to call Electric with:

```ts
import { ShapeProxy } from "@smthrs/effect-electric"
import * as Effect from "effect/Effect"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import * as HttpEffect from "effect/http/HttpEffect"

const program = Effect.gen(function*() {
  const connection = yield* ShapeProxy.config({ url: "http://localhost:30001" })
  return HttpEffect.toWebHandler(
    ShapeProxy.make({ ...connection, shape: { table: "items" } }).pipe(Effect.provide(FetchHttpClient.layer))
  )
})
```

Point the client's shape URL at the route that serves the handler, for example
`GET /api/shapes/items`.

`ShapeProxy.config` reads four variables with Effect `Config`:

| Variable             | Use                                                                                                     |
| -------------------- | ------------------------------------------------------------------------------------------------------- |
| `ELECTRIC_URL`       | Electric's origin. The proxy calls its `/v1/shape`. Required unless you pass `url` as the default.      |
| `ELECTRIC_SECRET`    | Electric's secret, read as a redacted value and sent as `secret`. Optional.                             |
| `ELECTRIC_SECRET_AS` | How the secret is sent: `parameter` (the default) or `bearer`. Optional. See [The secret](#the-secret). |
| `ELECTRIC_SOURCE_ID` | Electric Cloud's source id, sent as `source_id`. Optional.                                              |

You can also pass `url`, `secret` (a `Redacted` string), `secretAs` and
`sourceId` to `make` directly.

## Decide the shape per request

`shape` can be an Effect that decides the shape for each request, for example
from the session, after the method check and before Electric is called. Its
requirements become the handler's. When it can't decide, it fails with
`ShapeProxy.Refused`, and the proxy answers that status without calling
Electric:

```ts
const messages = ShapeProxy.make({
  ...connection,
  shape: Effect.gen(function*() {
    const person = yield* whoIsAsking.pipe(
      Effect.mapError(() => new ShapeProxy.Refused({ status: 503, retryAfter: 5 }))
    )
    return { table: "messages", where: "owner = $1", params: { "1": person.id } }
  })
})
```

| `Refused` status | When                                                    |
| ---------------- | ------------------------------------------------------- |
| `401`            | Signed out                                              |
| `403`            | Not allowed                                             |
| `503`            | The host can't tell right now, for example its sessions |

A refusal carries `cache-control: private, no-store`, and `retry-after` when
`retryAfter` (seconds) is set. Refuse rather than serve a narrower shape under
the same URL: a device holds the shape's `handle` and `offset`, and a `where`
or `params` that changes under them makes Electric answer
`409 must-refetch`, which empties the device's copy. An Electric collection
keeps its rows on a refusal: it retries a `503` under its sync policy and stops
on a `401` or `403`.

## What reaches Electric

The proxy builds every upstream request itself from:

1. The Electric client's protocol parameters, the first value of each:
   `offset`, `handle`, `live`, `live_sse`, `experimental_live_sse`, `cursor`,
   `expired_handle`, `log` and `cache-buster`.
2. The host's shape: `table`, `where` and its `params` when `shape` sets them,
   as `params[1]`, `params[2]` and so on, and `columns`, comma-separated, when
   `shape` lists them.
3. `secret` and `source_id`, when the connection has them; `secret` only when
   `secretAs` is `"parameter"`, the default.

The URL is canonical: its parameters are sorted by name and each value is
encoded once. Two requests for the same shape at the same `handle`, `offset`
and `cursor` send Electric the same URL, whatever order the browser sent its
parameters in, and two different shapes never send the same URL. A cache
between the proxy and Electric can key on that URL.

Every other parameter the browser sends is dropped, including `table`,
`where`, `params`, `columns`, `replica`, `secret`, `source_id` and every
subset request's `subset__*` (`subset__where`, `subset__params`,
`subset__order_by`, `subset__limit`, `subset__offset`, `subset__where_expr`,
`subset__order_by_expr`). A browser can follow the shape, but it can't change
it or read part of it: `ElectricCollection` syncs whole shapes and sends no
subset requests, and a client that sends one gets the whole shape.

Electric's status, headers and body stream back. `content-encoding` and
`content-length` are dropped, because `fetch` has already decoded the body, and
so is every `access-control-*` header, because the proxy serves the browser's
own origin.

## Call Electric another way

The proxy calls Electric with the request's `HttpClient`. When Electric is
reached some other way than the rest of your server's requests, for example
through a platform's private binding to a gateway in front of Electric,
provide that client as `ShapeProxy.Upstream`. The proxy calls it instead, and
every other request keeps your `HttpClient`:

```ts
import { ShapeProxy } from "@smthrs/effect-electric"
import * as Effect from "effect/Effect"
import type * as HttpClient from "effect/http/HttpClient"

declare const gateway: HttpClient.HttpClient

const handler = ShapeProxy.make({ url: "http://electric-gateway", shape: { table: "items" } }).pipe(
  Effect.provideService(ShapeProxy.Upstream, gateway)
)
```

## Caching

Electric marks a shape's responses cacheable: a first response says
`public, max-age=604800`. The browser's URL doesn't name the person, so when
your server builds `where` from the session, or serves the shape only after a
session check, a cached response answers the next person in that browser, or
anyone after sign-out. So by default (`cache: "no-store"`) the proxy drops
Electric's `cache-control`, `etag`, `surrogate-control`, `cdn-cache-control`
and `expires`, and every response it sends, a 405 or 502 included, says
`cache-control: private, no-store`.

Opt a shape in to Electric's own caching only when it is the same for everyone
and served without a session check:

```ts
ShapeProxy.make({ ...connection, shape: { table: "releases" }, cache: "public" })
```

Electric's protocol doesn't depend on a cache: a live request carries
`cursor` and a retry `cache-buster`, so a shape syncs and follows changes the
same either way. On the browser side, `ShapeSource.fetchSource` sends every
request with `cache: "no-store"`, so the HTTP cache never answers a shape
request, even one a server marked cacheable.

## The secret

Electric takes its secret only as the `secret` query parameter, so that is the
default. A URL is what platforms log and trace: Cloudflare's invocation logs
record a request's URL, and its traces record a subrequest's `url.full` and
`url.query`. When Electric sits behind your own gateway, set `secretAs:
"bearer"` (or `ELECTRIC_SECRET_AS=bearer`): the proxy sends
`authorization: Bearer <secret>` instead, which those records leave out, and
the gateway checks it in constant time and doesn't pass it on. The proxy's own
client span records the header redacted.

## Refusals

A request the proxy refuses never reaches Electric:

| Request                               | Status                      | Body |
| ------------------------------------- | --------------------------- | ---- |
| A method other than `GET`             | 405, with `allow: GET`      | none |
| A `shape` Effect that fails `Refused` | its status, 401, 403 or 503 | none |

When Electric can't be reached, the proxy answers 502. A defect while deciding access answers 500 and is recorded without its message. `Refused.upstream` identifies a failed host dependency (`database`); other refusals default to `access`. An abandoned access check records 499.

## What it records

The proxy records with plain Effect, so the host's own logger, tracer and
metric exporters pick up the records. None of them carries the secret, a where
clause or a parameter value.

- **Span.** One server span per request, named `name` (default
  `electric.shape`), with `http.response.status_code` and
  `electric.shape.live`, `route`, `upstream` and `correlationId`. The `HttpClient` adds its own client span for the call to
  Electric, with `secret=REDACTED` in `url.full`.
- **Log line.** One line per request, once its body has ended, with the message
  `name` and the annotations `route` (the fixed shape name), `upstream`, `correlationId`, `statusClass`, `status`, `live`, `durationMs`, `bytes` and
  `outcome`. `outcome` is `complete`, `aborted`
  (the browser went away: status 499 before Electric answered, else mid-body)
  or `failed` (Electric's body broke off). The level is Error for a 5xx or a
  failed body, Warn for another 4xx, and Info otherwise, an aborted request
  included.
- **Count.** One count on `metric`, by `status` and `live` as strings. The
  default is `ShapeProxy.defaultMetric`, `electric_shape_requests`. `ShapeProxy.responses`
  also counts every response as `electric_shape_responses{name,statusClass}`.

The proxy generates `correlationId` from its server span id and returns it as `x-request-id`; it never trusts a browser-supplied id. `upstream` identifies the boundary that answered: `electric`, `database` for a host-declared dependency failure, `access` for other access outcomes, or `proxy` for a method refusal. It does not guess which internal Electric dependency failed.

## Limits

- **A cached response is outside the proxy's reach.** A `"public"` shape's
  responses can be served by a browser or CDN without reaching your server, so
  a session check there doesn't apply to them.
- **The shape is the read boundary.** A browser reads the whole shape. To keep
  a browser to some rows, set `shape.where` and `shape.params` on the server;
  to keep a column on the server, list the others in `shape.columns`, the
  primary key included. A column added to the table later stays on the server
  until you list it.
- **Tested with `@electric-sql/client` 1.5.28 and Electric 1.8.1.**

Each completion record includes `phase` (`first`, `catch-up`, or `live`),
`bytes`, `durationMs`, and `outcome` (`complete`, `aborted`, or `failed`).
The response's `x-request-id` matches `correlationId` in that record. Preserve
it even when reading the response body fails; aggregate invocation success
cannot prove that a particular response reached the client. No protocol values
or row contents enter these records.

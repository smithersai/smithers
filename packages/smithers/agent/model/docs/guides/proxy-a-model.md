---
title: "Proxy a model"
description: "Serve a Model from a Cloudflare Worker, Node or Bun with ModelProxy.serve, and call it from a browser as a Model with ModelProxy.layerClient."
sidebar:
  order: 5
---

A browser must never hold a provider key, so it cannot call a provider route
itself. `ModelProxy` splits the call across HTTP instead. The host runs
`ModelProxy.serve`, which owns the key and decides, for each request, which
model answers it and with which system prompt, parameters and tools. The
browser, another Worker or a CLI provides `ModelProxy.layerClient`, a `Model`
whose `stream` posts the request and reads the events back. Code that calls
`model.stream(request)` does not change.

```text
browser                         host (Worker, Node, Bun)          provider
Model.stream ──POST ModelRequest──▶ ModelProxy.serve
  (layerClient)                       prepare: the host's policy
                                        and the Model that answers
                                      Model.stream ───────────────▶ route
             ◀──NDJSON ModelEvents── … then {"type":"end"}
                                      onEnd: usage, for metering
```

## Serve from a Cloudflare Worker

`ModelProxy.serve` is an Effect, not a request handler function: it reads the
current `HttpServerRequest` and answers an `HttpServerResponse`. Alchemy runs a
Worker's `fetch` Effect per request, so the handler drops in as is.
`HostModel.layerConfig` from `@smthrs/model-host` picks the host's model and
key from the Worker's bindings, and `prepare` hands it to the proxy:

```ts
import { ModelProxy, ModelRequest } from "@smthrs/model"
import { HostModel } from "@smthrs/model-host"
import * as Cloudflare from "alchemy/Cloudflare"
import { Effect } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/http"

// Used when the CHAT_MODEL binding is unset.
const DEFAULT_CHAT_MODEL = {
  protocol: "openai-chat",
  baseUrl: "https://api.cerebras.ai",
  modelId: "qwen-3.8-27b",
  credential: "CEREBRAS_API_KEY"
}

export default class ChatApi extends Cloudflare.Worker<ChatApi>()(
  "ChatApi",
  { main: "worker/ChatApi.ts", compatibility: { date: "2026-10-01", flags: ["enable_request_signal"] } },
  Effect.gen(function*() {
    const { model, modelId } = yield* HostModel
    const chat = ModelProxy.serve({
      prepare: (request) =>
        Effect.succeed({
          model,
          request: ModelRequest.ModelRequest.make({
            modelId,
            system: [ModelRequest.SystemPart.make({ text: "Answer briefly and plainly." })],
            messages: request.messages,
            tools: [],
            params: ModelRequest.GenerationParams.make({ reasoningEffort: "low" })
          })
        }),
      maxBodyBytes: 512 * 1024
    })

    return {
      fetch: Effect.gen(function*() {
        const request = yield* HttpServerRequest.HttpServerRequest
        if (request.url !== "/api/chat") return HttpServerResponse.empty({ status: 404 })
        return yield* chat
      })
    }
  }).pipe(Effect.provide(HostModel.layerConfig("CHAT_MODEL", DEFAULT_CHAT_MODEL)))
) {}
```

The `enable_request_signal` flag lets the Worker see a browser that goes away,
so a closed tab stops the provider call instead of paying for the rest of the
answer.

## Decide what the caller may choose

`prepare` runs on every decoded request before any model does. It returns the
request the model receives and the `Model` that answers it, so one endpoint can
serve several models, chosen per request. A browser must not choose the model,
system prompt, parameters or tools on the host's key, so `prepare` is required:
keep only the caller's fields you allow.

To refuse a request, fail with a `Refusal`. Its `status` and `message` reach
the client as written, and `code` is the `ModelError` code the client fails
with (the status picks one when omitted). `prepare` can read any service the
handler provides, such as the session of the person asking:

```ts
import { type Model, ModelProxy, ModelRequest } from "@smthrs/model"
import { Effect } from "effect"

const prepare = (signedIn: boolean, model: Model.Model) => (request: ModelRequest.ModelRequest) =>
  signedIn
    ? Effect.succeed({ model, request: ModelRequest.ModelRequest.make({ ...request, modelId: "qwen-3.8-27b" }) })
    : Effect.fail(new ModelProxy.Refusal({ status: 401, message: "Sign in to chat." }))
```

## Meter what each request spends

Three options record usage where the host knows what it means:

- `attributes` labels every server-side metric and the log line of the
  request, such as `{ role: "agent" }`. Keep them low-cardinality: never ids,
  prompt text or credentials.
- `prepare` receives an `Admission` beside the request: the caller's
  `requestId`, the server's `invocationId` for this call and the body's
  `requestBytes`. To bound spend, reserve the call's worst case here, before
  the model runs, and check the budget and reserve in one atomic step: a
  budget read before the call and written after it lets concurrent calls all
  pass the read. `requestBytes` bounds the prompt, because a byte-level
  tokenizer never yields more tokens than bytes; add the output cap you set.
  Lower `maxBodyBytes` to bound it further.
- `onEnd` runs once after an admitted request's model stream ends, with its
  `invocationId`, `requestId`, outcome (`success`, `failed` or
  `interrupted`), model id and the usage the model reported. Settle the
  reservation there, under the same `invocationId`. The terminal line waits
  for it, so the spend is recorded before the client reads the end, and
  before a Worker's invocation ends with the response. Once it starts it runs
  to its end, even when the client goes away meanwhile, so a settle is never
  cut off halfway. It never runs for a refused request, and it must handle its
  own errors. A response body that is never read never reaches `onEnd`, so a
  reservation it holds stays counted. Usage the model never reported is
  unknown, not zero: a call that failed or was interrupted may have spent
  tokens nobody reported, so keep its reservation rather than settle it to
  the usage you have. The exception is a clean refusal,
  `ModelProxy.refusedCleanly(end)`: the call failed before the model
  produced any output (`end.produced` is false), `rate_limited` or with a
  provider 4xx status (`end.errorCode`, `end.httpStatus`). It spent nothing
  beyond the usage reported, so settle it to that, 0 when none; otherwise a
  provider outage spends a day's budget on reservations while the provider
  spends nothing.
- Key spend on `invocationId`, which the server mints for every call it
  admits. `requestId` is the caller's: it may send one id on any number of
  calls, and each call still runs the model, so spend keyed on it counts only
  the first.

This sample caps output at 1,000 tokens: unset or nonfinite values use 1,000;
finite values are rounded down and clamped to [0, 1,000]. It reserves and
forwards the same cap. The in-memory map illustrates accounting only; enforce
a real budget with an atomic database reservation before admitting the call.

```ts
import { ModelProxy, ModelRequest } from "@smthrs/model"
import { Effect } from "effect"

const outputCap = (value: number | undefined): number =>
  value === undefined || !Number.isFinite(value) ? 1_000 : Math.max(0, Math.min(1_000, Math.floor(value)))

// Tokens reserved for calls in flight, by invocation id. A real host keeps them in its database.
const reserved = new Map<string, number>()

const served = ModelProxy.serve({
  prepare: (request, { invocationId, requestBytes }) =>
    Effect.sync(() => {
      const maxTokens = outputCap(request.params.maxTokens)
      // The worst case: every byte a prompt token, plus the enforced output cap.
      reserved.set(invocationId, requestBytes + maxTokens)
      return {
        model,
        request: ModelRequest.ModelRequest.make({
          ...request,
          params: ModelRequest.GenerationParams.make({ ...request.params, maxTokens })
        })
      }
    }),
  maxBodyBytes: 64 * 1024,
  attributes: { role: "agent" },
  onEnd: ({ invocationId, requestId, outcome, usage }) =>
    Effect.logInfo("usage").pipe(
      Effect.annotateLogs({
        invocationId,
        requestId,
        outcome,
        reserved: reserved.get(invocationId) ?? 0,
        tokens: usage.outputTokens ?? 0
      }),
      Effect.ensuring(Effect.sync(() => reserved.delete(invocationId)))
    )
})
```

## Run it on Node or Bun

The same Effect runs under any `effect/http` server. As a web handler, with
`model` any `Model` (a `Route.toModel` result, for one):

```ts
import { ModelProxy, ModelRequest } from "@smthrs/model"
import { Effect } from "effect"
import { HttpEffect } from "effect/http"

const handler = HttpEffect.toWebHandler(
  ModelProxy.serve({
    prepare: (request) =>
      Effect.succeed({ model, request: ModelRequest.ModelRequest.make({ ...request, modelId: "qwen-3.8-27b" }) })
  })
)
// Bun.serve({ fetch: handler }), or any server that takes (Request) => Promise<Response>.
```

## Call it from a browser

`ModelProxy.layerClient` provides `Model` over any Effect `HttpClient`. In a
browser, `FetchHttpClient` is the one, and a relative URL resolves against the
page:

```ts
import { Model, ModelProxy, ModelRequest } from "@smthrs/model"
import { Effect, Layer, Stream } from "effect"
import { FetchHttpClient } from "effect/http"

const ChatModel = ModelProxy.layerClient({ url: "/api/chat" }).pipe(Layer.provide(FetchHttpClient.layer))

const answer = (question: string) =>
  Effect.gen(function*() {
    const model = yield* Model.Model
    return model.stream(ModelRequest.ModelRequest.make({
      modelId: "host-chooses",
      system: [],
      messages: [ModelRequest.Message.user(question)],
      tools: [],
      params: ModelRequest.GenerationParams.make()
    }))
  }).pipe(
    Stream.unwrap,
    Stream.filter((event) => event.type === "text-delta"),
    Stream.map((event) => event.text),
    Stream.provide(ChatModel)
  )
```

The browser's `modelId` is a placeholder: the host's `prepare` replaces it.
Interrupting the fiber that runs the stream aborts the request, and the host's
model call stops with it.

## Make each call a durable step

A flow calls a model through `ModelStep.run` from `@smthrs/agent`, or an agent
seat, so a resumed run replays a sealed call instead of paying for it again.
Both key the step on a `route`: the credential-free form of the request.
`ModelProxy.prepare` is that form for a proxied model, the endpoint's URL and
the exact bytes the client sends, so hand it over beside the client's `Model`:

```ts
import { ModelStep } from "@smthrs/agent"
import { ModelProxy } from "@smthrs/model"

const url = "/api/model/agent"
const model = yield* ModelProxy.makeClient({ url })
const result = yield* ModelStep.run({ name: "chat/answer/model", request, model, route: { prepare: ModelProxy.prepare({ url }) } })
```

The client's `headers`, which may carry the host's own authorization, and its
per-call request id stay out of the key. `ModelProxy.prepare` refuses endpoint
URLs with embedded credentials or credential query parameters as
`invalid_request`; put authorization in headers. Relative URLs remain supported.

Every failure is a `ModelError`, so the code from
[Handle failures](./handle-failures.md) applies unchanged. Each one carries
the request id as `requestId`.

| What happened                                       | `code`                                                     | `httpStatus` |
| --------------------------------------------------- | ---------------------------------------------------------- | ------------ |
| The model failed after the stream started           | the model's own code; the message is a fixed safe headline | none         |
| The host refused the request                        | the `Refusal`'s code, or the status's                      | its status   |
| The body was not a `ModelRequest`, or was too large | `invalid_request`                                          | 400 or 413   |
| The host could not be reached, or the body broke    | `transport`                                                | none         |
| The body ended before its terminal line             | `transport`                                                | none         |
| A line the client could not decode                  | `invalid_provider_output`                                  | none         |
| The request could not be encoded                    | `invalid_request`                                          | none         |

The client limits each response line to 1 MiB of UTF-8 bytes, excluding the
newline. An oversized line fails `invalid_provider_output` and cancels the body,
including when the line never terminates. Error-line `retryAfterMillis` values
must be finite and nonnegative; invalid values fail `invalid_provider_output`.

## Observe it

Both halves record one span, three metrics and one log line per request,
joined by the request id and by trace context. The client sends a fresh id in
`x-smithers-request-id`; the server keeps it (or mints one if it is missing or
malformed) and echoes it in the response. The server also mints an invocation
id of its own for every call it admits, which the caller never chooses. Effect's `HttpClient` sends W3C
`traceparent`, so the browser's span, the host's spans and the provider call
share one trace:

```text
model.proxy.stream (client)
└─ POST (HttpClient)
   └─ http.server POST
      └─ model.proxy.serve
         └─ chat <model>   (Model.withGenAiSpan)
```

The `model.proxy.serve` and `model.proxy.stream` spans carry
`smithers.model.proxy.request_id`, `smithers.model.proxy.outcome`,
`http.response.status_code`, `error.type` (the `ModelError` code),
`smithers.model.proxy.events`, `smithers.model.proxy.duration_ms` and
`smithers.model.proxy.first_event_ms`; the server span adds
`smithers.model.proxy.invocation_id`, `gen_ai.request.model`,
`gen_ai.provider.name` and `smithers.model.proxy.request_bytes`.

| Metric                                | Kind      | Attributes                                                                |
| ------------------------------------- | --------- | ------------------------------------------------------------------------- |
| `smithers_model_proxy_requests`       | counter   | `side`, `outcome`, `status`, the host's `attributes`                      |
| `smithers_model_proxy_duration_ms`    | histogram | `side`, `outcome`, the host's `attributes`                                |
| `smithers_model_proxy_first_event_ms` | histogram | `side`, the host's `attributes`                                           |
| `smithers_model_tokens`               | counter   | `type` (`input`, `output`), `model`, the host's `attributes`; server only |

The host's `attributes` appear only on the server side. `outcome` is
`success`, `invalid` (bad method or body), `refused`, `failed` or
`interrupted`. The log line's message is the span name, and its level follows
the outcome: Info for `success` and `interrupted`, Warn for `invalid` and
`refused`, Error for `failed`. Its annotations are the host's `attributes`,
`requestId`, `traceId`, `side`, `outcome`, `status`, `durationMs`, `events`,
the server's `invocationId`, and when known `modelId`, `provider`, `errorCode`, `errorTag`,
`firstEventMs`, `requestBytes`, `inputTokens` and `outputTokens`. The
proxy's own names win over a host attribute of the same name.

No span, metric or log line carries prompt or response text, provider error
text, or credentials. The test suite proves it with a sentinel prompt that the
model echoes and fails on.

On a cross-origin deployment, the host must allow the `traceparent`, `b3` and
`x-smithers-request-id` request headers in its CORS preflight. A same-origin
route, such as a site Worker that forwards `/api/*`, needs nothing.

## The wire format

The request is `POST` with a JSON `ModelRequest` body, encoded by the
`ModelRequest` schema. A `200` response is `application/x-ndjson`: one
Schema-encoded `ModelEvent` per line, then exactly one terminal line.

```text
{"type":"text-start","id":"t"}
{"type":"text-delta","id":"t","text":"Hello"}
{"type":"text-end","id":"t"}
{"type":"settle","stopReason":"stop"}
{"type":"end"}
```

A model that fails after the headers were sent ends the stream with
`{"type":"error","code":"rate_limited","message":"Model usage limit reached","retryAfterMillis":1200}`
instead. A body that stops before either line was cut. Any other status
carries `{"code","message","requestId"}`. `ModelProxy.Line` and
`ModelProxy.ErrorBody` are the schemas.

A blank line is a keep-alive. A provider can reason for minutes without an
event while it keeps its connection open with keep-alive comments or pings.
The route runs `Model.Liveness` for each of those chunks, and `serve` writes a
blank line for it: at most one a second, and none within a second of an event.
The client runs `Model.Liveness` for every chunk of the body it reads, a blank
line included, and decodes no event from a blank line. A browser's
`ModelStep` therefore counts the provider's keep-alives as heartbeats, and a
`high` call that thinks for 400 seconds outlasts its 300-second silence bound.

```text
{"type":"text-start","id":"t"}

{"type":"text-delta","id":"t","text":"Hello"}
```

`serve` invents nothing: a provider that sends no bytes yields no blank line,
so a stalled call still reaches the step's heartbeat bound. Every client skips
blank lines, so a client that predates keep-alives reads the same events.

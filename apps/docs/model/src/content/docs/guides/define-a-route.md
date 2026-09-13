---
title: "Define a route"
description: "Build a Model service for Anthropic, OpenAI, an OpenAI-compatible server, or the ChatGPT-subscription backend."
sidebar:
  order: 1
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/agent/model/docs/guides/define-a-route.md"
---

A route is the composition of a protocol, an endpoint, an `Auth`, and a
framing. The built-in constructors cover the known deployments; `Route.make`
covers everything else. Every constructor answers `Result<Route, ModelError>`:
endpoint validation can fail before a route exists, so unwrap with
`Result.getOrThrow` or branch on the failure.

Prerequisite: the package is installed and you hold the provider's
credential. For the layer wiring that turns a route into a running `Model`,
see the [quickstart](/quickstart/).

## Anthropic

`Route.anthropic` targets `https://api.anthropic.com/v1/messages` and sends
the key as `x-api-key` with `anthropic-version: 2023-06-01`:

```ts
import { Route } from "@smthrs/model"
import { Redacted, Result } from "effect"

const route = Result.getOrThrow(
  Route.anthropic({ apiKey: Redacted.make(process.env["ANTHROPIC_API_KEY"] ?? "") })
)
```

## OpenAI API key

`Route.openai` targets the Responses API at
`https://api.openai.com/v1/responses` with bearer auth:

```ts
const route = Result.getOrThrow(
  Route.openai({ apiKey: Redacted.make(process.env["OPENAI_API_KEY"] ?? "") })
)
```

## An OpenAI-compatible server

First, decide which wire shape the server speaks. Responses and Chat
Completions are different protocols, not two names for one. Ollama, Gemini's
compatibility layer, Cerebras, OpenRouter's chat route, and most self-hosted
servers speak Chat Completions. OpenRouter's `/v1/responses` route speaks
Responses.

For a Responses-speaking provider, use `Route.openaiResponsesCompatible` and
pass only the origin: the constructor appends `/v1/responses` itself, so
`https://openrouter.ai/api` becomes `https://openrouter.ai/api/v1/responses`:

```ts
const route = Result.getOrThrow(
  Route.openaiResponsesCompatible({
    id: "openrouter",
    baseUrl: "https://openrouter.ai/api",
    apiKey: Redacted.make(process.env["OPENROUTER_API_KEY"] ?? "")
  })
)
```

For a Chat Completions provider, use `Route.openaiChatCompatible`. `path`
defaults to `/v1/chat/completions`; pass it explicitly when the provider
mounts the endpoint elsewhere:

```ts
const ollama = Result.getOrThrow(
  Route.openaiChatCompatible({
    id: "ollama",
    baseUrl: "http://localhost:11434",
    apiKey: Redacted.make("ollama")
  })
)

const gemini = Result.getOrThrow(
  Route.openaiChatCompatible({
    id: "gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    path: "/chat/completions",
    apiKey: Redacted.make(process.env["GEMINI_API_KEY"] ?? "")
  })
)
```

A server that does not check its `Authorization` header still needs a
non-empty placeholder key: `Auth.bearer` rejects only the empty credential.
Ollama ignores the header entirely.

To ask the provider to enforce a JSON Schema on the answer, configure the
route with `structuredOutput`. Such a route refuses a request that also
declares tools; [Handle failures](/guides/handle-failures/) explains the refusal.
The Cerebras example uses the origin as `baseUrl` with the default
`/v1/chat/completions` path described above.

```ts
const route = Result.getOrThrow(
  Route.openaiChatCompatible({
    id: "cerebras",
    baseUrl: "https://api.cerebras.ai",
    apiKey: Redacted.make(process.env["CEREBRAS_API_KEY"] ?? ""),
    structuredOutput: {
      name: "answer",
      schema: {
        type: "object",
        properties: { city: { type: "string" } },
        required: ["city"]
      }
    }
  })
)
```

## The ChatGPT-subscription backend

`OpenAIChatGPT.make` targets the backend the codex CLI speaks,
`https://chatgpt.com/backend-api/codex/responses`. The credential is a
rotating OAuth access token plus a `chatgpt-account-id` header, so the route
takes a composed `Auth` whose `sign` applies both and whose `refresh` rotates
them. The host owns the token store; the package owns the endpoint, the
protocol, and the confirmed client identity headers.

```ts
import { OpenAIChatGPT } from "@smthrs/model"
import { Result } from "effect"

const route = Result.getOrThrow(OpenAIChatGPT.make({ auth: codexStore.auth({ modelId }) }))
```

Do not set `params.maxTokens` on this route: the backend rejects
`max_output_tokens`, so the request fails locally as `invalid_request` naming
`params.maxTokens`.

## A custom deployment

When no constructor fits, compose the four pieces yourself. A `Protocol`
owns the body codec, the event codec, the streaming state machine, and error
classification; `Endpoint.make` validates the target; `Auth.apiKeyHeader` or
`Auth.bearer` carries the credential; `Framing.sse` or `Framing.ndjson`
matches the byte shape. `myProtocol` stands for any `Protocol.make` value:

```ts
import { Auth, Endpoint, Framing, Route } from "@smthrs/model"
import { Redacted, Result } from "effect"

const route = Result.gen(function*() {
  const endpoint = yield* Endpoint.make({ url: "https://provider.example", path: "/v1/generate" })
  return Route.make({
    id: "my-provider",
    protocol: myProtocol,
    endpoint,
    auth: Auth.bearer(Redacted.make(process.env["MY_PROVIDER_API_KEY"] ?? "")),
    framing: Framing.ndjson
  })
})
```

For a custom `Protocol.make`, `body.from` returns the decoded `Body` type of
`body.schema`. Preparation encodes that value through the codec, then
canonicalizes the encoded JSON into the bytes sent to the provider and used
in sealed-step keys. Transforming codecs are supported: with
`Schema.Struct({ limit: Schema.NumberFromString })`, return `{ limit: 8 }`
from `body.from` to send `{"limit":"8"}`. Encoding failures become
`invalid_request` errors with the failing member's path when available.

Rules the composition enforces for you: endpoint URLs are public route
identity, so `Endpoint.make` rejects embedded credentials, fragments, and
credential-shaped query keys; route headers with credential-shaped names fail
preparation, because credentials travel through `Auth` alone. For the full
`Protocol` contract, see the [API reference](/reference/api/#protocol) and
[Schema-first model calls](/concepts/schema-first/).

## Extra route headers

Two constructors accept extra headers: `Route.openaiResponsesCompatible`
takes a `headers` record, and `OpenAIChatGPT.make` merges its `headers` over
the confirmed `clientHeaders`. A route you compose with `Route.make` sets
them as `Config.headers`. Header names are lowercased and sorted into the
prepared request, and a credential-shaped name is refused: apply secrets
through `Auth`, never through `headers`.

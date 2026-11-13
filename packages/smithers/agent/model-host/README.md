# @smthrs/model-host

Provider-neutral model streaming and the durable callback producer shared by the local Smithers and Plue host composition.

The package is private: it ships inside the Smithers host executables, not on npm.

It runs on Node, Bun, browsers and Cloudflare Workers. The root entry imports no `node:` or `bun:` built-in, and `test/BrowserBundle.test.ts` and the repository browser contract hold it to that. What only one platform can do is injected by the host composition. Import from `@smthrs/model-host` only; the package has no deep entry points.

## What it does

A model host is a trusted process that holds the owner's provider credential. The backend sends it a signed turn grant; the host calls the provider, removes any echo of the credential from the output, and commits each frame back to the backend's durable chat journal.

| Endpoint                  | Constant                         | Purpose                                                                |
| ------------------------- | -------------------------------- | ---------------------------------------------------------------------- |
| `GET /health`             | `MODEL_HOST_HEALTH_PATH`         | Returns `{ "protocol": "smithers.chat-model-host/v1" }`. No bearer.    |
| `POST /v1/chat/turn`      | `MODEL_HOST_TURN_PATH`           | Runs one durable chat turn from a grant; answers `204` when committed. |
| `POST /v1/model/stream`   | `MODEL_HOST_STREAM_PATH`         | Runs one model call and answers the frames as NDJSON (16 MiB at most). |
| `POST /v1/context/select` | `MODEL_HOST_CONTEXT_SELECT_PATH` | Runs the context preflight selector over caller-supplied candidates.   |

Every `POST` route requires `Authorization: Bearer <authorization>` and reads at most 2 MiB of JSON body.

## Building a host

```ts
import { createModelTurnHandler, environmentModelResolver } from "@smthrs/model-host"
import { FetchTransport } from "@smthrs/platform-node"

// The owner's configured model binding, as the backend stores it.
declare const configuredBinding: unknown

const app = createModelTurnHandler({
  authorization: process.env["MODEL_HOST_TOKEN"] ?? "",
  callbackBaseUrl: "http://127.0.0.1:4000",
  resolve: environmentModelResolver({ binding: configuredBinding, env: process.env }),
  // A Node host reads each journal callback's transport phase off Node's own `undici` channels.
  observeTransport: FetchTransport.observe,
  // A Node host writes each turn's diagnostic records to standard error.
  writeDiagnostic: (line) => process.stderr.write(line)
})

// Register app inside the host's flow, providing the incoming HttpServerRequest.
// The host supplies a persistent FlowRuntime and Crypto; the engine supplies FlowInstance.
```

`createModelTurnHandler` returns an `effect/http` handler, `Effect<HttpServerResponse, never, HttpServerRequest | ModelStep.Requirements>`: every refusal is a response, and the package runs no Effect itself. Once the host binds its running flow services, `HttpEffect.toWebHandler` turns it into a `(request: Request) => Promise<Response>` that any server speaking Fetch serves (a Node host adapts `node:http`; a Worker or `Bun.serve` passes it as `fetch`), or a host mounts it on an `HttpRouter`. It runs in the host's fiber, so the host's services, logger, tracer and metrics reach every turn.

A caller who goes away interrupts the body read and the model call however the handler is mounted, and the turn's outcome is still logged and counted.

- `createModelTurnHandler` throws when `authorization` is empty or whitespace, or when `callbackBaseUrl` is not an HTTP or HTTPS URL without user information, query or fragment.
- A turn grant is refused with `400 request_invalid` when it is expired, malformed, names a different run or leg in its cursor, or names a producer origin other than `callbackBaseUrl`.
- `environmentModelResolver` plans the configured binding, reads exactly one named credential from `env`, and refuses provider redirects. A request may pick another model only on the same credential and origin.
- `observeTransport` is the host's `CallbackTransportObserver`. With one, a turn records the host's runtime build before its first callback, and a callback that never answers carries the phase it reached (`none`, `created`, `sent`, `responded`, `received`) in its record and in the `502` answer. Without one, failures carry no transport phase.
- `writeDiagnostic` receives each turn's diagnostic records, one newline-terminated line per call. Without one, turns record nothing.

## Building blocks

- `runModelTurn` streams one model call into turn frames and cuts the credential out of text, reasoning and tool calls, including echoes split across chunks (`StreamingCredentialCutter`).
- `DurableChatProducer` and `runDurableChatTurn` commit frames to the journal callback and verify each receipt against the expected cursor, including its run and leg. An inconsistent receipt fails with `ReceiptMismatch` before the cursor advances, including a final-frame or duplicate receipt.
- `createHostDiagnostics` writes bounded, marker-tagged records to the `write` sink the host passes, and is inert without one; the package never writes to a console or stream itself. Only named measurements and approved protocol string values pass; other fields are dropped and counted. Event and phase labels use closed vocabularies. `yield* diagnostics.begin(event, fields)` starts an observation in the caller’s Effect runtime and returns its completion callback. Fast failures remain visible after the detail limit.
- `toModel` builds the `Model` a configured-model plan names, over a transport that never follows a provider redirect (`onRedirect` is told the refused status), and the `route` it streams through. The transport's fetch (`fetch`, else the `FetchHttpClient.Fetch` present when it builds) carries every request, whatever `Fetch` the calling fiber holds. `route.prepare` gives a request's url, public headers and body exactly as the model sends them, before the key signs it. `HostModel.layer` and `HostModel.layerConfig` provide `{ modelId, model, route }` as the `HostModel` service. `HostModel.make(record)` builds the same service at run time from a configured-model record read elsewhere, such as a database row, reading its key through `Config`; a record the host cannot use fails with `HostModelUnusable` and the planner's or route's code. Missing keys yield `credential_missing`; malformed ChatGPT sign-in credentials yield a typed `authentication` failure without credential contents.
- `createModelProbe` tests a configured model and dials only its planned origin. Its `test` requires the running flow services and returns an Effect that never fails; the host runs it. `ModelCredentials.refresh` returns `Effect<void, unknown>`; refresh failures become a content-free `unreachable` result, and cancellation interrupts the refresh.

## Failures

Turn failures are tagged errors (`ResolveFailed`, `ProducerUnreachable`, `ProviderStartRefused`, `CommitRefused`, `ReceiptMismatch`, `StreamTooLarge`) with fixed messages and status codes only. The HTTP answer carries one of `turn_failed`, `provider_quota`, `provider_auth` or `cancelled`, never provider text.

See [docs/host-tools.md](docs/host-tools.md) for the host-owned tools and install origin rules.

## Callback and fallback boundaries

A producer reads its cursor when a write Effect executes. Refused commits and
malformed receipts fail immediately; only a transport failure retries the
identical batch once, including a connection lost while reading its receipt.

Fallback selection notifications use the primary credential of their own role
and are interrupted after one second. A timeout records the
`smithers_model_host_fallback_notification_timeouts` counter, the
`model_host.fallback_notification` span and a credential-free warning. Every
resolved fallback credential is removed from text, reasoning, tool IDs, tool
names, arguments and preflight reasons, including echoes split across chunks.
Preflight reasons are cut again after JSON decoding, before context budgeting
or reuse in the answer prompt. A reason emptied by redaction is invalid.
Tool arguments are buffered until the call ends, then decoded string values
and keys are cut before durable recording or dispatch. This also removes JSON
escaped echoes split across provider chunks; safe formatting and numeric
literals are preserved.
Malformed message and tool entries are rejected with `400 request_invalid`
before model resolution.

## Durable model calls

Turns, context selectors, generation probes and fallback attempts use
`ModelStep.run` from `@smthrs/agent`, the durable model-call entry in
[the library catalog](../../../../docs/libraries.md). Their options carry the
actual credential-free `route.prepare` alongside the matching model. The host
must provide `Crypto` and a persistent `FlowRuntime`, and invoke them inside a
registered flow, whose engine supplies `FlowInstance`. There is no implicit
in-memory runtime or direct-provider fallback.

The SDK records provider events and usage before replay. The host also seals
failed attempts so resuming a fallback does not charge the failed primary
again. Provider credential echoes are removed before recording. Decision
probes use the evaluator protocol inside a sealed SDK action. A resumed
execution reuses the same outcome and correlated frames without charging its
usage again. A different execution is a separate call. Provider request bytes
and prompt-cache keys are unchanged.

Cancellation closes the provider without inventing a terminal frame. A crash
before a call seals can require another provider attempt, as documented by
`ModelStep`; this is at-least-once delivery. The host owns stable execution
identities and callback-journal cursor recovery. `DurableCalls.test.ts` covers
replay, failed-primary fallback, accounting, cancellation and reopening a real
SQLite engine with the original cache request.

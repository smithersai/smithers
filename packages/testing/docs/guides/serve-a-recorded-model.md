---
title: "Serve a recorded model over HTTP"
description: "Test an install that calls its model from another process: record real Chat Completions turns and judge evaluations once through smthrs-model-server, replay them with no network, and hold a turn until the test releases it."
sidebar:
  order: 9
---

A layer replaces a model only inside one process. An install under test runs
its coding host as a separate process, and that process calls its model over
HTTP. `ModelServer` puts a recorded model behind the same wire, so the install
calls a local endpoint and the test stays deterministic.

The endpoint speaks two routes:

| Route                          | Protocol                                                                      |
| ------------------------------ | ----------------------------------------------------------------------------- |
| `POST /v1/chat/completions`    | OpenAI Chat Completions, streamed, as `Route.openaiChatCompatible` sends it   |
| `POST /v4/ai/evaluation-model` | The AI Gateway's evaluation route, as `Evaluator.layerVercelGateway` sends it |

Turns are recorded through `CachedModel` and judgments through
`CachedEvaluator`, both into one fixture file in the
[fixture format](../concepts/fixtures.md).

## Record once

Run the server in record mode against a real provider. The key is read from the
environment variable `--key-env` names. It is never passed on the command line
and never written to the fixture.

```bash
AI_GATEWAY_API_KEY=... npx smthrs-model-server \
  --fixture test/fixtures/install.json \
  --record --upstream https://ai-gateway.vercel.sh --key-env AI_GATEWAY_API_KEY \
  --upstream-model openai/gpt-5-mini
```

The server prints one line once it listens:

```json
{ "url": "http://127.0.0.1:54123" }
```

Point the install's provider base URL at that origin and run the test.
`--upstream-model` picks the model the provider is asked for. The fixture keeps
the model id the install requested, so replay matches what the install sends.
The fixture is written when the server stops on SIGINT or SIGTERM. Read it
before you commit it: it holds every prompt and answer.

## Replay on every run after

Without `--record` the server reads the fixture once and never writes it. It
needs no key and makes no network call:

```bash
npx smthrs-model-server --fixture test/fixtures/install.json
```

A request the fixture does not hold is answered `501` with
`{"error":{"type":"unrecorded"}}` and logged with its model id and message
count, never its text. If a heartbeat or model output already opened the
stream, its HTTP status stays `200`; the server sends the same error as an SSE
chunk and ends the response. Replay refuses to start when the fixture file
does not exist.

## Make replay deterministic

Replay keys a turn on its canonical request: the model id, the system prompt,
every message, the tools, and the parameters. A prompt that carries a value that
changes on every run, such as a timestamp, a temporary path, a port or a random
identifier, misses on replay. Pin what the test controls: fix the clock and
seed the identifiers. Normalize the rest with `--normalize <regex>`, on the
recording run and every replay alike: each match becomes `<normalized>` before
the request is keyed and recorded, while the upstream still receives the
original. A test that runs in a temporary directory passes that directory:

```bash
npx smthrs-model-server --fixture test/fixtures/install.json --normalize '/var/folders/[^"]*/TestInstall[0-9]+'
```

Run the replay twice before you commit a fixture.

## Hold a turn until the test releases it

An ordering test needs a run to stop at one exact turn. `--hold` takes a
regular expression with one capture group. A turn whose text matches waits on
the captured key:

```bash
npx smthrs-model-server --fixture test/fixtures/install.json --hold '\[HOLD ([a-z0-9]+)\]'
```

| Route                         | Answer                                                             |
| ----------------------------- | ------------------------------------------------------------------ |
| `GET /__testing/held`         | The keys turns wait on now, as a JSON array                        |
| `POST /__testing/release/<k>` | `204`; answers every turn held on `k`, and every later one at once |

While a turn waits, the server opens its stream and writes an SSE comment every
15 seconds, so a proxy in front of the model does not time the call out.

## Count and trace the turns

Every run keeps a turn log. `GET /__testing/turns` answers the turns served so
far by kind and name, with the keys held now. `--trace <path>` appends each turn
to a file as one JSON line, and `--trace-messages` keeps each chat turn's
messages, so the trace is evidence of what the install sent:

```bash
npx smthrs-model-server --fixture test/fixtures/install.json --trace evidence/turns.jsonl
```

## Script what a recording cannot answer

`--script builtin` answers Smithers' built-in flows from `BuiltinScript` before
the fixture, for the turns no real model gives on demand. See
[Script the turns a recording cannot make](./script-a-model.md).

## Serve from a test in process

The same server is a scoped Effect constructor, for a test that starts the
install from its own process:

```ts
import { CachedEvaluator, CachedModel, FixtureStore, TurnGate } from "@smthrs/testing"
import * as ModelServer from "@smthrs/testing/ModelServer"
import * as Effect from "effect/Effect"

const program = Effect.gen(function*() {
  const fixture = yield* FixtureStore.makeMemory(recorded)
  const gate = yield* TurnGate.make()
  const model = TurnGate.model(CachedModel.make({ fixture }), {
    gate,
    key: (request) => request.system[0]?.text.includes("Implement") ? "edit" : undefined
  })
  const server = yield* ModelServer.make({ model, evaluator: CachedEvaluator.make({ fixture }), gate })
  yield* startTheInstall({ providerBaseUrl: server.url })
  yield* gate.release("edit")
})

Effect.runPromise(Effect.scoped(program))
```

`CachedModel` and `CachedEvaluator` without `live` replay only. Pass `live` to
record misses.

## Related

- [Replay a model instead of calling one](./replay-a-model.md) covers the
  in-process layers.
- [Fixtures and replay identity](../concepts/fixtures.md) explains the
  canonical digest a replay matches on.
- [Script the turns a recording cannot make](./script-a-model.md) covers
  `ScriptedModel` and `BuiltinScript`.

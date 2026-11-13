---
title: "Read the stream"
description: "Consume the ModelEvent stream: text, thinking, tool calls, usage, settlement, and the settledMessage fold."
sidebar:
  order: 2
---

`model.stream(request)` answers a `Stream<ModelEvent, ModelFailure>`. Every
protocol lowers its own wire vocabulary into the same thirteen events, so the
reading code below works whichever provider answered. Cancellation is fiber
interruption: interrupt the fiber running the stream and the call stops.

## The event vocabulary

| `type`            | Fields                                                            | Meaning                                                                       |
| ----------------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `text-start`      | `id`                                                              | Opens a text part.                                                            |
| `text-delta`      | `id`, `text`                                                      | One chunk of that part's content.                                             |
| `text-end`        | `id`                                                              | Closes the part.                                                              |
| `thinking-start`  | `id`, `signature?`                                                | Opens a reasoning part.                                                       |
| `thinking-delta`  | `id`, `text`                                                      | One chunk of reasoning.                                                       |
| `thinking-end`    | `id`                                                              | Closes the part.                                                              |
| `tool-call-start` | `id`, `name`                                                      | Opens a tool call and names the tool.                                         |
| `tool-call-delta` | `id`, `arguments`                                                 | One chunk of the JSON argument text.                                          |
| `tool-call-end`   | `id`, `arguments?`                                                | Closes the call, repeating the full argument text when the provider sends it. |
| `tool-result`     | `id`, `output`, `isError?`                                        | A harness's report of an executed call; not part of the settled message.      |
| `usage`           | the `Usage` counters                                              | Token counts reported mid-stream.                                             |
| `retry`           | `attempt`, `code`, `delayMillis`, `elapsedMs?`, `httpStatus?`     | A bounded model-boundary retry, recorded for run reports.                     |
| `settle`          | `stopReason`, `responseId?`, `servedTier?`, `timing?`, `itemIds?` | Ends the stream and states why.                                               |

Parts correlate by `id`: deltas and the end event carry the `id` of the
start event they belong to, so interleaved text, thinking, and tool calls
disambiguate.

## Fold the stream into a message

Most consumers want the durable result, not the deltas.
`ModelEvent.settledMessage` folds any iterable of events into the one
assistant message plus the usage counters:

```ts
import { Model, ModelEvent } from "@smthrs/model"
import { Effect, Stream } from "effect"

const result = Effect.gen(function*() {
  const model = yield* Model.Model
  const events = yield* Stream.runCollect(model.stream(request))
  const { message, usage } = ModelEvent.settledMessage(events)
  return { message, usage }
})
```

The folded `AssistantMessage` carries the reassembled content parts, the
`stopReason`, and the `responseId` and `itemIds` a continuation request
replays. Append it to the transcript as-is; the built-in lowerings know how
to send it back.

`usage` merges every `usage` event, later counters overwriting earlier ones
field by field. Every counter is optional: a missing count is not a zero
count.

## React to deltas instead

To render progressively, consume the stream directly and switch on
`event.type`:

```ts
yield * Stream.runForEach(model.stream(request), (event) => {
  if (event.type === "text-delta") return Effect.sync(() => process.stdout.write(event.text))
  return Effect.void
})
```

A `retry` event needs no handling in a render loop: it records that the
durable boundary waited and tried again, and `settledMessage` skips it.

## Settlement and interruption

A well-formed stream ends with exactly one `settle` event. Its `stopReason`
is one of seven values:

| `stopReason`     | Meaning                                                                     |
| ---------------- | --------------------------------------------------------------------------- |
| `stop`           | The model finished its turn.                                                |
| `length`         | The output hit the token budget or the context window.                      |
| `tool-calls`     | The model asked for tools; execute them and continue.                       |
| `content-filter` | The provider refused on safety grounds.                                     |
| `error`          | The provider failed the turn.                                               |
| `aborted`        | The stream was interrupted. This layer's own value; no provider reports it. |
| `unknown`        | The provider's reason did not map.                                          |

A stream that ends without `settle` was interrupted: the fiber was cancelled
or the transport died. `settledMessage` still returns a message, with
`stopReason: "aborted"` and whatever content arrived, so the transcript
stays truthful and resumable. Every built-in lowering omits an aborted or
errored assistant turn from the next request rather than replaying content
the provider will reject, so a transcript containing one continues cleanly.

## Where the call's time went

A call made through a route says where its time went. The `settle` event
carries `timing`, in whole milliseconds from the start of the call:

```ts
yield * Stream.runForEach(model.stream(request), (event) => {
  if (event.type !== "settle" || event.timing === undefined) return Effect.void
  const { attempts, headersMs, firstOutputMs, lastOutputMs } = event.timing
  // headersMs: the provider started answering.
  // firstOutputMs - headersMs: the wait for the first written piece.
  // attempts > 1: event.timing.failedTries says when and why a try failed.
  return Effect.log({ attempts, headersMs, firstOutputMs, lastOutputMs, servedTier: event.servedTier })
})
```

A stage that did not happen is absent: a call with no thinking has no
`firstThinkingMs`, and a call that wrote nothing has no `firstOutputMs`.
`servedTier` is the service tier the provider says served the call. The
[API reference](../api.md#wire-timing) defines every field.

## Tool calls need validation before execution

Tool-call arguments arrive as JSON text in fragments. Two policies cover the
two situations the text can be in:

- On a live stream, the protocol's state machine completes a call through
  `ToolStream.end`, which validates that the reassembled text is a JSON
  object and fails the stream with `invalid_provider_output` when it is not.
  A `tool-call-end` you observe on a built-in protocol therefore carries
  provider-validated text.
- On an interrupted stream, partial text is preserved verbatim in the folded
  message, so the journal records what arrived. It is audit data, not
  executable input.

The fold does not decode arguments for you. Parse and validate
`ToolCallPart.arguments` against the tool's schema before executing,
especially on a message whose `stopReason` is `"aborted"`.

Report results back through the transcript: append a `ToolMessage` whose
`ToolResultPart` values address each call by `toolCallId`. When a result
makes new tools available, name them in `addedToolNames`; that is the signal
the deferred-tool policy reads on the next request.

## Continue the conversation

The next request is a new `ModelRequest` with the folded assistant message
and the tool message appended to `messages`. Provider-specific continuation
state travels inside the message: Anthropic thinking signatures inside
`ThinkingPart.signature`, OpenAI item ids inside `itemIds` and signatures.
You replay values, never wire fields.

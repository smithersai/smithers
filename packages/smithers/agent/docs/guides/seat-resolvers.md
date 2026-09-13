---
title: "Resolve seats into live models"
description: "Implement the SeatResolver seam: turn a declared seat string into a live model, a sealing route, and a real context window, or fail with SeatUnresolved."
sidebar:
  order: 7
---

A flow declares `model: anthropic:claude-sonnet-4-5` and an action declares
`seat: "anthropic:claude-sonnet-4-5"`. Neither declaration carries an API key,
an endpoint, or a client, and that is the whole point: a declaration is
portable, so the credentialed half has to live somewhere the declaration cannot
reach. `SeatResolver` is that half. This guide implements one. For why the two
halves are split, see [Seats](../concepts/seats.md).

## The one method

```ts
import * as Seat from "@smthrs/agent/Seat"
import * as SeatResolver from "@smthrs/agent/SeatResolver"
import * as Effect from "effect/Effect"

const seats = SeatResolver.layer({
  resolve: (id) =>
    Effect.succeed(
      Seat.make({
        id,
        modelId: "claude-sonnet-4-5", // the resolved provider model id
        model, // a live Model.Model
        route, // a FlowEngineLike.RouteResolver
        contextWindowTokens: 200_000
      })
    )
})
```

A resolved seat preserves the declared `id` and carries four resolved fields:

- `modelId`: the provider model id used for generation and compaction. An alias
  such as `reviewer` stays in `id`; its selected model goes in `modelId`.
- `model`: the live `Model` the run streams from.
- `route`: the `RouteResolver` that seals the run's requests. For a configured
  provider route, `FlowEngineLike.routeResolver(route)` adapts it; a test
  supplies a recorded `prepare`.
- `contextWindowTokens`: the model's context window, so compaction has a real
  budget. Never zero: zero is the controller's "compaction disabled", and a
  resolver must not silently disable it.

`SeatResolver.contextWindowTokensFor` is the catalog for known model ids, with
a conservative floor of 128,000 for models it has not met:

| Model id                                                                     | Tokens    |
| ---------------------------------------------------------------------------- | --------- |
| `claude-opus-5`, `claude-sonnet-5`                                           | 1,000,000 |
| `claude-fable-5*`, `claude-mythos-5*` (numeric version suffixes)             | 1,000,000 |
| `claude-opus-4-6`, `claude-opus-4-7`, `claude-opus-4-8`, `claude-sonnet-4-6` | 1,000,000 |
| Other `claude` ids, including Haiku and Bedrock/Vertex-prefixed ids          | 200,000   |
| `gpt-5`                                                                      | 400,000   |
| `gpt-4.1`                                                                    | 1,000,000 |
| `gpt-4o`                                                                     | 128,000   |
| `o1`, `o3`, `o4`                                                             | 200,000   |
| anything else                                                                | 128,000   |

## Refuse honestly

A seat the host cannot serve is a typed `Seat.SeatUnresolved`, not a run that
fails halfway through:

```ts
const seats = SeatResolver.layer({
  resolve: (id) =>
    apiKeyFor(id) === undefined
      ? Effect.fail(new Seat.SeatUnresolved({ seat: id, message: `No API key is configured for ${id}` }))
      : Effect.succeed(
        Seat.make({ id, modelId: modelIdFor(id), model: modelFor(id), route, contextWindowTokens: 200_000 })
      )
})
```

`AgentSession` resolves the declared seat at launch, so a missing key refuses
the launch as a typed failure instead of failing an accepted run.
`SeatResolver.layerNoop()` is the explicit absence: it fails every resolve with
`SeatUnresolved` and the message "No seat resolver is configured". Refusing is
the honest default, because inventing a model here would turn a missing key
into a failed provider call halfway through a run.

## Own the vocabulary

The `provider:modelId` convention is what the resolver in
[`@smthrs/cli`](/api/cli) understands, not a rule the agent enforces. Nothing below the resolver parses the string, so
a host may define its own vocabulary: a resolver that maps `reviewer` onto a
particular model is an ordinary implementation of the one method. `AgentSession`
reads the string out of a flow's `model:` frontmatter and asks for it verbatim.

## The scripted half

A test installs a resolver that answers with a scripted model and never touches
the network. That resolver is the whole difference between a deterministic run
and a live one, which is the pattern the [Quickstart](../quickstart.md) builds
and [Test a model-backed step](./testing.md) generalizes.

`SeatResolver.contextWindowResolver(service)` adapts a host resolver to the
harness's `contextWindowTokensFor(seat)` callback. The session and action
adapters use it when steering, so logical seats such as `reviewer` retain the
host's context budget. A refused seat becomes a typed harness assembly failure.

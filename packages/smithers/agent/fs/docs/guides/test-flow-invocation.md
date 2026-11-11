---
title: "Test flow invocation"
description: "Stub the FlowInvoker boundary to test command surfaces without running flows."
sidebar:
  order: 3
---

Both projections dispatch through the `FlowInvoker` seam, so tests replace it
and never run a real flow. This guide covers three patterns: recording
invocations, failing closed, and asserting on sanitized errors.

## Record invocations with a stub

`FlowInvoker.make` builds a frozen service from an object carrying an own
`invoke` function. Push each invocation into an array and return a value that
satisfies the flow's output schema:

```ts
import { Command, FlowInvoker } from "@smthrs/fs"
import { Effect, Layer } from "effect"

const seen: Array<FlowInvoker.Invocation> = []
const invoker = FlowInvoker.make({
  invoke: (invocation) =>
    Effect.sync(() => {
      seen.push(invocation)
      return { accepted: true, number: (invocation.input as { readonly number: number }).number }
    })
})

const output = await Effect.runPromise(
  commands.execute("review --number 42").pipe(
    Effect.provide(Layer.succeed(FlowInvoker.FlowInvoker, invoker))
  )
)
// output === { accepted: true, number: 42 }
// seen[0].input === { number: 42 }, frozen
```

The invocation arrives frozen, with the decoded input inside it: the string
`"42"` from the command line is the number `42` here. Return a value the
flow's output schema rejects, such as `{ accepted: "yes", number: 1 }`, and
`execute` fails with `encode_failed`.

`make` refuses non-records, inherited or accessor `invoke` properties, and
non-function values with a `TypeError`, without invoking anything.

## Fail closed with the noop invoker

`FlowInvoker.makeNoop` fails every invocation with `invocation_unavailable`,
and `FlowInvoker.layerNoop` provides it as a layer. Use it to prove a surface
cannot execute when no harness is installed:

```ts
const exit = await Effect.runPromise(
  Effect.exit(
    commands.execute("review --number 42").pipe(Effect.provide(FlowInvoker.layerNoop()))
  )
)
// failure code: invocation_unavailable
```

To override the default with one behavior, pass `invoke` to `makeNoop` or
`layerNoop`. An inherited, accessor, or non-function override throws `TypeError`.

In VibeLang effect code, wrap constructor calls in `Effect.try` so a synchronous
`TypeError` becomes a typed failure:

```vibe
effect function makeInvoker() {
  return try Effect.try(() => FlowInvoker.make({
    invoke: effect ({ input }) => input
  }))
}
```

This also applies to `makeNoop` and `layerNoop`. The constructors validate
immediately; running the returned invoker remains an Effect.

## Assert on decoded input and sanitized errors

Two properties are worth asserting in your own surfaces:

1. **Decoding happens before invocation.** A command that fails decoding
   never reaches `invoke`. Parse or execute with an input that contradicts
   the flow's schema and assert `seen` stays empty:

   ```ts
   const exit = await Effect.runPromise(Effect.exit(commands.parse("review --number nope")))
   // failure code: decode_failed, and seen.length === 0
   ```

2. **Errors never echo caller data.** `FsError` values retain no raw
   arguments, input values, output values, or implementation causes. Assert
   that the serialized error does not contain the offending value:

   ```ts
   import { Cause, Option } from "effect"

   const failure = Option.getOrThrow(Cause.findErrorOption(exit.cause as never))
   JSON.stringify(failure) // never contains "nope"
   ```

For the full list of codes your assertions can branch on, see the
[error codes table](../contract.md#error-codes) and
[Troubleshooting](../troubleshooting.md).

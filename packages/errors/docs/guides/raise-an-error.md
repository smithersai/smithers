---
title: "Raise a SmithersError from an adapter"
description: "Construct a SmithersError with the right code, attach provider-safe details and a cause, and subclass it when your adapter needs typed fields of its own."
sidebar:
  order: 2
---

You are writing an integration adapter and something went wrong. This guide is
the raising side: which code to pick, what to attach, and when a subclass earns
its keep.

## Pick the code first

The code is the only part of the error a caller branches on, so choose it by
what the caller must do, not by where the failure happened:

- The caller passed something the helper or the provider cannot accept:
  `INVALID_INPUT`.
- A call to the provider failed: `INTEGRATION_ERROR`, through the
  `IntegrationError` subclass so the failure carries a `reason`.
- The runtime lacks a primitive you need: `UNSUPPORTED`.

The two Telegram codes are retained for historical decoding. Do not use them
for new adapters.
If none of the five fits your failure, you are probably not writing an
integration adapter. State the failure as a `Schema.TaggedError` on the effect
that can fail, which is what every other Smithers package does. See
[The closed code vocabulary](../concepts/error-codes.md).

## Construct it

```ts
import { SmithersError } from "@smthrs/errors/SmithersError"

throw new SmithersError(
  "INVALID_INPUT",
  `Chunk maxLength must be an integer between 1 and ${MAX_MESSAGE_LENGTH}.`,
  { maxLength }
)
```

Write the summary for a person who has to fix something. Name the argument and
the accepted range or format, as the line does here. Leave the documentation
URL out: the constructor appends it, and appends it exactly once.

`details` is optional, and omitting it is better than passing an empty record.
An instance built with no `details` has no own `details` property, so a log
line never prints `details: undefined`.

## Redact before you construct, not after

The class stores `details` and `cause` verbatim. Anything you attach is
anything a log will hold.

Provider responses and network errors may contain credentials. Prefer a fixed
summary and explicitly safe details instead of attaching raw response text:

```ts
const summary = "Provider request failed"
const details = { operation: "read-issue" }
```

The GitHub adapter already redacts its own errors. A custom adapter must apply
its own credential policy before constructing an error or attaching a cause.

Keep verification failures coarse. Report that a signature did not match, never
which bytes differed: a more specific message is a verification oracle.

## Attach a cause without an undefined key

Pass `cause` straight through from your options. A `cause` of `undefined` is
treated as no cause, so the instance gets no own `cause` property and
`util.inspect` prints no `[cause]` line:

```ts
import { SmithersError } from "@smthrs/errors"

class IntegrationError extends SmithersError {
  declare readonly _tag: "IntegrationError"
  readonly reason: Reason

  constructor(
    reason: Reason,
    message: string,
    details?: Record<string, unknown>,
    options?: { readonly cause?: unknown }
  ) {
    super("INTEGRATION_ERROR", message, { reason, ...details }, { cause: options?.cause })
    this._tag = "IntegrationError"
    this.reason = reason
  }
}
IntegrationError.prototype.name = "IntegrationError"
```

That is why a subclass can always spell the optional key instead of building a
conditional spread at every call site.

## Subclass when you have typed fields

Subclass `SmithersError` when your adapter has fields a caller reads by name.
`Core.IntegrationError` in [`@smthrs/integrations`](/api/integrations) adds
`reason` and includes it in `details` by default.

The TypeScript form above follows the real `Core.IntegrationError`
constructor: `(reason, message, details?, options?)`. `Reason` is the adapter's
closed reason union. Two explicit steps give it its own identity:

1. Declare a literal `_tag` type and assign `this._tag = "IntegrationError"`
   after `super(...)`, so `Effect.catchTag("IntegrationError")` routes to it.
2. Set `IntegrationError.prototype.name = "IntegrationError"` after the class,
   so the reported name and stack heading agree with the tag.

A plain `class YourError extends SmithersError {}` inherits both `"SmithersError"`
values. Declare additional fields in the body and set them after `super(...)`
in the constructor.

## Ship a refinement with the subclass

`instanceof` fails across a module-instance boundary, and a `name` check alone
is forgeable. Export a refinement that checks both, plus every field your
conversions later read:

```ts
export const isIntegrationError = (error: unknown): error is IntegrationError => {
  try {
    if (
      !(error instanceof Error) ||
      (!(error instanceof IntegrationError) && error.name !== "IntegrationError") ||
      !hasSmithersErrorShape(error) ||
      error.code !== "INTEGRATION_ERROR"
    ) return false
    const reason = Object.getOwnPropertyDescriptor(error, "reason")
    return reason !== undefined && "value" in reason && isReason(reason.value)
  } catch {
    return false
  }
}
```

Three details in that shape are load-bearing:

- Every read is inside a `try`. A property getter on a caller-supplied error is
  caller code, and one that throws must answer `false` rather than escape.
- `hasSmithersErrorShape` validates the code against the documented vocabulary,
  so an error from an older copy of your module whose values have drifted falls
  through to the caller's unclassified path.
- Reading `reason` through a property descriptor, not a plain access, avoids
  running a getter twice.

For the reasoning behind the two refinements, see
[Detect an error across module copies](./detect-an-error-across-module-copies.md).

## Convert at the durable boundary

An error class cannot cross a journal write. If your adapter's failure can end
an action, ship a schema form of it too, and a total conversion in both
directions. `Core.ActionFailure.fromIntegrationError` and `toIntegrationError`
are the pattern: the conversion never throws, and a value it cannot classify
becomes a conservative non-retryable failure rather than a defect inside
`Effect.mapError`.

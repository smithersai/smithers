---
title: "The shape of a SmithersError"
description: "The five fields a SmithersError carries, the guarantee attached to each, and the redaction contract that makes details and cause safe to write into a log."
sidebar:
  order: 2
---

`SmithersError` extends `Error` and adds five own fields. Every one of them
exists because a different reader needs it, and each carries a guarantee the
constructor enforces.

## The fields

| Field     | Type                                               | Guarantee                                                                                            |
| --------- | -------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `code`    | `SmithersErrorCode`                                | One of five string literals, closed by the type. The classification a caller branches on.            |
| `summary` | `string`                                           | The message with every trailing documentation URL removed.                                           |
| `docsUrl` | `string`                                           | Always `ERROR_REFERENCE_URL`.                                                                        |
| `details` | `Readonly<Record<string, unknown>>` or `undefined` | An own property only when the constructor received one. Copied and frozen at the top level.          |
| `_tag`    | `string`                                           | The Effect tag: the class's own name, `"SmithersError"` or a subclass's. Enumerable, as Effect's is. |

`name` reports the tag too, and comes from the class's prototype, like
`Error.prototype.name`.

`message` and `cause` are inherited from `Error`. `message` is `summary` plus
the documentation URL; `cause` is present only when the caller supplied one.

## message, summary, and the documentation URL

The constructor appends `" See https://github.com/smithersai/smithers/blob/main/packages/errors/docs/reference/error-codes.md"` to the
summary and stores the un-suffixed text as `summary`.

The append is idempotent by construction. Before appending, the constructor
strips every trailing copy of the suffix, tolerating trailing whitespace and
whitespace between copies. Whitespace the summary itself ends with is kept.
Wrapping an error's `message` in a new `SmithersError` therefore produces the
same `message` and `summary` rather than a growing tail:

```ts
const first = new SmithersError("INVALID_INPUT", "no bot token")
first.message // "no bot token See https://github.com/smithersai/smithers/blob/main/packages/errors/docs/reference/error-codes.md"

const wrapped = new SmithersError("INVALID_INPUT", first.message)
wrapped.message // "no bot token See https://github.com/smithersai/smithers/blob/main/packages/errors/docs/reference/error-codes.md"
wrapped.summary // "no bot token"
```

Only a trailing suffix is stripped. A URL quoted in the middle of a sentence is
prose, so it stays and the pointer is still appended.

Two cases suppress the URL:

- `{ includeDocsUrl: false }` leaves it out, and still strips a suffix the
  summary already carried.
- A summary that is empty or entirely whitespace gets no suffix, because a
  message of just a URL tells a reader nothing.

Use `summary` when you render a failure somewhere the URL is noise. Use
`message` in a log or a stack trace, where the pointer is the point.

## details is copied, frozen, and shallow

`details` is caller-supplied context. The constructor copies the top-level
record and freezes the copy:

```ts
const details = { reason: "poll-failed", context: nested }
const error = new SmithersError("INTEGRATION_ERROR", "poll failed", details)

details.reason = "changed" // does not reach error.details
error.details // { reason: "poll-failed", context: nested }
Object.isFrozen(error.details) // true
```

The freeze is one level deep. Nested values are shared by reference, so
mutating an object you already attached does change what the error reports.
Attach values you will not touch again.

When the constructor receives no `details`, the instance has no own `details`
property at all. That is why `util.inspect` and `JSON.stringify` never print
`details: undefined` for an error that carries none.

## cause is stored verbatim, and absent when undefined

A `cause` of `undefined` is treated as no cause, so the instance has no own
`cause` property and inspection prints no `[cause]` line. A subclass can
therefore always spell the key and let the caller decide:

```vibe
class IntegrationError extends SmithersError {
  declare readonly _tag: "IntegrationError"

  constructor(options?: { readonly cause?: unknown }) {
    super("INTEGRATION_ERROR", "poll failed", undefined, { cause: options?.cause })
    this._tag = "IntegrationError"
  }
}
IntegrationError.prototype.name = "IntegrationError"
```

A supplied cause is stored as given. Non-`Error` causes are kept as-is, and a
cause chain is preserved unchanged.

## The redaction contract

`SmithersError` never redacts. It copies `details`, it stores `cause`, and it
inspects neither. The obligation sits with the constructor caller, and it is
the reason this package exists next to integration adapters rather than inside
them.

An adapter must remove credentials before it constructs the error:

- Bot tokens, API keys, and webhook secrets must not appear in the summary, in
  `details`, or in `cause`.
- Provider text is the dangerous case, because a message from `fetch` or the
  platform may quote a URL your code never formatted. Redact provider text
  before attaching it, or use a fixed summary and explicitly safe fields.
- Verification failures must not describe why they failed beyond the fact that
  they did. A signature refusal must not identify which bytes differed,
  because a more specific message is a verification oracle.

The consequence for a caller: `details` from a Smithers integration adapter is
already provider-safe and can go straight into a log. `details` on an error you
constructed yourself is only as safe as you made it.

## Subclasses tag themselves

A subclass is a class that extends `SmithersError`. An `error` declaration
cannot extend a class (VibeLang VIP-13), so the subclass sets its own tag after
`super(...)` and its own name on its prototype. `instanceof` holds for both
classes, and the subclass reports its own name, which its stack starts with:

```vibe
class AdapterError extends SmithersError {
  declare readonly _tag: "AdapterError"

  constructor(code: SmithersErrorCode, summary: string) {
    super(code, summary)
    this._tag = "AdapterError"
  }
}
AdapterError.prototype.name = "AdapterError"

const error = new AdapterError("TELEGRAM_API_ERROR", "bad request")
error instanceof AdapterError // true
error is SmithersError // true
error.name // "AdapterError"
```

## The tag is the name

`SmithersError` is an Effect tagged error. Each class's `_tag` is its own
name, so `Effect.catchTag` routes each adapter's failures to their own handler:

```ts
Effect.fail(error).pipe(
  Effect.catchTag("IntegrationError", (e) => Effect.succeed(e.reason)),
  Effect.catchTag("SmithersError", (e) => Effect.succeed(e.code))
)
```

A `SmithersError` may be any subclass, so its `_tag` is typed `string`, while a
subclass's is its own name. Catching `"IntegrationError"` therefore removes
`IntegrationError` from the failure type, and catching `"SmithersError"`
handles base instances and leaves `SmithersError` in it. To handle the whole
family, match by class: `x catch (e) => match (e) { when SmithersError: … }`.

[Raise a SmithersError from an adapter](../guides/raise-an-error.md) shows the
two real subclasses and what they add.

Construction options are readonly: `SmithersErrorOptions.cause` and
`SmithersErrorOptions.includeDocsUrl` cannot be reassigned through the typed
options value. The constructor reads them without modifying the options.

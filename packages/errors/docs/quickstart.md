---
title: "Quickstart"
description: "Raise a SmithersError from a helper, catch it in a caller, branch on its code, and print a log line that carries no credentials."
---

This walkthrough runs one failure the whole way through: a helper refuses an
argument, a caller classifies the refusal by code, and a log line records it.
It needs no network and no credentials. Each step below is TypeScript; the
[VibeLang tab](#the-same-walkthrough-in-vibelang) runs the same steps as Effect
code.

## Raise the error

This example helper validates a chunk size and throws a typed refusal. It uses
only `@smthrs/errors`; no provider adapter is needed.

```ts
import { SmithersError } from "@smthrs/errors"

const MAX_MESSAGE_LENGTH = 4096

const requireChunkLength = (maxLength: number): number => {
  if (!Number.isSafeInteger(maxLength) || maxLength < 1 || maxLength > MAX_MESSAGE_LENGTH) {
    throw new SmithersError(
      "INVALID_INPUT",
      `Chunk maxLength must be an integer between 1 and ${MAX_MESSAGE_LENGTH}.`,
      { maxLength }
    )
  }
  return maxLength
}
```

The three arguments are the whole constructor contract: the code, a summary a
person can read, and an optional `details` record. Everything else is optional
and lives in a fourth options argument.

## Catch it and branch on the code

Classify by `code`. Never match on message text: a message is prose an adapter
may reword, and a code is a string literal the type system checks.

```ts
import { isSmithersError } from "@smthrs/errors"

const parseChunkLength = (raw: unknown): number | string => {
  try {
    return requireChunkLength(raw as number)
  } catch (error) {
    if (!isSmithersError(error)) throw error
    switch (error.code) {
      case "INVALID_INPUT":
        return `Fix the request: ${error.summary}`
      default:
        return `Integration failure (${error.code}): ${error.summary}`
    }
  }
}

parseChunkLength(0)
// "Fix the request: Chunk maxLength must be an integer between 1 and 4096."
```

`error.code` narrows to the two documented literals. This example deliberately
keeps a fallback branch: any code without its own case returns the integration
failure message. Adding a code does not make this switch fail type checking.

`summary` is the message without the appended documentation URL. Use it
wherever the URL would be noise, such as a form field or a chat reply.
`message` keeps the URL, which is what a stack trace and an operator want.

## Check exhaustiveness explicitly

A closed union makes an explicit exhaustiveness check possible. Handle every
code and assign the remaining value to `never` in the default branch:

```ts
import type { SmithersErrorCode } from "@smthrs/errors"

const describeCode = (code: SmithersErrorCode): string => {
  switch (code) {
    case "INVALID_INPUT":
      return "The request is invalid."
    case "INTEGRATION_ERROR":
      return "An integration call failed."
    default: {
      const unhandled: never = code
      return unhandled
    }
  }
}
```

After both cases return, `code` narrows to `never`. If a code is added to
`SmithersErrorCode` without a matching case here, the assignment to `unhandled`
fails type checking. The explicit `never` check provides that guarantee; the
closed union alone does not.

## Log it without leaking a credential

`SmithersError` serializes to its own enumerable fields, and `name` is not one
of them:

```ts
const error = new SmithersError("INTEGRATION_ERROR", "poll failed", { reason: "poll-failed" })

Object.keys(error) // ["code", "summary", "docsUrl", "details", "_tag"]
console.log(JSON.stringify(error))
```

```json
{
  "code": "INTEGRATION_ERROR",
  "summary": "poll failed",
  "docsUrl": "https://github.com/smithersai/smithers/blob/main/packages/errors/docs/reference/error-codes.md",
  "details": { "reason": "poll-failed" },
  "_tag": "SmithersError"
}
```

`message`, `stack`, and `name` stay out of that object: the first two are
non-enumerable on `Error`, and `name` comes from the prototype.

`details` appears only when the constructor received one, so a log line never
carries `details: undefined`.

The class writes `details` verbatim. If the record you attach could hold a bot
token, an API key, or a webhook secret, remove it before you construct the
error, not after. See
[The shape of a SmithersError](./concepts/error-shape.md#the-redaction-contract).

## Look up what a code means at runtime

The definitions table is exported, so a diagnostic command can print the
meaning of a code it received:

```ts
import { getSmithersErrorDefinition, smithersErrorCodes } from "@smthrs/errors"

for (const code of smithersErrorCodes) {
  console.log(code, getSmithersErrorDefinition(code)?.when)
}
```

`getSmithersErrorDefinition` answers `undefined` for anything outside the two
codes, including inherited property names such as `toString`.

## The same walkthrough in VibeLang

In [VibeLang](https://github.com/smithersai/vibelang) the helper is an `effect`
function, so the refusal is a typed failure rather than an exception: `throw`
fails with the `SmithersError`, `catch` recovers it, and `match` branches on
the code. A `match` with no `default` arm is checked for exhaustiveness by the
compiler, so `describeCode` needs no `never` assignment.

This is `examples/quickstart.vibe`. `test/quickstart.test.vibe` runs it, and
the package's docs check fails if this block and the file differ.

```vibe
import { getSmithersErrorDefinition, SmithersError, type SmithersErrorCode, smithersErrorCodes } from "@smthrs/errors"

const MAX_MESSAGE_LENGTH = 4096

/** Fails with a typed refusal when a chunk size is out of range. */
export effect function requireChunkLength(maxLength: number): number!SmithersError {
  if (!Number.isSafeInteger(maxLength) || maxLength < 1 || maxLength > MAX_MESSAGE_LENGTH) {
    throw new SmithersError(
      "INVALID_INPUT",
      `Chunk maxLength must be an integer between 1 and ${MAX_MESSAGE_LENGTH}.`,
      { maxLength }
    )
  }
  return maxLength
}

/** Recovers the refusal and branches on its code, never on its message. */
export effect function parseChunkLength(raw: number): (number | string)!! {
  return requireChunkLength(raw) catch (error) =>
    match (error.code) {
      when "INVALID_INPUT": `Fix the request: ${error.summary}`;
      default: `Integration failure (${error.code}): ${error.summary}`;
    }
}

/** A `match` with no `default` fails to compile when a new code has no arm. */
export const describeCode = (code: SmithersErrorCode): string =>
  match (code) {
    when "INVALID_INPUT": "The request is invalid.";
    when "INTEGRATION_ERROR": "An integration call failed.";
  }

/** What each code means, one line per code, as a diagnostic command prints them. */
export const codeMeanings = (): ReadonlyArray<string> =>
  smithersErrorCodes.map((code) => `${code}: ${getSmithersErrorDefinition(code)?.when}`)
```

## Next

- [Handle a failed integration call](./guides/handle-a-failure.md) covers
  retries, the `IntegrationError` subclass, and the durable action boundary.
- [Error code reference](./reference/error-codes.md) lists current construction sites and their details.

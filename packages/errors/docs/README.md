---
title: "@smthrs/errors"
description: "One error class and two closed codes for the Smithers integration adapters: classify a failure by code, show a person a summary, and log context that carries no credential."
---

`@smthrs/errors` is a single error class, `SmithersError`, and a closed
vocabulary of two codes. Smithers is a durable-execution engine for agent
workflows. Its GitHub adapter raises `SmithersError` when
an integration call fails, and a caller decides what to do by reading
`error.code` rather than by matching on message text.

## Why you would reach for it

One integration failure has three readers, and each needs something different
from it:

- A person needs a sentence naming what to fix.
- Code needs a stable value to branch on, one that survives a reworded message.
- A log needs a record that is safe to keep.

`SmithersError` carries all three at once. `code` is a string literal from a
closed union, which makes an
[explicit exhaustiveness check](./quickstart.md#check-exhaustiveness-explicitly)
possible. With that check, adding a code without a matching case is a type
error. `summary` is the message without the documentation URL the constructor
appends, which is what you put in a chat reply or a form field. `details` is the
context the raise site attached, copied and frozen at construction so it cannot
change under you. `code`, `summary`, `docsUrl`, optional `details`, and `_tag`
serialize; `name` and `stack` stay out of `JSON.stringify`.

The class never redacts. It stores `details` and `cause` exactly as it received
them, so the code that constructs the error removes bot tokens, API keys, and
webhook secrets first.
[The shape of a SmithersError](./concepts/error-shape.md) states that contract
in full.

Reach for this package when you are wrapping somebody else's API and its
failures cross into an HTTP handler, a webhook route, and a log line. For a
failure inside your own code, an Effect `Schema.TaggedError` on the effect that
can fail is the better tool, and
[The closed code vocabulary](./concepts/error-codes.md) explains where Smithers
draws that line.

## Install

```bash
npm install @smthrs/errors@next effect
```

`@smthrs/integrations` is its only consumer in Smithers. Handling a
`SmithersError` you caught needs no install: every field, code, and raise site
is on this site, and the source is
[on GitHub](https://github.com/smithersai/smithers/tree/main/packages/errors).
[Installation](./installation.md) has the root entry point, the two module
subpaths, and the paths the exports map refuses. The package depends on
`vibelang-runtime` `0.0.12`, peers `effect` `4.1.1`, and needs Node.js 22.19.0
or later.

## A small example

A helper refuses an argument, and the caller classifies the refusal without
reading a word of prose:

```ts
import { isSmithersError, SmithersError } from "@smthrs/errors"

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

try {
  requireChunkLength(0)
} catch (error) {
  if (!isSmithersError(error)) throw error
  error.code // "INVALID_INPUT"
  error.summary // "Chunk maxLength must be an integer between 1 and 4096."
  error.details // { maxLength: 0 }
  Object.keys(error) // ["code", "summary", "docsUrl", "details", "_tag"]
}
```

`error.code` narrows to the two documented literals. A switch can keep a
fallback or [check exhaustiveness explicitly](./quickstart.md#check-exhaustiveness-explicitly).
[Quickstart](./quickstart.md) shows both forms and runs the same failure the
whole way through, from the raise site to a log line.

## The two codes

`smithersErrorDefinitions` is the runtime table every code is derived from, and
nothing widens it at runtime:

- `INVALID_INPUT`: the call is wrong, and no retry makes it right.
- `INTEGRATION_ERROR`: a provider call, a webhook read, or a listener
  reconciliation failed. `details.reason` says which, and whether to retry.

[Error code reference](./reference/error-codes.md) names current construction sites,
the `details` they attach, and the caller's move.

## Where this sits in Smithers

`@smthrs/errors` imports no other Smithers package. Its tagged-error base and
schema matcher come from the npm package `vibelang-runtime`, which uses the
`effect` peer dependency.
The packages built on top of it are how you get from here into the rest of the
system:

- [`@smthrs/integrations`](/api/integrations) is the only package that depends
  on this one. Its `Core.IntegrationError` carries a classified `reason`.
- Those adapters answer webhooks through the Smithers control plane,
  [`@smthrs/control`](/api/control), and expose their provider calls as durable
  actions built with [`@smthrs/flow`](/api/flow). A durable action is the
  boundary where an error class has to become a schema the journal can store.
- [`@smthrs/cli`](/api/cli) is the `smithers` command line at the top of that
  tree, and the entry point most people meet Smithers through.

## Where to go next

- [Quickstart](./quickstart.md): raise, catch, classify, and log one failure.
- [Handle a failed integration call](./guides/handle-a-failure.md): the
  caller's side, including retries and transport statuses.
- [Raise a SmithersError from an adapter](./guides/raise-an-error.md): the
  raising side, including subclasses and redaction.
- [Detect an error across module copies](./guides/detect-an-error-across-module-copies.md):
  when `instanceof` is not enough.
- [API reference](./api.md): every export with its signature.
- [Troubleshooting](./troubleshooting.md): symptom, cause, and fix.

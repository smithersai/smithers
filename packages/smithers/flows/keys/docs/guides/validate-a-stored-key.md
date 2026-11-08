---
title: "Validate a stored key"
description: "Accept a key from a database, an RPC, or a file: decode it with StoredKey, read its digest, and keep the validation out of the derivation path."
sidebar:
  order: 1
---

Whenever a key crosses back into your process, validate it. Persistence, RPC,
a journal, a query parameter, and a config file are all the same boundary: text
you did not just derive, claiming to be a key.

## Decode at the boundary

`StoredKey` returns the input text unchanged and requires no `Digest` service:

```ts
import { StoredKey } from "@smthrs/keys"
import * as Schema from "effect/Schema"

const key = Schema.decodeUnknownSync(StoredKey)(row.stepKey)
```

In an Effect program, use the effectful decoder so the failure joins your error
channel instead of throwing:

```ts
import { StoredKey } from "@smthrs/keys"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

const load = (text: unknown) =>
  Schema.decodeUnknownEffect(StoredKey)(text).pipe(
    Effect.mapError(() => new Error("stored key is not a key this release understands"))
  )
```

## Validate as a field, not a step

Where a key arrives inside a larger record, put `StoredKey` in the schema. The
record then cannot decode with a key-shaped hole in it, which is what
[`@smthrs/plan`](/api/plan) does at its store boundary:

```ts
import { StoredKey } from "@smthrs/keys"
import * as Schema from "effect/Schema"

const StepRow = Schema.Struct({
  key: StoredKey,
  runId: Schema.String,
  output: Schema.Unknown
})
```

Because `StoredKey` is branded, a plain `string` will not type-check where a
`StoredKey` is required. That is the point: the brand is only obtainable by
decoding, so a value that reached your cache lookup was validated somewhere.

## Read the digest through the accessor

To get the 64-character payload without the prefix, use `digest`:

```ts
import { digest, StoredKey } from "@smthrs/keys"
import * as Schema from "effect/Schema"

const payload = digest(Schema.decodeUnknownSync(StoredKey)(text))
```

`digest` takes a value the type system already says is a key and does not
re-validate it. Do not cast an unvalidated string to `StoredKey` to reach it,
and do not reimplement it with `slice` or a split on `_`. The prefix is this
package's to know. See [the wire format](../concepts/wire-format.md).

## Never validate by deriving

This is the mistake the two operations exist to prevent:

```ts
import { DerivedKey } from "@smthrs/keys"
import * as Schema from "effect/Schema"

// Wrong. This hashes the key text and returns a different key, silently.
const wrong = Schema.decodeUnknownEffect(DerivedKey)(row.stepKey)
```

`DerivedKey` and `deriveKey` hash whatever they are given, including something
that already looks like a key. Nothing fails, and every identity that crossed
the boundary is quietly rewritten. Reach for `StoredKey` whenever the value
came from outside.

## A note on error reporting

`StoredKey` does not suppress input reporting. A caller that decodes with
`{ reportInput: true }` gets the rejected text back in the error message:

```text
Expected key1_ followed by a 64-character lowercase hexadecimal SHA-256 digest, got "key1_not-a-key"
```

A key is a public identifier, so echoing one is not a disclosure. Text that
merely claimed to be a key is another matter: if your boundary decodes
arbitrary untrusted strings through `StoredKey`, leave input reporting off, or
handle the failure before it reaches a log. The derivation path is different
and pins this for you; see
[Derive a key inside a schema](./derive-a-key-inside-a-schema.md).

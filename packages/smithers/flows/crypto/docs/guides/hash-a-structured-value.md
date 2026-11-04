---
title: "Hash a structured value"
description: "Canonicalize an object before hashing it, compose the Sha256 schema into a larger schema, and understand why the schema redacts its input and refuses to encode."
sidebar:
  order: 3
---

`digest` and `digestSync` take text or bytes. An object is neither, so hashing
one means choosing a serialization first, and that choice is the whole
correctness question: two programs agree about a digest only when they agree,
byte for byte, about how the value was written down.

## Canonicalize, then hash

Use [`@smthrs/canonical`](/api/canonical), which implements RFC 8785 canonical
JSON. It sorts object keys by UTF-16 code unit, and it rejects values that
have no stable JSON form rather than guessing at one:

```ts
import { Canonical } from "@smthrs/canonical"
import { digest } from "@smthrs/crypto"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

const digestOf = (value: unknown) =>
  Schema.decodeUnknownEffect(Canonical)(value, { reportInput: false }).pipe(
    Effect.flatMap(digest)
  )

// { a: 2, b: 1 } and { b: 1, a: 2 } serialize to {"a":2,"b":1} and share a digest.
```

`reportInput: false` disables parser input capture at this decode boundary,
which matters when the value contains credentials or a multi-megabyte payload.
It does not sanitize custom messages, annotations, or preserved causes.

## What you must not do instead

Building the bytes by hand is where digests go wrong. Two structured values
that are genuinely different can produce identical bytes:

```ts
import { digestSync } from "@smthrs/crypto"

// Do not do this: ("ab", "c") and ("a", "bc") hash identically.
digestSync(`${namespace}${name}`)
```

If you are joining strings rather than canonicalizing a value, separate them
with a byte that cannot occur in either part, and include a domain and a
version in the material so identities from different protocols cannot
overlap:

```ts
digestSync(`flow-key/v1\0${namespace}\0${name}`)
```

This is the ambiguity the package cannot protect you from: it hashes exactly
the bytes it is given. See
[the contract](../contract.md#what-the-package-does-not-defend-against).

## Reach for the package that already did this

Do not re-derive a format that exists. [`@smthrs/keys`](/api/keys) is
canonicalization plus SHA-256 plus a versioned `key1_` prefix, with typed
failures for both halves:

```ts
import { deriveKey } from "@smthrs/keys"

deriveKey({ domain: "step", flow: "build", attempt: 1 })
// Effect<KeyV1, KeyDerivationError, Crypto.Crypto>
```

[`@smthrs/artifacts`](/api/artifacts) is the same idea for bytes: an address
plus a store that verifies it on every read.

## Compose the Sha256 schema

Where the boundary is naturally a schema rather than a function call, `Sha256`
is the transformation from `string | Uint8Array` to `Digest`:

```ts
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { Crypto, Sha256 } from "@smthrs/crypto"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

const Manifest = Schema.Struct({
  name: Schema.String,
  contents: Sha256 // decodes text or bytes into a Digest
})

Effect.runPromise(
  Schema.decodeUnknownEffect(Manifest)(
    { name: "server.js", contents: "hello" },
    { reportInput: false }
  ).pipe(
    Effect.provide(Crypto.layerFromDigest(NodeCrypto.layerDigest))
  )
)
// {
//   name: "server.js",
//   contents: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
// }
```

Three behaviours of this schema are deliberate:

- **It requires a `Crypto` service.** Decoding runs `digest`, so use
  `Schema.decodeUnknownEffect` and provide a host. There is no synchronous
  decode.
- **It disables input reporting at its own node.** The child annotation cannot
  redact parent issues. Pass `reportInput: false` at the outermost decode, as
  above, for Struct, Array, and Union composition. With `reportInput: true`,
  an enclosing issue can retain the original contents even when hashing
  succeeds and only `name` fails validation.
- **It refuses to encode.** Encoding fails with
  `A digest cannot be converted back into its source bytes`, because a digest
  cannot reconstruct what produced it.

Operational failures become `SchemaError` issues whose message is
`[code] message` and whose annotations keep the typed `Sha256Error` as
`cause`, so a handler can still branch on the stable code. Input reporting
options do not sanitize host or encoder causes, schema paths, custom messages,
or annotations. Keep these diagnostics free of secrets or sanitize the error
before serializing or inspecting it. Do not re-enable `reportInput` on
descendant schemas inside a boundary that disables it.

## Related

- [What a digest covers](../concepts/what-a-digest-covers.md): the input
  policy every one of these paths shares.
- [Validate a digest read from storage](./validate-a-stored-digest.md): the
  other half, for digests you did not compute.

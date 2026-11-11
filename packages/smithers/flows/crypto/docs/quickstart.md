---
title: "Quickstart"
description: "Address bytes by their SHA-256 digest, store them, and validate the address on the way back, with the injected Crypto service and the Digest schema."
sidebar:
  order: 2
---

This quickstart builds the smallest thing a digest is actually for: a store
that names bytes after their own hash. By the end you will have hashed a
value through the injected `Crypto` service, validated a digest that arrived
as an untrusted string, and re-verified bytes against the address they were
stored under. Each step below is TypeScript; the
[VibeLang tab](#the-same-walkthrough-in-vibelang) runs the same steps as Effect
code.

## Prerequisites

- Node.js 22.19.0 or later.
- A project with the packages installed: `npm install @smthrs/crypto@next @effect/platform-node effect`.

## Hash bytes and store them under the digest

Create `quickstart.ts`. `digest` returns an Effect that requires
`EffectDigest.Digest`, so `put` carries that requirement outward instead of choosing
a host for its callers:

```ts
import { Digest, digest, type Sha256Error } from "@smthrs/crypto"
import type * as EffectDigest from "effect/crypto/Digest"
import * as Effect from "effect/Effect"

/** The store: bytes under the digest of those bytes, and nothing else. */
const blobs = new Map<string, Uint8Array>()

/** Publishes bytes and returns the only name they will ever have. */
export const put = (
  bytes: Uint8Array
): Effect.Effect<Digest, Sha256Error, EffectDigest.Digest> =>
  Effect.gen(function*() {
    const owned = Uint8Array.from(bytes)
    const address = yield* digest(owned)
    blobs.set(address, owned)
    return address
  })
```

The returned `Digest` is a branded string: 64 lowercase hexadecimal
characters, and the only form this package ever produces or accepts.

## Validate the address on the way back

An address that comes back from a database column, a URL segment, or a request
body is an ordinary untrusted string. `Digest` validates one without hashing
anything, so it needs no `Crypto` service:

```ts
import * as Schema from "effect/Schema"

/** Reads bytes back, checking the address and then the bytes it names. */
export const get = (address: string) =>
  Effect.gen(function*() {
    const requested = yield* Schema.decodeUnknownEffect(Digest)(address)
    const bytes = blobs.get(requested)
    if (bytes === undefined) return "missing" as const

    // Bytes are what they claim to be only while they still hash to the
    // address they are stored under.
    const recomputed = yield* digest(bytes)
    return recomputed === requested ? "verified" as const : "corrupt" as const
  })
```

`Schema.decodeUnknownEffect(Digest)` fails with a `SchemaError` for anything
that is not 64 lowercase hexadecimal characters, including an uppercase
digest, a 63-character digest, and a digest with a trailing space. That
rejection happens before the map is touched.

## Run it

```ts
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"

const program = Effect.gen(function*() {
  const input = new TextEncoder().encode("the quickstart bytes")
  const address = yield* put(input)
  input.fill(0) // Reusing the caller's buffer leaves the stored bytes intact.
  console.log(address)
  console.log(yield* get(address))
  console.log(yield* get("0".repeat(64)))
})

await Effect.runPromise(program.pipe(Effect.provide(NodeCrypto.layer), Effect.orDie))
```

Run the file with your TypeScript runner:

```text
43648540bc1311ad4731c914b68594dbf0cf1870f84de1f6c8511481dc1f76b7
verified
missing
```

## Prove the two entry points agree

`digestSync` hashes the same input with the package's own implementation and
needs no service, which is what makes it usable inside a synchronous
constructor:

```ts
import { digestSync } from "@smthrs/crypto"

digestSync("the quickstart bytes")
// 43648540bc1311ad4731c914b68594dbf0cf1870f84de1f6c8511481dc1f76b7
```

That equality holds for every input both entry points accept, including
arbitrary text and any byte view, and both are cross-checked against Node and
Web Crypto.

## What just happened

`put` copied your array before yielding to the hash service, hashed that copy,
and stored the same copy after hashing succeeded. Caller writes during hashing
or after `put` returns cannot change the stored bytes or their digest. `get`
validated the address before using it as a key, then re-hashed the stored bytes rather than
trusting the map. Those two habits are the whole discipline of content
addressing: never accept a digest you have not validated, and never trust
bytes you have not re-hashed.

## The same walkthrough in VibeLang

In [VibeLang](https://github.com/smithersai/vibelang) `put` and `get` are
`effect` functions, so `try` replaces `yield*` and the `Digest` requirement
still travels in the return type. `provide` supplies the package's
`WebCrypto.layer` around the run. `digestSync` is a TypeScript function that
may throw `Sha256Error`, and the compiler refuses a bare call in Effect code, so
`digestNow` runs it through `Effect.try`.

This is `examples/quickstart.vibe`. `test/quickstart.test.vibe` runs it, and
the package's docs check fails if this block and the file differ.

```vibe
import { Digest, digest, digestSync, type Sha256Error, WebCrypto } from "@smthrs/crypto"
import type * as EffectDigest from "effect/crypto/Digest"

/** The store: bytes under the digest of those bytes, and nothing else. */
const blobs = new Map<string, Uint8Array>()

/** Publishes bytes and returns the only name they will ever have. */
export effect function put(bytes: Uint8Array): Digest!Sha256Error!EffectDigest.Digest {
  const owned = Uint8Array.from(bytes)
  const address = try digest(owned)
  blobs.set(address, owned)
  return address
}

/** Reads bytes back, checking the address and then the bytes it names. */
export effect function get(address: string) {
  const requested = try Schema.decodeUnknownEffect(Digest)(address)
  const bytes = blobs.get(requested)
  if (bytes === undefined) return "missing" as const

  // Bytes are what they claim to be only while they still hash to the
  // address they are stored under.
  const recomputed = try digest(bytes)
  return recomputed === requested ? "verified" as const : "corrupt" as const
}

/** Stores the quickstart bytes, then reads back their address and an unknown one. */
export effect function quickstart() {
  provide WebCrypto.layer {
    const input = new TextEncoder().encode("the quickstart bytes")
    const address = try put(input)
    input.fill(0) // Reusing the caller's buffer leaves the stored bytes intact.
    return [address, try get(address), try get("0".repeat(64))] as const
  }
}

/** `digestSync` needs no service; it may throw, so Effect code runs it in `Effect.try`. */
export effect function digestNow(text: string): Digest!Sha256Error {
  return try Effect.try({ try: () => digestSync(text), catch: (error) => error as Sha256Error })
}
```

## Next steps

- [The contract](./contract.md): what a digest guarantees, and the attacks it
  does not stop. Read this before a digest becomes a security boundary.
- [Hash inside synchronous code](./guides/hash-in-synchronous-code.md): the
  `digestSync` and `syncCrypto` path, and when it is the right one.
- [Hash a structured value](./guides/hash-a-structured-value.md): why hashing
  an object means canonicalizing it first.
- [Testing](./testing.md): hashing deterministically without a platform layer.

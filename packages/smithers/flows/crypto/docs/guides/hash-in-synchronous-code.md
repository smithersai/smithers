---
title: "Hash inside synchronous code"
description: "Use digestSync inside a pure constructor, and syncCrypto where the surrounding code already speaks the Effect Crypto interface, without giving up the injected path elsewhere."
sidebar:
  order: 1
---

Some identities are computed while a value is being built, not while an effect
is running: a node's identity in a plan AST, a cache key inside a constructor,
a fingerprint attached to a record you are returning right now. There is no
Effect to suspend in and no service to reach. Use `digestSync`.

## Call digestSync directly

```ts
import { digestSync } from "@smthrs/crypto"

interface FunctionIdentity {
  readonly algorithm: "source/v1"
  readonly digest: string
}

export const functionIdentity = (operation: (...args: never) => unknown): FunctionIdentity => ({
  algorithm: "source/v1",
  digest: digestSync(operation.toString())
})
```

`digestSync` accepts the same `string | Uint8Array` input as `digest`, applies
the same input policy, and returns the same branded `Digest`. It needs no
`Crypto` service because it uses the package-owned FIPS 180-4 implementation.

It throws instead of returning a failure, and it throws exactly three of the
five codes: `invalid_text`, `text_encoding_failed`, and `invalid_input`. It
never raises `digest_failed` or `invalid_digest`, because it never consults a
host.

```ts
import { Sha256Error } from "@smthrs/crypto"

const identityOf = (value: string): string => {
  try {
    return digestSync(value)
  } catch (error) {
    if (error instanceof Sha256Error && error.code === "invalid_text") {
      // The string held an unpaired UTF-16 surrogate.
    }
    throw error
  }
}
```

## Separate the fields you join

A synchronous identity is usually built from more than one piece of text, and
the package hashes exactly the bytes you hand it. Join them with a byte that
cannot appear in either part, so two different field splits cannot produce the
same input:

```ts
const identity = digestSync(`${source}\0${captures}`)
```

Without a separator, `("ab", "c")` and `("a", "bc")` hash identically. For
structured values rather than two strings, canonicalize instead: see
[hash a structured value](./hash-a-structured-value.md).

## Use syncCrypto when the code already takes a Crypto service

Sometimes the derivation you want to run synchronously is already written as
an Effect that requires `EffectDigest.Digest`, because it is shared with the
asynchronous path. `syncCrypto` satisfies that requirement without a platform
layer:

```ts
import { syncCrypto } from "@smthrs/crypto"
import * as EffectDigest from "effect/crypto/Digest"
import * as Effect from "effect/Effect"

/** Provides the synchronous SHA-256 service to an Effect-shaped derivation. */
export const provideSync = <A, E>(
  effect: Effect.Effect<A, E, EffectDigest.Digest>
): Effect.Effect<A, E> => Effect.provideService(effect, EffectDigest.Digest, syncCrypto)

export const runSync = <A, E>(effect: Effect.Effect<A, E, EffectDigest.Digest>): A => Effect.runSync(provideSync(effect))
```

One derivation then serves both callers. The asynchronous path provides a
platform layer, the synchronous path provides `syncCrypto`, and the digest is
the same digest either way.

`syncCrypto` implements Digest for SHA-256. Other algorithms are rejected as
defects, and it supplies no SecureRandom service. Provide a platform layer for
other algorithms, secure random bytes, or UUIDv4.

## Know when not to use the synchronous path

- **Large inputs.** `digestSync` runs the compression function in JavaScript
  on the calling thread, so a large buffer blocks until it finishes. Prefer
  `digest` with a platform host, which hands the work to the host binding.
- **Ordinary Effect code.** If you are already inside an Effect, use `digest`
  and let the composition choose the host. The injected path is the default
  for a reason: it is the seam a test, a browser build, and a hardware module
  all attach to.
- **Anything but hashing.** `syncCrypto` is not a platform `Crypto` layer. It
  does not supply a SecureRandom service.

## Related

- [The injected hashing boundary](../concepts/injected-hashing.md): why the
  package has three doors and what each one is for.
- [Testing](../testing.md): `syncCrypto` is also the shortest way to hash in a
  test without a platform layer.

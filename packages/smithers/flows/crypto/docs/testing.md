---
title: "Testing"
description: "Hash deterministically in a test with syncCrypto, inject a failing Crypto service to exercise the typed failures, and read the evidence behind each guarantee."
---

Hashing is deterministic, so the only question a test has to answer is which
`Crypto` service the code under test receives.

## Hash without a platform layer

`syncCrypto` is the package's own implementation wearing the `Crypto`
interface. Provide it and the test hashes for real with no platform
dependency:

```ts
import { digest, syncCrypto } from "@smthrs/crypto"
import * as EffectDigest from "effect/crypto/Digest"
import * as Effect from "effect/Effect"

Effect.runSync(Effect.provideService(digest("abc"), EffectDigest.Digest, syncCrypto))
// "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
```

`Effect.runSync` works here because the whole operation is synchronous. Under
a platform layer the same program is asynchronous, so use `Effect.runPromise`
when you want to test against the real host.

Assert against published vectors rather than against a value you captured from
your own code. The empty string is
`e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` and `"abc"`
is `ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad`.

## Exercise the failure paths

Every failure `digest` reports comes from a host that misbehaved, so a test
reaches all of them by constructing a `Crypto` service that misbehaves on
purpose:

```ts
import * as EffectDigest from "effect/crypto/Digest"
import * as Effect from "effect/Effect"
import * as PlatformError from "effect/PlatformError"
import * as Hex from "effect/encoding/Hex"

type DigestService = typeof EffectDigest.Digest.Service
const host = (operation: DigestService["digest"]): DigestService =>
  EffectDigest.Digest.of({
    digest: operation,
    digestHex: (algorithm, data) => Effect.map(operation(algorithm, data), Hex.encode)
  })

// invalid_digest, naming the length it received.
const short = host(() => Effect.succeed(new Uint8Array(31)))

// digest_failed, keeping this failure as `cause`.
const hardware = PlatformError.systemError({
  _tag: "Unknown",
  module: "test-host",
  method: "digest",
  description: "hardware failure"
})
const broken = host(() => Effect.die(hardware))
```

Then flip the effect and match on the code, which is the stable part:

```ts
Effect.runSync(Effect.flip(Effect.provideService(digest("secret"), EffectDigest.Digest, short)))
// Sha256Error { code: "invalid_digest", ... }
```

The two input failures need no host at all: pass an unpaired surrogate for
`invalid_text` and a non-`Uint8Array` value for `invalid_input`.

## The evidence behind the contract

Each guarantee on [the contract](./contract.md) is stated as a fact because a
test holds the package to it. The tests are not in the published tarball, but
they are readable and runnable from the
[public repository](https://github.com/smithersai/smithers/tree/main/packages/smithers/flows/crypto/test):

- **Published vectors** for text and bytes through `digest`, `digestSync`, and
  the `Sha256` schema, including the million-character FIPS vector.
- **Parity** between `digestSync`, the injected path under Node, and
  `crypto.subtle.digest` in the same runtime.
- **Property tests** over arbitrary text and arbitrary byte views, asserting
  that the two entry points agree, that malformed text fails the same way on
  both, and that a subarray hashes exactly its own window.
- **Adversarial hosts**: a service that returns the wrong length, a non-byte
  value, a detached buffer, a non-Effect, a defect, or an output buffer it
  reuses and mutates between calls, plus one that mutates the bytes it was
  handed.
- **Redaction**: standalone `Sha256` issues omit parser input even with
  `reportInput: true`. Struct, Array, and Union tests pin parent input retention
  with that option and verify that outermost `reportInput: false` removes it,
  including sibling failures. Checks walk the complete issue tree and inspect
  JSON and `util.inspect` output for text and byte inputs.
- **Irreversibility**: encoding through the `Sha256` schema always fails with
  the exact forbidden-encode message.

The same tests run under Node and Bun, so both entry points are checked
against both hosts.

## Related

- [Hash inside synchronous code](./guides/hash-in-synchronous-code.md): the
  same `syncCrypto` seam, in production code.
- [Troubleshooting](./troubleshooting.md): the symptom-by-symptom list of what
  each failure means.

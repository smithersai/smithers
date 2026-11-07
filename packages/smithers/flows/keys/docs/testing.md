---
title: "Testing"
description: "Test code that derives keys: provide a deterministic Crypto layer, assert on the key literal, and exercise both derivation failures."
---

Derivation reads no clock, opens no socket, and touches no disk. The same input
produces the same key every time, so a test that derives one is an ordinary
unit test. The only thing it needs is a `Digest` service.

## Provide a Crypto layer

`@smthrs/crypto` ships a synchronous SHA-256-only service. It needs no platform
package, and because it does not suspend you can drive the whole test with
`Effect.runSync`:

```ts
import { syncCrypto } from "@smthrs/crypto"
import { deriveKey } from "@smthrs/keys"
import * as Crypto from "effect/crypto/Digest"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"

const crypto = Layer.succeed(EffectDigest.Digest)(syncCrypto)

const key = (material: unknown) => Effect.runSync(deriveKey(material).pipe(Effect.provide(crypto)))
```

A platform layer works the same way and produces the same keys: SHA-256 is
SHA-256. Use `NodeCrypto.layer` from `@effect/platform-node` when the code under
test already composes one.

## Assert on the key itself

The `key1_` derivation is frozen, so a key literal is a legitimate assertion,
and it is the one that catches an accidental change to your key material:

```ts
import { expect, it } from "vitest"

it("keys one compile under its own namespace", () => {
  expect(key({ domain: "cache/compile", version: 1, target: "web", flags: ["--minify"] }))
    .toBe("key1_a8a24926078622a3dc7a19ca9074b44d6ff55f8910ad6a2df9314922ab415a21")
})
```

If you later add a field to that material, this test fails, which is exactly
when you want to hear about it: every key already in your store was derived
from the old shape. Bump the material `version` deliberately and update the
literal. See
[Separate identity namespaces](./guides/separate-identity-namespaces.md).

Assert the equality property too, because it is the reason the key exists:

```ts
it("ignores member order", () => {
  expect(key({ domain: "cache/compile", version: 1, target: "web" }))
    .toBe(key({ target: "web", version: 1, domain: "cache/compile" }))
})
```

## Exercise both failures

`deriveKey` fails with a `KeyDerivationError` and nothing else, so `Effect.flip`
gives you the error directly. Bad material fails the same way on every attempt:

```ts
it("refuses material with no canonical form", () => {
  const error = Effect.runSync(deriveKey({ ledgerSeq: 42n }).pipe(Effect.flip, Effect.provide(crypto)))
  expect(error.code).toBe("canonicalization_failed")
})
```

The other code belongs to the host, so reach it with a `Digest` service that
refuses to hash:

```ts
import * as PlatformError from "effect/PlatformError"

const brokenCrypto = Layer.succeed(
  EffectDigest.Digest,
  Crypto.make({
    randomBytes: (size) => new Uint8Array(size),
    digest: () => Effect.fail(PlatformError.systemError({ _tag: "Unknown", module: "test-host", method: "digest" }))
  })
)

it("reports a host failure as digest_failed", () => {
  const error = Effect.runSync(deriveKey({ target: "web" }).pipe(Effect.flip, Effect.provide(brokenCrypto)))
  expect(error.code).toBe("digest_failed")
})
```

Match on `code`, never on `message`. See
[Handle a derivation failure](./guides/handle-a-derivation-failure.md).

## Validation needs no layer at all

`StoredKey`, `KeyV1`, and `digest` perform no hashing, so a test that covers a
storage boundary provides nothing:

```ts
import { StoredKey } from "@smthrs/keys"
import * as Schema from "effect/Schema"

it("rejects a key from a version it does not implement", () => {
  expect(() => Schema.decodeUnknownSync(StoredKey)("key2_" + "0".repeat(64))).toThrow()
})
```

## Why a key literal stays green across upgrades

The `key1_` derivation is frozen. Canonicalization, hashing, and framing cannot
change while the prefix stays the same, so the literal you assert on is a
stable expectation rather than a snapshot you have to refresh after every
release. Upgrading this package does not rewrite your keys.

It has to work that way, because the output is persisted. If a derivation
changed under you, every cache entry would miss, every replay would re-execute,
and every stored row would become unreachable under its new key. A new
derivation therefore gets a new prefix instead: see
[The wire format](./concepts/wire-format.md).

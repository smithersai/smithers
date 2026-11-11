---
title: "The injected hashing boundary"
description: "Why the cryptographic operation goes through Effect's Crypto service, why one entry point deliberately does not, and what the package checks about an answer it did not compute."
sidebar:
  order: 1
---

Hashing is host access. The bytes go somewhere the program does not control:
a Node binding, a Bun binding, a browser's Web Crypto, a hardware module. So
`digest` takes that implementation as a service rather than importing one:

```ts
import { digest } from "@smthrs/crypto"

digest("hello")
// Effect<Digest, Sha256Error, EffectDigest.Digest>
```

The `EffectDigest.Digest` in the requirement channel is the whole design. A test
provides a scripted service and never touches a platform binding. A browser
build provides Web Crypto. A fault-injection test provides a service that
fails, and the code under test does not change.

## Why one entry point does not inject

Some hashing is not host access in any meaningful sense: it happens inside a
pure, synchronous constructor that has no Effect to suspend in. A fingerprint
on a record you are about to return, a cache key derived while an object is
being assembled, the identity of one node in a tree you are building: each is
computed while a value takes shape, not while an effect is running.

`digestSync` serves exactly that case. It uses the package's own FIPS 180-4
implementation, so it needs no service and cannot suspend:

```ts
import { digestSync } from "@smthrs/crypto"

digestSync("hello")
// "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
```

The digest is the same digest: the same bytes, the same hash, the same
encoding, reached without suspending. That equality holds for every input both
entry points accept, which matters because the two paths compute it
differently.

That implementation is why the synchronous door can exist at all. It lives
behind a blocked `internal/` subpath, so every synchronous caller reaches the
same code through `digestSync` or `syncCrypto` instead of pasting in a hash
function of its own.

## The third door: syncCrypto

`syncCrypto` is the same synchronous implementation wearing the Effect `Digest`
interface, for code that already consumes the service and cannot suspend:

```ts
import { digest, syncCrypto } from "@smthrs/crypto"
import * as EffectDigest from "effect/crypto/Digest"
import * as Effect from "effect/Effect"

Effect.runSync(Effect.provideService(digest("hello"), EffectDigest.Digest, syncCrypto))
```

It is deliberately narrow. It implements `Digest` for SHA-256 and rejects other
algorithms as defects. It supplies no SecureRandom service. Provide a platform
layer when the program needs secure bytes, UUIDv4, or another digest algorithm.

## What the package checks about an answer it did not compute

An injected service is a boundary, and the package treats what crosses it as
untrusted. `digest` verifies four things about the host's answer, in order:
that the operation is an Effect at all, that it succeeded, that its value is a
`Uint8Array` that can be copied, and that there are exactly 32 bytes. Each
failure is a typed `Sha256Error` with a stable code, listed in
[the contract](../contract.md#what-the-injected-host-must-supply).

It also copies. The bytes going in are a snapshot, so a host that mutates its
argument cannot reach the caller's array. The bytes coming back are copied
before encoding, so a host that reuses one output buffer across calls cannot
rewrite a digest already returned, and an iterator the host defined on its
value is not consulted while that copy is made.

What none of this checks is whether the host actually computed SHA-256. There
is no way to verify that short of computing the hash, which would defeat the
injection. A service that returns 32 bytes of anything produces a digest this
package will return as valid. That is stated plainly in
[the contract](../contract.md#what-the-package-does-not-defend-against), and
it is the reason to provide a platform layer you trust.

## The one failure that is not a Sha256Error

A missing `Crypto` service is not a runtime failure. It stays an unsatisfied
Effect context requirement and surfaces as `Service not found: effect/crypto/Digest`,
because a composition that forgot to provide a host has a defect, not a bad
input. The distinction is deliberate: `Sha256Error` codes describe inputs and
hosts that behaved badly, and a program that branches on them should never
have to consider a wiring mistake among them.

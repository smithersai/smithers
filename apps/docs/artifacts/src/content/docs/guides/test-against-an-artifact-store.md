---
title: "Test against an artifact store"
description: "Use the in-memory store as the default test tier, the no-op stores with per-method overrides to script a refusing host, and a real loopback server to exercise the HTTP tier."
sidebar:
  order: 5
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/artifacts/docs/guides/test-against-an-artifact-store.md"
---

Every tier in this package is a value you construct, so a test swaps the tier
rather than mocking a module. Three substitutions cover almost everything:
memory for a real directory, a no-op with overrides for a refusing host, and a
loopback server for the shared tier.

## Use the memory store as the default

`ArtifactStore.makeMemory()` needs no directory, no temporary files, and no
cleanup, and it computes real digests through the same `Crypto` service the
filesystem store uses:

```ts
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as ArtifactStore from "@smthrs/artifacts/ArtifactStore"
import * as Effect from "effect/Effect"

const payload = new TextEncoder().encode("a step's output")

const roundTrip = Effect.gen(function*() {
  const store = ArtifactStore.makeMemory()
  const digest = yield* store.put(payload)
  return new TextDecoder().decode(yield* store.get(digest))
})

const result = await Effect.runPromise(roundTrip.pipe(Effect.provide(NodeCrypto.layer)))
```

It copies on both boundaries, so a test that mutates the array it put still
reads the original bytes back. What it does not do is verify a read, because
its address space is private and cannot disagree with itself. A test that needs
a corrupt address needs the filesystem store and a directory to tamper with, as
in the [Quickstart](/quickstart/#corrupt-a-blob-then-heal-it).

To assert on the address without hard-coding a digest, measure it the same way
the store does:

```ts
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as ArtifactStore from "@smthrs/artifacts/ArtifactStore"
import * as Effect from "effect/Effect"

const expectedAddress = await Effect.runPromise(
  ArtifactStore.measureBytes(new TextEncoder().encode("payload")).pipe(Effect.provide(NodeCrypto.layer))
)
```

## Script a refusing host with the no-op stores

`makeNoop` fails every operation with an `unavailable` `ArtifactStoreError`,
and takes per-method overrides, so a test states exactly the one behavior it
cares about:

```ts
import * as ArtifactStore from "@smthrs/artifacts/ArtifactStore"
import * as Effect from "effect/Effect"

/** A store whose reads always refuse, to prove a caller does not fall through. */
export const offline = ArtifactStore.makeNoop({
  get: () =>
    Effect.fail(
      new ArtifactStore.ArtifactStoreError({ code: "unavailable", message: "the host filesystem is offline" })
    )
})
```

`ArtifactSweep.makeNoop` and `ArtifactSweep.layerNoop` work the same way:

```ts
import * as ArtifactSweep from "@smthrs/artifacts/ArtifactSweep"
import * as Effect from "effect/Effect"

/** A sweep that enumerates nothing, so a collector's empty path is exercised. */
export const sweepless = ArtifactSweep.layerNoop({
  inventory: Effect.succeed([])
})
```

Use these to pin the distinctions the combined store makes. A local tier whose
`get` fails with `ArtifactStoreError` must not fall through to the shared tier;
one that fails with `ArtifactMissing` must.

## Compose two memory tiers

`CombinedArtifacts` does not care what its tiers are, so the whole read-through
and write-back contract is testable with two maps:

```ts
import * as ArtifactStore from "@smthrs/artifacts/ArtifactStore"
import * as CombinedArtifacts from "@smthrs/artifacts/CombinedArtifacts"
import * as Effect from "effect/Effect"

const shared = Effect.gen(function*() {
  const local = ArtifactStore.makeMemory()
  const remote = ArtifactStore.makeMemory()
  return yield* CombinedArtifacts.make({ local, remote })
})
```

Seed the remote tier, read through the combination, and then probe the local
tier's `has` to prove whether the download policy wrote back.

## Exercise the HTTP tier over a real socket

`RemoteArtifacts` accepts plain HTTP only for a loopback host. To exercise the
HTTPS authority a deployment declares, run a loopback HTTP server and rewrite
that authority onto its port, so the request, body, status code, and
connection are all real and only TLS termination is missing:

```ts
import * as Layer from "effect/Layer"
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient"

/** The real fetch transport, with a declared HTTPS authority mapped to `port`. */
const transport = (port: number) =>
  Layer.provide(
    FetchHttpClient.layer,
    Layer.succeed(
      FetchHttpClient.Fetch,
      ((input, init) => {
        const href = input instanceof URL ? input.href : typeof input === "string" ? input : (input as Request).url
        const url = new URL(href)
        url.protocol = "http:"
        url.host = `127.0.0.1:${port}`
        return globalThis.fetch(url, init)
      }) as typeof globalThis.fetch
    )
  )
```

Then build the store against `https://cas.test` and provide `transport(port)`.
A stub `HttpClient` is the right tool for header-by-header assertions about a
single request; a real socket is the only way to assert that an interrupted
transfer resumes from the prefix a real server kept.

## What not to stub

Do not replace the digest check. It is the invariant the whole package exists
to hold, and a test that stubs it proves nothing about the code that ships. To
test the corruption path, corrupt a real blob and let the real `get` refuse it.

Do not stub the `Crypto` service to return a constant either. Real digests are
cheap, and a constant digest makes deduplication, `findMissing`, and the
corruption check all indistinguishable from each other.

## Related

- [Quickstart](/quickstart/): the corruption and repair path against a real
  directory.
- [The three tiers](/concepts/tiers/): the distinctions your assertions
  should pin.
- [API reference](/reference/api/): every constructor and its overrides.

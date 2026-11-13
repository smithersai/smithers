---
title: "Installation"
description: "Install @smthrs/keys, provide the Effect Digest service that derivation requires, and pick an import form."
sidebar:
  order: 1
---

## Install the package

```bash
npm install @smthrs/keys@next effect
```

The `next` tag carries the 1.0 release candidates.

`@effect/platform-node` provides `NodeCrypto` for the example below and is
optional if you supply your own `Digest` implementation.

[`effect`](https://effect.website) is a peer dependency at exactly `4.1.1`,
because the schemas this package exports have to be the ones your own code
composes with. Two more dependencies install with the package and are the only
ones: [`@smthrs/canonical`](/api/canonical) for the serialization and
[`@smthrs/crypto`](/api/crypto) for the digest.

The package requires Node.js 22.19.0 or later and ships as ESM and CommonJS
with TypeScript declarations.

## Provide a Digest service

`deriveKey` and `DerivedKey` return an Effect that requires
`EffectDigest.Digest` from `effect/crypto/Digest`. The package imports no `node:` builtin
and ships no implementation of its own, which is what lets the same source
bundle for a browser. You choose where the hashing happens.

On Node.js or Bun, use the platform layer:

```ts
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { deriveKey } from "@smthrs/keys"
import * as Effect from "effect/Effect"

const program = deriveKey({ domain: "docs/install", version: 1 }).pipe(
  Effect.provide(NodeCrypto.layer)
)
```

Where you want no platform dependency at all, `@smthrs/crypto` ships a
synchronous SHA-256-only `Digest` service. It rejects every other digest
algorithm, so use it for identity construction and supply a platform digest
layer for other algorithms:

```ts
import { syncCrypto } from "@smthrs/crypto"
import { deriveKey } from "@smthrs/keys"
import * as EffectDigest from "effect/crypto/Digest"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"

const key = Effect.runSync(
  deriveKey({ domain: "docs/install", version: 1 }).pipe(
    Effect.provide(Layer.succeed(EffectDigest.Digest)(syncCrypto))
  )
)
```

In a browser, compose `BrowserCrypto` from `@effect/platform-browser`, or the
synchronous service above. [`@smthrs/platform-browser`](/api/platform-browser)
deliberately omits `Digest`, so it does not pick for you.

`StoredKey`, `KeyV1`, and `digest` require no `Digest` service. A boundary that
only validates keys installs nothing.

## Import forms

The root entry point re-exports every module:

```ts
import { DerivedKey, deriveKey, digest, KeyDerivationError, KeyV1, StoredKey } from "@smthrs/keys"
```

Every name is also importable from the `Key` subpath:

```ts
import * as Key from "@smthrs/keys/Key"
```

Two subpath forms are blocked in the export map and are not public:
`@smthrs/keys/internal/*` and `@smthrs/keys/*/index`.
`@smthrs/keys/package.json` is exported.

## Next step

Derive a key, store it, and read it back in the [Quickstart](./quickstart.md).

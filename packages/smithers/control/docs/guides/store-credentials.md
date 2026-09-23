---
title: "Store and resolve a credential"
description: "Keep a connection secret out of flow input, plan digests, journals, and model context: the reference that crosses the boundary, the store and cipher ports behind it, and the compare-and-set that serializes a rotation."
sidebar:
  order: 12
---

Credentials are capabilities. They must never enter flow input, plan digests,
journal payloads, or model context, so only a `CredentialRef` crosses the
browser-safe contract:

```ts
interface CredentialRef {
  readonly id: string
  readonly name: string
}
```

Plaintext exists in exactly two places: inside a `Redacted` handed to `create`
or `rotate`, and inside the `Redacted` returned by `resolve`.

## Compose the boundary

`Credential` composes two ports, and a host chooses an adapter for each:

```ts
import * as Credential from "@smthrs/control/Credential"
import * as CredentialStore from "@smthrs/control/CredentialStore"
import * as WebCryptoCipher from "@smthrs/control/WebCryptoCipher"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"

const credentials = Credential.layer().pipe(
  Layer.provide(Layer.merge(
    CredentialStore.layerMemory,
    WebCryptoCipher.layer({ key: Redacted.make(process.env["SMITHERS_CREDENTIAL_KEY"]!) })
  ))
)
```

| Port               | What it does                                                      | Adapters                                               |
| ------------------ | ----------------------------------------------------------------- | ------------------------------------------------------ |
| `CredentialStore`  | Persists an opaque sealed record, with compare-and-set on writes. | `layerMemory`, `SqlCredentialStore.layer`, `layerNoop` |
| `CredentialCipher` | Seals and opens the secret under host-managed keys.               | `WebCryptoCipher.layer`, `layerNoop`                   |

`Credential.layerNoop` is the whole boundary reporting `Unavailable`, which is
the honest composition for a host with no credential storage.

## Use it

```ts
const program = Effect.gen(function*() {
  const credentials = yield* Credential.Credential

  const reference = yield* credentials.create({
    id: "github-webhook",
    name: "GitHub webhook",
    secret: Redacted.make(incomingSecret)
  })

  // Only this call sees plaintext again.
  const secret = yield* credentials.resolve(reference)

  const rotated = yield* credentials.rotate(reference, Redacted.make(nextSecret))
  yield* credentials.revoke(rotated)
})
```

`list` and `get` answer references. `resolve` is the one operation that crosses
into a secret-bearing adapter boundary.

## Authorization is the host's

`Credential.layer({ authorize })` injects a policy hook, called with the
operation and the reference before anything else runs:

```ts
Credential.layer({
  authorize: (operation, reference) =>
    operation === "resolve" && !Option.exists(reference, allowed)
      ? Effect.fail(new Unauthorized({ message: "Not available to this caller" }))
      : Effect.void
})
```

The default allows every operation, which is correct for a single-principal
local process. The six operations are `list`, `get`, `create`, `resolve`,
`rotate`, and `revoke`.

A reference is also _authenticated_ on every operation: caller-owned fields are
snapshotted before policy effects run, and a forged or stale `CredentialRef` is
refused because the snapshotted name must still match the stored record. The
refusal for a missing credential and the refusal for a denied one are
deliberately indistinguishable, because telling an unauthorized caller which
ids exist is itself a leak.

## What is stored, and what is not

`SealedRecord` is everything at rest:

| Field         | Meaning                                                      |
| ------------- | ------------------------------------------------------------ |
| `id`, `name`  | Opaque metadata, and the cipher's authenticated data.        |
| `ciphertext`  | Base64, produced by the cipher.                              |
| `nonce`       | Base64, per record, never reused across versions.            |
| `version`     | Monotonic write counter, 1 for a freshly created credential. |
| `updatedAtMs` | When the record was last written.                            |

The key never reaches the store, so a stolen store is ciphertext and nothing
else. `WebCryptoCipher` holds it as a non-extractable `CryptoKey`, so it cannot
be read back out of the cipher either.

The id, name, and version are written beside the blob _and_ authenticated with
it, so moving a blob to another id, name, or version makes it unreadable.

## Rotation is serialized

Writes are compare-and-set on `version`. A writer that read version _n_ commits
version _n + 1_; a concurrent writer that read the same _n_ is refused with
`CredentialConflict` carrying both versions, rather than silently overwriting
the winner.

`SqlCredentialStore` does the read and the write in one transaction, so the
version a writer read and the row it guards cannot interleave.

## The key

`WebCryptoCipher` uses AES-256-GCM over the Web Crypto API, which is the
browser's own and has been Node's since v19, so this adapter imports nothing
from `node:*` and runs unmodified on a server. `Options.key` is 32 raw bytes,
base64-encoded, held redacted so it cannot be printed or serialized by
accident.

A host without Web Crypto, an old runtime or a locked-down worker, fails with
the typed `Unavailable` rather than a defect. A key that is not 32
base64-encoded bytes fails with `InvalidInput`.

A record that does not open fails with `PersistenceError` on operation
`credential.open`, and the host log records why. The message names a malformed
stored nonce, or a failed authentication: the key is not the one that sealed
the record, the record's id, name or version changed, or the ciphertext was
tampered with.

## Durable storage

```ts
import * as SqlCredentialStore from "@smthrs/control/SqlCredentialStore"

const store = SqlCredentialStore.layer
```

It requires `DurableWriter` and `SqlClient`, and creates `control_credentials`
on construction. The table is part of the package's
[migration set](./durable-storage.md), so a host that composes that set has it
already.

## Where to go next

- [Accept a webhook](./ingest-a-webhook.md): the caller that carries a
  `CredentialRef` into a signature verifier.
- [Store control state in a database](./durable-storage.md): the migration set
  the credential table belongs to.
- [Troubleshooting](../troubleshooting.md): what `Unavailable` and
  `CredentialConflict` mean in practice.

---
title: "Troubleshooting"
description: "The failures @smthrs/keys reports, what each one means, and the fix: canonicalization refusals, digest failures, rejected stored keys, and keys that will not match."
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/keys/docs/troubleshooting.md"
---

Every failure this package reports is typed. `deriveKey` fails with a
`KeyDerivationError` carrying one of two codes, and the schemas refuse a value
rather than coerce it. Nothing here fails silently.

The examples below use a namespace import:

```ts
import * as Keys from "@smthrs/keys"
```

## `canonicalization_failed`

**Symptom.** `deriveKey` fails with:

```text
[canonicalization_failed] Key input could not be canonicalized
```

**Cause.** The input holds something canonical serialization has no single
representation for, so there is no one right way to turn it into bytes. A
`bigint` is the common case: `deriveKey({ value: 1n })` fails here. Functions,
symbols, and `undefined` behave differently depending on their position:

| Position         | Canonical behavior                                                                                 |
| ---------------- | -------------------------------------------------------------------------------------------------- |
| Root-level value | Rejected with `canonical_unsupported_value`, reported by `deriveKey` as `canonicalization_failed`. |
| Object member    | Omitted; identity equals the member being absent.                                                  |
| Array element    | Replaced with `null`.                                                                              |

See the [canonical erasure table](/concepts/key-material/#distinctions-the-digest-never-sees).
The existing `test/Key.test.ts` test
"collapses an undefined-valued member into an absent member" pins this behavior:
`derive({ a: 1, b: undefined })` equals `derive({ a: 1 })`.

When two distinct requests share a key, check for omitted members. Before
deriving, validate required identity fields or encode an explicit sentinel
when the distinction must contribute to identity.

**Fix.** Convert the value to a canonical type before deriving. A `bigint`
becomes a string; a date becomes an ISO string or an epoch number. Choose the
representation deliberately, because the key is derived from exactly the bytes
you supply.

```ts
// Refused: no canonical form for a bigint.
Keys.deriveKey({ ledgerSeq: 42n })

// Accepted, and the string is now part of the identity.
Keys.deriveKey({ ledgerSeq: "42" })
```

The original schema failure is kept on `cause` as a `SchemaError`, so the
member that refused is available for diagnostics. The `message` never contains
the input, so it is safe to log.

## `digest_failed`

**Symptom.** `deriveKey` fails with:

```text
[digest_failed] Canonical key material could not be hashed
```

**Cause.** The input canonicalized, but the injected `Crypto` service could
not produce a SHA-256 digest. This is a failure of the runtime or of the
service you provided, not of the key material.

**Fix.** Check the `Crypto` layer in the composition. In a test this usually
means a stub that throws or returns the wrong shape; in a browser it can mean
the page is not in a secure context, so Web Crypto is unavailable. The
underlying failure is preserved on `cause`.

## A stored key is rejected

**Symptom.** `Schema.decodeUnknownSync(Keys.StoredKey)(value)` throws, with an
expectation reading:

```text
key1_ followed by a 64-character lowercase hexadecimal SHA-256 digest
```

**Cause.** The value is not a `key1_` key. The pattern is exact: the `key1_`
prefix, then 64 hexadecimal characters in lowercase. An uppercase digest, a
truncated one, or a key from another scheme all fail.

**Fix.** Do not hand-build keys. Derive them with `deriveKey`, which produces
the only form this release accepts. `StoredKey` is deliberately equal to
`KeyV1`: a second format joins that schema only when both its representation
and its derivation ship, so a value that fails today would not have validated
under some other version either.

## Two inputs that should match produce different keys

**Cause.** The key is derived from canonical bytes, so any difference in the
material is a difference in the key. These are all distinct:

```ts
Keys.deriveKey({ value: 1 }) // a number
Keys.deriveKey({ value: "1" }) // a string
Keys.deriveKey([1, 2]) // array order is significant
Keys.deriveKey([2, 1])
```

Object member order is not significant; canonicalization fixes it. Types,
array order, and string content all are.

**Fix.** Normalize before deriving, not after. If a number and its string
form must produce the same identity, pick one representation at the boundary
where the value enters your flow.

## Keys from different protocols collide

**Symptom.** Two unrelated identities derive to the same key because their
material happens to be structurally identical.

**Cause.** `deriveKey` hashes exactly what you give it. It adds no domain
separation of its own.

**Fix.** Include a stable domain and version in the material yourself.

```ts
Keys.deriveKey({ domain: "approval", v: 1, subject })
```

See [separate identity namespaces](/guides/separate-identity-namespaces/)
for the full pattern.

## The failure is a schema issue rather than a `KeyDerivationError`

**Cause.** Deriving inside a schema transform converts the typed failure into
an `InvalidValue` schema issue, keeping the `code` on it. This is intended: a
schema reports schema issues.

**Fix.** Read `code` from the issue to tell the two derivation failures apart,
exactly as you would on the error. See
[derive a key inside a schema](/guides/derive-a-key-inside-a-schema/).

## Encoding a derived key back is forbidden

**Cause.** The derivation schema is one way. Encoding is explicitly forbidden
rather than left undefined, because a key cannot be turned back into the
material it came from.

**Fix.** Keep the original material if you need it. Store it beside the key,
or re-derive from a source you still hold.

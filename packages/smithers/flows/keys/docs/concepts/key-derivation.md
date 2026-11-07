---
title: "Key derivation"
description: "What a key is, the three fixed steps that produce one, the equality it guarantees, and the four things it deliberately does not promise."
sidebar:
  order: 1
---

A key answers one question: are these two pieces of work the same work? It
answers it with a digest, so the answer travels. Two processes on two machines
in two releases reach the same conclusion without talking to each other, which
is what makes a durable cache, a deterministic replay, and a stable database
row possible at all.

## The three steps

Version one of the derivation is fixed. `deriveKey` performs exactly these
steps, in this order:

1. Serialize the input to RFC 8785 canonical JSON with
   [`@smthrs/canonical`](/api/canonical). Object keys sort by UTF-16 code unit,
   numbers get one formatting, and strings get one escaping.
2. Hash that exact canonical document as UTF-8 with SHA-256, through the
   injected Effect `Digest` service that [`@smthrs/crypto`](/api/crypto)
   wraps. No Unicode normalization is applied.
3. Prefix the 64 lowercase hexadecimal digest characters with `key1_`.

Nothing else contributes. There is no salt, no HMAC key, no timestamp, no
process identity, and no per-installation seed. That is what makes the
derivation reproducible, and it is also why a key is not a secret.

## What the derivation guarantees

**One canonical document, one key.** Equal canonical documents always produce
byte-identical keys. This is the property everything else rests on, and the
package tests it against arbitrary JSON, not just examples.

**Meaning, not spelling.** `{ b: 2, a: 1 }` and `{ a: 1, b: 2 }` are the same
document, so they are the same key. Canonicalization is what buys you this, and
it is also why the input has to be canonicalizable at all.

**A fixed width, always.** Every derived key is 69 characters:
`key1_` and 64 lowercase hexadecimal digits. The width does not vary with the
size or shape of the input.

**No path back.** `DerivedKey` refuses to encode. A digest cannot reconstruct
its input, so the schema says so instead of pretending.

## What it does not guarantee

**Distinctness.** SHA-256 is not injective. Two different canonical documents
could in principle share a key; the derivation inherits SHA-256's collision
resistance and claims nothing stronger. Where a collision would be a security
event rather than a cache miss, that is a property of your protocol, not of
this package.

**Secrecy.** The derivation is unkeyed and public. Anyone holding a candidate
input can derive the key and compare. A key therefore identifies work; it never
authenticates a holder. Never accept a key as proof that its bearer knew the
input, and never derive a key from a low-entropy secret and treat the result as
protected.

**A stable identity across formats.** The key of a value is stable for as long
as the derivation is. A future `key2_` format would derive a different key from
the same input, on purpose, so the two can never be confused. See
[the wire format](./wire-format.md).

**Anything about your input's shape.** Domain separation is yours. Two
protocols that both hash `{ id: 1 }` get the same key, because it is the same
document. See
[Separate identity namespaces](../guides/separate-identity-namespaces.md).

## Deriving and validating are different operations

`deriveKey` and `DerivedKey` hash. `StoredKey` and `KeyV1` validate. They are
separate exports because the failure mode of merging them is silent.

Hand a key to a derivation and it hashes the key text and returns a new,
different key. Nothing throws. A boundary that "parses" incoming keys that way
would rewrite every identity that crossed it, and the corruption would only
surface later as a cache that never hits or a row that can never be found
again. The package refuses to offer a single call that could mean either.

Validation therefore does no hashing at all, requires no `Digest` service, and
returns the input text unchanged. Derivation requires `Digest`, so the type
system tells you which one you are holding.

## Where this is used

The rest of Smithers is built on this operation. [`@smthrs/flow`](/api/flow)
mints the default execution id of an invocation from the flow tag and the
canonical form of its payload, so re-driving a crashed program re-attaches to
the run it left behind. [`@smthrs/engine`](/api/engine) derives the persisted
key of every action dispatch, folding in the declaration, the boundary
descriptor, and the cache environment so a changed declaration misses instead
of replaying a stale row. [`@smthrs/plan`](/api/plan) validates those keys at
its store boundary with `StoredKey`.

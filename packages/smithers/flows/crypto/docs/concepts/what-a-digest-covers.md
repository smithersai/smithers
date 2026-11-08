---
title: "What a digest covers"
description: "The exact bytes @smthrs/crypto hashes: UTF-16 well-formedness, UTF-8 encoding without normalization, byte views, snapshot timing, and the one-shot whole-buffer API."
sidebar:
  order: 2
---

A digest is a statement about a specific sequence of bytes. Two callers only
agree about a digest if they agree about which bytes it covers, so the package
is strict about how it gets from your value to those bytes.

## Text becomes UTF-8, and nothing else happens to it

A string is checked for well-formedness and then encoded as UTF-8 with the
host's `TextEncoder`.

The check rejects any unpaired UTF-16 surrogate with `invalid_text`. The
reason is collision, not tidiness: `TextEncoder` replaces a lone surrogate
with U+FFFD, so `"\ud800"` and `"\udfff"` would encode to identical bytes and
hash to the same digest despite being different strings. Refusing them keeps
every accepted string mapped to its own byte sequence.

Nothing else is applied. In particular the package performs **no Unicode
normalization**, so canonically equivalent text has different digests:

```ts
import { digestSync } from "@smthrs/crypto"

// U+00E9, then "e" followed by U+0301. Canonically equivalent, different bytes.
digestSync("\u00e9") === digestSync("e\u0301") // false
```

That is the right default for a package that hashes bytes, and it is a
requirement to know about if your protocol treats those two strings as one
value. Normalize before you call, and normalize on every side that computes
the digest.

## Bytes are taken exactly as viewed

`Uint8Array` is the only accepted byte input. `Buffer` works because it is a
`Uint8Array` subclass. `ArrayBuffer`, `DataView`, other typed arrays, plain
arrays, iterables, and streams are rejected with `invalid_input` rather than
coerced, because each would need a conversion rule that callers would then
have to agree on.

A view hashes its own window:

```ts
import { digestSync } from "@smthrs/crypto"

const backing = new Uint8Array([0xff, 0xff, 0x61, 0x62, 0x63, 0xff])
digestSync(backing.subarray(2, 5)) === digestSync(new TextEncoder().encode("abc"))
// true
```

## The snapshot, and when it is taken

The package hashes a copy, and the copy is taken at a defined moment:

- `digestSync` copies during the call, before it hashes.
- `digest` copies when its Effect **begins**, not when the Effect is
  constructed.

The second is the part worth holding on to. Building the Effect does nothing;
the snapshot happens at the start of execution, so a write to your array
between construction and execution is included, and a write after execution
starts is not:

```ts
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { digest } from "@smthrs/crypto"
import * as Effect from "effect/Effect"

const input = new TextEncoder().encode("abc")
const running = Effect.runPromise(digest(input).pipe(Effect.provide(NodeCrypto.layer)))
input.fill(0) // Too late: the snapshot was taken when the Effect began.
```

The snapshot also protects you in the other direction. The host receives the
copy, so a host that writes into the bytes it was handed leaves the caller's
array untouched.

## One shot, whole buffer

There is no incremental or streaming entry point. `digest` and `digestSync`
each require the complete input, and each holds the input and its snapshot in
memory at once. Hashing a file means reading the whole file first.

`digestSync` additionally runs the compression function in JavaScript on the
calling thread, so a large input blocks until it finishes. It stays correct
at any size, including a million-character input, but that is roughly the
scale at which to start preferring `digest` with a platform host.

## What a digest does not cover

A digest covers bytes. It does not cover the structure those bytes came from,
the field names you joined to build them, or the encoding you chose. Two
different structured values that serialize to the same bytes have the same
digest, which is why hashing an object starts with canonicalizing it: see
[hash a structured value](../guides/hash-a-structured-value.md).

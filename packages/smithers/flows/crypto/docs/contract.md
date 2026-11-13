---
title: "The crypto contract"
description: "What @smthrs/crypto guarantees about a SHA-256 digest, what the injected host must supply, and the attacks the package does not defend against."
---

The governing statement for `@smthrs/crypto`: what a digest from this package
means, what the package promises about it, and where those promises stop.

## What the package computes

`digest` and `digestSync` compute SHA-256 as specified in FIPS 180-4 over the
bytes described in [what a digest covers](./concepts/what-a-digest-covers.md),
and return the result as 64 lowercase hexadecimal characters branded as
`Digest`. There is no other output form, no truncation option, and no other
algorithm.

`digest` delegates the computation to the injected Effect `Crypto` service.
`digestSync` and `syncCrypto` use the package's own implementation, which is
not exported and is reachable only through those two entry points.

## What the package guarantees

- **One representation.** A value is a `Digest` only if it matches
  `^[0-9a-f]{64}$`. Uppercase, truncated, over-long, non-hexadecimal, and
  whitespace-padded values are rejected.
- **A snapshot, not your array.** `digest` copies byte input when its Effect
  begins, before the host is called; `digestSync` copies during the call.
  Mutating the caller's array afterwards cannot change an operation already in
  flight, and a host that mutates the bytes it was handed cannot reach back
  into the caller's array.
- **Exactly the viewed bytes.** A `Uint8Array` that is a subarray of a larger
  buffer hashes its own window and nothing around it.
- **A copied result.** Host output is copied before it is encoded, so a host
  that reuses one output buffer across calls cannot rewrite a digest you
  already hold, and an iterator the host defined on its value is not
  consulted while the copy is made.
- **Exactly 32 bytes from the host.** Any other length fails with
  `invalid_digest` rather than producing a short or padded digest.
- **Malformed text is refused, not replaced.** A string containing an unpaired
  UTF-16 surrogate fails with `invalid_text` before encoding, so two different
  malformed strings cannot collide on the digest of a replacement character.
- **Messages omit hash input.** Every `Sha256Error` message omits the hashed
  value. The `Sha256` schema sets `reportInput: false` for its own node only.
  When composing it inside a Struct, Array, or Union, callers must pass
  `reportInput: false` at the outermost decode boundary. With
  `reportInput: true`, enclosing issues can retain the original input object
  or array, even when only a sibling field fails validation. A child's parse
  options cannot redact a parent issue. See the
  [composition example](./guides/hash-a-structured-value.md#compose-the-sha256-schema).
- **Digests do not run backwards.** Encoding through the `Sha256` schema
  always fails with `A digest cannot be converted back into its source bytes`.
- **The two entry points agree.** `digest` and `digestSync` produce the same
  digest for every input both accept, including arbitrary text and any byte
  view, and both are cross-checked against Node and Web Crypto.

## What the injected host must supply

`digest` accepts a `Crypto` service that satisfies all of the following, and
fails with a typed `Sha256Error` when one does not hold:

| Requirement                                            | Failure when it does not hold                                       |
| ------------------------------------------------------ | ------------------------------------------------------------------- |
| `digest(EffectDigest.sha256, bytes)` returns an Effect | `digest_failed`, "returned a non-Effect SHA-256 operation"          |
| That Effect succeeds                                   | `digest_failed`, with the host failure or defect as `cause`         |
| Its success value is a `Uint8Array`                    | `invalid_digest`, "returned a non-Uint8Array SHA-256 digest"        |
| Those bytes can be copied                              | `invalid_digest`, "returned SHA-256 bytes that could not be copied" |
| There are exactly 32 of them                           | `invalid_digest`, naming the length it received                     |

The algorithm argument is Effect's `EffectDigest.sha256` value, whose `name`
is `"SHA-256"`, rather than the string itself.

A missing `Crypto` service is not on that list. It stays an unsatisfied Effect
context requirement, which surfaces as `Service not found: effect/crypto/Digest` and
is a composition defect rather than a runtime failure.

## What the package does not defend against

SHA-256 is a collision-resistant hash function and nothing more. This package
adds no key, no salt, and no iteration count, so everything below is outside
what it can protect.

- **Authentication.** A digest is not a message authentication code. Anyone
  who can guess the input can recompute the digest, so a digest alone proves
  nothing about who produced a message. Use HMAC or a signature.
- **Length extension.** SHA-256 is a Merkle-Damgard construction, and this
  package returns its full internal state. Given `digest(secret + message)`
  and the length of `secret`, an attacker can compute the digest of
  `secret + message + padding + suffix` without knowing `secret`. Never build
  a MAC by hashing a secret prefix.
- **Password and key material.** A single SHA-256 pass is fast by design.
  It is the wrong primitive for passwords, for stretching a low-entropy
  secret, and for deriving keys. Use a memory-hard KDF.
- **Hiding a low-entropy input.** A digest reveals nothing about a
  high-entropy input and everything about an input an attacker can enumerate.
  Hashing an email address, an account number, or a short identifier does not
  make it private.
- **Ambiguity in what you concatenated.** The package hashes exactly the bytes
  you hand it. If you build those bytes by joining fields yourself, two
  different structured values can produce identical bytes and therefore an
  identical digest. Canonicalize instead: see
  [hash a structured value](./guides/hash-a-structured-value.md).
- **A hostile or wrong `Crypto` service.** `digest` checks that the host
  returned 32 copyable bytes. It cannot check that those bytes are the
  SHA-256 of the input, so a wrong host produces a wrong digest that this
  package returns as valid. Provide a platform layer you trust, or use
  `digestSync`, which does not consult a host at all.
- **Timing and other side channels.** The package makes no constant-time
  claim, ships no digest comparison function, and comparing two digests with
  `===` is not a constant-time comparison.
- **Secrets in custom diagnostics.** Input reporting options suppress parser
  input fields, not arbitrary diagnostics. Original host and encoder failures
  remain available as `cause`; schema paths, custom messages, and annotations
  are not sanitized. Keep those free of secrets or sanitize them before
  serializing or inspecting a complete error. Descendant schemas must not
  re-enable `reportInput` when the outer boundary disables it.
- **Secrets left in memory.** The snapshot the package takes is ordinary
  garbage-collected memory. Nothing is zeroed after use, so hashing a secret
  leaves at least the input and its copy reachable until collection.
- **Validation of the implementation by a third party.** The internal
  implementation follows FIPS 180-4 and is pinned against published vectors,
  including the million-character vector, and against Node and Web Crypto
  under both Node and Bun. It is not a validated cryptographic module, and
  the package makes no audit claim.

## Failure codes

`Sha256Error.code` is stable and is the value to branch on. `message` is prose
and may change.

| Code                   | Raised by              | Meaning                                                               |
| ---------------------- | ---------------------- | --------------------------------------------------------------------- |
| `invalid_input`        | `digest`, `digestSync` | The input is neither a string nor a copyable `Uint8Array`.            |
| `invalid_text`         | `digest`, `digestSync` | The string contains an unpaired UTF-16 surrogate.                     |
| `text_encoding_failed` | `digest`, `digestSync` | The host `TextEncoder` threw.                                         |
| `digest_failed`        | `digest`               | The injected host failed, threw, died, or answered with a non-Effect. |
| `invalid_digest`       | `digest`               | The host result is not a copyable 32-byte array.                      |

`digestSync` raises only the first three, because it never consults a host.
Every code carries the original failure as `cause` where one exists. For the
symptom-by-symptom version, see [Troubleshooting](./troubleshooting.md).

## Boundaries with neighbouring packages

Canonical value serialization belongs to
[`@smthrs/canonical`](/api/canonical). Domain-specific key formats, including
the `key1_` prefix and its derivation, belong to [`@smthrs/keys`](/api/keys).
Content addressing over a digest belongs to
[`@smthrs/artifacts`](/api/artifacts). This package hashes bytes and validates
digests, and does nothing else.

## Callback resume identity compatibility

Callback resume shapes preserve implicit `arguments` and standard ECMAScript,
Node and browser host names (for example `fetch`, `eval`, `JSON`, `globalThis`,
`process`, `Buffer`, `require`, `localStorage` and `sessionStorage`) after
resolving explicit local bindings. Local shadowing and minifier binding renames remain equivalent;
unrecognized outer bindings still use first-use numbering. This uses an
explicit list, independent of which globals the current host installs.

A prefix update (`++` or `--`) after a line break following an `if`, `while`,
`for`, `for await` or `with` head remains that statement's body. An explicit
empty body (`;`) changes the shape and `resumeDigest`. After a real operand,
the same line break still ends the expression statement. A `do...while` tail
also keeps its statement boundary when its semicolon is omitted.

These corrections change `resumeDigest` for callbacks reading these globals
or using a prefix update after a statement head across a line break.
The exact-source `digest` is unchanged. Persisted identities are not rewritten:
an unchanged exact-source identity can still match, but a resume relying on
an old normalized identity can be refused as `plan_changed`. Keep the old
build available to finish such runs, or start a new run with the corrected
plan. Accepting the old conflated shape as a fallback would reintroduce the
`fetch` versus `eval` collision. Captured dependencies still need explicit
capture identities; source normalization cannot identify arbitrary closures.

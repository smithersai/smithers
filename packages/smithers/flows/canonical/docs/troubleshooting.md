---
title: "Troubleshooting"
description: "Every failure code @smthrs/canonical reports with its cause and its fix, plus the digest symptoms that are not failures: a digest that changed, a collision, and an error that leaked its input."
---

Every refusal is a `CanonicalError` whose message reads
`code: detail at path`. Find the code and read its section. Through the
`Canonical` schema the same text arrives inside a `SchemaError`, so the codes
below apply to both entry points.

The path grammar is the same everywhere: `$` is the root, `.name` is an
identifier-safe member, `["name"]` is any other member, `[0]` is an array
index, and `.toJSON()` is a step into the result of a `toJSON` method.

## canonical_nan and canonical_non_finite

```text
canonical_non_finite: Infinity at $.payload.cost
```

**Cause.** The value at that path is `NaN`, `Infinity`, or `-Infinity`. The
JSON number grammar has no form for any of them, and `JSON.stringify` writes
`null`, which would make a failed computation digest the same as a deliberate
absence. A boxed `new Number(NaN)` fails the same way.

**Fix.** Decide what the value means and encode that. `null` for a missing
measurement, a tagged object such as `{ kind: "unbounded" }` for an unbounded
limit. See
[Non-finite numbers](./guides/prepare-a-value.md#non-finite-numbers).

## canonical_bigint

```text
canonical_bigint: BigInt at $.blockHeight
```

**Cause.** JSON has no `bigint`. `JSON.stringify` throws on one, and this
serializer refuses it, boxed or not.

**Fix.** Encode it as a string with `.toString()`. A number loses precision
above `Number.MAX_SAFE_INTEGER`, which is why the value was a `bigint`.

## canonical_lone_surrogate

```text
canonical_lone_surrogate: lone surrogate in key at $["\ud800"]
```

**Cause.** A string carries an unpaired surrogate code unit, as a member name
or as a value. UTF-8 encoders commonly replace it with U+FFFD, so two different
strings would encode to the same bytes and digest identically. The detail says
`key` or `value`, and a path ending in `.toJSON()` means the string was minted
during serialization rather than present in the input.

**Fix.** Find where the string was truncated. Slicing a string by code unit
splits surrogate pairs, so `text.slice(0, 100)` can cut an emoji in half. Slice
by code point instead: `[...text].slice(0, 100).join("")`. If the bytes are
genuinely binary, encode them as base64 rather than as text.

## canonical_circular

```text
canonical_circular: circular reference at $.b.a
```

**Cause.** The value at that path is an ancestor of itself, so it has no finite
serialization. The path is where the cycle closes.

**Fix.** Break the cycle before hashing: replace the back reference with an
identifier, or digest a projection of the structure rather than the structure
itself. Note that sharing is not a cycle. Two members pointing at one object
serialize fine.

## canonical_unsupported_value

```text
canonical_unsupported_value: Set at $.input.tags
canonical_unsupported_value: undefined at $
```

**Cause.** Two different situations share this code.

At a path other than `$`, the value is a built-in or class instance whose
`JSON.stringify` form is lossy enough to collide: `Map`, `Set`, `WeakMap`,
`WeakSet`, `ArrayBuffer`, a typed array, `RegExp`, an `Error` or a subclass, or
any object whose prototype is neither `Object.prototype` nor `null`. The detail
names the constructor, or `non-plain object` when the constructor name is
unavailable.

At `$`, the root value is `undefined`, a function, or a symbol. The serializer
must return a string and those have no representation. Inside an object or an
array the same values are dropped or written as `null` instead of failing.

**Fix.** Convert the value to JSON data, or give the type a `toJSON` method.
[Convert a value the serializer refuses](./guides/prepare-a-value.md) covers
each kind, including the tagging that keeps the conversion from creating a
collision.

## canonical_depth_exceeded

```text
canonical_depth_exceeded: depth 10,001 exceeds 10,000 at $.child.child...
```

**Cause.** The value nests more than 10,000 levels below the root. Every
member, element, and `toJSON` result counts as one level. The bound belongs to
this package rather than to the host's call stack, so it is the same on every
runtime.

**Fix.** A value this deep is almost always a linked structure that should be a
flat list, or an accidental accumulation such as a wrapper applied in a loop.
Flatten it. Raising the bound is not an option a caller has, and would not
help: the digest of a 10,000-level structure is not something a consumer can
work with either.

## canonical_tojson_threw

```text
canonical_tojson_threw: nope at $.x
```

**Cause.** The `toJSON` method on the value at that path threw. The original
error is preserved as the `CanonicalError`'s `cause`.

**Fix.** Read `cause` for the underlying error and fix the method. A `toJSON`
that can fail is a poor fit for a digest, because whether a value has an
identity would depend on when you asked.

## canonical_getter_threw

```text
canonical_getter_threw: boom at $.x
```

**Cause.** Reading the value at that path threw. That covers an accessor
property, a `toJSON` that is itself a throwing getter, a proxy `get`,
`ownKeys`, or `getPrototypeOf` trap, and a `length` read on a proxied array.
The original error is preserved as `cause`.

**Fix.** Read `cause`, then decide whether the value should be digested at all.
A getter that throws under serialization usually means the object is a live
view of something (a request, a connection, a lazily loaded record) rather than
data. Digest a plain snapshot of the fields you care about instead.

## canonical_malformed

```text
canonical_malformed: Unexpected token } in JSON at position 1
```

**Cause.** Encoding through the `Canonical` schema was handed a string that
does not parse as JSON. This only happens on the unknown-string path
(`Schema.encodeUnknownSync` or `Schema.encodeUnknownEffect`): a value carrying
the `Canonical` brand was minted by decoding and always parses. The detail is
the runtime's own parse message, so its wording varies by host.

**Fix.** Encode the document a decode produced, not text assembled by hand. If
the string came from storage, the stored bytes were altered after they were
digested; treat it as corrupt rather than repairing it.

## My digest changed and the value did not

The value probably did change, in one of the places `JSON.stringify` semantics
reach through:

- **An array that is really a set.** Array order is preserved, so a member
  built by iterating a `Set` or an object digests differently when insertion
  order changes. Sort it.
- **A `Date`.** `Date.prototype.toJSON` renders the instant to millisecond
  precision, so a value that is "now" is different on every call.
- **A field that is sometimes absent and sometimes `undefined`.** Both produce
  the same document, but a field that is sometimes `null` produces a different
  one.
- **A floating point computation.** Two arithmetic paths that agree to fifteen
  digits still produce different shortest forms, and therefore different bytes.

If none of those apply and the digest changed across a dependency upgrade,
compare the canonical documents rather than the digests. A byte diff names the
member that moved.

## Two different values digest the same

The serializer applies `JSON.stringify` semantics, which coerce before they
compare:

- A `Date` and its ISO string are the same document.
- `{ a: 1 }` and `{ a: 1, b: undefined }` are the same document.
- A class instance with an untagged `toJSON` and a plain object of the same
  shape are the same document.

Add a discriminating field to whichever value should be distinct. Where the
coercion itself is unacceptable, add a pre-check that refuses values
`JSON.stringify` would reshape, the way [`@smthrs/model`](/api/model) does for
sealed model requests.

## The error message contains my input

A schema issue retains the rejected value only when the decode is given
`reportInput: true`. In `effect@4.0.0-rc.112` nothing retains it by default,
and this package adds no parse options of its own, so a plain decode is not
where your input came from. Pass `reportInput: false`, or annotate a schema you
own with `parseOptions: { reportInput: false }`, to hold that policy against a
caller who asks for retention.

Neither redacts the custom issue message or a thrown `CanonicalError`, which is
the usual source. Those carry the path and the original exception text whatever
`reportInput` is set to.

Paths embed caller-supplied member names. A record keyed by a token or an email
can disclose that key when a nested value fails. This example uses a fake token:

```ts
import { Canonical, CanonicalError, canonicalize } from "@smthrs/canonical"
import * as Schema from "effect/Schema"

const input = { records: { SYNTHETIC_SECRET_KEY: { value: NaN } } }

try {
  canonicalize(input)
} catch (error) {
  if (error instanceof CanonicalError) {
    error.path // "$.records.SYNTHETIC_SECRET_KEY.value"
    error.code // "canonical_nan": the default diagnostic to report
  }
}

Schema.decodeUnknownSync(Canonical)(input, { reportInput: false })
// throws SchemaError whose message still contains SYNTHETIC_SECRET_KEY

Schema.decodeUnknownSync(Canonical)({
  toJSON() {
    throw new Error("SYNTHETIC_SECRET_VALUE")
  }
}, { reportInput: false })
// throws SchemaError whose message still contains SYNTHETIC_SECRET_VALUE
```

The final two calls are separate failing examples. Getter and `toJSON`
exception text is copied into the custom message, and a direct `CanonicalError`
also preserves the original `cause`. Treat every path segment, `message`, and
`cause` text as caller-controlled and potentially sensitive.

Report only the stable code by default. Allowlist or redact any path segments
and exception details before a log or RPC boundary. A length cap alone does not
remove secrets. See
[Limit diagnostic disclosure](./guides/use-the-schema.md#limit-diagnostic-disclosure)
for reporting examples and the current control RPC behavior.

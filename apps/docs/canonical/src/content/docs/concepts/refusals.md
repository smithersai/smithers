---
title: "Why the serializer refuses"
description: "The reasoning behind each class of refusal: collisions from lossy built-ins, unpaired surrogates, cycles and depth, and why the checks live in the serializer rather than in a pre-pass."
sidebar:
  order: 2
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/canonical/docs/concepts/refusals.md"
---

`canonicalize` fails rather than approximates. A best-effort string for a value
with no canonical form still hashes, and the digest it produces disagrees with
whatever another host computed for the same value. A refusal is loud and local;
a silent disagreement surfaces later as a cache that never hits or an approval
that never validates.

Each refusal below is a class of value where emitting something would be worse
than emitting nothing.

## A lossy built-in collides with an ordinary object

`JSON.stringify` does not fail on a `Map`, a `Set`, or a typed array. It
renders them, and it renders them lossily:

```ts
JSON.stringify(new Map([["a", 1]]))
// => '{}'
JSON.stringify(new Set([1, 2]))
// => '{}'
JSON.stringify(new Uint8Array([1, 2, 255]))
// => '{"0":1,"1":2,"2":255}'
```

A populated `Map` and an empty object produce the same bytes, so they produce
the same digest. A typed array produces the same bytes as a plain object with
numeric keys. In a digest library that is a collision: two different values
that name the same work.

So this package refuses them, by name, with the value's path:

```text
canonical_unsupported_value: Set at $.input.tags
```

The rule generalizes past the built-ins. Any object whose prototype is neither
`Object.prototype` nor `null` is refused and named by its constructor, because
`JSON.stringify` would flatten it to its own enumerable members and lose the
class that distinguished it. `RegExp`, `Error` and its subclasses, `WeakMap`,
`WeakSet`, and `ArrayBuffer` are refused for the same reason. An `Error`
subclass reports its concrete constructor, so the message names the value that
actually leaked in.

## `toJSON` is the escape hatch, and `Date` uses it

A value's own `toJSON` runs before any of those checks, exactly as
`JSON.stringify` orders them. That is why `new Date(0)` serializes rather than
failing: `Date.prototype.toJSON` returns an ISO string, and the serializer
never sees a `Date`.

The same door is open to your own types. A class with a `toJSON` method is
serialized as whatever that method returns, from either the instance or the
prototype:

```ts
class Money {
  readonly cents: number
  constructor(cents: number) {
    this.cents = cents
  }
  toJSON(): { kind: string; cents: number } {
    return { kind: "money", cents: this.cents }
  }
}

canonicalize({ price: new Money(500) })
// => '{"price":{"cents":500,"kind":"money"}}'
```

Note what the `kind` field buys: without it, a `Money` and a plain
`{ cents: 500 }` would digest identically. `toJSON` decides the bytes, so it
also decides which values are distinguishable. Tag the shapes you need to keep
apart.

## A lone surrogate is not text

An unpaired surrogate is a code unit with no character behind it. UTF-8
encoders do not agree on what to do with one, and the common answer is to
replace it with U+FFFD, which means two different strings can encode to the
same bytes. A digest over those bytes cannot distinguish them.

So a string carrying an unpaired surrogate is refused as a member name, as a
value, and anywhere else it appears:

```text
canonical_lone_surrogate: lone surrogate in key at $["\ud800"]
```

## The checks live in the serializer, not in a pre-pass

A caller could scan a value for bad strings before serializing it. That scan
cannot be complete, because `toJSON` mints strings during serialization that no
pre-pass ever saw:

```ts
canonicalize({ toJSON: () => "\ud800" })
```

There is no lone surrogate in the input value. There is one in the document
that would be emitted. Putting the well-formedness check inside the serializer
is what makes the promise hold for every string it emits, not just for the
strings the caller handed it.

The same reasoning covers the other in-flight refusals. A getter or a proxy
trap that throws becomes `canonical_getter_threw` at the path where it threw,
and a `toJSON` that throws becomes `canonical_tojson_threw`, both carrying the
original error as `cause`. Neither escapes as a raw exception from somewhere
inside the walk, because a caller that only knows "something threw" cannot say
which member was at fault.

## A cycle and a depth bound are both about termination

A value that contains itself has no finite serialization, so a cycle is refused
at the path where the value is re-entered. Sharing is not a cycle: two members
pointing at one object are serialized, and validated, at each occurrence.

The depth bound is the same concern with a number attached. A host's call stack
overflows at a depth that varies by runtime and by build, and the failure it
raises is a `RangeError` that names nothing useful. This serializer walks
iteratively and refuses at a fixed 10,000 levels below the root:

```text
canonical_depth_exceeded: depth 10,001 exceeds 10,000
```

The bound is the package's, so every runtime accepts and refuses exactly the
same documents. That determinism is the point: a value that canonicalizes on a
laptop must canonicalize in CI.

## Every refusal carries a path

The failure is a `CanonicalError` with a stable `code` and a JSON-style `path`:
`$` for the root, `.name` for an identifier-safe member, `["name"]` for any
other member, `[0]` for an array index, and `.toJSON()` for a step into a
`toJSON` result. Report only the stable `code` by default. Member names are
caller-supplied, so every path segment must be treated as untrusted and may be
sensitive. The `message` and original `cause` text can also contain caller data.
`reportInput: false` suppresses Schema input rendering only, without redacting
paths or exception text. See
[Limit diagnostic disclosure](/guides/use-the-schema/#limit-diagnostic-disclosure)
for allowlisting and redaction before a log or RPC boundary.

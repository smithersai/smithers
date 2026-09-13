---
title: "Canonicalize inside an Effect pipeline"
description: "Decode with the Canonical schema instead of calling canonicalize: typed failures in the error channel, the branded document type, composing a derived schema, and limiting diagnostic disclosure."
sidebar:
  order: 2
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/canonical/docs/guides/use-the-schema.md"
---

`canonicalize` throws. The `Canonical` schema does the same serialization and
puts the failure in an Effect error channel instead, as a `SchemaError` whose
message carries the same code and path. Use the schema when the surrounding
code is Effect, and the function when it is not.

Every example here is Effect 4. The package declares `effect@4.0.0-rc.115` as a
peer dependency, and modules such as `effect/SchemaGetter` and
`effect/SchemaIssue` exist only in that line. See
[Installation](/installation/).

## Decode a value

```ts
import { Canonical } from "@smthrs/canonical"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

const decode = Schema.decodeUnknownEffect(Canonical)

const documentEffect: Effect.Effect<Canonical, Schema.SchemaError> = decode({ b: 2, a: 1 })

const document: Canonical = Effect.runSync(documentEffect)
// => '{"a":1,"b":2}'
```

The success value is branded. Only decoding through `Canonical` produces the
brand, so a function that takes a `Canonical` cannot be handed a string that
merely looks like JSON:

```ts
const hash = (document: Canonical): Effect.Effect<string> => sha256(document)

hash("{\"a\":1,\"b\":2}")
// Type error: string is not assignable to Canonical.
```

## Encode a document back

The encode direction takes the document itself, not the Effect that produced
it, and parses it into a plain JSON value:

```ts
Schema.encodeUnknownSync(Canonical)(document)
// => { a: 1, b: 2 }
```

The round trip is lossy in exactly the way JSON is lossy: what went in as a
`Date` comes back as a string, and a dropped `undefined` member does not
return.

## Handle both branches

For a caller that wants the failure as a value rather than as a short circuit:

```ts
import * as Result from "effect/Result"

const attempt = (value: unknown): Result.Result<Canonical, Schema.SchemaError> =>
  Effect.runSync(Effect.result(decode(value)))
```

Outside Effect entirely, `Schema.decodeUnknownSync(Canonical)(value)` throws
the `SchemaError` directly.

## Map to a typed failure

A `SchemaError` says the value was not canonicalizable. It does not say what
your caller should do about it. Map it to a failure your domain names, the way
[`@smthrs/keys`](https://keys.smithers.sh/reference/api/) does when key derivation fails:

```ts
class FingerprintError extends Schema.TaggedError<FingerprintError>()(
  "app/FingerprintError",
  { path: Schema.String, code: Schema.String }
) {}

const fingerprint = (value: unknown): Effect.Effect<Canonical, FingerprintError> =>
  decode(value, { reportInput: false }).pipe(
    Effect.mapError(() => new FingerprintError({ path: "$", code: "canonicalization_failed" }))
  )
```

## Limit diagnostic disclosure

Canonicalized values can contain secrets, including in member names. Treat
every path segment, `message`, and original `cause` text as caller-controlled
and potentially sensitive.

**Input retention is opt-in.** In `effect@4.0.0-rc.115` a schema issue keeps
the rejected value only when the decode is given `reportInput: true`, and this
package adds no parse options of its own. Writing `reportInput: false` changes
nothing on a bare decode; write it to hold that policy against an option a
caller or an enclosing schema supplies:

```ts
decode(value, { reportInput: false })
```

Pin it on a schema you own with
`.annotate({ parseOptions: { reportInput: false } })`, so no caller can turn
retention on.

`reportInput` governs the retained input and nothing else. Whatever it is set
to, the custom issue message still carries the path and the original getter or
`toJSON` exception text.

**Report only the stable code by default.** For errors from `canonicalize`,
construct a diagnostic containing only the failure identifier:

```ts
import { CanonicalError } from "@smthrs/canonical"

const issueOf = (cause: unknown): string => cause instanceof CanonicalError ? cause.code : "canonicalization_failed"
```

A `SchemaError` has no `CanonicalError.code` field. Map it to a fixed domain
code, as in `fingerprint` above, instead of forwarding its message.

**Allowlist or redact any additional fields before logging or RPC.** This
example allows only complete paths whose segments are public schema names.
Any other path, including one containing a dynamic record key, is replaced in
full. All message and cause text is replaced with a constant:

```ts
import { CanonicalError } from "@smthrs/canonical"

const publicPaths = new Set(["$", "$.input", "$.input.tags"])

const detailedIssueOf = (cause: unknown) => {
  if (!(cause instanceof CanonicalError)) return { code: "canonicalization_failed" }
  return {
    code: cause.code,
    path: publicPaths.has(cause.path) ? cause.path : "$[redacted]",
    message: "[redacted]",
    cause: "[redacted]"
  }
}
```

Keep this allowlist application-owned; do not populate it from input. If you
retain selected dynamic segments or exception details, apply an explicit
allowlist or redaction policy to each before constructing the diagnostic.
Cap the sanitized result as well: a path grows with depth, but limiting its
length does not remove sensitive data.

[`@smthrs/control`](https://control.smithers.sh/reference/api/) currently forwards `cause.path` and the code
over RPC with a length cap. That behavior can disclose caller-supplied member
names; it is not a redaction guarantee. Apply the boundary policy above before
forwarding diagnostics in your own integrations.

## Compose a derived schema

Because `Canonical` is an ordinary codec, a derived identity is a schema
transformation rather than a function callers must remember to apply. Map the
canonicalization failure into a schema issue using the fixed domain code and
root path from `fingerprint`, and pin the retention policy on the schema:

```ts
import * as SchemaGetter from "effect/SchemaGetter"
import * as SchemaIssue from "effect/SchemaIssue"

const Fingerprint = Schema.Unknown.pipe(
  Schema.decodeTo(Schema.String, {
    decode: SchemaGetter.transformEffect((value) =>
      fingerprint(value).pipe(
        Effect.mapError((error) => new SchemaIssue.InvalidValue({ message: `[${error.code}] ${error.path}` }))
      )
    ),
    encode: SchemaGetter.forbidden(() => "A fingerprint cannot be converted back into its input")
  })
).annotate({
  identifier: "app/Fingerprint",
  parseOptions: { reportInput: false }
})
```

`Schema.decodeTo` with a forbidden encode is the right shape whenever the
derivation is one way. [`@smthrs/keys`](https://keys.smithers.sh/reference/api/) builds its `DerivedKey`
schema exactly this way: a key can be derived from its input, and never
recovered from it.

## What the schema adds, and what it does not

The schema decodes through the same serializer, so every rule in
[The serialization contract](/serialization/) applies unchanged. It adds
three things: the branded type, the failure in the error channel, and
composability with other schemas. It changes no bytes.

---
title: "Handle a permission failure"
description: "Branch the three typed failures a guarded host call can add, recover one from Effect's PlatformError channel, and render it for a log without letting a resource forge a second line."
sidebar:
  order: 2
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/capability/docs/guides/handle-a-permission-failure.md"
---

`Permission.PermissionError` is the union of the three failures the permission
kernel adds to a guarded host call. A service that names it in its own error
channel, as [`@smthrs/jj`](https://jj.smithers.sh/reference/api/) does with `JjError | PermissionError`,
forces every caller to decide what each one means.

## Branch the union

Switch on `_tag`. The three cases call for three different responses, and
collapsing them loses the difference between "ask a person", "the answer is no",
and "nobody could answer":

```ts
import { Permission } from "@smthrs/capability"

const describe = (error: Permission.PermissionError): string => {
  switch (error._tag) {
    case "@smthrs/capability/PermissionRequired":
      // Suspend the run and show the request. `capability`, `tier`, and
      // `requestId` are what an approval surface needs.
      return `waiting on ${error.requestId}`
    case "@smthrs/capability/PermissionDenied":
      // Policy or the capability ceiling refused. Retrying changes nothing.
      return `refused: ${error.reason}`
    case "@smthrs/capability/GrantStoreError":
      // The store could not decide. Branch on the stable `code`.
      return `store ${error.code}`
  }
}
```

| Failure              | What it means                                                  | What to do                                                                     |
| -------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `PermissionRequired` | The decision was `ask`. The operation did not happen.          | Park the run, show `capability` and `tier` to a person, resolve `requestId`.   |
| `PermissionDenied`   | A rule or the capability ceiling said no. `reason` says which. | Fail the operation. A retry produces the same answer.                          |
| `GrantStoreError`    | Registering, persisting, or resolving the request failed.      | Treat as unavailable, not as a denial. Read `code` to decide whether to retry. |

`GrantStoreError.code` is one of `duplicate_request`, `request_not_found`,
`journal_failed`, `store_closed`, or `invalid_resolution`. Its `message` and
`cause` are operation context for a persistence adapter; they are optional, so
branch on `code`.

## Recover a failure from the platform channel

Effect owns the `FileSystem` and `ChildProcessSpawner` tags, and their error
channel is fixed to `PlatformError`. The kernel decorates those tags in place
rather than minting new ones, so a guarded filesystem call fails with a
`PlatformError` whose structured cause is the permission failure:

```ts
import { Capability, Permission } from "@smthrs/capability"
import { Option } from "effect"

const denied = Permission.permissionDenied(
  Capability.make("fs:write", "/etc/hosts"),
  "outside the workspace"
)

const projected = Permission.toPlatformError({
  module: "FileSystem",
  method: "writeFileString",
  pathOrDescriptor: "/etc/hosts",
  error: denied
})

Option.isSome(Permission.fromPlatformError(projected))
// true
```

The structured permission failure is preserved in the projection. The normalized reason is always
`PermissionDenied`, meaning the operation did not happen because the kernel
refused, suspended, or could not decide it. `description` carries the
`Permission.formatError` rendering, and `cause` carries the failure itself, so
an attended surface still gets back the original `capability`, `tier`,
`requestId`, and `reason`.

`fromPlatformError` accepts any `PermissionDenied` reason whose cause passes
`isPermissionError`, including a foreign error never passed to `toPlatformError`.
It returns the original cause as `PermissionErrorPayload`, or `Option.none()`
when the reason tag or structure does not match. Recovery validates structure,
not origin. Across a trust boundary, establish the producer or request identity
separately before acting on the recovered request.

## Recognize a failure at a boundary

Use `Permission.isPermissionError` where a value arrives as `unknown`: a caught
defect, an RPC payload, a journal row. It checks the exact enumerable shape,
not the `_tag` alone, so it accepts a structurally valid failure produced by
another copy of this dual-published package and rejects an extra field, a
wrong-typed field, a missing `meta`, or an overlong capability resource. It
rejects accessors on known fields and checks metadata descriptors at every
depth without calling getters. Required fields must be own data properties;
optional inherited fields are rejected except the empty default `Error.message`
on a schema-identified grant-store error. The grant-store `cause` remains
opaque context.

The refinement promises data fields through `Permission.PermissionErrorPayload`.
A wire record has no Effect iterator or class operations. Import
`decodePermissionError` from `@smthrs/capability` and call
`decodePermissionError(payload)` to construct an error you can
`yield*` in `Effect.gen`; it returns `Option.none()` for invalid data or metadata
exceeding the constructor limits. The resulting instance also passes
`Schema.is(Permission.PermissionError)`.

## Render one line for a log

```ts
Permission.formatError(denied)
// "permission_denied: fs:write:/etc/hosts: outside the workspace"
```

The three renderings are:

```text
permission_required: <action:resource> (tier <tier>, request <requestId>)
permission_denied: <action:resource>: <reason>
grant store <code>: <message>
```

`formatError` escapes C0/C1 controls, Unicode format characters (`Cf`, including
bidi controls), and line/paragraph separators (`Zl`/`Zp`). Newlines render as
`\n`; U+2028 and U+202E render as `\u2028` and `\u202E`. These characters
cannot introduce raw line breaks or bidi controls into the diagnostic.
Each encoded field is capped at `Permission.maxDisplayFieldLength` (256 UTF-16
code units), including the visible `…[truncated]` marker. Other non-ASCII text
passes through unchanged.

`toPlatformError` applies the same escaping and limit to `module`, `method`,
and string `pathOrDescriptor` fields, so the complete `PlatformError.message`
has the same one-line guarantee. Numeric descriptors are unchanged. The raw
capability resource remains in `reason.cause` and is recovered by
`fromPlatformError`; the projected path is display text.

## Put only journal-safe context in `meta`

`PermissionRequired.meta` reaches the grant journal, so it accepts only
JSON-representable values and rejects anything else at the construction site,
naming the key, rather than later at the persistence boundary:

- An object property whose value is `undefined` is dropped, mirroring
  `JSON.stringify`, so a host can pass an optional field it does not have.
- An `undefined` array element is rejected, because serializing it would change
  it to `null` rather than omit it.
- A `bigint`, a `Date`, a `Map`, or a class instance is rejected rather than
  flattened into an empty object.
- Own `__proto__` data properties are preserved, including in nested objects.
- The maximum depth is 16, counting the metadata root as depth 0.
- At most 1024 object properties and array elements are accepted in total.
  Dropped `undefined` properties still count toward this work limit.
- Serialized metadata is limited to 64 KiB of UTF-8 JSON, including keys,
  punctuation and escapes, after dropping undefined properties.
- Shared references reuse one frozen copy. Each occurrence counts toward depth,
  members and serialized bytes, so a compact graph cannot expand past the limits.
- A cycle or exceeded limit raises a schema error naming the field at
  construction, before journal encoding.

Construction takes a deep-frozen snapshot and never retains your object, and
the `meta` and `capability` slots are non-writable. Mutating the object you
passed does not change the failure.

## Related

- [Effect tiers](/concepts/effect-tiers/): what `tier` on a suspended
  request tells the person answering it.
- [The `@smthrs/kernel` reference](https://kernel.smithers.sh/reference/api/): the grant store that produces
  these failures and the layers that decorate host services.

# @smthrs/capability

Release candidate scope, host requirements and compatibility review are defined in the [library support policy](https://github.com/smithersai/smithers/blob/main/RELEASE_SUPPORT.md).

**Documentation:** https://github.com/smithersai/smithers/tree/main/packages/smithers/flows/capability/docs

Capability values and permission failures: the vocabulary a program uses to
decide whether one operation may proceed.

A `Capability` names one exact operation, such as `fs:write` on
`/workspace/out.txt`. A `CapabilityPattern` names a set someone approved, such
as `fs:write` on `/workspace/**`. One pure function reduces ordered rules over
those two values into `allow`, `deny`, or `ask`, and three typed failures carry
the answer back to a caller.

The package also exports `CapabilitySet` from its root. It represents
intersections of capability-pattern groups; `CapabilitySet.attenuate` narrows
the ambient ceiling for an Effect without widening its parent authority.

The package performs no I/O. It reads no files, opens no sockets, and enforces
nothing. Its one runtime dependency is
[`@smthrs/canonical`](https://github.com/smithersai/smithers/tree/main/packages/smithers/flows/canonical/docs), and
[`effect`](https://effect.website) is a peer in the range `effect@4.1.1`.
It bundles for a browser unchanged. Enforcement, the grant store, the layers
that decorate host services, and the journal live in
[`@smthrs/kernel`](https://github.com/smithersai/smithers/tree/main/packages/smithers/flows/kernel/docs).

## Install

Published on npm under the `next` tag. Install it with its `effect` peer:

```sh
npm install @smthrs/capability@next effect@4.1.1
```

Name `@next` explicitly: `latest` still points at an older release candidate.

## Decide one request

```typescript
import { Capability, Permission } from "@smthrs/capability"

const rule = (effect: Permission.RuleEffect, action: Capability.PatternAction, resource: string) =>
  new Permission.Rule({ effect, pattern: new Capability.CapabilityPattern({ action, resource }) })

const policy = [
  rule("allow", "fs:read", "/workspace/**"),
  rule("allow", "fs:write", "/workspace/**"),
  rule("deny", "fs:write", "/workspace/.git/**")
]

Permission.evaluate([policy], Capability.make("fs:read", "/workspace/README.md"))
// "allow"
Permission.evaluate([policy], Capability.make("fs:write", "/workspace/.git/config"))
// "deny"

const deploy = Capability.make("net:post", "https://api.example.test/deploy")
Permission.evaluate([policy], deploy)
// "ask": nothing matched it, so a person has to answer
```

An `ask` becomes a typed failure the caller raises instead of proceeding,
carrying the effect tier an approval surface shows a person:

```typescript
const tier = Capability.tierOf(deploy, { workspaceRoot: "/workspace" })
// "irreversible"

Permission.formatError(Permission.permissionRequired({
  requestId: "req-1",
  capability: deploy,
  tier,
  meta: { flow: "deploy", attempt: 1 }
}))
// "permission_required: net:post:https://api.example.test/deploy (tier irreversible, request req-1)"
```

## Modules

Import `Capability`, `CapabilitySet` and `Permission` from the
`@smthrs/capability` root entry point.

| Module          | Contents                                                                                                                                                                                                                                                                                                         |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Capability`    | `Capability`, `CapabilityPattern`, `Action`, `PatternAction`, `EffectTier`, `TierOptions`, `maxResourceLength`, `maxMatchWork`, `make`, `format`, `parse`, `parsePattern`, `patternFromCapability`, `withinMatchBudget`, `matches`, `subsumes`, `tierOf`, `requiresIdempotencyKey`.                              |
| `CapabilitySet` | Capability-pattern group intersections, authority comparisons and scoped attenuation.                                                                                                                                                                                                                            |
| `Permission`    | `PermissionRequired`, `PermissionDenied`, `GrantStoreError`, `GrantStoreErrorCode`, the `PermissionError` union and its schema, `Rule`, `RuleEffect`, `evaluate`, `permissionRequired`, `permissionDenied`, `isPermissionError`, `formatError`, `maxDisplayFieldLength`, `toPlatformError`, `fromPlatformError`. |

Full reference: <https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/capability/docs/api.md>.

## Contracts

These behaviours decide authorization and durability. Each is a guarantee of
the exported symbol; this list is the short form.

**Text form.** `format` renders both a `Capability` and a `CapabilityPattern`
as `action:resource` and throws on an action outside the closed vocabulary.
`parse` reads back an exact capability and `parsePattern` reads back a pattern.
Both require every component and return `Option.none()` on anything else,
including a missing resource. The action is the first two colon-separated
components, except for the whole-authority selector `*`, which is the first
component alone; all remaining text, colons included, is the resource.

```typescript
import { Capability } from "@smthrs/capability"

Capability.format(Capability.make("net:get", "example.test:8443/api:v1"))
// "net:get:example.test:8443/api:v1"
Capability.parsePattern("*:**")
// Option.some(CapabilityPattern { action: "*", resource: "**" })
Capability.parse("fs:read")
// Option.none()
```

**Glob grammar.** `*` matches any run of UTF-16 code units, path separators and
newlines included. `?` matches exactly one code unit, so an astral character
needs two. A pattern ending in a space and `*` also matches the bare resource
without its argument text, which is what makes the `proc:spawn` grant `npm *`
cover bare `npm`. That grant also covers every subcommand and any appended
`; cmd` or `&& cmd` text, so grant commands exactly. Apart from an identical resource, `**` is the only form
`subsumes` can prove. A grant written `/workspace/*` matches
`/workspace/src/a.ts` but can never be shown to cover it, so an envelope built
from `*` patterns proves only those same patterns and re-prompts for everything
else.

**There is no escape.** A resource that genuinely contains `*` or `?` cannot be
granted exactly, so `net:get:https://api.test/v1?k=1` reads as an exact URL and
is a one-character wildcard. Never build a pattern by concatenating
agent-supplied text. `patternFromCapability` derives the exact grant and returns
`Option.none()` for a resource the grammar cannot express or whose literal
pattern fails the filesystem path checks. Relative paths such as `./src`,
`src/./a`, and `a/../b` cannot be granted exactly; canonicalize them in the
adapter before constructing the request. The resource `.` remains accepted.

**Paths and case.** Matching compares the pattern against the whole resource
byte-exactly over UTF-16 code units. It performs no path normalization and no
case folding, so `\` is an ordinary character that never matches `/`, and
`A:/x` never matches `a:/X`.

**Size and cost.** Matching costs O(pattern length times resource length) in the
worst case. Exact and pattern resources reject anything longer than
`maxResourceLength` (4096 UTF-16 code units) at construction and decode.
Adapters reject or summarize larger host values before authorization.
`maxMatchWork` is the fail-closed guard for unchecked structural inputs;
`withinMatchBudget` reports the case and `evaluate` denies it.

**Tiers.** `tierOf` decides containment lexically, so it cannot see symlinks: a
caller that materializes snapshots resolves real paths first. A `workspaceRoot`
that normalizes to `.` or the empty string has no boundary and fails closed to
`irreversible`, so pass an absolute root. Only `irreversible` effects require an
idempotency key to retry.

**Errors.** `isPermissionError` validates the whole shape, not the `_tag` alone,
because the package ships dual cjs and esm and class identity is not stable for
a dual-package consumer. `permissionRequired` and `PermissionRequired.new`
accept only JSON-representable metadata, drop undefined-valued object properties, snapshot
the result deeply, freeze the snapshot, and never retain the caller's object.
Undefined array elements are still rejected. These factories and
`permissionDenied` / `PermissionDenied.new` defensively copy capabilities
into non-writable slots; the request's `meta` slot is non-writable too.
`decodePermissionError` provides the same guarantees for transported data.
Direct class construction and Effect schema decoding do not provide these
snapshots, non-writable slots or metadata limits. A value the journal could
not encode fails at the factory call naming the key. `formatError` escapes C0/C1 controls, Unicode format
characters (`Cf`, including bidi controls), and line/paragraph separators
(`Zl`/`Zp`), and doubles a literal backslash so the text `\n` never reads as a
newline. Each encoded field is capped at `maxDisplayFieldLength`, including
the truncation marker. `toPlatformError` applies the same rules to `module`,
`method`, and string `pathOrDescriptor` fields, keeping the complete message
free of raw line separators and bidi controls. The raw capability resource
remains in the structured cause; the projected path is display text.

**Stable identity.** The schema ids and the `action:resource` text `format`
renders are identity, not display text: a stored decision keeps those exact
strings and is read back through them. Render capability text with `format`
rather than assembling it yourself.

---
title: "Validate capability text from an untrusted source"
description: "Read capability and pattern strings out of config, an RPC, or a journal with parse, parsePattern, and the exported schemas, and reject what does not belong."
sidebar:
  order: 3
---

Capability text arrives from places you do not control: a policy file an
operator edits, flow frontmatter, an RPC payload, a journal row written by an
older build. This guide is how to read it without widening anything.

## Parse, and treat `Option.none()` as a rejection

`Capability.parse` reads an exact capability. `Capability.parsePattern` reads a
pattern. Both return `Option`, and neither guesses:

```ts
import { Capability } from "@smthrs/capability"
import { Option } from "effect"

Capability.parse("fs:read:/workspace/README.md")
// Option.some(Capability { action: "fs:read", resource: "/workspace/README.md" })
Capability.parse("fs:read")
// Option.none(): no resource component
Capability.parse("fs:delete:/a")
// Option.none(): not an action

Capability.parsePattern("fs:*:/workspace/**")
// Option.some(CapabilityPattern { action: "fs:*", resource: "/workspace/**" })
```

The shape both readers follow: the action is the first two colon-separated
components, and every remaining character, colons included, is the resource. So
`net:get:example.test:8443/api:v1` parses to the resource
`example.test:8443/api:v1`, and `Capability.format` renders it back byte for
byte.

An empty resource is legal (`fs:read:` parses to the resource `""`); a missing
one is not (`fs:read` is rejected). A leading colon is rejected. A resource
longer than `Capability.maxResourceLength` is rejected here, exactly as it is
at construction and at decode.

## Know the one sentinel

`parsePattern` has a single special case. The whole-authority action `*`
occupies the first component alone, and the bare string `*` parses to
`{ action: "*", resource: "**" }`:

```ts
Capability.parsePattern("*")
// Option.some(CapabilityPattern { action: "*", resource: "**" })
Capability.parsePattern("*:**")
// the same value
```

The bare `*` is how a source that declares no capabilities of its own is
written down, and it is stored and read back verbatim rather than rewritten, so
this parser is the one place its meaning is defined. The resource is `**`
rather than `*` because `Capability.subsumes` proves that `**` covers every
resource, while `*` proves only an identical `*`. Apart from that one string, a
missing component is still a rejection.

## Validate a bare selector with the exported schemas

When a payload carries an action, a tier, or a rule effect as a bare string,
validate it with the schema rather than copying the list into your own code:

```ts
import { Capability, Permission } from "@smthrs/capability"
import { Schema } from "effect"

Schema.is(Capability.Action)("fs:read")
// true
Schema.is(Capability.Action)("fs:delete")
// false
Schema.is(Capability.PatternAction)("fs:*")
// true
Schema.is(Capability.EffectTier)("compensable")
// true
Schema.is(Permission.RuleEffect)("maybe")
// false
```

`Capability.Capability`, `Capability.CapabilityPattern`, `Permission.Rule`, and
the three failure classes are schemas too, so a journal payload decodes through
them. Decoding enforces both the closed action vocabulary and the resource
length bound, which is what stops an unknown action from being read as
something adjacent:

```ts
Schema.decodeUnknownResult(Capability.Capability)({ action: "fs:delete", resource: "/a" })
// a Failure
```

## Refine a value you already hold

For a value that arrives as `unknown` at a runtime boundary rather than as data
to decode, `Permission.isPermissionError` is the refinement. It validates the
whole enumerable shape, so it accepts a structurally valid failure from another
copy of this dual-published package and rejects a forgery with an extra field.
See [Handle a permission failure](./handle-a-permission-failure.md).

## Extend the grammar in one direction only

A consumer may accept a shorthand its own users write, as long as the shorthand
only ever narrows or restates what this grammar already means.
[`@smthrs/chain`](/api/chain) does exactly one of these: a declared claim with
two components and no resource (`fs:read`, `fs:*`) claims the whole family, so
it re-reads as `fs:read:**`. Everything else goes through `parsePattern`
unchanged, and an unparseable claim asks rather than proceeding.

Keep the base grammar as the only reader of stored text. A second parser is a
second answer to "what does this string grant".

## Related

- [Resource globs](../concepts/resource-globs.md): what the resource half of a
  parsed pattern means.
- [Grant a capability safely](./grant-a-capability-safely.md): going the other
  direction, from a request to a pattern.

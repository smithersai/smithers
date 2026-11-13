---
title: "Quickstart"
description: "Decide one request against a policy: parse operator patterns into rules, evaluate a capability, classify its effect tier, and render the failure a suspended request produces."
sidebar:
  order: 2
---

This quickstart turns three lines of operator configuration into a policy, runs
three requests through it, and produces the typed failure a host raises when a
request needs a person. Nothing here talks to a filesystem, a network, or a
model: the package decides, and the caller acts. Each step below is TypeScript; the
[VibeLang tab](#the-same-walkthrough-in-vibelang) runs the same steps as Effect
code.

## Prerequisites

- Node.js 22.19.0 or later.
- The package and its `effect` peer installed:
  `npm install @smthrs/capability@next effect@4.1.1`.

## Parse the configured patterns into rules

Operators write patterns as text. `Capability.parsePattern` reads that text
back, and it returns `Option.none()` rather than guessing, so an unusable line
fails at load rather than at the first request:

```ts
import { Capability, Permission } from "@smthrs/capability"
import { Option } from "effect"

const configured: ReadonlyArray<string> = [
  "fs:read:/workspace/**",
  "fs:write:/workspace/**",
  "proc:spawn:npm install"
]

const ruleFor = (effect: Permission.RuleEffect, declared: string): Permission.Rule => {
  const pattern = Capability.parsePattern(declared)
  if (Option.isNone(pattern)) {
    throw new Error(`Not a capability pattern: ${declared}`)
  }
  return new Permission.Rule({ effect, pattern: pattern.value })
}

const policy = configured.map((declared) => ruleFor("allow", declared))
```

`proc:spawn:npm install` reads as the action `proc:spawn` and the resource
`npm install`.
The action is the first two colon-separated components; everything after them,
colons included, is the resource.

## Decide three requests

`Permission.evaluate` takes ordered rulesets and one exact capability:

```ts
const requests = [
  Capability.make("fs:read", "/workspace/README.md"),
  Capability.make("proc:spawn", "npm install"),
  Capability.make("net:post", "https://api.example.test/deploy")
]

for (const request of requests) {
  console.log(Capability.format(request), Permission.evaluate([policy], request))
}
```

```text
fs:read:/workspace/README.md allow
proc:spawn:npm install allow
net:post:https://api.example.test/deploy ask
```

The first two are covered. The third matched no rule, and the default for an
unmatched request is `ask`, not `deny` and never `allow`.

## Classify the effect and suspend the request

An `ask` decision means a person has to answer. Before you ask, classify what
the operation costs, because the tier is what an approval surface shows and
what decides whether a retry needs an idempotency key:

```ts
const deploy = Capability.make("net:post", "https://api.example.test/deploy")
const tier = Capability.tierOf(deploy, { workspaceRoot: "/workspace" })
// "irreversible"
Capability.requiresIdempotencyKey(tier)
// true

const suspended = Permission.permissionRequired({
  requestId: "req-1",
  runId: "run-7",
  capability: deploy,
  tier,
  meta: { flow: "deploy", attempt: 1 }
})

console.log(Permission.formatError(suspended))
```

```text
permission_required: net:post:https://api.example.test/deploy (tier irreversible, request req-1)
```

`permissionRequired` accepts only JSON-representable `meta` values and takes
a deep-frozen snapshot rather than retaining your object.
`Permission.formatError` escapes control characters and caps each field, so an
agent-chosen resource cannot forge a second log line.

## Add a rule the run cannot talk its way past

`evaluate` takes a list of rulesets. `rulesets[0]` is configured policy; later
rulesets are the grants a session or a tool has accumulated. Within all of them
the last matching rule wins, with one exception: once configured policy reduces
to `deny`, no later grant lifts it.

```ts
const guarded = [...policy, ruleFor("deny", "fs:write:/workspace/.git/**")]
const session = [ruleFor("allow", "fs:write:/workspace/.git/config")]
const write = Capability.make("fs:write", "/workspace/.git/config")

Permission.evaluate([guarded], write)
// "deny"
Permission.evaluate([guarded, session], write)
// "deny"
Permission.evaluate([guarded, session], Capability.make("fs:read", "/workspace/.git/config"))
// "allow"
```

The read still succeeds. The deny rule names the action `fs:write`, so it never
selects a read, and the `fs:read:/workspace/**` allow still covers the path.

## The same walkthrough in VibeLang

In [VibeLang](https://github.com/smithersai/vibelang) an unusable pattern is a
typed failure instead of an exception: `ruleFor` is an `effect` function that
fails with a `NotAPattern` error, so loading the policy fails in the error
channel and a caller recovers it with `catch`. Deciding, classifying and
rendering stay plain functions, because none of them can fail.

This is `examples/vibe/quickstart.vibe`. `test/quickstart.test.vibe` runs it, and
the package's docs check fails if this block and the file differ.

```vibe
import { Capability, Permission } from "@smthrs/capability"

/** Operator text the capability grammar does not accept. */
export error NotAPattern { declared: string }

/** Reads one configured pattern into a rule, failing instead of guessing a default. */
export effect function ruleFor(effect: Permission.RuleEffect, declared: string): Permission.Rule!NotAPattern {
  const pattern = Capability.parsePattern(declared)
  if (Option.isNone(pattern)) throw new NotAPattern({ declared })
  return new Permission.Rule({ effect, pattern: pattern.value })
}

/** The configured policy: read and write inside the workspace, and run one exact command. */
export effect function loadPolicy(configured: ReadonlyArray<string>): ReadonlyArray<Permission.Rule>!NotAPattern {
  return try forEach(configured, (declared) => ruleFor("allow", declared))
}

/** Decides each request and pairs it with its text form. */
export const decide = (
  policy: ReadonlyArray<Permission.Rule>,
  requests: ReadonlyArray<Capability.Capability>
): ReadonlyArray<string> =>
  requests.map((request) => `${Capability.format(request)} ${Permission.evaluate([policy], request)}`)

/** Classifies an undecided request and renders the failure a host raises while a person answers. */
export const suspend = (request: Capability.Capability, requestId: string): string => {
  const tier = Capability.tierOf(request, { workspaceRoot: "/workspace" })
  const failure = Permission.permissionRequired({ requestId, capability: request, tier, meta: { flow: "deploy" } })
  return Permission.formatError(failure)
}

/** Decides a request under configured policy, a final deny, and a session's grants. */
export effect function decideWithSession(
  policy: ReadonlyArray<Permission.Rule>,
  request: Capability.Capability
): Permission.RuleEffect!NotAPattern {
  const guarded = [...policy, try ruleFor("deny", "fs:write:/workspace/.git/**")]
  const session = [try ruleFor("allow", "fs:write:/workspace/.git/config")]
  return Permission.evaluate([guarded, session], request)
}
```

## What just happened

You built a policy out of text, reduced it to one decision per request, and
turned the undecided request into a typed failure a host can raise, a surface
can display, and a journal can store. Three properties did the work, and each
one is a deliberate refusal to guess:

- An unparseable pattern is `Option.none()`, not a default.
- An unmatched request is `ask`, not `allow`.
- A configured `deny` is final, not the current leader.

## Next steps

- [The authorization model](./concepts/authorization-model.md): how a decision
  is reduced, and where it fails closed.
- [Grant a capability safely](./guides/grant-a-capability-safely.md): turn the
  request you just suspended into a grant that covers it and nothing more.
- [Resource globs](./concepts/resource-globs.md): what `*`, `?`, and `**` mean,
  and the three edges the grammar does not make obvious.

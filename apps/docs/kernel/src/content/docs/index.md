---
title: "@smthrs/kernel"
description: "A capability kernel for Effect hosts: it decorates the filesystem, process, network, path, and Jujutsu service tags in place, so every side effect is checked against a grant store before it runs and refused with a typed error when nobody authorized it."
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/kernel/docs/README.md"
---

`@smthrs/kernel` puts a permission check in front of every side effect an
[Effect](https://effect.website) program can reach. It wraps the five service
tags a host provides, `FileSystem`, `Path`, `ChildProcessSpawner`, `HttpClient`,
and `Jj`, with middleware that names the operation as a capability, asks a grant
store whether it may proceed, and refuses it with a typed error when no rule
allows it and nobody is there to ask. Four of those tags are Effect's own; `Jj`
is the [Jujutsu](https://jj-vcs.github.io) repository port from
[`@smthrs/jj`](https://jj.smithers.sh/reference/api/).

## What it solves

Running code you did not write, an agent's plan, a plugin, a generated build
script, means every file write and every spawned process needs an answer to one
question: did anyone authorize this. The usual way to enforce that answer is a
second, protected service, and to tell every caller to use it. That breaks on
the first dependency that never heard of your kernel and reaches for the
ordinary `FileSystem` tag instead.

This package decorates the ordinary tag in place. Once the layer is composed,
the guarded implementation _is_ what the tag resolves to, so there is no
unguarded one left to reach for. Code that calls `fs.readFileString` is checked
without ever mentioning permission.

A yes or no answer is not enough on its own, so the kernel also closes the gaps
around it:

- **Confinement.** A path is authorized as a canonical resource and the
  operation runs through a pinned directory descriptor, so a symlink or a
  rename between the decision and the call cannot redirect it.
- **Containment.** A cancelled run signals its children, escalates to
  `SIGKILL` on a deadline, and records each child in a durable ledger, so a
  host that dies leaves orphan records its successor can reap.
- **A ceiling that only narrows.** `CapabilitySet.attenuate` bounds what a
  fiber may ask for, and no public operation widens it again.
- **Grants that outlive the process.** A decision is written to a journal
  before it takes effect, so a permission a person chose to remember is still
  in force after a restart.

## Install

`@smthrs/kernel` is not on npm at 1.0.0-rc.0. Its source lives in the
[smithers repository](https://github.com/smithersai/smithers), and
[Installation](/installation/) covers how to depend on it from a checkout,
the import forms, and the three test subpaths.

The package needs Node.js 26.4.0 or later. It carries no platform
implementations of its own, so a composition that reaches a real machine also
adds a bundle such as [`@smthrs/platform-node`](https://platform-node.smithers.sh/reference/api/).

## Refuse an operation nobody authorized

This program composes the kernel over `@smthrs/testing/TestHost`. Add
`"@smthrs/testing": "workspace:*"` to the consuming package's devDependencies
before running it. The policy allows reads under the workspace and says
nothing about writes:

```ts
import { Capability, GrantStore, HostServices, Permission, Workspace } from "@smthrs/kernel"
import * as TestHost from "@smthrs/testing/TestHost"
import { Effect, FileSystem, Layer } from "effect"

const rules = [
  new Permission.Rule({
    effect: "allow",
    pattern: new Capability.CapabilityPattern({ action: "fs:read", resource: "/workspace/**" })
  })
]

const guarded = HostServices.layer.pipe(
  Layer.provide(Layer.orDie(GrantStore.layer({ attended: false, rules }))),
  Layer.provideMerge(TestHost.layer({ files: { "/workspace/README.md": "# hello" } })),
  Layer.provide(Workspace.layer("/workspace"))
)

/** Ordinary Effect code. Nothing here knows a kernel exists. */
const program = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const readme = yield* fs.readFileString("/workspace/README.md")
  yield* fs.writeFileString("/workspace/out.txt", readme)
})

Effect.runPromise(program.pipe(Effect.provide(guarded), Effect.scoped))
```

The read returns `"# hello"`. The write never reaches the filesystem. Effect
fixes that method's error channel to `PlatformError`, so the kernel projects
its refusal into one and keeps the structured original on the cause;
`Permission.fromPlatformError` reads it back:

```text
{
  _tag: '@smthrs/capability/PermissionRequired',
  code: 'permission_required',
  requestId: 'permission-1',
  capability: { action: 'fs:write', resource: '/workspace/out.txt' },
  tier: 'compensable',
  meta: {}
}
```

The `tier` says what re-running the refused operation would cost: a write
inside the workspace is `compensable`, because the run can undo it from its own
snapshot. See [effect tiers](https://capability.smithers.sh/concepts/effect-tiers/) for the
other two.

`permission_required`, not `permission_denied`: no rule matched, silence is not
consent, and this store has nobody to ask. Build the store with
`attended: true` instead and the same write parks on a request an operator can
answer, then resumes the operation it was authorized for. The
[Quickstart](/quickstart/) runs both halves.

## How this fits with @smthrs/flows

`@smthrs/kernel` is one package of the Smithers durable flow engine, which
ships whole as [`@smthrs/flows`](https://flows.smithers.sh/reference/api/). Inside that engine the kernel is
the layer between a flow's body and the machine:
[`@smthrs/capability`](https://capability.smithers.sh/reference/api/) supplies the vocabulary it decides with,
the [`@smthrs/platform-node`](https://platform-node.smithers.sh/reference/api/) family implements the ports it
decorates, and [`@smthrs/engine`](https://engine.smithers.sh/reference/api/) runs steps over the guarded
surface it composes. `@smthrs/flows` re-exports all of it as the `Kernel`
namespace, and the durable Node runtime it builds is this composition at full
size, so a program that already depends on the barrel does not install this
package separately.

Depend on `@smthrs/kernel` on its own when you are guarding a host of your own
rather than running Smithers flows. Its only Smithers dependencies are the
capability vocabulary, the journal, and the Jujutsu port, and its root entry
point imports no Node built-ins, so the kernel runs wherever its host does.

Further up, [`@smthrs/cli`](https://cli.smithers.sh/reference/api/) is the `smthrs` command line that
everything here sits under. It finds the flows in a project, plans them, takes
an approval, and runs them, and it builds its host through this kernel with a
policy scoped to the project root, which is how a step that reaches outside
that root gets stopped.

## Where to go next

- [Installation](/installation/): runtime requirements, the import forms,
  the three test subpaths, and the platform bundle you choose yourself.
- [Quickstart](/quickstart/): refuse a read on an unattended store, then
  answer the same read on an attended one.
- [Guard a host bundle](/guides/guard-a-host-bundle/): the composition over
  a real platform, in the right order, and the two mistakes that defeat it.
- [Write a capability policy](/guides/write-a-capability-policy/): the four
  rulesets, the hard veto, and the resource each action names.
- [Answer permission requests](/guides/answer-permission-requests/): the
  code on the other side of a parked request.
- [Decoration in place](/concepts/decoration-in-place/): why the kernel
  guards the platform's own tags instead of publishing protected copies.
- [How a grant decision is made](/concepts/grant-decisions/): the ceiling,
  the four rulesets, and the order they are consulted in.
- [API reference](/reference/api/): every public export, its signature, and its
  bounds.
- [The kernel contract](/contract/): what this package guarantees at a host
  boundary, in one paragraph.
- [Troubleshooting](/troubleshooting/): each refusal this package raises,
  what it means, and what to change.

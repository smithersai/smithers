---
title: "Bind the standard flows into a host"
description: "Compose the platform and service layers the handlers require, offer the declarations to a model, and use the read-only projection for a restricted tool surface."
sidebar:
  order: 1
---

A host does two things with this package: it offers declarations to a model, and
it runs the matching handlers when a call arrives. This guide covers the
composition both halves need.

## Compose the host layer

Start with a platform layer, then add one layer per service a flow needs:

```ts
import { NodeServices } from "@effect/platform-node"
import { Container, NativeSearch, TestRunner } from "@smthrs/std"
import * as Layer from "effect/Layer"

/** FileSystem, Path, and ChildProcessSpawner. */
const platform = NodeServices.layer

const host = Layer.mergeAll(
  platform,
  // grep and glob, through the rg executable.
  NativeSearch.layer.pipe(Layer.provide(platform)),
  // bash and test, when a call names a container.
  Container.layerCommand({ program: "docker" }),
  // test: how the project under test runs its suite.
  TestRunner.layer({ command: "pnpm vitest run", cwd: "/workspace" })
)
```

Swap `NativeSearch.layer` for `PortableSearch.layer` to search in process with
no external binary. Both satisfy the same `Search` service, and nothing above
the layer changes. When the files live on another machine, such as a container
or a sandbox machine, `RemoteSearch.make` over that machine's spawner and `Path`
answers in two round trips where the portable peer would ask once per file.

The other file flows count round trips too. A filesystem whose every call
crosses a network can offer `Read.Batched` calls, and then `read` and `ls` take
one round trip, and `edit`, `write`, and `apply_patch` take two whatever the
number of files. `@smthrs/sandbox`'s Linux sessions offer them. See
[Concurrent changes](./read-and-edit-a-file.md#concurrent-changes).

A host that cannot serve a service binds its refusal layer instead of leaving it
out, so the failure names the missing service rather than a missing context:

```ts
import { Checkpoints, LanguageServer, WebSearch } from "@smthrs/std"

const unavailable = Layer.mergeAll(
  WebSearch.layerNoop, // websearch fails with provider_unavailable
  LanguageServer.layerNoop, // lsp fails with unsupported
  Checkpoints.layerNoop // pinning fails with provider_unavailable
)
```

To answer `lsp` on Node.js or Bun, bind `NodeLanguageServer.layer(config)` from
[`@smthrs/platform-node`](/api/platform-node) instead of
`LanguageServer.layerNoop`. See
[Query a language server](./query-a-language-server.md).

## Run one handler

A handler is an ordinary Effect. Provide the composed host and run it:

```ts
import { Grep } from "@smthrs/std"
import * as Effect from "effect/Effect"

const hits = Effect.provide(
  Grep.run({ pattern: "TODO", root: "/workspace", globs: ["*.ts"] }),
  host
)
```

## Offer the declarations

`Manifest.flows` is the declaration registry, keyed by the same names a model
calls. Offering all 17 is one expression:

```ts
import { Manifest } from "@smthrs/std"

const offered = Manifest.names.map((name) => Manifest.flows[name])
```

For a tool surface that must not change anything, use the read-only projection
instead of filtering by hand:

```ts
const readOnly = Manifest.readOnly.map((name) => Manifest.flows[name])
```

`Manifest.readOnly` is `read`, `ls`, `glob`, `grep`, `fetch`, `explore`,
`webfetch`, and `lsp`. `websearch` is not in it: its provider contract requires
`net:post` authority, which is mutating under the kernel capability taxonomy.

## Narrow the envelope for one call

When a call arrives, narrow its declared envelope to what that input actually
touches before scheduling it. `Manifest.effectsFor` reaches the narrowing by
name:

```ts
const narrowed = Manifest.effectsFor["read"]({ path: "/workspace/notes.md" })
// reads: ["/workspace/notes.md"], instead of the declared ["/**"]
```

Without this, two reads of two different files serialize against each other. See
[Effects and capabilities](../concepts/effects-and-capabilities.md).

## The production path

[`@smthrs/agent`](/api/agent) already does all of this. Its `StandardFlows`
module pairs each declaration with its handler through
[`@smthrs/harness`](/api/harness)'s `FlowBinding` contract, and groups them by
the slice of host services they need: `filesystem` binds `read`, `write`,
`edit`, `apply_patch`, `ls`, `glob`, and `grep`; `shell` binds `bash`; `tests`
binds `test`. If you are building an agent rather than a tool host, start there:
[Give a run capabilities](/pkg/agent/guides/capabilities).

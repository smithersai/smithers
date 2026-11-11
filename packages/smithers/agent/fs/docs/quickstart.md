---
title: "Quickstart"
description: "Scan a flows tree and run one command end to end with @smthrs/fs."
---

This walkthrough builds the smallest real program: one flow on disk, one
metadata-only scan, one parsed command, and one invocation through a stub
boundary. By the end you have a command surface you can also serve to a
shell or an HTTP client. Each step below is TypeScript; the
[VibeLang tab](#the-same-walkthrough-in-vibelang) runs the scan and the command
as Effect code.

## Prerequisites

- Node.js 26.4.0 or later, and pnpm.
- `@smthrs/fs`, `@smthrs/core`, `effect`, and `@effect/platform-node` resolvable
  from your program.

`@smthrs/fs` is not published to npm, so you install it from a checkout:

```bash
git clone https://github.com/smithersai/smithers.git
cd smithers
pnpm install
```

Write this walkthrough's program inside that checkout, in a package that depends
on `@smthrs/fs`, so the imports below resolve.

## Create a flow

A route's name comes from its directory path, not from the flow's `name`
field. Create `.smithers/flows/review/flow.ts`:

```ts
import { Schema } from "effect"

export default ({
  name: "review",
  description: "Review a pull request.",
  input: Schema.Struct({ number: Schema.Number }),
  output: Schema.Struct({ accepted: Schema.Boolean, number: Schema.Number })
})
```

The default export must satisfy `isFlow` from
[@smthrs/core](/api/core). Anything else fails at dispatch time with
`load_failed`.

## Scan the flows tree

`FileRouter.scan` reads registry metadata without importing `flow.ts`. It
requires the platform `FileSystem` and `Path` services:

```ts
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import { FileRouter } from "@smthrs/fs"
import { Effect, Layer } from "effect"
import { resolve } from "node:path"

const platform = Layer.merge(NodeFileSystem.layer, NodePath.layer)

const scanned = Effect.gen(function*() {
  const { routes } = yield* FileRouter.scan({ root: resolve(".smithers/flows") })
  return routes.map((route) => route.name)
}).pipe(Effect.provide(platform))

Effect.runPromise(scanned).then(console.log)
```

```text
[ "review" ]
```

The route carries the discovered description, schema locators, capabilities,
effect declaration, placement, and `modelInvocable` flag, all validated and
frozen. The flow module itself has not been imported.

## Build the command surface and execute one command

`Command.make` filters the scan to executable routes (module kind with
`modelInvocable` set to true) and projects them for an agent. `execute`
parses the command string, loads only the selected module, decodes the input
through the flow's Effect schema, invokes through `FlowInvoker`, and encodes
the output:

```ts
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import { Command, FileRouter, FlowInvoker } from "@smthrs/fs"
import { Effect, Layer } from "effect"
import { resolve } from "node:path"

const platform = Layer.merge(NodeFileSystem.layer, NodePath.layer)

const invoker = FlowInvoker.make({
  invoke: ({ input }) => Effect.succeed({ accepted: true, number: (input as { readonly number: number }).number })
})

const program = Effect.gen(function*() {
  const { routes } = yield* FileRouter.scan({ root: resolve(".smithers/flows") })
  const commands = yield* Command.make(routes)
  console.log(commands.list())
  return yield* commands.execute("review --number 42")
}).pipe(
  Effect.provide(Layer.succeed(FlowInvoker.FlowInvoker, invoker)),
  Effect.provide(platform)
)

Effect.runPromise(program).then(console.log)
```

```text
[ { name: "review", description: "Review a pull request." } ]
{ accepted: true, number: 42 }
```

Two defining behaviors happened here: the flow module loaded only when the
command dispatched, and the string `"42"` from the command line decoded to
the number `42` through the flow's own schema before invocation.

## The same walkthrough in VibeLang

In [VibeLang](https://github.com/smithersai/vibelang) the scan and the command
are `effect` functions. The stub boundary's `invoke` is an `effect` arrow that
returns the output directly, `provide FlowInvoker.FlowInvoker = invoker`
replaces `Effect.provide(Layer.succeed(…))`, and `main` provides
`NodeServices.layer` for the `FileSystem` and `Path` services the scan needs.
The caller passes the flows root, because a `.vibe` file has no `process.cwd()`.

This is `examples/quickstart.vibe`. `test/quickstart.test.vibe` runs it, and
the package's docs check fails if this block and the file differ.

```vibe
import * as NodeServices from "@effect/platform-node/NodeServices"
import { Command, FileRouter, FlowInvoker } from "@smthrs/fs"

/** A stub boundary that accepts every review it is handed. */
const invoker = FlowInvoker.make({
  invoke: effect ({ input }) => ({ accepted: true, number: (input as { readonly number: number }).number })
})

/** Scans the flows tree under `root` without importing any flow module. */
export effect function routeNames(root: string) {
  const { routes } = try FileRouter.scan({ root })
  return routes.map((route) => route.name)
}

/** Builds the command surface and executes one command string through the stub. */
export effect function execute(root: string, commandString: string) {
  provide FlowInvoker.FlowInvoker = invoker {
    const { routes } = try FileRouter.scan({ root })
    const commands = try Command.make(routes)
    return { listed: commands.list(), output: try commands.execute(commandString) }
  }
}

/** The walkthrough on Node's filesystem: scan, then run `review --number 42`. */
export effect function main(root: string) {
  provide NodeServices.layer {
    const names = try routeNames(root)
    const { listed, output } = try execute(root, "review --number 42")
    return { names, listed, output }
  }
}
```

## Serve the same routes

To expose the same routes to a shell or an HTTP client, project them with
`Incur.createCli`. The returned CLI responds to `serve` with an argv and to
`fetch` with a `Request`:

```ts
import { Incur } from "@smthrs/fs"

const cli = await Effect.runPromise(
  Effect.gen(function*() {
    const { routes } = yield* FileRouter.scan({ root: resolve(".smithers/flows") })
    return yield* Incur.createCli("flows", routes)
  }).pipe(
    Effect.provide(Layer.succeed(FlowInvoker.FlowInvoker, invoker)),
    Effect.provide(platform)
  )
)

await cli.serve(["review", "--number", "42", "--format", "json"])
const response = await cli.fetch(new Request("http://localhost/review?number=42"))
console.log(await response.json())
```

`cli.fetch` performs no authentication: any client that reaches it can run
every mounted flow. Before you serve it on a socket, follow
[Authenticate before you listen](./guides/serve-over-cli-http-and-mcp.md#authenticate-before-you-listen).

The CLI run prints the encoded output as JSON, and the HTTP response body
carries the same encoded output under `data`. Discovery stays metadata-aware:
`--help`, `--llms`, `--schema`, `/openapi.json`, and `/mcp` all describe the
flow's real input schema.

## Next steps

- To drive this surface programmatically, see
  [Expose flows to an agent](./guides/expose-flows-to-an-agent.md).
- For the full CLI, HTTP, and MCP behavior, see
  [Serve flows over CLI, HTTP, and MCP](./guides/serve-over-cli-http-and-mcp.md).
- To learn why discovery and dispatch work this way, see
  [Metadata routing](./concepts/metadata-routing.md) and
  [Command projections](./concepts/command-projections.md).

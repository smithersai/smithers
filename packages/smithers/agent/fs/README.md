# `@smthrs/fs`

**Documentation:** https://fs.smithers.sh

Turn a directory of Smithers flows into named, schema-checked commands for
agents, shells, HTTP clients, and MCP tools.

`@smthrs/fs` reads a flows tree without importing a single flow module, records
what it finds as immutable path-named routes, and projects the runnable ones
onto four surfaces. `FileRouter.scan` and `Command.list` stay metadata-only, so
listing the commands through them never runs user code and a flow whose module
throws at import time still appears. The first Incur help, OpenAPI, or MCP
discovery is the one exception: publishing each flow's real input schema
requires loading it, so that discovery imports every visible module once and
caches the projection. Dispatch imports one module, the one being called, and
that flow's own Effect schema decodes the input and encodes the output. `Command.make` exposes routes
to an agent as list, parse, execute, and typed call operations; `Incur.createCli`
serves the same routes as a CLI and as HTTP, OpenAPI, and MCP. Neither surface
runs a flow: both dispatch through the injected `FlowInvoker` seam, and every
failure arrives as a sanitized `FsError`.

## Install

`@smthrs/fs` is not published to npm. Install it from a checkout of the Smithers
repository, and write your program inside that checkout so the imports resolve:

```bash
git clone https://github.com/smithersai/smithers.git
cd smithers
pnpm install
```

To run flows from a shell today, use the `smthrs` command line
(https://cli.smithers.sh).

## Example

Scan a flows directory, build the agent command surface, and execute one command
through a stub invoker:

```ts
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import { Command, FileRouter, FlowInvoker } from "@smthrs/fs"
import { Effect, Layer } from "effect"
import { resolve } from "node:path"

const invoker = FlowInvoker.make({
  invoke: ({ input }) => Effect.succeed({ accepted: true, number: (input as { readonly number: number }).number })
})

const program = Effect.gen(function*() {
  const { routes } = yield* FileRouter.scan({ root: resolve("flows") })
  const commands = yield* Command.make(routes)
  return yield* commands.execute("review --number 42")
}).pipe(
  Effect.provide(Layer.succeed(FlowInvoker.FlowInvoker, invoker)),
  Effect.provide(Layer.merge(NodeFileSystem.layer, NodePath.layer))
)
```

The command name comes from the flow's directory, so this dispatches
`flows/review/flow.ts`. The root and the named module subpaths are the whole
import surface: `./internal/*` and nested `*/index` paths do not resolve.

## Documentation

https://fs.smithers.sh covers the quickstart, the guides for agent, CLI, HTTP,
and MCP surfaces, the normative routing contract, the full API reference, and
every `FsError` code with its fix.

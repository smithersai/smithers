---
title: "Test against a server"
description: "Two seams for testing MCP code: a three-field fake client for projection tests, and a real fixture server in its own process for transport and protocol tests."
sidebar:
  order: 8
---

Testing this package's consumers has two levels, and picking the wrong one
wastes time or proves nothing.

## Fake the client for projection tests

`McpFlows.mcp` takes an `McpClient.McpClient`, which is an interface with three
members. Any object with those members works, so a projection test needs no
process:

```ts
import * as McpFlows from "@smthrs/mcp/McpFlows"
import { Effect } from "effect"

const source = McpFlows.mcp({
  server: "fixtures",
  tools: [{
    name: "word_count",
    description: "Counts the words in a piece of text",
    inputSchema: { type: "object", properties: { text: { type: "string" } } },
    outputSchema: undefined
  }],
  callTool: () =>
    Effect.succeed({
      content: [{ type: "text", text: "4" }],
      isError: false,
      structuredContent: undefined
    })
})

const bindings = await Effect.runPromise(source.bindings())
// bindings[0].descriptor.name === "mcp/fixtures/word_count"
```

Use this for anything about flow names, filtering, prefixes, declared
capabilities, or the input document a model is shown. It is fast and
deterministic, and it exercises the code you are actually testing.

Note that `mcp` is total: it applies the filters it is given without checking
them. To test that an unknown `include` name is rejected, you need
`McpFlows.connected`, which checks against a real catalog.

## Spawn a real server for transport tests

A fake client proves nothing about the handshake, the framing, the deadlines, or
what happens when a process dies. Those need a real subprocess, and a real
subprocess is cheap: an MCP server is one `readline` loop with no dependencies.

```ts
import { NodeServices } from "@effect/platform-node"
import * as McpClient from "@smthrs/mcp/McpClient"
import { Effect } from "effect"

/** A real MCP server in its own process: one `add` tool, nothing else. */
const SERVER = String.raw`
const readline = require("node:readline")
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n")
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line)
  if (request.method === "initialize") {
    send({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} } } })
    return
  }
  if (request.method === "tools/list") {
    send({ jsonrpc: "2.0", id: request.id, result: { tools: [{ name: "add", inputSchema: { type: "object" } }] } })
    return
  }
  if (request.method === "tools/call") {
    const { a, b } = request.params.arguments
    send({ jsonrpc: "2.0", id: request.id, result: { content: [{ type: "text", text: String(a + b) }], isError: false } })
  }
})
`

const connected = Effect.scoped(Effect.gen(function*() {
  const client = yield* McpClient.connect({
    server: "fixture",
    command: process.execPath,
    args: ["-e", SERVER]
  })
  return yield* client.callTool("add", { a: 2, b: 3 })
})).pipe(Effect.provide(NodeServices.layer))
```

`process.execPath` with `-e` keeps the fixture next to the assertion about it
while one suite spawns it. Give these tests a generous timeout; spawning a
process and completing a handshake takes longer than an assertion.

Test the failure paths this way too. A server that exits during startup, writes
an oversized frame, answers the wrong protocol version, or never replies is a
few lines of fixture each, and those are the paths that break in production.

Once a second suite needs the same server, give every suite one source and
switch it on `process.argv[1]`, rather than copying it. This package does that:
`test/fixtures/FixtureServer.ts` holds the only `node -e` server its suites
spawn, so a change to a shared shape such as the initialize reply is made once.

## Test the boundary, not your model of it

A projected source is not proof that a cell can call the tool. Two gates sit in
front of a real call: the capability decision the cell boundary makes from the
descriptor's declaration, and the registry resolution the harness performs before
dispatch. Both are places MCP tools have actually failed.

Compose them the way a host does, rather than re-deriving the rule in the test:

```ts
import * as CellCalls from "@smthrs/harness/CellCalls"
import * as FlowBinding from "@smthrs/harness/FlowBinding"
import * as Registry from "@smthrs/registry/Registry"

const catalog = yield* FlowBinding.catalog([source])
const registry = FlowBinding.registry(Registry.makeNoop(), catalog)
const descriptor = yield* registry.get("mcp/fixture/add")
const resolver = CellCalls.make({ registry, catalog })
```

A test that recomputes what the boundary should decide passes whatever the
boundary does, which is the one thing a boundary test must not do.

## Next

- [Grant authority to MCP tools](./grant-authority-to-mcp-tools.md): the
  declaration those gates read.
- [Troubleshooting](../troubleshooting.md): the failures worth writing a fixture
  for.

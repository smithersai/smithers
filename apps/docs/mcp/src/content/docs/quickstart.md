---
title: "Quickstart"
description: "Connect to a real MCP server over stdio, call one of its tools, and read the flows the adapter projects from its catalog."
sidebar:
  order: 2
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/mcp/docs/quickstart.md"
---

This quickstart connects to a real MCP server in its own process, calls two of
its tools, and prints the flows the adapter projects from its catalog. Nothing
is mocked: the server is a separate program speaking newline-delimited JSON-RPC,
which is the only thing MCP is.

By the end you will have seen both halves of this package. `McpClient` owns the
session, and `McpFlows` turns that session's catalog into flows a Smithers run
can call.

## Prerequisites

Node.js 26.4.0 or later, and a project that depends on `@smthrs/mcp`,
`@effect/platform-node`, and `effect`. See
[Installation](/installation/).

## Write the server

Create `quickstart-server.mjs`. It imports nothing, which is the point: the
process on the other end of an MCP session need not be yours.

```js
import { createInterface } from "node:readline"

const tools = [
  {
    name: "word_count",
    description: "Counts the words in a piece of text",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"]
    },
    outputSchema: {
      type: "object",
      properties: { words: { type: "integer" } },
      required: ["words"]
    }
  },
  {
    name: "explode",
    description: "Always reports a tool-level failure",
    inputSchema: { type: "object", properties: {} }
  }
]

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`)

createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line)
  if (request.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: request.id,
      result: {
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "quickstart", version: "1.0.0" }
      }
    })
    return
  }
  if (request.method === "tools/list") {
    send({ jsonrpc: "2.0", id: request.id, result: { tools } })
    return
  }
  if (request.method === "tools/call") {
    if (request.params.name === "explode") {
      send({
        jsonrpc: "2.0",
        id: request.id,
        result: { content: [{ type: "text", text: "the tool refused" }], isError: true }
      })
      return
    }
    const text = String(request.params.arguments.text ?? "")
    const words = text.split(/\s+/u).filter((word) => word.length > 0).length
    send({
      jsonrpc: "2.0",
      id: request.id,
      result: {
        content: [{ type: "text", text: String(words) }],
        structuredContent: { words },
        isError: false
      }
    })
  }
})
```

Two details matter later. The `initialize` result declares a `tools`
capability, which this client requires: a server that serves no tools is
refused during the handshake. And `explode` answers a successful JSON-RPC reply
carrying `isError: true`, which is MCP's way of saying "the tool ran and
reported a problem", not "the call failed".

## Connect and call

Create `quickstart.ts`. `McpClient.connect` spawns the server, completes the
handshake, and fetches the tool catalog once, up front:

```ts
import { NodeServices } from "@effect/platform-node"
import * as McpClient from "@smthrs/mcp/McpClient"
import * as McpFlows from "@smthrs/mcp/McpFlows"
import { Effect } from "effect"

const program = Effect.scoped(Effect.gen(function*() {
  const client = yield* McpClient.connect({
    server: "quickstart",
    command: process.execPath,
    args: ["quickstart-server.mjs"]
  })

  const counted = yield* client.callTool("word_count", { text: "durable flows release notes" })
  const refused = yield* client.callTool("explode", {})

  const source = McpFlows.mcp(client)
  const bindings = yield* source.bindings()

  return {
    tools: client.tools.map((tool) => tool.name),
    counted,
    refused,
    sourceName: source.name,
    flowNames: bindings.map((binding) => binding.descriptor.name)
  }
}))

console.log(await Effect.runPromise(Effect.provide(program, NodeServices.layer)))
```

`Effect.scoped` is what owns the subprocess. When the scope closes, the server
process is torn down and every request still outstanding fails with
`connection_closed` rather than hanging.

## Run it

Run the file with a TypeScript runner:

```bash
npx tsx quickstart.ts
```

```text
{
  tools: [ 'word_count', 'explode' ],
  counted: {
    content: [ { type: 'text', text: '4' } ],
    isError: false,
    structuredContent: { words: 4 }
  },
  refused: {
    content: [ { type: 'text', text: 'the tool refused' } ],
    isError: true,
    structuredContent: undefined
  },
  sourceName: 'mcp/quickstart',
  flowNames: [ 'mcp/quickstart/word_count', 'mcp/quickstart/explode' ]
}
```

## What just happened

`connect` spawned the process, negotiated `2025-06-18`, sent
`notifications/initialized`, and walked `tools/list` to the end of its cursor
before returning. `client.tools` is that catalog, and it is a snapshot: this
client never re-polls it.

`callTool("explode", {})` **succeeded**. Its `isError: true` came back in the
success channel, because a tool that runs and reports a problem is data. Only a
failure of the session itself, a server that will not start, a closed pipe, a
reply this client cannot parse, becomes an `McpError`. See
[Handle a failed tool call](/guides/handle-a-failed-tool-call/).

`word_count` declared an `outputSchema`, so its `structuredContent` was checked
against that schema before it was returned. `explode` declared none, so nothing
was checked. See
[Validate structured output](/guides/validate-structured-output/).

`McpFlows.mcp(client)` produced a `FlowBinding.Source` named `mcp/quickstart`
holding one binding per tool. Each binding's descriptor carries the server's own
`inputSchema` as its input document, so a model reading the catalog sees
`{ type: "object", properties: { text: { type: "string" } }, required: ["text"] }`
rather than this package's permissive record type.

## Next steps

- [A remote tool as a flow](/concepts/tools-as-flows/): what the projection
  produces, and why nothing downstream knows the flow is remote.
- [Grant authority to MCP tools](/guides/grant-authority-to-mcp-tools/): the
  one step between a projected source and a cell that can actually call it.
- [Select the tools a run sees](/guides/select-the-tools-a-run-sees/): keep a
  fifty-tool server out of the model's context window.

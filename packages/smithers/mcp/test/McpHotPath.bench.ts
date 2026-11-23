import { describe, test } from "vitest"
import * as JsonLimits from "../src/internal/JsonLimits.ts"
import * as Rpc from "../src/internal/Rpc.ts"

const outboundMessages: ReadonlyArray<Rpc.OutboundMessage> = Array.from({ length: 30 }, (_, i) => ({
  jsonrpc: "2.0",
  id: i + 1,
  method: "tools/call",
  params: {
    name: `tool_${i}`,
    arguments: { path: `packages/pkg-${i}/src/index.ts`, line: i * 10, recursive: i % 2 === 0 }
  }
}))

const inboundLines: ReadonlyArray<string> = Array.from({ length: 30 }, (_, i) =>
  JSON.stringify({
    jsonrpc: "2.0",
    id: i + 1,
    result: {
      content: [{ type: "text", text: `Result payload for tool_${i}: ${"x".repeat(64)}` }],
      isError: false
    }
  }))

const makeCatalogPayload = () => ({
  tools: Array.from({ length: 40 }, (_, i) => ({
    name: `mcp_tool_${i}`,
    description: `Execute remote MCP operation ${i} with structured input`,
    inputSchema: {
      type: "object",
      required: ["target"],
      properties: {
        target: { type: "string" },
        options: {
          type: "object",
          properties: {
            limit: { type: "number" },
            tags: { type: "array", items: { type: "string" } }
          }
        }
      }
    }
  }))
})

const catalogSample = makeCatalogPayload()

describe("mcp hot paths", () => {
  test("Rpc.encode 30 JSON-RPC requests", async ({ bench }) => {
    await bench("encode 30 outbound JSON-RPC frames", () => {
      for (const msg of outboundMessages) {
        Rpc.encode(msg)
      }
    }).run({ time: 120, warmupTime: 30 })
  })

  test("Rpc.parse and classify 30 responses", async ({ bench }) => {
    await bench("parse + classify 30 inbound JSON-RPC response lines", () => {
      for (const line of inboundLines) {
        const parsed = Rpc.parse(line)
        if (parsed !== undefined) {
          Rpc.classify(parsed)
        }
      }
    }).run({ time: 120, warmupTime: 30 })
  })

  test("JsonLimits.checkParsed + freezeParsed", async ({ bench }) => {
    await bench("depth-check 40-tool MCP catalog payload", () => {
      JsonLimits.checkParsed(catalogSample)
    }).run({ time: 120, warmupTime: 30 })
  })

  test("JsonLimits.freezeParsed on fresh catalog", async ({ bench }) => {
    await bench("recursively freeze 40-tool MCP catalog snapshot", () => {
      JsonLimits.freezeParsed(makeCatalogPayload())
    }).run({ time: 120, warmupTime: 30 })
  })
})

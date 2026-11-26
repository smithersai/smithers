// Decision 0173 §1: a local agent speaks MCP over stdio straight to the local SQLite node, as `act: "agent"`.
import { ShardProtocol } from "@smthrs/sync"
import { Schema } from "effect"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { PassThrough } from "node:stream"
import { expect, test } from "vitest"
import { startNode } from "../src/commands/NodeServe.ts"
import { executable, scriptedHost } from "./support/bin.ts"

const shard = Schema.decodeUnknownSync(ShardProtocol.ShardId)("repo:example/project")
const token = "test-only-node-agent-token-never-deployed"
const frame = (id: number, method: string, params?: object) =>
  `${JSON.stringify({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) })}\n`

/** Collects newline-delimited JSON-RPC replies and waits for the next one. */
const replies = (stream: NodeJS.ReadableStream) => {
  const lines: Array<any> = []
  let buffered = ""
  const waiters: Array<() => void> = []
  stream.on("data", (chunk: Buffer) => {
    buffered += chunk.toString("utf8")
    for (let end = buffered.indexOf("\n"); end >= 0; end = buffered.indexOf("\n")) {
      lines.push(JSON.parse(buffered.slice(0, end)))
      buffered = buffered.slice(end + 1)
      waiters.shift()?.()
    }
  })
  let read = 0
  return async (): Promise<any> => {
    if (lines.length <= read) await new Promise<void>((resolve) => waiters.push(resolve))
    return lines[read++]
  }
}

test("smthrs node serve answers a stdio MCP client from its SQLite shard and refuses oversized input", {
  timeout: 120_000
}, async () => {
  const dir = mkdtempSync(join(tmpdir(), "smithers-node-stdio-"))
  const file = join(dir, "node.sqlite")
  try {
    const child = spawn(process.execPath, [
      "--no-warnings",
      "--import",
      scriptedHost,
      executable,
      "node",
      "serve",
      "--file",
      file,
      "--shard",
      shard,
      "--node",
      "local"
    ], {
      cwd: dir,
      stdio: "pipe",
      timeout: 90_000,
      killSignal: "SIGKILL",
      env: { ...process.env, HOME: dir, SMITHERS_NODE_AGENT_TOKEN: token }
    })
    let stderr = ""
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString()
    })
    const closed = once(child, "close")
    const next = replies(child.stdout)

    child.stdin.write(frame(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {} }))
    expect(await next(), stderr).toMatchObject({ id: 1, result: { serverInfo: { name: "smithers-node" } } })
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`)
    child.stdin.write("{not json\n")
    expect(await next()).toMatchObject({ id: null, error: { code: -32700 } })
    child.stdin.write(frame(2, "tools/list"))
    const listed = await next()
    expect(listed.result.tools.map((tool: { name: string }) => tool.name)).toEqual(["ref__cause", "shard__append"])

    child.stdin.write(frame(3, "tools/call", { name: "shard__append", arguments: { side: "local" } }))
    const appended = await next()
    expect(appended).toMatchObject({
      id: 3,
      result: { structuredContent: { output: { side: "local" }, cause: { nodeId: "shard/append" } } }
    })
    const ref = appended.result.structuredContent.outputRef as string
    child.stdin.write(frame(4, "tools/call", { name: "ref__cause", arguments: { ref } }))
    expect(await next()).toMatchObject({
      id: 4,
      result: { structuredContent: { rows: [{ outputRef: ref, nodeId: "shard/append" }] } }
    })

    // An unterminated frame past the 10 MiB bound ends the session with a typed JSON-RPC refusal and a clean exit.
    child.stdin.write(Buffer.alloc(10 * 1024 * 1024 + 1, 0x20))
    expect(await next()).toMatchObject({ id: null, error: { code: -32600, data: { code: "mcp_input_too_large" } } })
    const [code] = await closed
    expect(code, stderr).toBe(0)
    expect(stderr).toContain("mcp_input_too_large")

    // The append is durable in the node's SQLite file.
    const db = new DatabaseSync(file, { readOnly: true })
    try {
      const { state } = db.prepare("SELECT state FROM node_shard WHERE id = 1").get() as { state: string }
      const saved = JSON.parse(state) as { head: { head: number }; entries: ReadonlyArray<unknown> }
      expect(saved.head.head).toBe(1)
      expect(saved.entries).toHaveLength(1)
      expect(JSON.stringify(saved.entries[0])).toContain("\"side\":\"local\"")
    } finally {
      db.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a stdio agent never sees or runs a person-only flow the node hosts", async () => {
  const dir = mkdtempSync(join(tmpdir(), "smithers-node-stdio-person-"))
  const node = await startNode({
    file: join(dir, "node.sqlite"),
    shard,
    node: "local",
    token,
    flows: [{
      tag: "approval/decide",
      title: "Decide an approval",
      personOnly: "An approval decision needs a person.",
      capabilities: ["shard:append"],
      payload: { type: "object", properties: { decision: { type: "string" } }, additionalProperties: false },
      run: (payload) => payload
    }]
  })
  try {
    const input = new PassThrough()
    const output = new PassThrough()
    const next = replies(output)
    const session = node.serveStdio({ input, output, maxBytes: 4_096 })
    input.write(frame(1, "tools/list"))
    const listed = await next()
    expect(listed.result.tools.map((tool: { name: string }) => tool.name)).toEqual(["ref__cause", "shard__append"])
    input.write(frame(2, "tools/call", { name: "approval__decide", arguments: { decision: "approve" } }))
    expect(await next()).toMatchObject({
      id: 2,
      result: { isError: true, structuredContent: { code: "person_only", cause: "agent" } }
    })
    expect(await node.sync()).toMatchObject({ position: { seq: 0 } })
    input.write("x".repeat(4_097))
    expect(await next()).toMatchObject({ id: null, error: { data: { code: "mcp_input_too_large" } } })
    expect(await session).toBe("mcp_input_too_large")
  } finally {
    await node.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

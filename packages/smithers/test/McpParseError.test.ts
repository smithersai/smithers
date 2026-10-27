import { spawn } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, it } from "vitest"

it.each([{ flags: [] }, { flags: ["--help"] }])("answers malformed stdio JSON and continues serving with $flags", {
  timeout: 60_000
}, async ({ flags }) => {
  const root = await mkdtemp(join(tmpdir(), "smthrs-mcp-parse-"))
  const child = spawn(process.execPath, [
    "--no-warnings",
    fileURLToPath(new URL("../src/bin.ts", import.meta.url)),
    "--mcp",
    ...flags
  ], {
    cwd: root,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, HOME: root, XDG_CONFIG_HOME: root, XDG_DATA_HOME: root, SMITHERS_REMOTE: "" }
  })
  let stderr = "", buffer = ""
  const replies: Array<any> = []
  const exited = new Promise((resolve) => child.once("close", resolve))
  const timeout = setTimeout(() => child.kill("SIGKILL"), 50_000)
  const send = (value: unknown) => child.stdin.write(JSON.stringify(value) + "\n")
  try {
    child.stderr.on("data", (bytes) => {
      stderr += bytes
    })
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject)
      child.once("close", () => reject(new Error(`MCP ended before ping: ${stderr}`)))
      child.stdout.on("data", (bytes) => {
        buffer += bytes
        for (;;) {
          const end = buffer.indexOf("\n")
          if (end < 0) break
          const line = buffer.slice(0, end)
          buffer = buffer.slice(end + 1)
          let reply: any
          try {
            reply = JSON.parse(line)
          } catch (cause) {
            reject(cause)
            return
          }
          replies.push(reply)
          if (reply.id === 1) {
            send({ jsonrpc: "2.0", method: "notifications/initialized" })
            // Both split and coalesced bad frames must preserve the next valid request.
            child.stdin.write("{not ")
            child.stdin.write("json\n[broken\n")
            send({ jsonrpc: "2.0", id: 2, method: "ping" })
          }
          if (reply.id === 2) resolve()
        }
      })
      send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "parse-regression", version: "1" }
        }
      })
    })
    expect(replies.filter((reply) => reply.id === null)).toEqual([
      { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } },
      { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }
    ])
    expect(replies.find((reply) => reply.id === 2)).toMatchObject({ result: {} })
  } finally {
    clearTimeout(timeout)
    child.kill("SIGTERM")
    await exited
    await rm(root, { recursive: true, force: true })
  }
})

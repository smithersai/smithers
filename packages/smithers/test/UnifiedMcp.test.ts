import { spawn } from "node:child_process"
import { mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, it } from "vitest"

type Reply = {
  id?: number
  error?: unknown
  result?: { content?: Array<{ text: string }>; tools?: Array<{ name: string }>; isError?: boolean }
}

/** A real `smthrs --mcp` child in `root`, past its initialize handshake. */
const serve = async (root: string) => {
  const child = spawn(process.execPath, [
    "--no-warnings",
    "--import",
    new URL("./fixtures/scripted-native-host.ts", import.meta.url).href,
    fileURLToPath(new URL("../src/bin.ts", import.meta.url)),
    "--mcp"
  ], {
    cwd: root,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, SMITHERS_REMOTE: "" }
  })
  let stderr = ""
  let buffer = ""
  let nextId = 0
  const pending = new Map<number, { resolve: (reply: Reply) => void; reject: (cause: Error) => void }>()
  const exited = new Promise<number | null>((resolve) => child.once("exit", resolve))
  child.stderr.on("data", (chunk) => {
    stderr += chunk
  })
  child.stdout.on("data", (chunk) => {
    buffer += chunk
    for (;;) {
      const end = buffer.indexOf("\n")
      if (end < 0) break
      const line = buffer.slice(0, end)
      buffer = buffer.slice(end + 1)
      if (line.trim() === "") continue
      const reply = JSON.parse(line) as Reply
      if (reply.id !== undefined) pending.get(reply.id)?.resolve(reply)
    }
  })
  child.once("error", (cause) => {
    for (const waiting of pending.values()) waiting.reject(cause)
  })
  const request = async (method: string, params: unknown) => {
    const id = ++nextId
    let timer: ReturnType<typeof setTimeout> | undefined
    const reply = new Promise<Reply>((resolve, reject) => {
      pending.set(id, { resolve, reject })
      timer = setTimeout(() => reject(new Error(`MCP ${method} timed out: ${stderr}`)), 90_000)
    })
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`)
    try {
      const value = await reply
      expect(value.error, stderr).toBeUndefined()
      return value.result
    } finally {
      clearTimeout(timer)
      pending.delete(id)
    }
  }
  const stop = async () => {
    child.kill("SIGKILL")
    await exited
  }
  try {
    await request("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "cli-test", version: "1" }
    })
  } catch (cause) {
    await stop()
    throw cause
  }
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`)
  const call = (name: string, args: unknown) => request("tools/call", { name, arguments: args })
  return { child, exited, request, call, stop, stderr: () => stderr }
}

type Listed = { name: string; annotations?: { readOnlyHint?: unknown } }

/** Every tool the server serves, paged through `search_tools` with an empty query. */
const servedTools = async (server: Awaited<ReturnType<typeof serve>>) => {
  const tools: Array<Listed> = []
  let offset: number | undefined = 0
  while (offset !== undefined) {
    const page = await server.call("search_tools", { query: "", limit: 20, offset })
    const document = JSON.parse(page?.content?.[0]?.text.split("\n\n")[0] ?? "{}") as {
      tools: Array<Listed>
      nextOffset?: number
    }
    tools.push(...document.tools)
    offset = document.nextOffset
  }
  return tools
}

it(
  "discovers canonical MCP tools, executes the real flow catalog, and exits cleanly on SIGTERM",
  { timeout: 180_000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "smthrs-unified-mcp-"))
    const server = await serve(root)
    try {
      const listed = await server.request("tools/list", {})
      expect(listed?.tools?.map((tool) => tool.name)).toContain("search_tools")
      const details = await server.call("get_tool_details", { name: "flow_list" })
      expect(details?.content?.[0]?.text).toContain("root")
      for (const name of ["runs_fork", "eval_compare", "targets", "credentials_list", "triggers_fire"]) {
        const tool = await server.call("get_tool_details", { name })
        expect(tool?.content?.[0]?.text).toContain(`"name":"${name}"`)
      }
      for (const name of ["approvals_approve", "approvals_deny", "flow_start"]) {
        const details = await server.call("get_tool_details", { name })
        expect(details?.isError, JSON.stringify(details)).toBe(true)
        const refused = await server.call("call_write_tool", {
          name,
          arguments: { approval: "{}", flow: "absent", root, audience: "human" }
        })
        expect(refused?.isError, JSON.stringify(refused)).toBe(true)
      }
      expect(await readdir(root)).toEqual([])
      const catalog = await server.call("call_read_tool", { name: "flow_list", arguments: { root } })
      expect(catalog?.content?.[0]?.text, server.stderr()).toContain("flows")
      server.child.kill("SIGTERM")
      expect(await server.exited, server.stderr()).toBe(143)
    } finally {
      await server.stop()
      await rm(root, { recursive: true, force: true })
    }
  }
)

/**
 * Progressive discovery routes a tool through `call_read_tool` only when its
 * command declares `readOnlyHint: true`, and `call_write_tool` refuses such a
 * tool. An unclassified tool therefore forces every agent through the write
 * wrapper, so each served command must state its classification: this case
 * reads the served set itself, so a new command cannot slip in unclassified.
 */
it(
  "classifies every served tool and serves the read verbs through call_read_tool alone",
  { timeout: 180_000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "smthrs-unified-mcp-read-"))
    const server = await serve(root)
    try {
      const tools = await servedTools(server)
      expect(tools.length).toBeGreaterThan(50)
      const unclassified = tools.filter((tool) => typeof tool.annotations?.readOnlyHint !== "boolean")
      expect(unclassified.map((tool) => tool.name)).toEqual([])

      const readOnly = new Set(tools.filter((tool) => tool.annotations?.readOnlyHint === true).map((tool) => tool.name))
      for (const name of ["flow_list", "flow_show", "runs_list", "runs_show", "runs_logs", "approvals_list"]) {
        expect(readOnly.has(name), name).toBe(true)
      }
      // `flow plan` commits the plan card and its approval token and journals
      // `control.plan.created`; it is a write even though nothing executes.
      for (const name of ["flow_plan", "flow_execute", "runs_cancel", "runs_rewind", "memory_set"]) {
        expect(readOnly.has(name), name).toBe(false)
      }
      for (const name of readOnly) {
        const refused = await server.call("call_write_tool", { name, arguments: {} })
        expect(refused?.content?.[0]?.text, name).toContain(`Tool is read-only: ${name}`)
      }

      // The catalog reads the discovery snapshot and leaves the project as it found it.
      const catalog = await server.call("call_read_tool", { name: "flow_list", arguments: { root } })
      expect(catalog?.isError, JSON.stringify(catalog)).not.toBe(true)
      expect(catalog?.content?.[0]?.text).toMatch(/"items":\s*\[\]/)
      const missing = await server.call("call_read_tool", {
        name: "flow_show",
        arguments: { flow: "absent", root }
      })
      expect(missing?.content?.[0]?.text).toContain("Unknown flow absent")
      expect(await readdir(root)).toEqual([])
    } finally {
      await server.stop()
      await rm(root, { recursive: true, force: true })
    }
  }
)

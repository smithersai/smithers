import { spawn } from "node:child_process"
import { mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, it } from "vitest"

it(
  "discovers canonical MCP tools, executes the real flow catalog, and exits cleanly on SIGTERM",
  { timeout: 180_000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "smthrs-unified-mcp-"))
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
    type Reply = {
      id?: number
      error?: unknown
      result?: { content?: Array<{ text: string }>; tools?: Array<{ name: string }>; isError?: boolean }
    }
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
    try {
      await request("initialize", {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "cli-test", version: "1" }
      })
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`)
      const listed = await request("tools/list", {})
      expect(listed?.tools?.map((tool) => tool.name)).toContain("search_tools")
      const details = await request("tools/call", { name: "get_tool_details", arguments: { name: "flow_list" } })
      expect(details?.content?.[0]?.text).toContain("root")
      for (const name of ["runs_fork", "eval_compare", "targets", "credentials_list", "triggers_fire"]) {
        const tool = await request("tools/call", { name: "get_tool_details", arguments: { name } })
        expect(tool?.content?.[0]?.text).toContain(`"name":"${name}"`)
      }
      for (const name of ["approvals_approve", "approvals_deny", "flow_start"]) {
        const details = await request("tools/call", { name: "get_tool_details", arguments: { name } })
        expect(details?.isError, JSON.stringify(details)).toBe(true)
        const refused = await request("tools/call", {
          name: "call_write_tool",
          arguments: { name, arguments: { approval: "{}", flow: "absent", root, audience: "human" } }
        })
        expect(refused?.isError, JSON.stringify(refused)).toBe(true)
      }
      expect(await readdir(root)).toEqual([])
      const catalog = await request("tools/call", {
        name: "call_write_tool",
        arguments: { name: "flow_list", arguments: { root } }
      })
      expect(catalog?.content?.[0]?.text, stderr).toContain("flows")
      child.kill("SIGTERM")
      expect(await exited, stderr).toBe(143)
    } finally {
      child.kill("SIGKILL")
      await exited
      await rm(root, { recursive: true, force: true })
    }
  }
)

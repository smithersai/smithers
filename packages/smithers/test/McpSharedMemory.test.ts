/**
 * Shared agent memory over the MCP server a vendor agent CLI launches.
 *
 * Two agent profiles are two processes with their own home, configuration
 * directory and working directory. They share a memory only through the store
 * `smthrs mcp add --memory-db` records in each profile's server entry, and
 * reach it only through the tools `smthrs --mcp` discovers.
 */
import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createInterface } from "node:readline"
import { fileURLToPath } from "node:url"
import { afterEach, expect, it } from "vitest"

const bin = fileURLToPath(new URL("../src/bin.ts", import.meta.url))
const children: Array<ChildProcessWithoutNullStreams> = []
const directories: Array<string> = []

afterEach(() => {
  while (children.length > 0) children.pop()!.kill("SIGKILL")
  while (directories.length > 0) rmSync(directories.pop()!, { recursive: true, force: true })
})

interface ToolResult {
  readonly isError?: boolean
  readonly content: ReadonlyArray<{ readonly text: string }>
}

interface Launch {
  readonly command: string
  readonly args: ReadonlyArray<string>
  readonly env?: Readonly<Record<string, string>> | undefined
}

/** One agent profile's MCP session: its own home and working directory, started the way its registration says. */
const profile = async (root: string, name: string, launch: Launch) => {
  const home = join(root, name)
  mkdirSync(join(home, "work"), { recursive: true })
  const child = spawn(launch.command, [...launch.args], {
    cwd: join(home, "work"),
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      PATH: process.env.PATH,
      HOME: home,
      XDG_CONFIG_HOME: home,
      XDG_DATA_HOME: home,
      SMITHERS_DISABLE_SYSTEM_KEYRING: "1",
      NODE_NO_WARNINGS: "1",
      ...launch.env
    }
  })
  children.push(child)
  const waiting = new Map<number, (result: ToolResult) => void>()
  createInterface({ input: child.stdout }).on("line", (line) => {
    const message = JSON.parse(line) as { id: number; result: ToolResult }
    waiting.get(message.id)?.(message.result)
    waiting.delete(message.id)
  })
  let next = 0
  const request = (method: string, params: unknown): Promise<ToolResult> => {
    const id = next += 1
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`)
    return new Promise((resolve) => waiting.set(id, resolve))
  }
  await request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name, version: "1" }
  })
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`)
  const call = async (tool: string, argument: Record<string, unknown>) => {
    const result = await request("tools/call", { name: tool, arguments: argument })
    return { failed: result.isError === true, text: result.content[0]!.text }
  }
  return { call, home }
}

const stage = (): string => {
  const root = mkdtempSync(join(tmpdir(), "smithers-mcp-memory-"))
  directories.push(root)
  return root
}

/** Registers the server into one Claude Code profile through the public CLI, and answers the entry it wrote. */
const register = (root: string, name: string, memory: string): Launch => {
  const directory = join(root, name, "claude-profile")
  const registered = spawnSync(
    process.execPath,
    ["--no-warnings", bin, "mcp", "add", "--agent", "claude", "--memory-db", memory, "--json"],
    {
      cwd: root,
      env: { PATH: process.env.PATH, HOME: join(root, name), CLAUDE_CONFIG_DIR: directory },
      encoding: "utf8",
      timeout: 100_000
    }
  )
  expect(registered.status, registered.stdout + registered.stderr).toBe(0)
  expect(JSON.parse(registered.stdout)).toEqual([
    { agent: "claude", path: join(directory, ".claude.json"), status: "written" }
  ])
  const document = JSON.parse(readFileSync(join(directory, ".claude.json"), "utf8")) as {
    mcpServers: { smithers: Launch }
  }
  return document.mcpServers.smithers
}

it("lets one agent profile recall the fact another profile saved", { timeout: 240_000 }, async () => {
  const root = stage()
  const memory = join(root, "shared", "memory.db")
  // Each session starts from nothing but the entry `mcp add` wrote into its own profile.
  const writer = await profile(root, "profile-a", register(root, "profile-a", memory))
  const reader = await profile(root, "profile-b", register(root, "profile-b", memory))

  const found = await reader.call("search_tools", { query: "memory", limit: 20 })
  expect((JSON.parse(found.text) as { tools: Array<{ name: string }> }).tools.map((tool) => tool.name).sort())
    .toEqual(["memory_get", "memory_list", "memory_recall", "memory_set"])

  const saved = await writer.call("call_write_tool", {
    name: "memory_set",
    arguments: { key: "release-day", value: "Releases are cut on Tuesday mornings", tag: ["source:profile-a"] }
  })
  expect(saved.failed, saved.text).toBe(false)

  const recalled = await reader.call("call_read_tool", { name: "memory_recall", arguments: { query: "releases" } })
  expect(recalled.failed, recalled.text).toBe(false)
  expect(JSON.parse(recalled.text)).toMatchObject([
    { bank: "user-cli", key: "release-day", text: "Releases are cut on Tuesday mornings" }
  ])
  const read = await reader.call("call_read_tool", { name: "memory_get", arguments: { key: "release-day" } })
  expect(JSON.parse(read.text.split("\n\n")[0]!)).toMatchObject({
    value: "Releases are cut on Tuesday mornings",
    tags: ["source:profile-a"]
  })
  const listed = await reader.call("call_read_tool", { name: "memory_list", arguments: {} })
  expect((JSON.parse(listed.text.split("\n\n")[0]!) as Array<{ key: string }>).map((fact) => fact.key))
    .toEqual(["release-day"])
})

it("keeps deletion and another project's store out of an agent's reach", { timeout: 120_000 }, async () => {
  const root = stage()
  const session = await profile(root, "profile-a", {
    command: process.execPath,
    args: [bin, "--mcp"],
    env: { SMITHERS_MEMORY_DB: join(root, "memory.db") }
  })
  for (const tool of ["memory_rm", "memory_compact", "memory_notes_add", "memory_threads_rm"]) {
    const refused = await session.call("call_write_tool", { name: tool, arguments: { key: "release-day" } })
    expect(refused).toEqual({ failed: true, text: JSON.stringify({ error: `Unknown tool: ${tool}` }) })
  }
  const elsewhere = await session.call("call_read_tool", {
    name: "memory_list",
    arguments: { root: join(root, "profile-b") }
  })
  expect(elsewhere.failed).toBe(true)
  expect(elsewhere.text).toContain("--root is not accepted over MCP")
})

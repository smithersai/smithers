// Decision 0017 §9: an agent never acts as the person. `smthrs --mcp` and `smthrs --http` mark their process a
// delegate, and a delegate's call to a person-only command is refused with the typed `person_only` error before the
// command's handler runs. Each case proves the handler did not run: an approval that is not JSON would otherwise
// fail in the handler with a different error.
import { PassThrough } from "node:stream"
import { describe, expect, it } from "vitest"
import { DELEGATE_ACT, makeCli, personOnlyCommands } from "../src/Cli.ts"
import type * as Bridge from "../src/cli/ControlBridge.ts"

type Cli = ReturnType<typeof makeCli>

const run = async (cli: Cli, argv: Array<string>) => {
  const codes: Array<number> = []
  let stdout = ""
  await cli.serve(argv, {
    env: {},
    exit: (code) => codes.push(code),
    stdout: (text) => {
      stdout += text
    }
  })
  return { codes, stdout }
}

const make = (runtime: Bridge.Runtime) => makeCli({ exit: () => undefined, ...runtime })

/** A `smthrs --mcp` server in this process, past its initialize handshake. */
const mcp = async (environment: Record<string, string | undefined>) => {
  const input = new PassThrough()
  const output = new PassThrough()
  const controller = new AbortController()
  const replies: Array<{ id: number; result?: any; error?: unknown }> = []
  let buffer = ""
  output.on("data", (bytes) => {
    buffer += bytes
    for (;;) {
      const end = buffer.indexOf("\n")
      if (end < 0) break
      replies.push(JSON.parse(buffer.slice(0, end)))
      buffer = buffer.slice(end + 1)
    }
  })
  let nextId = 0
  const request = async (method: string, params: unknown) => {
    const id = ++nextId
    input.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n")
    for (;;) {
      const found = replies.find((value) => value.id === id)
      if (found !== undefined) return found
      await new Promise<void>((resolve) => output.once("data", () => resolve()))
    }
  }
  const cli = make({ mcpStdio: { input, output }, environment, signal: controller.signal })
  await cli.serve(["--mcp"])
  await request("initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "delegate", version: "1" }
  })
  input.write("{\"jsonrpc\":\"2.0\",\"method\":\"notifications/initialized\"}\n")
  return {
    cli,
    request,
    close: () => {
      controller.abort()
      input.destroy()
      output.destroy()
    }
  }
}

const refusal = (command: string) => ({
  code: "person_only",
  message: `smthrs ${command} needs a person. An agent can propose it; a person runs it from their own terminal.`
})

describe("a delegate never runs a person-only command", () => {
  it("names the approval, credential and token mutations, and the catalog's never-agent commands", () => {
    expect(personOnlyCommands).toEqual(expect.arrayContaining([
      "approvals approve",
      "approvals deny",
      "approvals grant",
      "approvals grant-trigger",
      "approvals revoke-trigger",
      "credentials add",
      "credentials rotate",
      "credentials revoke",
      "token mint",
      "ssh-key add",
      "ssh-key delete",
      "ssh",
      "debug api"
    ]))
  })

  it("lets a person through to the handler, which is what refuses a malformed approval", async () => {
    const { codes, stdout } = await run(make({ environment: {} }), ["approvals", "approve", "not json", "--json"])
    expect(codes).toHaveLength(1)
    expect(JSON.parse(stdout).code).not.toBe("person_only")
  })

  it("--mcp marks the process a delegate, lists no person-only tool, and refuses person-only commands as person_only", async () => {
    const environment: Record<string, string | undefined> = {}
    const server = await mcp(environment)
    try {
      // The mark is in the environment the server's tools and their children read.
      expect(environment[DELEGATE_ACT]).toBe("agent")

      // No person-only command is a tool, by its own name or through the tool that calls tools by name.
      const listed = await server.request("tools/list", {})
      const names: Array<string> = listed.result.tools.map((tool: { name: string }) => tool.name)
      const tools = personOnlyCommands.map((command) => command.replaceAll(" ", "_"))
      expect(names.filter((name) => tools.includes(name))).toEqual([])
      for (const name of ["approvals_approve", "credentials_add", "token_mint"]) {
        const direct = await server.request("tools/call", { name, arguments: { approval: "{}" } })
        expect(direct.error ?? direct.result.isError, JSON.stringify(direct)).toBeTruthy()
        const called = await server.request("tools/call", {
          name: "call_write_tool",
          arguments: { name, arguments: { approval: "{}" } }
        })
        expect(called.error ?? called.result.isError, JSON.stringify(called)).toBeTruthy()
      }

      // H5: listing keys reads and stays a tool; adding or deleting an account key is a credential mutation, so
      // neither is discoverable and neither runs by name, directly or through the tool that calls tools.
      // The server lists its tools through `search_tools`; an empty query pages through every one of them.
      const discovered: Array<string> = []
      for (let offset = 0;; offset += 20) {
        const page = await server.request("tools/call", {
          name: "search_tools",
          arguments: { query: "", limit: 20, offset }
        })
        const found: Array<{ name: string }> = JSON.parse(page.result.content[0].text).tools
        discovered.push(...found.map((tool) => tool.name))
        if (found.length < 20) break
      }
      expect(discovered).toContain("ssh-key_list")
      expect(discovered.filter((name) => name === "ssh-key_add" || name === "ssh-key_delete")).toEqual([])
      expect(discovered.filter((name) => tools.includes(name))).toEqual([])
      for (const name of ["ssh-key_add", "ssh-key_delete"]) {
        const details = await server.request("tools/call", { name: "get_tool_details", arguments: { name } })
        expect(details.error ?? details.result.isError, JSON.stringify(details)).toBeTruthy()
      }
      for (
        const [name, args] of [
          ["ssh-key_add", { title: "agent", key: "ssh-ed25519 AAAA" }],
          ["ssh-key_delete", { id: 1 }]
        ] as const
      ) {
        const direct = await server.request("tools/call", { name, arguments: args })
        expect(direct.error ?? direct.result.isError, JSON.stringify(direct)).toBeTruthy()
        const called = await server.request("tools/call", {
          name: "call_write_tool",
          arguments: { name, arguments: args }
        })
        expect(called.error ?? called.result.isError, JSON.stringify(called)).toBeTruthy()
      }

      // The serving process itself is a delegate from here on: the same CLI refuses each person-only command,
      // typed, before any handler reads its arguments.
      for (
        const [command, argv] of [
          ["approvals approve", ["approvals", "approve", "not json"]],
          ["approvals deny", ["approvals", "deny", "not json"]],
          ["approvals grant", ["approvals", "grant", "//app:deploy"]],
          ["approvals grant-trigger", ["approvals", "grant-trigger", "not json"]],
          ["approvals revoke-trigger", ["approvals", "revoke-trigger", "nightly"]],
          ["credentials add", ["credentials", "add", "github"]],
          ["credentials rotate", ["credentials", "rotate", "github"]],
          ["credentials revoke", ["credentials", "revoke", "github"]],
          ["token mint", ["token", "mint", "--scope", "approve:runs"]],
          ["ssh-key add", ["ssh-key", "add", "--title", "agent", "--key", "ssh-ed25519 AAAA"]],
          ["ssh-key delete", ["ssh-key", "delete", "1"]]
        ] as const
      ) {
        const { codes, stdout } = await run(server.cli, [...argv, "--json"])
        expect(JSON.parse(stdout), command).toEqual(refusal(command))
        expect(codes, command).toEqual([1])
      }
    } finally {
      server.close()
    }
  })

  it("--http marks the process a delegate even though Incur serves no HTTP transport", async () => {
    const environment: Record<string, string | undefined> = {}
    const cli = make({ environment })
    await run(cli, ["--http", "--json"])
    expect(environment[DELEGATE_ACT]).toBe("agent")
    const { codes, stdout } = await run(cli, ["approvals", "approve", "not json", "--json"])
    expect(JSON.parse(stdout)).toEqual(refusal("approvals approve"))
    expect(codes).toEqual([1])
  })

  it("refuses a process the environment already marks, as a tool spawned by an MCP server is", async () => {
    const cli = make({ environment: { [DELEGATE_ACT]: "agent" } })
    const { codes, stdout } = await run(cli, ["token", "mint", "--scope", "approve:runs", "--json"])
    expect(JSON.parse(stdout)).toEqual(refusal("token mint"))
    expect(codes).toEqual([1])
    // A command an agent may run is untouched by the mark.
    const version = await run(cli, ["--version"])
    expect(version.codes).toEqual([])
  })

  it("refuses a person-only command that arrives as an HTTP request, with no mark at all", async () => {
    const environment: Record<string, string | undefined> = {}
    const response = await make({ environment }).fetch(
      new Request("http://smthrs.test/approvals/approve/not-json", { method: "POST" })
    )
    const body = JSON.stringify(await response.json())
    expect(body).toContain("person_only")
    expect(response.ok).toBe(false)
    expect(environment[DELEGATE_ACT]).toBeUndefined()
  })
})

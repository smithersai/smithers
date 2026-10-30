import { getEventListeners } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PassThrough } from "node:stream"
import { setImmediate } from "node:timers/promises"
import { expect, it } from "vitest"
import { makeCli } from "../src/Cli.ts"

it("leaves the default process input untouched when MCP starts already interrupted", async () => {
  const data = process.stdin.listeners("data")
  const errors = process.stdin.listeners("error")
  await makeCli({ signal: AbortSignal.abort() }).serve(["--mcp"])
  await setImmediate()
  expect(process.stdin.listeners("data")).toEqual(data)
  expect(process.stdin.listeners("error")).toEqual(errors)
})

/** The remote install only; MCP dispatch and its middleware run in process. */
const fixtureInstall = async () => {
  const seen: Array<string> = []
  const server = createServer((request, response) => {
    seen.push(`${request.method} ${request.url}`)
    response.setHeader("content-type", "application/json")
    if (request.url === "/api/flows/broken") {
      response.statusCode = 503
      response.end(JSON.stringify({ error: { code: "unavailable", message: "Flow store unavailable" } }))
    } else response.end(JSON.stringify({ items: [{ name: "fixture" }] }))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  return {
    seen,
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: async () => {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }
}

it.each(["eof", "abort", "pre-aborted", "input-error", "no-signal"])(
  "cleans up the MCP transport service on %s",
  async (mode) => {
    const root = await mkdtemp(join(tmpdir(), "smthrs-mcp-transport-"))
    const install = await fixtureInstall()
    const input = new PassThrough()
    const output = new PassThrough()
    const controller = new AbortController()
    const replies: Array<{ id: number | null; result?: unknown; error?: unknown }> = []
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
    const reply = async (id: number) => {
      for (;;) {
        const found = replies.find((value) => value.id === id)
        if (found !== undefined) return found
        await new Promise<void>((resolve) => output.once("data", () => resolve()))
      }
    }
    try {
      if (mode === "pre-aborted") controller.abort()
      await makeCli({
        mcpStdio: { input, output },
        environment: {
          HOME: root,
          XDG_CONFIG_HOME: root,
          SMITHERS_AUTH_FILE: join(root, "auth.json"),
          SMITHERS_DISABLE_SYSTEM_KEYRING: "1",
          SMITHERS_API_ORIGIN: install.origin,
          SMITHERS_TOKEN: "transport-synthetic-credential"
        },
        signal: mode === "no-signal" ? undefined : controller.signal
      }).serve([
        "--mcp",
        ...(mode === "pre-aborted" ? ["--update", "--help"] : mode === "no-signal" ? ["--update", "-h"] : [])
      ])
      if (mode !== "pre-aborted") {
        input.write(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "transport", version: "1" } }
          }) + "\n"
        )
        expect((await reply(1)).result).toMatchObject({ serverInfo: { name: "smthrs" } })
        input.write("{\"jsonrpc\":\"2.0\",\"method\":\"notifications/initialized\"}\n")
        input.write("{bad\n{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"ping\"}\n")
        expect((await reply(2)).result).toEqual({})
        expect(replies.find((value) => value.id === null)?.error).toEqual({ code: -32700, message: "Parse error" })
        if (mode === "eof") {
          // A local install fixture keeps the tool call independent of this machine's host.
          const call = async (id: number, name: string, args: Record<string, unknown>) => {
            input.write(
              JSON.stringify({
                jsonrpc: "2.0",
                id,
                method: "tools/call",
                params: { name: "call_read_tool", arguments: { name, arguments: args } }
              }) + "\n"
            )
            return (await reply(id)).result as { isError?: boolean; content: Array<{ text: string }> }
          }
          const listed = await call(3, "flows", {})
          expect(listed.isError, JSON.stringify(listed)).not.toBe(true)
          expect(listed.content[0]?.text).toContain("fixture")
          const refused = await call(4, "flow_show", { flow: "broken" })
          expect(refused.isError, JSON.stringify(refused)).toBe(true)
          expect(JSON.stringify(refused)).not.toContain(root)
          expect(JSON.stringify([listed, refused])).not.toContain("transport-synthetic-credential")
          expect(install.seen).toEqual(["GET /api/flows", "GET /api/flows/broken"])
        }
        expect(input.listenerCount("data")).toBe(1)
        expect(input.listenerCount("error")).toBe(1)
        expect(getEventListeners(controller.signal, "abort")).toHaveLength(mode === "no-signal" ? 0 : 1)
        if (mode === "abort") controller.abort()
        else if (mode === "input-error") input.destroy(new Error("transport read failed"))
        else input.end()
      }
      await setImmediate()
      expect(input.listenerCount("data")).toBe(0)
      expect(input.listenerCount("error")).toBe(0)
      expect(getEventListeners(controller.signal, "abort")).toHaveLength(0)
      if (mode === "pre-aborted") expect(replies).toEqual([])
      expect(buffer).toBe("")
      // Cancellation after EOF/error is harmless once the listener is released.
      controller.abort()
      expect(input.listenerCount("error")).toBe(0)
    } finally {
      controller.abort()
      input.destroy()
      output.destroy()
      await install.close()
      await rm(root, { recursive: true, force: true })
    }
  }
)

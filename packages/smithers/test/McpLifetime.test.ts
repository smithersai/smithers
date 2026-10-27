import { spawn } from "node:child_process"
import { once } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, it } from "vitest"

it.each(["no-signal", "abort", "pre-aborted"])("releases MCP stdin listeners on %s", async (mode) => {
  const root = await mkdtemp(join(tmpdir(), "smthrs-mcp-lifetime-"))
  const child = spawn(process.execPath, [
    "--no-warnings",
    fileURLToPath(new URL("./fixtures/mcp-lifetime.ts", import.meta.url)),
    mode
  ], {
    cwd: root,
    stdio: ["pipe", "pipe", "pipe", "ipc"],
    env: { ...process.env, HOME: root, XDG_CONFIG_HOME: root, XDG_DATA_HOME: root, SMITHERS_REMOTE: "" }
  })
  let stderr = "", stdout = ""
  child.stderr!.on("data", (bytes) => stderr += bytes)
  child.stdout!.on("data", (bytes) => stdout += bytes)
  const messages: Array<{ type: string; errorListeners?: number; dataListeners?: number }> = []
  const receive = async (type: string) => {
    for (;;) {
      const found = messages.find((message) => message.type === type)
      if (found !== undefined) return found
      await once(child, "message", { signal: AbortSignal.timeout(25_000) })
    }
  }
  child.on("message", (message) => messages.push(message as typeof messages[number]))
  const closed = once(child, "close")
  const timeout = setTimeout(() => child.kill("SIGKILL"), 28_000)
  try {
    await receive("ready")
    if (mode !== "pre-aborted") {
      const initialized = new Promise<void>((resolve) => {
        child.stdout!.on("data", () => {
          if (stdout.includes("\"serverInfo\"")) resolve()
        })
      })
      child.stdin!.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "lifetime", version: "1" } }
        }) + "\n"
      )
      await initialized
      expect(JSON.parse(stdout).result.serverInfo.name).toBe("smthrs")
      if (mode === "abort") child.send("abort")
      else child.stdin!.end()
    }
    expect(await receive("closed")).toEqual({ type: "closed", errorListeners: 0, dataListeners: 0 })
    child.stdin!.end()
    child.send("disconnect")
    expect((await closed)[0], stderr).toBe(0)
    expect(stderr).toBe("")
    if (mode === "pre-aborted") expect(stdout).toBe("")
  } finally {
    clearTimeout(timeout)
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
    await closed
    await rm(root, { recursive: true, force: true })
  }
})

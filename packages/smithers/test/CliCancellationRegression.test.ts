import { spawn } from "node:child_process"
import { once } from "node:events"
import { fileURLToPath } from "node:url"
import { expect, it } from "vitest"

it("cancels tui --mcp with SIGINT after the real protocol handshake", async () => {
  const bin = fileURLToPath(new URL("../src/bin.ts", import.meta.url))
  const child = spawn(process.execPath, ["--no-warnings", bin, "tui", "--mcp"], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME, XDG_DATA_HOME: process.env.XDG_DATA_HOME }
  })
  let output = "", errors = ""
  child.stderr.on("data", (chunk) => errors += chunk)
  child.stdin.on("error", () => {})
  const ready = new Promise<void>((resolve, reject) => {
    child.once("error", reject)
    child.stdout.on("data", (chunk) => {
      output += chunk
      if (output.includes("\"serverInfo\"")) resolve()
    })
    child.once("close", () => reject(new Error(`MCP closed before handshake: ${errors}`)))
  })
  const closed = once(child, "close", { signal: AbortSignal.timeout(20_000) })
  // Attach the rejection before waiting for the handshake.
  const completed = closed.then(([code]) => ({ code }), (error: unknown) => ({ error }))
  try {
    child.stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "sigint-regression", version: "1" }
        }
      }) + "\n"
    )
    await Promise.race([
      ready,
      completed.then(() => {
        throw new Error("MCP handshake did not finish")
      })
    ])
    child.kill("SIGINT")
    expect(await completed).toEqual({ code: 130 })
  } finally {
    child.kill("SIGKILL")
    child.stdin.destroy()
  }
})

it("keeps the generated approval token out of quiet stderr", async () => {
  const driver = fileURLToPath(new URL("./fixtures/quiet-host-regression.ts", import.meta.url))
  const cacheDir = process.env.VIBELANG_CACHE_DIR ?? fileURLToPath(new URL("../.cache/vibelang", import.meta.url))
  const child = spawn(
    process.execPath,
    ["--no-warnings", "--import", import.meta.resolve("vibelang/register"), driver],
    {
      env: { PATH: process.env.PATH, HOME: process.env.HOME, VIBELANG_CACHE_DIR: cacheDir }
    }
  )
  let errors = ""
  child.stderr.on("data", (chunk) => errors += chunk)
  const closed = once(child, "close", { signal: AbortSignal.timeout(20_000) })
  try {
    expect((await closed)[0]).toBe(0)
    expect(errors).toBe("")
  } finally {
    child.kill("SIGKILL")
    child.stdin.destroy()
  }
})

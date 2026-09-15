import { spawn } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import { dockerProbeBudget } from "./DockerProbe.ts"

it("terminates and joins a Docker probe that ignores SIGTERM, reporting its deadline", async () => {
  const directory = mkdtempSync(join(tmpdir(), "flows-docker-probe-"))
  const ready = join(directory, "ready.json")
  const term = join(directory, "sigterm")
  const helper = new URL("./DockerProbe.ts", import.meta.url).href
  // A real process stands in for the Docker binary. Readiness is recorded
  // only after its SIGTERM handler is installed; a server keeps it alive
  // without polling or sleeps. It never fabricates a successful probe.
  writeFileSync(
    join(directory, "docker"),
    `#!${process.execPath}\n`
      + `const { writeFileSync } = require("node:fs");\n`
      + `process.on("SIGTERM", () => writeFileSync(${JSON.stringify(term)}, "ignored"));\n`
      + `require("node:net").createServer().listen(0, "127.0.0.1", () => {\n`
      + `  writeFileSync(${JSON.stringify(ready)}, JSON.stringify({ pid: process.pid, node: process.execPath }));\n`
      + `});\n`,
    { mode: 0o755 }
  )
  const child = spawn(process.execPath, [
    "--input-type=module",
    "-e",
    `import { docker } from ${JSON.stringify(helper)};\n`
    + `try { docker(["info"]); } catch (error) {\n`
    + `  console.log(JSON.stringify({ message: error.message, code: error.cause?.code }));\n`
    + `}\n`
  ], {
    detached: true,
    env: { ...process.env, PATH: `${directory}:${process.env.PATH}` },
    stdio: ["ignore", "pipe", "pipe"]
  })
  let stdout = ""
  let stderr = ""
  let watchdog = false
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => stdout += chunk)
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => stderr += chunk)
  // Keep a regression safe: rescue the ignored-signal case, let spawnSync
  // reap its child, and fail for needing the outer watchdog. The helper's
  // real ten-second deadline is unchanged.
  const timer = setTimeout(() => {
    watchdog = true
    const pid = existsSync(ready)
      ? (JSON.parse(readFileSync(ready, "utf8")) as { pid: number }).pid
      : -child.pid!
    try {
      process.kill(pid, "SIGKILL")
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error
    }
  }, dockerProbeBudget + 5_000)
  try {
    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once("error", reject)
      child.once("close", (code, signal) => resolve({ code, signal }))
    })
    expect(existsSync(ready), stderr).toBe(true)
    const fixture = JSON.parse(readFileSync(ready, "utf8")) as { pid: number; node: string }
    expect(fixture.node).toBe(process.execPath)
    expect(() => process.kill(fixture.pid, 0)).toThrowError(expect.objectContaining({ code: "ESRCH" }))
    expect(watchdog, `SIGTERM ignored: ${existsSync(term)}; ${stderr}`).toBe(false)
    expect(result, stderr).toEqual({ code: 0, signal: null })
    expect(JSON.parse(stdout)).toEqual({
      message: `Docker info did not respond within ${dockerProbeBudget}ms`,
      code: "ETIMEDOUT"
    })
  } finally {
    clearTimeout(timer)
    if (child.pid !== undefined) {
      try {
        process.kill(-child.pid, "SIGKILL")
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error
      }
    }
    rmSync(directory, { recursive: true, force: true })
  }
})

import { spawn } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import { dockerProbeBudget } from "./DockerProbe.ts"

it("bounds a probe supplied as an executable and arguments, without shell or PATH assumptions", async () => {
  const directory = mkdtempSync(join(tmpdir(), "flows-portable-probe-"))
  const ready = join(directory, "ready.json")
  const script = join(directory, "probe.cjs")
  writeFileSync(
    script,
    `
    const fs = require("node:fs");
    process.on("SIGTERM", () => {});
    require("node:net").createServer().listen(0, "127.0.0.1", () => {
      fs.writeFileSync(${JSON.stringify(ready)}, JSON.stringify({ pid: process.pid, args: process.argv.slice(2) }));
    });
  `
  )
  const child = spawn(process.execPath, [
    "--input-type=module",
    "-e",
    `
    import { docker } from ${JSON.stringify(new URL("./DockerProbe.ts", import.meta.url).href)};
    try {
      docker(["info"], { command: process.execPath, args: [${JSON.stringify(script)}] });
      process.exitCode = 2;
    } catch (error) {
      console.log(JSON.stringify({ message: error.message, code: error.cause?.code }));
    }
  `
  ], { stdio: ["ignore", "pipe", "pipe"] })
  let stdout = ""
  let stderr = ""
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => stdout += chunk)
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => stderr += chunk)
  let watchdog = false
  const timer = setTimeout(() => {
    watchdog = true
    if (existsSync(ready)) {
      const { pid } = JSON.parse(readFileSync(ready, "utf8")) as { pid: number }
      try {
        process.kill(pid, "SIGKILL")
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error
      }
    }
    child.kill("SIGKILL")
  }, dockerProbeBudget + 5_000)
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject)
      child.once("close", resolve)
    })
    expect(existsSync(ready), stderr).toBe(true)
    const fixture = JSON.parse(readFileSync(ready, "utf8")) as { pid: number; args: Array<string> }
    expect(fixture.args).toEqual(["info"])
    expect(() => process.kill(fixture.pid, 0)).toThrowError(expect.objectContaining({ code: "ESRCH" }))
    expect(watchdog).toBe(false)
    expect(code, stderr).toBe(0)
    expect(JSON.parse(stdout)).toEqual({
      message: `Docker info did not respond within ${dockerProbeBudget}ms`,
      code: "ETIMEDOUT"
    })
  } finally {
    clearTimeout(timer)
    child.kill("SIGKILL")
    rmSync(directory, { recursive: true, force: true })
  }
})

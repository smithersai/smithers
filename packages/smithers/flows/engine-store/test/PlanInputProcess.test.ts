import { execFile, spawn } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { expect, it } from "vitest"

it(
  "recovers input observations after SIGKILL and transfers ownership without repeating a completed update",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "smithers-plan-input-process-"))
    const fixture = fileURLToPath(new URL("./fixtures/plan-input-process.mjs", import.meta.url))
    const env = {
      PATH: process.env.PATH,
      TMPDIR: process.env.TMPDIR,
      LANG: "C.UTF-8",
      SMITHERS_WORKSPACE_JJ_EXPORT_BINARY: process.env.SMITHERS_WORKSPACE_JJ_EXPORT_BINARY
    }
    await mkdir(join(root, ".flows"))
    await writeFile(join(root, "config.txt"), "initial")
    const child = spawn(process.execPath, [fixture, root, "crash"], { env, stdio: ["pipe", "pipe", "pipe"] })
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.once("exit", (code, signal) => resolve({ code, signal }))
    })
    let output = ""
    let stderr = ""
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk)
    })
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`child did not reach its durable frontier: ${stderr}`)), 30_000)
        const finish = (error?: Error) => {
          clearTimeout(timer)
          if (error) reject(error)
          else resolve()
        }
        child.stdout.on("data", (chunk) => {
          output += String(chunk)
          if (output.includes("ready-to-kill\n")) finish()
        })
        child.once("error", finish)
        child.once("exit", () => finish(new Error(`child exited before its frontier: ${stderr}`)))
      })
      expect(await readFile(join(root, "config.txt"), "utf8")).toBe("initial!")
      expect(child.kill("SIGKILL")).toBe(true)
      expect((await exited).signal).toBe("SIGKILL")
      const resumed = await promisify(execFile)(process.execPath, [fixture, root, "resume"], {
        env,
        timeout: 60_000,
        killSignal: "SIGKILL",
        maxBuffer: 524_288
      })
      const report = JSON.parse(resumed.stdout.trim().split("\n").at(-1)!)
      expect(report.updates).toBe(0)
      expect(report.changedEnvironmentRefused).toBe(true)
      expect(report.settlements.map((node: { nodeId: string; outcome: string }) => [node.nodeId, node.outcome]))
        .toEqual([
          ["update", "clean"],
          ["pause", "built"]
        ])
      expect(report.results).toEqual({ update: "initial", pause: "resumed" })
      expect(await readFile(join(root, "config.txt"), "utf8")).toBe("initial!")
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
      await exited
      await rm(root, { recursive: true, force: true })
    }
  },
  120_000
)

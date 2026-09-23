import { execFile, spawn } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { expect, it } from "vitest"

for (const frontier of ["intent", "completion"] as const) {
  it(`recovers after SIGKILL at the committed merge ${frontier} frontier`, async () => {
    const root = await mkdtemp(join(tmpdir(), "smithers-merge-process-frontier-"))
    const fixture = fileURLToPath(new URL("./fixtures/plan-merge-frontier-process.mjs", import.meta.url))
    const env = {
      PATH: process.env.PATH,
      TMPDIR: process.env.TMPDIR,
      LANG: "C.UTF-8",
      SMITHERS_WORKSPACE_JJ_EXPORT_BINARY: process.env.SMITHERS_WORKSPACE_JJ_EXPORT_BINARY
    }
    await mkdir(join(root, ".flows"))
    await writeFile(join(root, "shared.txt"), "initial")
    const child = spawn(process.execPath, [fixture, root, "crash", frontier], { env, stdio: ["pipe", "pipe", "pipe"] })
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.once("exit", (code, signal) => resolve({ code, signal }))
    })
    let stdout = ""
    let stderr = ""
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk)
    })
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`child missed ${frontier} frontier: ${stderr}`)), 30_000)
        const finish = (error?: Error) => {
          clearTimeout(timer)
          if (error) reject(error)
          else resolve()
        }
        child.stdout.on("data", (chunk) => {
          stdout += String(chunk)
          if (stdout.includes("ready-to-kill\n")) finish()
        })
        child.once("error", finish)
        child.once("exit", () => finish(new Error(`child exited early: ${stderr}`)))
      })
      expect(await readFile(join(root, "shared.txt"), "utf8")).toBe(frontier === "intent" ? "initial" : "winner")
      expect(child.kill("SIGKILL")).toBe(true)
      expect((await exited).signal).toBe("SIGKILL")
      const resumed = await promisify(execFile)(process.execPath, [fixture, root, "resume", frontier], {
        env,
        timeout: 60_000,
        killSignal: "SIGKILL",
        maxBuffer: 524_288
      })
      const report = JSON.parse(resumed.stdout.trim().split("\n").at(-1)!)
      expect(report.calls).toEqual(frontier === "intent" ? ["a", "b+merge"] : ["b+merge"])
      expect(report.appended).toEqual(frontier === "intent" ? ["b+merge"] : [])
      expect(report.settlements.map((node: { nodeId: string; outcome: string }) => [node.nodeId, node.outcome]))
        .toEqual([["a", frontier === "intent" ? "built" : "clean"], ["b", "skipped"], ["b+merge", "built"]])
      expect(report.results).toEqual({ a: "a", "b+merge": "b+merge" })
      expect(await readFile(join(root, "shared.txt"), "utf8")).toBe("merged")
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
      await exited
      await rm(root, { recursive: true, force: true })
    }
  }, 120_000)
}

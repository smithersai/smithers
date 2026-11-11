import { execFile } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { afterEach, expect, it } from "vitest"
import * as ChildProcesses from "./ChildProcesses.ts"

// A timed-out case stops awaiting its children; teardown still kills their process groups.
afterEach(ChildProcesses.reap)

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
    const child = ChildProcesses.spawn(process.execPath, [ChildProcesses.vibeImport, fixture, root, "crash"], {
      env,
      stdio: ["pipe", "pipe", "pipe"]
    })
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.once("exit", (code, signal) => resolve({ code, signal }))
    })
    try {
      await ChildProcesses.waitForLine(child, (line) => line === "ready-to-kill", {
        timeoutMs: 30_000,
        description: "durable frontier"
      })
      expect(await readFile(join(root, "config.txt"), "utf8")).toBe("initial!")
      expect(ChildProcesses.killGroup(child)).toBe(true)
      expect((await exited).signal).toBe("SIGKILL")
      const resumed = await promisify(execFile)(
        process.execPath,
        [ChildProcesses.vibeImport, fixture, root, "resume"],
        {
          env,
          timeout: 60_000,
          killSignal: "SIGKILL",
          maxBuffer: 524_288
        }
      )
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
      if (child.exitCode === null && child.signalCode === null) ChildProcesses.killGroup(child)
      await exited
      await rm(root, { recursive: true, force: true })
    }
  },
  120_000
)

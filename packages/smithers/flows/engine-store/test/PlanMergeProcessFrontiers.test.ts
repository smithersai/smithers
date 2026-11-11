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
    const child = ChildProcesses.spawn(
      process.execPath,
      [ChildProcesses.vibeImport, fixture, root, "crash", frontier],
      {
        env,
        stdio: ["pipe", "pipe", "pipe"]
      }
    )
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.once("exit", (code, signal) => resolve({ code, signal }))
    })
    try {
      await ChildProcesses.waitForLine(child, (line) => line === "ready-to-kill", {
        timeoutMs: 30_000,
        description: "durable frontier"
      })
      expect(await readFile(join(root, "shared.txt"), "utf8")).toBe(frontier === "intent" ? "initial" : "winner")
      expect(ChildProcesses.killGroup(child)).toBe(true)
      expect((await exited).signal).toBe("SIGKILL")
      const resumed = await promisify(execFile)(process.execPath, [
        ChildProcesses.vibeImport,
        fixture,
        root,
        "resume",
        frontier
      ], {
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
      if (child.exitCode === null && child.signalCode === null) ChildProcesses.killGroup(child)
      await exited
      await rm(root, { recursive: true, force: true })
    }
  }, 120_000)
}

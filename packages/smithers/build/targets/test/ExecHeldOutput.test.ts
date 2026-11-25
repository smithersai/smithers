/**
 * A tool that exits while a program it started still holds its output
 * (`Exec.HeldOutput`): the run ends the holders, or lets go of the output, and
 * never waits on it for ever. Real processes: a shell that leaves a `sleep`
 * holding its output and exits.
 *
 * @since 1.0.0
 */
import * as Effect from "effect/Effect"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import * as Exec from "../src/Exec.ts"

let root: string
const left: Array<number> = []

beforeEach(async () => {
  root = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smithers-held-output-")))
})
afterEach(async () => {
  for (const pid of left.splice(0)) {
    try {
      process.kill(pid, "SIGKILL")
    } catch {
      // Ended by the case.
    }
  }
  await Fs.rm(root, { recursive: true, force: true })
})

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * A shell that prints, leaves a `sleep` that left its session holding its output (its pid in `pid`), and exits; or
 * exits holding none. The tool's own process group ends with it: only a program that left it can hold the output.
 */
const payload = (leaves: boolean): Exec.Payload => ({
  cwd: ".",
  argv: leaves
    ? [
      process.execPath,
      "-e",
      "const { spawn } = require('node:child_process'); const fs = require('node:fs'); " +
      "process.stdout.write('started\\n'); " +
      "const child = spawn('/bin/sh', ['-c', 'exec sleep 300'], { detached: true, stdio: ['ignore', 1, 2] }); " +
      "fs.writeFileSync('pid.part', String(child.pid)); fs.renameSync('pid.part', 'pid'); " +
      "child.unref(); setTimeout(() => process.exit(0), 200);"
    ]
    : ["/bin/sh", "-c", "echo done"],
  env: {},
  secrets: [],
  expectedExitCodes: [0],
  timeoutMs: 60_000
})

const leftPid = async (): Promise<number> => {
  const pid = Number((await Fs.readFile(NodePath.join(root, "pid"), "utf8")).trim())
  left.push(pid)
  return pid
}

const linuxIt = it.skipIf(process.platform === "win32")

describe("a tool whose output a program it started still holds", () => {
  linuxIt("ends that program and returns the tool's own result", async () => {
    const asked: Array<number> = []
    let holder: number | undefined
    const held: Exec.HeldOutput = {
      links: (pid) => {
        asked.push(pid)
        return ["the tool's output"]
      },
      holders: () => holder === undefined || !alive(holder) ? [] : [holder],
      kill: (pid) => process.kill(pid, "SIGKILL")
    }
    const running = Effect.runPromise(Exec.run({ workspaceRoot: root, heldOutput: held }, payload(true)))
    holder = await (async () => {
      for (;;) {
        try {
          return await leftPid()
        } catch {
          await new Promise((done) => setTimeout(done, 20))
        }
      }
    })()
    const began = Date.now()
    const result = await running
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe("started\n")
    expect(asked).toHaveLength(1)
    expect(alive(holder)).toBe(false)
    expect(Date.now() - began).toBeLessThan(Exec.heldOutputMs.wait + Exec.heldOutputMs.end)
  }, 30_000)

  linuxIt("lets go of the output when it cannot say who holds it, and leaves the program", async () => {
    for (
      const held of [
        { links: () => ["the tool's output"], holders: () => undefined, kill: () => undefined },
        { links: () => [], holders: () => [1], kill: () => undefined }
      ] satisfies ReadonlyArray<Exec.HeldOutput>
    ) {
      const result = await Effect.runPromise(Exec.run({ workspaceRoot: root, heldOutput: held }, payload(true)))
      expect(result.exitCode).toBe(0)
      expect(alive(await leftPid())).toBe(true)
    }
  }, 30_000)

  linuxIt("lets go of the output when the program outlives every attempt to end it", async () => {
    const began = Date.now()
    const held: Exec.HeldOutput = {
      links: () => ["the tool's output"],
      holders: () => [process.pid],
      kill: () => undefined
    }
    const result = await Effect.runPromise(Exec.run({ workspaceRoot: root, heldOutput: held }, payload(true)))
    expect(result.exitCode).toBe(0)
    expect(Date.now() - began).toBeGreaterThanOrEqual(Exec.heldOutputMs.wait + Exec.heldOutputMs.end)
    expect(alive(await leftPid())).toBe(true)
  }, 30_000)

  it("asks nothing when nothing holds the output once the tool ends", async () => {
    const held: Exec.HeldOutput = {
      links: () => ["the tool's output"],
      holders: () => {
        throw new Error("asked")
      },
      kill: () => undefined
    }
    const result = await Effect.runPromise(Exec.run({ workspaceRoot: root, heldOutput: held }, payload(false)))
    expect(result.stdout).toBe("done\n")
  })
})

/**
 * A test that times out stops awaiting its child process, so the `finally`
 * that would kill the child never runs, and the worker exits without killing
 * it. On the test farm such children outlived their runs by days. Each case
 * here starts a fixture child through the helper its own test uses, abandons
 * it the way a timed-out test does, runs the teardown those files register
 * (`ChildProcesses.reap`), and then asks the process table whether the child
 * is still alive.
 */
import { afterEach, describe, expect, it } from "@effect/vitest"
import { spawn as nodeSpawn, spawnSync } from "node:child_process"
import { once } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import * as ChildProcesses from "./ChildProcesses.ts"
import * as LeaseReclaimProcess from "./LeaseReclaimProcess.ts"
import * as ReclaimedAttemptProcess from "./ReclaimedAttemptProcess.ts"

/** Live processes whose command line names `fixture` and this case's own `filename`. */
const alive = (fixture: string, filename: string): Array<{ readonly pid: number; readonly args: string }> => {
  const ps = spawnSync("ps", ["-A", "-ww", "-o", "pid=,stat=,args="], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    env: { LC_ALL: "C", PATH: "/usr/bin:/bin" }
  })
  if (ps.status !== 0) throw new Error(`ps failed (${ps.status}): ${ps.stderr}`)
  return ps.stdout.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(\S+)\s+(.*)$/.exec(line)
    if (match === null || match[2]!.startsWith("Z")) return []
    const args = match[3]!
    return args.includes(fixture) && args.includes(filename) ? [{ pid: Number(match[1]), args }] : []
  })
}

let directory: string | undefined
const leaked: Array<number> = []

afterEach(async () => {
  // A red run must not leave its own evidence behind.
  for (const pid of leaked.splice(0)) {
    try {
      process.kill(pid, "SIGKILL")
    } catch {
      // already gone
    }
  }
  if (directory !== undefined) await rm(directory, { recursive: true, force: true })
  directory = undefined
})

const scratch = async (prefix: string, name: string): Promise<string> => {
  directory = await mkdtemp(join(tmpdir(), prefix))
  return join(directory, name)
}

const reapHost = fileURLToPath(new URL("./fixtures/reap-host.ts", import.meta.url))

describe("test children do not outlive their teardown", () => {
  it.each(["exit", "SIGTERM"] as const)("a worker ended by %s kills its child's process group", async (ending) => {
    const host = nodeSpawn(process.execPath, [reapHost, ending], { stdio: ["ignore", "pipe", "inherit"] })
    let output = ""
    host.stdout.setEncoding("utf8")
    host.stdout.on("data", (chunk: string) => {
      output += chunk
    })
    const ended = once(host, "exit")
    await new Promise<void>((resolve) => host.stdout.once("data", () => resolve()))
    const child = Number(output.trim())
    leaked.push(child)
    if (ending === "SIGTERM") host.kill("SIGTERM")
    const [code, signal] = await ended
    expect(ending === "SIGTERM" ? signal : code).toBe(ending === "SIGTERM" ? "SIGTERM" : 0)
    const state = spawnSync("ps", ["-o", "stat=", "-p", String(child)], { encoding: "utf8" }).stdout.trim()
    expect(state === "" || state.startsWith("Z")).toBe(true)
  })

  it("reaps a reclaimed-attempt child whose test stopped awaiting it", async () => {
    const filename = await scratch("reap-reclaimed-attempt-", "engine.db")
    // Abandoned, as a timed-out test abandons it: nothing awaits the marker.
    const abandoned = ReclaimedAttemptProcess.killDuringTest(filename).catch(() => undefined)
    expect(alive(ReclaimedAttemptProcess.fixture, filename)).toHaveLength(1)
    await ChildProcesses.reap()
    const left = alive(ReclaimedAttemptProcess.fixture, filename)
    leaked.push(...left.map((child) => child.pid))
    expect(left).toEqual([])
    await abandoned
  })

  it("reaps a lease-reclaim child whose test never killed it", async () => {
    const filename = await scratch("reap-lease-reclaim-", "runs.db")
    const child = LeaseReclaimProcess.launch(filename, "reap-after-abandon")
    expect(alive(LeaseReclaimProcess.fixture, filename).map((found) => found.pid)).toEqual([child.pid])
    await ChildProcesses.reap()
    const left = alive(LeaseReclaimProcess.fixture, filename)
    leaked.push(...left.map((found) => found.pid))
    expect(left).toEqual([])
  })

  it("kills the whole process group of a child it kills on purpose", async () => {
    const filename = await scratch("reap-group-", "marker")
    // The leader starts a grandchild in its group and exits; only a group kill reaches it.
    const child = ChildProcesses.spawn("/bin/sh", ["-c", `sleep 600 & echo started; wait`, filename])
    await new Promise<void>((resolve) => child.stdout.once("data", () => resolve()))
    const grandchild = alive("sleep 600", "").filter((found) => found.args === "sleep 600").filter((found) => {
      const ps = spawnSync("ps", ["-o", "pgid=", "-p", String(found.pid)], { encoding: "utf8" })
      return Number(ps.stdout.trim()) === child.pid
    })
    expect(grandchild).toHaveLength(1)
    await ChildProcesses.kill(child)
    const left = alive("sleep 600", "").filter((found) => found.pid === grandchild[0]!.pid)
    leaked.push(...left.map((found) => found.pid))
    expect(left).toEqual([])
    expect(ChildProcesses.pids()).toEqual([])
  })
})

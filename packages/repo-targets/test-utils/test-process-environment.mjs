import { spawnSync } from "node:child_process"
import { mkdtempSync } from "node:fs"
import { rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { registerRootCleanup } from "./vitest-root-temp.mjs"

const rows = (options) => {
  // `-o args=` with `eww` appends each process's environment on macOS and Linux alike.
  const table = spawnSync("ps", [...options, "-A", "-o", "pid=,ppid=,pgid=,args="], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    env: { LC_ALL: "C", PATH: "/usr/bin:/bin" }
  })
  if (table.error !== undefined) throw table.error
  if (table.status !== 0) throw new Error(`ps failed (${table.status}): ${table.stderr}`)
  return table.stdout.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line)
    return match === null ? [] : [{ pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]), args: match[4] }]
  })
}

// Vitest stops a fork with SIGTERM, then SIGKILL 500 ms later, so a wedged worker runs no teardown and no exit hook, and
// the child it started (Miniflare's workerd, a test's fixture) is orphaned. This run's TMPDIR in the environment says
// whose orphan it is. Returns the commands it killed; never prints an environment.
export const reapOrphans = (directory) => {
  if (process.platform === "win32") return []
  const orphans = rows(["eww"]).filter((row) => row.ppid === 1 && row.args.includes(`TMPDIR=${directory}`))
  if (orphans.length === 0) return []
  const table = rows(["-ww"])
  const doomed = new Map(table.filter((row) => orphans.some((orphan) => orphan.pid === row.pid)).map((row) => [row.pid, row]))
  for (let grew = true; grew;) {
    grew = false
    for (const row of table) {
      if (doomed.has(row.ppid) && !doomed.has(row.pid)) {
        doomed.set(row.pid, row)
        grew = true
      }
    }
  }
  for (const pid of doomed.keys()) {
    try {
      process.kill(pid, "SIGKILL")
    } catch (cause) {
      if (cause.code !== "ESRCH") throw cause
    }
  }
  return [...doomed.values()].map((row) => row.args)
}

// A run owns its scratch and default cache; explicit caches stay with the caller.
// Keep this short: Unix socket paths are bounded.
export function setup(project) {
  registerRootCleanup(project.vitest)
  const directory = mkdtempSync(join(tmpdir(), "st-"))
  // Vitest closes the worker pool before these callbacks, including on cancellation.
  project.vitest.onClose(async () => {
    try {
      for (const command of reapOrphans(directory)) {
        process.stderr.write(`[test-process-environment] killed a process its worker orphaned: ${command}\n`)
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
  const values = {
    NODE_COMPILE_CACHE: process.env.NODE_COMPILE_CACHE ?? join(directory, "node-compile-cache"),
    TMPDIR: directory,
    TEMP: directory,
    TMP: directory
  }
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]))
  Object.assign(process.env, values)
  return () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

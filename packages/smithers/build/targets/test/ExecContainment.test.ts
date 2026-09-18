import { Effect } from "effect"
import { spawnSync } from "node:child_process"
import type { SpawnSyncReturns } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { describe, expect, it } from "vitest"
import * as Exec from "../src/Exec.ts"

type Inspection = (pid: number) => SpawnSyncReturns<string>

const inspect: Inspection = (pid) =>
  spawnSync("/bin/ps", ["-ww", "-o", "stat=,command=", "-p", String(pid)], {
    encoding: "utf8",
    timeout: 2000,
    killSignal: "SIGKILL",
    env: { PATH: "/usr/bin:/bin", LC_ALL: "C" }
  })

// `ps -p` reports a process that no longer exists with exit status 1 and no
// output on either stream. Every other outcome (a timeout, a missing or
// refused /bin/ps, a diagnostic on stderr, a success with no description) is an
// inspection that never observed the process, and reading it as an exit would
// turn a surviving child into a passing lifecycle assertion.
const identity = (pid: number, run: Inspection = inspect): string => {
  const result = run(pid)
  const description = result.stdout?.trim() ?? ""
  const diagnostic = result.stderr?.trim() ?? ""
  if (result.error === undefined && result.status === 1 && description === "" && diagnostic === "") return "gone"
  if (result.error !== undefined || result.status !== 0 || description === "") {
    const detail = result.error?.message
      ?? (diagnostic === "" ? `exit status ${String(result.status)} with no output` : diagnostic)
    throw new Error(`ps -p ${pid} failed: ${detail}`)
  }
  return description
}

describe("process inspection", () => {
  const answer = (overrides: Partial<SpawnSyncReturns<string>>): SpawnSyncReturns<string> => ({
    pid: 4242,
    output: [],
    stdout: "",
    stderr: "",
    status: 0,
    signal: null,
    ...overrides
  })

  it("reads the no-match status with no output as an exited process", () => {
    expect(identity(4242, () => answer({ status: 1 }))).toBe("gone")
  })

  it("returns the trimmed description of a live process", () => {
    expect(identity(4242, () => answer({ stdout: "S+ node -e beat\n" }))).toBe("S+ node -e beat")
  })

  const faults: Array<[string, SpawnSyncReturns<string>]> = [
    ["a timeout", answer({ status: null, signal: "SIGKILL", error: new Error("spawnSync /bin/ps ETIMEDOUT") })],
    ["an unavailable ps", answer({ status: null, error: new Error("spawnSync /bin/ps ENOENT") })],
    ["a refused ps", answer({ status: null, error: new Error("spawnSync /bin/ps EACCES") })],
    ["a ps diagnostic", answer({ status: 1, stderr: "ps: process id too large: 999998" })],
    ["a success with no description", answer({ status: 0 })]
  ]

  it.each(faults)("refuses to read %s as a dead process", (_name, result) => {
    expect(() => identity(4242, () => result)).toThrow(/ps -p 4242 failed/)
  })

  // The fixtures above only pin the helper. These pin the fixtures to /bin/ps.
  it.skipIf(process.platform === "win32")("reads a reaped child as an exited process", () => {
    const reaped = spawnSync("/bin/sleep", ["0"], { encoding: "utf8" })
    expect(reaped.status).toBe(0)
    expect(identity(reaped.pid)).toBe("gone")
  })

  it.skipIf(process.platform === "win32")("describes the running test process", () => {
    expect(identity(process.pid)).toContain(basename(process.execPath))
  })

  // A negative number is not a pid on any POSIX host, so both `ps` families
  // decline it and say so on stderr. A merely enormous pid is not portable:
  // BSD `ps` rejects 999999999 as too large, while procps accepts anything
  // below its own `pid_max` and reports it exactly as it reports a process
  // that has exited, which is the answer this case must not be given.
  it.skipIf(process.platform === "win32")("refuses a pid that ps declines to inspect", () => {
    expect(() => identity(-1)).toThrow(/ps -p -1 failed/)
  })
})

describe.skipIf(process.platform === "win32")("Exec natural process exit", () => {
  it.each([false, true])("reaps a late child after target exit (inherited output: %s)", async (inheritedOutput) => {
    const directory = await mkdtemp(join(tmpdir(), "smithers-exec-child-"))
    const token = randomUUID()
    const beatPath = join(directory, "beat.json")
    const read = async (): Promise<
      { readonly token: string; readonly pid: number; readonly tick: number } | undefined
    > => {
      try {
        return JSON.parse(await readFile(beatPath, "utf8"))
      } catch {
        return undefined
      }
    }
    const child = `const fs=require('node:fs');const token=${JSON.stringify(token)};const path=${
      JSON.stringify(beatPath)
    };let tick=0;process.on('SIGTERM',()=>{});const beat=()=>{fs.writeFileSync(path+'.tmp',JSON.stringify({token,pid:process.pid,tick:tick++}));fs.renameSync(path+'.tmp',path)};beat();setInterval(beat,20)`
    const leader = `const fs=require('node:fs');require('node:child_process').spawn(process.execPath,['-e',${
      JSON.stringify(child)
    }],{stdio:${
      inheritedOutput ? "['ignore','inherit','inherit']" : "'ignore'"
    }}).unref();setInterval(()=>{if(fs.existsSync(${
      JSON.stringify(beatPath)
    }))process.stdout.write('target-complete\\n',()=>process.exit(0))},5)`
    let failure: unknown
    try {
      const result = await Effect.runPromise(Exec.run({ workspaceRoot: directory }, {
        cwd: ".",
        argv: [process.execPath, "-e", leader],
        env: {},
        secrets: [],
        expectedExitCodes: [0],
        timeoutMs: 5000
      }))
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toBe("target-complete\n")
      const first = await read()
      expect(first?.token).toBe(token)
      const observed = identity(first!.pid)
      expect(observed === "gone" || observed.startsWith("Z"), observed).toBe(true)
      await new Promise((resolve) => setTimeout(resolve, 120))
      expect(await read()).toEqual(first)
    } catch (error) {
      failure = error
    }
    // Cleanup owns the fixture whether or not the assertions held, and an
    // inspection that fails here is reported rather than read as a child that
    // no longer needs killing.
    const owned = await read()
    let escaped: string | undefined
    if (owned?.token === token) {
      try {
        if (identity(owned.pid).includes(token)) {
          try {
            process.kill(owned.pid, "SIGKILL")
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error
          }
          const deadline = Date.now() + 5000
          while (Date.now() < deadline) {
            const observed = identity(owned.pid)
            if (observed === "gone" || observed.startsWith("Z")) break
            await new Promise((resolve) => setTimeout(resolve, 10))
          }
        }
      } catch (error) {
        escaped = `could not clean up fixture ${owned.pid}: ${error instanceof Error ? error.message : String(error)}`
      }
    }
    await rm(directory, { recursive: true, force: true })
    if (failure !== undefined) throw failure
    if (escaped !== undefined) throw new Error(escaped)
  })
})

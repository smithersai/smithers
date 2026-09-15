/**
 * `smthrs up -d`, driven against real child processes.
 *
 * The 0.x requirements carried forward
 * (`apps/cli/tests/detached-launch-admission.e2e.test.js` and
 * `detached-admission-timeout.test.js`): a launch returns only after the child
 * proves it persisted the run row, a child that dies first is reported as a
 * failed launch with its output attached, and a child that is alive but silent
 * past the grace window is terminated rather than left running.
 */
import { spawn } from "node:child_process"
import { getEventListeners } from "node:events"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import * as Detached from "../src/Detached.ts"
import * as Project from "../src/Project.ts"

const staged: Array<string> = []

const project = (): string => {
  const root = mkdtempSync(join(tmpdir(), "smithers-detached-"))
  staged.push(root)
  return root
}

/**
 * A stand-in for the `smthrs run` child: a script that behaves the way one
 * behaves, without booting an engine. `entry` replaces the CLI entry point, so
 * `launch` still spawns a real detached process and still polls a real log.
 */
const child = (body: string): string => {
  const root = project()
  const file = join(root, "child.mjs")
  writeFileSync(file, body, "utf8")
  return file
}

const processGone = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return false
  } catch (error) {
    const code = (error as { readonly code?: string } | null)?.code
    if (code === "ESRCH") return true
    if (code === "EPERM") return false
    throw error
  }
}

const until = async (predicate: () => boolean, timeoutMs: number): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  return predicate()
}

afterEach(() => {
  while (staged.length > 0) rmSync(staged.pop()!, { recursive: true, force: true })
})

describe("the admission line", () => {
  it("round-trips the nonce and the run id", () => {
    const line = Detached.admissionLine("nonce-1", "run-42")

    expect(line).toBe("SMITHERS_DETACHED_ADMISSION=run:nonce-1 runId=run-42")
    expect(Detached.admittedRunId(`noise\n${line}\nmore`, "nonce-1")).toBe("run-42")
  })

  it("ignores a line stamped with another launcher's nonce", () => {
    expect(Detached.admittedRunId(Detached.admissionLine("other", "run-42"), "nonce-1")).toBeUndefined()
    expect(Detached.admittedRunId("", "nonce-1")).toBeUndefined()
  })

  it("ignores a truncated line with no run id", () => {
    expect(Detached.admittedRunId("SMITHERS_DETACHED_ADMISSION=run:nonce-1 runId=", "nonce-1")).toBeUndefined()
  })

  it("reads a run id at the very end of the log", () => {
    expect(Detached.admittedRunId("SMITHERS_DETACHED_ADMISSION=run:n runId=run-9", "n")).toBe("run-9")
  })

  it("refuses a run id that is not one safe filename component", () => {
    // The log the run id is parsed out of is the child's whole stdout/stderr:
    // workflow output, agent transcripts, and tool output all share it. A
    // forged line carrying a path-shaped id must never reach `renameSync`,
    // where it would move the log — and any file already at the target —
    // outside the log directory.
    const forged = (runId: string) => `SMITHERS_DETACHED_ADMISSION=run:n runId=${runId}`
    expect(Detached.admittedRunId(forged("../escape"), "n")).toBeUndefined()
    expect(Detached.admittedRunId(forged("../../etc/passwd"), "n")).toBeUndefined()
    expect(Detached.admittedRunId(forged("/absolute"), "n")).toBeUndefined()
    expect(Detached.admittedRunId(forged(".."), "n")).toBeUndefined()
    expect(Detached.admittedRunId(forged("nested/name"), "n")).toBeUndefined()
    expect(Detached.admittedRunId(forged("back\\slash"), "n")).toBeUndefined()
    expect(Detached.admittedRunId(forged(`.hidden`), "n")).toBeUndefined()
    expect(Detached.admittedRunId(forged(`a${"x".repeat(128)}`), "n")).toBeUndefined()
    // The shapes real control planes mint still pass.
    expect(Detached.admittedRunId(forged("run-42"), "n")).toBe("run-42")
    expect(Detached.admittedRunId(forged("018f3c9e-7b2a-7f3e-9c4d-2a1b0e5f6a7d"), "n")).toBe(
      "018f3c9e-7b2a-7f3e-9c4d-2a1b0e5f6a7d"
    )
  })
})

describe("the log tail", () => {
  it("is empty for a file that is not there", () => {
    expect(Detached.logTail(join(project(), "absent.log"))).toBe("")
  })

  it("returns the last bytes of a long file", () => {
    const file = join(project(), "long.log")
    writeFileSync(file, "abcdefghij", "utf8")

    expect(Detached.logTail(file, 4)).toBe("ghij")
    expect(Detached.logTail(file)).toBe("abcdefghij")
  })
})

describe("launching", () => {
  it("returns the run id and renames the log onto it", async () => {
    const root = project()
    const entry = child(
      `process.stderr.write("SMITHERS_DETACHED_ADMISSION=run:" + process.env.SMITHERS_INTERNAL_DETACHED_ADMISSION + " runId=run-7\\n")
       setTimeout(() => {}, 200)`
    )

    const result = await Detached.launch({ root, payload: "{}", entry, intervalMs: 10 })

    expect(Detached.isLaunched(result)).toBe(true)
    const launched = result as Detached.Launched
    expect(launched.runId).toBe("run-7")
    expect(launched.logFile).toBe(Project.logFile(root, "run-7"))
    expect(readFileSync(launched.logFile, "utf8")).toContain("runId=run-7")
    expect(typeof launched.pid).toBe("number")
  }, 30_000)

  it("reports a child that exited before admission, with its output", async () => {
    const root = project()
    const entry = child(`process.stderr.write("no seat configured\\n"); process.exit(3)`)

    const result = await Detached.launch({ root, payload: "{}", entry, intervalMs: 10 })

    // A launcher that returned a run id here would report a run for a process
    // that is already dead, and the operator would find out from an empty `ps`.
    expect(Detached.isLaunched(result)).toBe(false)
    const rejected = result as Detached.Rejected
    expect(rejected.reason).toContain("exited before admission (exit 3)")
    expect(rejected.tail).toContain("no seat configured")
    expect(existsSync(rejected.logFile)).toBe(true)

    Detached.discard(rejected)
    expect(existsSync(rejected.logFile)).toBe(false)
    // Discarding a log that is already gone is not an error.
    expect(() => Detached.discard(rejected)).not.toThrow()
  }, 30_000)

  it("does not rename the log onto a forged run id that escapes the log directory", async () => {
    const root = project()
    // Anything the child writes lands in this log — including untrusted agent
    // output — so the admission parse is an untrusted-input boundary. A forged
    // line with a traversal id must be ignored, not turned into a rename that
    // drops the log outside `.flows/logs`.
    const entry = child(
      `process.stderr.write("SMITHERS_DETACHED_ADMISSION=run:" + process.env.SMITHERS_INTERNAL_DETACHED_ADMISSION + " runId=../escaped\\n")
       process.exit(0)`
    )

    const result = await Detached.launch({ root, payload: "{}", entry, intervalMs: 10 })

    expect(Detached.isLaunched(result)).toBe(false)
    expect((result as Detached.Rejected).reason).toContain("exited before admission")
    expect(existsSync(join(root, ".flows", "escaped.log"))).toBe(false)
  }, 30_000)

  it("terminates a child that is alive but silent past the grace window", async () => {
    const root = project()
    const entry = child(`setInterval(() => {}, 1000)`)
    const notices: Array<string> = []

    const result = await Detached.launch({
      root,
      payload: "{}",
      entry,
      timeoutMs: 150,
      intervalMs: 10,
      onSlowBoot: (message) => notices.push(message)
    })

    expect(Detached.isLaunched(result)).toBe(false)
    const rejected = result as Detached.Rejected
    expect(rejected.reason).toContain("did not reach admission within 600ms")
    expect(rejected.reason).toContain("was still alive and was terminated")
    expect(rejected.reason).toContain("SMITHERS_DETACHED_ADMISSION_TIMEOUT_MS")
    // The slow-boot notice fires once, when the grace window opens: a loaded
    // machine can spend the whole first window on module parse.
    expect(notices).toHaveLength(1)
    expect(notices[0]).toContain("still booting")
  }, 30_000)

  it.skipIf(process.platform === "win32")("kills a SIGTERM-trapping child and its descendant", async () => {
    const root = project()
    const entry = child(
      `import { spawn } from "node:child_process"
       process.on("SIGTERM", () => {})
       const descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" })
       process.stderr.write("parent=" + process.pid + " descendant=" + descendant.pid + "\\n")
       setInterval(() => {}, 1000)`
    )

    const result = await Detached.launch({
      root,
      payload: "{}",
      entry,
      timeoutMs: 500,
      intervalMs: 10,
      terminationGraceMs: 150
    })

    expect(Detached.isLaunched(result)).toBe(false)
    const rejected = result as Detached.Rejected
    expect(rejected.reason).toContain("was terminated")
    expect(rejected.reason).not.toContain("could not be confirmed terminated")

    const tail = Detached.logTail(rejected.logFile)
    const pids = /parent=(\d+) descendant=(\d+)/.exec(tail)
    expect(pids).not.toBeNull()
    if (pids === null) throw new Error(`detached log did not contain both pids: ${tail}`)
    const parentPid = Number(pids[1])
    const descendantPid = Number(pids[2])

    const [parentGone, descendantGone, groupGone] = await Promise.all([
      until(() => processGone(parentPid), 2_000),
      until(() => processGone(descendantPid), 2_000),
      until(() => processGone(-parentPid), 2_000)
    ])
    expect(parentGone).toBe(true)
    expect(descendantGone).toBe(true)
    expect(groupGone).toBe(true)
  }, 30_000)

  it.skipIf(process.platform === "win32")("aborts admission and reaps the child process group", async () => {
    const root = project()
    const ready = join(root, "ready")
    const entry = child(
      `import { spawn } from "node:child_process"
       import { writeFileSync, renameSync } from "node:fs"
       process.on("SIGTERM", () => {})
       const descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" })
       writeFileSync(${JSON.stringify(ready + ".tmp")}, JSON.stringify([process.pid, descendant.pid]))
       renameSync(${JSON.stringify(ready + ".tmp")}, ${JSON.stringify(ready)})
       setInterval(() => {}, 1000)`
    )
    const controller = new AbortController()
    const options = {
      root,
      payload: "{}",
      entry,
      signal: controller.signal,
      timeoutMs: 10_000,
      intervalMs: 5_000,
      terminationGraceMs: 100
    }
    const pending = Detached.launch(options)
    let pids: Array<number> = []
    try {
      expect(await until(() => existsSync(ready), 10_000)).toBe(true)
      pids = JSON.parse(readFileSync(ready, "utf8"))
      controller.abort()
      // Cancellation must wake the admission poll, even with a long interval.
      expect(await until(() => processGone(-pids[0]!), 2_000)).toBe(true)
      const result = await pending
      expect(Detached.isLaunched(result)).toBe(false)
      expect((result as Detached.Rejected).reason).toContain("interrupted")
      expect(existsSync(result.logFile)).toBe(true)
      expect(getEventListeners(controller.signal, "abort")).toHaveLength(0)
      expect(pids.every(processGone)).toBe(true)
    } finally {
      controller.abort()
      if (pids[0] !== undefined && !processGone(-pids[0])) process.kill(-pids[0], "SIGKILL")
      await pending
    }
  })

  it("releases cancellation ownership after admission", async () => {
    const root = project()
    const controller = new AbortController()
    const entry = child(
      `process.stderr.write("SMITHERS_DETACHED_ADMISSION=run:" + process.env.SMITHERS_INTERNAL_DETACHED_ADMISSION + " runId=run-owned\\n")
       setInterval(() => {}, 1000)`
    )
    const options = { root, payload: "{}", entry, signal: controller.signal, intervalMs: 10 }
    const result = await Detached.launch(options)
    expect(Detached.isLaunched(result)).toBe(true)
    const pid = (result as Detached.Launched).pid!
    try {
      expect(getEventListeners(controller.signal, "abort")).toHaveLength(0)
      controller.abort()
      expect(processGone(pid)).toBe(false)
    } finally {
      if (!processGone(pid)) process.kill(pid, "SIGKILL")
      expect(await until(() => processGone(pid), 2_000)).toBe(true)
    }
  })

  it("does not spawn when the signal is already aborted", async () => {
    const root = project()
    const controller = new AbortController()
    controller.abort()
    const options = { root, payload: "{}", entry: child(""), signal: controller.signal }
    await expect(Detached.launch(options)).rejects.toMatchObject({ name: "AbortError" })
    expect(existsSync(Project.logDirectory(root))).toBe(false)
  })

  it("cleans up when admission polling throws", async () => {
    const root = project()
    const ready = join(root, "ready")
    const entry = child(
      `import { writeFileSync } from "node:fs"
       writeFileSync(${JSON.stringify(ready)}, String(process.pid))
       setInterval(() => {}, 1000)`
    )
    let pid: number | undefined
    try {
      const result = await Detached.launch({
        root,
        payload: "{}",
        entry,
        timeoutMs: 5_000,
        intervalMs: 10,
        onSlowBoot: () => {
          throw new Error("notice failed")
        }
      })
      pid = Number(readFileSync(ready, "utf8"))
      expect(Detached.isLaunched(result)).toBe(false)
      expect((result as Detached.Rejected).reason).toContain("notice failed")
      expect(processGone(pid)).toBe(true)
    } finally {
      if (pid === undefined && existsSync(ready)) pid = Number(readFileSync(ready, "utf8"))
      if (pid !== undefined && !processGone(pid)) process.kill(pid, "SIGKILL")
    }
  })

  it("passes the operator's extra arguments through to the child", async () => {
    const root = project()
    const entry = child(
      `process.stderr.write(process.argv.slice(2).join(" ") + "\\n")
       process.stderr.write("SMITHERS_DETACHED_ADMISSION=run:" + process.env.SMITHERS_INTERNAL_DETACHED_ADMISSION + " runId=run-8\\n")`
    )

    const result = await Detached.launch({
      root,
      payload: "{\"plan\":1}",
      passthrough: ["--remote", "https://control.test"],
      entry,
      intervalMs: 10
    })

    const launched = result as Detached.Launched
    expect(readFileSync(launched.logFile, "utf8")).toContain("run {\"plan\":1} --remote https://control.test")
  }, 30_000)

  it("supersedes a previous run's log instead of destroying it when the run id collides", async () => {
    const root = project()
    const previous = Project.logFile(root, "run-collision")
    const directory = Project.logDirectory(root)
    mkdirSync(directory, { recursive: true })
    writeFileSync(previous, "previous run output\n", "utf8")
    const entry = child(
      `process.stderr.write("new run output\\n")
       process.stderr.write("SMITHERS_DETACHED_ADMISSION=run:" + process.env.SMITHERS_INTERNAL_DETACHED_ADMISSION + " runId=run-collision\\n")`
    )

    const result = await Detached.launch({ root, payload: "{}", entry, intervalMs: 10 })

    expect(Detached.isLaunched(result)).toBe(true)
    // The receipt still names the canonical path, so `up -d` reports the same
    // file it always did and the new run's output is the whole of it.
    const log = readFileSync(previous, "utf8")
    expect(log).toContain("new run output")
    expect(log).not.toContain("previous run output")
    // The earlier run's output survives beside it. Renaming over the path was
    // silent, unrecoverable evidence loss: the log of a run an operator is
    // still diagnosing is the one thing `up -d` writes that nothing else
    // holds a copy of.
    const superseded = readdirSync(directory).filter((name) => name.startsWith("run-collision.superseded-"))
    expect(superseded).toHaveLength(1)
    expect(readFileSync(join(directory, superseded[0]!), "utf8")).toContain("previous run output")
  }, 30_000)

  it("defaults the admission window to thirty seconds", () => {
    expect(Detached.defaultTimeoutMs).toBe(30_000)
    expect(Detached.admissionVariable).toBe("SMITHERS_INTERNAL_DETACHED_ADMISSION")
  })
})

describe("terminating a child the host gave no process group", () => {
  it("reports that containment could not be confirmed rather than claiming a kill", async () => {
    // A spawn that never became a process: the executable does not exist, so
    // Node reports the failure asynchronously and the handle carries no pid.
    // There is no group to signal and no exit to observe, and `terminate` has
    // to say so. Reporting `true` here is the failure mode this case exists
    // for — the caller renders "was terminated" for a child it never reached,
    // and an operator reads a containment claim the host never made.
    const spawned = spawn(join(tmpdir(), "smithers-no-such-executable"), [], { stdio: "ignore" })
    const failed = new Promise<void>((resolve) => spawned.once("error", () => resolve()))
    await failed
    expect(spawned.pid).toBeUndefined()

    // A short grace: the two reap windows are the whole cost of this case, and
    // nothing about the answer changes with a longer one.
    expect(await Detached.terminate(spawned, 20)).toBe(false)
  }, 30_000)
})

describe("terminating on a host that has no process groups", () => {
  /**
   * What `smthrs up -d` ships to Windows. `process.kill(-pid, …)` is not a
   * thing there, so the handle is the only reachable target, and the whole
   * containment claim is about the leader. The rest of this suite runs on POSIX
   * and can never enter that arm, so `platform` is passed rather than read: a
   * branch that only a different operating system reaches is a branch nobody
   * has ever run, and the point of shipping it is that it works.
   */
  it("signals the child handle itself and confirms the leader is gone", async () => {
    const alive = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" })
    const pid = alive.pid
    if (pid === undefined) throw new Error("the fixture child did not start")

    expect(await Detached.terminate(alive, 2_000, "win32")).toBe(true)
    expect(await until(() => processGone(pid), 2_000)).toBe(true)
  }, 30_000)

  it("answers true without signalling anything when the child has already exited", async () => {
    const finished = spawn(process.execPath, ["-e", ""], { stdio: "ignore" })
    await new Promise<void>((resolve) => finished.once("exit", () => resolve()))

    // Nothing to contain, so nothing is claimed beyond what the handle already
    // shows. The POSIX arm answers the same way through the group probe, which
    // is why the two arms can share one caller.
    expect(await Detached.terminate(finished, 20, "win32")).toBe(true)
  }, 30_000)
})

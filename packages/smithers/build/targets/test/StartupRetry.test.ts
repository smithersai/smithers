import * as ScopedProcess from "@smthrs/platform-node/ScopedProcess"
import * as Effect from "effect/Effect"
import * as PlatformError from "effect/PlatformError"
import { execFileSync } from "node:child_process"
import * as Fs from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import * as Exec from "../src/Exec.ts"
import { Process } from "../src/internal/Process.ts"

let root: string
beforeEach(async () => {
  root = await Fs.realpath(await Fs.mkdtemp(join(tmpdir(), "exec-startup-retry-")))
})
afterEach(async () => {
  await Fs.rm(root, { recursive: true, force: true })
})

/** Appends one line per run, so a second run of the tool is visible. */
const payload: Exec.Payload = {
  cwd: ".",
  argv: ["/bin/sh", "-c", "echo ran >> runs.txt"],
  env: {},
  secrets: [],
  expectedExitCodes: [0],
  timeoutMs: 60_000
}

const runs = () => Fs.readFile(join(root, "runs.txt"), "utf8").catch(() => "")

/** Every live descendant of this test process, by pid. */
const descendants = (): ReadonlySet<number> => {
  const parents = new Map<number, Array<number>>()
  for (const row of execFileSync("ps", ["-A", "-o", "pid=,ppid="], { encoding: "utf8" }).trim().split("\n")) {
    const [pid, ppid] = row.trim().split(/\s+/).map(Number) as [number, number]
    parents.set(ppid, [...parents.get(ppid) ?? [], pid])
  }
  const found = new Set<number>()
  const todo = [process.pid]
  while (todo.length > 0) {
    for (const child of parents.get(todo.pop()!) ?? []) {
      if (!found.has(child)) {
        found.add(child)
        todo.push(child)
      }
    }
  }
  return found
}

/** New descendants still alive, with their state and command line. */
const survivors = (before: ReadonlySet<number>) =>
  [...descendants()].filter((pid) => !before.has(pid)).map((pid) => {
    try {
      return execFileSync("ps", ["-o", "stat=,args=", "-p", String(pid)], { encoding: "utf8" }).trim()
    } catch {
      return undefined
    }
  }).filter((row) => row !== undefined && row !== "")

/**
 * The real supervisor, whose first `misses` starts get a 1 ms bound: a start
 * a machine too busy to start the tool in time really misses.
 */
const busyFirst = (misses: number) => {
  const starts: Array<ScopedProcess.Options> = []
  const service = {
    spawn: (options: ScopedProcess.Options) => {
      starts.push(options)
      return ScopedProcess.spawn(starts.length <= misses ? { ...options, startupTimeoutMs: 1 } : options)
    },
    status: ScopedProcess.status
  }
  return { starts, service }
}

const run = (
  service: Pick<typeof ScopedProcess, "spawn" | "status">,
  retry?: Exec.StartupRetryPolicy,
  observed: Array<string> = []
) =>
  Effect.runPromise(
    Effect.result(Exec.run({
      workspaceRoot: root,
      onStderr: (chunk) => observed.push(Buffer.from(chunk).toString("utf8"))
    }, payload)).pipe(
      Effect.provideService(Process, service),
      retry === undefined ? (effect) => effect : Effect.provideService(Exec.StartupRetry, retry)
    )
  )

describe.skipIf(process.platform === "win32")("a start the machine was too busy to make", () => {
  it("runs the tool once after its first start missed the bound, and leaves no process behind", async () => {
    const before = descendants()
    const { service, starts } = busyFirst(1)
    const observed: Array<string> = []
    const result = await run(service, undefined, observed)
    expect(result._tag, JSON.stringify(result)).toBe("Success")
    expect(await runs()).toBe("ran\n")
    expect(starts).toHaveLength(2)
    expect(observed.join("")).toContain(
      "smthrs: the machine was too busy to start the tool within 15 s and it never ran; " +
        "starting it again in 1 s (attempt 2 of 3)"
    )
    expect(survivors(before)).toEqual([])
  })

  it("fails start_timed_out within its budget when no start succeeds, and the tool never ran", async () => {
    const before = descendants()
    const { service, starts } = busyFirst(Infinity)
    const began = Date.now()
    const result = await run(service, { attemptsMs: [1, 1, 1], backoffMs: 10 })
    expect(Date.now() - began).toBeLessThan(10_000)
    expect(result._tag).toBe("Failure")
    if (result._tag === "Failure") {
      expect(result.failure.code).toBe("start_timed_out")
      expect(result.failure.exitCode).toBe(-1)
      const [summary, ...reason] = result.failure.stderr.split("\n")
      expect(summary).toMatch(/^the machine was too busy to start the tool: 3 attempts in \d+ s$/)
      // The supervisor's own sentence stays the last line, as before.
      expect(reason).toEqual([
        "TimedOut: ChildProcess.spawn (/bin/sh): The machine was too busy to start the process within 0.001 s"
      ])
    }
    expect(starts).toHaveLength(3)
    expect(await runs()).toBe("")
    expect(survivors(before)).toEqual([])
  })

  it("retries even when the live output view throws", async () => {
    const { service, starts } = busyFirst(1)
    const result = await Effect.runPromise(
      Effect.result(Exec.run({
        workspaceRoot: root,
        onStderr: () => {
          throw new Error("progress view closed")
        }
      }, payload)).pipe(
        Effect.provideService(Process, service),
        Effect.provideService(Exec.StartupRetry, { attemptsMs: [1, 60_000], backoffMs: 10 })
      )
    )
    expect(result._tag, JSON.stringify(result)).toBe("Success")
    expect(starts).toHaveLength(2)
    expect(await runs()).toBe("ran\n")
  })

  it("bounds each start by the tool's deadline and hands that deadline to the activated start", async () => {
    const { service, starts } = busyFirst(0)
    const result = await Effect.runPromise(
      Effect.result(Exec.run({ workspaceRoot: root }, { ...payload, timeoutMs: 8_000 })).pipe(
        Effect.provideService(Process, service)
      )
    )
    expect(result._tag).toBe("Success")
    expect(starts.map((start) => [start.startupTimeoutMs, start.activationTimeoutMs])).toEqual([[8_000, 8_000]])
    const unbounded = busyFirst(0)
    await Effect.runPromise(
      Exec.run({ workspaceRoot: root }, { ...payload, timeoutMs: "unbounded" }).pipe(
        Effect.provideService(Process, unbounded.service)
      )
    )
    expect(unbounded.starts.map((start) => [start.startupTimeoutMs, start.activationTimeoutMs])).toEqual([
      [15_000, undefined]
    ])
  })

  it.each(
    [
      ["a miss after the supervisor was asked to start the tool", "TimedOut", "activation_timeout"],
      ["a refused spawn", "PermissionDenied", undefined]
    ] as const
  )("does not retry %s", async (_, tag, code) => {
    let calls = 0
    const service = {
      spawn: () => {
        calls++
        return Effect.fail(PlatformError.systemError({
          _tag: tag,
          module: "ChildProcess",
          method: "spawn",
          pathOrDescriptor: "/bin/sh",
          description: "refused",
          cause: { code }
        }))
      },
      status: ScopedProcess.status
    }
    const result = await run(service)
    expect(calls).toBe(1)
    expect(result._tag === "Failure" && result.failure.code).toBe("spawn_failed")
  })
})

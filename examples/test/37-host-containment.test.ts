import { afterAll, afterEach, describe, expect, it } from "@effect/vitest"
import { Journal } from "@smthrs/flows"
import * as NodeRuntime from "@smthrs/flows/NodeRuntime"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as ChildProcess from "node:child_process"
import { spawnSync } from "node:child_process"
import { EventEmitter } from "node:events"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PassThrough } from "node:stream"
import { vi } from "vitest"
import { main } from "../src/37-host-containment.ts"

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>()
  return { ...actual, spawn: vi.fn(actual.spawn) }
})

vi.mock("@smthrs/flows/NodeRuntime", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeRuntime>()
  return { ...actual, layerHost: vi.fn(actual.layerHost) }
})

const directory = mkdtempSync(join(tmpdir(), "flows-examples-containment-"))

describe("host startup cleanup", () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.mocked(ChildProcess.spawn).mockReset()
    vi.mocked(NodeRuntime.layerHost).mockReset()
    vi.useRealTimers()
  })

  const setup = (reaperWait: Effect.Effect<void> = Effect.void, closeOnKill = true) => {
    const events: Array<string> = []
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(() => {
        events.push("kill")
        if (closeOnKill) queueMicrotask(() => {
          events.push("close")
          child.emit("close", null, "SIGKILL")
        })
        return true
      })
    })
    vi.mocked(ChildProcess.spawn).mockReturnValue(child as unknown as ChildProcess.ChildProcessWithoutNullStreams)
    const journal = {
      entries: () => Effect.succeed({ entries: [] })
    } as unknown as Journal.Journal.Service
    vi.mocked(NodeRuntime.layerHost).mockImplementation(() =>
      Layer.effect(Journal.Journal.Journal, Effect.gen(function*() {
        events.push("reap")
        yield* reaperWait
        return journal
      })) as ReturnType<typeof NodeRuntime.layerHost>
    )
    const fiber = Effect.runFork(main(join(directory, "fake.sqlite")))
    return { child, events, fiber }
  }

  it("kills and reaps even when interrupted before the PID announcement", async () => {
    const { child, events, fiber } = setup()
    await new Promise<void>((resolve) => setImmediate(resolve))
    await Effect.runPromise(Fiber.interrupt(fiber))
    expect(child.kill).toHaveBeenCalledWith("SIGKILL")
    expect(events).toEqual(["kill", "close", "reap"])
    expect(child.stdout.listenerCount("data")).toBe(0)
    expect(child.stderr.listenerCount("data")).toBe(0)
    expect(child.listenerCount("error")).toBe(0)
    expect(child.listenerCount("close")).toBe(0)
    child.stdout.write("12345\n")
    expect(child.kill).toHaveBeenCalledTimes(1)
  })

  it("terminates and reaps a silent host at the startup deadline", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    const { child, events, fiber } = setup()
    await new Promise<void>((resolve) => setImmediate(resolve))
    await vi.advanceTimersByTimeAsync(30_001)
    // Poll first so a missing deadline fails without hanging the test itself.
    const exit = fiber.pollUnsafe()
    await Effect.runPromise(Fiber.interrupt(fiber))
    expect(exit).toBeDefined()
    expect(exit?._tag).toBe("Failure")
    if (exit?._tag === "Failure") expect(Cause.pretty(exit.cause)).toContain("TimeoutError")
    expect(child.kill).toHaveBeenCalledWith("SIGKILL")
    expect(events).toEqual(["kill", "close", "reap"])
  })

  it("waits for host termination before starting the reaper on interruption", async () => {
    const { child, events, fiber } = setup(Effect.void, false)
    await new Promise<void>((resolve) => setImmediate(resolve))
    const interrupted = Effect.runPromise(Fiber.interrupt(fiber))
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(events).toEqual(["kill"])
    expect(fiber.pollUnsafe()).toBeUndefined()
    child.emit("close", null, "SIGKILL")
    await interrupted
    expect(events).toEqual(["kill", "reap"])
  })

  it("reaps on a startup error", async () => {
    const { child, events, fiber } = setup()
    await new Promise<void>((resolve) => setImmediate(resolve))
    child.emit("error", new Error("startup failed"))
    const exit = await Effect.runPromise(Fiber.await(fiber))
    expect(exit._tag).toBe("Failure")
    if (exit._tag === "Failure") expect(Cause.pretty(exit.cause)).toContain("startup failed")
    expect(events).toEqual(["kill", "close", "reap"])
  })

  it("reaps when the host closes before announcing its group", async () => {
    const { child, events, fiber } = setup()
    await new Promise<void>((resolve) => setImmediate(resolve))
    child.stderr.write("startup diagnostics")
    child.emit("close", 1, null)
    const exit = await Effect.runPromise(Fiber.await(fiber))
    expect(exit._tag).toBe("Failure")
    if (exit._tag === "Failure") expect(Cause.pretty(exit.cause)).toContain("startup diagnostics")
    expect(child.kill).not.toHaveBeenCalled()
    expect(events).toEqual(["reap"])
  })

  it("finishes the reaper even if interrupted after the PID announcement", async () => {
    let finishReaper!: () => void
    const wait = new Promise<void>((resolve) => { finishReaper = resolve })
    const { child, events, fiber } = setup(Effect.promise(() => wait))
    vi.spyOn(process, "kill").mockReturnValue(true)
    await new Promise<void>((resolve) => setImmediate(resolve))
    child.stdout.write("12345\n")
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(events).toEqual(["kill", "close", "reap"])
    const interrupted = Effect.runPromise(Fiber.interrupt(fiber))
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(fiber.pollUnsafe()).toBeUndefined()
    finishReaper()
    await interrupted
    expect(child.kill).toHaveBeenCalledTimes(1)
  })

  it("reaps once on success and returns the containment observations", async () => {
    const { child, events, fiber } = setup()
    vi.spyOn(process, "kill").mockReturnValueOnce(true).mockImplementation(() => { throw new Error("ESRCH") })
    await new Promise<void>((resolve) => setImmediate(resolve))
    child.stdout.write("123")
    child.stdout.write("45\n")
    const summary = await Effect.runPromise(Fiber.join(fiber))
    expect(summary).toEqual({ pgid: 12345, hostStderr: "", orphaned: true, survivedTheReaper: false, hostEvents: [] })
    expect(events).toEqual(["kill", "close", "reap"])
  })
})

afterAll(() => rmSync(directory, { recursive: true, force: true }))

it("reaps the process group a killed host left running", async () => {
  const summary = await Effect.runPromise(main(join(directory, "containment", "host.sqlite")))

  // The killed host really did leave a live process group behind: without that
  // the reaping below would be a statement about nothing.
  // Node 22 reports its SQLite runtime status on stderr even when this host
  // starts successfully. Permit only that exact warning; every other byte
  // remains a failed diagnostic assertion.
  expect(summary.hostStderr.replace(
    /^\(node:\d+\) ExperimentalWarning: SQLite is an experimental feature and might change at any time\r?\n\(Use \x60node --trace-warnings \.\.\.\x60 to show where the warning was created\)\r?\n$/,
    ""
  )).toBe("")
  expect(summary.orphaned).toBe(true)
  expect(summary.survivedTheReaper).toBe(false)
  // Each host's startup jj version probe uses the contained spawner and records
  // its normal exit. Between those probes, the dead host's process group is
  // spawned and then reaped by its replacement on their shared journal run.
  expect(summary.hostEvents).toEqual([
    "flows.host.process-spawned.v1",
    "flows.host.process-exited.v1",
    "flows.host.process-spawned.v1",
    "flows.host.process-reaped.v1",
    "flows.host.process-spawned.v1",
    "flows.host.process-exited.v1"
  ])
}, 120_000)

it("reports a host startup failure on stderr and exits unsuccessfully", () => {
  const binary = join(directory, "unsupported-jj")
  writeFileSync(binary, "#!/bin/sh\necho \"jj 0.38.0\"\n", { mode: 0o755 })
  const child = spawnSync(process.execPath, [
    new URL("../src/37-host-containment-host.ts", import.meta.url).pathname,
    join(directory, "failure.sqlite"),
    "failed-host"
  ], {
    env: { ...process.env, SMITHERS_JJ_PATH: binary },
    encoding: "utf8",
    timeout: 30_000
  })
  expect(child.error).toBeUndefined()
  expect(child.signal).toBeNull()
  expect(child.status).toBe(1)
  expect(child.stdout).toBe("")
  expect(child.stderr).toContain("jj requires version 0.39.0 or newer; found jj 0.38.0")
})

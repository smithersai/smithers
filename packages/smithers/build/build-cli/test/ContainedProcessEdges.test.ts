import * as ScopedProcess from "@smthrs/platform-node/ScopedProcess"
import { Effect, PlatformError, Sink } from "effect"
import { describe, expect, it } from "vitest"
import * as ContainedProcess from "../src/internal/ContainedProcess.ts"

const base = {
  command: process.execPath,
  cwd: process.cwd(),
  timeoutMs: 10_000,
  stderr: () => {}
}

describe("contained process edges", () => {
  it("flushes a truncated UTF-8 sequence as a replacement character when decoding is lenient", async () => {
    let stdout = ""
    const code = await ContainedProcess.run({
      ...base,
      args: ["-e", "process.stdout.write(Buffer.from([0x6f, 0x6b, 0xe2, 0x82]))"],
      stdout: (text) => stdout += text
    })
    expect(code).toBe(0)
    expect(stdout).toBe("ok�")
  })

  it("reports exit status 1 for a command a signal stopped", async () => {
    const code = await ContainedProcess.run({
      ...base,
      args: ["-e", "process.kill(process.pid, 'SIGKILL')"],
      stdout: () => {}
    })
    expect(code).toBe(1)
  })

  it("reports a run its caller aborted as cancelled, carrying the abort reason", async () => {
    const controller = new AbortController()
    const reason = new Error("caller stopped the watch cycle")
    const pending = ContainedProcess.run({
      ...base,
      args: ["-e", "process.stdout.write('started'); setInterval(() => {}, 1000)"],
      signal: controller.signal,
      stdout: () => controller.abort(reason)
    })
    await expect(pending).rejects.toMatchObject({
      _tag: "smithers-build/ProcessError",
      code: "cancelled",
      cause: reason
    })
  })

  it("fails the run when stdin delivery fails for a reason other than a closed pipe", async () => {
    const failure = PlatformError.systemError({ _tag: "Unknown", module: "Stream", method: "write" })
    const spawner = {
      spawn: (options: ScopedProcess.Options) =>
        ScopedProcess.spawn(options).pipe(Effect.map((handle) => ({ ...handle, stdin: Sink.fail(failure) })))
    }
    const error = await Effect.runPromise(Effect.flip(
      ContainedProcess.runEffect({
        ...base,
        args: ["-e", "setInterval(() => {}, 1000)"],
        stdin: "input",
        stdout: () => {}
      }).pipe(Effect.provideService(ContainedProcess.ProcessSpawner, spawner))
    ))
    expect(error).toMatchObject({ _tag: "smithers-build/ProcessError", code: "process_failed", cause: failure })
  })
  it("reports a failed cleanup rather than cancellation when the caller aborted the run", async () => {
    const controller = new AbortController()
    const failure = PlatformError.systemError({ _tag: "Unknown", module: "ChildProcess", method: "kill" })
    let kills = 0
    const spawner = {
      spawn: (options: ScopedProcess.Options) =>
        ScopedProcess.spawn(options).pipe(Effect.map((handle) => ({
          ...handle,
          kill: (options: Parameters<typeof handle.kill>[0]) =>
            handle.kill(options).pipe(
              Effect.andThen(Effect.sync(() => {
                kills += 1
              })),
              Effect.andThen(Effect.fail(failure))
            )
        })))
    }
    const pending = ContainedProcess.run({
      ...base,
      args: ["-e", "process.stdout.write('started'); setInterval(() => {}, 1000)"],
      signal: controller.signal,
      stdout: () => controller.abort(new Error("caller stopped"))
    }, spawner)
    await expect(pending).rejects.toMatchObject({
      _tag: "smithers-build/ProcessError",
      code: "cleanup_failed",
      cause: failure
    })
    expect(controller.signal.aborted).toBe(true)
    expect(kills).toBe(1)
  })
})

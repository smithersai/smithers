import * as ScopedProcess from "@smthrs/platform-node/ScopedProcess"
import * as Effect from "effect/Effect"
import * as PlatformError from "effect/PlatformError"
import * as Sink from "effect/Sink"
import * as Stream from "effect/Stream"
import * as Fs from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, expect, it } from "vitest"
import * as Exec from "../src/Exec.ts"
import { Process } from "../src/internal/Process.ts"
import * as Review from "../src/LlmLint.ts"

let root: string
beforeEach(async () => {
  root = await Fs.realpath(await Fs.mkdtemp(join(tmpdir(), "honest-pipe-failures-")))
})
afterEach(async () => {
  await Fs.rm(root, { recursive: true, force: true })
})
const broken = (name: string) =>
  PlatformError.systemError({
    _tag: "Unknown",
    module: "ChildProcess",
    method: name,
    description: name + " failed",
    cause: new Error(name + " failed")
  })
const payload: Exec.Payload = {
  cwd: ".",
  argv: [process.execPath, "-e", "process.stdout.write('real bytes');process.stderr.write('diagnostic')"],
  env: {},
  secrets: [],
  expectedExitCodes: [0],
  timeoutMs: 10000
}

it.each(["stdout", "stderr", "status"] as const)(
  "reports a %s failure from an injected process service",
  async (name) => {
    const service = {
      spawn: (options: ScopedProcess.Options) =>
        Effect.map(ScopedProcess.spawn(options), (handle) => ({
          ...handle,
          ...(name === "status"
            ? {}
            : { [name]: Stream.concat(Stream.make(Buffer.from("partial")), Stream.fail(broken(name))) })
        })),
      status: name === "status" ? () => Effect.fail(broken(name)) : ScopedProcess.status
    }
    const error = await Effect.runPromise(
      Effect.flip(Exec.run({ workspaceRoot: root }, payload)).pipe(Effect.provideService(Process, service))
    )
    expect(error.code).toBe("stream_failed")
    expect(error.exitCode).toBe(-1)
    expect(error.argv).toEqual(payload.argv)
  }
)

it("reports an invalid byte chunk without converting it into successful output", async () => {
  const service = {
    spawn: (options: ScopedProcess.Options) =>
      Effect.map(ScopedProcess.spawn(options), (handle) => ({
        ...handle,
        stdout: Stream.make("not a byte chunk" as never)
      })),
    status: ScopedProcess.status
  }
  const error = await Effect.runPromise(
    Effect.flip(Exec.run({ workspaceRoot: root }, payload)).pipe(Effect.provideService(Process, service))
  )
  expect(error.code).toBe("stream_failed")
  expect(error.stderr).toContain("stdout could not be read")
})

it.each(["stdout", "stderr", "stdin", "status"] as const)("reports review transport %s failures", async (name) => {
  const service = {
    spawn: (options: ScopedProcess.Options) =>
      Effect.map(
        ScopedProcess.spawn({
          ...options,
          command: process.execPath,
          args: ["-e", "process.stdin.resume()"]
        }),
        (handle) => ({
          ...handle,
          ...(name === "stdout" || name === "stderr"
            ? { [name]: Stream.concat(Stream.make(Buffer.alloc(0)), Stream.fail(broken(name))) }
            : {}),
          ...(name === "stdin" ? { stdin: Sink.fail(broken(name)) } : {})
        })
      ),
    status: name === "status" ? () => Effect.fail(broken(name)) : ScopedProcess.status
  }
  const error = await Effect.runPromise(
    Effect.flip(Review.promptEngine({
      workspaceRoot: root,
      executable: process.execPath,
      timeoutMs: 1000
    }, { engine: "claude", model: "test", prompt: "inspect" })).pipe(Effect.provideService(Process, service))
  )
  expect(error._tag).toBe("smithers-build/LlmReviewError")
})

it("does not turn an unsettled platform status into exit zero", async () => {
  const service = { spawn: ScopedProcess.spawn, status: () => Effect.succeed({ code: null, signal: null }) }
  const error = await Effect.runPromise(
    Effect.flip(Exec.run({ workspaceRoot: root }, payload)).pipe(Effect.provideService(Process, service))
  )
  expect(error).toMatchObject({ code: "exit_status", exitCode: -1 })
})

it.each([null, undefined, 42, "payload"])("rejects a non-record payload before invoking a process", async (value) => {
  const error = await Effect.runPromise(Effect.flip(Exec.run({ workspaceRoot: root }, value as never)))
  expect(error.code).toBe("invalid_payload")
})

it("rejects duplicate expected exits at the execution boundary", async () => {
  const error = await Effect.runPromise(
    Effect.flip(Exec.run({ workspaceRoot: root }, { ...payload, expectedExitCodes: [0, 0] }))
  )
  expect(error.code).toBe("invalid_payload")
  expect(error.exitCode).toBe(-1)
})

it("surfaces a failing git status service as a diff failure", async () => {
  const service = { spawn: ScopedProcess.spawn, status: () => Effect.fail(broken("git status")) }
  const error = await Effect.runPromise(
    Effect.flip(Review.review({ workspaceRoot: root }, {
      base: "HEAD",
      include: [],
      context: [],
      prompt: "Review",
      rubric: "Find defects",
      engine: "claude",
      model: "claude-opus-5-5",
      batchSize: 1,
      failOn: "error",
      scope: "all"
    })).pipe(Effect.provideService(Process, service))
  )
  expect(error).toMatchObject({ phase: "diff" })
  expect(error.message).toContain("git status failed")
})
it("formats a platform failure whose cause is not an Error", async () => {
  const service = {
    spawn: () =>
      Effect.fail(PlatformError.systemError({
        _tag: "Unknown",
        module: "ChildProcess",
        method: "spawn",
        description: "transport unavailable",
        cause: undefined
      })),
    status: ScopedProcess.status
  }
  const error = await Effect.runPromise(
    Effect.flip(Review.promptEngine(
      { workspaceRoot: root, executable: process.execPath },
      { engine: "claude", model: "test", prompt: "inspect" }
    )).pipe(Effect.provideService(Process, service))
  )
  expect(error.message).toContain("transport unavailable")
})

it("fails closed when the actual host cannot enforce an explicit sandbox request", async () => {
  const error = await Effect.runPromise(Effect.flip(Exec.run({
    workspaceRoot: root,
    sandbox: { policy: { network: "loopback" }, reads: [], writes: [] }
  }, payload)))
  expect(error.code).toBe("sandbox_unenforceable")
  expect(error.stderr).not.toBe("")
})
it("searches the complete PATH without treating empty entries or duplicate directories as executables", async () => {
  const executable = join(root, "tool")
  await Fs.writeFile(executable, "#!/bin/sh\nexit 0\n", { mode: 0o755 })
  expect(Exec.findAllOnPath("tool", { PATH: ":" + root + ":" + root + ":" }, { platform: "linux" })).toEqual([
    executable
  ])
  expect(Exec.findAllOnPath("tool", {}, { platform: "linux" })).toEqual([])
  await Fs.writeFile(join(root, "tool.EXE"), "not executable", { mode: 0o644 })
  expect(Exec.findAllOnPath("tool", { PATH: root, PATHEXT: ".EXE" }, { platform: "win32" })).toEqual([])
  await Fs.chmod(join(root, "tool.EXE"), 0o755)
  expect(Exec.findAllOnPath("tool", { PATH: root + ";" + root, PATHEXT: ".EXE" }, { platform: "win32" })).toEqual([
    join(root, "tool.EXE")
  ])
})

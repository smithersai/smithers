import { Cause, Effect, Exit, Stream } from "effect"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import * as Native from "node:child_process"
import NativeMutable from "node:child_process"
import { randomUUID } from "node:crypto"
import { EventEmitter } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { syncBuiltinESMExports } from "node:module"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PassThrough } from "node:stream"
import { describe, expect, it, vi } from "vitest"
import * as PipedProcess from "../src/internal/PipedProcess.ts"

const text = (stream: Stream.Stream<Uint8Array, unknown>) => stream.pipe(Stream.decodeText(), Stream.mkString)
const identity = (pid: number) => {
  try {
    return Native.execFileSync("/bin/ps", ["-ww", "-o", "stat=,command=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: 1000,
      killSignal: "SIGKILL",
      env: { PATH: "/usr/bin:/bin", LC_ALL: "C" }
    }).trim()
  } catch {
    return "gone"
  }
}

// Native failure schedules use real streams and public ChildProcess events,
// with no OS process or numerical PID signalling.
const withNativeFailure = async (
  test: (child: ReturnType<typeof fakeChild>) => Promise<void>,
  startError?: Error
) => {
  const child = fakeChild()
  // A native startup failure never creates a process identity.
  if (startError !== undefined) child.pid = undefined
  const spawn = vi.spyOn(NativeMutable, "spawn").mockImplementation(() => {
    queueMicrotask(() => child.emit(startError === undefined ? "spawn" : "error", startError))
    return child as unknown as ReturnType<typeof Native.spawn>
  })
  syncBuiltinESMExports()
  try {
    await test(child)
  } finally {
    child.stdin.destroy()
    child.stdout.destroy()
    child.stderr.destroy()
    spawn.mockRestore()
    syncBuiltinESMExports()
  }
}

const fakeChild = () =>
  Object.assign(new EventEmitter(), {
    pid: 12345 as number | undefined,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    get stdio(): Array<PassThrough> {
      return [this.stdin, this.stdout, this.stderr]
    },
    kill: vi.fn((_signal?: string) => true),
    ref: vi.fn(),
    unref: vi.fn()
  })

describe("native pipe adapter", () => {
  it.each(["running", "exited", "signalled"] as const)(
    "observes a returned native handle after its spawn event was emitted early (%s)",
    async (state) => {
      const child = fakeChild()
      const spawn = vi.spyOn(NativeMutable, "spawn").mockImplementation(() => {
        // Bun's cold-start ordering is observable before spawn returns. The
        // public pid and status fields survive even when the events are missed.
        child.emit("spawn")
        if (state === "exited") {
          child.exitCode = 17
          child.emit("exit", 17, null)
        } else if (state === "signalled") {
          child.signalCode = "SIGTERM"
          child.emit("exit", null, "SIGTERM")
        }
        return child as unknown as ReturnType<typeof Native.spawn>
      })
      syncBuiltinESMExports()
      try {
        await Effect.runPromise(
          Effect.scoped(Effect.gen(function*() {
            const handle = yield* PipedProcess.spawn(ChildProcess.make("fixture"), undefined)
            expect(handle.pid).toBe(12345)
            expect(yield* handle.isRunning).toBe(state === "running")
            if (state === "running") child.emit("exit", 0, null)
            if (state === "signalled") {
              expect((yield* Effect.flip(handle.exitCode)).cause).toMatchObject({ signal: "SIGTERM" })
            } else expect(yield* handle.exitCode).toBe(state === "exited" ? 17 : 0)
          })).pipe(Effect.timeout("3 seconds"))
        )
        expect(child.kill).not.toHaveBeenCalled()
      } finally {
        child.stdin.destroy()
        child.stdout.destroy()
        child.stderr.destroy()
        spawn.mockRestore()
        syncBuiltinESMExports()
      }
    }
  )

  it.each([false, true])("matches native argv and streams with windowsVerbatimArguments=%s", async (verbatim) => {
    const directory = await mkdtemp(join(tmpdir(), "scoped-pipes-"))
    const spawn = vi.spyOn(NativeMutable, "spawn")
    syncBuiltinESMExports()
    try {
      const args = [
        "-e",
        "process.stdin.on('data',b=>process.stdout.write(b));process.stdin.on('end',()=>{process.stderr.write(JSON.stringify({args:process.argv.slice(1),cwd:process.cwd(),env:process.env}));process.exitCode=23})",
        "a b",
        "literal;$value",
        "☃"
      ]
      const result = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
        const handle = yield* PipedProcess.spawn(
          ChildProcess.make(process.execPath, args, {
            cwd: directory,
            env: { ONLY: "value" },
            extendEnv: false,
            stdin: "pipe"
          }),
          verbatim
        )
        const [code, stdout, stderr] = yield* Effect.all([
          handle.exitCode,
          text(handle.stdout),
          text(handle.stderr),
          Stream.make(new TextEncoder().encode("input é🙂\n")).pipe(Stream.run(handle.stdin))
        ], { concurrency: "unbounded" })
        expect(yield* handle.isRunning).toBe(false)
        yield* handle.kill()
        expect(yield* text(handle.getOutputFd(7))).toBe("")
        yield* Stream.make(new Uint8Array([1])).pipe(Stream.run(handle.getInputFd(7)))
        return { code, stdout, stderr }
      })))
      expect(result.code).toBe(23)
      expect(result.stdout).toBe("input é🙂\n")
      const native = Native.spawnSync(process.execPath, args, {
        cwd: directory,
        env: { ONLY: "value" },
        windowsVerbatimArguments: verbatim,
        input: "input é🙂\n",
        encoding: "utf8"
      })
      expect(result).toEqual({ code: native.status, stdout: native.stdout, stderr: native.stderr })
      if (!verbatim) expect(JSON.parse(result.stderr).args).toEqual(["a b", "literal;$value", "☃"])
      expect(spawn.mock.calls[0]?.[2]).toMatchObject({
        windowsVerbatimArguments: verbatim,
        stdio: ["pipe", "pipe", "pipe"]
      })
    } finally {
      spawn.mockRestore()
      syncBuiltinESMExports()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it("inherits the native environment only when requested and merges stdout/stderr", async () => {
    const output = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const handle = yield* PipedProcess.spawn(
        ChildProcess.make(process.execPath, [
          "-e",
          "process.stdout.write('out:'+process.env.EXTRA);process.stderr.write('err:'+typeof process.env.PATH)"
        ], { env: { EXTRA: "yes" }, extendEnv: true, stdin: "ignore", detached: false, windowsHide: false }),
        false
      )
      yield* Stream.make(new Uint8Array([1])).pipe(Stream.run(handle.stdin))
      const [output, code] = yield* Effect.all([text(handle.all), handle.exitCode], { concurrency: "unbounded" })
      expect(code).toBe(0)
      return output
    })))
    expect(output).toContain("out:yes")
    expect(output).toContain("err:string")
  })

  it("preserves the native spawn errno", async () => {
    const error = await Effect.runPromise(Effect.scoped(Effect.flip(PipedProcess.spawn(
      ChildProcess.make(join(tmpdir(), `missing-command-${randomUUID()}`)),
      undefined
    ))))
    expect(error.reason._tag).toBe("NotFound")
    expect(error.cause).toMatchObject({ code: "ENOENT" })
  })

  it.skipIf(process.platform === "win32")("preserves a target signal instead of inventing an exit code", async () => {
    const error = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const handle = yield* PipedProcess.spawn(
        ChildProcess.make(process.execPath, [
          "-e",
          "process.kill(process.pid,'SIGTERM');setInterval(()=>{},1000)"
        ]),
        undefined
      )
      return yield* Effect.flip(handle.exitCode)
    })))
    expect(error.cause).toMatchObject({ signal: "SIGTERM" })
  })

  it.skipIf(process.platform === "win32")("escalates a direct native child that ignores TERM", async () => {
    await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const handle = yield* PipedProcess.spawn(
        ChildProcess.make(process.execPath, [
          "-e",
          "process.on('SIGTERM',()=>{});console.log('ready');setInterval(()=>{},1000)"
        ], { killSignal: "SIGTERM", forceKillAfter: 0 }),
        undefined
      )
      yield* handle.stdout.pipe(Stream.decodeText(), Stream.splitLines, Stream.take(1), Stream.runDrain)
      expect(yield* handle.isRunning).toBe(true)
      yield* handle.kill()
      expect(yield* handle.isRunning).toBe(false)
      expect((yield* Effect.flip(handle.exitCode)).cause).toMatchObject({ signal: "SIGKILL" })
    })))
  })

  it.skipIf(process.platform === "win32")(
    "honors unref as a finalizer refusal and reref restores ownership",
    async () => {
      for (const rereference of [false, true]) {
        const token = randomUUID()
        let pid = 0
        try {
          const result = await Effect.runPromiseExit(Effect.scoped(Effect.gen(function*() {
            const handle = yield* PipedProcess.spawn(
              ChildProcess.make(process.execPath, [
                "-e",
                `const token=${JSON.stringify(token)};console.log(token);setInterval(()=>{},1000)`
              ]),
              undefined
            )
            pid = handle.pid
            yield* handle.stdout.pipe(Stream.decodeText(), Stream.splitLines, Stream.take(1), Stream.runDrain)
            const reref = yield* handle.unref
            if (rereference) yield* reref
          })))
          expect(Exit.isSuccess(result)).toBe(true)
          expect(identity(pid).includes(token)).toBe(!rereference)
        } finally {
          if (identity(pid).includes(token)) process.kill(pid, "SIGKILL")
        }
      }
    }
  )

  it("preserves non-Error causes and native permission errors", () => {
    expect(PipedProcess.failure("spawn", 42).cause).toMatchObject({ message: "42" })
    for (const code of ["EACCES", "EPERM"]) {
      const error = Object.assign(new Error("denied"), { code })
      const failure = PipedProcess.failure("kill", error)
      expect(failure.reason._tag).toBe("PermissionDenied")
      expect(failure.cause).toBe(error)
    }
  })

  it("preserves synchronous native spawn errors", async () => {
    const denied = Object.assign(new Error("executable denied"), { code: "EACCES" })
    const spawn = vi.spyOn(NativeMutable, "spawn").mockImplementation(() => {
      throw denied
    })
    syncBuiltinESMExports()
    try {
      const error = await Effect.runPromise(Effect.scoped(Effect.flip(PipedProcess.spawn(
        ChildProcess.make("fixture"),
        undefined
      ))))
      expect(error.reason._tag).toBe("PermissionDenied")
      expect(error.cause).toBe(denied)
    } finally {
      spawn.mockRestore()
      syncBuiltinESMExports()
    }
  })

  it("releases every pipe after an asynchronous startup failure without signalling a nonexistent child", async () => {
    const denied = Object.assign(new Error("cwd denied"), { code: "EACCES" })
    await withNativeFailure(async (child) => {
      const error = await Effect.runPromise(Effect.scoped(Effect.flip(PipedProcess.spawn(
        ChildProcess.make("fixture"),
        undefined
      ))))
      expect(error.cause).toBe(denied)
      expect(child.kill).not.toHaveBeenCalled()
      expect([child.stdin, child.stdout, child.stderr].every((pipe) => pipe.destroyed)).toBe(true)
    }, denied)
  })

  it.each(["explicit", "finalizer"] as const)(
    "waits for a queued native exit after %s kill returns false",
    async (kind) => {
      await withNativeFailure(async (child) => {
        let exitObserved = false
        child.kill.mockImplementation(() => {
          setTimeout(() => {
            exitObserved = true
            child.emit("exit", 0, null)
          }, 30)
          return false
        })
        await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
          const handle = yield* PipedProcess.spawn(ChildProcess.make("fixture"), undefined)
          if (kind === "explicit") {
            yield* handle.kill({ killSignal: "SIGINT", forceKillAfter: 500 })
            expect(yield* handle.exitCode).toBe(0)
          }
        })))
        expect(exitObserved).toBe(true)
        expect(child.kill).toHaveBeenCalledWith(kind === "explicit" ? "SIGINT" : "SIGKILL")
      })
    }
  )

  it.each(["explicit", "finalizer"] as const)(
    "preserves a live native signal denial during %s cleanup",
    async (kind) => {
      await withNativeFailure(async (child) => {
        const denied = Object.assign(new Error("signal denied"), { code: "EPERM" })
        child.kill.mockImplementation(() => {
          child.emit("error", denied)
          return false
        })
        const result = await Effect.runPromiseExit(Effect.scoped(Effect.gen(function*() {
          const handle = yield* PipedProcess.spawn(ChildProcess.make("fixture"), undefined)
          if (kind === "explicit") {
            const error = yield* Effect.flip(handle.kill())
            expect(error.reason._tag).toBe("PermissionDenied")
            expect(error.cause).toBe(denied)
          }
        })))
        expect(Exit.isFailure(result)).toBe(true)
        if (Exit.isFailure(result)) expect(Cause.squash(result.cause)).toMatchObject({ cause: denied })
        expect([child.stdin, child.stdout, child.stderr].every((pipe) => pipe.destroyed)).toBe(true)
      })
    }
  )

  it("does not certify a kill that reports delivery but never produces an exit", async () => {
    await withNativeFailure(async (child) => {
      const result = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
        const handle = yield* PipedProcess.spawn(ChildProcess.make("fixture", { forceKillAfter: 0 }), undefined)
        const error = yield* Effect.flip(handle.kill())
        expect(yield* handle.isRunning).toBe(true)
        // Refuse the raw finalizer rather than spending another identical
        // timeout; the managed lifecycle owns that refusal in production.
        yield* handle.unref
        return error
      })))
      expect(result.reason.method).toBe("kill")
      expect(result.cause).toMatchObject({ _tag: "TimeoutError" })
      expect(child.kill.mock.calls.map(([signal]) => signal)).toEqual(["SIGTERM", "SIGKILL"])
      expect(child.unref).toHaveBeenCalledOnce()
    })
  })

  it.each(["stdin", "stdout", "stderr"] as const)("preserves a %s pipe failure", async (pipe) => {
    await withNativeFailure(async (child) => {
      const broken = Object.assign(new Error(`${pipe} broken`), { code: "EIO" })
      const error = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
        const handle = yield* PipedProcess.spawn(ChildProcess.make("fixture", { stdin: "pipe" }), undefined)
        child[pipe].destroy(broken)
        child.emit("exit", 0, null)
        return yield* Effect.flip(
          pipe === "stdin"
            ? Stream.make(new Uint8Array([1])).pipe(Stream.run(handle.stdin))
            : Stream.runDrain(handle[pipe])
        )
      })))
      expect(error.cause).toBe(broken)
      expect(error.reason.method).toBe(pipe)
    })
  })

  it.each(["stdin", "stdout", "stderr"] as const)("preserves a failure during active %s I/O", async (pipe) => {
    await withNativeFailure(async (child) => {
      const broken = Object.assign(new Error(`${pipe} failed during I/O`), { code: "EIO" })
      const error = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
        const handle = yield* PipedProcess.spawn(ChildProcess.make("fixture", { stdin: "pipe" }), undefined)
        // Native stream hooks run only after the adapter has subscribed. This
        // schedule exercises an I/O failure, not the before-consumption guard.
        if (pipe === "stdin") {
          vi.spyOn(child.stdin, "_write").mockImplementation((_chunk, _encoding, callback) => {
            callback(broken)
          })
        } else {
          vi.spyOn(child[pipe], "_read").mockImplementation(() => {
            child[pipe].destroy(broken)
          })
        }
        const error = yield* Effect.flip(
          pipe === "stdin"
            ? Stream.make(new Uint8Array([1])).pipe(Stream.run(handle.stdin))
            : Stream.runDrain(handle[pipe])
        )
        child.emit("exit", 0, null)
        return error
      })))
      expect(error.cause).toBe(broken)
      expect(error.reason.method).toBe(pipe)
      expect(child[pipe].listenerCount("error")).toBeGreaterThan(0)
    })
  })
})

import { Cause, Effect, Exit, Redacted, Stream } from "effect"
import * as ChildProcess from "effect/process/ChildProcess"
import * as Native from "node:child_process"
import { randomUUID } from "node:crypto"
import { EventEmitter } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PassThrough } from "node:stream"
import { describe, expect, it } from "vitest"
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
const injected = (nativeSpawn: PipedProcess.NativeSpawn) => ({
  promise: <A, E>(effect: Effect.Effect<A, E>) =>
    Effect.runPromise(effect.pipe(Effect.provideService(PipedProcess.NativeSpawn, nativeSpawn))),
  exit: <A, E>(effect: Effect.Effect<A, E>) =>
    Effect.runPromiseExit(effect.pipe(Effect.provideService(PipedProcess.NativeSpawn, nativeSpawn)))
})

// Only failure ordering is synthetic. Happy paths below use real processes.
const withNativeFailure = async (
  test: (child: ReturnType<typeof faultyChild>, run: ReturnType<typeof injected>) => Promise<void>,
  startError?: Error
) => {
  const child = faultyChild()
  if (startError !== undefined) child.pid = undefined
  const nativeSpawn: PipedProcess.NativeSpawn = () => {
    queueMicrotask(() => child.emit(startError === undefined ? "spawn" : "error", startError))
    return child as unknown as ReturnType<PipedProcess.NativeSpawn>
  }
  try {
    await test(child, injected(nativeSpawn))
  } finally {
    child.stdin.destroy()
    child.stdout.destroy()
    child.stderr.destroy()
  }
}

const faultyChild = () => {
  const signals: Array<string | undefined> = []
  const references: Array<"ref" | "unref"> = []
  return Object.assign(new EventEmitter(), {
    pid: 12345 as number | undefined,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    signals,
    references,
    get stdio(): Array<PassThrough> {
      return [this.stdin, this.stdout, this.stderr]
    },
    deliver: (_signal?: string): boolean => true,
    kill(signal?: string) {
      signals.push(signal)
      return this.deliver(signal)
    },
    ref: () => {
      references.push("ref")
    },
    unref: () => {
      references.push("unref")
    }
  })
}

describe("native pipe adapter", () => {
  it("keeps opaque words out of a real missing-executable error", async () => {
    const failure = await Effect.runPromise(Effect.scoped(Effect.flip(PipedProcess.spawn(
      ChildProcess.make("/smithers-missing-executable", ["public", Redacted.make("synthetic-private-argument")]),
      undefined
    ))))
    expect(failure).toMatchObject({ reason: { _tag: "NotFound" } })
    expect(JSON.stringify(failure)).not.toContain("synthetic-private-argument")
    expect(String(failure)).not.toContain("synthetic-private-argument")
    expect(failure.reason.cause).toMatchObject({ spawnargs: ["public", "<redacted>"] })
  })

  it.each(
    [
      [ChildProcess.make("synthetic\0command"), "The command"],
      [ChildProcess.make(process.execPath, ["public", Redacted.make("synthetic\0argument")]), "Argument 2"],
      [
        ChildProcess.make(process.execPath, [], {
          env: { OMIT: undefined, PRIVATE: Redacted.make("synthetic\0environment") }
        }),
        "The environment variable PRIVATE"
      ]
    ] as const
  )("keeps a word holding NUL out of a real spawn refusal", async (command, position) => {
    const failure = await Effect.runPromise(Effect.scoped(Effect.flip(PipedProcess.spawn(command, undefined))))
    expect(failure).toMatchObject({
      reason: { _tag: "BadArgument", method: "spawn", description: `${position} contains a NUL character` }
    })
    expect(JSON.stringify(failure)).not.toContain("synthetic")
    expect(String(failure)).not.toContain("synthetic")
    expect(String(failure.reason.cause)).not.toContain("synthetic")
  })

  it.skipIf(process.platform === "win32")(
    "carries both directions over a declared duplex descriptor",
    async () => {
      const script =
        "const net=require('node:net');const socket=new net.Socket({fd:3,readable:true,writable:true,allowHalfOpen:true});let text='';socket.on('data',b=>{text+=b.toString()});socket.on('end',()=>socket.end('echo:'+text))"
      const result = await Effect.runPromise(
        Effect.scoped(Effect.gen(function*() {
          const handle = yield* PipedProcess.spawn(
            ChildProcess.make(process.execPath, ["-e", script], { additionalFds: { fd3: { type: "duplex" } } }),
            undefined
          )
          return yield* Effect.all([
            text(handle.getOutputFd(3)),
            Stream.make(new TextEncoder().encode("ping")).pipe(
              Stream.run(handle.getInputFd(3)),
              Effect.andThen(handle.exitCode)
            )
          ], { concurrency: "unbounded" })
        })).pipe(Effect.timeout("5 seconds"))
      )
      expect(result).toEqual(["echo:ping", 0])
    }
  )

  it("rereferencing a native handle restores finalizer ownership", async () => {
    await withNativeFailure(async (child, run) => {
      child.deliver = () => {
        queueMicrotask(() => child.emit("exit", 0, null))
        return true
      }
      await run.promise(Effect.scoped(Effect.gen(function*() {
        const handle = yield* PipedProcess.spawn(ChildProcess.make("fixture"), undefined)
        const reref = yield* handle.unref
        expect(child.references.filter((ref) => ref === "unref")).toHaveLength(1)
        yield* reref
        expect(child.references.filter((ref) => ref === "ref")).toHaveLength(1)
      })))
      expect(child.signals).toContain("SIGKILL")
    })
  })

  it.each(["running", "exited", "signalled"] as const)(
    "observes a returned native handle after its spawn event was emitted early (%s)",
    async (state) => {
      const child = faultyChild()
      const nativeSpawn: PipedProcess.NativeSpawn = () => {
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
        return child as unknown as ReturnType<PipedProcess.NativeSpawn>
      }
      try {
        await injected(nativeSpawn).promise(
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
        expect(child.signals).toEqual([])
      } finally {
        child.stdin.destroy()
        child.stdout.destroy()
        child.stderr.destroy()
      }
    }
  )

  it.each([false, true])("matches native argv and streams with windowsVerbatimArguments=%s", async (verbatim) => {
    const options: Array<Native.SpawnOptions> = []
    const nativeSpawn: PipedProcess.NativeSpawn = (command, args, config) => {
      options.push(config)
      return Native.spawn(command, args, config)
    }
    const directory = await mkdtemp(join(tmpdir(), "scoped-pipes-"))
    try {
      const words = [
        "-e",
        "process.stdin.on('data',b=>process.stdout.write(b));process.stdin.on('end',()=>{process.stderr.write(JSON.stringify({args:process.argv.slice(1),cwd:process.cwd(),env:process.env}));process.exitCode=23})",
        "a b",
        "literal;$value",
        "☃"
      ]
      const args = verbatim && process.platform === "win32" ? words.map((word) => JSON.stringify(word)) : words
      const result = await injected(nativeSpawn).promise(Effect.scoped(Effect.gen(function*() {
        const handle = yield* PipedProcess.spawn(
          ChildProcess.make(process.execPath, [args[0]!, args[1]!, Redacted.make(args[2]!), ...args.slice(3)], {
            cwd: directory,
            env: { ONLY: Redacted.make("value") },
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
      expect(JSON.parse(result.stderr).args).toEqual(["a b", "literal;$value", "☃"])
      expect(options[0]).toMatchObject({
        windowsVerbatimArguments: verbatim,
        stdio: ["pipe", "pipe", "pipe"]
      })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it.each([false, true])(
    "inherits the native environment and merges stdout/stderr (overrides: %s)",
    async (overrides) => {
      const output = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
        const handle = yield* PipedProcess.spawn(
          ChildProcess.make(process.execPath, [
            "-e",
            "process.stdout.write('out:'+process.env.EXTRA);process.stderr.write('err:'+typeof process.env.PATH)"
          ], {
            env: overrides ? { EXTRA: "yes" } : undefined,
            extendEnv: true,
            stdin: "ignore",
            detached: false,
            windowsHide: false
          }),
          false
        )
        yield* Stream.make(new Uint8Array([1])).pipe(Stream.run(handle.stdin))
        const [output, code] = yield* Effect.all([text(handle.all), handle.exitCode], { concurrency: "unbounded" })
        expect(code).toBe(0)
        return output
      })))
      expect(output).toContain(overrides ? "out:yes" : "out:undefined")
      expect(output).toContain("err:string")
    }
  )

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

  it("preserves synchronous errors from the injected native service", async () => {
    const denied = Object.assign(new Error("executable denied"), { code: "EACCES" })
    const nativeSpawn: PipedProcess.NativeSpawn = () => {
      throw denied
    }
    const error = await injected(nativeSpawn).promise(Effect.scoped(Effect.flip(PipedProcess.spawn(
      ChildProcess.make("fixture"),
      undefined
    ))))
    expect(error.reason._tag).toBe("PermissionDenied")
    expect(error.cause).toBe(denied)
  })

  it("keeps injected spawn failures separate from concurrent real processes", async () => {
    const native = Native.spawn
    const denied = Object.assign(new Error("only this scope is denied"), { code: "EACCES" })
    const faulty: PipedProcess.NativeSpawn = () => {
      throw denied
    }
    const [failure, code] = await Promise.all([
      injected(faulty).promise(Effect.scoped(Effect.flip(PipedProcess.spawn(ChildProcess.make("fixture"), undefined)))),
      Effect.runPromise(Effect.scoped(Effect.gen(function*() {
        const handle = yield* PipedProcess.spawn(ChildProcess.make(process.execPath, ["-e", ""]), undefined)
        return yield* handle.exitCode
      })))
    ])
    expect(failure.cause).toBe(denied)
    expect(code).toBe(0)
    expect(Native.spawn).toBe(native)
  })

  it("releases every pipe after an asynchronous startup failure without signalling a nonexistent child", async () => {
    const denied = Object.assign(new Error("cwd denied"), { code: "EACCES" })
    await withNativeFailure(async (child, run) => {
      const error = await run.promise(Effect.scoped(Effect.flip(PipedProcess.spawn(
        ChildProcess.make("fixture"),
        undefined
      ))))
      expect(error.cause).toBe(denied)
      expect(child.signals).toEqual([])
      expect([child.stdin, child.stdout, child.stderr].every((pipe) => pipe.destroyed)).toBe(true)
    }, denied)
  })

  it.each(["explicit", "finalizer"] as const)(
    "waits for a queued native exit after %s kill returns false",
    async (kind) => {
      await withNativeFailure(async (child, run) => {
        let exitObserved = false
        child.deliver = () => {
          setTimeout(() => {
            exitObserved = true
            child.emit("exit", 0, null)
          }, 30)
          return false
        }
        await run.promise(Effect.scoped(Effect.gen(function*() {
          const handle = yield* PipedProcess.spawn(ChildProcess.make("fixture"), undefined)
          if (kind === "explicit") {
            yield* handle.kill({ killSignal: "SIGINT", forceKillAfter: 500 })
            expect(yield* handle.exitCode).toBe(0)
          }
        })))
        expect(exitObserved).toBe(true)
        expect(child.signals).toContain(kind === "explicit" ? "SIGINT" : "SIGKILL")
      })
    }
  )

  it.each(["explicit", "finalizer"] as const)(
    "preserves a live native signal denial during %s cleanup",
    async (kind) => {
      await withNativeFailure(async (child, run) => {
        const denied = Object.assign(new Error("signal denied"), { code: "EPERM" })
        child.deliver = () => {
          child.emit("error", denied)
          return false
        }
        const result = await run.exit(Effect.scoped(Effect.gen(function*() {
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
    await withNativeFailure(async (child, run) => {
      const result = await run.promise(Effect.scoped(Effect.gen(function*() {
        const handle = yield* PipedProcess.spawn(ChildProcess.make("fixture", { forceKillAfter: 0 }), undefined)
        const error = yield* Effect.flip(handle.kill())
        expect(yield* handle.isRunning).toBe(true)
        // Refuse the raw finalizer rather than spending another identical
        // timeout; the managed lifecycle owns that refusal in production.
        yield* Effect.asVoid(handle.unref)
        return error
      })))
      expect(result.reason.method).toBe("kill")
      expect(result.cause).toMatchObject({ _tag: "TimeoutError" })
      expect(child.signals).toEqual(["SIGTERM", "SIGKILL"])
      expect(child.references.filter((ref) => ref === "unref")).toHaveLength(1)
    })
  })

  it.each(["stdin", "stdout", "stderr"] as const)("preserves a %s pipe failure", async (pipe) => {
    await withNativeFailure(async (child, run) => {
      const broken = Object.assign(new Error(`${pipe} broken`), { code: "EIO" })
      const error = await run.promise(Effect.scoped(Effect.gen(function*() {
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
    await withNativeFailure(async (child, run) => {
      const broken = Object.assign(new Error(`${pipe} failed during I/O`), { code: "EIO" })
      const error = await run.promise(Effect.scoped(Effect.gen(function*() {
        const handle = yield* PipedProcess.spawn(ChildProcess.make("fixture", { stdin: "pipe" }), undefined)
        // Native stream hooks run only after the adapter has subscribed. This
        // schedule exercises an I/O failure, not the before-consumption guard.
        if (pipe === "stdin") {
          child.stdin._write = (_chunk, _encoding, callback) => {
            callback(broken)
          }
        } else {
          child[pipe]._read = () => {
            child[pipe].destroy(broken)
          }
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

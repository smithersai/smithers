import { Deferred, Effect, Sink, Stream } from "effect"
import type * as PlatformError from "effect/PlatformError"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import * as Native from "node:child_process"
import NativeMutable from "node:child_process"
import { EventEmitter } from "node:events"
import { syncBuiltinESMExports } from "node:module"
import { Duplex, PassThrough } from "node:stream"
import { describe, expect, it, vi } from "vitest"
import * as PipedProcess from "../src/internal/PipedProcess.ts"

const bytes = (value: string) => new TextEncoder().encode(value)
const input = (value: string) => Stream.make(bytes(value))
const output = (value: Stream.Stream<Uint8Array, unknown>) => value.pipe(Stream.decodeText(), Stream.mkString)
const transform = (prefix: string): Sink.Sink<Uint8Array, Uint8Array, never, PlatformError.PlatformError> =>
  Sink.collect<Uint8Array>().pipe(
    Sink.map((chunks) => bytes(prefix + Buffer.concat(chunks).toString("utf8")))
  )
const spawn = (args: ReadonlyArray<string>, options: ChildProcess.CommandOptions) => {
  // A broken input option must fail this fixture, not leave an idle native
  // child behind when an assertion or reader fails before scope cleanup.
  const bounded = args[0] === "-e"
    ? ["-e", `setTimeout(()=>process.exit(97),5000).unref();${args[1]}`, ...args.slice(2)]
    : [...args]
  return PipedProcess.spawn(ChildProcess.make(process.execPath, bounded, options), undefined)
}

// Failure ordering uses native public EventEmitter/stream contracts, with no
// operating-system process and no numeric PID signal. Real I/O cases below do
// not use this fixture.
const withNativePipes = async (
  modes: ReadonlyArray<Native.IOType>,
  test: (
    child: Native.ChildProcess,
    pipes: ReadonlyArray<Duplex | null>,
    calls: Array<Parameters<typeof Native.spawn>>
  ) => Promise<void>
) => {
  const pipes = modes.map((mode, fd) => {
    if (mode !== "pipe" && mode !== "overlapped") return null
    // Native extra pipes have independent directions: ending the parent's
    // unused writable half must not end the child's readable output half.
    return fd < 3 ? new PassThrough() : new Duplex({
      read() {},
      write(_chunk, _encoding, callback) {
        callback()
      }
    })
  })
  const child = Object.assign(new EventEmitter(), {
    pid: 12345,
    stdin: pipes[0],
    stdout: pipes[1],
    stderr: pipes[2],
    stdio: pipes,
    kill: vi.fn(() => {
      queueMicrotask(() => child.emit("exit", 0, null))
      return true
    }),
    ref: vi.fn(),
    unref: vi.fn()
  })
  const mocked = vi.spyOn(NativeMutable, "spawn").mockImplementation(() => {
    queueMicrotask(() => child.emit("spawn"))
    return child as unknown as Native.ChildProcess
  })
  syncBuiltinESMExports()
  try {
    await test(child as unknown as Native.ChildProcess, pipes, mocked.mock.calls)
  } finally {
    for (const pipe of pipes) pipe?.destroy()
    mocked.mockRestore()
    syncBuiltinESMExports()
  }
}

describe("native public process I/O options", () => {
  it("automatically feeds a direct stdin Stream and closes it at the actual EOF", async () => {
    const value = "literal input é🙂\nsecond line"
    const result = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const handle = yield* spawn([
        "-e",
        "let data=[];process.stdin.on('data',b=>data.push(b));process.stdin.on('end',()=>process.stdout.write(Buffer.concat(data)))"
      ], { stdin: input(value) })
      return yield* Effect.all([output(handle.stdout), handle.exitCode], { concurrency: "unbounded" })
    })))
    expect(result).toEqual([value, 0])
  })

  it("keeps configured stdin open for a later write when endOnDone is false", async () => {
    const result = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const firstDone = yield* Deferred.make<void>()
      const handle = yield* spawn([
        "-e",
        "let data='';process.stdin.on('data',b=>{data+=b.toString('utf8');if(data.endsWith('\\n')){process.stdout.write(data);process.exit(0)}});process.stdin.on('end',()=>{process.stderr.write('early EOF');process.exit(1)})"
      ], {
        stdin: {
          stream: input("first é ").pipe(Stream.ensuring(Deferred.succeed(firstDone, undefined))),
          encoding: "utf16le",
          endOnDone: false
        }
      })
      yield* Deferred.await(firstDone)
      // The public process input is bytes. A string encoding must not
      // transcode either supplied Uint8Array or close the shared writable.
      yield* Stream.run(input("then 🙂\n"), handle.stdin)
      return yield* Effect.all([output(handle.stdout), output(handle.stderr), handle.exitCode], {
        concurrency: "unbounded"
      })
    })))
    expect(result).toEqual(["first é then 🙂\n", "", 0])
  })

  it("normalizes configured ignore and an empty output configuration without creating phantom pipes", async () => {
    const result = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const handle = yield* spawn([
        "-e",
        "process.stdin.resume();process.stdin.on('end',()=>{process.stdout.write('EOF');process.stderr.write('ignored')})"
      ], { stdin: { stream: "ignore" }, stdout: {}, stderr: { stream: "ignore" } })
      yield* Stream.run(input("discarded"), handle.stdin)
      return yield* Effect.all([output(handle.stdout), output(handle.stderr), handle.exitCode], {
        concurrency: "unbounded"
      })
    })))
    expect(result).toEqual(["EOF", "", 0])
  })

  it("transduces actual stdout and stderr through direct and configured public Sinks", async () => {
    const result = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const handle = yield* spawn(["-e", "process.stdout.write('out é');process.stderr.write('err 🙂')"], {
        stdout: transform("stdout:"),
        stderr: { stream: transform("stderr:") }
      })
      return yield* Effect.all([output(handle.stdout), output(handle.stderr), handle.exitCode], {
        concurrency: "unbounded"
      })
    })))
    expect(result).toEqual(["stdout:out é", "stderr:err 🙂", 0])
  })

  it("preserves a configured output Sink's typed failure", async () => {
    const denied = PipedProcess.failure("consumer", new Error("output policy refused"))
    const error = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const handle = yield* spawn(["-e", "process.stdout.write('one byte')"], {
        stdout: { stream: Sink.fail(denied) }
      })
      return yield* Effect.flip(Stream.runDrain(handle.stdout))
    })))
    expect(error).toBe(denied)
  })

  it("preserves sparse custom fd directions, automatic input, output transforms and direct handle access", async () => {
    const native = vi.spyOn(NativeMutable, "spawn")
    syncBuiltinESMExports()
    try {
      const result = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
        const handle = yield* spawn([
          "-e",
          "const fs=require('node:fs');const net=require('node:net');const read=fd=>new Promise((resolve,reject)=>{const chunks=[];const s=new net.Socket({fd,readable:true,writable:false});s.on('data',b=>chunks.push(b));s.on('error',reject);s.on('end',()=>resolve(Buffer.concat(chunks).toString('utf8')))});Promise.all([read(3),read(4)]).then(([a,b])=>{fs.writeSync(6,a);fs.writeSync(9,b);process.stdout.write('finished')})"
        ], {
          additionalFds: {
            fd9: { type: "output", sink: transform("auto:") },
            fd4: { type: "input", stream: input("configured 🙂") },
            fd6: { type: "output" },
            fd3: { type: "input" }
          }
        })
        expect(yield* output(handle.getOutputFd(3))).toBe("")
        expect(yield* output(handle.getOutputFd(5))).toBe("")
        yield* Stream.run(input("discarded"), handle.getInputFd(6))
        yield* Stream.run(input("discarded"), handle.getInputFd(5))
        return yield* Effect.all([
          output(handle.getOutputFd(6)),
          output(handle.getOutputFd(9)),
          output(handle.stdout),
          handle.exitCode,
          Stream.run(input("manual é"), handle.getInputFd(3))
        ], { concurrency: "unbounded" })
      })))
      expect(result).toEqual(["manual é", "auto:configured 🙂", "finished", 0, undefined])
      expect(native.mock.calls[0]?.[2]?.stdio).toEqual([
        "pipe",
        "pipe",
        "pipe",
        "pipe",
        "pipe",
        "ignore",
        "pipe",
        "ignore",
        "ignore",
        "pipe"
      ])
    } finally {
      native.mockRestore()
      syncBuiltinESMExports()
    }
  })

  it("uses native overlapped pipes without changing their byte contract", async () => {
    const result = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const handle = yield* spawn([
        "-e",
        "process.stdin.pipe(process.stdout);process.stdin.on('end',()=>process.stderr.write('done'))"
      ], { stdin: { stream: "overlapped" }, stdout: { stream: "overlapped" }, stderr: "overlapped" })
      return yield* Effect.all([
        output(handle.stdout),
        output(handle.stderr),
        handle.exitCode,
        Stream.run(input("overlapped bytes"), handle.stdin)
      ], { concurrency: "unbounded" })
    })))
    expect(result).toEqual(["overlapped bytes", "done", 0, undefined])
  })

  it.each(["inherit", "ignore"] as const)("forwards native %s and exposes empty local streams", async (mode) => {
    await withNativePipes([mode, mode, mode], async (child, pipes, calls) => {
      await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
        const handle = yield* spawn([], { stdin: mode, stdout: mode, stderr: { stream: mode } })
        yield* Stream.run(input("not a local pipe"), handle.stdin)
        expect(yield* output(handle.all)).toBe("")
        child.emit("exit", 0, null)
        expect(yield* handle.exitCode).toBe(0)
      })))
      expect(calls[0]?.[2]?.stdio).toEqual([mode, mode, mode])
      expect(pipes).toEqual([null, null, null])
    })
  })

  it.each([
    ["out-of-range", "fd65536"],
    ["unsafe integer", "fd9007199254740992"],
    ["overflowing integer", `fd${"9".repeat(400)}`]
  ])(
    "refuses an %s descriptor before native spawn or sparse allocation",
    async (_label, name) => {
      const native = vi.spyOn(NativeMutable, "spawn")
      syncBuiltinESMExports()
      try {
        const error = await Effect.runPromise(Effect.scoped(Effect.flip(spawn([], {
          additionalFds: { [name]: { type: "output" as const } }
        }))))
        expect(error.reason.method).toBe("spawn")
        expect(error.cause).toBeInstanceOf(RangeError)
        expect(error.cause).toMatchObject({ message: "Additional file descriptors must be below 65536" })
        expect(native).not.toHaveBeenCalled()
      } finally {
        native.mockRestore()
        syncBuiltinESMExports()
      }
    }
  )

  it("uses the public fd-name parser and does not expose malformed or reserved descriptor names", async () => {
    await withNativePipes(["pipe", "pipe", "pipe", "ignore", "pipe"], async (child, _pipes, calls) => {
      await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
        const handle = yield* spawn([], {
          additionalFds: {
            fd2: { type: "output" },
            "fd-3": { type: "input" },
            fd3x: { type: "input" },
            fd04: { type: "output" }
          } as ChildProcess.CommandOptions["additionalFds"]
        })
        expect(yield* output(handle.getOutputFd(2))).toBe("")
        yield* Stream.run(input("discarded"), handle.getInputFd(3))
        const pipe = child.stdio[4] as Duplex
        pipe.push(bytes("valid fd04"))
        pipe.push(null)
        child.emit("exit", 0, null)
        expect(yield* output(handle.getOutputFd(4))).toBe("valid fd04")
      })))
      expect(calls[0]?.[2]?.stdio).toEqual(["pipe", "pipe", "pipe", "ignore", "pipe"])
    })
  })

  it("retains lifetime error listeners after custom pipe consumers finish and after scope cleanup", async () => {
    await withNativePipes(["pipe", "pipe", "pipe", "ignore", "pipe", "pipe"], async (child, pipes) => {
      const late = Object.assign(new Error("late pending native write"), { code: "EPIPE" })
      await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
        const handle = yield* spawn([], { additionalFds: { fd4: { type: "input" }, fd5: { type: "output" } } })
        expect(pipes[4]!.writableEnded).toBe(false)
        expect(pipes[5]!.writableEnded).toBe(true)
        expect(pipes[5]!.readableEnded).toBe(false)
        yield* Stream.run(input("written before consumer exit"), handle.getInputFd(4))
        expect(pipes[4]!.writableEnded).toBe(true)
        pipes[5]!.push(bytes("read before consumer exit"))
        pipes[5]!.push(null)
        expect(yield* output(handle.getOutputFd(5))).toBe("read before consumer exit")
        for (const fd of [4, 5]) {
          expect(pipes[fd]!.listenerCount("error")).toBeGreaterThan(0)
          expect(() => pipes[fd]!.emit("error", late)).not.toThrow()
        }
        child.emit("exit", 0, null)
        expect(yield* handle.exitCode).toBe(0)
      })))
      for (const pipe of pipes) {
        if (pipe === null) continue
        expect(pipe.destroyed).toBe(true)
        expect(pipe.listenerCount("error")).toBeGreaterThan(0)
        expect(() => pipe.emit("error", late)).not.toThrow()
      }
    })
  })

  it.each(["input", "output"] as const)("preserves an active custom %s pipe failure", async (direction) => {
    await withNativePipes(["pipe", "pipe", "pipe", "pipe"], async (child, pipes) => {
      const broken = Object.assign(new Error("custom pipe failed"), { code: "EIO" })
      const error = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
        const handle = yield* spawn([], { additionalFds: { fd3: { type: direction } } })
        pipes[3]!.destroy(broken)
        child.emit("exit", 0, null)
        const run: Effect.Effect<unknown, PlatformError.PlatformError> = direction === "input"
          ? Stream.run(input("failed write"), handle.getInputFd(3))
          : Stream.runDrain(handle.getOutputFd(3))
        return yield* Effect.flip(run)
      })))
      expect(error.cause).toBe(broken)
      expect(error.reason.method).toBe("fd3")
    })
  })

  it.each(
    [
      [0, "stdin"],
      [1, "stdout"],
      [2, "stderr"],
      [4, "fd4 input"],
      [5, "fd5 output"]
    ] as const
  )("retains fd%i %s failure emitted before any consumer subscribes", async (fd, _label) => {
    await withNativePipes(["pipe", "pipe", "pipe", "ignore", "pipe", "pipe"], async (child, pipes) => {
      const broken = Object.assign(new Error("pipe failed before consumption"), { code: "EIO" })
      const error = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
        const handle = yield* spawn([], { additionalFds: { fd4: { type: "input" }, fd5: { type: "output" } } })
        yield* Effect.promise(() =>
          new Promise<void>((resolve) => {
            pipes[fd]!.once("close", resolve)
            pipes[fd]!.destroy(broken)
          })
        )
        // 'close' follows the native error event. A newly attached listener
        // cannot recover that event; the adapter must retain its exact cause.
        child.emit("exit", 0, null)
        const work = fd === 0 || fd === 4
          ? Stream.run(input("too late"), fd === 0 ? handle.stdin : handle.getInputFd(fd))
          : Stream.runDrain(fd === 1 ? handle.stdout : fd === 2 ? handle.stderr : handle.getOutputFd(fd))
        return yield* Effect.flip(work.pipe(Effect.timeout("500 millis")))
      })))
      expect(error).not.toHaveProperty("_tag", "TimeoutError")
      expect(error).toHaveProperty("cause", broken)
      expect("cause" in error ? error.cause : undefined).toBe(broken)
    })
  })

  it.each(["finished", "destroyed"] as const)("refuses a %s stdin writable without waiting for drain", async (mode) => {
    await withNativePipes(["pipe", "pipe", "pipe"], async (child, pipes) => {
      const error = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
        const handle = yield* spawn([], { stdin: "pipe" })
        if (mode === "finished") yield* Stream.run(input("first write"), handle.stdin)
        else {
          yield* Effect.promise(() =>
            new Promise<void>((resolve) => {
              pipes[0]!.once("close", resolve)
              pipes[0]!.destroy()
            })
          )
        }
        child.emit("exit", 0, null)
        return yield* Effect.flip(Stream.run(input("second write"), handle.stdin).pipe(Effect.timeout("500 millis")))
      })))
      expect(error).not.toHaveProperty("_tag", "TimeoutError")
      expect(error).toMatchObject({ cause: { code: "EPIPE", message: "stdin is closed" } })
    })
  })
})

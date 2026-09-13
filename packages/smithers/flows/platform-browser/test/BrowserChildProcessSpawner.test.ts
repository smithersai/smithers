/**
 * The spawner is driven through a stub `JustBashLike`, because what is being
 * pinned is the adapter — which command line the interpreter is handed, which
 * `PlatformError` a missing capability produces, and the serialized abort
 * boundary — not just-bash's own parser.
 *
 * Two stub shapes matter. Most tests settle in the same turn they are aborted,
 * which is the well-behaved interpreter; {@link deafStub} deliberately ignores
 * the abort and settles on a timer, which is the only way the permit's real
 * lifetime becomes observable.
 *
 * `FileSystem` comes from this package's own `BrowserFileSystem` over
 * `node:fs/promises`, so the `cwd` validation path is exercised against a real
 * directory rather than a double.
 */
import { afterAll, beforeAll, describe, expect, it } from "@effect/vitest"
import * as CommandLine from "@smthrs/kernel/CommandLine"
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Option, Path, Sink, Stream } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { mkdtemp, rm } from "node:fs/promises"
import * as NodeFsPromises from "node:fs/promises"
import { tmpdir } from "node:os"
import { vi } from "vitest"
import * as BrowserChildProcessSpawner from "../src/BrowserChildProcessSpawner/index.ts"
import * as BrowserFileSystem from "../src/BrowserFileSystem/index.ts"

interface Call {
  readonly command: string
  readonly cwd: string | undefined
  readonly env: Readonly<Record<string, string>> | undefined
  readonly replaceEnv: boolean | undefined
}

interface Stub {
  readonly bash: BrowserChildProcessSpawner.JustBashLike
  readonly calls: Array<Call>
}

const stub = (
  exec: (
    commandLine: string,
    signal?: AbortSignal
  ) => Promise<{ stdout: string; stderr: string; exitCode: number }>
): Stub => {
  const calls: Array<Call> = []
  return {
    calls,
    bash: {
      exec: (commandLine, options) => {
        calls.push({
          command: commandLine,
          cwd: options?.cwd,
          env: options?.env,
          replaceEnv: options?.replaceEnv
        })
        return exec(commandLine, options?.signal)
      }
    }
  }
}

/**
 * An interpreter that ignores the abort and settles on its own timer.
 *
 * This is the shape the boundary has to survive. A stub that rejects
 * synchronously inside its own `abort` listener settles in the same turn the
 * permit is released, so an overlap can never be observed; this one does not,
 * and `peak` records how many interpreter calls were ever in flight at once.
 */
const deafStub = (settleAfter: number) => {
  let inFlight = 0
  let peak = 0
  const started: Array<() => void> = []
  const bash: BrowserChildProcessSpawner.JustBashLike = {
    exec: () =>
      new Promise((resolve) => {
        inFlight += 1
        peak = Math.max(peak, inFlight)
        started.shift()?.()
        setTimeout(() => {
          inFlight -= 1
          resolve({ stdout: "", stderr: "", exitCode: 0 })
        }, settleAfter)
      })
  }
  return {
    bash,
    peak: (): number => peak,
    whenStarted: (): Promise<void> => new Promise<void>((resolve) => started.push(resolve))
  }
}

const ok = (stdout = "", stderr = "", exitCode = 0) => async () => ({ stdout, stderr, exitCode })

const join = (...segments: ReadonlyArray<string>): string => segments.join("/")

let root: string

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "flows-platform-browser-spawn-"))
  await NodeFsPromises.writeFile(join(root, "file.txt"), "not a directory")
})

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

const layerOf = (bash: BrowserChildProcessSpawner.JustBashLike) =>
  BrowserChildProcessSpawner.layer(bash).pipe(
    Layer.provide(Layer.mergeAll(BrowserFileSystem.layer(NodeFsPromises), Path.layer))
  )

const run = <A, E>(
  bash: BrowserChildProcessSpawner.JustBashLike,
  effect: Effect.Effect<A, E, ChildProcessSpawner>
) => Effect.provide(effect, layerOf(bash))

const runExit = <A, E>(
  bash: BrowserChildProcessSpawner.JustBashLike,
  effect: Effect.Effect<A, E, ChildProcessSpawner>
) => Effect.exit(Effect.provide(effect, layerOf(bash)))

describe("BrowserChildProcessSpawner", () => {
  it.effect("renders the line with the very renderer the kernel grants against", () =>
    Effect.gen(function*() {
      const { bash, calls } = stub(ok("hi\n"))

      const command = ChildProcess.make("echo", ["a b", "it's"])
      const output = yield* run(
        bash,
        Effect.flatMap(ChildProcessSpawner, (spawner) => spawner.string(command))
      )

      expect(output).toBe("hi\n")
      // Argv semantics are kept by quoting only what needs it — and the string is
      // `CommandLine.render`'s, the same one `proc:spawn` is checked against, so
      // a grant cannot authorize a line different from the one that runs.
      expect(calls[0]?.command).toBe("echo 'a b' 'it'\\''s'")
      expect(calls[0]?.command).toBe(CommandLine.render(command))
    }))

  it.effect("passes the line through verbatim when `shell` is requested", () =>
    Effect.gen(function*() {
      const { bash, calls } = stub(ok())

      yield* run(
        bash,
        Effect.flatMap(
          ChildProcessSpawner,
          (spawner) => spawner.exitCode(ChildProcess.make("ls | wc -l", [], { shell: true }))
        )
      )

      expect(calls[0]?.command).toBe("ls | wc -l")
      expect(calls[0]?.command).toBe(CommandLine.render(ChildProcess.make("ls | wc -l", [], { shell: true })))
    }))

  it.effect("reports the interpreter exit code and both captured streams", () =>
    Effect.gen(function*() {
      const { bash } = stub(ok("out", "err", 3))

      const result = yield* run(
        bash,
        Effect.scoped(Effect.gen(function*() {
          const spawner = yield* ChildProcessSpawner
          const handle = yield* spawner.spawn(ChildProcess.make("thing"))
          const stdout = yield* Stream.mkString(Stream.decodeText(handle.stdout))
          const stderr = yield* Stream.mkString(Stream.decodeText(handle.stderr))
          const all = yield* Stream.mkString(Stream.decodeText(handle.all))
          return { code: yield* handle.exitCode, stdout, stderr, all, running: yield* handle.isRunning }
        }))
      )

      expect(result).toEqual({ code: 3, stdout: "out", stderr: "err", all: "outerr", running: false })
    }))

  it.effect("emits no chunk at all for an empty stream", () =>
    Effect.gen(function*() {
      const { bash } = stub(ok("", "only-stderr"))

      const chunks = yield* run(
        bash,
        Effect.scoped(Effect.gen(function*() {
          const spawner = yield* ChildProcessSpawner
          const handle = yield* spawner.spawn(ChildProcess.make("thing"))
          return yield* Stream.runCollect(handle.stdout)
        }))
      )

      expect(Array.from(chunks)).toEqual([])
    }))

  /**
   * The interpreter captures the text either way, so the stream options have to
   * be applied by the adapter — Node gets them for free by never opening a
   * readable for anything but `"pipe"`.
   */
  it.effect.each<["ignore" | "inherit" | "pipe" | "overlapped", string]>([
    ["ignore", ""],
    ["inherit", ""],
    ["pipe", "out"],
    ["overlapped", "out"]
  ])("honours the `%s` stdout option", ([handling, expected]) =>
    Effect.gen(function*() {
      const { bash } = stub(ok("out", "err"))

      const observed = yield* run(
        bash,
        Effect.scoped(Effect.gen(function*() {
          const spawner = yield* ChildProcessSpawner
          const handle = yield* spawner.spawn(ChildProcess.make("thing", [], { stdout: handling }))
          return yield* Stream.mkString(Stream.decodeText(handle.stdout))
        }))
      )

      expect(observed).toBe(expected)
    }))

  it.effect.each<["ignore" | "inherit", boolean]>([
    ["ignore", false],
    ["inherit", false],
    ["ignore", true],
    ["inherit", true]
  ])("does not encode discarded `%s` output (nested: %s)", ([handling, nested]) =>
    Effect.gen(function*() {
      const { bash } = stub(ok("hé", "err"))
      yield* run(
        bash,
        Effect.scoped(Effect.gen(function*() {
          const encode = vi.spyOn(TextEncoder.prototype, "encode")
          yield* Effect.addFinalizer(() => Effect.sync(() => encode.mockRestore()))
          const spawner = yield* ChildProcessSpawner
          const option = nested ? { stream: handling } : handling
          const ignored = yield* spawner.spawn(ChildProcess.make("thing", [], {
            stdout: option,
            stderr: option
          }))
          for (const stream of [ignored.stdout, ignored.stderr, ignored.all]) {
            expect(Array.from(yield* Stream.runCollect(stream))).toEqual([])
            expect(encode).not.toHaveBeenCalled()
          }

          const piped = yield* spawner.spawn(ChildProcess.make("thing", [], {
            stdout: "pipe",
            stderr: option
          }))
          const chunks = yield* Stream.runCollect(piped.all)
          expect(Array.from(chunks)).toEqual([new Uint8Array([104, 195, 169])])
          expect(encode).toHaveBeenCalledExactlyOnceWith("hé")
        }))
      )
    }))

  it.effect("honours an option nested in a stdout config, and an undefined one inside it", () =>
    Effect.gen(function*() {
      const { bash } = stub(ok("out", "err"))

      const observed = yield* run(
        bash,
        Effect.scoped(Effect.gen(function*() {
          const spawner = yield* ChildProcessSpawner
          const ignored = yield* spawner.spawn(ChildProcess.make("thing", [], { stderr: { stream: "ignore" } }))
          const piped = yield* spawner.spawn(ChildProcess.make("thing", [], { stderr: {} }))
          return {
            ignored: yield* Stream.mkString(Stream.decodeText(ignored.stderr)),
            piped: yield* Stream.mkString(Stream.decodeText(piped.stderr))
          }
        }))
      )

      expect(observed).toEqual({ ignored: "", piped: "err" })
    }))

  it.effect("transduces captured output through a `Sink` given as an option", () =>
    Effect.gen(function*() {
      const { bash } = stub(ok("out"))
      const upper = Sink.map(
        Sink.collect<Uint8Array>(),
        (chunks) =>
          new TextEncoder().encode(chunks.map((chunk) => new TextDecoder().decode(chunk)).join("").toUpperCase())
      )

      const observed = yield* run(
        bash,
        Effect.scoped(Effect.gen(function*() {
          const spawner = yield* ChildProcessSpawner
          const handle = yield* spawner.spawn(ChildProcess.make("thing", [], { stdout: upper }))
          return yield* Stream.mkString(Stream.decodeText(handle.stdout))
        }))
      )

      expect(observed).toBe("OUT")
    }))

  it.effect("forwards cwd and env, dropping the undefined values just-bash cannot represent", () =>
    Effect.gen(function*() {
      const { bash, calls } = stub(ok())

      yield* run(
        bash,
        Effect.flatMap(ChildProcessSpawner, (spawner) =>
          spawner.exitCode(ChildProcess.make("thing", [], {
            cwd: root,
            env: { KEEP: "yes", DROP: undefined },
            extendEnv: true
          })))
      )

      expect(calls[0]?.cwd).toBe(root)
      expect(calls[0]?.env).toEqual({ KEEP: "yes" })
    }))

  it.effect.each([false, true])(
    "resolves a relative cwd against the volume root (tab: %s)",
    (tab) =>
      Effect.gen(function*() {
        const { bash, calls } = stub(ok())
        const statted: Array<string> = []
        const path = yield* Path.Path.pipe(Effect.provide(Path.layer))
        const pathLayer = Layer.succeed(Path.Path, {
          ...path,
          resolve: (...paths) => {
            if (!tab) return path.resolve(...paths)
            // Only the synchronous resolver sees a tab's missing process global,
            // so the test runner and asynchronous filesystem keep their runtime.
            const descriptor = Object.getOwnPropertyDescriptor(globalThis, "process")!
            Reflect.deleteProperty(globalThis, "process")
            try {
              return path.resolve(...paths)
            } finally {
              Object.defineProperty(globalThis, "process", descriptor)
            }
          }
        })
        const layer = BrowserChildProcessSpawner.layer(bash).pipe(
          Layer.provide(Layer.mergeAll(
            BrowserFileSystem.layer({
              ...NodeFsPromises,
              stat: (cwd) => {
                statted.push(cwd)
                // Model a volume whose backend roots relative paths at /.
                return NodeFsPromises.stat(join(root, cwd))
              }
            }),
            pathLayer
          ))
        )
        yield* Effect.promise(() => NodeFsPromises.mkdir(join(root, "workspace"), { recursive: true }))

        const exit = yield* Effect.exit(Effect.provide(
          Effect.flatMap(
            ChildProcessSpawner,
            (spawner) => spawner.exitCode(ChildProcess.make("thing", [], { cwd: "workspace" }))
          ),
          layer
        ))

        expect(exit).toEqual(Exit.succeed(0))
        expect(calls[0]?.cwd).toBe("/workspace")
        expect(statted).toEqual(["/workspace"])
      })
  )

  it.effect("omits cwd and env entirely when the command declares neither", () =>
    Effect.gen(function*() {
      const { bash, calls } = stub(ok())

      yield* run(bash, Effect.flatMap(ChildProcessSpawner, (spawner) => spawner.exitCode(ChildProcess.make("thing"))))

      expect(calls[0]).toEqual({ command: "thing", cwd: undefined, env: undefined })
    }))

  /**
   * `env` without `extendEnv` is Effect's replacement case, and just-bash
   * merges into the interpreter's own environment unless it is asked for
   * `replaceEnv`. Not asking inverts the caller's semantics.
   */
  it.effect("asks the interpreter to replace its environment unless the caller extends it", () =>
    Effect.gen(function*() {
      const { bash, calls } = stub(ok())

      yield* run(
        bash,
        Effect.flatMap(ChildProcessSpawner, (spawner) =>
          Effect.all([
            spawner.exitCode(ChildProcess.make("replaced", [], { env: { A: "1" } })),
            spawner.exitCode(ChildProcess.make("extended", [], { env: { A: "1" }, extendEnv: true })),
            spawner.exitCode(ChildProcess.make("neither"))
          ]))
      )

      expect(calls.map((call) => call.replaceEnv)).toEqual([true, undefined, undefined])
    }))

  it.effect("fails before running anything when cwd does not exist", () =>
    Effect.gen(function*() {
      const { bash, calls } = stub(ok())

      const exit = yield* runExit(
        bash,
        Effect.flatMap(
          ChildProcessSpawner,
          (spawner) => spawner.exitCode(ChildProcess.make("thing", [], { cwd: join(root, "absent") }))
        )
      )

      expect(Exit.isFailure(exit)).toBe(true)
      expect(calls).toEqual([])
    }))

  /**
   * A bare existence check passes a regular file, which is then handed to the
   * interpreter as a working directory; Node fails ENOTDIR here.
   */
  it.effect("refuses a regular file given as the working directory", () =>
    Effect.gen(function*() {
      const { bash, calls } = stub(ok())

      const error = yield* run(
        bash,
        Effect.flip(
          Effect.flatMap(
            ChildProcessSpawner,
            (spawner) => spawner.exitCode(ChildProcess.make("thing", [], { cwd: join(root, "file.txt") }))
          )
        )
      )

      expect(error.reason).toMatchObject({ _tag: "BadArgument", module: "ChildProcess", method: "spawn" })
      expect(error.message).toContain("is not a directory")
      expect(calls).toEqual([])
    }))

  it.effect("wraps a thrown interpreter failure as a system PlatformError", () =>
    Effect.gen(function*() {
      const { bash } = stub(async () => {
        throw new Error("interpreter exploded")
      })

      const error = yield* run(
        bash,
        Effect.flip(Effect.flatMap(ChildProcessSpawner, (spawner) => spawner.exitCode(ChildProcess.make("thing"))))
      )

      expect(error.reason).toMatchObject({
        _tag: "Unknown",
        module: "ChildProcess",
        method: "spawn",
        description: "interpreter exploded"
      })
    }))

  /**
   * A synchronous throw never produced a promise to wait on, but it is still a
   * failed run rather than a defect in this adapter.
   */
  it.effect("wraps an interpreter that throws before returning a promise", () =>
    Effect.gen(function*() {
      const bash: BrowserChildProcessSpawner.JustBashLike = {
        exec: () => {
          throw new Error("no interpreter mounted")
        }
      }

      const error = yield* run(
        bash,
        Effect.flip(Effect.flatMap(ChildProcessSpawner, (spawner) => spawner.exitCode(ChildProcess.make("thing"))))
      )

      expect(error.reason).toMatchObject({
        _tag: "Unknown",
        module: "ChildProcess",
        method: "spawn",
        description: "no interpreter mounted"
      })
    }))

  it.effect("stringifies a non-Error interpreter rejection", () =>
    Effect.gen(function*() {
      const { bash } = stub(async () => {
        throw "plain"
      })

      const error = yield* run(
        bash,
        Effect.flip(Effect.flatMap(ChildProcessSpawner, (spawner) => spawner.exitCode(ChildProcess.make("thing"))))
      )

      expect(error.reason.description).toBe("plain")
    }))
})

describe("BrowserChildProcessSpawner rejected inputs", () => {
  it.effect("rejects a pipeline of processes rather than pretending to fork", () =>
    Effect.gen(function*() {
      const { bash, calls } = stub(ok())

      const error = yield* run(
        bash,
        Effect.flip(
          Effect.flatMap(
            ChildProcessSpawner,
            (spawner) => spawner.exitCode(ChildProcess.pipeTo(ChildProcess.make("a"), ChildProcess.make("b")))
          )
        )
      )

      expect(error.reason).toMatchObject({ _tag: "BadArgument", module: "ChildProcess", method: "spawn" })
      expect(error.message).toContain("single command line")
      expect(calls).toEqual([])
    }))

  it.effect("rejects stdin given directly as a stream", () =>
    Effect.gen(function*() {
      const { bash } = stub(ok())

      const error = yield* run(
        bash,
        Effect.flip(
          Effect.flatMap(
            ChildProcessSpawner,
            (spawner) => spawner.exitCode(ChildProcess.make("thing", [], { stdin: Stream.make(new Uint8Array([1])) }))
          )
        )
      )

      expect(error.message).toContain("cannot stream stdin into it")
    }))

  it.effect("rejects stdin given as a config wrapping a stream", () =>
    Effect.gen(function*() {
      const { bash } = stub(ok())

      const error = yield* run(
        bash,
        Effect.flip(Effect.flatMap(ChildProcessSpawner, (spawner) =>
          spawner.exitCode(
            ChildProcess.make("thing", [], { stdin: { stream: Stream.make(new Uint8Array([1])) } })
          )))
      )

      expect(error.reason._tag).toBe("BadArgument")
    }))

  it.effect("accepts the string stdin options, which name a pipe rather than supply one", () =>
    Effect.gen(function*() {
      const { bash, calls } = stub(ok())

      yield* run(
        bash,
        Effect.flatMap(
          ChildProcessSpawner,
          (spawner) => spawner.exitCode(ChildProcess.make("thing", [], { stdin: "ignore" }))
        )
      )

      expect(calls).toHaveLength(1)
    }))

  it.effect("accepts a stdin config that names an option instead of a stream", () =>
    Effect.gen(function*() {
      const { bash, calls } = stub(ok())

      yield* run(
        bash,
        Effect.flatMap(
          ChildProcessSpawner,
          (spawner) => spawner.exitCode(ChildProcess.make("thing", [], { stdin: { stream: "inherit" } }))
        )
      )

      expect(calls).toHaveLength(1)
    }))

  /**
   * `CommandOptions` inherits `forceKillAfter`; dropping it at spawn runs a
   * command whose requested hard-stop guarantee this backend cannot provide.
   */
  it.effect("rejects command-level `forceKillAfter` before invoking the interpreter", () =>
    Effect.gen(function*() {
      const { bash, calls } = stub(ok())

      const error = yield* run(
        bash,
        Effect.flip(Effect.flatMap(
          ChildProcessSpawner,
          (spawner) => spawner.exitCode(ChildProcess.make("thing", [], { forceKillAfter: 1 }))
        ))
      )

      expect(error.reason).toMatchObject({ _tag: "BadArgument", module: "ChildProcess", method: "spawn" })
      expect(error.message).toContain("forceKillAfter")
      expect(calls).toEqual([])
    }))

  it.effect.each<[string, ChildProcess.Command, string]>([
    [
      "additional file descriptors",
      ChildProcess.make("thing", [], { additionalFds: { fd3: { type: "output" } } }),
      "additional file descriptors"
    ],
    ["a custom shell", ChildProcess.make("thing", [], { shell: "/bin/zsh" }), "requested shell"],
    ["a detached process", ChildProcess.make("thing", [], { detached: true }), "detach"]
  ])("rejects %s instead of silently ignoring it", ([_name, command, message]) =>
    Effect.gen(function*() {
      const { bash, calls } = stub(ok())

      const error = yield* run(
        bash,
        Effect.flip(Effect.flatMap(ChildProcessSpawner, (spawner) => spawner.exitCode(command)))
      )

      expect(error.reason._tag).toBe("BadArgument")
      expect(error.message).toContain(message)
      expect(calls).toEqual([])
    }))
})

describe("BrowserChildProcessSpawner handle capabilities", () => {
  it.effect("hands out increasing pids, a failing stdin, an aborting kill, and a no-op unref", () =>
    Effect.gen(function*() {
      const { bash } = stub(ok())

      const observed = yield* run(
        bash,
        Effect.scoped(Effect.gen(function*() {
          const spawner = yield* ChildProcessSpawner
          const first = yield* spawner.spawn(ChildProcess.make("one"))
          const second = yield* spawner.spawn(ChildProcess.make("two"))
          const stdin = yield* Effect.flip(Stream.run(Stream.make(new Uint8Array([1])), second.stdin))
          yield* second.kill()
          const reref = yield* second.unref
          yield* reref
          const fd = yield* Stream.runCollect(second.getOutputFd(3))
          yield* Stream.run(Stream.make(new Uint8Array([1])), second.getInputFd(3))
          return { pids: [first.pid, second.pid], stdin, fd: Array.from(fd) }
        }))
      )

      expect(observed.pids).toEqual([1, 2])
      expect(observed.stdin.reason).toMatchObject({ method: "stdin", _tag: "Unknown" })
      expect(observed.fd).toEqual([])
    }))
})

describe("BrowserChildProcessSpawner boundary", () => {
  it.effect("aborts the interpreter before reporting an interruption", () =>
    Effect.gen(function*() {
      let aborted = false
      const started = Deferred.makeUnsafe<void>()
      const { bash } = stub((_command, signal) =>
        new Promise((_resolve, reject) => {
          Deferred.doneUnsafe(started, Exit.void)
          signal?.addEventListener("abort", () => {
            aborted = true
            reject(signal.reason)
          }, { once: true })
        })
      )

      const exit = yield* Effect.exit(
        Effect.provide(
          Effect.gen(function*() {
            const spawner = yield* ChildProcessSpawner
            const fiber = yield* Effect.forkChild(spawner.exitCode(ChildProcess.make("slow")), {
              startImmediately: true
            })
            yield* Deferred.await(started)
            return yield* Fiber.interrupt(fiber)
          }),
          layerOf(bash)
        )
      )

      expect(Exit.isSuccess(exit)).toBe(true)
      expect(aborted).toBe(true)
    }))

  // Real elapsed time: `it.effect`'s TestClock would stall this.
  it.live("aborts the interpreter before reporting a timeout", () =>
    Effect.gen(function*() {
      let aborted = false
      const { bash } = stub((_command, signal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => {
            aborted = true
            reject(signal.reason)
          }, { once: true })
        })
      )

      const exit = yield* runExit(
        bash,
        Effect.flatMap(ChildProcessSpawner, (spawner) => Effect.timeout(spawner.exitCode(ChildProcess.make("slow")), 1))
      )

      expect(Exit.isFailure(exit)).toBe(true)
      expect(aborted).toBe(true)
    }))

  it.effect("serializes concurrent runs so one interpreter call never overlaps another", () =>
    Effect.gen(function*() {
      let inFlight = 0
      let overlapped = false
      const { bash } = stub(async () => {
        inFlight += 1
        if (inFlight > 1) overlapped = true
        await new Promise((resolve) => setTimeout(resolve, 5))
        inFlight -= 1
        return { stdout: "", stderr: "", exitCode: 0 }
      })

      yield* run(
        bash,
        Effect.flatMap(ChildProcessSpawner, (spawner) =>
          Effect.all(
            [
              spawner.exitCode(ChildProcess.make("a")),
              spawner.exitCode(ChildProcess.make("b")),
              spawner.exitCode(ChildProcess.make("c"))
            ],
            { concurrency: "unbounded" }
          ))
      )

      expect(overlapped).toBe(false)
    }))

  it.effect("removes an interrupted queued run without leaking the semaphore permit", () =>
    Effect.gen(function*() {
      const firstStarted = Deferred.makeUnsafe<void>()
      const releaseFirst = Deferred.makeUnsafe<void>()
      const thirdStarted = Deferred.makeUnsafe<void>()
      const { bash, calls } = stub(async (command) => {
        if (command === "first") {
          Deferred.doneUnsafe(firstStarted, Exit.void)
          // The adapter under test hands this stub a Promise contract, so
          // running the Effect here is the boundary being exercised.
          await Effect.runPromise(Deferred.await(releaseFirst))
        }
        if (command === "third") Deferred.doneUnsafe(thirdStarted, Exit.void)
        return { stdout: "", stderr: "", exitCode: 0 }
      })

      const observed = yield* run(
        bash,
        Effect.gen(function*() {
          const spawner = yield* ChildProcessSpawner
          const first = yield* Effect.forkChild(spawner.exitCode(ChildProcess.make("first")), {
            startImmediately: true
          })
          yield* Deferred.await(firstStarted)

          // startImmediately drives the child to its first suspension: with the
          // first run holding the sole permit, the second is now queued at it.
          const second = yield* Effect.forkChild(spawner.exitCode(ChildProcess.make("second")), {
            startImmediately: true
          })
          const callsWhileQueued = calls.map((call) => call.command)
          yield* Fiber.interrupt(second)
          const secondExit = yield* Fiber.await(second)

          Deferred.doneUnsafe(releaseFirst, Exit.void)
          yield* Fiber.join(first)

          const third = yield* Effect.forkChild(spawner.exitCode(ChildProcess.make("third")), {
            startImmediately: true
          })
          const thirdDidStart = Option.isSome(yield* Deferred.poll(thirdStarted))
          if (!thirdDidStart) yield* Fiber.interrupt(third)
          const thirdExit = yield* Fiber.await(third)
          return {
            callsWhileQueued,
            secondExit,
            thirdDidStart,
            thirdExit,
            calls: calls.map((call) => call.command)
          }
        })
      )

      expect(observed.callsWhileQueued).toEqual(["first"])
      expect(Exit.isFailure(observed.secondExit)).toBe(true)
      expect(observed.thirdDidStart).toBe(true)
      expect(Exit.isSuccess(observed.thirdExit)).toBe(true)
      expect(observed.calls).toEqual(["first", "third"])
    }))

  /**
   * The permit has to outlive the *promise*, not the fiber waiting on it.
   * `Effect.tryPromise` aborts and resumes in the same turn, so the permit
   * would be released with the call still writing to the mount, and a second
   * interpreter would start on top of it.
   */
  it.live("holds the permit until an aborted interpreter actually settles", () =>
    Effect.gen(function*() {
      const { bash, peak, whenStarted } = deafStub(40)

      yield* run(
        bash,
        Effect.gen(function*() {
          const spawner = yield* ChildProcessSpawner
          const started = whenStarted()
          const fiber = yield* Effect.forkChild(spawner.exitCode(ChildProcess.make("first")), {
            startImmediately: true
          })
          yield* Effect.promise(() => started)
          yield* Fiber.interrupt(fiber)
          yield* spawner.exitCode(ChildProcess.make("second"))
        })
      )

      expect(peak()).toBe(1)
    }))

  it.live("holds the permit until an interpreter abandoned by a timeout settles", () =>
    Effect.gen(function*() {
      const { bash, peak } = deafStub(40)

      yield* run(
        bash,
        Effect.gen(function*() {
          const spawner = yield* ChildProcessSpawner
          yield* Effect.exit(Effect.timeout(spawner.exitCode(ChildProcess.make("first")), 1))
          yield* spawner.exitCode(ChildProcess.make("second"))
        })
      )

      expect(peak()).toBe(1)
    }))

  it.live("holds the permit until an interpreter stopped by `kill` settles", () =>
    Effect.gen(function*() {
      const { bash, peak, whenStarted } = deafStub(40)

      yield* run(
        bash,
        Effect.gen(function*() {
          const spawner = yield* ChildProcessSpawner
          const started = whenStarted()
          yield* Effect.scoped(Effect.gen(function*() {
            const handle = yield* spawner.spawn(ChildProcess.make("first"))
            yield* Effect.promise(() => started)
            yield* handle.kill()
          }))
          yield* spawner.exitCode(ChildProcess.make("second"))
        })
      )

      expect(peak()).toBe(1)
    }))

  /**
   * The observables are typed `Effect<_, PlatformError>`. Replaying the
   * worker's interrupt through them would cancel the caller's own fiber, which
   * is indistinguishable from someone else cancelling the whole run.
   */
  it.effect("reports a killed run as a PlatformError rather than interrupting the caller", () =>
    Effect.gen(function*() {
      const { bash } = stub((_command, signal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true })
        })
      )

      const observed = yield* run(
        bash,
        Effect.scoped(Effect.gen(function*() {
          const spawner = yield* ChildProcessSpawner
          const handle = yield* spawner.spawn(ChildProcess.make("slow"))
          const before = yield* handle.isRunning
          yield* handle.kill()
          return {
            before,
            after: yield* handle.isRunning,
            exit: yield* Effect.exit(handle.exitCode),
            stdout: yield* Effect.exit(Stream.runCollect(handle.stdout))
          }
        }))
      )

      expect(observed.before).toBe(true)
      expect(observed.after).toBe(false)
      expect(Exit.hasInterrupts(observed.exit)).toBe(false)
      expect(Exit.hasInterrupts(observed.stdout)).toBe(false)
      const failure = Exit.isFailure(observed.exit)
        ? Option.getOrUndefined(Cause.findErrorOption(observed.exit.cause))
        : undefined
      expect(failure?.reason).toMatchObject({
        _tag: "Unknown",
        module: "ChildProcess",
        method: "kill",
        description: "the interpreter run was aborted",
        pathOrDescriptor: "slow"
      })
      expect(Exit.isFailure(observed.stdout)).toBe(true)
    }))

  it.effect("refuses `forceKillAfter`, which has no meaning after the abort", () =>
    Effect.gen(function*() {
      const { bash } = stub(ok())

      const error = yield* run(
        bash,
        Effect.scoped(Effect.gen(function*() {
          const spawner = yield* ChildProcessSpawner
          const handle = yield* spawner.spawn(ChildProcess.make("thing"))
          // `killSignal` has no meaning for an interpreter and is accepted.
          yield* handle.kill({ killSignal: "SIGTERM" })
          return yield* Effect.flip(handle.kill({ forceKillAfter: "1 second" }))
        }))
      )

      expect(error.reason).toMatchObject({ _tag: "BadArgument", module: "ChildProcess", method: "kill" })
      expect(error.message).toContain("forceKillAfter")
    }))

  /**
   * `handle.stdout` and `handle.all` both wrap the same captured text, so a
   * configured `Sink` has to be transduced once per consumption rather than
   * shared between them; and `all` inherits `stdout`'s handling, so an
   * ignored stdout leaves `all` carrying stderr alone.
   */
  it.effect("applies a stdout option to `all` as well as to `stdout`", () =>
    Effect.gen(function*() {
      const { bash } = stub(ok("out", "err"))
      let transductions = 0
      const counting = Sink.map(Sink.collect<Uint8Array>(), (chunks) => {
        transductions += 1
        return new TextEncoder().encode(
          `${transductions}:${chunks.map((chunk) => new TextDecoder().decode(chunk)).join("")}`
        )
      })

      const observed = yield* run(
        bash,
        Effect.scoped(Effect.gen(function*() {
          const spawner = yield* ChildProcessSpawner
          const sunk = yield* spawner.spawn(ChildProcess.make("thing", [], { stdout: counting }))
          const ignored = yield* spawner.spawn(ChildProcess.make("thing", [], { stdout: "ignore" }))
          return {
            stdout: yield* Stream.mkString(Stream.decodeText(sunk.stdout)),
            all: yield* Stream.mkString(Stream.decodeText(sunk.all)),
            ignoredAll: yield* Stream.mkString(Stream.decodeText(ignored.all))
          }
        }))
      )

      expect(observed.stdout).toBe("1:out")
      expect(observed.all).toBe("2:outerr")
      expect(observed.ignoredAll).toBe("err")
      expect(transductions).toBe(2)
    }))

  /**
   * This adapter is the one place a rendered command line is handed back to a
   * real shell parser, so the hostile tokens are pinned as a golden string and
   * against `CommandLine.render` itself, which is what `proc:spawn` grants
   * against. The two cannot drift apart.
   */
  it.effect("quotes hostile argv tokens the way the kernel's renderer does", () =>
    Effect.gen(function*() {
      const { bash, calls } = stub(ok())
      const command = ChildProcess.make("echo", [
        "line\nbreak",
        "`id`",
        "$(id)",
        "${IFS}",
        "it's",
        "-x",
        ""
      ])

      yield* run(bash, Effect.flatMap(ChildProcessSpawner, (spawner) => spawner.exitCode(command)))

      expect(calls[0]?.command).toBe(
        "echo 'line\nbreak' '`id`' '$(id)' '${IFS}' 'it'\\''s' -x ''"
      )
      expect(calls[0]?.command).toBe(CommandLine.render(command))
    }))

  it.effect("derives `lines` and `streamLines` from the same buffered output", () =>
    Effect.gen(function*() {
      const { bash } = stub(ok("one\ntwo\n", "three\n"))

      const [lines, withStderr] = yield* run(
        bash,
        Effect.flatMap(ChildProcessSpawner, (spawner) =>
          Effect.all([
            spawner.lines(ChildProcess.make("thing")),
            spawner.lines(ChildProcess.make("thing"), { includeStderr: true })
          ]))
      )

      expect(Array.from(lines)).toEqual(["one", "two"])
      expect(Array.from(withStderr)).toEqual(["one", "two", "three"])
    }))
})

import { describe, expect, it } from "@effect/vitest"
import { Deferred, Effect, Exit, Fiber, PlatformError, Ref, Sink, Stream } from "effect"
import * as Scope from "effect/Scope"
import { ChildProcess } from "effect/unstable/process"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { Buffer } from "node:buffer"
import * as RemoteChildProcessSpawner from "../src/RemoteChildProcessSpawner/index.ts"

const reason = (error: unknown): string =>
  error instanceof PlatformError.PlatformError ? error.reason._tag : `not a PlatformError: ${String(error)}`

describe("RemoteChildProcessSpawner", () => {
  it.effect("adapts a scripted command through the spawner's buffered helper", () =>
    Effect.gen(function*() {
      const provider = RemoteChildProcessSpawner.TestRemote.make({
        session: "exec-session",
        scripts: { greet: { stdout: "hello" } }
      })

      const result = yield* (
        Effect.gen(function*() {
          const spawner = yield* ChildProcessSpawner
          const command = ChildProcess.make("greet")
          return {
            stdout: yield* spawner.string(command),
            exitCode: yield* spawner.exitCode(command)
          }
        }).pipe(Effect.provide(RemoteChildProcessSpawner.layer(provider)))
      )

      expect(result).toEqual({ stdout: "hello", exitCode: 0 })
      expect(provider.state.openedSessions).toEqual(["exec-session"])
      expect(provider.state.commands).toEqual(["greet", "greet"])
    }))

  it.effect("keeps this process's ambient environment out of the guest and passes chosen values", () =>
    Effect.gen(function*() {
      const seen: Array<Record<string, string | undefined> | undefined> = []
      const scripted = RemoteChildProcessSpawner.TestRemote.make({ scripts: { probe: { stdout: "ok" } } })
      const provider: RemoteChildProcessSpawner.Provider = {
        ...scripted,
        spawn: (command, options) => {
          seen.push(options.env)
          return scripted.spawn(command, options)
        }
      }
      const host = process.env
      const env = {
        PATH: host.PATH ?? "/host/bin",
        HOME: host.HOME ?? "/host/home",
        TMPDIR: "/guest/tmp",
        LANG: host.LANG ?? "C",
        FEATURE: "on",
        DROPPED: undefined
      }
      yield* Effect.flatMap(
        ChildProcessSpawner,
        (spawner) => spawner.string(ChildProcess.make("probe", [], { env, extendEnv: false }))
      ).pipe(Effect.provide(RemoteChildProcessSpawner.layer(provider)))
      const received = seen[0]!
      // The host's own PATH, HOME and LANG stay here; the guest keeps its own.
      for (const name of ["PATH", "HOME", "LANG"]) {
        expect(Object.hasOwn(received, name), name).toBe(host[name] === undefined)
      }
      expect(received).toMatchObject({ TMPDIR: "/guest/tmp", FEATURE: "on" })
      expect(Object.hasOwn(received, "DROPPED") && received.DROPPED === undefined).toBe(true)
      yield* Effect.flatMap(ChildProcessSpawner, (spawner) => spawner.string(ChildProcess.make("probe"))).pipe(
        Effect.provide(RemoteChildProcessSpawner.layer(provider))
      )
      expect(seen[1]).toBeUndefined()
    }))

  it.effect("renders arguments and a pipeline into the command the provider receives", () =>
    Effect.gen(function*() {
      const provider = RemoteChildProcessSpawner.TestRemote.make({
        scripts: { "printf 'a b' | grep a": { stdout: "a b" } }
      })

      const output = yield* (
        Effect.flatMap(
          ChildProcessSpawner,
          (spawner) =>
            spawner.string(
              ChildProcess.make("printf", ["a b"]).pipe(ChildProcess.pipeTo(ChildProcess.make("grep", ["a"])))
            )
        ).pipe(Effect.provide(RemoteChildProcessSpawner.layer(provider)))
      )

      expect(output).toBe("a b")
      expect(provider.state.commands).toEqual(["printf 'a b' | grep a"])
    }))

  it.effect("renders shell commands under the exact unquoted line the provider executes", () =>
    Effect.gen(function*() {
      const provider = RemoteChildProcessSpawner.TestRemote.make({
        scripts: { "echo safe; run privileged": { stdout: "done" } }
      })

      const output = yield* (
        Effect.flatMap(
          ChildProcessSpawner,
          (spawner) => spawner.string(ChildProcess.make("echo", ["safe;", "run", "privileged"], { shell: true }))
        ).pipe(
          Effect.provide(RemoteChildProcessSpawner.layer(provider))
        )
      )

      expect(output).toBe("done")
      expect(provider.state.commands).toEqual(["echo safe; run privileged"])
    }))

  it.effect("interleaves stdout and stderr through the handle's `all` stream", () =>
    Effect.gen(function*() {
      const provider = RemoteChildProcessSpawner.TestRemote.make({
        scripts: { noisy: { stdout: "out", stderr: "err" } }
      })

      const output = yield* (
        Effect.flatMap(
          ChildProcessSpawner,
          (spawner) => Stream.runCollect(spawner.streamString(ChildProcess.make("noisy"), { includeStderr: true }))
        ).pipe(Effect.provide(RemoteChildProcessSpawner.layer(provider)))
      )

      expect(Array.from(output).sort()).toEqual(["err", "out"])
    }))

  it.effect("runs the provider cancellation finalizer on interruption", () =>
    Effect.gen(function*() {
      const provider = RemoteChildProcessSpawner.TestRemote.make({ scripts: { pending: { pending: true } } })

      yield* (
        Effect.gen(function*() {
          const fiber = yield* Effect.flatMap(
            ChildProcessSpawner,
            (spawner) => spawner.exitCode(ChildProcess.make("pending"))
          ).pipe(
            Effect.provide(RemoteChildProcessSpawner.layer(provider)),
            Effect.forkChild({ startImmediately: true })
          )
          yield* Effect.yieldNow
          yield* Fiber.interrupt(fiber)
        })
      )

      expect(provider.state.commands).toEqual(["pending"])
      expect(provider.state.cancellations).toBe(1)
    }))

  it.effect("releases the provider session when a stdout consumer is interrupted", () =>
    Effect.gen(function*() {
      const provider = RemoteChildProcessSpawner.TestRemote.make({ scripts: { pending: { pending: true } } })

      yield* (
        Effect.gen(function*() {
          const fiber = yield* Effect.flatMap(
            ChildProcessSpawner,
            (spawner) => Stream.runDrain(spawner.streamString(ChildProcess.make("pending")))
          ).pipe(
            Effect.provide(RemoteChildProcessSpawner.layer(provider)),
            Effect.forkChild({ startImmediately: true })
          )
          yield* Effect.yieldNow
          yield* Fiber.interrupt(fiber)
        })
      )

      expect(provider.state.commands).toEqual(["pending"])
      expect(provider.state.cancellations).toBe(1)
    }))

  it.effect.each(["failure", "defect"] as const)(
    "surfaces a provider open-scope release %s without hanging",
    (kind) =>
      Effect.gen(function*() {
        const releaseFailure = new RemoteChildProcessSpawner.ProviderError({
          code: "unknown",
          message: "provider scope release failed"
        })
        const release = kind === "failure"
          // Scope finalizers are typed as infallible in Effect, so a provider's
          // typed release failure reaches the close boundary as a defect.
          ? Effect.fail(releaseFailure).pipe(Effect.orDie)
          : Effect.die("provider scope release defect")
        const provider = RemoteChildProcessSpawner.Provider.of({
          session: "release-failure",
          open: () =>
            Effect.gen(function*() {
              const scope = yield* Effect.scope
              yield* Scope.addFinalizer(scope, release)
            }),
          spawn: () =>
            Effect.succeed({
              stdout: Stream.empty,
              stderr: Stream.empty,
              exitCode: Effect.succeed(0)
            })
        })

        const exit = yield* (
          Effect.flatMap(ChildProcessSpawner, (spawner) => spawner.exitCode(ChildProcess.make("quiet"))).pipe(
            Effect.provide(RemoteChildProcessSpawner.layer(provider)),
            Effect.scoped,
            Effect.exit
          )
        )

        expect(Exit.isFailure(exit)).toBe(true)
        if (!Exit.isFailure(exit)) return
        expect(exit.cause.reasons).toEqual(expect.arrayContaining([
          expect.objectContaining(
            kind === "failure"
              ? { _tag: "Die", defect: releaseFailure }
              : { _tag: "Die", defect: "provider scope release defect" }
          )
        ]))
      }),
    1_000
  )

  it.effect("maps typed provider failures onto normalized PlatformError reasons", () =>
    Effect.gen(function*() {
      const provider = RemoteChildProcessSpawner.TestRemote.make({
        scripts: {
          fail: {
            failure: new RemoteChildProcessSpawner.ProviderError({
              code: "spawn_error",
              message: "provider rejected command"
            })
          },
          slow: {
            failure: new RemoteChildProcessSpawner.ProviderError({ code: "timeout", message: "provider gave up" })
          }
        }
      })

      const errors = yield* (
        Effect.gen(function*() {
          const spawner = yield* ChildProcessSpawner
          return [
            yield* Effect.flip(spawner.string(ChildProcess.make("fail"))),
            yield* Effect.flip(spawner.string(ChildProcess.make("slow")))
          ]
        }).pipe(Effect.provide(RemoteChildProcessSpawner.layer(provider)))
      )

      expect(errors.map(reason)).toEqual(["Unknown", "TimedOut"])
      expect(errors[0]?.message).toContain("`fail`: provider rejected command")
    }))

  it.effect.each(["unavailable", "not_found"] as const)(
    "maps provider code %s to the documented NotFound reason",
    (code) =>
      Effect.gen(function*() {
        // `not_found` and `unavailable` stay apart in the provider vocabulary
        // and arrive here as one instruction to a retry policy: this session
        // cannot run your command, try somewhere else. A caller that needs the
        // distinction reads the `ProviderError` off `PlatformError.cause`.
        const failure = new RemoteChildProcessSpawner.ProviderError({ code, message: `${code} provider failure` })
        const provider = RemoteChildProcessSpawner.TestRemote.make({ scripts: { fail: { failure } } })

        const error = yield* Effect.flip(
          Effect.flatMap(ChildProcessSpawner, (spawner) => spawner.string(ChildProcess.make("fail")))
        ).pipe(Effect.provide(RemoteChildProcessSpawner.layer(provider)))

        expect(reason(error)).toBe("NotFound")
        expect(error.message).toContain(`${code} provider failure`)
        expect(error.reason.cause).toBe(failure)
      })
  )

  it.effect.each(["aborted", "unknown"] as const)(
    "maps provider code %s to the documented Unknown reason",
    (code) =>
      Effect.gen(function*() {
        const provider = RemoteChildProcessSpawner.TestRemote.make({
          scripts: {
            fail: {
              failure: new RemoteChildProcessSpawner.ProviderError({
                code,
                message: `${code} provider failure`
              })
            }
          }
        })

        const error = yield* (
          Effect.flip(
            Effect.flatMap(ChildProcessSpawner, (spawner) => spawner.string(ChildProcess.make("fail")))
          ).pipe(Effect.provide(RemoteChildProcessSpawner.layer(provider)))
        )

        expect(reason(error)).toBe("Unknown")
        expect(error.reason).toMatchObject({ module: "ChildProcess", method: "spawn" })
      })
  )

  it.effect.each(["stdout", "stderr"] as const)(
    "maps a provider %s stream failure after preserving earlier output",
    (output) =>
      Effect.gen(function*() {
        const providerFailure = new RemoteChildProcessSpawner.ProviderError({
          code: "unknown",
          message: `${output} stream disconnected`
        })
        const failedStream = Stream.concat(
          Stream.succeed(new TextEncoder().encode("before")),
          Stream.fail(providerFailure)
        )
        const provider = RemoteChildProcessSpawner.Provider.of({
          session: `failed-${output}`,
          open: () => Effect.void,
          spawn: () =>
            Effect.succeed({
              stdout: output === "stdout" ? failedStream : Stream.empty,
              stderr: output === "stderr" ? failedStream : Stream.empty,
              exitCode: Effect.succeed(0)
            })
        })

        const observed = yield* (
          Effect.gen(function*() {
            const spawner = yield* ChildProcessSpawner
            const handle = yield* spawner.spawn(ChildProcess.make("stream-failure"))
            const chunks: Array<string> = []
            const error = yield* Effect.flip(
              Stream.runForEach(handle[output], (chunk) =>
                Effect.sync(() => {
                  chunks.push(new TextDecoder().decode(chunk))
                }))
            )
            return { chunks, error }
          }).pipe(Effect.scoped, Effect.provide(RemoteChildProcessSpawner.layer(provider)))
        )

        expect(observed.chunks).toEqual(["before"])
        expect(reason(observed.error)).toBe("Unknown")
        expect(observed.error.reason).toMatchObject({ module: "ChildProcess", method: output })
      })
  )

  it.effect("maps an exitCode failure and then reports the handle as no longer running", () =>
    Effect.gen(function*() {
      const providerFailure = new RemoteChildProcessSpawner.ProviderError({
        code: "unknown",
        message: "remote process vanished"
      })
      const provider = RemoteChildProcessSpawner.Provider.of({
        session: "exit-failure",
        open: () => Effect.void,
        spawn: () =>
          Effect.succeed({
            stdout: Stream.empty,
            stderr: Stream.empty,
            exitCode: Effect.fail(providerFailure)
          })
      })

      const observed = yield* (
        Effect.gen(function*() {
          const spawner = yield* ChildProcessSpawner
          const handle = yield* spawner.spawn(ChildProcess.make("exit-failure"))
          const before = yield* handle.isRunning
          const error = yield* Effect.flip(handle.exitCode)
          yield* Effect.yieldNow
          const after = yield* handle.isRunning
          return { before, error, after }
        }).pipe(Effect.scoped, Effect.provide(RemoteChildProcessSpawner.layer(provider)))
      )

      expect(reason(observed.error)).toBe("Unknown")
      expect(observed.error.reason).toMatchObject({ module: "ChildProcess", method: "exitCode" })
      expect(observed.before).toBe(true)
      expect(observed.after).toBe(false)
    }))

  it.effect("provides a spawner that fails every command when opening the session fails", () =>
    Effect.gen(function*() {
      const provider = RemoteChildProcessSpawner.TestRemote.make({
        openFailure: new RemoteChildProcessSpawner.ProviderError({
          code: "unavailable",
          message: "provider session is unavailable"
        })
      })

      const errors = yield* (
        Effect.gen(function*() {
          const spawner = yield* ChildProcessSpawner
          return [
            yield* Effect.flip(spawner.string(ChildProcess.make("never-opened"))),
            // A stream must fail too, not hang on a queue nothing will ever end.
            yield* Effect.flip(Stream.runDrain(spawner.streamString(ChildProcess.make("never-opened"))))
          ]
        }).pipe(Effect.provide(RemoteChildProcessSpawner.layer(provider)))
      )

      expect(errors.map(reason)).toEqual(["NotFound", "NotFound"])
      expect(errors[0]?.message).toContain("`never-opened`: provider session is unavailable")
    }))

  it.effect("answers an unconfigured extra file descriptor the way a local spawner does", () =>
    Effect.gen(function*() {
      const provider = RemoteChildProcessSpawner.TestRemote.make({ scripts: { quiet: { stdout: "out" } } })

      const observed = yield* (
        Effect.gen(function*() {
          const spawner = yield* ChildProcessSpawner
          const handle = yield* spawner.spawn(ChildProcess.make("quiet"))
          return {
            // A descriptor nobody configured drains on the way in and is empty on
            // the way out — the same answer `NodeChildProcessSpawner` gives.
            written: yield* Stream.run(Stream.fromArray([new Uint8Array([1])]), handle.getInputFd(3)),
            read: yield* Stream.runCollect(handle.getOutputFd(3))
          }
        }).pipe(Effect.scoped, Effect.provide(RemoteChildProcessSpawner.layer(provider)))
      )

      expect(observed.written).toBeUndefined()
      expect(Array.from(observed.read)).toEqual([])
    }))

  it.effect("rejects stdin and kill instead of dropping them silently", () =>
    Effect.gen(function*() {
      const provider = RemoteChildProcessSpawner.TestRemote.make({ scripts: { quiet: {} } })

      const errors = yield* (
        Effect.gen(function*() {
          const spawner = yield* ChildProcessSpawner
          const handle = yield* spawner.spawn(ChildProcess.make("quiet"))
          return [
            yield* Effect.flip(Stream.run(Stream.fromArray([new Uint8Array([1])]), handle.stdin)),
            yield* Effect.flip(handle.kill())
          ]
        }).pipe(Effect.scoped, Effect.provide(RemoteChildProcessSpawner.layer(provider)))
      )

      expect(errors.map(reason)).toEqual(["BadArgument", "BadArgument"])
    }))

  it.effect("rejects command-supplied stdin before the provider starts", () =>
    Effect.gen(function*() {
      const provider = RemoteChildProcessSpawner.TestRemote.make({ scripts: { quiet: {} } })

      const error = yield* (
        Effect.flip(
          Effect.flatMap(ChildProcessSpawner, (spawner) =>
            spawner.exitCode(ChildProcess.make("quiet", [], {
              stdin: Stream.fromArray([new Uint8Array([1])])
            })))
        ).pipe(Effect.provide(RemoteChildProcessSpawner.layer(provider)))
      )

      expect(reason(error)).toBe("BadArgument")
      expect(error.message).toContain("cannot supply stdin")
      expect(provider.state.commands).toEqual([])
    }))

  it.effect("refuses to pretend a remote command inherited this process's standard input", () =>
    Effect.gen(function*() {
      // `"pipe"` and `"ignore"` are honest here: the handle's `stdin` sink
      // fails and the command reads EOF, which is what both mean locally.
      // `"inherit"` is not. A local spawner hands the child this process's own
      // standard input, and reading EOF instead would be a silent divergence.
      const provider = RemoteChildProcessSpawner.TestRemote.make({ stdin: true, scripts: { cat: {} } })

      const error = yield* Effect.flip(
        Effect.flatMap(
          ChildProcessSpawner,
          (spawner) => spawner.string(ChildProcess.make("cat", [], { stdin: "inherit" }))
        ).pipe(
          Effect.provide(RemoteChildProcessSpawner.layer(provider))
        )
      )
      expect(reason(error)).toBe("BadArgument")
      expect(error.message).toContain("cannot inherit this process's standard input")
      expect(provider.state.commands).toEqual([])

      // The same option inside a config, and inside a pipeline's leftmost
      // stage, are the same refusal.
      const inConfig = yield* Effect.flip(
        Effect.flatMap(
          ChildProcessSpawner,
          (spawner) => spawner.string(ChildProcess.make("cat", [], { stdin: { stream: "inherit" } }))
        ).pipe(
          Effect.provide(RemoteChildProcessSpawner.layer(provider))
        )
      )
      expect(inConfig.message).toContain("cannot inherit this process's standard input")

      // A later stage of a pipeline reads its predecessor, not this process,
      // so `"inherit"` there is not the divergence and is left alone.
      const piped = RemoteChildProcessSpawner.TestRemote.make({
        stdin: true,
        scripts: { "cat | wc": { stdout: "1" } }
      })
      const output = yield* Effect.flatMap(ChildProcessSpawner, (spawner) =>
        spawner.string(
          ChildProcess.make("cat").pipe(ChildProcess.pipeTo(ChildProcess.make("wc", [], { stdin: "inherit" })))
        )).pipe(Effect.provide(RemoteChildProcessSpawner.layer(piped)))
      expect(output).toBe("1")

      // And the other three options still run.
      for (const stream of ["pipe", "ignore", "overlapped"] as const) {
        yield* Effect.flatMap(
          ChildProcessSpawner,
          (spawner) => spawner.string(ChildProcess.make("cat", [], { stdin: stream }))
        ).pipe(
          Effect.provide(RemoteChildProcessSpawner.layer(provider))
        )
      }
      expect(provider.state.commands).toEqual(["cat", "cat", "cat"])
    }))

  it.effect("delivers command-supplied stdin whole when the provider declares it", () =>
    Effect.gen(function*() {
      const provider = RemoteChildProcessSpawner.TestRemote.make({
        stdin: true,
        scripts: { cat: { stdout: "echoed" } }
      })
      const output = yield* Effect.flatMap(ChildProcessSpawner, (spawner) =>
        spawner.string(
          ChildProcess.make("cat", [], {
            stdin: Stream.fromArray([new Uint8Array([1, 2]), new Uint8Array([3])])
          })
        )).pipe(Effect.provide(RemoteChildProcessSpawner.layer(provider)))
      expect(output).toBe("echoed")
      expect(Array.from(provider.state.inputs[0]!)).toEqual([1, 2, 3])
      // A command without input hands the provider none, and so does a
      // config whose stream is an OS option rather than data.
      yield* Effect.flatMap(ChildProcessSpawner, (spawner) => spawner.string(ChildProcess.make("cat"))).pipe(
        Effect.provide(RemoteChildProcessSpawner.layer(provider))
      )
      expect(provider.state.inputs[1]).toBeUndefined()
      yield* Effect.flatMap(ChildProcessSpawner, (spawner) =>
        spawner.string(ChildProcess.make("cat", [], { stdin: { stream: "pipe" } }))).pipe(
          Effect.provide(RemoteChildProcessSpawner.layer(provider))
        )
      expect(provider.state.inputs[2]).toBeUndefined()
    }))

  it.effect("feeds standard input to the first command of a pipeline only", () =>
    Effect.gen(function*() {
      const provider = RemoteChildProcessSpawner.TestRemote.make({
        stdin: true,
        scripts: { "cat | wc": { stdout: "3" } }
      })
      const accepted = yield* Effect.flatMap(ChildProcessSpawner, (spawner) =>
        spawner.string(
          ChildProcess.make("cat", [], { stdin: Stream.fromArray([new Uint8Array([7])]) }).pipe(
            ChildProcess.pipeTo(ChildProcess.make("wc"))
          )
        )).pipe(Effect.provide(RemoteChildProcessSpawner.layer(provider)))
      expect(accepted).toBe("3")
      expect(Array.from(provider.state.inputs[0]!)).toEqual([7])
      const error = yield* Effect.flip(
        Effect.flatMap(ChildProcessSpawner, (spawner) =>
          spawner.string(
            ChildProcess.make("cat").pipe(
              ChildProcess.pipeTo(ChildProcess.make("wc", [], { stdin: Stream.fromArray([new Uint8Array([7])]) }))
            )
          )).pipe(Effect.provide(RemoteChildProcessSpawner.layer(provider)))
      )
      expect(error.message).toContain("first command of a pipeline only")
    }))

  it.effect(
    "stops reading standard input at the bound instead of after the producer finishes",
    () =>
      Effect.gen(function*() {
        const provider = RemoteChildProcessSpawner.TestRemote.make({ stdin: true, scripts: { cat: {} } })
        const pulled = yield* Ref.make(0)
        const released = yield* Ref.make(false)
        // An endless producer. If the bound were checked after the fold, this
        // test would never return: the fold would keep growing the accumulator
        // until the heap ran out.
        const endless = Stream.forever(Stream.make(new Uint8Array(1024 * 1024))).pipe(
          Stream.tap(() => Ref.update(pulled, (n) => n + 1)),
          Stream.ensuring(Ref.set(released, true))
        )

        const error = yield* Effect.flip(
          Effect.flatMap(
            ChildProcessSpawner,
            (spawner) => spawner.string(ChildProcess.make("cat", [], { stdin: endless }))
          ).pipe(
            Effect.provide(RemoteChildProcessSpawner.layer(provider))
          )
        )

        expect(error.message).toContain("exceeds")
        // Seventeen mebibytes were pulled and no more: the sixteen that fit plus
        // the one that crossed the line and ended the read.
        expect(yield* Ref.get(pulled)).toBe(17)
        // The upstream producer's own cleanup ran on the early cutoff.
        expect(yield* Ref.get(released)).toBe(true)
        expect(provider.state.commands).toEqual([])
      }),
    30_000
  )

  // A producer that fills one buffer and emits it again is an ordinary shape
  // for a reader with a fixed read buffer, and the collector used to retain
  // the references and copy them only once the stream had ended, by which
  // time every retained reference named the same, last-written bytes: input
  // `[1, 2]` reached the provider as `[2, 2]`. The copy has to happen when the
  // chunk arrives, because that is the only moment its contents are the
  // caller's.
  for (const kind of ["Uint8Array", "Buffer"] as const) {
    it.effect(`copies each chunk as it arrives, so a reused ${kind} producer buffer is not corrupted`, () =>
      Effect.gen(function*() {
        const provider = RemoteChildProcessSpawner.TestRemote.make({ stdin: true, scripts: { cat: {} } })
        const scratch = kind === "Buffer" ? Buffer.alloc(1) : new Uint8Array(1)
        function* reused(): Generator<Uint8Array> {
          scratch[0] = 1
          yield scratch
          scratch[0] = 2
          yield scratch
        }

        yield* Effect.flatMap(ChildProcessSpawner, (spawner) =>
          spawner.string(
            ChildProcess.make("cat", [], { stdin: Stream.fromIterable(reused(), { chunkSize: 1 }) })
          )).pipe(Effect.provide(RemoteChildProcessSpawner.layer(provider)))

        expect(Array.from(provider.state.inputs[0]!)).toEqual([1, 2])
      }))
  }

  it.effect("accepts standard input of exactly the bound and refuses one byte more", () =>
    Effect.gen(function*() {
      const provider = RemoteChildProcessSpawner.TestRemote.make({ stdin: true, scripts: { cat: {} } })
      const bound = 16 * 1024 * 1024
      // Delivered in many small chunks, which is how a real producer arrives:
      // the accumulator is joined once at the end rather than recopied per
      // chunk, so this is linear rather than quadratic in the chunk count.
      const chunk = new Uint8Array(64 * 1024).fill(7)
      const parts = Array.from({ length: bound / chunk.length }, () => chunk)

      yield* Effect.flatMap(ChildProcessSpawner, (spawner) =>
        spawner.string(ChildProcess.make("cat", [], { stdin: Stream.fromArray(parts) }))).pipe(
          Effect.provide(RemoteChildProcessSpawner.layer(provider))
        )
      expect(provider.state.inputs[0]?.length).toBe(bound)
      expect(provider.state.inputs[0]?.at(-1)).toBe(7)

      const error = yield* Effect.flip(
        Effect.flatMap(ChildProcessSpawner, (spawner) =>
          spawner.string(
            ChildProcess.make("cat", [], { stdin: Stream.fromArray([...parts, new Uint8Array(1)]) })
          )).pipe(Effect.provide(RemoteChildProcessSpawner.layer(provider)))
      )
      expect(error.message).toContain("exceeds")
    }), 60_000)

  it.effect("refuses standard input beyond the bound and reports one it cannot read", () =>
    Effect.gen(function*() {
      const provider = RemoteChildProcessSpawner.TestRemote.make({ stdin: true, scripts: { cat: {} } })
      const oversize = yield* Effect.flip(
        Effect.flatMap(ChildProcessSpawner, (spawner) =>
          spawner.string(
            ChildProcess.make("cat", [], { stdin: Stream.make(new Uint8Array(16 * 1024 * 1024 + 1)) })
          )).pipe(Effect.provide(RemoteChildProcessSpawner.layer(provider)))
      )
      expect(oversize.message).toContain("exceeds")
      const unreadable = yield* Effect.flip(
        Effect.flatMap(ChildProcessSpawner, (spawner) =>
          spawner.string(
            ChildProcess.make("cat", [], {
              stdin: Stream.fail(
                PlatformError.badArgument({ module: "ChildProcess", method: "stdin", description: "torn" })
              )
            })
          )).pipe(
            Effect.provide(RemoteChildProcessSpawner.layer(provider))
          )
      )
      expect(reason(unreadable)).toBe("Unknown")
      expect(unreadable.message).toContain("could not be read")
      expect(provider.state.commands).toEqual([])
    }))

  it.effect("rejects command-supplied stdin inside a config", () =>
    Effect.gen(function*() {
      const provider = RemoteChildProcessSpawner.TestRemote.make({ scripts: { quiet: {} } })

      const error = yield* (
        Effect.flip(
          Effect.flatMap(ChildProcessSpawner, (spawner) =>
            spawner.exitCode(ChildProcess.make("quiet", [], {
              stdin: { stream: Stream.fromArray([new Uint8Array([1])]) }
            })))
        ).pipe(Effect.provide(RemoteChildProcessSpawner.layer(provider)))
      )

      expect(reason(error)).toBe("BadArgument")
      expect(provider.state.commands).toEqual([])
    }))

  it.effect.each<[string, ChildProcess.Command, string]>([
    [
      "a non-default pipe source",
      ChildProcess.pipeTo(ChildProcess.make("left"), ChildProcess.make("right"), { from: "stderr" }),
      "pipe from stderr"
    ],
    [
      "a non-default pipe destination",
      ChildProcess.pipeTo(ChildProcess.make("left"), ChildProcess.make("right"), { to: "fd3" }),
      "pipe to fd3"
    ],
    [
      "additional file descriptors",
      ChildProcess.make("quiet", [], { additionalFds: { fd3: { type: "output" } } }),
      "additional file descriptors"
    ],
    ["a custom shell", ChildProcess.make("quiet", [], { shell: "/bin/zsh" }), "requested shell"],
    ["a detached process", ChildProcess.make("quiet", [], { detached: true }), "detach"]
  ])("rejects %s instead of changing its meaning", ([_name, command, message]) =>
    Effect.gen(function*() {
      const provider = RemoteChildProcessSpawner.TestRemote.make({})

      const error = yield* (
        Effect.flip(Effect.flatMap(ChildProcessSpawner, (spawner) => spawner.exitCode(command))).pipe(
          Effect.provide(RemoteChildProcessSpawner.layer(provider))
        )
      )

      expect(reason(error)).toBe("BadArgument")
      expect(error.message).toContain(message)
      expect(provider.state.commands).toEqual([])
    }))

  it.effect.each<[string, ChildProcess.Command]>([
    [
      "the left side of an outer pipe",
      ChildProcess.pipeTo(
        ChildProcess.pipeTo(ChildProcess.make("left"), ChildProcess.make("middle"), { from: "stderr" }),
        ChildProcess.make("right")
      )
    ],
    [
      "the right side of an outer pipe",
      ChildProcess.pipeTo(
        ChildProcess.make("left"),
        ChildProcess.pipeTo(ChildProcess.make("middle"), ChildProcess.make("right"), { from: "stderr" })
      )
    ]
  ])("rejects an inner stderr pipe nested on %s", ([_position, command]) =>
    Effect.gen(function*() {
      const provider = RemoteChildProcessSpawner.TestRemote.make({})

      const error = yield* (
        Effect.flip(Effect.flatMap(ChildProcessSpawner, (spawner) => spawner.exitCode(command))).pipe(
          Effect.provide(RemoteChildProcessSpawner.layer(provider))
        )
      )

      expect(reason(error)).toBe("BadArgument")
      expect(error.message).toContain("pipe from stderr")
      expect(provider.state.commands).toEqual([])
    }))

  it.effect("honors output options and sinks", () =>
    Effect.gen(function*() {
      const provider = RemoteChildProcessSpawner.TestRemote.make({
        scripts: { noisy: { stdout: "out", stderr: "err" } }
      })
      const upper = Sink.map(
        Sink.collect<Uint8Array>(),
        (chunks) =>
          new TextEncoder().encode(
            chunks.map((chunk) => new TextDecoder().decode(chunk)).join("").toUpperCase()
          )
      )

      const observed = yield* (
        Effect.gen(function*() {
          const spawner = yield* ChildProcessSpawner
          const handle = yield* spawner.spawn(ChildProcess.make("noisy", [], {
            stdout: upper,
            stderr: { stream: "ignore" }
          }))
          return {
            stdout: yield* Stream.mkString(Stream.decodeText(handle.stdout)),
            stderr: yield* Stream.mkString(Stream.decodeText(handle.stderr))
          }
        }).pipe(Effect.scoped, Effect.provide(RemoteChildProcessSpawner.layer(provider)))
      )

      expect(observed).toEqual({ stdout: "OUT", stderr: "" })
    }))

  it.effect.each<[undefined | "pipe" | "overlapped" | "ignore" | "inherit", string]>([
    [undefined, "out"],
    ["pipe", "out"],
    ["overlapped", "out"],
    ["ignore", ""],
    ["inherit", ""]
  ])("honors the %s stdout option", ([stdout, expected]) =>
    Effect.gen(function*() {
      const provider = RemoteChildProcessSpawner.TestRemote.make({ scripts: { noisy: { stdout: "out" } } })

      const observed = yield* (
        Effect.flatMap(ChildProcessSpawner, (spawner) => spawner.string(ChildProcess.make("noisy", [], { stdout })))
          .pipe(
            Effect.provide(RemoteChildProcessSpawner.layer(provider))
          )
      )

      expect(observed).toBe(expected)
    }))

  it.effect("accepts explicit default pipeline routing and empty option objects", () =>
    Effect.gen(function*() {
      const provider = RemoteChildProcessSpawner.TestRemote.make({
        scripts: { "left | right": { stdout: "ok" } }
      })
      const command = ChildProcess.pipeTo(
        ChildProcess.make("left", [], { additionalFds: {}, stdin: "pipe" }),
        ChildProcess.make("right", [], { stdout: {}, stderr: {} }),
        { from: "stdout", to: "stdin" }
      )

      const output = yield* (
        Effect.flatMap(ChildProcessSpawner, (spawner) => spawner.string(command)).pipe(
          Effect.provide(RemoteChildProcessSpawner.layer(provider))
        )
      )

      expect(output).toBe("ok")
    }))
})

describe("RemoteChildProcessSpawner test double scripting", () => {
  it.effect("answers an unscripted command the way a shell reports a missing binary", () =>
    Effect.gen(function*() {
      const provider = RemoteChildProcessSpawner.TestRemote.make({ scripts: { other: {} } })

      const result = yield* (
        Effect.gen(function*() {
          const spawner = yield* ChildProcessSpawner
          const command = ChildProcess.make("nope")
          return {
            stderr: yield* Stream.mkString(spawner.streamString(command, { includeStderr: true })),
            exitCode: yield* spawner.exitCode(command)
          }
        }).pipe(Effect.provide(RemoteChildProcessSpawner.layer(provider)))
      )

      expect(result).toEqual({ stderr: "command not found: nope\n", exitCode: 127 })
    }))

  it.effect("answers a scripted command with no declared output as an empty success", () =>
    Effect.gen(function*() {
      const provider = RemoteChildProcessSpawner.TestRemote.make({ scripts: { quiet: {} } })

      const result = yield* (
        Effect.gen(function*() {
          const spawner = yield* ChildProcessSpawner
          const command = ChildProcess.make("quiet")
          return {
            stdout: yield* spawner.string(command),
            exitCode: yield* spawner.exitCode(command)
          }
        }).pipe(Effect.provide(RemoteChildProcessSpawner.layer(provider)))
      )

      expect(result).toEqual({ stdout: "", exitCode: 0 })
    }))

  it.effect("reports the process as running until its exit code arrives", () =>
    Effect.gen(function*() {
      const provider = RemoteChildProcessSpawner.TestRemote.make({ scripts: { quiet: { exitCode: 3 } } })

      const observed = yield* (
        Effect.gen(function*() {
          const spawner = yield* ChildProcessSpawner
          const handle = yield* spawner.spawn(ChildProcess.make("quiet"))
          const before = yield* handle.isRunning
          const exitCode = yield* handle.exitCode
          return { before, exitCode, after: yield* handle.isRunning }
        }).pipe(Effect.scoped, Effect.provide(RemoteChildProcessSpawner.layer(provider)))
      )

      expect(observed).toEqual({ before: true, exitCode: 3, after: false })
    }))
})

describe("RemoteChildProcessSpawner handle state", () => {
  it.effect("allocates concurrent handles independently while recording commands in call order", () =>
    Effect.gen(function*() {
      const provider = RemoteChildProcessSpawner.TestRemote.make({
        session: "concurrent-session",
        scripts: { first: {}, second: {} }
      })

      const pids = yield* (
        Effect.gen(function*() {
          const spawner = yield* ChildProcessSpawner
          const handles = yield* Effect.all([
            spawner.spawn(ChildProcess.make("first")),
            spawner.spawn(ChildProcess.make("second"))
          ], { concurrency: 2 })
          return handles.map((handle) => handle.pid)
        }).pipe(Effect.scoped, Effect.provide(RemoteChildProcessSpawner.layer(provider)))
      )

      expect(pids[0]).not.toBe(pids[1])
      expect(pids).toEqual([1, 2])
      expect(provider.state.openedSessions).toEqual(["concurrent-session"])
      expect(provider.state.commands).toEqual(["first", "second"])
    }))

  it.effect("does not share observable pid state between two spawner layers (D8)", () =>
    Effect.gen(function*() {
      // `layer.ts:117` was a module-level `let nextPid = 1`: process-global
      // mutable state in a repository whose rule is that host access goes
      // through a Layer. Two spawners in one process shared the counter, so a
      // handle's id depended on how many processes an unrelated spawner had
      // started — and on test ordering.
      const spawn = () =>
        Effect.gen(function*() {
          const spawner = yield* ChildProcessSpawner
          const first = yield* spawner.spawn(ChildProcess.make("greet"))
          const second = yield* spawner.spawn(ChildProcess.make("greet"))
          return [first.pid, second.pid]
        }).pipe(
          Effect.provide(
            RemoteChildProcessSpawner.layer(
              RemoteChildProcessSpawner.TestRemote.make({ scripts: { greet: { stdout: "hello" } } })
            )
          ),
          Effect.scoped
        )

      const left = yield* (spawn())
      const right = yield* (spawn())

      // Distinct handles within one spawner still get distinct ids.
      expect(left[0]).not.toBe(left[1])
      // And the second spawner starts over rather than continuing the first's
      // count, which is what "does not share state" means here.
      expect(right).toEqual(left)
    }))

  it.effect("reports isRunning false after the process exits without awaiting exitCode first", () =>
    Effect.gen(function*() {
      // The old `running` flag flipped only inside the handle's `exitCode`
      // effect, so a caller that never awaited it was told the process was still
      // running forever. A controlled provider lets the remote process exit
      // without consuming the handle's exit effect.
      const exited = Effect.runSync(Deferred.make<number>())
      const provider = RemoteChildProcessSpawner.Provider.of({
        session: "liveness",
        open: () => Effect.void,
        spawn: () =>
          Effect.succeed({
            stdout: Stream.empty,
            stderr: Stream.empty,
            exitCode: Deferred.await(exited)
          })
      })

      const observed = yield* (
        Effect.gen(function*() {
          const spawner = yield* ChildProcessSpawner
          const handle = yield* spawner.spawn(ChildProcess.make("greet"))
          const beforeExit = yield* handle.isRunning
          yield* Deferred.succeed(exited, 0)
          yield* Effect.yieldNow
          const afterExit = yield* handle.isRunning
          return { beforeExit, afterExit }
        }).pipe(Effect.provide(RemoteChildProcessSpawner.layer(provider)), Effect.scoped)
      )

      expect(observed.beforeExit).toBe(true)
      // No `handle.exitCode` await occurred. The adapter observes the provider's
      // completion in its own scoped fiber and updates liveness independently.
      expect(observed.afterExit).toBe(false)
    }))
})

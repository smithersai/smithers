import { describe, expect, it } from "@effect/vitest"
import type { JjError } from "@smthrs/jj"
import { Effect, PlatformError, Stream } from "effect"
import * as ChildProcess from "effect/process/ChildProcess"
import * as ChildProcessSpawner from "../src/ChildProcessSpawner.ts"
import * as Jj from "../src/Jj.vibe"

/**
 * The kernel stubs exist so a program can be wired without a host at all: an
 * unconfigured capability must answer, not vanish. Each stub inherits the Host
 * noop implementation, so the failure a caller sees is the host's "no such
 * capability here" error rather than a permission decision.
 */
describe("kernel stubs without any host", () => {
  it.effect("denies every derived spawner helper with a `NotFound` PlatformError naming the command", () =>
    Effect.gen(function*() {
      const command = ChildProcess.make("ls", ["-al"])
      const result = yield* (
        Effect.gen(function*() {
          const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
          return {
            string: yield* Effect.flip(spawner.string(command)),
            exitCode: yield* Effect.flip(spawner.exitCode(command)),
            streamed: yield* Effect.flip(Stream.runDrain(spawner.streamLines(command)))
          }
        }).pipe(Effect.provide(ChildProcessSpawner.layerNoop()))
      )

      for (const error of Object.values(result)) {
        expect(error).toBeInstanceOf(PlatformError.PlatformError)
        expect((error as PlatformError.PlatformError).reason._tag).toBe("NotFound")
        expect(error.message).toContain("no process host for `ls -al`")
      }
    }))

  it.effect("denies every jj operation with `not_installed`", () =>
    Effect.gen(function*() {
      const jj = Jj.makeNoop({})
      const errors = yield* (
        Effect.all([
          Effect.flip(jj.snapshot("m")),
          Effect.flip(jj.restore("abc")),
          Effect.flip(jj.diff("a", "b")),
          Effect.flip(jj.workspaceAdd("lane", "/tmp/lane")),
          Effect.flip(jj.workspaceForget("lane")),
          Effect.flip(jj.status())
        ])
      )

      expect(errors.map((error) => (error as JjError).code)).toEqual(Array.from({ length: 6 }, () => "not_installed"))
      expect(errors.map((error) => (error as JjError).method)).toEqual([
        "snapshot",
        "restore",
        "diff",
        "workspaceAdd",
        "workspaceForget",
        "status"
      ])
    }))

  it.effect("lets overrides replace individual methods while the rest stay denied", () =>
    Effect.gen(function*() {
      const command = ChildProcess.make("echo", ["hi"])
      const spawner = yield* (
        Effect.gen(function*() {
          const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
          return {
            ok: yield* spawner.string(command),
            denied: yield* Effect.flip(spawner.exitCode(command))
          }
        }).pipe(
          Effect.provide(ChildProcessSpawner.layerNoop({ string: () => Effect.succeed("hi") }))
        )
      )
      const jj = Jj.make(Jj.makeNoop({ status: () => Effect.succeed("clean") }))

      expect(spawner.ok).toBe("hi")
      expect((spawner.denied as PlatformError.PlatformError).reason._tag).toBe("NotFound")
      expect(yield* jj.status()).toBe("clean")
      expect(yield* Effect.flip(jj.snapshot())).toMatchObject({ code: "not_installed" })
    }))

  it.effect("derives the whole helper surface from the one `spawn` it is given", () =>
    Effect.gen(function*() {
      const command = ChildProcess.make("echo", ["hi"])
      const spawner = ChildProcessSpawner.make(() =>
        Effect.fail(
          PlatformError.systemError({
            _tag: "NotFound",
            module: "ChildProcessSpawner",
            method: "spawn",
            description: "derived"
          })
        )
      )
      const failure = yield* (Effect.flip(spawner.string(command)))
      expect((failure as PlatformError.PlatformError).reason._tag).toBe("NotFound")
      expect(failure.message).toContain("derived")
    }))
})

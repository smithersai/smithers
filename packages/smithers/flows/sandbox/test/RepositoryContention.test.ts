import { expect, it } from "@effect/vitest"
import { Effect, Fiber } from "effect"
import { TestClock } from "effect/testing"
import * as Remote from "../src/RemoteChildProcessSpawner/index.ts"
import { make } from "../src/SandboxMerge/Repository.vibe"

it.effect("returns shared lock contention immediately so no repository fence sleeps through retry", () =>
  Effect.gen(function*() {
    const remote = Remote.TestRemote.make({
      scripts: {
        "jj -R /repo --ignore-working-copy --no-pager --color=never log": {
          exitCode: 1,
          stderr: "cannot lock ref 'refs/heads/main': File exists"
        }
      }
    })
    const operation = Effect.gen(function*() {
      const repository = yield* make("/repo")
      return yield* Effect.flip(repository.jj(["log"]))
    }).pipe(Effect.provide(Remote.layer(remote)))
    const fiber = yield* Effect.forkChild(operation)
    yield* TestClock.adjust(0)
    const result = fiber.pollUnsafe()
    expect(result).toBeDefined()
    expect(remote.state.commands).toHaveLength(1)
    if (result !== undefined) {
      const error = yield* Fiber.join(fiber)
      expect(error.reason).toBe("vcs_failed")
      expect(error.message).toContain("cannot lock ref")
    }
    yield* Fiber.interrupt(fiber)
  }))

import { expect, it } from "@effect/vitest"
import { Deferred, Effect, Fiber } from "effect"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tempDirectory } from "./TempDirectory.ts"

for (const fails of [false, true]) {
  it.effect(`removes nested files when the test scope ${fails ? "fails" : "succeeds"}`, () =>
    Effect.gen(function*() {
      let path = ""
      yield* Effect.scoped(Effect.gen(function*() {
        path = yield* tempDirectory("flows-temp-cleanup-")
        mkdirSync(join(path, "nested"))
        writeFileSync(join(path, "nested", "state.sqlite"), "state")
        if (fails) yield* Effect.fail("test failure")
      })).pipe(Effect.exit)
      expect(path).not.toBe("")
      expect(existsSync(path)).toBe(false)
    }))
}

it.effect("removes the directory when its owner is interrupted", () =>
  Effect.gen(function*() {
    const ready = yield* Deferred.make<string>()
    const fiber = yield* Effect.scoped(Effect.gen(function*() {
      const path = yield* tempDirectory("flows-temp-cleanup-")
      yield* Deferred.succeed(ready, path)
      yield* Effect.never
    })).pipe(Effect.forkChild)
    const path = yield* Deferred.await(ready)
    expect(existsSync(path)).toBe(true)
    yield* Fiber.interrupt(fiber)
    expect(existsSync(path)).toBe(false)
  }))

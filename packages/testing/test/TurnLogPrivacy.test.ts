import { describe, expect, it } from "@effect/vitest"
import { NodeHost } from "@smthrs/platform-node"
import { Effect, PlatformError } from "effect"
import { link, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as TurnLog from "../src/TurnLog.ts"

describe("TurnLog private publication", () => {
  it.live("does not remember a turn when the private publication service fails", () =>
    Effect.gen(function*() {
      const native = yield* NodeHost.AtomicFileSystem.ownerPrivate
      const log = yield* TurnLog.make({ file: "turns.jsonl" }).pipe(Effect.provideService(
        NodeHost.AtomicFileSystem.ownerPrivate,
        {
          ...native,
          append: () =>
            Effect.fail(
              PlatformError.badArgument({ module: "FileSystem", method: "append", description: "faulty publication" })
            )
        }
      ))
      expect((yield* Effect.exit(log.record("chat", "not-published")))._tag).toBe("Failure")
      expect(yield* log.entries()).toEqual([])
    }))

  for (const kind of ["public", "symlink", "hardlink"] as const) {
    it.live(`refuses a ${kind} destination before publishing or remembering a turn`, () =>
      Effect.acquireUseRelease(
        Effect.promise(() => mkdtemp(join(tmpdir(), "turn-log-privacy-"))),
        (directory) =>
          Effect.gen(function*() {
            const original = join(directory, "original")
            const file = join(directory, "turns.jsonl")
            yield* Effect.promise(async () => {
              await writeFile(original, "retained\n", { mode: 0o600 })
              if (kind === "public") await writeFile(file, "retained\n", { mode: 0o644 })
              if (kind === "symlink") await symlink(original, file)
              if (kind === "hardlink") await link(original, file)
            })
            // Prove the same native service can publish before testing refusal.
            // A missing helper must fail this test, never count as privacy.
            const control = yield* TurnLog.make({ file: join(directory, "control.jsonl") })
            yield* control.record("chat", "control")
            expect(yield* Effect.promise(() => readFile(join(directory, "control.jsonl"), "utf8")))
              .toContain("\"step\":\"control\"")
            const log = yield* TurnLog.make({ file, messages: true })
            expect((yield* Effect.exit(log.record("chat", "secret")))._tag).toBe("Failure")
            expect(yield* log.entries()).toEqual([])
            expect(yield* Effect.promise(() => readFile(file, "utf8"))).toBe("retained\n")
            expect(yield* Effect.promise(() => readFile(original, "utf8"))).toBe("retained\n")
          }),
        (directory) => Effect.promise(() => rm(directory, { force: true, recursive: true }))
      ))
  }
})

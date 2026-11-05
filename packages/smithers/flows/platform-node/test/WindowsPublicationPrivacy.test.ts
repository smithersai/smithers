import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as AtomicFileSystem from "../src/AtomicFileSystem.ts"

// Platform-independent publication behavior. Native Windows unit tests perform
// a real read using an anonymous token, with a readable positive control.
describe("owner-private publication", () => {
  it.live("durably appends and refuses an existing file without private protection", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => mkdtemp(join(tmpdir(), "private-publication-"))),
      (root) =>
        Effect.gen(function*() {
          const owner = yield* AtomicFileSystem.ownerPrivate
          const file = join(root, "turns.jsonl")
          yield* owner.append(file, "first\n")
          yield* owner.append(file, "second\n")
          expect(yield* Effect.promise(() => readFile(file, "utf8"))).toBe("first\nsecond\n")
          if (process.platform !== "win32") {
            expect((yield* Effect.promise(() => stat(file))).mode & 0o777).toBe(0o600)
          }
          const broad = join(root, "broad")
          yield* Effect.promise(() => writeFile(broad, "retained", { mode: 0o644 }))
          expect((yield* Effect.exit(owner.append(broad, "secret")))._tag).toBe("Failure")
          expect(yield* Effect.promise(() => readFile(broad, "utf8"))).toBe("retained")
          expect((yield* Effect.exit(owner.append(join(root, "missing", "turns"), "secret")))._tag).toBe("Failure")
        }),
      (root) => Effect.promise(() => rm(root, { recursive: true, force: true }))
    ))
})

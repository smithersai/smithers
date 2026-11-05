import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
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
  it.live("publishes complete private snapshots and refuses paths outside the trusted root", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => mkdtemp(join(tmpdir(), "private-snapshot-"))),
      (root) =>
        Effect.gen(function*() {
          const owner = yield* AtomicFileSystem.ownerPrivate
          const directory = join(root, "report", "backup")
          const destination = join(directory, "snapshot")
          yield* owner.directory(root, directory)
          yield* owner.write(root, destination, new TextEncoder().encode("old complete snapshot"))
          yield* owner.write(root, destination, new TextEncoder().encode("new complete snapshot"))
          expect(yield* Effect.promise(() => readFile(destination, "utf8"))).toBe("new complete snapshot")
          if (process.platform !== "win32") {
            expect((yield* Effect.promise(() => stat(directory))).mode & 0o777).toBe(0o700)
            expect((yield* Effect.promise(() => stat(destination))).mode & 0o777).toBe(0o600)
          }
          for (const target of [root, dirname(root), join(dirname(root), "outside")]) {
            expect((yield* Effect.exit(owner.directory(root, target)))._tag).toBe("Failure")
            expect((yield* Effect.exit(owner.write(root, target, new Uint8Array())))._tag).toBe("Failure")
          }
          expect((yield* Effect.exit(owner.directory(join(root, "missing"), join(root, "missing", "child"))))._tag)
            .toBe("Failure")
        }),
      (root) => Effect.promise(() => rm(root, { recursive: true, force: true }))
    ))
})

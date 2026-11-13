import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { execFileSync } from "node:child_process"
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import * as AtomicFileSystem from "../src/AtomicFileSystem.ts"
import { assertPrivatePath } from "./helpers/assertPrivatePath.ts"

// Check POSIX modes or the native Windows ACL for every published path.
describe("owner-private publication", () => {
  it.live("detects a directory whose permissions were broadened after private publication", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => mkdtemp(join(tmpdir(), "private-directory-"))),
      (root) =>
        Effect.gen(function*() {
          const owner = yield* AtomicFileSystem.ownerPrivate
          const directory = join(root, "private")
          yield* owner.directory(root, directory)
          assertPrivatePath(directory)
          if (process.platform === "win32") {
            execFileSync("icacls", [directory, "/grant", "*S-1-1-0:(R)"], { stdio: "pipe", timeout: 10_000 })
          } else {
            yield* Effect.promise(() => chmod(directory, 0o755))
          }
          expect(() => assertPrivatePath(directory)).toThrow()
        }),
      (root) => Effect.promise(() => rm(root, { recursive: true, force: true }))
    ))

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
          assertPrivatePath(file)
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
          assertPrivatePath(directory)
          assertPrivatePath(destination)
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

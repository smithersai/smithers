import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as NodePath from "@effect/platform-node/NodePath"
import { describe, expect, it } from "@effect/vitest"
import { ArtifactStore } from "@smthrs/artifacts"
import { Effect, FileSystem, Path, PlatformError } from "effect"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as AtomicFileSystem from "../src/AtomicFileSystem.ts"

describe("required directory publication", () => {
  it.live("propagates native publication refusal from an opened directory", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => mkdtemp(join(tmpdir(), "directory-publication-"))),
      (root) =>
        Effect.gen(function*() {
          const fs = yield* FileSystem.FileSystem
          const owner = yield* AtomicFileSystem.ownerPrivate
          const denied = PlatformError.badArgument({
            module: "AtomicFileSystem",
            method: "syncDirectory",
            description: "faulty required publication"
          })
          const outcome = yield* Effect.scoped(Effect.gen(function*() {
            const directory = yield* fs.open(root, { flag: "r" })
            return yield* directory.sync
          })).pipe(
            Effect.exit,
            Effect.provideService(AtomicFileSystem.ownerPrivate, { ...owner, syncDirectory: () => Effect.fail(denied) })
          )
          expect(outcome._tag).toBe("Failure")
        }),
      (root) => Effect.promise(() => rm(root, { force: true, recursive: true }))
    ).pipe(Effect.provide(AtomicFileSystem.layer)))
  it.live("syncs a real directory and refuses substitution after open", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => mkdtemp(join(tmpdir(), "directory-identity-"))),
      (root) =>
        Effect.scoped(Effect.gen(function*() {
          const fs = yield* FileSystem.FileSystem
          const child = join(root, "child")
          yield* fs.makeDirectory(child)
          const file = yield* fs.open(child, { flag: "r" })
          yield* file.sync
          // Rename the opened directory, then put another inode at its old name.
          // Windows pins deletion as well; either refusal is a safe result.
          const renamed = yield* Effect.exit(fs.rename(child, join(root, "old")))
          if (renamed._tag === "Success") {
            yield* fs.makeDirectory(child)
            expect((yield* Effect.exit(file.sync))._tag).toBe("Failure")
          } else {
            expect(yield* fs.exists(join(root, "old"))).toBe(false)
            yield* file.sync
          }
        })),
      (root) => Effect.promise(() => rm(root, { recursive: true, force: true }))
    ).pipe(Effect.provide(AtomicFileSystem.layer)))
  it.live("reopens required-durability artifacts and propagates an ancestor sync refusal", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => mkdtemp(join(tmpdir(), "required-artifacts-"))),
      (root) =>
        Effect.gen(function*() {
          const fs = yield* FileSystem.FileSystem
          const path = yield* Path.Path
          const options = { directory: join(root, "objects"), durability: "required" as const }
          const bytes = new TextEncoder().encode("complete durable artifact")
          const digest = yield* ArtifactStore.makeFileSystem(fs, path, options).put(bytes)
          const reopened = ArtifactStore.makeFileSystem(fs, path, options)
          expect(Array.from(yield* reopened.get(digest))).toEqual(Array.from(bytes))
          const owner = yield* AtomicFileSystem.ownerPrivate
          const failure = PlatformError.badArgument({
            module: "AtomicFileSystem",
            method: "syncDirectory",
            description: "faulty required ancestor sync"
          })
          const faulty = { ...owner, syncDirectory: () => Effect.fail(failure) }
          // Dedupe must still sync the ancestry; a present blob is not a durable receipt.
          expect(
            (yield* Effect.exit(
              reopened.put(bytes).pipe(
                Effect.provideService(AtomicFileSystem.ownerPrivate, faulty)
              )
            ))._tag
          ).toBe("Failure")
          expect(Array.from(yield* ArtifactStore.makeFileSystem(fs, path, options).get(digest))).toEqual(
            Array.from(bytes)
          )
        }),
      (root) => Effect.promise(() => rm(root, { recursive: true, force: true }))
    ).pipe(Effect.provide([AtomicFileSystem.layer, NodePath.layer, NodeCrypto.layer])))
})

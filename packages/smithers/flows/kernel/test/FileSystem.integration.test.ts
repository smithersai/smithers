import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import { afterEach, describe, expect, it } from "@effect/vitest"
import { CapabilityPattern } from "@smthrs/capability/Capability"
import { Rule } from "@smthrs/capability/Permission"
import { Effect, Fiber, FileSystem as EffectFileSystem, Layer } from "effect"
import { mkdir, mkdtemp, readFile, rename, rm, symlink, unlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as FileSystem from "../src/FileSystem.ts"
import * as GrantStore from "../src/GrantStore.ts"
import * as Workspace from "../src/Workspace.ts"

const directories = new Set<string>()

const temporaryDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), "flows-kernel-fs-"))
  directories.add(directory)
  return directory
}

afterEach(async () => {
  await Promise.all([...directories].map((directory) => rm(directory, { recursive: true, force: true })))
  directories.clear()
})

const awaitPending = (store: GrantStore.Service): Effect.Effect<GrantStore.PendingRequest> =>
  Effect.suspend(() =>
    Effect.flatMap(store.list, (pending) =>
      pending[0] === undefined
        ? Effect.yieldNow.pipe(Effect.andThen(awaitPending(store)))
        : Effect.succeed(pending[0]))
  )

/**
 * The real Node filesystem attested as an isolated volume. The kernel must
 * not depend on a platform package, and the in-memory browser volume has no
 * symlinks or renames, so this is the host tier a native isolated volume
 * would declare — path-delegating `execute`/`open`, real rename and symlink
 * semantics to race against. It is exactly the tier where the kernel's OWN
 * check-to-use guards are the only thing standing between an authorization
 * and a swapped-out resource: production Node hosts declare the
 * descriptor-relative executor instead and never this attestation.
 */
const isolatedHostLayer = Layer.effect(
  EffectFileSystem.FileSystem,
  Effect.map(EffectFileSystem.FileSystem, FileSystem.withIsolatedFileSystem)
).pipe(Layer.provide(NodeFileSystem.layer))

const withGuardedFileSystem = <A, E>(
  workspaceRoot: string,
  options: GrantStore.MakeOptions,
  use: (store: GrantStore.Service) => Effect.Effect<A, E, EffectFileSystem.FileSystem>
) =>
  Effect.scoped(
    Effect.gen(function*() {
      const store = yield* GrantStore.make(options)
      return yield* use(store).pipe(
        Effect.provide(FileSystem.layer),
        Effect.provide(isolatedHostLayer),
        Effect.provide(NodePath.layer),
        Effect.provideService(GrantStore.GrantStore, store)
      )
    })
  ).pipe(Effect.provide(Workspace.layer(workspaceRoot)))

const workspaceRules = (workspace: string): GrantStore.MakeOptions => ({
  attended: false,
  rules: [
    new Rule({ effect: "allow", pattern: new CapabilityPattern({ action: "fs:*", resource: join(workspace, "**") }) })
  ]
})

describe("FileSystem real host confinement", () => {
  // The attended grant suspends the asking fiber, and the delegate would open
  // the logical path only after approval. The guard therefore resolves the
  // capability resource again once the decision arrives and refuses when the
  // path no longer names what was authorized, so a symlink swapped in during
  // the wait is refused, never followed.
  it.effect("does not follow a symlink swapped in while an attended write is pending", () =>
    Effect.gen(function*() {
      const directory = yield* Effect.promise(() => temporaryDirectory())
      const workspace = join(directory, "workspace")
      const outside = join(directory, "outside")
      const target = join(workspace, "target.txt")
      const original = join(workspace, "original.txt")
      const secret = join(outside, "secret.txt")
      yield* Effect.promise(() => mkdir(workspace))
      yield* Effect.promise(() => mkdir(outside))
      yield* Effect.promise(() => writeFile(target, "inside", "utf8"))
      yield* Effect.promise(() => writeFile(secret, "outside-original", "utf8"))

      const outcome = yield* (
        withGuardedFileSystem(workspace, {}, (store) =>
          Effect.gen(function*() {
            const fileSystem = yield* EffectFileSystem.FileSystem
            const write = yield* Effect.result(fileSystem.writeFileString(target, "attacker-data")).pipe(
              Effect.forkChild({ startImmediately: true })
            )
            const pending = yield* awaitPending(store)
            expect(pending.capability).toMatchObject({ action: "fs:write", resource: target })

            yield* Effect.promise(() => rename(target, original))
            yield* Effect.promise(() => symlink(secret, target))
            yield* store.reply(pending.requestId, "once")
            return yield* Fiber.join(write)
          }))
      )

      expect(outcome._tag).toBe("Failure")
      expect(yield* Effect.promise(() => readFile(secret, "utf8"))).toBe("outside-original")
    }))

  // `open` fstats the handle it authorized and binds that `device:inode`
  // identity. Rechecking the pathname alone would authorize the REPLACEMENT
  // file and then delegate to the OLD descriptor, whose inode has left the
  // workspace; the identity verification refuses instead.
  it.effect("does not authorize an old descriptor by rechecking a rebound pathname", () =>
    Effect.gen(function*() {
      const directory = yield* Effect.promise(() => temporaryDirectory())
      const workspace = join(directory, "workspace")
      const outside = join(directory, "outside")
      const target = join(workspace, "bound.txt")
      const moved = join(outside, "moved.txt")
      yield* Effect.promise(() => mkdir(workspace))
      yield* Effect.promise(() => mkdir(outside))
      yield* Effect.promise(() => writeFile(target, "inside-original", "utf8"))

      const outcome = yield* (
        withGuardedFileSystem(workspace, workspaceRules(workspace), () =>
          Effect.scoped(
            Effect.gen(function*() {
              const fileSystem = yield* EffectFileSystem.FileSystem
              const file = yield* fileSystem.open(target, { flag: "r+" })
              yield* Effect.promise(() => rename(target, moved))
              yield* Effect.promise(() => writeFile(target, "replacement", "utf8"))
              return yield* Effect.result(file.writeAll(new TextEncoder().encode("mutated")))
            })
          ))
      )

      expect(outcome._tag).toBe("Failure")
      expect(yield* Effect.promise(() => readFile(moved, "utf8"))).toBe("inside-original")
      yield* Effect.promise(() => unlink(target))
    }))

  // The identity binding must not refuse the benign case: while the
  // authorized path still names the opened inode, handle reads and writes
  // proceed.
  it.effect("performs handle operations while the descriptor still names the authorized path", () =>
    Effect.gen(function*() {
      const directory = yield* Effect.promise(() => temporaryDirectory())
      const workspace = join(directory, "workspace")
      const target = join(workspace, "steady.txt")
      yield* Effect.promise(() => mkdir(workspace))
      yield* Effect.promise(() => writeFile(target, "inside-original", "utf8"))

      yield* (
        withGuardedFileSystem(workspace, workspaceRules(workspace), () =>
          Effect.scoped(
            Effect.gen(function*() {
              const fileSystem = yield* EffectFileSystem.FileSystem
              const file = yield* fileSystem.open(target, { flag: "r+" })
              const info = yield* file.stat
              expect(info.type).toBe("File")
              yield* file.writeAll(new TextEncoder().encode("mutated"))
            })
          ))
      )

      expect(yield* Effect.promise(() => readFile(target, "utf8"))).toBe("mutatedoriginal")
    }))

  // Once the path is unlinked there is no resource at the authorized name at
  // all, so both the read and the write side of the handle refuse.
  it.effect("refuses handle operations after the authorized path is unlinked", () =>
    Effect.gen(function*() {
      const directory = yield* Effect.promise(() => temporaryDirectory())
      const workspace = join(directory, "workspace")
      const target = join(workspace, "unlinked.txt")
      yield* Effect.promise(() => mkdir(workspace))
      yield* Effect.promise(() => writeFile(target, "inside-original", "utf8"))

      const [written, read] = yield* (
        withGuardedFileSystem(workspace, workspaceRules(workspace), () =>
          Effect.scoped(
            Effect.gen(function*() {
              const fileSystem = yield* EffectFileSystem.FileSystem
              const file = yield* fileSystem.open(target, { flag: "r+" })
              yield* Effect.promise(() => unlink(target))
              const written = yield* Effect.result(file.writeAll(new TextEncoder().encode("mutated")))
              const read = yield* Effect.result(file.readAlloc(1))
              return [written, read] as const
            })
          ))
      )

      expect(written._tag).toBe("Failure")
      expect(read._tag).toBe("Failure")
    }))

  // A directory swapped in at the authorized path is not the bound resource
  // either: the identity verification sees a non-file occupant and refuses
  // the old descriptor.
  it.effect("refuses an old descriptor when a directory occupies its authorized path", () =>
    Effect.gen(function*() {
      const directory = yield* Effect.promise(() => temporaryDirectory())
      const workspace = join(directory, "workspace")
      const outside = join(directory, "outside")
      const target = join(workspace, "occupied.txt")
      const moved = join(outside, "moved.txt")
      yield* Effect.promise(() => mkdir(workspace))
      yield* Effect.promise(() => mkdir(outside))
      yield* Effect.promise(() => writeFile(target, "inside-original", "utf8"))

      const outcome = yield* (
        withGuardedFileSystem(workspace, workspaceRules(workspace), () =>
          Effect.scoped(
            Effect.gen(function*() {
              const fileSystem = yield* EffectFileSystem.FileSystem
              const file = yield* fileSystem.open(target, { flag: "r+" })
              yield* Effect.promise(() => rename(target, moved))
              yield* Effect.promise(() => mkdir(target))
              return yield* Effect.result(file.writeAll(new TextEncoder().encode("mutated")))
            })
          ))
      )

      expect(outcome._tag).toBe("Failure")
      expect(yield* Effect.promise(() => readFile(moved, "utf8"))).toBe("inside-original")
    }))
})

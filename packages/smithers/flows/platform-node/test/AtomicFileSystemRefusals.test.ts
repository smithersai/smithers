/**
 * Adversarial refusal probes over the full kernel + atomic adapter stack.
 *
 * Each case names a way an attacker (or an unlucky workspace) could try to
 * reach outside the pinned root, and asserts the adapter refuses with a typed
 * `PlatformError` while the outside target stays untouched. They complement
 * `AtomicFileSystem.test.ts`, which pins the swap races and the operation
 * semantics; this file pins the documented confinement refusals end to end.
 */
// Every case here runs on real elapsed time — subprocess spawns, file locks,
// mtimes, and poll loops — so the suite uses `it.live`; `it.effect`'s
// TestClock never advances for them.

import * as NodePath from "@effect/platform-node/NodePath"
import { afterEach, describe, expect, it } from "@effect/vitest"
import * as KernelFileSystem from "@smthrs/kernel/FileSystem"
import * as GrantStore from "@smthrs/kernel/GrantStore"
import * as Workspace from "@smthrs/kernel/Workspace"
import { Effect, FileSystem, Layer } from "effect"
import { link, mkdir, mkdtemp, readlink, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as AtomicFileSystem from "../src/AtomicFileSystem.ts"

const directories = new Set<string>()

const temporaryDirectory = async () => {
  const directory = await mkdtemp(join(tmpdir(), "flows-audit-probe-"))
  directories.add(directory)
  return directory
}

afterEach(async () => {
  await Promise.all([...directories].map((directory) => rm(directory, { recursive: true, force: true })))
  directories.clear()
})

const guarded = (root: string) =>
  KernelFileSystem.layer.pipe(
    Layer.provide(AtomicFileSystem.layer),
    Layer.provide(NodePath.layer),
    Layer.provide(Workspace.layer(root)),
    Layer.provide(GrantStore.layerNoop)
  )

const run = <A, E>(root: string, effect: Effect.Effect<A, E, FileSystem.FileSystem>) =>
  effect.pipe(Effect.provide(guarded(root)))

describe("audit probes", () => {
  it.live("refuses to read or append to a hard-linked file", () =>
    Effect.gen(function*() {
      const container = yield* Effect.promise(() => temporaryDirectory())
      const root = join(container, "workspace")
      yield* Effect.promise(() => mkdir(root))
      const victim = join(container, "victim.txt")
      yield* Effect.promise(() => writeFile(victim, "outside"))
      yield* Effect.promise(() => link(victim, join(root, "linked.txt")))
      const read = yield* run(
        root,
        Effect.flip(Effect.flatMap(FileSystem.FileSystem, (fs) => fs.readFileString(join(root, "linked.txt"))))
      )
      expect(read._tag).toBe("PlatformError")
      const append = yield* run(
        root,
        Effect.flip(
          Effect.flatMap(
            FileSystem.FileSystem,
            (fs) => fs.writeFileString(join(root, "linked.txt"), "x", { flag: "a" })
          )
        )
      )
      expect(append._tag).toBe("PlatformError")
    }))

  it.live("refuses to remove a symlink and leaves its target untouched", () =>
    Effect.gen(function*() {
      const container = yield* Effect.promise(() => temporaryDirectory())
      const root = join(container, "workspace")
      const outside = join(container, "outside")
      yield* Effect.promise(() => mkdir(root))
      yield* Effect.promise(() => mkdir(outside))
      yield* Effect.promise(() => writeFile(join(outside, "kept.txt"), "kept"))
      yield* Effect.promise(() => symlink(outside, join(root, "escape")))
      const direct = yield* run(
        root,
        Effect.flip(Effect.flatMap(FileSystem.FileSystem, (fs) => fs.remove(join(root, "escape"))))
      )
      expect(direct._tag).toBe("PlatformError")
      // The link itself must still exist: refusal, not silent unlink.
      expect(yield* Effect.promise(() => readlink(join(root, "escape")))).toBe(outside)
      // A recursive remove of a directory containing a symlink is refused too,
      // and the outside target survives.
      yield* Effect.promise(() => mkdir(join(root, "tree")))
      yield* Effect.promise(() => symlink(outside, join(root, "tree", "escape")))
      const recursive = yield* run(
        root,
        Effect.flip(
          Effect.flatMap(FileSystem.FileSystem, (fs) => fs.remove(join(root, "tree"), { recursive: true }))
        )
      )
      expect(recursive._tag).toBe("PlatformError")
      expect(yield* Effect.promise(() => readlink(join(root, "tree", "escape")))).toBe(outside)
    }), 30_000)

  it.live("fails closed, without crashing, on a pathological deep removal", () =>
    Effect.gen(function*() {
      const container = yield* Effect.promise(() => temporaryDirectory())
      const root = join(container, "workspace")
      yield* Effect.promise(() => mkdir(root))
      let current = join(root, "deep")
      yield* Effect.promise(() => mkdir(current))
      // As deep as macOS PATH_MAX lets a native harness construct.
      for (let index = 0; index < 400; index++) {
        current = join(current, "d")
        yield* Effect.promise(() => mkdir(current))
      }
      const result = yield* run(
        root,
        Effect.exit(
          Effect.flatMap(FileSystem.FileSystem, (fs) => fs.remove(join(root, "deep"), { recursive: true }))
        )
      )
      // Either outcome is contractual as long as it is a typed failure or a
      // success, never a defect or a hung/killed helper.
      expect(result._tag === "Success" || result._tag === "Failure").toBe(true)
      if (result._tag === "Failure") {
        expect(String(result.cause)).toContain("PlatformError")
      }
    }))

  it.live("reports a broken symlink as a typed refusal for exists", () =>
    Effect.gen(function*() {
      const container = yield* Effect.promise(() => temporaryDirectory())
      const root = join(container, "workspace")
      yield* Effect.promise(() => mkdir(root))
      yield* Effect.promise(() => symlink(join(container, "gone"), join(root, "dangling")))
      const result = yield* run(
        root,
        Effect.exit(Effect.flatMap(FileSystem.FileSystem, (fs) => fs.exists(join(root, "dangling"))))
      )
      // Fail-closed is acceptable; returning true would not be. A plain false is
      // also acceptable (the entry is not an addressable file).
      if (result._tag === "Success") {
        expect(result.value).toBe(false)
      } else {
        expect(String(result.cause)).toContain("PlatformError")
      }
    }))

  it.live("keeps rename inside the boundary when the destination parent is a symlink", () =>
    Effect.gen(function*() {
      const container = yield* Effect.promise(() => temporaryDirectory())
      const root = join(container, "workspace")
      const outside = join(container, "outside")
      yield* Effect.promise(() => mkdir(root))
      yield* Effect.promise(() => mkdir(outside))
      yield* Effect.promise(() => writeFile(join(root, "moved.txt"), "payload"))
      yield* Effect.promise(() => symlink(outside, join(root, "portal")))
      const result = yield* run(
        root,
        Effect.flip(
          Effect.flatMap(
            FileSystem.FileSystem,
            (fs) => fs.rename(join(root, "moved.txt"), join(root, "portal", "moved.txt"))
          )
        )
      )
      expect(result._tag).toBe("PlatformError")
      // Nothing may appear outside the boundary.
      const escaped = yield* run(
        outside,
        Effect.flatMap(FileSystem.FileSystem, (fs) => fs.exists(join(outside, "moved.txt")))
      )
      expect(escaped).toBe(false)
    }))
})

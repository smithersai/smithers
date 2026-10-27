/**
 * The barrel and the aggregate layer. `BrowserServices.layer` has no behaviour
 * of its own, so the assertion is that every tag it promises is present and
 * that the spawner it wires up is the one talking to the filesystem it wires
 * up — the failure mode the function signature exists to prevent.
 */
import { describe, expect, it } from "@effect/vitest"
import * as KernelFileSystem from "@smthrs/kernel/FileSystem"
import { Effect, FileSystem, Path } from "effect"
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner"
import * as NodeFsPromises from "node:fs/promises"
import * as BrowserChildProcessSpawner from "../src/BrowserChildProcessSpawner/index.ts"
import * as BrowserFileSystem from "../src/BrowserFileSystem/index.ts"
import * as BrowserHost from "../src/BrowserHost.ts"
import * as BrowserServices from "../src/BrowserServices.ts"
import * as Index from "../src/index.ts"

const bash: BrowserChildProcessSpawner.JustBashLike = {
  exec: async (commandLine) => ({ stdout: commandLine, stderr: "", exitCode: 0 })
}

describe("@smthrs/platform-browser barrel", () => {
  it("re-exports every module as a namespace", () => {
    expect(Object.keys(Index).sort()).toEqual(
      [
        "BrowserCache",
        "BrowserChildProcessSpawner",
        "BrowserEngine",
        "BrowserFileSystem",
        "BrowserHost",
        "BrowserLanguageServer",
        "BrowserRuntime",
        "BrowserScheduler",
        "BrowserServices",
        "BrowserSqlite",
        "PendingSnapshot",
        "SharedSqlite",
        "StoragePersistence",
        "TabChannel",
        "TerminalSocket",
        "WebLock"
      ].sort()
    )
    expect(Index.BrowserChildProcessSpawner.layer).toBe(BrowserChildProcessSpawner.layer)
    expect(Index.BrowserFileSystem.layer).toBe(BrowserFileSystem.layer)
    expect(Index.BrowserHost.layer).toBe(BrowserHost.layer)
    expect(Index.BrowserServices.layer).toBe(BrowserServices.layer)
  })

  /** Both adapters expose a constructor beside their layer, not one each. */
  it("exposes `make` on both adapters", () => {
    expect(typeof Index.BrowserFileSystem.make).toBe("function")
    expect(Index.BrowserChildProcessSpawner.make).toBe(BrowserChildProcessSpawner.make)
  })
})

describe("BrowserFileSystem kernel attestation", () => {
  /**
   * `layer` attests to `@smthrs/kernel` that the volume behind `fs` cannot
   * address anything outside itself, which is what lets the guarded surface
   * resolve paths directly. `make` makes no such claim. Nothing else pins the
   * difference, so deleting the attestation from `layer` would break no test.
   */
  it.effect("attests whole-filesystem isolation on `layer` and not on `make`", () =>
    Effect.gen(function*() {
      const attested = yield* Effect.provide(FileSystem.FileSystem, BrowserFileSystem.layer(NodeFsPromises))
      const bare = BrowserFileSystem.make(NodeFsPromises)

      expect(Object.getOwnPropertySymbols(attested)).toContain(KernelFileSystem.AtomicFileSystemTypeId)
      expect(Object.getOwnPropertySymbols(bare)).not.toContain(KernelFileSystem.AtomicFileSystemTypeId)
    }))
})

describe("BrowserServices", () => {
  it.effect("provides the spawner, the filesystem, and the path service from one layer", () =>
    Effect.gen(function*() {
      const services = yield* (
        Effect.gen(function*() {
          const spawner = yield* ChildProcessSpawner
          const fs = yield* FileSystem.FileSystem
          const path = yield* Path.Path
          return {
            spawned: typeof spawner.spawn,
            exists: yield* fs.exists("/definitely-not-a-real-path"),
            normalized: path.normalize("/a/./b/../c")
          }
        }).pipe(Effect.provide(BrowserServices.layer({ bash, fs: NodeFsPromises })))
      )

      expect(services).toEqual({ spawned: "function", exists: false, normalized: "/a/c" })
    }))
})

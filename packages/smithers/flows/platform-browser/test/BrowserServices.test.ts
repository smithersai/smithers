import { describe, expect, it } from "@effect/vitest"
import * as KernelFileSystem from "@smthrs/kernel/FileSystem"
import { Effect, FileSystem, Path } from "effect"
import { ChildProcess } from "effect/process"
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner"
import * as BrowserServices from "../src/BrowserServices.ts"
import * as ZenFsMount from "./fixtures/ZenFsMount.ts"

const services = Effect.gen(function*() {
  return {
    fileSystem: yield* FileSystem.FileSystem,
    path: yield* Path.Path,
    spawner: yield* ChildProcessSpawner
  }
})

describe("BrowserServices isolation root", () => {
  it.effect.each([undefined, "/"])("builds with workspaceRoot %s", (workspaceRoot) =>
    Effect.gen(function*() {
      const mount = yield* Effect.promise(() => ZenFsMount.mount())
      const built = yield* services.pipe(Effect.provide(BrowserServices.layer({
        bash: mount.bash,
        fs: mount.fs.promises,
        ...(workspaceRoot === undefined ? {} : { workspaceRoot })
      })))
      expect(typeof built.spawner.spawn).toBe("function")
      expect(built.path.normalize("/repo/..")).toBe("/")
      expect(
        (built.fileSystem as KernelFileSystem.AtomicHostFileSystem)[KernelFileSystem.AtomicFileSystemTypeId].isolated
      )
        .toBe(built.fileSystem)
      yield* built.fileSystem.writeFileString("/message", "shared")
      expect(yield* built.spawner.string(ChildProcess.make("cat", ["/message"]))).toBe("shared")
    }))

  it.effect.each(["/repo", "repo", "/repo/", "/.", ""])(
    "refuses workspaceRoot %s before backend use",
    (workspaceRoot) =>
      Effect.gen(function*() {
        let backendCalls = 0
        const unavailable = async (): Promise<never> => {
          backendCalls++
          throw new Error("backend unavailable")
        }
        const error = yield* Effect.flip(services.pipe(
          Effect.provide(BrowserServices.layer({
            bash: { exec: unavailable },
            fs: {
              open: unavailable,
              readFile: unavailable,
              writeFile: unavailable,
              mkdir: unavailable,
              readdir: unavailable,
              stat: unavailable,
              lstat: unavailable,
              realpath: unavailable,
              rm: unavailable
            },
            workspaceRoot
          }))
        ))
        expect(error._tag).toBe("PlatformError")
        expect(error.reason).toMatchObject({
          _tag: "PermissionDenied",
          module: "FileSystem",
          method: "layer",
          pathOrDescriptor: workspaceRoot,
          description: "isolation requires the workspace root to equal the mount root /"
        })
        expect(backendCalls).toBe(0)
      })
  )
})

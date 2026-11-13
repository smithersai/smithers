import { describe, expect, it } from "@effect/vitest"
import { Jj } from "@smthrs/jj"
import * as KernelFileSystem from "@smthrs/kernel/FileSystem"
import { Effect, FileSystem, Path } from "effect"
import { HttpClient } from "effect/http/HttpClient"
import { ChildProcess } from "effect/process"
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner"
import { build } from "esbuild"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import * as ZenFsMount from "./fixtures/ZenFsMount.ts"

import * as BrowserHost from "../src/BrowserHost.ts"
import * as BrowserServices from "../src/BrowserServices.ts"

const wasm = new Uint8Array(readFileSync(new URL("../../jj/wasm/flows_jj.wasm", import.meta.url)))

describe("BrowserHost roots", () => {
  it.effect.each([undefined, "/", "/repo"])(
    "keeps the mount isolated at / with jj.root %s",
    (root) =>
      Effect.gen(function*() {
        const mount = yield* Effect.promise(() => ZenFsMount.mount())
        mount.fs.mkdirSync("/repo")
        const services = yield* Effect.gen(function*() {
          return {
            fileSystem: yield* FileSystem.FileSystem,
            path: yield* Path.Path,
            spawner: yield* ChildProcessSpawner,
            jj: yield* Jj,
            http: yield* HttpClient
          }
        }).pipe(Effect.provide(BrowserHost.layer({
          bash: mount.bash,
          fs: mount.fs.promises,
          // BrowserJj loads wasm on its first operation, not while building the host.
          jj: { wasm, fs: mount.fs, ...(root === undefined ? {} : { root }) }
        })))

        expect(typeof services.spawner.spawn).toBe("function")
        expect(typeof services.jj.status).toBe("function")
        expect(yield* services.jj.root!("/repo")).toBe(root ?? "/")
        expect(typeof services.http.execute).toBe("function")
        expect(services.path.normalize("/repo/..")).toBe("/")
        const attestation = (services.fileSystem as KernelFileSystem.AtomicHostFileSystem)[
          KernelFileSystem.AtomicFileSystemTypeId
        ]
        expect(attestation.isolated).toBe(services.fileSystem)
        expect(yield* services.fileSystem.realPath(".")).toBe("/")
        yield* services.fileSystem.writeFileString("/repo/message", "shared")
        expect(yield* services.spawner.string(ChildProcess.make("cat", ["/repo/message"]))).toBe("shared")
      })
  )
})

describe("BrowserHost composition", () => {
  /**
   * The module header claims this bundle is the layer above `BrowserServices`.
   * Rebuilding the filesystem, path and spawner trio here instead of composing
   * that layer puts the isolation-root rule in two places, so pin the
   * dependency: `BrowserServices` has to be in `BrowserHost`'s value graph.
   */
  it("builds its platform trio from BrowserServices", async () => {
    const result = await build({
      bundle: true,
      entryPoints: [fileURLToPath(new URL("../src/BrowserHost.ts", import.meta.url))],
      external: ["effect", "effect/*", "@smthrs/*"],
      format: "esm",
      logLevel: "silent",
      metafile: true,
      platform: "browser",
      write: false
    })
    expect(Object.keys(result.metafile.inputs).some((input) => input.endsWith("src/BrowserServices.ts"))).toBe(true)
  })

  /** The three shared tags answer identically however the caller reaches them. */
  it.effect("serves the same platform trio BrowserServices does", () =>
    Effect.gen(function*() {
      const trio = Effect.gen(function*() {
        const fileSystem = yield* FileSystem.FileSystem
        return {
          normalized: (yield* Path.Path).normalize("/repo/.."),
          output: yield* (yield* ChildProcessSpawner).string(ChildProcess.make("printf", ["shared"])),
          isolated:
            (fileSystem as KernelFileSystem.AtomicHostFileSystem)[KernelFileSystem.AtomicFileSystemTypeId].isolated ===
              fileSystem,
          realPath: yield* fileSystem.realPath(".")
        }
      })

      const mount = yield* Effect.promise(() => ZenFsMount.mount())
      mount.fs.mkdirSync("/repo")
      const fromHost = yield* trio.pipe(Effect.provide(BrowserHost.layer({
        bash: mount.bash,
        fs: mount.fs.promises,
        jj: { wasm, fs: mount.fs, root: "/repo" }
      })))
      const fromServices = yield* trio.pipe(Effect.provide(BrowserServices.layer({
        bash: mount.bash,
        fs: mount.fs.promises
      })))

      expect(fromHost).toEqual(fromServices)
    }))
})

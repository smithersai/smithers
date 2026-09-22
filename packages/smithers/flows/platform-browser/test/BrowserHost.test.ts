import { describe, expect, it } from "@effect/vitest"
import { Jj } from "@smthrs/jj"
import type { SyncFsLike } from "@smthrs/jj/browser/WasiFs"
import * as KernelFileSystem from "@smthrs/kernel/FileSystem"
import { Effect, FileSystem, Path } from "effect"
import { HttpClient } from "effect/unstable/http/HttpClient"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { build } from "esbuild"
import { posix } from "node:path"
import { fileURLToPath } from "node:url"
import { vi } from "vitest"
import * as BrowserHost from "../src/BrowserHost.ts"
import * as BrowserServices from "../src/BrowserServices.ts"

describe("BrowserHost roots", () => {
  it.effect.each([undefined, "/", "/repo"])(
    "keeps the mount isolated at / with jj.root %s",
    (root) =>
      Effect.gen(function*() {
        const unexpected = vi.fn(async (): Promise<never> => {
          throw new Error("unexpected backend operation during layer construction")
        })
        const realpath = vi.fn(async (path: string) => posix.normalize(path))
        const fs = {
          open: unexpected,
          readFile: unexpected,
          writeFile: unexpected,
          mkdir: unexpected,
          readdir: unexpected,
          stat: unexpected,
          rm: unexpected,
          realpath
        }
        const services = yield* Effect.gen(function*() {
          return {
            fileSystem: yield* FileSystem.FileSystem,
            path: yield* Path.Path,
            spawner: yield* ChildProcessSpawner,
            jj: yield* Jj,
            http: yield* HttpClient
          }
        }).pipe(Effect.provide(BrowserHost.layer({
          bash: { exec: unexpected },
          fs,
          // BrowserJj loads wasm on its first operation, not while building the host.
          jj: { wasm: new Uint8Array(), fs: {} as SyncFsLike, ...(root === undefined ? {} : { root }) }
        })))

        expect(unexpected).not.toHaveBeenCalled()
        expect(realpath).not.toHaveBeenCalled()
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
        expect(realpath).toHaveBeenCalledExactlyOnceWith("/.")
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
      const backend = () => {
        const unexpected = vi.fn(async (): Promise<never> => {
          throw new Error("unexpected backend operation during layer construction")
        })
        return {
          unexpected,
          realpath: vi.fn(async (path: string) => posix.normalize(path)),
          rest: {
            open: unexpected,
            readFile: unexpected,
            writeFile: unexpected,
            mkdir: unexpected,
            readdir: unexpected,
            stat: unexpected,
            rm: unexpected
          }
        }
      }
      const trio = Effect.gen(function*() {
        const fileSystem = yield* FileSystem.FileSystem
        return {
          normalized: (yield* Path.Path).normalize("/repo/.."),
          spawn: typeof (yield* ChildProcessSpawner).spawn,
          isolated:
            (fileSystem as KernelFileSystem.AtomicHostFileSystem)[KernelFileSystem.AtomicFileSystemTypeId].isolated ===
              fileSystem,
          realPath: yield* fileSystem.realPath(".")
        }
      })

      const host = backend()
      const services = backend()
      const fromHost = yield* trio.pipe(Effect.provide(BrowserHost.layer({
        bash: { exec: host.unexpected },
        fs: { ...host.rest, realpath: host.realpath },
        jj: { wasm: new Uint8Array(), fs: {} as SyncFsLike, root: "/repo" }
      })))
      const fromServices = yield* trio.pipe(Effect.provide(BrowserServices.layer({
        bash: { exec: services.unexpected },
        fs: { ...services.rest, realpath: services.realpath }
      })))

      expect(fromHost).toEqual(fromServices)
      expect(host.realpath.mock.calls).toEqual(services.realpath.mock.calls)
      expect(host.unexpected).not.toHaveBeenCalled()
    }))
})

import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Logger from "effect/Logger"
import * as PlatformError from "effect/PlatformError"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { describe, expect, it } from "vitest"
import * as PackageManager from "../src/PackageManager.ts"
import * as ExecutableFixture from "./ExecutableFixture.ts"

// The unguarded-open warning is once per process, and vitest gives each test
// file its own module graph: no read in this file runs without
// `RegularFileOpen` before the test that counts the warning.

const withLockfile = async <A>(use: (root: string) => Promise<A>): Promise<A> => {
  const root = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-regular-file-open-")))
  try {
    await Fs.writeFile(NodePath.join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8")
    return await use(root)
  } finally {
    await Fs.rm(root, { recursive: true, force: true })
  }
}

const hostFileSystem = () =>
  Effect.runPromise(
    Effect.gen(function*() {
      return yield* FileSystem.FileSystem
    }).pipe(Effect.provide(ExecutableFixture.layer))
  )

const warningsOf = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.gen(function*() {
    const warnings: Array<string> = []
    const capture = Logger.layer([
      Logger.make(({ logLevel, message }) => {
        if (logLevel === "Warn") warnings.push(Array.isArray(message) ? message.join(" ") : String(message))
      })
    ])
    const result = yield* effect.pipe(Effect.provide(capture))
    return { result, warnings }
  })

const digest = (
  root: string,
  fileSystem: FileSystem.FileSystem,
  regular?: PackageManager.RegularFileOpen["Service"]
) =>
  PackageManager.lockfileDigest(root, "pnpm-lock.yaml").pipe(
    Effect.provideService(FileSystem.FileSystem, fileSystem),
    Effect.provide(
      regular === undefined ? Layer.empty : Layer.succeed(PackageManager.RegularFileOpen, regular)
    ),
    Effect.provide(ExecutableFixture.layer)
  )

describe("PackageManager.RegularFileOpen", () => {
  it("opens every read through the service when it is in context, and logs nothing", async () => {
    await withLockfile(async (root) => {
      const host = await hostFileSystem()
      const opened: Array<string> = []
      const noPathOpen: FileSystem.FileSystem = {
        ...host,
        open: () => Effect.die(new Error("FileSystem.open ran although RegularFileOpen was provided"))
      }
      const delegating = {
        open: (path: string) => {
          opened.push(path)
          return host.open(path, { flag: "r" })
        }
      }
      const read = await Effect.runPromise(warningsOf(digest(root, noPathOpen, delegating)))
      expect(opened).toEqual([NodePath.join(root, "pnpm-lock.yaml")])
      expect(read.warnings).toEqual([])

      const refusal = PlatformError.systemError({
        _tag: "BadResource",
        module: "FileSystem",
        method: "openRegularFile",
        description: "expected a regular file"
      })
      const refused = await Effect.runPromise(
        warningsOf(Effect.flip(digest(root, noPathOpen, { open: () => Effect.fail(refusal) })))
      )
      expect(refused.result.code).toBe("lockfile_unreadable")
      expect(refused.result.message).toContain(refusal.message)
      expect(refused.result.cause?.name).toBe("PlatformError")
      expect(refused.warnings).toEqual([])
    })
  })

  it("reads through an injected FileSystem whose paths are not host paths, warning once", async () => {
    await withLockfile(async (root) => {
      const host = await hostFileSystem()
      const expected = await Effect.runPromise(
        digest(root, host, { open: (path) => host.open(path, { flag: "r" }) })
      )
      // Only the injected service knows `/virtual`: a host open of that path fails.
      const toHost = (path: string) => path.startsWith("/virtual") ? root + path.slice("/virtual".length) : path
      const toGuest = (path: string) => path.startsWith(root) ? "/virtual" + path.slice(root.length) : path
      const virtual: FileSystem.FileSystem = {
        ...host,
        exists: (path) => host.exists(toHost(path)),
        realPath: (path) => host.realPath(toHost(path)).pipe(Effect.map(toGuest)),
        stat: (path) => host.stat(toHost(path)),
        open: (path, options) => host.open(toHost(path), options)
      }
      const reads = await Effect.runPromise(
        warningsOf(Effect.all([digest("/virtual", virtual), digest("/virtual", virtual)]))
      )
      expect(reads.result).toEqual([expected, expected])
      expect(reads.warnings).toHaveLength(1)
      expect(reads.warnings[0]).toContain("PackageManager.RegularFileOpen is not provided")
    })
  })
})

import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Effect, Logger, Result, Schema, Stream } from "effect"
import { describe, expect, it } from "vitest"
import * as BrowserFileSystem from "../src/BrowserFileSystem/make.ts"
import { normalizePath } from "../src/BrowserFileSystem/normalizePath.ts"
import type { ZenFsPromisesLike } from "../src/BrowserFileSystem/ZenFsPromisesLike.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? "80")
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261131")
const silentLogger = Logger.layer([])

const assertPassed = (report: Parameters<typeof Fuzz.formatReport>[0]) => {
  const failure = Fuzz.formatReport(report)
  if (failure !== undefined) throw new Error(failure)
  expect(report._tag).toBe("Passed")
}

const makeMemZenFs = (opts: {
  readonly withOptionalOps: boolean
  readonly readOnlyMode: boolean
  readonly failStatPermission: boolean
}): ZenFsPromisesLike => {
  const files = new Map<string, Uint8Array>([["/hello.txt", new TextEncoder().encode("hello world")]])
  const dirs = new Set<string>(["/", "/sub"])

  const makeStats = (path: string) => {
    const isDir = dirs.has(path)
    const bytes = files.get(path)
    if (!isDir && bytes === undefined) {
      const e: any = new Error(`ENOENT: ${path}`)
      e.code = "ENOENT"
      throw e
    }
    const mode = opts.readOnlyMode ? 0o444 : 0o666
    return {
      isFile: () => !isDir,
      isDirectory: () => isDir,
      isSymbolicLink: () => false,
      isBlockDevice: () => false,
      isCharacterDevice: () => false,
      isFIFO: () => false,
      isSocket: () => false,
      size: bytes?.byteLength ?? 0,
      mode: isDir ? 0o40755 : (0o100000 | mode),
      atime: new Date(1000),
      mtime: new Date(2000),
      ctime: new Date(3000),
      birthtime: new Date(1000),
      atimeMs: 1000,
      mtimeMs: 2000,
      ctimeMs: 3000,
      birthtimeMs: 1000,
      dev: 1,
      ino: 1,
      nlink: 1,
      uid: 0,
      gid: 0,
      rdev: 0,
      blksize: 4096,
      blocks: 1
    } as any
  }

  const base: ZenFsPromisesLike = {
    readFile: async (p: string) => {
      const b = files.get(p)
      if (b === undefined) {
        const e: any = new Error("ENOENT")
        e.code = "ENOENT"
        throw e
      }
      return b
    },
    writeFile: async (p: string, data: any) => {
      files.set(p, typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data))
    },
    mkdir: async (p: string) => {
      dirs.add(p)
      return p
    },
    readdir: async (p: string) => {
      if (!dirs.has(p)) {
        const e: any = new Error("ENOENT")
        e.code = "ENOENT"
        throw e
      }
      const prefix = p === "/" ? "/" : `${p}/`
      const out = new Set<string>()
      for (const k of [...files.keys(), ...dirs]) {
        if (k === p || !k.startsWith(prefix)) continue
        const rest = k.slice(prefix.length)
        const seg = rest.split("/")[0]
        if (seg) out.add(seg)
      }
      return Array.from(out)
    },
    stat: async (p: string) => {
      if (opts.failStatPermission && p === "/secret") {
        const e: any = new Error("EACCES")
        e.code = "EACCES"
        throw e
      }
      return makeStats(p)
    },
    open: async () => ({} as any),
    rm: async (p: string) => {
      files.delete(p)
      dirs.delete(p)
    },
    ...(opts.withOptionalOps
      ? {
        rename: async (from: string, to: string) => {
          const b = files.get(from)
          if (b === undefined) {
            const e: any = new Error("ENOENT")
            e.code = "ENOENT"
            throw e
          }
          files.delete(from)
          files.set(to, b)
        },
        utimes: async (_p: string) => {},
        lstat: async (p: string) => makeStats(p)
      }
      : {})
  }
  return base
}

describe("@smthrs/platform-browser Deep2 Fuzz (BrowserFileSystem & normalizePath)", () => {
  it("normalizePath upholds POSIX lexical canonicalization, root clamping, and idempotency", async () => {
    const seg = Schema.Literals(["", ".", "..", "a", "b", "c.ts", "dir-1"])
    const arb = Arbitrary.schema(Schema.Array(seg).pipe(Schema.check(Schema.isMaxLength(12))))

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (segs) =>
          Effect.sync(() => {
            const raw = segs.join("/")
            const norm = normalizePath(raw)
            if (!norm.startsWith("/")) return false
            if (norm.includes("/../") || norm.endsWith("/..")) return false
            if (norm.includes("/./") || norm.endsWith("/.")) return false
            if (norm.includes("//")) return false
            // Idempotency
            return normalizePath(norm) === norm
          }),
        { seed, executions }
      )
    )
    assertPassed(report)
  })

  it("BrowserFileSystem.make fuzzes unsupported refusals, optional ops, access modes, readFileString encoding, exists, and readDirectoryEntries", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        withOptionalOps: Schema.Boolean,
        readOnlyMode: Schema.Boolean,
        failStatPermission: Schema.Boolean
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (c) =>
          Effect.gen(function*() {
            const fs = BrowserFileSystem.make(makeMemZenFs(c))

            // All unsupported operations fail closed with PermissionDenied
            const unsupportedOps = [
              fs.chmod("/hello.txt", 0o644),
              fs.chown("/hello.txt", 0, 0),
              fs.copy("/hello.txt", "/copy.txt"),
              fs.copyFile("/hello.txt", "/copy.txt"),
              fs.link("/hello.txt", "/link.txt"),
              fs.symlink("/hello.txt", "/sym.txt"),
              fs.readLink("/hello.txt"),
              Effect.scoped(fs.open("/hello.txt")),
              fs.truncate("/hello.txt", 1),
              fs.makeTempDirectory(),
              Effect.scoped(fs.makeTempDirectoryScoped()),
              fs.makeTempFile(),
              Effect.scoped(fs.makeTempFileScoped()),
              Stream.run(Stream.make(new Uint8Array([1])), fs.sink("/hello.txt")),
              Stream.runCollect(fs.watch("/hello.txt"))
            ]
            for (const op of unsupportedOps) {
              const r = yield* Effect.result(op)
              if (Result.isSuccess(r)) return false
            }

            // Optional rename, utimes, lstat
            const renRes = yield* Effect.result(fs.rename("/hello.txt", "/moved.txt"))
            if (c.withOptionalOps && Result.isFailure(renRes)) return false
            if (!c.withOptionalOps && Result.isSuccess(renRes)) return false

            const targetPath = c.withOptionalOps ? "/moved.txt" : "/hello.txt"
            const utRes = yield* Effect.result(fs.utimes(targetPath, new Date(1000), new Date(2000)))
            if (c.withOptionalOps && Result.isFailure(utRes)) return false
            if (!c.withOptionalOps && Result.isSuccess(utRes)) return false

            const lsInfo = yield* fs.lstat(targetPath)
            if (lsInfo.type !== "File") return false

            // readFileString valid & invalid encoding
            const text = yield* fs.readFileString(targetPath, "utf-8")
            if (text !== "hello world") return false
            const badEnc = yield* Effect.result(fs.readFileString(targetPath, "not-a-real-encoding-xyz"))
            if (Result.isSuccess(badEnc)) return false

            // writeFileString, makeDirectory, readDirectoryEntries, remove
            yield* fs.makeDirectory("/sub/nested", { recursive: true, mode: 0o700 })
            yield* fs.writeFileString("/sub/nested/f.txt", "data", { mode: 0o600 })
            const entries = yield* fs.readDirectoryEntries("/")
            if (entries.length === 0) return false

            // access mode checks
            const writableRes = yield* Effect.result(fs.access(targetPath, { writable: true }))
            if (c.readOnlyMode && Result.isSuccess(writableRes)) return false
            if (!c.readOnlyMode && Result.isFailure(writableRes)) return false
            yield* fs.access(targetPath, { readable: true })

            // exists distinguishes NotFound (false) vs PermissionDenied (failure)
            if ((yield* fs.exists("/definitely-missing")) !== false) return false
            if ((yield* fs.exists(targetPath)) !== true) return false
            if (c.failStatPermission) {
              const secRes = yield* Effect.result(fs.exists("/secret"))
              if (Result.isSuccess(secRes)) return false
            }

            yield* fs.remove("/sub/nested/f.txt", { force: true })
            return true
          }).pipe(Effect.provide(silentLogger)),
        { seed: seed + 1, executions: Math.min(executions, 40) }
      )
    )
    assertPassed(report)
  })
})

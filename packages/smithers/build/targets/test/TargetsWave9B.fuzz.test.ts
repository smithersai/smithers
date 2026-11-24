import { Flow, FlowRuntime } from "@smthrs/flow"
import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Effect, Exit, Latch, Layer, Schema } from "effect"
import * as NodeFs from "node:fs"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { describe, expect, it } from "vitest"
import * as Compose from "../src/Compose.ts"
import * as DocsParity from "../src/DocsParity.ts"
import * as GeneratedFile from "../src/GeneratedFile.ts"
import * as Input from "../src/Input.ts"
import * as PackageJson from "../src/PackageJson.ts"
import * as SafeFs from "../src/SafeFs.ts"
import * as Target from "../src/Target.ts"
import * as ToolBuild from "../src/ToolBuild.ts"
import * as ExecStage from "../src/internal/ExecStage.ts"
import * as PrivateStore from "../src/internal/PrivateStore.ts"
import * as PublicationFileSystem from "../src/internal/PublicationFileSystem.ts"

const executions = Number(process.env["EFFECT_FUZZ_EXECUTIONS"] ?? (process.env["EFFECT_FUZZ"] ? "250" : "80"))
const fsExecutions = Math.min(executions, 8)
const seed = Number(process.env["EFFECT_FUZZ_SEED"] ?? "20261124")

const assertPassed = <A, E>(report: Fuzz.Report<A, E>): void => {
  const failure = Fuzz.formatReport(report)
  if (failure !== undefined) throw new Error(failure)
  expect(report._tag).toBe("Passed")
}

const withTempDir = async <A>(prefix: string, fn: (dir: string) => Promise<A>): Promise<A> => {
  const dir = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), prefix)))
  try {
    return await fn(dir)
  } finally {
    await Fs.rm(dir, { recursive: true, force: true })
  }
}

const makeErr = (message: string, code: string): NodeJS.ErrnoException => {
  const err: NodeJS.ErrnoException = new Error(message)
  err.code = code
  return err
}

describe("@smthrs/targets Wave-9B: ToolBuild, SafeFs, GeneratedFile, Compose, Input, PackageJson, DocsParity, PrivateStore & ExecStage deep IO fuzz", () => {
  it("ToolBuild.measureOutput/measureOutputs/readOutputManifest/verifyOutputs fault & race matrix via CaptureIo", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        mode: Schema.Literals([
          "numeric-stats",
          "open-fail",
          "non-file-stat",
          "inode-swap",
          "unusable-meta",
          "hardlink",
          "confine-parent-fail",
          "post-open-lstat-swap",
          "bad-read-len",
          "changed-during-read",
          "close-fail",
          "dir-lstat-fail",
          "dir-symlink",
          "dir-nonfile",
          "dir-replaced",
          "output-not-file-dir",
          "output-outside-ws",
          "cache-outside-ws",
          "aborted",
          "realpath-root-fail",
          "bad-limits",
          "bad-cache-dir"
        ])
      })
    )

    await withTempDir("wave9b-tb-", async (root) => {
      await Fs.mkdir(NodePath.join(root, "dist", "sub"), { recursive: true })
      await Fs.mkdir(NodePath.join(root, "cache"), { recursive: true })
      const fileA = NodePath.join(root, "dist", "a.txt")
      const fileB = NodePath.join(root, "dist", "sub", "b.txt")
      await Fs.writeFile(fileA, "hello-a")
      await Fs.writeFile(fileB, "hello-b")
      const realA = await Fs.lstat(fileA, { bigint: true })
      const realDir = await Fs.lstat(NodePath.join(root, "dist"), { bigint: true })
      const numStats = await Fs.lstat(fileA)

      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          (input) =>
            Effect.promise(async () => {
              const baseIo = ToolBuild.defaultCaptureIo

              if (input.mode === "numeric-stats") {
                // Non-bigint number stats fallback (lines 323, 329)
                const io: ToolBuild.CaptureIo = {
                  ...baseIo,
                  lstat: async (p) => (p === fileA ? numStats : baseIo.lstat(p)),
                  openFile: async (p) => {
                    const fh = await baseIo.openFile(p)
                    return {
                      stat: async () => numStats,
                      read: (buf) => fh.read(buf),
                      close: () => fh.close()
                    }
                  }
                }
                const out = await ToolBuild.measureOutput(root, ".", "dist/a.txt", { io })
                expect(out.fileCount).toBe(1)
                return true
              }

              if (input.mode === "bad-limits") {
                const throwingLimits = new Proxy({}, {
                  getOwnPropertyDescriptor() {
                    throw new Error("unreadable")
                  }
                })
                await expect(ToolBuild.measureOutput(root, ".", "dist/a.txt", { limits: throwingLimits as never })).rejects.toThrow(/could not be read/)
                await expect(ToolBuild.measureOutput(root, ".", "dist/a.txt", { limits: { ...ToolBuild.defaultCaptureLimits, files: -1 } })).rejects.toThrow(/not usable/)
                await expect(ToolBuild.measureOutput(root, ".", "dist/a.txt", { limits: { ...ToolBuild.defaultCaptureLimits, files: 999_999_999 } })).rejects.toThrow(/exceeds/)
                return true
              }

              if (input.mode === "bad-cache-dir") {
                await expect(ToolBuild.measureOutput(root, ".", "dist/a.txt", { cacheDirectory: "" })).rejects.toThrow(/workspace-relative/)
                await expect(ToolBuild.measureOutput(root, ".", "dist/a.txt", { cacheDirectory: "/tmp/abs" })).rejects.toThrow(/workspace-relative/)
                await expect(ToolBuild.measureOutput(root, ".", "dist/a.txt", { cacheDirectory: "." })).rejects.toThrow(/leaves the workspace/)
                return true
              }

              if (input.mode === "aborted") {
                const ac = new AbortController()
                ac.abort()
                await expect(ToolBuild.measureOutput(root, ".", "dist/a.txt", { signal: ac.signal })).rejects.toThrow(/cancelled/)
                await expect(ToolBuild.measureOutputs(root, ".", ["dist/a.txt"], { signal: ac.signal })).rejects.toThrow(/cancelled/)
                return true
              }

              if (input.mode === "realpath-root-fail") {
                const io: ToolBuild.CaptureIo = {
                  ...baseIo,
                  realpath: async () => {
                    throw makeErr("no root", "ENOENT")
                  }
                }
                await expect(ToolBuild.measureOutput(root, ".", "dist/a.txt", { io })).rejects.toThrow(/workspace root could not be resolved/)
                return true
              }

              if (input.mode === "output-outside-ws") {
                const io: ToolBuild.CaptureIo = {
                  ...baseIo,
                  realpath: async (p) => (p === root ? root : "/outside/evil")
                }
                await expect(ToolBuild.measureOutput(root, ".", "dist/a.txt", { io })).rejects.toThrow(/outside the workspace/)
                return true
              }

              if (input.mode === "cache-outside-ws") {
                const cacheAbs = NodePath.join(root, "cache")
                const io: ToolBuild.CaptureIo = {
                  ...baseIo,
                  realpath: async (p) => (p === cacheAbs ? "/outside/cache" : baseIo.realpath(p))
                }
                await expect(ToolBuild.measureOutput(root, ".", "dist/a.txt", { io, cacheDirectory: "cache" })).rejects.toThrow(/cache directory resolves outside/)
                return true
              }

              if (input.mode === "output-not-file-dir") {
                const io: ToolBuild.CaptureIo = {
                  ...baseIo,
                  lstat: async (p) => (p === fileA ? ({ ...realA, isFile: () => false, isDirectory: () => false, isSymbolicLink: () => false } as never) : baseIo.lstat(p))
                }
                await expect(ToolBuild.measureOutput(root, ".", "dist/a.txt", { io })).rejects.toThrow(/not a file or a directory/)
                return true
              }

              if (input.mode === "open-fail") {
                const io: ToolBuild.CaptureIo = {
                  ...baseIo,
                  openFile: async () => {
                    throw makeErr("EACCES", "EACCES")
                  }
                }
                await expect(ToolBuild.measureOutput(root, ".", "dist/a.txt", { io })).rejects.toThrow(/could not be opened/)
                // Also exercise directory worker failure ordering
                await expect(ToolBuild.measureOutput(root, ".", "dist", { io })).rejects.toThrow(/could not be opened/)
                return true
              }

              if (input.mode === "non-file-stat") {
                const io: ToolBuild.CaptureIo = {
                  ...baseIo,
                  openFile: async (p) => {
                    const fh = await baseIo.openFile(p)
                    return {
                      stat: async () => ({ ...realA, isFile: () => false } as never),
                      read: (b) => fh.read(b),
                      close: () => fh.close()
                    }
                  }
                }
                await expect(ToolBuild.measureOutput(root, ".", "dist/a.txt", { io })).rejects.toThrow(/not a file or a directory/)
                return true
              }

              if (input.mode === "inode-swap") {
                const io: ToolBuild.CaptureIo = {
                  ...baseIo,
                  openFile: async (p) => {
                    const fh = await baseIo.openFile(p)
                    return {
                      stat: async () => ({ ...realA, ino: realA.ino + 999n, isFile: () => true } as never),
                      read: (b) => fh.read(b),
                      close: () => fh.close()
                    }
                  }
                }
                await expect(ToolBuild.measureOutput(root, ".", "dist/a.txt", { io })).rejects.toThrow(/replaced/)
                return true
              }

              if (input.mode === "unusable-meta") {
                const io: ToolBuild.CaptureIo = {
                  ...baseIo,
                  openFile: async (p) => {
                    const fh = await baseIo.openFile(p)
                    return {
                      stat: async () => ({ ...realA, size: -1n, isFile: () => true } as never),
                      read: (b) => fh.read(b),
                      close: () => fh.close()
                    }
                  }
                }
                await expect(ToolBuild.measureOutput(root, ".", "dist/a.txt", { io })).rejects.toThrow(/unusable metadata/)
                return true
              }

              if (input.mode === "hardlink") {
                const io: ToolBuild.CaptureIo = {
                  ...baseIo,
                  openFile: async (p) => {
                    const fh = await baseIo.openFile(p)
                    return {
                      stat: async () => ({ ...realA, nlink: 2n, isFile: () => true } as never),
                      read: (b) => fh.read(b),
                      close: () => fh.close()
                    }
                  }
                }
                await expect(ToolBuild.measureOutput(root, ".", "dist/a.txt", { io })).rejects.toThrow(/hard-linked/)
                return true
              }

              if (input.mode === "confine-parent-fail") {
                let realCalls = 0
                const io: ToolBuild.CaptureIo = {
                  ...baseIo,
                  realpath: async (p) => {
                    realCalls++
                    if (realCalls > 3) throw makeErr("gone", "ENOENT")
                    return baseIo.realpath(p)
                  }
                }
                await expect(ToolBuild.measureOutput(root, ".", "dist/a.txt", { io })).rejects.toThrow(/replaced/)
                return true
              }

              if (input.mode === "post-open-lstat-swap") {
                let lstatCalls = 0
                const io: ToolBuild.CaptureIo = {
                  ...baseIo,
                  lstat: async (p) => {
                    if (p === fileA && ++lstatCalls >= 2) {
                      return { ...realA, ino: realA.ino + 7n, isFile: () => true, isSymbolicLink: () => false } as never
                    }
                    return baseIo.lstat(p)
                  }
                }
                await expect(ToolBuild.measureOutput(root, ".", "dist/a.txt", { io })).rejects.toThrow(/replaced/)
                return true
              }

              if (input.mode === "bad-read-len") {
                const io: ToolBuild.CaptureIo = {
                  ...baseIo,
                  openFile: async (p) => {
                    const fh = await baseIo.openFile(p)
                    return {
                      stat: () => fh.stat(),
                      read: async () => -1,
                      close: () => fh.close()
                    }
                  }
                }
                await expect(ToolBuild.measureOutput(root, ".", "dist/a.txt", { io })).rejects.toThrow(/invalid read length/)
                return true
              }

              if (input.mode === "changed-during-read") {
                const io: ToolBuild.CaptureIo = {
                  ...baseIo,
                  openFile: async (p) => {
                    const fh = await baseIo.openFile(p)
                    let calls = 0
                    return {
                      stat: async () => {
                        const st = await fh.stat()
                        return ++calls === 2 ? ({ ...st, mtimeNs: (st as NodeFs.BigIntStats).mtimeNs + 100n, isFile: () => true } as never) : st
                      },
                      read: (b) => fh.read(b),
                      close: () => fh.close()
                    }
                  }
                }
                await expect(ToolBuild.measureOutput(root, ".", "dist/a.txt", { io })).rejects.toThrow(/changed while it was being read/)
                return true
              }

              if (input.mode === "close-fail") {
                const io: ToolBuild.CaptureIo = {
                  ...baseIo,
                  openFile: async (p) => {
                    const fh = await baseIo.openFile(p)
                    return {
                      stat: () => fh.stat(),
                      read: (b) => fh.read(b),
                      close: async () => {
                        await fh.close()
                        throw makeErr("EIO", "EIO")
                      }
                    }
                  }
                }
                await expect(ToolBuild.measureOutput(root, ".", "dist/a.txt", { io })).rejects.toThrow()
                return true
              }

              if (input.mode === "dir-lstat-fail") {
                const io: ToolBuild.CaptureIo = {
                  ...baseIo,
                  lstat: async (p) => {
                    if (p === fileA) throw makeErr("vanished", "ENOENT")
                    return baseIo.lstat(p)
                  }
                }
                await expect(ToolBuild.measureOutput(root, ".", "dist", { io })).rejects.toThrow(/replaced/)
                return true
              }

              if (input.mode === "dir-symlink") {
                const io: ToolBuild.CaptureIo = {
                  ...baseIo,
                  lstat: async (p) => (p === fileA ? ({ ...realA, isSymbolicLink: () => true, isFile: () => false, isDirectory: () => false } as never) : baseIo.lstat(p))
                }
                await expect(ToolBuild.measureOutput(root, ".", "dist", { io })).rejects.toThrow(/symbolic link/)
                return true
              }

              if (input.mode === "dir-nonfile") {
                const io: ToolBuild.CaptureIo = {
                  ...baseIo,
                  lstat: async (p) => (p === fileA ? ({ ...realA, isSymbolicLink: () => false, isFile: () => false, isDirectory: () => false } as never) : baseIo.lstat(p))
                }
                await expect(ToolBuild.measureOutput(root, ".", "dist", { io })).rejects.toThrow(/not a file or a directory/)
                return true
              }

              if (input.mode === "dir-replaced") {
                const distAbs = NodePath.join(root, "dist")
                let distCalls = 0
                const io: ToolBuild.CaptureIo = {
                  ...baseIo,
                  lstat: async (p) => {
                    if (p === distAbs && ++distCalls >= 2) {
                      return { ...realDir, ino: realDir.ino + 55n, isDirectory: () => true, isSymbolicLink: () => false } as never
                    }
                    return baseIo.lstat(p)
                  }
                }
                await expect(ToolBuild.measureOutput(root, ".", "dist", { io })).rejects.toThrow(/directory was replaced/)
                return true
              }

              return true
            }),
          { executions: Math.min(executions, 45), seed }
        )
      )
      assertPassed(report)

      // readOutputManifest & verifyOutputs edge cases (lines 901, 914, 971, 984, 990, 1021)
      const declared: Target.DeclaredOutputs = { cwd: ".", paths: ["dist/a.txt"] }
      expect(typeof ToolBuild.readOutputManifest(declared, { outputs: [], extra: 1 })).toBe("string")
      expect(typeof ToolBuild.readOutputManifest(declared, { outputs: new Proxy([], {}) })).toBe("string")
      expect(
        typeof ToolBuild.readOutputManifest(
          declared,
          { outputs: [{ path: "dist/wrong.txt", fileCount: 1, contentDigest: "a".repeat(64) }] }
        )
      ).toBe("string")
      expect(
        typeof ToolBuild.readOutputManifest(
          declared,
          { outputs: [{ path: "dist/a.txt", fileCount: 1, contentDigest: "not-hex" }] }
        )
      ).toBe("string")
      const throwingManifest = new Proxy({}, {
        ownKeys() {
          throw new Error("boom")
        }
      })
      expect(typeof ToolBuild.readOutputManifest(declared, throwingManifest)).toBe("string")

      const validOutputs = await ToolBuild.measureOutputs(root, ".", ["dist/a.txt"])
      const unmeasurable = await ToolBuild.verifyOutputs(root, declared, validOutputs, {
        io: {
          ...ToolBuild.defaultCaptureIo,
          lstat: async () => {
            throw makeErr("gone", "ENOENT")
          }
        }
      })
      expect(unmeasurable).toContain("could not be measured")
    })
  })

  it("SafeFs fault/race matrix, GeneratedFile PublicationFileSystem faults, PrivateStore & ExecStage error paths", async () => {
    await withTempDir("wave9b-safefs-", async (root) => {
      const f1 = NodePath.join(root, "doc.txt")
      const badUtf8 = NodePath.join(root, "bad.bin")
      const subDir = NodePath.join(root, "sub")
      const linkPath = NodePath.join(root, "link.txt")
      await Fs.mkdir(subDir, { recursive: true })
      await Fs.writeFile(f1, "safe-content")
      await Fs.writeFile(badUtf8, Buffer.from([0xff, 0xfe, 0xfd]))
      await Fs.symlink(f1, linkPath)
      const realSt = await Fs.lstat(f1, { bigint: true })
      const numSt = await Fs.lstat(f1)

      const arb = Arbitrary.schema(
        Schema.Struct({
          mode: Schema.Literals([
            "num-stats-and-index",
            "bad-size",
            "reject-symlink",
            "symlink-race",
            "resolve-outside",
            "non-enoent",
            "list-limit",
            "open-changed",
            "open-left-ws",
            "open-replaced",
            "bad-read-len",
            "digest-limits",
            "digest-changed",
            "readtext-limits",
            "readtext-changed",
            "readtext-bad-utf8",
            "syncdir-errors",
            "error-helpers"
          ])
        })
      )

      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          (input) =>
            Effect.promise(async () => {
              const base = SafeFs.defaultIo

              if (input.mode === "error-helpers") {
                const throwGetter = {}
                Object.defineProperty(throwGetter, "code", { get() { throw new Error("no code") } })
                expect(SafeFs.errorCode(throwGetter)).toBeUndefined()
                expect(SafeFs.digestStatus(numSt)).toBeDefined()
                return true
              }

              if (input.mode === "num-stats-and-index") {
                const io: SafeFs.Io = {
                  ...base,
                  lstat: async (p) => (p === f1 ? numSt : base.lstat(p)),
                  open: async (p) => {
                    const fh = await base.open(p)
                    return { stat: async () => numSt, read: (b) => fh.read(b), close: () => fh.close() }
                  }
                }
                const entry = await SafeFs.resolveFile(f1, { root, io })
                expect(entry).toBeDefined()
                const idx = SafeFs.makeDigestIndex()
                const d = await SafeFs.digestEntry(entry!, { root, io }); expect(idx).toBeDefined()
                expect(d.length).toBe(64)
                return true
              }

              if (input.mode === "bad-size") {
                const badSt = { ...numSt, size: -5, isFile: () => true, isSymbolicLink: () => false } as never
                const entry: SafeFs.Entry = { path: f1, stats: badSt }
                await expect(SafeFs.digestEntry(entry, { root })).rejects.toThrow(/invalid file size/)
                return true
              }

              if (input.mode === "reject-symlink") {
                await expect(SafeFs.resolveFile(linkPath, { root, symlinks: "reject" })).rejects.toThrow(/symbolic link/)
                return true
              }

              if (input.mode === "symlink-race") {
                let n = 0
                const io: SafeFs.Io = {
                  ...base,
                  lstat: async (p) => {
                    if (p === f1 && ++n >= 1) return { ...realSt, isSymbolicLink: () => true, isFile: () => false } as never
                    return base.lstat(p)
                  }
                }
                await expect(SafeFs.resolveFile(linkPath, { root, io })).rejects.toThrow(/changed while its symbolic link/)
                // Also absent target on symlink realpath
                const ioAbsent: SafeFs.Io = {
                  ...base,
                  realpath: async () => {
                    throw makeErr("gone", "ENOENT")
                  }
                }
                expect(await SafeFs.resolveFile(linkPath, { root, io: ioAbsent })).toBeUndefined()
                const ioEacces: SafeFs.Io = {
                  ...base,
                  realpath: async () => {
                    throw makeErr("denied", "EACCES")
                  }
                }
                await expect(SafeFs.resolveFile(linkPath, { root, io: ioEacces })).rejects.toThrow(/denied/)
                return true
              }

              if (input.mode === "resolve-outside") {
                const io: SafeFs.Io = {
                  ...base,
                  realpath: async () => "/outside/escape"
                }
                await expect(SafeFs.resolveDirectory(subDir, { root, io })).rejects.toThrow(/outside the workspace/)
                return true
              }

              if (input.mode === "non-enoent") {
                const io: SafeFs.Io = {
                  ...base,
                  lstat: async () => {
                    throw makeErr("perm", "EACCES")
                  }
                }
                await expect(SafeFs.resolveFile(f1, { root, io })).rejects.toThrow(/perm/)
                await expect(SafeFs.resolveDirectory(subDir, { root, io })).rejects.toThrow(/perm/)
                const ioOpen: SafeFs.Io = {
                  ...base,
                  open: async () => {
                    throw makeErr("perm", "EACCES")
                  }
                }
                await expect(SafeFs.readText(f1, { root, io: ioOpen })).rejects.toThrow(/perm/)
                return true
              }

              if (input.mode === "list-limit") {
                const rootDirEntry = (await SafeFs.resolveDirectory(root, { root }))!
                await expect(SafeFs.listDirectory(root, rootDirEntry, { root, directoryEntries: -1 })).rejects.toThrow(/directory entry limit/)
                await expect(SafeFs.listDirectory(root, rootDirEntry, { root, directoryEntries: 1 })).rejects.toThrow(/more than 1 entries/)
                return true
              }

              if (input.mode === "open-changed") {
                const io: SafeFs.Io = {
                  ...base,
                  open: async (p) => {
                    const fh = await base.open(p)
                    return {
                      stat: async () => ({ ...realSt, ino: realSt.ino + 1n, isFile: () => true } as never),
                      read: (b) => fh.read(b),
                      close: () => fh.close()
                    }
                  }
                }
                await expect(SafeFs.readText(f1, { root, io })).rejects.toThrow(/changed|replaced/)
                return true
              }

              if (input.mode === "open-left-ws") {
                let realCalls = 0
                const io: SafeFs.Io = {
                  ...base,
                  realpath: async (p) => (++realCalls >= 2 ? "/outside/dir" : base.realpath(p))
                }
                await expect(SafeFs.readText(f1, { root, io })).rejects.toThrow(/left the workspace/)
                return true
              }

              if (input.mode === "open-replaced") {
                let lstatCalls = 0
                const io: SafeFs.Io = {
                  ...base,
                  lstat: async (p) => {
                    if (p === f1 && ++lstatCalls >= 2) {
                      return { ...realSt, ino: realSt.ino + 42n, isFile: () => true, isSymbolicLink: () => false } as never
                    }
                    return base.lstat(p)
                  }
                }
                await expect(SafeFs.readText(f1, { root, io })).rejects.toThrow(/replaced while its open descriptor/)
                return true
              }

              if (input.mode === "bad-read-len") {
                const io: SafeFs.Io = {
                  ...base,
                  open: async (p) => {
                    const fh = await base.open(p)
                    return { stat: () => fh.stat(), read: async () => -1, close: () => fh.close() }
                  }
                }
                await expect(SafeFs.readText(f1, { root, io })).rejects.toThrow(/invalid read length/)
                return true
              }

              if (input.mode === "digest-limits") {
                const entry = (await SafeFs.resolveFile(f1, { root }))!
                await expect(SafeFs.digestEntry(entry, { root, maximumBytes: -1 })).rejects.toThrow(/digest byte limit/)
                await expect(SafeFs.digestEntry(entry, { root, maximumBytes: 2 })).rejects.toThrow(/larger than 2 bytes/)
                await expect(SafeFs.digestFile(f1, { root, maximumBytes: -1 })).rejects.toThrow(/digest byte limit/)
                // Exceeds maximumBytes on fstat after small lstat
                const smallEntry: SafeFs.Entry = { path: f1, stats: { ...realSt, size: 1n, isFile: () => true, isSymbolicLink: () => false } as never }
                const ioGrow: SafeFs.Io = {
                  ...base,
                  lstat: async () => ({ ...realSt, size: 50n, isFile: () => true, isSymbolicLink: () => false } as never),
                  open: async (p) => {
                    const fh = await base.open(p)
                    return {
                      stat: async () => ({ ...realSt, size: 50n, isFile: () => true } as never),
                      read: (b) => fh.read(b),
                      close: () => fh.close()
                    }
                  }
                }
                await expect(SafeFs.digestEntry(smallEntry, { root, maximumBytes: 5, io: ioGrow })).rejects.toThrow(/changed while it was being opened/)
                // Exceeds maximumBytes during read loop
                const ioStreamBig: SafeFs.Io = {
                  ...base,
                  lstat: async () => ({ ...realSt, size: 1n, isFile: () => true, isSymbolicLink: () => false } as never),
                  open: async (p) => {
                    const fh = await base.open(p)
                    return {
                      stat: async () => ({ ...realSt, size: 1n, isFile: () => true } as never),
                      read: async (b) => {
                        b.fill(65)
                        return b.byteLength
                      },
                      close: () => fh.close()
                    }
                  }
                }
                await expect(SafeFs.digestEntry(smallEntry, { root, maximumBytes: 5, io: ioStreamBig })).rejects.toThrow(/larger than 5 bytes/)
                return true
              }

              if (input.mode === "digest-changed") {
                const entry = (await SafeFs.resolveFile(f1, { root }))!
                const io: SafeFs.Io = {
                  ...base,
                  open: async (p) => {
                    const fh = await base.open(p)
                    let calls = 0
                    return {
                      stat: async () => {
                        const st = await fh.stat()
                        return ++calls === 2 ? ({ ...st, mtimeNs: (st as NodeFs.BigIntStats).mtimeNs + 50n, isFile: () => true } as never) : st
                      },
                      read: (b) => fh.read(b),
                      close: () => fh.close()
                    }
                  }
                }
                await expect(SafeFs.digestEntry(entry, { root, io })).rejects.toThrow(/changed while it was being digested/)
                return true
              }

              if (input.mode === "readtext-limits") {
                await expect(SafeFs.readText(f1, { root, limit: -1 })).rejects.toThrow(/text read limit/)
                return true
              }

              if (input.mode === "readtext-changed") {
                const io: SafeFs.Io = {
                  ...base,
                  open: async (p) => {
                    const fh = await base.open(p)
                    let calls = 0
                    return {
                      stat: async () => {
                        const st = await fh.stat()
                        return ++calls === 2 ? ({ ...st, mtimeNs: (st as NodeFs.BigIntStats).mtimeNs + 50n, isFile: () => true } as never) : st
                      },
                      read: (b) => fh.read(b),
                      close: () => fh.close()
                    }
                  }
                }
                await expect(SafeFs.readText(f1, { root, io })).rejects.toThrow(/changed while it was being read/)
                return true
              }

              if (input.mode === "readtext-bad-utf8") {
                await expect(SafeFs.readText(badUtf8, { root })).rejects.toThrow(/not valid UTF-8/)
                return true
              }

              if (input.mode === "syncdir-errors") {
                const syncIo: SafeFs.DirectorySyncIo = {
                  open: async () => ({
                    sync: async () => {
                      throw makeErr("sync fail", "EIO")
                    },
                    close: async () => {
                      throw makeErr("close fail", "EIO")
                    }
                  })
                }
                await expect(SafeFs.syncDirectory(root, syncIo)).rejects.toThrow(/sync fail/)
                const syncIo2: SafeFs.DirectorySyncIo = {
                  open: async () => ({
                    sync: async () => {
                      throw makeErr("einval", "EINVAL")
                    },
                    close: async () => {
                      throw makeErr("close-only fail", "EIO")
                    }
                  })
                }
                await expect(SafeFs.syncDirectory(root, syncIo2)).rejects.toThrow(/close-only fail/)
                return true
              }

              return true
            }),
          { executions: Math.min(executions, 40), seed }
        )
      )
      assertPassed(report)

      // GeneratedFile faults via PublicationFileSystem
      const runGenWrite = (io: typeof Fs, path = "out/file.txt", contents = "ok") =>
        Effect.runPromiseExit(
          GeneratedFile.writeGeneratedFile(root, { path, contents }).pipe(
            Effect.provideService(PublicationFileSystem.PublicationFileSystem, io)
          )
        )

      // failureMessage unstringifiable
      const badMsg = {
        get message() {
          throw new Error("boom")
        }
      }
      expect(GeneratedFile.failureMessage(badMsg)).toBe("unknown failure")

      // exceeds maximumGeneratedFileBytes
      const hugeExit = await runGenWrite(Fs, "out/big.txt", "a".repeat(GeneratedFile.maximumGeneratedFileBytes + 1))
      expect(Exit.isFailure(hugeExit)).toBe(true)

      // existing output is a directory (not regular file)
      await Fs.mkdir(NodePath.join(root, "is-a-dir"), { recursive: true })
      expect(Exit.isFailure(await runGenWrite(Fs, "is-a-dir", "hi"))).toBe(true)

      // workspace root not real directory
      expect(
        Exit.isFailure(
          await runGenWrite({
            ...Fs,
            lstat: (async (p: NodeFs.PathLike, opts?: unknown) => {
              const st = await Fs.lstat(p, opts as never)
              if (String(p) === root) return { ...st, isDirectory: () => false, isSymbolicLink: () => false }
              return st
            }) as typeof Fs.lstat
          })
        )
      ).toBe(true)

      // mkdir non-EEXIST error
      expect(
        Exit.isFailure(
          await runGenWrite({
            ...Fs,
            mkdir: (async () => {
              throw makeErr("mkdir fail", "EACCES")
            }) as typeof Fs.mkdir
          }, "newdir/a.txt")
        )
      ).toBe(true)

      // temp file EEXIST exhaustion (lines 341, 344)
      expect(
        Exit.isFailure(
          await runGenWrite({
            ...Fs,
            open: (async () => {
              throw makeErr("exists", "EEXIST")
            }) as typeof Fs.open
          })
        )
      ).toBe(true)

      // temp file non-EEXIST error (line 341)
      expect(
        Exit.isFailure(
          await runGenWrite({
            ...Fs,
            open: (async () => {
              throw makeErr("perm", "EACCES")
            }) as typeof Fs.open
          })
        )
      ).toBe(true)

      // write + close + rm combined failures (lines 393-418)
      expect(
        Exit.isFailure(
          await runGenWrite({
            ...Fs,
            open: (async (p: NodeFs.PathLike, flags: number, mode?: number) => {
              const fh = await Fs.open(p, flags, mode)
              return {
                stat: () => fh.stat({ bigint: true }),
                writeFile: async () => {
                  throw makeErr("write fail", "EIO")
                },
                sync: () => fh.sync(),
                close: async () => {
                  await fh.close()
                  throw makeErr("close fail", "EIO")
                }
              }
            }) as unknown as typeof Fs.open,
            rm: (async () => {
              throw makeErr("rm fail", "EIO")
            }) as typeof Fs.rm
          })
        )
      ).toBe(true)

      // incomplete written temp size (line 389)
      expect(
        Exit.isFailure(
          await runGenWrite({
            ...Fs,
            open: (async (p: NodeFs.PathLike, flags: number, mode?: number) => {
              const fh = await Fs.open(p, flags, mode)
              let statCount = 0
              return {
                stat: async () => {
                  const st = await fh.stat({ bigint: true })
                  return ++statCount === 2 ? { ...st, size: 9999n, isFile: () => true, nlink: 1n } : st
                },
                writeFile: (c: string) => fh.writeFile(c),
                sync: () => fh.sync(),
                close: () => fh.close()
              }
            }) as unknown as typeof Fs.open
          })
        )
      ).toBe(true)

      // rename failure (line 409)
      expect(
        Exit.isFailure(
          await runGenWrite({
            ...Fs,
            rename: (async () => {
              throw makeErr("rename fail", "EXDEV")
            }) as typeof Fs.rename
          })
        )
      ).toBe(true)

      // checkGeneratedSymlink non-ENOENT error (line 505, 508)
      const symExit = await Effect.runPromiseExit(
        GeneratedFile.checkGeneratedSymlink(root, { path: "bad\u0000link", target: "x" })
      )
      expect(Exit.isFailure(symExit)).toBe(true)

      // PrivateStore errors (lines 17, 43, 90, 113, 118, 143-147)
      const notDirFile = NodePath.join(root, "not-a-dir")
      await Fs.writeFile(notDirFile, "x")
      expect(() => PrivateStore.ensure(notDirFile, { ...NodeFs, mkdirSync: () => undefined })).toThrow(/not a directory/)
      const storeDir = NodePath.join(root, "pstore")
      await Fs.mkdir(storeDir, { recursive: true })
      await Fs.writeFile(NodePath.join(storeDir, "colfile"), "x")
      expect(() => PrivateStore.list(storeDir, "colfile")).toThrow(/collection is not a directory/)
      const ensured = PrivateStore.ensure(storeDir)
      const recName = "recs/" + "a".repeat(64) + ".json"
      const colDir = NodePath.join(ensured, "recs")
      await Fs.mkdir(NodePath.join(ensured, recName), { recursive: true })
      expect(() => PrivateStore.read(ensured, recName)).toThrow(/not a regular file/)
      expect(() => PrivateStore.read(ensured, recName, { ...NodeFs, openSync: () => { throw makeErr("eloop", "ELOOP") } })).toThrow(/not a regular file/)
      await Fs.rm(NodePath.join(ensured, recName), { recursive: true, force: true })
      await Fs.writeFile(NodePath.join(colDir, "b".repeat(64) + ".json"), "{invalid")
      expect(PrivateStore.list(ensured, "recs")).toEqual([])
      expect(() =>
        PrivateStore.list(ensured, "recs", {
          ...NodeFs,
          openSync: () => {
            throw makeErr("eio", "EIO")
          }
        })
      ).toThrow(/not a regular file/)

      // ExecStage.render & prepare cleanup on failure (lines 186-187, 207-222)
      const plan = {
        argv: ["echo", "hi"],
        cwd: root,
        workspaceRoot: root,
        reads: [f1],
        writes: [] as ReadonlyArray<string>,
        writeProtected: [] as ReadonlyArray<string>,
        network: "none" as const,
        mechanism: { _tag: "bubblewrap" as const, executable: "bwrap" },
        tmp: root
      } as never
      expect(() =>
        ExecStage.prepare(plan, {
          ...ExecStage.liveIo,
          link: () => {
            throw new Error("link boom")
          },
          copy: () => {
            throw new Error("copy boom")
          }
        })
      ).toThrow(/boom/)

      const rendered = ExecStage.render(plan, (p) => ({ argv: p.stage === undefined ? ["x".repeat(ExecStage.maximumCommandBytes + 10)] : ["echo", p.stage.directory] }))
      expect(rendered.wrapped.argv[0]).toBe("echo")
      rendered.prepared?.release()

      expect(() =>
        ExecStage.render(plan, () => ({ argv: ["x".repeat(ExecStage.maximumCommandBytes + 10)] }))
      ).toThrow()
    })
  })

  it("Input glob arrays/limits/gitignore/pnpmWorkspace, Compose Generate/checkGenerator, PackageJson.sync & DocsParity deep paths", async () => {
    await withTempDir("wave9b-input-", async (root) => {
      await Fs.mkdir(NodePath.join(root, "pkg", "src"), { recursive: true })
      await Fs.mkdir(NodePath.join(root, "pkg", "subpkg"), { recursive: true })
      await Fs.mkdir(NodePath.join(root, "nested-repo", ".git"), { recursive: true })
      await Fs.writeFile(NodePath.join(root, ".gitignore"), "*.ignored\n!keep.ignored\n")
      await Fs.writeFile(NodePath.join(root, "pkg", "src", "a.ts"), "export const a = 1\n")
      await Fs.writeFile(NodePath.join(root, "pkg", "src", "drop.ignored"), "drop\n")
      await Fs.writeFile(NodePath.join(root, "pkg", "src", "keep.ignored"), "keep\n")
      await Fs.writeFile(NodePath.join(root, "pkg", "subpkg", "PACKAGE.ts"), "export default {}\n")
      await Fs.writeFile(NodePath.join(root, "pkg", "subpkg", "x.ts"), "export const x = 1\n")
      await Fs.writeFile(NodePath.join(root, "nested-repo", "f.ts"), "export const f = 1\n")

      // Input.glob array form + errors (lines 200-207)
      const globs = Input.glob(["src/**/*.ts", "!src/**/*.test.ts"])
      expect(globs.length).toBe(1)
      expect(globs[0]!.exclude).toEqual(["src/**/*.test.ts"])
      expect(() => Input.glob([123 as never])).toThrow(/must be strings/)
      expect(() => Input.glob(["!only-exclude"])).toThrow(/positive pattern/)

      // Input.expandGlob with ancestor .gitignore, GlobCrossesPackage, enteredRepositories, limit errors & max exclusions/length
      const expanded = await Input.expandGlob(root, "pkg", Input.glob("src/**/*"))
      expect(expanded).toContain("pkg/src/a.ts")
      expect(expanded).toContain("pkg/src/keep.ignored")
      expect(expanded).not.toContain("pkg/src/drop.ignored")

      await expect(
        Input.expandGlob(root, "pkg", Input.glob("subpkg/*.ts"))
      ).rejects.toThrow() // GlobCrossesPackage

      const entered = await Input.expandGlob(root, "nested-repo", Input.glob("*.ts"))
      expect(entered).toContain("nested-repo/f.ts")

      await expect(
        Input.expandGlob(root, "pkg", Input.glob("src/*.ts"), { limits: { ...Input.defaultScanLimits, directories: -1 } })
      ).rejects.toThrow(/non-negative safe integer/)
      await expect(
        Input.expandGlob(root, "pkg", Input.glob("src/*.ts"), { limits: { ...Input.defaultScanLimits, directories: 999_999_999 } })
      ).rejects.toThrow(/exceeds/)
      const badLimits = new Proxy({}, { getOwnPropertyDescriptor() { throw new Error("nope") } })
      await expect(
        Input.expandGlob(root, "pkg", Input.glob("src/*.ts"), { limits: badLimits as never })
      ).rejects.toThrow(/could not be inspected/)

      await expect(
        Input.expandGlob(root, "pkg", { _tag: "Glob", pattern: "a".repeat(17_000), exclude: [] })
      ).rejects.toThrow(/UTF-16/)
      await expect(
        Input.expandGlob(root, "pkg", { _tag: "Glob", pattern: "*.ts", exclude: Array.from({ length: 4100 }, (_, i) => `e${i}`) })
      ).rejects.toThrow(/exclusions/)

      // Input.expandPnpmWorkspace YAML parse/validate/empty/no-inclusion errors
      const badYaml = NodePath.join(root, "bad.yaml")
      await Fs.writeFile(badYaml, "packages: [unclosed\n")
      await expect(Input.expandPnpmWorkspace(root, ".", Input.pnpmWorkspace("bad.yaml"))).rejects.toThrow(/parse/)

      const badShape = NodePath.join(root, "shape.yaml")
      await Fs.writeFile(badShape, "packages: 123\n")
      await expect(Input.expandPnpmWorkspace(root, ".", Input.pnpmWorkspace("shape.yaml"))).rejects.toThrow(/validate/)

      const emptyEntry = NodePath.join(root, "empty.yaml")
      await Fs.writeFile(emptyEntry, "packages:\n  - \"\"\n")
      await expect(Input.expandPnpmWorkspace(root, ".", Input.pnpmWorkspace("empty.yaml"))).rejects.toThrow(/empty/)

      const onlyExcl = NodePath.join(root, "excl.yaml")
      await Fs.writeFile(onlyExcl, "packages:\n  - \"!packages/a\"\n")
      await expect(Input.expandPnpmWorkspace(root, ".", Input.pnpmWorkspace("excl.yaml"))).rejects.toThrow(/no package inclusion/)

      // Input.isDeclared proxy/non-array exclude
      expect(Input.isDeclared({ _tag: "Glob", pattern: "*.ts", exclude: new Proxy([], {}) })).toBe(false)

      // Input.digestLink non-ENOENT error
      await expect(
        Input.digestLink(root, "pkg/src/a.ts", {
          io: {
            ...SafeFs.defaultIo,
            lstat: async () => {
              throw makeErr("perm", "EACCES")
            }
          }
        })
      ).rejects.toThrow(/perm/)

      // Compose.Generate validation + attrsForKind + checkGenerator snapshot limits & symlink restore
      expect(() => Compose.Generate({ command: "echo hi", args: ["a"], changes: ["out.txt"] } as never)).toThrow(/cannot take args/)
      expect(() => Compose.Generate({ command: "echo hi" } as never)).toThrow(/changes or stdout/)
      const genTarget = Compose.Generate({ command: "echo hi", changes: ["out.txt"], mode: "write" } as never)
      const lintView = Target.metadata(genTarget).forKind("lint")
      expect((lintView.attrs as { readonly mode?: string }).mode).toBe("check")

      await Fs.symlink("pkg/src/a.ts", NodePath.join(root, "gen-link"))
      const badSnapExit = await Effect.runPromiseExit(
        Compose.checkGenerator(
          { workspaceRoot: root, snapshotLimits: { fileBytes: -1, totalBytes: 100 } },
          {
            declared: "gen-link",
            cwd: ".",
            changes: ["gen-link"],
            exec: { cwd: ".", argv: ["true"], env: {} }
          } as never
        )
      )
      expect(Exit.isFailure(badSnapExit)).toBe(true)

      // PackageJson.parseGenerated + sync error paths + PackageJsonCheck forKind("lint")
      expect(() => PackageJson.parseGenerated("x".repeat(PackageJson.maximumGeneratedResponseBytes + 10), ["description"])).toThrow(/exceeds/)
      expect(() => PackageJson.parseGenerated("{}", [])).toThrow(/empty or contains duplicates/)
      expect(() => PackageJson.parseGenerated("{}", ["description", "description"])).toThrow(/empty or contains duplicates/)

      const pkCheck = PackageJson.PackageJsonCheck({
        output: "package.json",
        packageDirectory: ".",
        fields: { name: "demo", version: "1.0.0" },
        generated: [],
        readme: null,
        sources: null,
        promptVersion: "v1",
        engine: "claude",
        model: "claude-sonnet-4-5",
        mode: "write"
      })
      expect((Target.metadata(pkCheck).forKind("lint").attrs as { readonly mode?: string }).mode).toBe("check")

      const syncFailExit = await Effect.runPromiseExit(
        PackageJson.sync(
          {
            workspaceRoot: root,
            cacheDirectory: "../escape",
            invokeModel: () => Effect.fail(new Error("model boom"))
          } as never,
          {
            path: "package.json",
            mode: "check",
            fields: { name: "demo", version: "1.0.0" },
            generated: ["description"],
            engine: "claude",
            model: "claude-sonnet-4-5"
          } as never
        )
      )
      expect(Exit.isFailure(syncFailExit)).toBe(true)

      // DocsParity: checkDocs + CheckDocsLive + DocsParity target plan
      await Fs.writeFile(
        NodePath.join(root, "README.md"),
        "# Demo\n\n" + "This package provides deterministic build targets and documentation parity checks across examples. ".repeat(3) + "\n```ts\nconst ok = 1\n```\n"
      )
      await Fs.writeFile(NodePath.join(root, "ex.ts"), "const ok = 1\n")
      await Fs.writeFile(NodePath.join(root, "ex.test.ts"), "import \"./ex.ts\"\n")
      await Effect.runPromise(
        DocsParity.checkDocs(
          { workspaceRoot: root },
          {
            path: "README.md",
            minimumProseCharacters: 50,
            examples: [{ page: "README.md", example: "ex.ts", test: "ex.test.ts" }]
          }
        )
      )

      const parityMissingExit = await Effect.runPromiseExit(
        DocsParity.checkDocs(
          { workspaceRoot: root },
          {
            path: "MISSING.md",
            minimumProseCharacters: 50,
            examples: []
          }
        )
      )
      expect(Exit.isFailure(parityMissingExit)).toBe(true)

      const dpTarget = DocsParity.DocsParity({
        deps: [],
        readme: Input.file("README.md"),
        examples: [{ page: Input.file("README.md"), example: Input.file("ex.ts"), test: Input.file("ex.ts") }]
      } as never)
      expect(Target.plan(dpTarget as never)).toBeDefined()

      // CheckDocsLive layer registration
      let regParity: ((p: DocsParity.ReadmePayload, id: string) => Effect.Effect<void, DocsParity.DocsParityError>) | undefined
      const runtime = FlowRuntime.FlowRuntime.of({
        register: (_flow: unknown, exec: typeof regParity) =>
          Effect.sync(() => {
            regParity = exec
          }),
        actionExecute: (action: { readonly execute: Effect.Effect<unknown, unknown> }) =>
          Effect.map(Effect.exit(action.execute), (exit) => new Flow.Complete({ exit }))
      } as unknown as FlowRuntime.FlowRuntime["Service"])
      await Effect.runPromise(
        Effect.gen(function*() {
          yield* Layer.build(
            DocsParity.CheckDocsLive({ workspaceRoot: root }).pipe(
              Layer.provide(Layer.succeed(FlowRuntime.FlowRuntime, runtime))
            )
          )
          const instance = FlowRuntime.FlowInstance.of({
            executionId: "dp-wave9b",
            actionState: { count: 0, latch: Latch.makeUnsafe() }
          } as never)
          return yield* regParity!(
            { path: "README.md", minimumProseCharacters: 20, examples: [] },
            "dp-wave9b"
          ).pipe(
            Effect.provideService(FlowRuntime.FlowInstance, instance),
            Effect.provideService(FlowRuntime.FlowRuntime, runtime)
          )
        }).pipe(Effect.scoped)
      )
    })
  }, 60_000)
})

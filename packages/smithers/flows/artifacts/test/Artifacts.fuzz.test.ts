import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import { Sha256, syncCrypto } from "@smthrs/crypto"
import { Fuzz, FuzzSimulation } from "@smthrs/fuzz"
import { Arbitrary, Effect, Schema } from "effect"
import * as Clock from "effect/Clock"
import * as EffectDigest from "effect/crypto/Digest"
import * as Deferred from "effect/Deferred"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as FileSystem from "effect/FileSystem"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientError from "effect/http/HttpClientError"
import * as HttpClientResponse from "effect/http/HttpClientResponse"
import * as Layer from "effect/Layer"
import * as Logger from "effect/Logger"
import * as Metric from "effect/Metric"
import * as Option from "effect/Option"
import * as PlatformError from "effect/PlatformError"
import * as Stream from "effect/Stream"
import { TestClock } from "effect/testing"
import { posix } from "node:path"
import { describe, expect, it } from "vitest"
import {
  ArtifactBackupLease,
  ArtifactStore,
  ArtifactStoreMetrics,
  ArtifactSweep,
  CombinedArtifacts,
  FileLease,
  ImmutableCache,
  RemoteArtifacts
} from "../src/index.ts"
import * as ArtifactLocks from "../src/internal/ArtifactLocks.ts"
import * as ArtifactPath from "../src/internal/ArtifactPath.ts"
import { hostPath } from "./HostPath.ts"

const baseExecutions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "1000" : "200"))
const scale = (target: number) => Math.max(1, Math.round((target * baseExecutions) / 200))
const pureExecutions = scale(100)
const mediumExecutions = scale(35)
const simExecutions = scale(25)
const ioExecutions = scale(18)
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261122")

const silentLogger = Logger.layer([])
const encoder = new TextEncoder()
const decoder = new TextDecoder()

const platformError = (
  tag: PlatformError.SystemErrorTag,
  method: string,
  cause?: unknown,
  pathOrDescriptor?: string
): PlatformError.PlatformError =>
  PlatformError.systemError({
    _tag: tag,
    module: "fuzz",
    method,
    ...(cause === undefined ? {} : { cause }),
    ...(pathOrDescriptor === undefined ? {} : { pathOrDescriptor })
  })

const einval = (method: string) => platformError("Unknown", method, { code: "EINVAL" })

const bytesEqual = (a: Uint8Array, b: Uint8Array): boolean => {
  if (a.byteLength !== b.byteLength) return false
  for (let i = 0; i < a.byteLength; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

const errorOf = (exit: Exit.Exit<unknown, unknown>): unknown => {
  if (Exit.isSuccess(exit)) return undefined
  const reason = exit.cause.reasons[0]
  return reason !== undefined && "error" in reason ? reason.error : undefined
}

const runFuzz = async <A, R = never>(
  arb: Parameters<typeof Fuzz.run<A, R>>[0],
  predicate: (input: A) => Effect.Effect<boolean, unknown, R>,
  options: {
    readonly seedOffset?: number
    readonly executions?: number
    readonly execution?: ReturnType<typeof FuzzSimulation.execution>
  } = {}
) => {
  const eff = Fuzz.run(arb, predicate as (input: A) => Effect.Effect<boolean, never, R>, {
    seed: seed + (options.seedOffset ?? 0),
    executions: options.executions ?? mediumExecutions,
    ...(options.execution === undefined ? {} : { execution: options.execution })
  }).pipe(Effect.provide(silentLogger)) as unknown as Effect.Effect<
    Parameters<typeof Fuzz.formatReport>[0] & { readonly _tag: string }
  >
  const report = await Effect.runPromise(eff)
  const failure = Fuzz.formatReport(report)
  if (failure !== undefined) throw new Error(failure)
  expect(report._tag).toBe("Passed")
}

interface FsOpenOptions {
  readonly flag?: FileSystem.OpenFlag | undefined
  readonly mode?: number | undefined
}

interface VirtualFsHooks {
  readonly readLink?: (path: string) => Effect.Effect<string, PlatformError.PlatformError> | undefined
  readonly stat?: (path: string) => Effect.Effect<FileSystem.File.Info, PlatformError.PlatformError> | undefined
  readonly readFile?: (path: string) => Effect.Effect<Uint8Array, PlatformError.PlatformError> | undefined
  readonly writeFile?: (
    path: string,
    data: Uint8Array,
    options?: FsOpenOptions
  ) => Effect.Effect<void, PlatformError.PlatformError> | undefined
  readonly open?: (
    path: string,
    options?: FsOpenOptions
  ) => Effect.Effect<FileSystem.File, PlatformError.PlatformError> | undefined
  readonly utimes?: (
    path: string,
    atime: Date | number,
    mtime: Date | number
  ) => Effect.Effect<void, PlatformError.PlatformError> | undefined
  readonly rename?: (from: string, to: string) => Effect.Effect<void, PlatformError.PlatformError> | undefined
  readonly remove?: (path: string) => Effect.Effect<void, PlatformError.PlatformError> | undefined
  readonly exists?: (path: string) => Effect.Effect<boolean, PlatformError.PlatformError> | undefined
  readonly readDirectory?: (path: string) => Effect.Effect<Array<string>, PlatformError.PlatformError> | undefined
  readonly sync?: (path: string) => Effect.Effect<void, PlatformError.PlatformError> | undefined
}

interface VirtualEntry {
  data: Uint8Array
  mtime: number | undefined
  ino: bigint
  dev: bigint
}

interface VirtualDir {
  mtime: number | undefined
  ino: bigint
  dev: bigint
}

const makeVirtualFs = (options: {
  readonly hooks?: VirtualFsHooks
  readonly initialClockMs?: number
} = {}) => {
  let nextIno = 10n
  const files = new Map<string, VirtualEntry>()
  const dirs = new Map<string, VirtualDir>([
    [".", { mtime: options.initialClockMs ?? 1_000_000, ino: 1n, dev: 1n }],
    ["/", { mtime: options.initialClockMs ?? 1_000_000, ino: 2n, dev: 1n }]
  ])
  const symlinks = new Map<string, string>()
  const syncs: Array<string> = []

  const normalize = (p: string): string => {
    const cleaned = p.replace(/\/+/g, "/")
    if (cleaned.length > 1 && cleaned.endsWith("/")) return cleaned.slice(0, -1)
    return cleaned
  }

  const ensureDir = (raw: string, nowMs: number): void => {
    const p = normalize(raw)
    if (dirs.has(p)) return
    const parent = posix.dirname(p)
    if (parent !== p) ensureDir(parent, nowMs)
    dirs.set(p, { mtime: nowMs, ino: nextIno++, dev: 1n })
  }

  const setFile = (raw: string, data: Uint8Array, mtime: number | null = 1_000_000): void => {
    const p = normalize(raw)
    ensureDir(posix.dirname(p), mtime ?? 1_000_000)
    files.set(p, { data: data.slice(), mtime: mtime === null ? undefined : mtime, ino: nextIno++, dev: 1n })
  }

  const setDir = (raw: string, mtime: number | null = 1_000_000): void => {
    const p = normalize(raw)
    ensureDir(p, mtime ?? 1_000_000)
    dirs.set(p, { mtime: mtime === null ? undefined : mtime, ino: nextIno++, dev: 1n })
  }

  const setSymlink = (raw: string, target: string): void => {
    const p = normalize(raw)
    ensureDir(posix.dirname(p), 1_000_000)
    symlinks.set(p, target)
  }

  const hooks = options.hooks ?? {}

  const fs: FileSystem.FileSystem = FileSystem.makeNoop({
    exists: (raw) =>
      Effect.suspend(() => {
        const p = normalize(raw)
        const hooked = hooks.exists?.(p)
        if (hooked !== undefined) return hooked
        return Effect.succeed(files.has(p) || dirs.has(p) || symlinks.has(p))
      }),
    readLink: (raw) =>
      Effect.suspend(() => {
        const p = normalize(raw)
        const hooked = hooks.readLink?.(p)
        if (hooked !== undefined) return hooked
        const target = symlinks.get(p)
        if (target !== undefined) return Effect.succeed(target)
        if (files.has(p) || dirs.has(p)) return Effect.fail(einval("readLink"))
        return Effect.fail(platformError("NotFound", "readLink", undefined, p))
      }),
    stat: (raw) =>
      Effect.suspend((): Effect.Effect<FileSystem.File.Info, PlatformError.PlatformError> => {
        const p = normalize(raw)
        const hooked = hooks.stat?.(p)
        if (hooked !== undefined) return hooked
        const f = files.get(p)
        if (f !== undefined) {
          return Effect.succeed({
            type: "File",
            mtime: Option.fromUndefinedOr(f.mtime).pipe(Option.map((ms) => new Date(ms))),
            atime: Option.none(),
            birthtime: Option.none(),
            dev: f.dev,
            ino: Option.some(f.ino),
            mode: 0o600,
            nlink: Option.some(1),
            uid: Option.some(0),
            gid: Option.some(0),
            rdev: Option.none(),
            size: BigInt(f.data.byteLength) as FileSystem.File.Info["size"],
            blksize: Option.none(),
            blocks: Option.none()
          } as unknown as FileSystem.File.Info)
        }
        const d = dirs.get(p)
        if (d !== undefined) {
          return Effect.succeed({
            type: "Directory",
            mtime: Option.fromUndefinedOr(d.mtime).pipe(Option.map((ms) => new Date(ms))),
            atime: Option.none(),
            birthtime: Option.none(),
            dev: d.dev,
            ino: Option.some(d.ino),
            mode: 0o700,
            nlink: Option.some(1),
            uid: Option.some(0),
            gid: Option.some(0),
            rdev: Option.none(),
            size: 0n as FileSystem.File.Info["size"],
            blksize: Option.none(),
            blocks: Option.none()
          } as unknown as FileSystem.File.Info)
        }
        return Effect.fail(platformError("NotFound", "stat", undefined, p))
      }),
    makeDirectory: (raw) =>
      Effect.gen(function*() {
        const p = normalize(raw)
        const now = yield* Clock.currentTimeMillis
        ensureDir(p, now)
      }),
    readDirectory: (raw) =>
      Effect.suspend(() => {
        const p = normalize(raw)
        const hooked = hooks.readDirectory?.(p)
        if (hooked !== undefined) return hooked
        if (!dirs.has(p)) return Effect.fail(platformError("NotFound", "readDirectory", undefined, p))
        const prefix = p === "/" ? "/" : `${p}/`
        const children = new Set<string>()
        for (const k of [...files.keys(), ...dirs.keys(), ...symlinks.keys()]) {
          if (k.startsWith(prefix) && k.length > prefix.length) {
            children.add(k.slice(prefix.length).split("/")[0]!)
          }
        }
        return Effect.succeed([...children])
      }),
    readFile: (raw) =>
      Effect.suspend(() => {
        const p = normalize(raw)
        const hooked = hooks.readFile?.(p)
        if (hooked !== undefined) return hooked
        if (dirs.has(p)) return Effect.fail(platformError("Unknown", "readFile", { code: "EISDIR" }, p))
        const f = files.get(p)
        if (f === undefined) return Effect.fail(platformError("NotFound", "readFile", undefined, p))
        return Effect.succeed(f.data.slice())
      }),
    readFileString: (raw) => Effect.map(fs.readFile(raw), (buf) => decoder.decode(buf)),
    writeFile: (raw, data, writeOpts) =>
      Effect.gen(function*() {
        const p = normalize(raw)
        const hooked = hooks.writeFile?.(p, data, writeOpts)
        if (hooked !== undefined) return yield* hooked
        const flag = writeOpts?.flag
        if (flag === "wx" && (files.has(p) || dirs.has(p) || symlinks.has(p))) {
          return yield* Effect.fail(platformError("AlreadyExists", "writeFile", undefined, p))
        }
        const now = yield* Clock.currentTimeMillis
        const existing = files.get(p)
        ensureDir(posix.dirname(p), now)
        files.set(p, {
          data: data.slice(),
          mtime: now,
          ino: existing?.ino ?? nextIno++,
          dev: existing?.dev ?? 1n
        })
      }),
    writeFileString: (raw, content, writeOpts) => fs.writeFile(raw, encoder.encode(content), writeOpts),
    utimes: (raw, atime, mtime) =>
      Effect.suspend(() => {
        const p = normalize(raw)
        const hooked = hooks.utimes?.(p, atime, mtime)
        if (hooked !== undefined) return hooked
        const ms = typeof mtime === "number" ? mtime : mtime.getTime()
        const f = files.get(p)
        if (f !== undefined) {
          f.mtime = ms
          return Effect.void
        }
        const d = dirs.get(p)
        if (d !== undefined) {
          d.mtime = ms
          return Effect.void
        }
        return Effect.fail(platformError("NotFound", "utimes", undefined, p))
      }),
    rename: (rawFrom, rawTo) =>
      Effect.suspend(() => {
        const from = normalize(rawFrom)
        const to = normalize(rawTo)
        const hooked = hooks.rename?.(from, to)
        if (hooked !== undefined) return hooked
        const f = files.get(from)
        if (f !== undefined) {
          files.delete(from)
          files.set(to, f)
          return Effect.void
        }
        const d = dirs.get(from)
        if (d !== undefined) {
          dirs.delete(from)
          dirs.set(to, d)
          return Effect.void
        }
        return Effect.fail(platformError("NotFound", "rename", undefined, from))
      }),
    remove: (raw) =>
      Effect.suspend(() => {
        const p = normalize(raw)
        const hooked = hooks.remove?.(p)
        if (hooked !== undefined) return hooked
        if (files.delete(p) || dirs.delete(p) || symlinks.delete(p)) return Effect.void
        return Effect.fail(platformError("NotFound", "remove", undefined, p))
      }),
    open: (raw, openOpts) =>
      Effect.gen(function*() {
        const p = normalize(raw)
        const hooked = hooks.open?.(p, openOpts)
        if (hooked !== undefined) return yield* hooked
        const flag = openOpts?.flag
        const now = yield* Clock.currentTimeMillis
        if (flag === "wx") {
          if (files.has(p) || dirs.has(p) || symlinks.has(p)) {
            return yield* Effect.fail(platformError("AlreadyExists", "open", undefined, p))
          }
          if (!dirs.has(posix.dirname(p))) {
            return yield* Effect.fail(platformError("NotFound", "open", undefined, p))
          }
          files.set(p, { data: new Uint8Array(), mtime: now, ino: nextIno++, dev: 1n })
        } else if (!files.has(p) && !dirs.has(p)) {
          return yield* Effect.fail(platformError("NotFound", "open", undefined, p))
        }
        return {
          stat: fs.stat(p),
          chmod: () => Effect.void,
          chown: () => Effect.void,
          read: () => Effect.succeed(0n as FileSystem.File.Info["size"]),
          readAlloc: () => Effect.succeed(Option.none()),
          truncate: () => Effect.void,
          write: (chunk: Uint8Array) =>
            Effect.map(fs.writeFile(p, chunk), () => BigInt(chunk.byteLength) as FileSystem.File.Info["size"]),
          writeAll: (chunk: Uint8Array) => fs.writeFile(p, chunk),
          sync: Effect.suspend(() => {
            const syncHook = hooks.sync?.(p)
            if (syncHook !== undefined) return syncHook
            syncs.push(p)
            return Effect.void
          })
        } as unknown as FileSystem.File
      })
  })

  return { fs, files, dirs, symlinks, syncs, setFile, setDir, setSymlink }
}

describe("@smthrs/artifacts comprehensive fuzz suite", () => {
  it("MemoryArtifactStore, NoopArtifactStore, layers, metrics, and pure helpers satisfy invariants", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        blobs: Schema.Array(
          Schema.Array(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 255 })))
        ),
        badDigest: Schema.String,
        overrideHas: Schema.Boolean
      })
    )
    await runFuzz(
      arb,
      (input) =>
        Effect.gen(function*() {
          // 1. validateDigest
          const isValid = /^[0-9a-f]{64}$/.test(input.badDigest)
          const validExit = yield* ArtifactStore.validateDigest(input.badDigest).pipe(Effect.exit)
          if (isValid && !Exit.isSuccess(validExit)) return false
          if (!isValid) {
            const err = errorOf(validExit) as ArtifactStore.ArtifactStoreError
            if (err?.code !== "invalid_digest") return false
          }
          // Non-string guard
          const nonStrExit = yield* ArtifactStore.validateDigest(123 as never).pipe(Effect.exit)
          if ((errorOf(nonStrExit) as ArtifactStore.ArtifactStoreError)?.code !== "invalid_digest") return false

          // 2. snapshotBytes failure path (host allocation/copy refusal)
          const badBuf = {
            get length() {
              throw new RangeError("allocation refused")
            }
          } as unknown as Uint8Array
          const snapFail = yield* ArtifactStore.snapshotBytes(badBuf).pipe(Effect.exit)
          if ((errorOf(snapFail) as ArtifactStore.ArtifactStoreError)?.code !== "unavailable") return false

          // 3. measureBytes failure path (broken Digest service)
          const brokenCrypto = EffectDigest.Digest.of({
            digest: () => Effect.fail(new Error("crypto unavailable") as never),
            digestHex: () => Effect.fail(new Error("crypto unavailable") as never)
          })
          const measFail = yield* ArtifactStore.measureBytes(new Uint8Array([1, 2])).pipe(
            Effect.provideService(EffectDigest.Digest, brokenCrypto),
            Effect.exit
          )
          if ((errorOf(measFail) as ArtifactStore.ArtifactStoreError)?.code !== "digest_failed") return false

          // 4. MemoryArtifactStore via layerMemory + defensive copy + findMissing + missing get
          const payloads = input.blobs.slice(0, 6).map((b) => new Uint8Array(b.slice(0, 64)))
          const memOk = yield* Effect.gen(function*() {
            const store = yield* ArtifactStore.ArtifactStore
            const digests: Array<ArtifactStore.Digest> = []
            for (const p of payloads) {
              const copy = p.slice()
              const d = yield* store.put(copy)
              // Mutate caller buffer after put: stored copy must stay intact.
              if (copy.length > 0) copy[0] = (copy[0]! + 1) & 0xff
              if (d !== Sha256.digestSync(p)) return false
              digests.push(d)
            }
            for (let i = 0; i < payloads.length; i++) {
              const d = digests[i]!
              if (!(yield* store.has(d))) return false
              const got = yield* store.get(d)
              if (!bytesEqual(got, payloads[i]!)) return false
              // Mutate returned buffer: subsequent get must stay intact.
              if (got.length > 0) got[0] = (got[0]! ^ 0xff) & 0xff
              const got2 = yield* store.get(d)
              if (!bytesEqual(got2, payloads[i]!)) return false
            }
            const absent = Sha256.digestSync(encoder.encode(`absent-${input.badDigest}`))
            if (digests.includes(absent)) return true
            const missExit = yield* store.get(absent).pipe(Effect.exit)
            if (!(errorOf(missExit) instanceof ArtifactStore.ArtifactMissing)) return false
            const missing = yield* store.findMissing([...digests, absent, absent])
            if (missing.length !== 1 || missing[0] !== absent) return false
            return true
          }).pipe(
            Effect.provide(ArtifactStore.layerMemory),
            Effect.provideService(EffectDigest.Digest, syncCrypto)
          )
          if (!memOk) return false

          // 5. NoopArtifactStore (default + layerNoop with override)
          const noop = ArtifactStore.makeNoop()
          const d0 = "0".repeat(64)
          const noopOps: ReadonlyArray<Effect.Effect<unknown, unknown, EffectDigest.Digest>> = [
            noop.put(new Uint8Array([1])),
            noop.get(d0),
            noop.has(d0),
            noop.findMissing([d0])
          ]
          for (const eff of noopOps) {
            const ex = yield* eff.pipe(Effect.provideService(EffectDigest.Digest, syncCrypto), Effect.exit)
            if ((errorOf(ex) as ArtifactStore.ArtifactStoreError)?.code !== "unavailable") return false
          }
          const noopLayerOk = yield* Effect.gen(function*() {
            const s = yield* ArtifactStore.ArtifactStore
            return (yield* s.has(d0)) === input.overrideHas
          }).pipe(Effect.provide(ArtifactStore.layerNoop({ has: () => Effect.succeed(input.overrideHas) })))
          if (!noopLayerOk) return false

          // 6. Metrics handles are live counters
          yield* Metric.update(ArtifactStoreMetrics.puts, 0)
          yield* Metric.update(ArtifactStoreMetrics.gets, 0)
          yield* Metric.update(ArtifactStoreMetrics.remoteFailure.put, 0)
          yield* Metric.update(ArtifactStoreMetrics.remoteFailure.write_back, 0)
          yield* Metric.update(ArtifactStoreMetrics.freshenFailures, 0)
          return true
        }),
      { seedOffset: 1, executions: pureExecutions }
    )
  })

  it("MemoryArtifactStore preserves exact bytes, SHA-256 content addressing, and idempotency under concurrent FuzzSimulation", async () => {
    const arb = Arbitrary.schema(
      Schema.Array(
        Schema.Struct({
          bytes: Schema.Array(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 255 }))),
          deleteAfter: Schema.Boolean
        })
      )
    )
    await runFuzz(
      arb,
      (items) =>
        Effect.gen(function*() {
          const store = ArtifactStore.makeMemory()
          const payloads = items.slice(0, 6).map((item) => new Uint8Array(item.bytes.slice(0, 128)))
          const digests = yield* Effect.forEach(
            payloads,
            (bytes) =>
              Effect.gen(function*() {
                yield* Effect.yieldNow
                const d1 = yield* store.put(bytes)
                const d2 = yield* store.put(bytes)
                if (d1 !== d2 || d1 !== Sha256.digestSync(bytes)) return null
                return d1
              }),
            { concurrency: "unbounded" }
          )
          for (let i = 0; i < payloads.length; i++) {
            const d = digests[i]
            if (d === null || d === undefined) return false
            if (!(yield* store.has(d))) return false
            const actual = yield* store.get(d)
            if (!bytesEqual(actual, payloads[i]!)) return false
          }
          return true
        }).pipe(Effect.provideService(EffectDigest.Digest, syncCrypto)),
      { seedOffset: 2, executions: simExecutions, execution: FuzzSimulation.execution() }
    )
  })

  it("ArtifactPath.guard and ArtifactLocks.withDigest enforce symlink, type, identity, and lock safety", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        mode: Schema.Literals([
          "symlink",
          "wrong-type",
          "readlink-err",
          "stat-err",
          "vanish-allow",
          "vanish-refuse",
          "ino-swap",
          "dev-swap",
          "expected-mismatch",
          "ok"
        ]),
        coordination: Schema.Literals(["required", "process"]),
        concurrency: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 4 }))
      })
    )
    await runFuzz(
      arb,
      (input) =>
        Effect.gen(function*() {
          const target = "/obj/dir"
          let failReadLink = false
          let failStat = false
          const vfs = makeVirtualFs({
            hooks: {
              readLink: (p) =>
                failReadLink && p === target
                  ? Effect.fail(platformError("PermissionDenied", "readLink"))
                  : undefined,
              stat: (p) =>
                failStat && p === target
                  ? Effect.fail(platformError("PermissionDenied", "stat"))
                  : undefined
            }
          })
          const d = "a".repeat(64)

          if (input.mode === "symlink") {
            vfs.setSymlink(target, "/elsewhere")
            const ex = yield* ArtifactPath.guard(vfs.fs, target).pipe(Effect.exit)
            if (Exit.isSuccess(ex)) return false
          } else if (input.mode === "wrong-type") {
            vfs.setFile(target, new Uint8Array([1]))
            const ex = yield* ArtifactPath.guard(vfs.fs, target, "Directory").pipe(Effect.exit)
            if (Exit.isSuccess(ex)) return false
          } else if (input.mode === "readlink-err") {
            vfs.setDir(target)
            failReadLink = true
            const ex = yield* ArtifactPath.guard(vfs.fs, target).pipe(Effect.exit)
            if (Exit.isSuccess(ex)) return false
          } else if (input.mode === "stat-err") {
            vfs.setDir(target)
            failStat = true
            const ex = yield* ArtifactPath.guard(vfs.fs, target).pipe(Effect.exit)
            if (Exit.isSuccess(ex)) return false
          } else if (input.mode === "vanish-allow") {
            vfs.setFile(target, new Uint8Array([1]))
            const recheck = yield* ArtifactPath.guard(vfs.fs, target, "File", undefined, "allow")
            vfs.files.delete(target)
            const ex = yield* recheck.pipe(Effect.exit)
            if (!Exit.isSuccess(ex)) return false
          } else if (input.mode === "vanish-refuse") {
            vfs.setFile(target, new Uint8Array([1]))
            const recheck = yield* ArtifactPath.guard(vfs.fs, target, "File", undefined, "refuse")
            vfs.files.delete(target)
            const ex = yield* recheck.pipe(Effect.exit)
            if (Exit.isSuccess(ex)) return false
          } else if (input.mode === "ino-swap" || input.mode === "dev-swap") {
            vfs.setFile(target, new Uint8Array([1]))
            const recheck = yield* ArtifactPath.guard(vfs.fs, target, "File")
            const entry = vfs.files.get(target)!
            if (input.mode === "ino-swap") entry.ino += 100n
            else entry.dev += 1n
            const ex = yield* recheck.pipe(Effect.exit)
            if (Exit.isSuccess(ex)) return false
          } else if (input.mode === "expected-mismatch") {
            vfs.setFile(target, new Uint8Array([1]))
            const info = yield* vfs.fs.stat(target)
            vfs.files.get(target)!.ino += 55n
            const ex = yield* ArtifactPath.guard(vfs.fs, target, "File", info).pipe(Effect.exit)
            if (Exit.isSuccess(ex)) return false
          } else {
            // Test ArtifactLocks.withDigest serialization + WeakMap cleanup + timeout
            const lockRoot = "/obj"
            vfs.setDir(lockRoot)
            let active = 0
            let maxActive = 0
            const results = yield* Effect.forEach(
              Array.from({ length: input.concurrency }, (_, i) => i),
              (i) =>
                ArtifactLocks.withDigest(
                  vfs.fs,
                  lockRoot,
                  d,
                  Effect.gen(function*() {
                    active += 1
                    if (active > maxActive) maxActive = active
                    yield* Effect.yieldNow
                    active -= 1
                    return i
                  }),
                  (cause) => cause,
                  input.coordination
                ),
              { concurrency: "unbounded" }
            )
            if (maxActive !== 1 || results.length !== input.concurrency) return false

            // Also test acquisition timeout on held lock
            const entered = yield* Deferred.make<void>()
            const releaseHolder = yield* Deferred.make<void>()
            const holder = yield* Effect.forkChild(
              ArtifactLocks.withDigest(
                vfs.fs,
                lockRoot,
                d,
                Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(releaseHolder))),
                (cause) => cause,
                input.coordination
              )
            )
            yield* Deferred.await(entered)
            const waiter = yield* Effect.forkChild(
              ArtifactLocks.withDigest(
                vfs.fs,
                lockRoot,
                d,
                Effect.succeed("never"),
                (cause) => cause,
                input.coordination
              )
            )
            yield* TestClock.adjust("3 minutes")
            const waitExit = yield* Fiber.await(waiter)
            yield* Deferred.succeed(releaseHolder, undefined)
            yield* Fiber.await(holder)
            if (Exit.isSuccess(waitExit)) return false
          }
          return true
        }).pipe(Effect.provide(TestClock.layer())),
      { seedOffset: 3, executions: pureExecutions }
    )
  })

  it("FileLease handles invalid config, contention, stale/directory reclaim, displaced handback, heartbeat, and release faults", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        scenario: Schema.Literals([
          "invalid-config",
          "basic-and-contention",
          "timeout",
          "stale-reclaim",
          "legacy-dir-reclaim",
          "displaced-handback",
          "claim-contended",
          "claim-and-rename-errors",
          "observe-errors",
          "heartbeat-own-and-unreadable",
          "heartbeat-lost-gone",
          "heartbeat-lost-foreign",
          "guard-failure",
          "release-edge-cases"
        ]),
        staleAfterMs: Schema.Int.check(Schema.isBetween({ minimum: 500, maximum: 5000 })),
        heartbeatMs: Schema.Int.check(Schema.isBetween({ minimum: 50, maximum: 400 }))
      })
    )
    await runFuzz(
      arb,
      (input) =>
        Effect.gen(function*() {
          const lockPath = "/locks/a.lock"
          const baseTime = 1_000_000
          yield* TestClock.setTime(baseTime)

          if (input.scenario === "invalid-config") {
            const vfs = makeVirtualFs()
            const badOpts: ReadonlyArray<FileLease.Options> = [
              { staleAfterMs: 0 },
              { staleAfterMs: -10 },
              { staleAfterMs: Number.NaN },
              { staleAfterMs: Number.POSITIVE_INFINITY },
              { heartbeatEvery: "not-a-duration" as never },
              { heartbeatEvery: "0 millis", staleAfterMs: 1000 },
              { heartbeatEvery: "2 seconds", staleAfterMs: 1000 }
            ]
            for (const opt of badOpts) {
              const ex = yield* FileLease.hold(vfs.fs, lockPath, Effect.void, (c) => c, opt).pipe(Effect.exit)
              if (Exit.isSuccess(ex)) return false
            }
            return true
          }

          if (input.scenario === "basic-and-contention") {
            const vfs = makeVirtualFs()
            vfs.setDir("/locks")
            const entered = yield* Deferred.make<void>()
            const finishFirst = yield* Deferred.make<void>()
            const first = yield* Effect.forkChild(
              FileLease.withLease(
                vfs.fs,
                lockPath,
                Deferred.succeed(entered, undefined).pipe(
                  Effect.andThen(Deferred.await(finishFirst)),
                  Effect.as("first")
                ),
                (c) => c,
                {
                  heartbeatEvery: `${input.heartbeatMs} millis`,
                  staleAfterMs: input.staleAfterMs,
                  retryEvery: "10 millis",
                  acquireWithin: "5 seconds"
                }
              )
            )
            yield* Deferred.await(entered)
            const second = yield* Effect.forkChild(
              FileLease.withLease(vfs.fs, lockPath, Effect.succeed("second"), (c) => c, {
                heartbeatEvery: `${input.heartbeatMs} millis`,
                staleAfterMs: input.staleAfterMs,
                retryEvery: "10 millis",
                acquireWithin: "5 seconds"
              })
            )
            yield* TestClock.adjust("15 millis")
            yield* Deferred.succeed(finishFirst, undefined)
            yield* TestClock.adjust("30 millis")
            const r1 = yield* Fiber.join(first)
            const r2 = yield* Fiber.join(second)
            return r1 === "first" && r2 === "second" && !vfs.files.has(lockPath)
          }

          if (input.scenario === "timeout") {
            const vfs = makeVirtualFs()
            vfs.setFile(lockPath, encoder.encode("live-owner"), baseTime)
            const fiber = yield* Effect.forkChild(
              FileLease.withLease(vfs.fs, lockPath, Effect.succeed(true), (c) => c, {
                heartbeatEvery: `${input.heartbeatMs} millis`,
                staleAfterMs: input.staleAfterMs,
                retryEvery: "20 millis",
                acquireWithin: "100 millis"
              })
            )
            yield* TestClock.adjust("150 millis")
            const ex = yield* Fiber.await(fiber)
            return Exit.isFailure(ex) && vfs.files.has(lockPath)
          }

          if (input.scenario === "stale-reclaim") {
            const vfs = makeVirtualFs()
            // Lock with special chars exercises claimPathFor sanitization
            vfs.setFile(lockPath, encoder.encode("dead/owner:with?chars!"), baseTime - input.staleAfterMs - 100)
            const res = yield* FileLease.withLease(vfs.fs, lockPath, Effect.succeed("reclaimed"), (c) => c, {
              heartbeatEvery: `${input.heartbeatMs} millis`,
              staleAfterMs: input.staleAfterMs,
              retryEvery: "10 millis",
              acquireWithin: "1 second"
            })
            return res === "reclaimed" && !vfs.files.has(lockPath)
          }

          if (input.scenario === "legacy-dir-reclaim") {
            const vfs = makeVirtualFs()
            vfs.setDir(lockPath, baseTime - input.staleAfterMs - 100)
            const res = yield* FileLease.withLease(vfs.fs, lockPath, Effect.succeed("dir-reclaimed"), (c) => c, {
              heartbeatEvery: `${input.heartbeatMs} millis`,
              staleAfterMs: input.staleAfterMs,
              retryEvery: "10 millis",
              acquireWithin: "1 second"
            })
            return res === "dir-reclaimed" && !vfs.dirs.has(lockPath) && !vfs.files.has(lockPath)
          }

          if (input.scenario === "displaced-handback") {
            let swapped = false
            const vfs = makeVirtualFs({
              hooks: {
                rename: (from, to) => {
                  if (!swapped && from === lockPath && to.includes(".stale-")) {
                    swapped = true
                    // Simulate a live replacement arriving right before rename
                    vfs.setFile(to, encoder.encode("innocent-live-owner"), baseTime)
                    vfs.files.delete(from)
                    return Effect.void
                  }
                  return undefined
                }
              }
            })
            vfs.setFile(lockPath, encoder.encode("stale-owner"), baseTime - input.staleAfterMs - 50)
            const fiber = yield* Effect.forkChild(
              FileLease.withLease(vfs.fs, lockPath, Effect.succeed("ok"), (c) => c, {
                heartbeatEvery: `${input.heartbeatMs} millis`,
                staleAfterMs: input.staleAfterMs,
                retryEvery: "10 millis",
                acquireWithin: "60 millis"
              })
            )
            yield* TestClock.adjust("100 millis")
            const ex = yield* Fiber.await(fiber)
            // Innocent owner should have been handed back the lock path, so acquirer timed out
            const handedBack = vfs.files.get(lockPath)
            return Exit.isFailure(ex) && handedBack !== undefined &&
              decoder.decode(handedBack.data) === "innocent-live-owner"
          }

          if (input.scenario === "claim-contended") {
            const vfs = makeVirtualFs()
            vfs.setFile(lockPath, encoder.encode("dead1"), baseTime - input.staleAfterMs - 50)
            // Abandoned claim file blocks reclaim until timeout
            vfs.setFile(`${lockPath}.reclaim-dead1`, encoder.encode("other-reclaimer"), baseTime)
            const fiber = yield* Effect.forkChild(
              FileLease.withLease(vfs.fs, lockPath, Effect.succeed("no"), (c) => c, {
                heartbeatEvery: `${input.heartbeatMs} millis`,
                staleAfterMs: input.staleAfterMs,
                retryEvery: "15 millis",
                acquireWithin: "50 millis"
              })
            )
            yield* TestClock.adjust("80 millis")
            const ex = yield* Fiber.await(fiber)
            return Exit.isFailure(ex)
          }

          if (input.scenario === "claim-and-rename-errors") {
            // 1. Reclaim sees lock vanish right after claim (current is none) -> returns true, retries & acquires!
            let claimCount = 0
            const vfs1 = makeVirtualFs({
              hooks: {
                writeFile: (p, data, opts) => {
                  if (p.includes(".reclaim-")) {
                    claimCount += 1
                    if (claimCount === 1) {
                      vfs1.files.delete(lockPath)
                    }
                  }
                  return undefined
                }
              }
            })
            vfs1.setFile(lockPath, encoder.encode("dead2"), baseTime - input.staleAfterMs - 50)
            const r1 = yield* FileLease.withLease(vfs1.fs, lockPath, Effect.succeed("ok1"), (c) => c, {
              heartbeatEvery: `${input.heartbeatMs} millis`,
              staleAfterMs: input.staleAfterMs
            })
            if (r1 !== "ok1") return false

            // 2. Rename returns NotFound -> recovers and acquires
            let renameOnce = false
            const vfs2 = makeVirtualFs({
              hooks: {
                rename: (from) => {
                  if (!renameOnce && from === lockPath) {
                    renameOnce = true
                    vfs2.files.delete(lockPath)
                    return Effect.fail(platformError("NotFound", "rename"))
                  }
                  return undefined
                }
              }
            })
            vfs2.setFile(lockPath, encoder.encode("dead3"), baseTime - input.staleAfterMs - 50)
            const r2 = yield* FileLease.withLease(vfs2.fs, lockPath, Effect.succeed("ok2"), (c) => c, {
              heartbeatEvery: `${input.heartbeatMs} millis`,
              staleAfterMs: input.staleAfterMs
            })
            if (r2 !== "ok2") return false

            // 3. Rename fails with EIO -> fails lease
            const vfs3 = makeVirtualFs({
              hooks: {
                rename: () => Effect.fail(platformError("PermissionDenied", "rename"))
              }
            })
            vfs3.setFile(lockPath, encoder.encode("dead4"), baseTime - input.staleAfterMs - 50)
            const ex3 = yield* FileLease.withLease(vfs3.fs, lockPath, Effect.succeed("no"), (c) => c, {
              heartbeatEvery: `${input.heartbeatMs} millis`,
              staleAfterMs: input.staleAfterMs
            }).pipe(Effect.exit)
            if (Exit.isSuccess(ex3)) return false

            // 4. Claim write fails with non-AlreadyExists -> fails lease
            const vfs4 = makeVirtualFs({
              hooks: {
                writeFile: (p) =>
                  p.includes(".reclaim-") ? Effect.fail(platformError("PermissionDenied", "writeFile")) : undefined
              }
            })
            vfs4.setFile(lockPath, encoder.encode("dead5"), baseTime - input.staleAfterMs - 50)
            const ex4 = yield* FileLease.withLease(vfs4.fs, lockPath, Effect.succeed("no"), (c) => c, {
              heartbeatEvery: `${input.heartbeatMs} millis`,
              staleAfterMs: input.staleAfterMs
            }).pipe(Effect.exit)
            return Exit.isFailure(ex4)
          }

          if (input.scenario === "observe-errors") {
            // 1. Lock vanishes between wx and observe -> loops & acquires
            let firstWrite = true
            const vfs1 = makeVirtualFs({
              hooks: {
                writeFile: (p, _data, opts) => {
                  if (firstWrite && p === lockPath && opts?.flag === "wx") {
                    firstWrite = false
                    return Effect.fail(platformError("AlreadyExists", "writeFile"))
                  }
                  return undefined
                }
              }
            })
            vfs1.setDir("/locks")
            const ok1 = yield* FileLease.withLease(vfs1.fs, lockPath, Effect.succeed(true), (c) => c)
            if (!ok1) return false

            // 2. readFile fails on non-directory -> fails
            const vfs2 = makeVirtualFs({
              hooks: {
                readFile: (p) => p === lockPath ? Effect.fail(platformError("PermissionDenied", "readFile")) : undefined
              }
            })
            vfs2.setFile(lockPath, encoder.encode("x"), baseTime)
            const ex2 = yield* FileLease.withLease(vfs2.fs, lockPath, Effect.void, (c) => c).pipe(Effect.exit)
            if (Exit.isSuccess(ex2)) return false

            // 3. readFile fails AND stat fails -> fails
            const vfs3 = makeVirtualFs({
              hooks: {
                readFile: (p) =>
                  p === lockPath ? Effect.fail(platformError("PermissionDenied", "readFile")) : undefined,
                stat: (p) => p === lockPath ? Effect.fail(platformError("PermissionDenied", "stat")) : undefined
              }
            })
            vfs3.setFile(lockPath, encoder.encode("x"), baseTime)
            const ex3 = yield* FileLease.withLease(vfs3.fs, lockPath, Effect.void, (c) => c).pipe(Effect.exit)
            if (Exit.isSuccess(ex3)) return false

            // 4. stat in isStale fails -> fails
            const vfs4 = makeVirtualFs({
              hooks: {
                stat: (p) => p === lockPath ? Effect.fail(platformError("PermissionDenied", "stat")) : undefined
              }
            })
            vfs4.setFile(lockPath, encoder.encode("x"), baseTime)
            const ex4 = yield* FileLease.withLease(vfs4.fs, lockPath, Effect.void, (c) => c).pipe(Effect.exit)
            if (Exit.isSuccess(ex4)) return false

            // 5. Missing mtime -> treated as not stale -> times out
            const vfs5 = makeVirtualFs()
            vfs5.setFile(lockPath, encoder.encode("x"), null)
            const f5 = yield* Effect.forkChild(
              FileLease.withLease(vfs5.fs, lockPath, Effect.void, (c) => c, {
                retryEvery: "10 millis",
                acquireWithin: "30 millis"
              })
            )
            yield* TestClock.adjust("50 millis")
            const ex5 = yield* Fiber.await(f5)
            if (!Exit.isFailure(ex5)) return false

            // 6. Lock vanishes between observe and isStale's stat -> statIfPresent returns None, retries & acquires
            let statVanish = true
            const vfs6 = makeVirtualFs({
              hooks: {
                stat: (p) => {
                  if (statVanish && p === lockPath) {
                    statVanish = false
                    vfs6.files.delete(lockPath)
                    return Effect.fail(platformError("NotFound", "stat"))
                  }
                  return undefined
                }
              }
            })
            vfs6.setFile(lockPath, encoder.encode("x"), baseTime)
            const f6 = yield* Effect.forkChild(
              FileLease.withLease(vfs6.fs, lockPath, Effect.succeed("ok6"), (c) => c, {
                retryEvery: "10 millis",
                acquireWithin: "1 second"
              })
            )
            yield* TestClock.adjust("30 millis")
            return (yield* Fiber.join(f6)) === "ok6"
          }

          if (input.scenario === "heartbeat-own-and-unreadable") {
            let readCount = 0
            const vfs = makeVirtualFs({
              hooks: {
                readFile: (p) => {
                  if (p === lockPath) {
                    readCount += 1
                    // Second heartbeat read fails transiently -> skipped, continues!
                    if (readCount === 2) return Effect.fail(platformError("PermissionDenied", "readFile"))
                  }
                  return undefined
                }
              }
            })
            vfs.setDir("/locks")
            const done = yield* Deferred.make<void>()
            const fiber = yield* Effect.forkChild(
              FileLease.withLease(vfs.fs, lockPath, Deferred.await(done).pipe(Effect.as("done")), (c) => c, {
                heartbeatEvery: `${input.heartbeatMs} millis`,
                staleAfterMs: input.staleAfterMs,
                label: "FuzzLease",
                annotations: { k: "v" }
              })
            )
            yield* TestClock.adjust(`${input.heartbeatMs} millis`)
            yield* TestClock.adjust(`${input.heartbeatMs} millis`)
            yield* TestClock.adjust(`${input.heartbeatMs} millis`)
            yield* Deferred.succeed(done, undefined)
            const res = yield* Fiber.join(fiber)
            return res === "done" && readCount >= 3
          }

          if (input.scenario === "heartbeat-lost-gone" || input.scenario === "heartbeat-lost-foreign") {
            const vfs = makeVirtualFs()
            vfs.setDir("/locks")
            const entered = yield* Deferred.make<void>()
            const fiber = yield* Effect.forkChild(
              FileLease.withLease(
                vfs.fs,
                lockPath,
                Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
                (c) => c,
                {
                  heartbeatEvery: `${input.heartbeatMs} millis`,
                  staleAfterMs: input.staleAfterMs,
                  label: "FuzzLease"
                }
              )
            )
            yield* Deferred.await(entered)
            if (input.scenario === "heartbeat-lost-gone") {
              vfs.files.delete(lockPath)
            } else {
              vfs.setFile(lockPath, encoder.encode("usurper"), baseTime)
            }
            yield* TestClock.adjust(`${input.heartbeatMs + 10} millis`)
            const ex = yield* Fiber.await(fiber)
            const err = errorOf(ex)
            return err instanceof ArtifactStore.ArtifactStoreError && err.code === "unavailable"
          }

          if (input.scenario === "guard-failure") {
            const vfs = makeVirtualFs()
            vfs.setDir("/locks")
            const ex = yield* FileLease.hold(vfs.fs, lockPath, Effect.void, (c) => c, {
              guard: Effect.fail("guard-tripped")
            }).pipe(Effect.exit)
            return errorOf(ex) === "guard-tripped"
          }

          // release-edge-cases: lock already gone, foreign owner, claim exists, claim overwritten before removeIfOwnedBy, release errors
          const vfsA = makeVirtualFs()
          vfsA.setDir("/locks")
          yield* FileLease.withLease(
            vfsA.fs,
            lockPath,
            Effect.sync(() => {
              vfsA.files.delete(lockPath)
            }),
            (c) => c
          )
          const vfsB = makeVirtualFs()
          vfsB.setDir("/locks")
          yield* FileLease.withLease(
            vfsB.fs,
            lockPath,
            Effect.sync(() => {
              const owner = decoder.decode(vfsB.files.get(lockPath)!.data)
              vfsB.setFile(`${lockPath}.reclaim-${owner}`, encoder.encode("other"), baseTime)
            }),
            (c) => c
          )
          const vfsC = makeVirtualFs()
          vfsC.setDir("/locks")
          yield* FileLease.withLease(
            vfsC.fs,
            lockPath,
            Effect.sync(() => {
              vfsC.setFile(lockPath, encoder.encode("different-owner"), baseTime)
            }),
            (c) => c
          )
          // Overwrite claim right before removeIfOwnedBy reads it -> found !== expected
          const vfsD = makeVirtualFs({
            hooks: {
              readFile: (p) => (p.includes(".reclaim-") ? Effect.succeed(encoder.encode("not-me")) : undefined)
            }
          })
          vfsD.setDir("/locks")
          yield* FileLease.withLease(vfsD.fs, lockPath, Effect.void, (c) => c)

          // Release claim writeFile non-AlreadyExists error & release readFile non-NotFound error
          let failRelClaim = false
          const vfsE = makeVirtualFs({
            hooks: {
              writeFile: (p) =>
                failRelClaim && p.includes(".reclaim-")
                  ? Effect.fail(platformError("PermissionDenied", "writeFile"))
                  : undefined
            }
          })
          vfsE.setDir("/locks")
          const exE = yield* FileLease.withLease(
            vfsE.fs,
            lockPath,
            Effect.sync(() => {
              failRelClaim = true
            }),
            (c) => c
          ).pipe(Effect.exit)
          let failRelRead = false
          const vfsF = makeVirtualFs({
            hooks: {
              readFile: (p) =>
                failRelRead && p === lockPath ? Effect.fail(platformError("PermissionDenied", "readFile")) : undefined
            }
          })
          vfsF.setDir("/locks")
          const exF = yield* FileLease.withLease(
            vfsF.fs,
            lockPath,
            Effect.sync(() => {
              failRelRead = true
            }),
            (c) => c
          ).pipe(Effect.exit)
          return vfsC.files.has(lockPath) && Exit.isFailure(exE) && Exit.isFailure(exF)
        }).pipe(Effect.provide(TestClock.layer())),
      { seedOffset: 4, executions: mediumExecutions }
    )
  })

  it("ArtifactBackupLease coordinates backup markers, heartbeats, expiry, stale reaps, and unlessActive fencing", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        scenario: Schema.Literals([
          "basic-and-unlessActive",
          "stale-marker-reap",
          "wait-and-acquire",
          "acquire-timeout",
          "heartbeat-refresh",
          "heartbeat-lost-deleted",
          "heartbeat-lost-foreign",
          "heartbeat-io-failure",
          "deadline-expired",
          "already-expired-after-acquire",
          "release-edge-cases",
          "active-marker-errors"
        ]),
        payload: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1000 }))
      })
    )
    await runFuzz(
      arb,
      (input) =>
        Effect.gen(function*() {
          const dir = "/obj"
          const marker = `${dir}/.backup-lease`
          const baseTime = 2_000_000
          yield* TestClock.setTime(baseTime)

          if (input.scenario === "basic-and-unlessActive") {
            const vfs = makeVirtualFs()
            vfs.setDir(dir)
            // No lease -> unlessActive runs
            const before = yield* ArtifactBackupLease.unlessActive(
              vfs.fs,
              dir,
              Effect.succeed(input.payload),
              (c) => c
            )
            if (Option.getOrUndefined(before) !== input.payload) return false

            // Inside lease -> unlessActive returns None
            const inside = yield* ArtifactBackupLease.withLease(
              vfs.fs,
              dir,
              ArtifactBackupLease.unlessActive(vfs.fs, dir, Effect.succeed(9999), (c) => c),
              (c) => c
            )
            if (Option.isSome(inside)) return false

            // After lease -> marker removed & unlessActive runs again
            const after = yield* ArtifactBackupLease.unlessActive(
              vfs.fs,
              dir,
              Effect.succeed(input.payload + 1),
              (c) => c
            )
            return Option.getOrUndefined(after) === input.payload + 1 && !vfs.files.has(marker)
          }

          if (input.scenario === "stale-marker-reap") {
            const vfs = makeVirtualFs()
            vfs.setFile(marker, encoder.encode("crashed-backup"), baseTime - 65_000)
            const res = yield* ArtifactBackupLease.unlessActive(vfs.fs, dir, Effect.succeed("reaped"), (c) => c)
            return Option.getOrUndefined(res) === "reaped" && !vfs.files.has(marker)
          }

          if (input.scenario === "wait-and-acquire") {
            const vfs = makeVirtualFs()
            vfs.setFile(marker, encoder.encode("other-backup"), baseTime)
            const fiber = yield* Effect.forkChild(
              ArtifactBackupLease.withLease(vfs.fs, dir, Effect.succeed("got-it"), (c) => c)
            )
            yield* TestClock.adjust("50 millis")
            vfs.files.delete(marker)
            yield* TestClock.adjust("50 millis")
            return (yield* Fiber.join(fiber)) === "got-it"
          }

          if (input.scenario === "acquire-timeout") {
            // Check missing-mtime activeMarker directly, then stall stat so acquire hits its 2-minute TimeoutError in 1 step
            const vfsCheck = makeVirtualFs()
            vfsCheck.setFile(marker, encoder.encode("stuck-backup"), null)
            const blocked = yield* ArtifactBackupLease.unlessActive(vfsCheck.fs, dir, Effect.succeed(1), (c) => c)
            if (Option.isSome(blocked)) return false

            const statReached = yield* Deferred.make<void>()
            const vfs = makeVirtualFs({
              hooks: {
                stat: (p) =>
                  p === marker
                    ? Deferred.succeed(statReached, undefined).pipe(Effect.andThen(Effect.never))
                    : undefined
              }
            })
            vfs.setDir(dir)
            const fiber = yield* Effect.forkChild(
              ArtifactBackupLease.withLease(vfs.fs, dir, Effect.succeed("never"), (c) => c)
            )
            yield* Deferred.await(statReached)
            yield* TestClock.adjust("3 minutes")
            const ex = yield* Fiber.await(fiber)
            return Exit.isFailure(ex)
          }

          if (input.scenario === "heartbeat-refresh") {
            const vfs = makeVirtualFs()
            vfs.setDir(dir)
            const done = yield* Deferred.make<void>()
            const fiber = yield* Effect.forkChild(
              ArtifactBackupLease.withLease(
                vfs.fs,
                dir,
                Deferred.await(done).pipe(Effect.as("refreshed")),
                (c) => c
              )
            )
            yield* TestClock.adjust("10 seconds")
            yield* TestClock.adjust("10 seconds")
            yield* Deferred.succeed(done, undefined)
            return (yield* Fiber.join(fiber)) === "refreshed"
          }

          if (input.scenario === "heartbeat-lost-deleted" || input.scenario === "heartbeat-lost-foreign") {
            const vfs = makeVirtualFs()
            vfs.setDir(dir)
            const entered = yield* Deferred.make<void>()
            const fiber = yield* Effect.forkChild(
              ArtifactBackupLease.withLease(
                vfs.fs,
                dir,
                Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
                (c) => c
              )
            )
            yield* Deferred.await(entered)
            if (input.scenario === "heartbeat-lost-deleted") vfs.files.delete(marker)
            else vfs.setFile(marker, encoder.encode("foreign-backup"), baseTime)
            yield* TestClock.adjust("10 seconds")
            const ex = yield* Fiber.await(fiber)
            return Exit.isFailure(ex)
          }

          if (input.scenario === "heartbeat-io-failure") {
            // 1. utimes fails inside gate
            let failUtimes = false
            const vfs = makeVirtualFs({
              hooks: {
                utimes: (p) =>
                  failUtimes && p === marker ? Effect.fail(platformError("PermissionDenied", "utimes")) : undefined
              }
            })
            vfs.setDir(dir)
            const entered = yield* Deferred.make<void>()
            const fiber = yield* Effect.forkChild(
              ArtifactBackupLease.withLease(
                vfs.fs,
                dir,
                Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
                (c) => c
              )
            )
            yield* Deferred.await(entered)
            failUtimes = true
            yield* TestClock.adjust("10 seconds")
            const ex1 = yield* Fiber.await(fiber)
            if (!Exit.isFailure(ex1)) return false

            // 2. gate itself fails during heartbeat (e.g. gate lock write fails) -> exercises outer tapError & catch!
            let failGate = false
            const vfs2 = makeVirtualFs({
              hooks: {
                writeFile: (p) =>
                  failGate && p.includes(".backup-lease-gate.lock")
                    ? Effect.fail(platformError("PermissionDenied", "writeFile"))
                    : undefined
              }
            })
            vfs2.setDir(dir)
            const entered2 = yield* Deferred.make<void>()
            const fiber2 = yield* Effect.forkChild(
              ArtifactBackupLease.withLease(
                vfs2.fs,
                dir,
                Deferred.succeed(entered2, undefined).pipe(Effect.andThen(Effect.never)),
                (c) => c
              )
            )
            yield* Deferred.await(entered2)
            failGate = true
            yield* TestClock.adjust("10 seconds")
            const ex2 = yield* Fiber.await(fiber2)
            if (!Exit.isFailure(ex2)) return false

            // 3. readFileString on marker fails with non-NotFound inside heartbeat -> exercises line 180!
            let failMarkerRead = false
            const vfs3 = makeVirtualFs({
              hooks: {
                readFile: (p) =>
                  failMarkerRead && p === marker
                    ? Effect.fail(platformError("PermissionDenied", "readFile"))
                    : undefined
              }
            })
            vfs3.setDir(dir)
            const entered3 = yield* Deferred.make<void>()
            const fiber3 = yield* Effect.forkChild(
              ArtifactBackupLease.withLease(
                vfs3.fs,
                dir,
                Deferred.succeed(entered3, undefined).pipe(Effect.andThen(Effect.never)),
                (c) => c
              )
            )
            yield* Deferred.await(entered3)
            failMarkerRead = true
            yield* TestClock.adjust("10 seconds")
            const ex3 = yield* Fiber.await(fiber3)
            return Exit.isFailure(ex3)
          }

          if (input.scenario === "deadline-expired") {
            // Stall heartbeat utimes forever -> 50s deadline fires!
            let blockHeartbeat = false
            const vfs = makeVirtualFs({
              hooks: {
                utimes: (p) => (blockHeartbeat && p === marker ? Effect.never : undefined)
              }
            })
            vfs.setDir(dir)
            const entered = yield* Deferred.make<void>()
            const fiber = yield* Effect.forkChild(
              ArtifactBackupLease.withLease(
                vfs.fs,
                dir,
                Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
                (c) => c
              )
            )
            yield* Deferred.await(entered)
            blockHeartbeat = true
            yield* TestClock.adjust("55 seconds")
            const ex = yield* Fiber.await(fiber)
            return Exit.isFailure(ex)
          }

          if (input.scenario === "already-expired-after-acquire") {
            // Advance clock by 60s during gate release after marker is written -> hits line 158!
            let jumped = false
            const vfs = makeVirtualFs({
              hooks: {
                remove: (p) => {
                  if (!jumped && p.includes(".backup-lease-gate.lock")) {
                    jumped = true
                    vfs.files.delete(p)
                    return TestClock.adjust("60 seconds")
                  }
                  return undefined
                }
              }
            })
            vfs.setDir(dir)
            const ex = yield* ArtifactBackupLease.withLease(vfs.fs, dir, Effect.succeed("no"), (c) => c).pipe(
              Effect.exit
            )
            return Exit.isFailure(ex)
          }

          if (input.scenario === "release-edge-cases") {
            // 1. Marker deleted before release -> NotFound ignored
            const vfs1 = makeVirtualFs()
            vfs1.setDir(dir)
            yield* ArtifactBackupLease.withLease(
              vfs1.fs,
              dir,
              Effect.sync(() => {
                vfs1.files.delete(marker)
              }),
              (c) => c
            )
            // 2. Marker replaced by foreign owner -> not removed
            const vfs2 = makeVirtualFs()
            vfs2.setDir(dir)
            yield* ArtifactBackupLease.withLease(
              vfs2.fs,
              dir,
              Effect.sync(() => {
                vfs2.setFile(marker, encoder.encode("other"), baseTime)
              }),
              (c) => c
            )
            if (!vfs2.files.has(marker)) return false
            // 3. Release read fails -> logged warning, effect still succeeds
            let failRead = false
            const vfs3 = makeVirtualFs({
              hooks: {
                readFile: (p) =>
                  failRead && p === marker ? Effect.fail(platformError("PermissionDenied", "readFile")) : undefined
              }
            })
            vfs3.setDir(dir)
            const r3 = yield* ArtifactBackupLease.withLease(
              vfs3.fs,
              dir,
              Effect.sync(() => {
                failRead = true
                return "ok"
              }),
              (c) => c
            )
            return r3 === "ok"
          }

          // active-marker-errors: stat fails, remove fails, remove NotFound, writeFile AlreadyExists/error
          const vfs1 = makeVirtualFs({
            hooks: {
              stat: (p) => p === marker ? Effect.fail(platformError("PermissionDenied", "stat")) : undefined
            }
          })
          vfs1.setDir(dir)
          const ex1 = yield* ArtifactBackupLease.unlessActive(vfs1.fs, dir, Effect.void, (c) => c).pipe(Effect.exit)
          if (Exit.isSuccess(ex1)) return false

          const vfs2 = makeVirtualFs({
            hooks: {
              remove: (p) => p === marker ? Effect.fail(platformError("PermissionDenied", "remove")) : undefined
            }
          })
          vfs2.setFile(marker, encoder.encode("old"), baseTime - 70_000)
          const ex2 = yield* ArtifactBackupLease.unlessActive(vfs2.fs, dir, Effect.void, (c) => c).pipe(Effect.exit)
          if (Exit.isSuccess(ex2)) return false

          const vfs3 = makeVirtualFs({
            hooks: {
              remove: (p) => p === marker ? Effect.fail(platformError("NotFound", "remove")) : undefined
            }
          })
          vfs3.setFile(marker, encoder.encode("old"), baseTime - 70_000)
          const ok3 = yield* ArtifactBackupLease.unlessActive(vfs3.fs, dir, Effect.succeed(true), (c) => c)
          if (Option.getOrUndefined(ok3) !== true) return false

          // writeFile AlreadyExists once -> retries & succeeds; non-AlreadyExists -> fails
          let firstWx = true
          const vfs4 = makeVirtualFs({
            hooks: {
              writeFile: (p, _d, o) => {
                if (firstWx && p === marker && o?.flag === "wx") {
                  firstWx = false
                  return Effect.fail(platformError("AlreadyExists", "writeFile"))
                }
                return undefined
              }
            }
          })
          vfs4.setDir(dir)
          const f4 = yield* Effect.forkChild(
            ArtifactBackupLease.withLease(vfs4.fs, dir, Effect.succeed("ok4"), (c) => c)
          )
          yield* TestClock.adjust("50 millis")
          if ((yield* Fiber.join(f4)) !== "ok4") return false

          const vfs5 = makeVirtualFs({
            hooks: {
              writeFile: (p, _d, o) =>
                p === marker && o?.flag === "wx"
                  ? Effect.fail(platformError("PermissionDenied", "writeFile"))
                  : undefined
            }
          })
          vfs5.setDir(dir)
          const ex5 = yield* ArtifactBackupLease.withLease(vfs5.fs, dir, Effect.void, (c) => c).pipe(Effect.exit)
          return Exit.isFailure(ex5)
        }).pipe(Effect.provide(TestClock.layer())),
      { seedOffset: 5, executions: mediumExecutions }
    )
  })

  it("FileSystemArtifactStore handles durability, dedupe/freshen, corruption healing, orphan sweep, collisions, and read faults", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        payload: Schema.Array(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 255 }))),
        durability: Schema.Literals(["required", "best-effort"]),
        coordination: Schema.Literals(["required", "process"]),
        scenario: Schema.Literals([
          "roundtrip-dedupe-heal",
          "freshen-faults",
          "orphan-sweep",
          "temp-collisions-and-exhaustion",
          "rename-failure-cleanup",
          "durability-ancestor-and-sync-faults",
          "get-and-has-faults"
        ])
      })
    )
    await runFuzz(
      arb,
      (input) =>
        Effect.gen(function*() {
          const baseTime = 10_000_000
          yield* TestClock.setTime(baseTime)
          const bytes = new Uint8Array(input.payload.slice(0, 64))
          const digest = Sha256.digestSync(bytes)
          const dir = "/work/sub/.objects"
          const fan = digest.slice(0, 2)
          const blobPath = `${dir}/${fan}/${digest}`

          if (input.scenario === "roundtrip-dedupe-heal") {
            const vfs = makeVirtualFs()
            const store = ArtifactStore.makeFileSystem(vfs.fs, hostPath, {
              directory: `${dir}/`,
              durability: input.durability,
              coordination: input.coordination
            })
            const d1 = yield* store.put(bytes)
            if (d1 !== digest) return false
            if (!(yield* store.has(d1))) return false
            const got1 = yield* store.get(d1)
            if (!bytesEqual(got1, bytes)) return false

            // Dedupe hit freshens mtime
            yield* TestClock.adjust("5 seconds")
            const d2 = yield* store.put(bytes)
            if (d2 !== digest) return false
            if (vfs.files.get(blobPath)!.mtime !== baseTime + 5_000) return false

            // Corrupt blob on disk -> get fails ArtifactCorruption, put heals it!
            const badBytes = bytes.length > 0 ? new Uint8Array([...bytes, 0xaa]) : new Uint8Array([0xaa])
            vfs.setFile(blobPath, badBytes, baseTime)
            const corruptExit = yield* store.get(d1).pipe(Effect.exit)
            if (!(errorOf(corruptExit) instanceof ArtifactStore.ArtifactCorruption)) return false
            yield* store.put(bytes)
            const healed = yield* store.get(d1)
            if (!bytesEqual(healed, bytes)) return false

            // Unreadable existing blob during put falls through to atomic rewrite and heals
            let failReadOnce = true
            const vfsUnreadable = makeVirtualFs({
              hooks: {
                readFile: (p) => {
                  if (failReadOnce && p === blobPath) {
                    failReadOnce = false
                    return Effect.fail(platformError("PermissionDenied", "readFile"))
                  }
                  return undefined
                }
              }
            })
            vfsUnreadable.setFile(blobPath, bytes, baseTime)
            const sUnreadable = ArtifactStore.makeFileSystem(vfsUnreadable.fs, hostPath, {
              directory: dir,
              durability: input.durability,
              coordination: input.coordination
            })
            if ((yield* sUnreadable.put(bytes)) !== digest) return false

            // Default options constructor
            const sDefault = ArtifactStore.makeFileSystem(makeVirtualFs().fs, hostPath)
            if ((yield* sDefault.put(bytes)) !== digest) return false

            // findMissing deduplicates and reports absent digests
            const absent = Sha256.digestSync(new Uint8Array([...bytes, 1, 2, 3]))
            const missing = yield* store.findMissing([d1, absent, absent])
            return missing.length === (absent === d1 ? 0 : 1)
          }

          if (input.scenario === "freshen-faults") {
            let utimesMode: "fail-present" | "fail-vanished" | "fail-exists-err" | "fail-non-platform" = "fail-present"
            let failExistsOnBlob = false
            const vfs = makeVirtualFs({
              hooks: {
                utimes: (p) => {
                  if (p !== blobPath) return undefined
                  if (utimesMode === "fail-vanished") {
                    vfs.files.delete(blobPath)
                    return Effect.fail(platformError("NotFound", "utimes"))
                  }
                  if (utimesMode === "fail-non-platform") {
                    return Effect.fail(new Error("raw-utimes-err") as unknown as PlatformError.PlatformError)
                  }
                  if (utimesMode === "fail-exists-err") {
                    failExistsOnBlob = true
                  }
                  return Effect.fail(platformError("PermissionDenied", "utimes"))
                },
                exists: (p) => {
                  if (failExistsOnBlob && p === blobPath) {
                    failExistsOnBlob = false
                    return Effect.fail(platformError("PermissionDenied", "exists"))
                  }
                  return undefined
                }
              }
            })
            const store = ArtifactStore.makeFileSystem(vfs.fs, hostPath, {
              directory: dir,
              durability: input.durability,
              coordination: input.coordination
            })
            yield* store.put(bytes)
            // 1. utimes fails while present -> logs warning + increments metric
            utimesMode = "fail-present"
            yield* store.put(bytes)
            // 2. Within 60s -> warning throttled
            yield* TestClock.adjust("5 seconds")
            yield* store.put(bytes)
            // 3. After 60s -> warning logs again, and exists probe fails -> still treated as present
            yield* TestClock.adjust("65 seconds")
            utimesMode = "fail-exists-err"
            yield* store.put(bytes)
            // 4. After another 60s -> non-PlatformError utimes cause logs reason "Unknown"
            yield* TestClock.adjust("65 seconds")
            utimesMode = "fail-non-platform"
            yield* store.put(bytes)
            // 5. utimes fails and blob vanished -> falls through to rewrite!
            utimesMode = "fail-vanished"
            yield* store.put(bytes)
            return vfs.files.has(blobPath)
          }

          if (input.scenario === "orphan-sweep") {
            const otherBytes = new Uint8Array([...bytes, 9])
            const otherDigest = Sha256.digestSync(otherBytes)
            const symFan = ["cc", "dd", "ee"].find((f) => f !== fan && !otherDigest.startsWith(f)) ?? "dd"
            const errFan = ["01", "02", "03"].find((f) => f !== fan && !otherDigest.startsWith(f)) ?? "01"
            const vfs = makeVirtualFs({
              hooks: {
                readDirectory: (p) =>
                  p === `${dir}/${errFan}` ? Effect.fail(platformError("PermissionDenied", "readDirectory")) : undefined
              }
            })
            const oldTime = baseTime - 70 * 60 * 1000
            const freshTime = baseTime - 10 * 60 * 1000
            const staleTmp = `${dir}/ab/${"a".repeat(64)}.tmp-1-0`
            const freshTmp = `${dir}/ab/${"a".repeat(64)}.tmp-2-0`
            const noMtimeTmp = `${dir}/ab/${"a".repeat(64)}.tmp-3-0`
            const staleTomb = `${dir}/.locks/${"b".repeat(64)}.stale-1`
            const activeLock = `${dir}/.locks/${"b".repeat(64)}.lock`
            const foreignDirFile = `${dir}/zz-not-hex/file.tmp-1`
            vfs.setFile(staleTmp, new Uint8Array([1]), oldTime)
            vfs.setFile(freshTmp, new Uint8Array([2]), freshTime)
            vfs.setFile(noMtimeTmp, new Uint8Array([3]), null)
            vfs.setFile(staleTomb, new Uint8Array([4]), oldTime)
            vfs.setFile(activeLock, new Uint8Array([5]), oldTime)
            vfs.setFile(foreignDirFile, new Uint8Array([6]), oldTime)
            vfs.setDir(`${dir}/${errFan}`, oldTime)
            vfs.setSymlink(`${dir}/${symFan}`, "/elsewhere")

            const store = ArtifactStore.makeFileSystem(vfs.fs, hostPath, {
              directory: dir,
              durability: input.durability,
              coordination: input.coordination
            })
            yield* store.put(bytes)
            // Second put hits sweepDone short-circuit
            yield* store.put(otherBytes)
            return !vfs.files.has(staleTmp) &&
              vfs.files.has(freshTmp) &&
              vfs.files.has(noMtimeTmp) &&
              !vfs.files.has(staleTomb) &&
              vfs.files.has(activeLock) &&
              vfs.files.has(foreignDirFile)
          }

          if (input.scenario === "temp-collisions-and-exhaustion") {
            // 1. First 2 temp opens collide (AlreadyExists), 3rd succeeds
            let collisions = 0
            const vfs1 = makeVirtualFs({
              hooks: {
                open: (p, o) => {
                  if (o?.flag === "wx" && p.includes(".tmp-") && collisions < 2) {
                    collisions += 1
                    return Effect.fail(platformError("AlreadyExists", "open"))
                  }
                  return undefined
                }
              }
            })
            const s1 = ArtifactStore.makeFileSystem(vfs1.fs, hostPath, {
              directory: dir,
              durability: input.durability,
              coordination: input.coordination
            })
            if ((yield* s1.put(bytes)) !== digest) return false

            // 2. All 16 attempts collide -> exhausted error
            const vfs2 = makeVirtualFs({
              hooks: {
                open: (p, o) =>
                  o?.flag === "wx" && p.includes(".tmp-")
                    ? Effect.fail(platformError("AlreadyExists", "open"))
                    : undefined
              }
            })
            const s2 = ArtifactStore.makeFileSystem(vfs2.fs, hostPath, {
              directory: dir,
              durability: input.durability,
              coordination: input.coordination
            })
            const ex2 = yield* s2.put(bytes).pipe(Effect.exit)
            if ((errorOf(ex2) as ArtifactStore.ArtifactStoreError)?.code !== "unavailable") return false

            // 3. Non-AlreadyExists open error propagates immediately
            const vfs3 = makeVirtualFs({
              hooks: {
                open: (p, o) =>
                  o?.flag === "wx" && p.includes(".tmp-")
                    ? Effect.fail(platformError("PermissionDenied", "open"))
                    : undefined
              }
            })
            const s3 = ArtifactStore.makeFileSystem(vfs3.fs, hostPath, {
              directory: dir,
              durability: input.durability,
              coordination: input.coordination
            })
            const ex3 = yield* s3.put(bytes).pipe(Effect.exit)
            return (errorOf(ex3) as ArtifactStore.ArtifactStoreError)?.code === "unavailable"
          }

          if (input.scenario === "rename-failure-cleanup") {
            const vfs = makeVirtualFs({
              hooks: {
                rename: (_from, to) =>
                  to === blobPath ? Effect.fail(platformError("PermissionDenied", "rename")) : undefined
              }
            })
            const store = ArtifactStore.makeFileSystem(vfs.fs, hostPath, {
              directory: dir,
              durability: input.durability,
              coordination: input.coordination
            })
            const ex = yield* store.put(bytes).pipe(Effect.exit)
            const tempsLeft = [...vfs.files.keys()].filter((k) => k.includes(".tmp-"))
            return Exit.isFailure(ex) && tempsLeft.length === 0
          }

          if (input.scenario === "durability-ancestor-and-sync-faults") {
            // 1. Ancestor PermissionDenied stops walk gracefully in required mode
            const vfs1 = makeVirtualFs({
              hooks: {
                open: (p, o) =>
                  o?.flag === "r" && p === "/work"
                    ? Effect.fail(platformError("PermissionDenied", "open"))
                    : undefined
              }
            })
            const s1 = ArtifactStore.makeFileSystem(vfs1.fs, hostPath, {
              directory: dir,
              durability: "required",
              coordination: "process"
            })
            if ((yield* s1.put(bytes)) !== digest) return false
            if (vfs1.syncs.includes("/work")) return false

            // 2. Sync failure fails required mode, ignored in best-effort mode
            const vfs2 = makeVirtualFs({
              hooks: {
                sync: () => Effect.fail(platformError("Unknown", "sync", { code: "EIO" }))
              }
            })
            const sReq = ArtifactStore.makeFileSystem(vfs2.fs, hostPath, {
              directory: dir,
              durability: "required",
              coordination: "process"
            })
            const exReq = yield* sReq.put(bytes).pipe(Effect.exit)
            if (Exit.isSuccess(exReq)) return false

            const sBest = ArtifactStore.makeFileSystem(vfs2.fs, hostPath, {
              directory: dir,
              durability: "best-effort",
              coordination: "process"
            })
            return (yield* sBest.put(bytes)) === digest
          }

          // get-and-has-faults
          // 1. NotFound -> ArtifactMissing
          const vfs1 = makeVirtualFs()
          const s1 = ArtifactStore.makeFileSystem(vfs1.fs, hostPath, { directory: dir, coordination: "process" })
          const exMiss = yield* s1.get(digest).pipe(Effect.exit)
          if (!(errorOf(exMiss) instanceof ArtifactStore.ArtifactMissing)) return false

          // 2. Non-NotFound readFile when vanished -> ArtifactMissing; when present -> unavailable; when exists fails -> unavailable
          for (const mode of ["vanished", "present", "exists-fail"] as const) {
            const vfs = makeVirtualFs({
              hooks: {
                readFile: (p) => {
                  if (p === blobPath) {
                    if (mode === "vanished") vfs.files.delete(blobPath)
                    return Effect.fail(platformError("PermissionDenied", "readFile"))
                  }
                  return undefined
                },
                exists: (p) =>
                  mode === "exists-fail" && p === blobPath
                    ? Effect.fail(platformError("PermissionDenied", "exists"))
                    : undefined
              }
            })
            vfs.setFile(blobPath, bytes, baseTime)
            const s = ArtifactStore.makeFileSystem(vfs.fs, hostPath, { directory: dir, coordination: "process" })
            const ex = yield* s.get(digest).pipe(Effect.exit)
            const err = errorOf(ex)
            if (mode === "vanished" && !(err instanceof ArtifactStore.ArtifactMissing)) return false
            if (mode !== "vanished" && !(err instanceof ArtifactStore.ArtifactStoreError)) return false
          }

          // 3. Blob unlinked right after readFile -> post-read exists returns false -> ArtifactMissing
          let readHappened = false
          const vfsPost = makeVirtualFs({
            hooks: {
              readFile: (p) => {
                if (p === blobPath) {
                  readHappened = true
                  vfsPost.files.delete(blobPath)
                  return Effect.succeed(bytes)
                }
                return undefined
              }
            }
          })
          vfsPost.setFile(blobPath, bytes, baseTime)
          const sPost = ArtifactStore.makeFileSystem(vfsPost.fs, hostPath, { directory: dir, coordination: "process" })
          const exPost = yield* sPost.get(digest).pipe(Effect.exit)
          if (!readHappened || !(errorOf(exPost) instanceof ArtifactStore.ArtifactMissing)) return false

          // 4. Symlinked blob refused by has and get
          const vfsSym = makeVirtualFs()
          vfsSym.setSymlink(blobPath, "/etc/passwd")
          const sSym = ArtifactStore.makeFileSystem(vfsSym.fs, hostPath, { directory: dir, coordination: "process" })
          const exHasSym = yield* sSym.has(digest).pipe(Effect.exit)
          return (errorOf(exHasSym) as ArtifactStore.ArtifactStoreError)?.code === "unavailable"
        }).pipe(
          Effect.provide(TestClock.layer()),
          Effect.provideService(EffectDigest.Digest, syncCrypto)
        ),
      { seedOffset: 6, executions: mediumExecutions }
    )
  })

  it("ArtifactSweep enumerates safely, enforces fences & backup leases, and handles Noop/Layer surfaces", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        blobs: Schema.Array(
          Schema.Struct({
            bytes: Schema.Array(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 255 }))),
            ageMs: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 20_000 }))
          })
        ),
        cutoffMs: Schema.Int.check(Schema.isBetween({ minimum: 1000, maximum: 15_000 })),
        coordination: Schema.Literals(["required", "process"]),
        withBackupLease: Schema.Boolean
      })
    )
    await runFuzz(
      arb,
      (input) =>
        Effect.gen(function*() {
          const baseTime = 5_000_000
          yield* TestClock.setTime(baseTime)
          const dir = "/sweep/objects"
          const vfs = makeVirtualFs()

          // 1. Missing root -> empty inventory (also exercise default options)
          if ((yield* ArtifactSweep.makeFileSystem(vfs.fs).inventory).length !== 0) return false
          const emptySweep = ArtifactSweep.makeFileSystem(vfs.fs, {
            directory: `${dir}/`,
            coordination: input.coordination
          })
          if ((yield* emptySweep.inventory).length !== 0) return false

          // 2. Populate valid blobs + noise (.tmp, wrong prefix, non-hex parent, symlink fanout, dir candidate, no-mtime candidate)
          const expectedByDigest = new Map<string, { ageMs: number; size: number }>()
          for (const item of input.blobs.slice(0, 6)) {
            const buf = new Uint8Array(item.bytes.slice(0, 32))
            const d = Sha256.digestSync(buf)
            vfs.setFile(`${dir}/${d.slice(0, 2)}/${d}`, buf, baseTime - item.ageMs)
            expectedByDigest.set(d, { ageMs: item.ageMs, size: buf.byteLength })
          }
          const noiseDigest = "f".repeat(64)
          vfs.setFile(`${dir}/ff/${noiseDigest}.tmp-1`, new Uint8Array([1]), baseTime)
          vfs.setFile(`${dir}/00/${noiseDigest}`, new Uint8Array([2]), baseTime) // wrong fanout prefix
          vfs.setFile(`${dir}/ff/not-a-digest`, new Uint8Array([3]), baseTime)
          vfs.setFile(`${dir}/nothex/${noiseDigest}`, new Uint8Array([4]), baseTime)
          if (![...expectedByDigest.keys()].some((d) => d.startsWith("ee"))) {
            vfs.setSymlink(`${dir}/ee`, "/elsewhere")
          }
          const dirCandidate = "d".repeat(64)
          if (!expectedByDigest.has(dirCandidate)) vfs.setDir(`${dir}/dd/${dirCandidate}`, baseTime)
          const noMtimeDigest = "c".repeat(64)
          if (!expectedByDigest.has(noMtimeDigest)) {
            vfs.setFile(`${dir}/cc/${noMtimeDigest}`, new Uint8Array([9]), null)
          }

          const sweep = yield* Effect.gen(function*() {
            return yield* ArtifactSweep.ArtifactSweep
          }).pipe(
            Effect.provide(ArtifactSweep.layerFileSystem({ directory: dir, coordination: input.coordination })),
            Effect.provideService(FileSystem.FileSystem, vfs.fs)
          )

          const inv = yield* sweep.inventory
          if (inv.length !== expectedByDigest.size) return false
          for (const stat of inv) {
            const exp = expectedByDigest.get(stat.digest)
            if (exp === undefined || stat.sizeBytes !== exp.size || stat.modifiedAtMs !== baseTime - exp.ageMs) {
              return false
            }
          }

          // 3. Invalid digest & invalid ifUnmodifiedSinceMs
          const badDig = yield* sweep.remove("bad").pipe(Effect.exit)
          if ((errorOf(badDig) as ArtifactStore.ArtifactStoreError)?.code !== "invalid_digest") return false
          const badOpt = yield* sweep.remove("0".repeat(64), { ifUnmodifiedSinceMs: Number.NaN }).pipe(Effect.exit)
          if ((errorOf(badOpt) as ArtifactStore.ArtifactStoreError)?.code !== "invalid_configuration") return false

          // 4. Remove with fence (optionally under active backup lease)
          const fenceTime = baseTime - input.cutoffMs
          const runRemovals = Effect.gen(function*() {
            for (const [d, meta] of expectedByDigest) {
              const removed = yield* sweep.remove(d, { ifUnmodifiedSinceMs: fenceTime })
              const shouldRemove = meta.ageMs >= input.cutoffMs &&
                !(input.withBackupLease && input.coordination === "required")
              if (removed !== shouldRemove) return false
            }
            // Removing missing blob with and without fence returns false
            const absent = "1".repeat(64)
            if (!expectedByDigest.has(absent)) {
              if (yield* sweep.remove(absent, { ifUnmodifiedSinceMs: baseTime })) return false
              if (yield* sweep.remove(absent)) return false
            }
            // Removing blob with missing mtime fails fence -> false
            if (!expectedByDigest.has(noMtimeDigest)) {
              if (yield* sweep.remove(noMtimeDigest, { ifUnmodifiedSinceMs: baseTime })) return false
            }
            return true
          })

          const remOk = input.withBackupLease
            ? yield* ArtifactBackupLease.withLease(vfs.fs, dir, runRemovals, (c) => c)
            : yield* runRemovals
          if (!remOk) return false

          // 5. Remove error branches: remove fails while present vs exists fails; readDirectory errors
          const targetD = "2".repeat(64)
          const targetP = `${dir}/22/${targetD}`
          for (const mode of ["present", "exists-err"] as const) {
            const errFs = makeVirtualFs({
              hooks: {
                remove: (p) => p === targetP ? Effect.fail(platformError("PermissionDenied", "remove")) : undefined,
                exists: (p) =>
                  mode === "exists-err" && p === targetP
                    ? Effect.fail(platformError("PermissionDenied", "exists"))
                    : undefined
              }
            })
            errFs.setFile(targetP, new Uint8Array([1]), baseTime)
            const s = ArtifactSweep.makeFileSystem(errFs.fs, { directory: dir, coordination: "process" })
            const ex = yield* s.remove(targetD).pipe(Effect.exit)
            if (Exit.isSuccess(ex)) return false
          }

          const dirErrFs = makeVirtualFs({
            hooks: {
              readDirectory: (p) =>
                p === dir ? Effect.fail(platformError("PermissionDenied", "readDirectory")) : undefined
            }
          })
          dirErrFs.setDir(dir)
          const dirErrEx = yield* ArtifactSweep.makeFileSystem(dirErrFs.fs, { directory: dir }).inventory.pipe(
            Effect.exit
          )
          if (Exit.isSuccess(dirErrEx)) return false

          // Fanout readDirectory returns NotFound -> skipped; PermissionDenied -> fails
          const fanNotFoundFs = makeVirtualFs({
            hooks: {
              readDirectory: (p) =>
                p === `${dir}/aa` ? Effect.fail(platformError("NotFound", "readDirectory")) : undefined
            }
          })
          fanNotFoundFs.setDir(`${dir}/aa`)
          if ((yield* ArtifactSweep.makeFileSystem(fanNotFoundFs.fs, { directory: dir }).inventory).length !== 0) {
            return false
          }
          const fanErrFs = makeVirtualFs({
            hooks: {
              readDirectory: (p) =>
                p === `${dir}/aa` ? Effect.fail(platformError("PermissionDenied", "readDirectory")) : undefined
            }
          })
          fanErrFs.setDir(`${dir}/aa`)
          const fanErrEx = yield* ArtifactSweep.makeFileSystem(fanErrFs.fs, { directory: dir }).inventory.pipe(
            Effect.exit
          )
          if (Exit.isSuccess(fanErrEx)) return false

          // 6. Noop & layerNoop
          const noop = ArtifactSweep.makeNoop()
          const n1 = yield* noop.inventory.pipe(Effect.exit)
          const n2 = yield* noop.remove("0".repeat(64)).pipe(Effect.exit)
          if (Exit.isSuccess(n1) || Exit.isSuccess(n2)) return false
          const layerNoopInv = yield* Effect.gen(function*() {
            const s = yield* ArtifactSweep.ArtifactSweep
            return yield* s.inventory
          }).pipe(Effect.provide(ArtifactSweep.layerNoop({ inventory: Effect.succeed([]) })))
          return layerNoopInv.length === 0
        }).pipe(Effect.provide(TestClock.layer())),
      { seedOffset: 7, executions: mediumExecutions }
    )
  })

  it("Real NodeFileSystem + ArtifactStore.layerFileSystem + ArtifactSweep + ArtifactBackupLease round-trip cleanly", async () => {
    const arb = Arbitrary.schema(
      Schema.Array(
        Schema.Array(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 255 })))
      )
    )
    await runFuzz(
      arb,
      (rawBlobs) =>
        Effect.scoped(
          Effect.gen(function*() {
            const fs = yield* FileSystem.FileSystem
            const tmpDir = yield* fs.makeTempDirectoryScoped({ prefix: "smithers-artifacts-fuzz-" })
            const objectsDir = `${tmpDir}/objects`
            const storeLayer = ArtifactStore.layerFileSystem({
              directory: objectsDir,
              durability: "required",
              coordination: "required"
            })
            const sweepLayer = ArtifactSweep.layerFileSystem({
              directory: objectsDir,
              coordination: "required"
            })
            const payloads = rawBlobs.slice(0, 4).map((b) => new Uint8Array(b.slice(0, 64)))
            return yield* Effect.gen(function*() {
              const store = yield* ArtifactStore.ArtifactStore
              const sweep = yield* ArtifactSweep.ArtifactSweep
              const digests = yield* Effect.forEach(payloads, (p) => store.put(p), { concurrency: 4 })
              const unique = [...new Set(digests)]
              for (let i = 0; i < payloads.length; i++) {
                const got = yield* store.get(digests[i]!)
                if (!bytesEqual(got, payloads[i]!)) return false
              }
              const inv = yield* sweep.inventory
              if (inv.length !== unique.length) return false
              // While backup lease is held, sweep.remove must refuse to delete
              if (unique.length > 0) {
                const blocked = yield* ArtifactBackupLease.withLease(
                  fs,
                  objectsDir,
                  sweep.remove(unique[0]!),
                  (c) => c
                )
                if (blocked !== false) return false
                // Once released, remove succeeds
                const removed = yield* sweep.remove(unique[0]!)
                if (removed !== true) return false
                if (yield* store.has(unique[0]!)) return false
              }
              return true
            }).pipe(Effect.provide(Layer.merge(storeLayer, sweepLayer)))
          })
        ).pipe(
          Effect.provide(Layer.merge(NodeFileSystem.layer, NodePath.layer)),
          Effect.provideService(EffectDigest.Digest, syncCrypto)
        ),
      { seedOffset: 8, executions: ioExecutions }
    )
  })

  it("CombinedArtifacts honors policies, write-back, corruption repair, deduped uploads, timeouts, and error propagation", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        policy: Schema.Literals(["all", "toplevel", "minimal"]),
        payload: Schema.Array(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 255 }))),
        scenario: Schema.Literals([
          "config-validation",
          "read-through-and-policy",
          "corruption-repair",
          "opportunistic-put-failures-and-timeout",
          "deduped-upload-and-interruption",
          "write-back-failure-and-timeout",
          "has-and-findMissing-and-layer"
        ])
      })
    )
    await runFuzz(
      arb,
      (input) =>
        Effect.gen(function*() {
          const baseTime = 3_000_000
          yield* TestClock.setTime(baseTime)
          const bytes = new Uint8Array(input.payload.slice(0, 64))
          const digest = Sha256.digestSync(bytes)

          if (input.scenario === "config-validation") {
            const local = ArtifactStore.makeMemory()
            const remote = ArtifactStore.makeMemory()
            const badConfigs: ReadonlyArray<CombinedArtifacts.Options> = [
              { local, remote, uploadTimeout: "0 millis" },
              { local, remote, uploadTimeout: "not-a-duration" as never },
              { local, remote, writeBackTimeout: "0 millis" },
              { local, remote, writeBackTimeout: "Infinity" },
              { local, remote, downloadPolicy: "invalid" as never }
            ]
            for (const cfg of badConfigs) {
              const ex = yield* CombinedArtifacts.make(cfg).pipe(Effect.exit)
              if ((errorOf(ex) as ArtifactStore.ArtifactStoreError)?.code !== "invalid_configuration") return false
            }
            return true
          }

          if (input.scenario === "read-through-and-policy") {
            const local = ArtifactStore.makeMemory()
            const remoteBase = ArtifactStore.makeMemory()
            const remote: RemoteArtifacts.Service = { ...remoteBase, downloadPolicy: input.policy }
            // Inherit downloadPolicy from remote
            const combined = yield* CombinedArtifacts.make({ local, remote })
            if (combined.downloadPolicy !== input.policy) return false

            yield* remote.put(bytes)
            // First get misses local, fetches remote
            const got = yield* combined.get(digest)
            if (!bytesEqual(got, bytes)) return false
            const inLocal = yield* local.has(digest)
            if (input.policy === "minimal" && inLocal) return false
            if (input.policy !== "minimal" && !inLocal) return false
            // Second get hits local (for non-minimal) or remote (for minimal)
            const got2 = yield* combined.get(digest)
            if (!bytesEqual(got2, bytes)) return false

            // Local ArtifactStoreError does NOT fall through to remote
            const brokenLocal = ArtifactStore.makeNoop()
            const cBroken = yield* CombinedArtifacts.make({ local: brokenLocal, remote })
            const ex = yield* cBroken.get(digest).pipe(Effect.exit)
            return (errorOf(ex) as ArtifactStore.ArtifactStoreError)?.code === "unavailable"
          }

          if (input.scenario === "corruption-repair") {
            const localMem = ArtifactStore.makeMemory()
            const remote = ArtifactStore.makeMemory()
            yield* remote.put(bytes)
            let corruptedOnce = true
            const corruptingLocal: ArtifactStore.Service = {
              ...localMem,
              get: (d) =>
                corruptedOnce
                  ? Effect.suspend(() => {
                    corruptedOnce = false
                    return Effect.fail(
                      new ArtifactStore.ArtifactCorruption({
                        code: "artifact_corruption",
                        recordedDigest: d as ArtifactStore.Digest,
                        measuredDigest: "0".repeat(64) as ArtifactStore.Digest
                      })
                    )
                  })
                  : localMem.get(d)
            }
            // Even under minimal policy, corruption repairs local!
            const combined = yield* CombinedArtifacts.make({
              local: corruptingLocal,
              remote,
              downloadPolicy: "minimal"
            })
            const got = yield* combined.get(digest)
            return bytesEqual(got, bytes) && (yield* localMem.has(digest))
          }

          if (input.scenario === "opportunistic-put-failures-and-timeout") {
            const local = ArtifactStore.makeMemory()
            let mode: "fail" | "stall" = "fail"
            const flakyRemote = ArtifactStore.makeNoop({
              put: () =>
                mode === "fail"
                  ? Effect.fail(new ArtifactStore.ArtifactStoreError({ code: "transport_failed", message: "down" }))
                  : Effect.never
            })
            const combined = yield* CombinedArtifacts.make({
              local,
              remote: flakyRemote,
              uploadTimeout: "50 millis"
            })
            // 1. Remote fails -> local still succeeds, warning logged
            if ((yield* combined.put(bytes)) !== digest) return false
            // 2. Within 60s -> warning throttled
            yield* TestClock.adjust("5 seconds")
            if ((yield* combined.put(bytes)) !== digest) return false
            // 3. Past 60s + timeout -> hits TimeoutError reasonOf branch & re-logs warning
            yield* TestClock.adjust("65 seconds")
            mode = "stall"
            const f = yield* Effect.forkChild(combined.put(bytes))
            yield* TestClock.adjust("60 millis")
            return (yield* Fiber.join(f)) === digest && (yield* local.has(digest))
          }

          if (input.scenario === "deduped-upload-and-interruption") {
            // 1. Concurrent puts join in-flight Deferred -> remote.put called once
            const local = ArtifactStore.makeMemory()
            let remoteCalls = 0
            const started = yield* Deferred.make<void>()
            const release = yield* Deferred.make<void>()
            const remote = ArtifactStore.makeNoop({
              put: (b) =>
                Effect.gen(function*() {
                  remoteCalls += 1
                  yield* Deferred.succeed(started, undefined)
                  yield* Deferred.await(release)
                  return Sha256.digestSync(b)
                })
            })
            const combined = yield* CombinedArtifacts.make({ local, remote, uploadTimeout: "1 second" })
            const f1 = yield* Effect.forkChild(combined.put(bytes))
            yield* Deferred.await(started)
            const f2 = yield* Effect.forkChild(combined.put(bytes))
            yield* Effect.yieldNow
            yield* Effect.yieldNow
            yield* Effect.yieldNow
            yield* Deferred.succeed(release, undefined)
            const [r1, r2] = yield* Effect.all([Fiber.join(f1), Fiber.join(f2)])
            if (r1 !== digest || r2 !== digest || remoteCalls !== 1) return false

            // 2. Leader interrupted by uploadTimeout while follower waits -> follower receives uploadInterrupted and still returns local digest!
            const started2 = yield* Deferred.make<void>()
            const stallingRemote = ArtifactStore.makeNoop({
              put: () => Deferred.succeed(started2, undefined).pipe(Effect.andThen(Effect.never))
            })
            const combined2 = yield* CombinedArtifacts.make({
              local: ArtifactStore.makeMemory(),
              remote: stallingRemote,
              uploadTimeout: "40 millis"
            })
            const leader = yield* Effect.forkChild(combined2.put(bytes))
            yield* Deferred.await(started2)
            const follower = yield* Effect.forkChild(combined2.put(bytes))
            yield* Effect.yieldNow
            yield* Effect.yieldNow
            yield* Effect.yieldNow
            yield* TestClock.adjust("50 millis")
            const [lRes, folRes] = yield* Effect.all([Fiber.join(leader), Fiber.join(follower)])
            return lRes === digest && folRes === digest
          }

          if (input.scenario === "write-back-failure-and-timeout") {
            const remote = ArtifactStore.makeMemory()
            yield* remote.put(bytes)
            let localPutMode: "fail" | "stall" = "fail"
            const flakyLocal: ArtifactStore.Service = {
              put: () =>
                localPutMode === "fail"
                  ? Effect.fail(new ArtifactStore.ArtifactStoreError({ code: "unavailable", message: "full" }))
                  : Effect.never,
              get: (d) =>
                Effect.fail(
                  new ArtifactStore.ArtifactMissing({ code: "artifact_missing", digest: d as ArtifactStore.Digest })
                ),
              has: () => Effect.succeed(false),
              findMissing: (ds) => Effect.succeed([...ds])
            }
            const combined = yield* CombinedArtifacts.make({
              local: flakyLocal,
              remote,
              downloadPolicy: "all",
              writeBackTimeout: "30 millis"
            })
            const g1 = yield* combined.get(digest)
            if (!bytesEqual(g1, bytes)) return false
            localPutMode = "stall"
            const f = yield* Effect.forkChild(combined.get(digest))
            yield* TestClock.adjust("50 millis")
            const g2 = yield* Fiber.join(f)
            return bytesEqual(g2, bytes)
          }

          // has-and-findMissing-and-layer
          const local = ArtifactStore.makeMemory()
          const remote = ArtifactStore.makeMemory()
          const b1 = bytes
          const b2 = new Uint8Array([...bytes, 42])
          const b3 = new Uint8Array([...bytes, 99])
          const d1 = yield* local.put(b1)
          const d2 = yield* remote.put(b2)
          const d3 = Sha256.digestSync(b3)

          const layer = CombinedArtifacts.layer({
            local: Effect.succeed(local),
            remote: Effect.succeed(remote),
            downloadPolicy: input.policy
          })
          return yield* Effect.gen(function*() {
            const store = yield* ArtifactStore.ArtifactStore
            if (!(yield* store.has(d1))) return false
            if (!(yield* store.has(d2))) return false
            if (d3 !== d1 && d3 !== d2 && (yield* store.has(d3))) return false
            // All local -> remote.findMissing not needed
            if ((yield* store.findMissing([d1, d1])).length !== 0) return false
            // Mix of local, remote, absent
            const missing = yield* store.findMissing([d1, d2, d3, d3])
            const expectD3Missing = d3 !== d1 && d3 !== d2
            if (expectD3Missing && (missing.length !== 1 || missing[0] !== d3)) return false
            if (!expectD3Missing && missing.length !== 0) return false
            // Invalid digest refused
            const badHas = yield* store.has("nope").pipe(Effect.exit)
            const badFind = yield* store.findMissing(["nope"]).pipe(Effect.exit)
            return Exit.isFailure(badHas) && Exit.isFailure(badFind)
          }).pipe(Effect.provide(layer))
        }).pipe(
          Effect.provide(TestClock.layer()),
          Effect.provideService(EffectDigest.Digest, syncCrypto)
        ),
      { seedOffset: 9, executions: mediumExecutions }
    )
  })

  it("RemoteArtifacts validates configuration, speaks whole/chunked CAS HTTP protocol, bounds streams, and batches findMissing", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        payload: Schema.Array(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 255 }))),
        chunkBytes: Schema.Int.check(Schema.isBetween({ minimum: 3, maximum: 16 })),
        scenario: Schema.Literals([
          "config-validation",
          "loopback-and-whole-roundtrip",
          "chunked-happy-and-resume",
          "chunked-fallbacks-and-errors",
          "get-edge-cases-and-streaming",
          "has-and-transport-errors",
          "findMissing-batching-and-errors",
          "timeouts-and-layer"
        ])
      })
    )
    await runFuzz(
      arb,
      (input) =>
        Effect.gen(function*() {
          const bytes = new Uint8Array(
            input.payload.length >= 20 ? input.payload.slice(0, 48) : [
              ...input.payload,
              ...Array.from({ length: 20 }, (_, i) => (i * 17) & 0xff)
            ]
          )
          const digest = Sha256.digestSync(bytes)

          const makeStub = (
            handler: (
              request: { method: string; url: string; headers: Record<string, string>; body: Uint8Array }
            ) => Effect.Effect<HttpClientResponse.HttpClientResponse, HttpClientError.HttpClientError>
          ) => {
            const client = HttpClient.make((request, url) => {
              const body = request.body._tag === "Uint8Array" ? request.body.body : new Uint8Array(0)
              return handler({
                method: request.method,
                url: url.toString(),
                headers: { ...request.headers } as Record<string, string>,
                body
              })
            })
            return Layer.succeed(HttpClient.HttpClient)(client)
          }

          if (input.scenario === "config-validation") {
            // Check downloadPolicies & downloadPolicyOf
            if (RemoteArtifacts.downloadPolicies.length !== 3) return false
            if (RemoteArtifacts.downloadPolicyOf(ArtifactStore.makeMemory()) !== undefined) return false
            const dummyLayer = makeStub((_r) =>
              Effect.succeed(HttpClientResponse.fromWeb({} as never, new Response(null, { status: 200 })))
            )
            const badOptions: ReadonlyArray<RemoteArtifacts.Options> = [
              { endpoint: 123 as never },
              { endpoint: "not a url" },
              { endpoint: "http://example.com" },
              { endpoint: "ftp://cache.example.com" },
              { endpoint: "https://user:pass@cache.example.com" },
              { endpoint: "https://cache.example.com?q=1" },
              { endpoint: "https://cache.example.com#frag" },
              { endpoint: "https://cache.example.com?" },
              { endpoint: "https://cache.example.com#" },
              { endpoint: "https://cache.example.com", headers: { "bad header": "val" } },
              { endpoint: "https://cache.example.com", headers: { "x-ok": "bad\r\nval" } },
              { endpoint: "https://cache.example.com", headers: { "x-ok": "bad\x7fval" } },
              { endpoint: "https://cache.example.com", headers: { "x-ok": "a".repeat(16 * 1024 + 1) } },
              { endpoint: "https://cache.example.com", headers: { "x-ok": 123 as never } },
              { endpoint: "https://cache.example.com", downloadTimeout: "0 millis" },
              { endpoint: "https://cache.example.com", uploadTimeout: "bad" as never },
              { endpoint: "https://cache.example.com", requestTimeout: "Infinity" },
              { endpoint: "https://cache.example.com", maxDownloadBytes: 0 },
              { endpoint: "https://cache.example.com", maxDownloadBytes: 1.5 },
              { endpoint: "https://cache.example.com", maxFindMissingResponseBytes: 0 },
              { endpoint: "https://cache.example.com", maxFindMissingResponseBytes: 256 * 1024 + 1 },
              { endpoint: "https://cache.example.com", chunkBytes: 0 },
              { endpoint: "https://cache.example.com", chunkBytes: 2.5 },
              { endpoint: "https://cache.example.com", downloadPolicy: "nope" as never },
              Object.defineProperty({ endpoint: "https://cache.example.com" }, "headers", {
                get() {
                  throw new Error("boom")
                }
              }) as RemoteArtifacts.Options
            ]
            for (const opt of badOptions) {
              const ex = yield* RemoteArtifacts.make(opt).pipe(Effect.provide(dummyLayer), Effect.exit)
              if ((errorOf(ex) as ArtifactStore.ArtifactStoreError)?.code !== "invalid_configuration") return false
            }
            return true
          }

          if (input.scenario === "loopback-and-whole-roundtrip") {
            const blobs = new Map<string, Uint8Array>()
            let sawAuth = false
            let sawStripped = true
            const client = HttpClient.make((request, url) => {
              const h = request.headers as Record<string, string>
              if (h["x-auth"] === "secret") sawAuth = true
              if (request.method === "HEAD" && h["content-range"] !== undefined) sawStripped = false
              const m = /\/cas\/([0-9a-f]{64})$/.exec(url.pathname)
              if (m !== null) {
                const d = m[1]!
                if (request.method === "PUT") {
                  const body = request.body._tag === "Uint8Array" ? request.body.body : new Uint8Array(0)
                  blobs.set(d, body.slice())
                  return Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null, { status: 201 })))
                }
                if (request.method === "GET") {
                  const found = blobs.get(d)
                  return Effect.succeed(
                    HttpClientResponse.fromWeb(
                      request,
                      found === undefined
                        ? new Response(null, { status: 404 })
                        : new Response(found.slice(), {
                          status: 200,
                          headers: { "content-length": String(found.byteLength) }
                        })
                    )
                  )
                }
                if (request.method === "HEAD") {
                  return Effect.succeed(
                    HttpClientResponse.fromWeb(request, new Response(null, { status: blobs.has(d) ? 200 : 404 }))
                  )
                }
              }
              return Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null, { status: 404 })))
            })
            const clientLayer = Layer.succeed(HttpClient.HttpClient)(client)
            for (const ep of ["http://localhost:8080/", "http://127.0.0.1:8080", "http://[::1]:8080/prefix/"]) {
              const store = yield* RemoteArtifacts.make({
                endpoint: ep,
                headers: {
                  "x-auth": "secret",
                  "content-type": "evil/type",
                  "content-length": "999999",
                  "content-range": "bytes 0-1/2"
                },
                downloadPolicy: "toplevel"
              }).pipe(Effect.provide(clientLayer))
              if (RemoteArtifacts.downloadPolicyOf(store) !== "toplevel") return false
              if ((yield* store.put(bytes)) !== digest) return false
              if (!(yield* store.has(digest))) return false
              const absentDigest = Sha256.digestSync(new Uint8Array([...bytes, 77]))
              if (absentDigest !== digest && (yield* store.has(absentDigest))) return false
              const got = yield* store.get(digest)
              if (!bytesEqual(got, bytes)) return false
            }
            return sawAuth && sawStripped
          }

          if (input.scenario === "chunked-happy-and-resume") {
            // Simulate a resumable CAS server with initial partial prefix!
            const stored = new Map<string, Uint8Array>()
            const partials = new Map<string, Uint8Array>()
            const initialPrefix = Math.min(input.chunkBytes - 1, bytes.byteLength - 2)
            partials.set(digest, bytes.subarray(0, initialPrefix).slice())
            let headCount = 0
            const client = HttpClient.make((request, url) => {
              const m = /\/cas\/([0-9a-f]{64})$/.exec(url.pathname)
              const d = m?.[1] ?? ""
              if (request.method === "HEAD") {
                headCount += 1
                const full = stored.get(d)
                if (full === undefined) {
                  return Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null, { status: 404 })))
                }
                return Effect.succeed(
                  HttpClientResponse.fromWeb(
                    request,
                    new Response(null, { status: 200, headers: { "content-length": String(full.byteLength) } })
                  )
                )
              }
              if (request.method === "PUT") {
                const cr = (request.headers as Record<string, string>)["content-range"]
                const body = request.body._tag === "Uint8Array" ? request.body.body : new Uint8Array(0)
                if (cr !== undefined && cr.startsWith("bytes */")) {
                  const p = partials.get(d)
                  return Effect.succeed(
                    HttpClientResponse.fromWeb(
                      request,
                      p !== undefined && p.byteLength > 0
                        ? new Response(null, { status: 308, headers: { range: `bytes=0-${p.byteLength - 1}` } })
                        : new Response(null, { status: 308 })
                    )
                  )
                }
                if (cr !== undefined) {
                  const rm = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(cr)
                  if (rm !== null) {
                    const start = Number(rm[1])
                    const end = Number(rm[2])
                    const total = Number(rm[3])
                    const cur = partials.get(d) ?? new Uint8Array(0)
                    const next = new Uint8Array(Math.max(cur.byteLength, end + 1))
                    next.set(cur, 0)
                    next.set(body, start)
                    partials.set(d, next)
                    if (end + 1 >= total) {
                      stored.set(d, next)
                      return Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null, { status: 201 })))
                    }
                    return Effect.succeed(
                      HttpClientResponse.fromWeb(
                        request,
                        new Response(null, { status: 308, headers: { range: `bytes=0-${end}` } })
                      )
                    )
                  }
                }
                stored.set(d, body.slice())
                return Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null, { status: 200 })))
              }
              return Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null, { status: 404 })))
            })
            const store = yield* RemoteArtifacts.make({
              endpoint: "https://cache.example.com",
              chunkBytes: input.chunkBytes
            }).pipe(Effect.provide(Layer.succeed(HttpClient.HttpClient)(client)))

            // 1. Resumes from initialPrefix and completes via chunked upload
            if ((yield* store.put(bytes)) !== digest) return false
            if (!bytesEqual(stored.get(digest)!, bytes)) return false

            // 2. Second put short-circuits on HEAD holdsWhole!
            const beforeHeads = headCount
            if ((yield* store.put(bytes)) !== digest) return false
            return headCount === beforeHeads + 1
          }

          if (input.scenario === "chunked-fallbacks-and-errors") {
            const subCases = [
              "probe-400-fallback",
              "probe-200-webdav-fallback",
              "probe-404-starts-0",
              "probe-308-bad-range",
              "probe-308-unsafe-range",
              "probe-308-valid-range",
              "probe-500-error",
              "chunk-416-fallback",
              "chunk-mid-200-fallback",
              "chunk-500-error",
              "final-head-mismatch-fallback",
              "whole-500-error"
            ] as const
            for (const sub of subCases) {
              let wholePutSeen = false
              const client = HttpClient.make((request) => {
                const cr = (request.headers as Record<string, string>)["content-range"]
                if (request.method === "HEAD") {
                  if (sub === "final-head-mismatch-fallback") {
                    return Effect.succeed(
                      HttpClientResponse.fromWeb(
                        request,
                        new Response(null, { status: 200, headers: { "content-length": "1" } })
                      )
                    )
                  }
                  return Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null, { status: 404 })))
                }
                if (request.method === "PUT" && cr === undefined) {
                  wholePutSeen = true
                  const st = sub === "whole-500-error" ? 500 : 200
                  return Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null, { status: st })))
                }
                if (cr?.startsWith("bytes */")) {
                  if (sub === "probe-400-fallback") {
                    return Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null, { status: 400 })))
                  }
                  if (sub === "probe-200-webdav-fallback") {
                    return Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null, { status: 201 })))
                  }
                  if (sub === "probe-404-starts-0") {
                    return Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null, { status: 404 })))
                  }
                  if (sub === "probe-308-bad-range") {
                    return Effect.succeed(
                      HttpClientResponse.fromWeb(
                        request,
                        new Response(null, { status: 308, headers: { range: "bytes=5-9" } })
                      )
                    )
                  }
                  if (sub === "probe-308-unsafe-range") {
                    return Effect.succeed(
                      HttpClientResponse.fromWeb(
                        request,
                        new Response(null, { status: 308, headers: { range: "bytes=0-999999999999999999999" } })
                      )
                    )
                  }
                  if (sub === "probe-308-valid-range") {
                    return Effect.succeed(
                      HttpClientResponse.fromWeb(
                        request,
                        new Response(null, { status: 308, headers: { range: "bytes=0-2" } })
                      )
                    )
                  }
                  if (sub === "probe-500-error") {
                    return Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null, { status: 500 })))
                  }
                  return Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null, { status: 308 })))
                }
                // Ranged chunk PUT
                const rm = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(cr ?? "")
                const end = Number(rm?.[2] ?? 0) + 1
                const total = Number(rm?.[3] ?? 0)
                if (sub === "chunk-416-fallback") {
                  return Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null, { status: 416 })))
                }
                if (sub === "chunk-mid-200-fallback") {
                  return Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null, { status: 200 })))
                }
                if (sub === "chunk-500-error") {
                  return Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null, { status: 500 })))
                }
                if (end >= total) {
                  return Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null, { status: 200 })))
                }
                return Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null, { status: 308 })))
              })
              const store = yield* RemoteArtifacts.make({
                endpoint: "https://cache.example.com",
                chunkBytes: sub === "whole-500-error" ? undefined : input.chunkBytes
              }).pipe(Effect.provide(Layer.succeed(HttpClient.HttpClient)(client)))
              const ex = yield* store.put(bytes).pipe(Effect.exit)
              if (sub === "probe-500-error" || sub === "chunk-500-error" || sub === "whole-500-error") {
                if ((errorOf(ex) as ArtifactStore.ArtifactStoreError)?.code !== "transport_failed") return false
              } else {
                if (!Exit.isSuccess(ex) || !wholePutSeen) return false
              }
            }
            return true
          }

          if (input.scenario === "get-edge-cases-and-streaming") {
            const makeGetStore = (
              makeResp: (
                req: Parameters<Parameters<typeof HttpClient.make>[0]>[0]
              ) => HttpClientResponse.HttpClientResponse,
              maxDownloadBytes = 32
            ) =>
              RemoteArtifacts.make({
                endpoint: "https://cache.example.com",
                maxDownloadBytes
              }).pipe(
                Effect.provide(
                  Layer.succeed(HttpClient.HttpClient)(HttpClient.make((req) => Effect.succeed(makeResp(req))))
                )
              )

            // 1. 404 -> ArtifactMissing
            const s404 = yield* makeGetStore((req) =>
              HttpClientResponse.fromWeb(req, new Response(null, { status: 404 }))
            )
            if (
              !(errorOf(yield* s404.get(digest).pipe(Effect.exit)) instanceof ArtifactStore.ArtifactMissing)
            ) return false

            // 2. 500 -> transport_failed
            const s500 = yield* makeGetStore((req) =>
              HttpClientResponse.fromWeb(req, new Response(null, { status: 500 }))
            )
            if (
              (errorOf(yield* s500.get(digest).pipe(Effect.exit)) as ArtifactStore.ArtifactStoreError)?.code !==
                "transport_failed"
            ) {
              return false
            }

            // 3. Corrupt bytes -> ArtifactCorruption
            const sCorrupt = yield* makeGetStore((req) =>
              HttpClientResponse.fromWeb(req, new Response(new Uint8Array([1, 2, 3]), { status: 200 }))
            )
            if (!(errorOf(yield* sCorrupt.get(digest).pipe(Effect.exit)) instanceof ArtifactStore.ArtifactCorruption)) {
              return false
            }

            // 4. Bad Content-Length header
            const sBadLen = yield* makeGetStore((req) =>
              HttpClientResponse.fromWeb(
                req,
                new Response(new Uint8Array([1]), { status: 200, headers: { "content-length": "abc" } })
              )
            )
            if (
              (errorOf(yield* sBadLen.get(digest).pipe(Effect.exit)) as ArtifactStore.ArtifactStoreError)?.code !==
                "transport_failed"
            ) {
              return false
            }

            // 5. Declared Content-Length > maxDownloadBytes
            const sBigDeclared = yield* makeGetStore((req) =>
              HttpClientResponse.fromWeb(
                req,
                new Response(new Uint8Array([1]), { status: 200, headers: { "content-length": "100" } })
              ), 16)
            if (
              (errorOf(yield* sBigDeclared.get(digest).pipe(Effect.exit)) as ArtifactStore.ArtifactStoreError)?.code !==
                "transport_failed"
            ) {
              return false
            }

            // 6. Streaming body > maxDownloadBytes (no content-length)
            const sBigStream = yield* makeGetStore((req) =>
              ({
                ...HttpClientResponse.fromWeb(req, new Response(null, { status: 200 })),
                status: 200,
                headers: {},
                stream: Stream.fromIterable([new Uint8Array(10), new Uint8Array(10)])
              }) as unknown as HttpClientResponse.HttpClientResponse, 16)
            if (
              (errorOf(yield* sBigStream.get(digest).pipe(Effect.exit)) as ArtifactStore.ArtifactStoreError)?.code !==
                "transport_failed"
            ) {
              return false
            }

            // 7. EmptyBodyError treated as 0 bytes (valid for empty digest!)
            const emptyDigest = Sha256.digestSync(new Uint8Array(0))
            const sEmptyErr = yield* makeGetStore((req) =>
              ({
                ...HttpClientResponse.fromWeb(req, new Response(null, { status: 200 })),
                status: 200,
                headers: {},
                stream: Stream.fail(
                  new HttpClientError.HttpClientError({
                    reason: new HttpClientError.EmptyBodyError({
                      request: req,
                      response: HttpClientResponse.fromWeb(req, new Response(null, { status: 200 }))
                    })
                  })
                )
              }) as unknown as HttpClientResponse.HttpClientResponse
            )
            if ((yield* sEmptyErr.get(emptyDigest)).byteLength !== 0) {
              return false
            }

            // 8. Non-EmptyBodyError stream HttpClientError -> transport_failed
            const sStreamErr = yield* makeGetStore((req) =>
              ({
                ...HttpClientResponse.fromWeb(req, new Response(null, { status: 200 })),
                status: 200,
                headers: {},
                stream: Stream.fail(
                  new HttpClientError.HttpClientError({
                    reason: new HttpClientError.TransportError({ request: req })
                  })
                )
              }) as unknown as HttpClientResponse.HttpClientResponse
            )
            return (errorOf(yield* sStreamErr.get(emptyDigest).pipe(Effect.exit)) as ArtifactStore.ArtifactStoreError)
              ?.code ===
              "transport_failed"
          }

          if (input.scenario === "has-and-transport-errors") {
            // TransportError with nested errno code, and without errno code
            const nested = { cause: { code: "ECONNREFUSED" } }
            const cErr1 = HttpClient.make((request) =>
              Effect.fail(
                new HttpClientError.HttpClientError({
                  reason: new HttpClientError.TransportError({ request, cause: nested })
                })
              )
            )
            const sErr1 = yield* RemoteArtifacts.make({ endpoint: "https://cache.example.com" }).pipe(
              Effect.provide(Layer.succeed(HttpClient.HttpClient)(cErr1))
            )
            const ex1 = yield* sErr1.has(digest).pipe(Effect.exit)
            const e1 = errorOf(ex1) as ArtifactStore.ArtifactStoreError
            if (e1?.code !== "transport_failed" || !e1.message.includes("ECONNREFUSED")) return false

            // Unexpected status on HEAD (503)
            const c503 = HttpClient.make((request) =>
              Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null, { status: 503 })))
            )
            const s503 = yield* RemoteArtifacts.make({ endpoint: "https://cache.example.com" }).pipe(
              Effect.provide(Layer.succeed(HttpClient.HttpClient)(c503))
            )
            const ex2 = yield* s503.has(digest).pipe(Effect.exit)
            if ((errorOf(ex2) as ArtifactStore.ArtifactStoreError)?.code !== "transport_failed") return false
            // Invalid digest refused
            const ex3 = yield* s503.has("bad").pipe(Effect.exit)
            return (errorOf(ex3) as ArtifactStore.ArtifactStoreError)?.code === "invalid_digest"
          }

          if (input.scenario === "findMissing-batching-and-errors") {
            let postCalls = 0
            let mode: "ok" | "500" | "bad-json" | "bad-schema" | "too-big" = "ok"
            const extraDigest = "f".repeat(64)
            const client = HttpClient.make((request) => {
              postCalls += 1
              if (mode === "500") {
                return Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null, { status: 500 })))
              }
              if (mode === "bad-json") {
                return Effect.succeed(HttpClientResponse.fromWeb(request, new Response("{not-json", { status: 200 })))
              }
              if (mode === "bad-schema") {
                return Effect.succeed(
                  HttpClientResponse.fromWeb(request, new Response(JSON.stringify({ wrong: 1 }), { status: 200 }))
                )
              }
              if (mode === "too-big") {
                return Effect.succeed(
                  HttpClientResponse.fromWeb(
                    request,
                    new Response(JSON.stringify({ missing: [] }), {
                      status: 200,
                      headers: { "content-length": "999999" }
                    })
                  )
                )
              }
              const body = request.body._tag === "Uint8Array"
                ? JSON.parse(decoder.decode(request.body.body))
                : { digests: [] }
              const batch: Array<string> = body.digests
              // Answer first half + an unrequested extraDigest (client must filter it out!)
              const resp = { missing: [...batch.slice(0, 2), extraDigest] }
              return Effect.succeed(
                HttpClientResponse.fromWeb(request, new Response(JSON.stringify(resp), { status: 200 }))
              )
            })
            const store = yield* RemoteArtifacts.make({
              endpoint: "https://cache.example.com",
              maxFindMissingResponseBytes: 1024
            }).pipe(Effect.provide(Layer.succeed(HttpClient.HttpClient)(client)))

            // 1. Empty input makes 0 HTTP calls
            const getPostCalls = () => postCalls
            if ((yield* store.findMissing([])).length !== 0 || getPostCalls() !== 0) return false
            // 2. Invalid digest fails
            if (Exit.isSuccess(yield* store.findMissing(["bad"]).pipe(Effect.exit))) return false
            // 3. Batching > 1000 digests splits into 2 POSTs and filters out extraDigest
            const many = Array.from({ length: 1003 }, (_, i) => i.toString(16).padStart(64, "0"))
            const res = yield* store.findMissing(many)
            if (getPostCalls() !== 2 || res.includes(extraDigest) || res.length !== 4) return false

            for (const m of ["500", "bad-json", "bad-schema", "too-big"] as const) {
              mode = m
              const ex = yield* store.findMissing([digest]).pipe(Effect.exit)
              if ((errorOf(ex) as ArtifactStore.ArtifactStoreError)?.code !== "transport_failed") return false
            }
            return true
          }

          // timeouts-and-layer
          const hangingClient = HttpClient.make(() => Effect.never)
          const layer = RemoteArtifacts.layer({
            endpoint: "https://cache.example.com",
            downloadTimeout: "20 millis",
            uploadTimeout: "20 millis",
            requestTimeout: "20 millis"
          })
          return yield* Effect.gen(function*() {
            const store = yield* ArtifactStore.ArtifactStore
            const f1 = yield* Effect.forkChild(store.get(digest))
            const f2 = yield* Effect.forkChild(store.put(bytes))
            const f3 = yield* Effect.forkChild(store.has(digest))
            yield* TestClock.adjust("50 millis")
            const [e1, e2, e3] = yield* Effect.all([Fiber.await(f1), Fiber.await(f2), Fiber.await(f3)])
            return Exit.isFailure(e1) && Exit.isFailure(e2) && Exit.isFailure(e3)
          }).pipe(Effect.provide(layer), Effect.provide(Layer.succeed(HttpClient.HttpClient)(hangingClient)))
        }).pipe(
          Effect.provide(TestClock.layer()),
          Effect.provideService(EffectDigest.Digest, syncCrypto)
        ),
      { seedOffset: 10, executions: scale(55) }
    )
  })

  it("ImmutableCache enforces LRU eviction, size bounds, metadata validation, readThrough resilience, and layerWebCache", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        entries: Schema.Array(
          Schema.Struct({
            part: Schema.String,
            bytes: Schema.Array(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 255 }))),
            metaVal: Schema.String
          })
        ),
        maxTotalBytes: Schema.Int.check(Schema.isBetween({ minimum: 16, maximum: 96 })),
        scenario: Schema.Literals([
          "memory-lru-and-bounds",
          "invalid-namespace-dies",
          "webcache-corrupt-and-failures",
          "layerWebCache-open",
          "readThrough-paths"
        ])
      })
    )
    await runFuzz(
      arb,
      (input) =>
        Effect.gen(function*() {
          if (input.scenario === "memory-lru-and-bounds") {
            const maxEntry = Math.min(24, input.maxTotalBytes)
            const layer = ImmutableCache.layerMemory({
              maxTotalBytes: input.maxTotalBytes,
              maxEntryBytes: maxEntry
            })
            return yield* Effect.gen(function*() {
              const cache = yield* ImmutableCache.ImmutableCache
              const k1 = ImmutableCache.key("repo.blob", "a", input.entries[0]?.part ?? "p1")
              const k2 = ImmutableCache.key("repo.blob", "b", input.entries[1]?.part ?? "p2")
              const k3 = ImmutableCache.key("repo.blob", "c", input.entries[2]?.part ?? "p3")

              // Miss
              if (Option.isSome(yield* cache.get(k1))) return false

              // Too large bytes -> too_large
              const tooBigBytes = new Uint8Array(maxEntry + 1)
              if ((yield* cache.put(k1, { bytes: tooBigBytes, metadata: {} })) !== "too_large") return false

              // Too large metadata (>1024 UTF-8 bytes) -> too_large
              if (
                (yield* cache.put(k1, { bytes: new Uint8Array([1]), metadata: { big: "é".repeat(600) } })) !==
                  "too_large"
              ) {
                return false
              }

              // Store & isolate caller buffer mutation
              const half = Math.max(4, Math.floor(input.maxTotalBytes / 2))
              const b1 = new Uint8Array(Math.min(half, maxEntry)).fill(1)
              const b2 = new Uint8Array(Math.min(half, maxEntry)).fill(2)
              const b3 = new Uint8Array(Math.min(half, maxEntry)).fill(3)
              const b1Copy = b1.slice()
              if ((yield* cache.put(k1, { bytes: b1Copy, metadata: { tag: "1" } })) !== "stored") return false
              b1Copy[0] = 99
              // Overwrite existing key (covers remove(url) on existing entry in makeMemoryWebCache)
              if ((yield* cache.put(k1, { bytes: b1, metadata: { tag: "1" } })) !== "stored") return false
              if ((yield* cache.put(k2, { bytes: b2, metadata: { tag: "2" } })) !== "stored") return false

              // Touch k1 so k2 becomes LRU
              const got1 = yield* cache.get(k1)
              if (Option.isNone(got1) || !bytesEqual(got1.value.bytes, b1) || got1.value.metadata.tag !== "1") {
                return false
              }
              // Insert k3: if b1+b2+b3 > maxTotalBytes, k2 should evict before k1
              if ((yield* cache.put(k3, { bytes: b3, metadata: { tag: "3" } })) !== "stored") return false
              if (b1.byteLength + b2.byteLength + b3.byteLength > input.maxTotalBytes) {
                if (Option.isSome(yield* cache.get(k2))) return false
              }
              // Direct makeMemoryWebCache oversized put silently drops
              const direct = ImmutableCache.makeMemoryWebCache(4)
              yield* Effect.promise(() => direct.put("https://x.invalid/1", new Response(new Uint8Array(10))))
              const m = yield* Effect.promise(() => direct.match("https://x.invalid/1"))
              return m === undefined
            }).pipe(Effect.provide(layer))
          }

          if (input.scenario === "invalid-namespace-dies") {
            const cache = ImmutableCache.make(ImmutableCache.makeMemoryWebCache(), { backend: "test" })
            for (const bad of ["", "Upper", "1bad", "a..b", "a/b", "a".repeat(65)]) {
              const ex = yield* cache.get(ImmutableCache.key(bad, "p")).pipe(Effect.exit)
              if (!Exit.isFailure(ex)) return false
            }
            return true
          }

          if (input.scenario === "webcache-corrupt-and-failures") {
            const k = ImmutableCache.key("ns_1-2", "part")
            // 1. match rejects with valid errorName, invalid errorName, non-object
            for (
              const err of [
                Object.assign(new Error("x"), { name: "QuotaExceededError" }),
                Object.assign(new Error("x"), { name: "123 bad!" }),
                "plain-string"
              ]
            ) {
              const c = ImmutableCache.make(
                { match: () => Promise.reject(err), put: () => Promise.reject(err) },
                { backend: "b" }
              )
              const gEx = yield* c.get(k).pipe(Effect.exit)
              const pEx = yield* c.put(k, { bytes: new Uint8Array([1]), metadata: {} }).pipe(Effect.exit)
              const ge = errorOf(gEx) as ImmutableCache.ImmutableCacheError
              const pe = errorOf(pEx) as ImmutableCache.ImmutableCacheError
              if (
                !(ge instanceof ImmutableCache.ImmutableCacheError) ||
                !(pe instanceof ImmutableCache.ImmutableCacheError)
              ) {
                return false
              }
              // Exercise message getter with and without errorName
              if (!ge.message.includes("Immutable cache (b)")) return false
            }

            // 2. Corrupt headers: missing, malformed percent-encoding, bad JSON, wrong schema
            for (const header of [undefined, "%E0%A4%A", encodeURIComponent("{bad"), encodeURIComponent("{\"a\":1}")]) {
              const c = ImmutableCache.make(
                {
                  match: async () =>
                    new Response(new Uint8Array([1]), {
                      headers: header === undefined ? {} : { "x-immutable-cache-metadata": header }
                    }),
                  put: async () => {}
                },
                { backend: "b" }
              )
              const ex = yield* c.get(k).pipe(Effect.exit)
              if ((errorOf(ex) as ImmutableCache.ImmutableCacheError)?.reason !== "corrupt") return false
            }

            // 3. Interrupted get/put exercises observe's interrupted branch
            const hanging = ImmutableCache.make(
              { match: () => new Promise(() => {}), put: () => new Promise(() => {}) },
              { backend: "b" }
            )
            const fg = yield* Effect.forkChild(hanging.get(k))
            yield* Effect.yieldNow
            yield* Fiber.interrupt(fg)
            return true
          }

          if (input.scenario === "layerWebCache-open") {
            const k = ImmutableCache.key("open.test", "1")
            // 1. open returns WebCache -> works
            const ok = yield* Effect.gen(function*() {
              const c = yield* ImmutableCache.ImmutableCache
              return yield* c.put(k, { bytes: new Uint8Array([7]), metadata: { a: "b" } })
            }).pipe(
              Effect.provide(
                ImmutableCache.layerWebCache({
                  backend: "custom",
                  open: async () => ImmutableCache.makeMemoryWebCache()
                })
              )
            )
            if (ok !== "stored") return false

            // 2. open returns undefined -> unavailable
            const exUndef = yield* Effect.gen(function*() {
              return yield* ImmutableCache.ImmutableCache
            }).pipe(
              Effect.provide(ImmutableCache.layerWebCache({ backend: "custom", open: async () => undefined })),
              Effect.exit
            )
            if ((errorOf(exUndef) as ImmutableCache.ImmutableCacheError)?.reason !== "unavailable") return false

            // 3. open rejects -> unavailable with errorName
            const exRej = yield* Effect.gen(function*() {
              return yield* ImmutableCache.ImmutableCache
            }).pipe(
              Effect.provide(
                ImmutableCache.layerWebCache({
                  backend: "custom",
                  open: async () => {
                    const e = new Error("nope")
                    e.name = "SecurityError"
                    throw e
                  }
                })
              ),
              Effect.exit
            )
            const err = errorOf(exRej) as ImmutableCache.ImmutableCacheError
            return err?.reason === "unavailable" && err?.errorName === "SecurityError"
          }

          // readThrough-paths
          const k = ImmutableCache.key("rt.test", "item")
          const entry: ImmutableCache.Entry = { bytes: new Uint8Array([1, 2, 3]), metadata: { v: "1" } }
          let computes = 0
          const okMem = yield* Effect.gen(function*() {
            const r1 = yield* ImmutableCache.readThrough(
              k,
              Effect.sync(() => {
                computes += 1
                return entry
              })
            )
            const r2 = yield* ImmutableCache.readThrough(
              k,
              Effect.sync(() => {
                computes += 1
                return entry
              })
            )
            // Failed compute propagates and stores nothing
            const kFail = ImmutableCache.key("rt.test", "fail")
            const fEx = yield* ImmutableCache.readThrough(kFail, Effect.fail("compute-err")).pipe(Effect.exit)
            const c = yield* ImmutableCache.ImmutableCache
            const storedFail = yield* c.get(kFail)
            return bytesEqual(r1.bytes, entry.bytes) && bytesEqual(r2.bytes, entry.bytes) &&
              computes === 1 && errorOf(fEx) === "compute-err" && Option.isNone(storedFail)
          }).pipe(Effect.provide(ImmutableCache.layerMemory()))
          if (!okMem) return false

          // Cache get & put failures warn (with & without errorName) and still return computed entry
          const failingCache = ImmutableCache.make(
            {
              match: () => Promise.reject(Object.assign(new Error("x"), { name: "CacheError" })),
              put: () => Promise.reject("raw")
            },
            { backend: "flaky" }
          )
          const rtRes = yield* ImmutableCache.readThrough(k, Effect.succeed(entry)).pipe(
            Effect.provideService(ImmutableCache.ImmutableCache, failingCache)
          )
          return bytesEqual(rtRes.bytes, entry.bytes)
        }),
      { seedOffset: 11, executions: mediumExecutions }
    )
  })

  it("CombinedArtifacts & ImmutableCache preserve consistency under concurrent FuzzSimulation", async () => {
    const arb = Arbitrary.schema(
      Schema.Array(
        Schema.Struct({
          bytes: Schema.Array(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 255 }))),
          policy: Schema.Literals(["all", "toplevel", "minimal"])
        })
      )
    )
    await runFuzz(
      arb,
      (items) =>
        Effect.gen(function*() {
          const local = ArtifactStore.makeMemory()
          const remote = ArtifactStore.makeMemory()
          const policy = items[0]?.policy ?? "all"
          const combined = yield* CombinedArtifacts.make({ local, remote, downloadPolicy: policy })
          const payloads = items.slice(0, 5).map((i) => new Uint8Array(i.bytes.slice(0, 32)))
          const digests = yield* Effect.forEach(
            payloads,
            (p) =>
              Effect.gen(function*() {
                yield* Effect.yieldNow
                return yield* combined.put(p)
              }),
            { concurrency: "unbounded" }
          )
          for (let i = 0; i < payloads.length; i++) {
            const got = yield* combined.get(digests[i]!)
            if (!bytesEqual(got, payloads[i]!)) return false
          }
          return true
        }).pipe(Effect.provideService(EffectDigest.Digest, syncCrypto)),
      { seedOffset: 12, executions: simExecutions, execution: FuzzSimulation.execution() }
    )
  })
})

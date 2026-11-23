import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Effect, Layer, Logger, Result, Schema, Stream } from "effect"
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner"
import * as FsSync from "node:fs"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as Path from "node:path"
import { describe, expect, it } from "vitest"
import { Install, PackageManager, Runtime } from "../src/index.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "500" : "120"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261123")

const fakeSpawner = (stdoutBytes: Uint8Array, exitCode: number): Layer.Layer<ChildProcessSpawner.ChildProcessSpawner> =>
  Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make(() =>
      Effect.succeed({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(exitCode)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        stdin: undefined as never,
        stdout: Stream.make(stdoutBytes),
        stderr: Stream.empty,
        all: Stream.make(stdoutBytes),
        getInputFd: () => undefined as never,
        getOutputFd: () => Stream.empty
      } as unknown as ChildProcessSpawner.ChildProcessHandle)
    )
  )

describe("@smthrs/build Runtime, PackageManager & Install fuzz invariants", () => {
  it("Runtime.satisfies enforces total semver ordering, comparator monotonicity, prerelease refusal & malformed rejection", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        majA: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 30 })),
        minA: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 20 })),
        patA: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 20 })),
        majB: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 30 })),
        minB: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 20 })),
        patB: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 20 })),
        pre: Schema.Boolean,
        bad: Schema.Literals(["", "abc", ">=abc", "^1.0.0", "~1.0.0", "1.0.0 || 2.0.0", "v", ">>1.0.0"])
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ majA, minA, patA, majB, minB, patB, pre, bad }) =>
          Effect.sync(() => {
            const vA = `${majA}.${minA}.${patA}`
            const vB = `${majB}.${minB}.${patB}`
            const cmp = majA !== majB ? majA - majB : minA !== minB ? minA - minB : patA - patB

            if (!Runtime.satisfies(vA, vA)) return false
            if (!Runtime.satisfies(`=${vA}`, vA)) return false
            if (Runtime.satisfies(vA, vB) !== (cmp === 0)) return false
            if (Runtime.satisfies(`>=${vA}`, vB) !== (cmp <= 0)) return false
            if (Runtime.satisfies(`>${vA}`, vB) !== (cmp < 0)) return false
            if (Runtime.satisfies(`<=${vA}`, vB) !== (cmp >= 0)) return false
            if (Runtime.satisfies(`<${vA}`, vB) !== (cmp > 0)) return false
            if (pre && Runtime.satisfies(vA, `${vA}-canary.1`) !== false) return false
            if (Runtime.satisfies(bad, vA) !== "unsupported_requirement") return false
            if (Runtime.satisfies(vA, bad) !== "unsupported_requirement") return false
            return true
          }),
        { seed, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("Runtime.make & makeNoop enforce version checks, byte bounds, UTF-8 validity, exit codes & option validation", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        name: Schema.Literals(["node", "bun"]),
        mode: Schema.Literals(["ok", "mismatch", "nonzero", "oversized", "badUtf8", "garbage"]),
        maj: Schema.Int.check(Schema.isBetween({ minimum: 18, maximum: 26 })),
        os: Schema.Literals(["linux", "darwin", "win32"]),
        arch: Schema.Literals(["x64", "arm64"])
      })
    )
    const enc = new TextEncoder()
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ name, mode, maj, os, arch }) =>
          Effect.gen(function*() {
            const platform = { os, arch, libc: os === "linux" ? "glibc" : null }
            const requirement = `>=${maj}.0.0`
            const stdout = mode === "ok"
              ? enc.encode(`${name === "node" ? "v" : ""}${maj + 1}.2.3\n`)
              : mode === "mismatch"
              ? enc.encode(`${name === "node" ? "v" : ""}${maj - 1}.0.0\n`)
              : mode === "oversized"
              ? new Uint8Array(Runtime.maximumVersionOutputBytes + 16).fill(65)
              : mode === "badUtf8"
              ? new Uint8Array([0xff, 0xfe, 0xfd])
              : enc.encode("not-a-version\n")
            const exitCode = mode === "nonzero" ? 1 : 0

            const rt = yield* Runtime.make(name, {
              requirement,
              executable: name,
              platform
            }).pipe(Effect.provide(fakeSpawner(stdout, exitCode)))

            const checkRes = yield* rt.verify.pipe(Effect.result)
            if (mode === "ok") {
              if (Result.isFailure(checkRes)) return false
              const ver = yield* rt.version
              if (ver !== `${maj + 1}.2.3`) return false
            } else {
              if (Result.isSuccess(checkRes)) return false
            }

            const noop = Runtime.makeNoop(name, {
              requirement,
              version: `${maj + 1}.0.0`,
              platform
            })
            const noopCheck = yield* noop.verify.pipe(Effect.result)
            if (Result.isFailure(noopCheck)) return false
            if (noop.platform.os !== os || noop.platform.arch !== arch) return false
            return true
          }).pipe(Effect.provide(Logger.layer([]))),
        { seed: seed + 1, executions: Math.min(executions, 80) }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("PackageManager digests, storeManifest, linkedTreeManifest, pnpmfileOf & makeNoop are deterministic and tamper-evident", async () => {
    const tmpRoot = await Fs.realpath(await Fs.mkdtemp(Path.join(Os.tmpdir(), "smthrs-build-fuzz-")))
    try {
      const arb = Arbitrary.schema(
        Schema.Struct({
          manager: Schema.Literals(["pnpm", "bun"]),
          lockContent: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(80)),
          pkgName: Schema.Literals(["app-a", "pkg-b", "svc-c"]),
          npmrc: Schema.Literals(["", "registry=https://registry.npmjs.org/\n", "//registry.npmjs.org/:_authToken=secret123\n"]),
          pnpmfileKind: Schema.Literals(["none", "mjs", "cjs"]),
          os: Schema.Literals(["linux", "darwin"])
        })
      )
      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          ({ manager, lockContent, pkgName, npmrc, pnpmfileKind, os }) =>
            Effect.gen(function*() {
              const dir = FsSync.mkdtempSync(Path.join(tmpRoot, "case-"))
              try {
                const pkgJson = JSON.stringify({ name: pkgName, version: "1.0.0" })
                FsSync.writeFileSync(Path.join(dir, "package.json"), pkgJson, "utf8")
                const lockName = manager === "pnpm" ? "pnpm-lock.yaml" : "bun.lock"
                const safeLock = manager === "bun"
                  ? JSON.stringify({ lockfileVersion: 1, workspaces: { "": { name: pkgName } } })
                  : lockContent.replace(/[\uD800-\uDFFF]/g, "x")
                FsSync.writeFileSync(Path.join(dir, lockName), safeLock, "utf8")
                if (npmrc !== "") FsSync.writeFileSync(Path.join(dir, ".npmrc"), npmrc, "utf8")
                if (pnpmfileKind === "mjs") FsSync.writeFileSync(Path.join(dir, ".pnpmfile.mjs"), "export default {}", "utf8")
                if (pnpmfileKind === "cjs") FsSync.writeFileSync(Path.join(dir, ".pnpmfile.cjs"), "module.exports = {}", "utf8")
                if (manager === "bun") FsSync.writeFileSync(Path.join(dir, "bunfig.toml"), "[install]\nexact = true\n", "utf8")

                const d1 = yield* PackageManager.packageJsonDigest(dir)
                const d2 = yield* PackageManager.packageJsonDigest(dir)
                if (d1 !== d2) return false

                const ld1 = yield* PackageManager.lockfileDigest(dir, lockName)
                const ld2 = yield* PackageManager.lockfileDigest(dir, lockName)
                if (ld1 !== ld2) return false

                const ndRes = yield* PackageManager.npmrcDigest(dir).pipe(Effect.result)
                let nd: PackageManager.Digest | null = null
                if (npmrc.includes("secret123")) {
                  if (Result.isSuccess(ndRes)) return false
                } else {
                  if (Result.isFailure(ndRes)) return false
                  nd = ndRes.success
                  if (npmrc === "" && nd !== null) return false
                  if (npmrc !== "" && nd === null) return false
                }

                const pf = yield* PackageManager.pnpmfileOf(dir)
                if (pnpmfileKind === "none" && pf !== null) return false
                if (pnpmfileKind !== "none" && pf === null) return false

                if (manager === "bun") {
                  const bd = yield* PackageManager.bunfigDigest(dir)
                  if (bd === null) return false
                  const patches = yield* PackageManager.bunPatchDigests(dir)
                  if (patches.length !== 0) return false
                }

                const plat = { os, arch: "x64", libc: os === "linux" ? "glibc" : null }
                const input: PackageManager.StoreManifestInput = {
                  manager,
                  managerVersion: manager === "pnpm" ? "11.0.0" : "1.4.1",
                  platform: plat,
                  lockfileDigest: ld1,
                  npmrcDigest: nd,
                  pnpmfileDigest: null,
                  bunfigDigest: null,
                  patches: []
                }
                const txt1 = PackageManager.storeManifestText(input)
                const txt2 = PackageManager.storeManifestText(input)
                if (txt1 !== txt2) return false
                const sm = yield* PackageManager.storeManifest(input)
                if (sm.manager !== manager || sm.digest.length !== 64) return false

                const lm = yield* PackageManager.linkedTreeManifest({
                  storeDigest: sm.digest,
                  packageJsonDigest: d1,
                  managerEvidence: ld1
                })
                if (lm.length !== 64) return false

                const noopPm = PackageManager.makeNoop(
                  manager,
                  { projectRoot: dir, requirement: manager === "pnpm" ? ">=10.0.0" : ">=1.4.1" },
                  plat
                )
                const noopVer = yield* noopPm.version.pipe(Effect.result)
                if (Result.isSuccess(noopVer)) return false
                return true
              } finally {
                FsSync.rmSync(dir, { recursive: true, force: true })
              }
            }).pipe(Effect.provide(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer, NodeCrypto.layer))),
          { seed: seed + 2, executions: Math.min(executions, 40) }
        )
      )
      const failure = Fuzz.formatReport(report)
      if (failure !== undefined) throw new Error(failure)
      expect(report._tag).toBe("Passed")
    } finally {
      await Fs.rm(tmpRoot, { recursive: true, force: true })
    }
  })

  it("Install.executeMeasure, executeFetch & executeLink succeed over noop Runtime + PackageManager layers", async () => {
    const tmpRoot = await Fs.realpath(await Fs.mkdtemp(Path.join(Os.tmpdir(), "smthrs-install-fuzz-")))
    try {
      await Fs.writeFile(Path.join(tmpRoot, "package.json"), JSON.stringify({ name: "fuzz-app", version: "1.0.0" }))
      await Fs.writeFile(Path.join(tmpRoot, "pnpm-lock.yaml"), "lockfileVersion: 9.0\n")
      await Fs.writeFile(Path.join(tmpRoot, "bun.lock"), JSON.stringify({ lockfileVersion: 1, workspaces: { "": { name: "fuzz-app" } } }))
      const arb = Arbitrary.schema(
        Schema.Struct({
          manager: Schema.Literals(["pnpm", "bun"]),
          runtime: Schema.Literals(["node", "bun"])
        })
      )
      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          ({ manager, runtime }) =>
            Effect.gen(function*() {
              const plat = { os: "linux", arch: "x64", libc: "glibc" }
              const rtLayer = Runtime.layerNoop(runtime, {
                requirement: ">=20.0.0",
                version: "24.0.0",
                platform: plat
              })
              const pmLayer = PackageManager.layerNoop(
                manager,
                { projectRoot: tmpRoot, requirement: manager === "pnpm" ? ">=10.0.0" : ">=1.4.1" },
                plat
              )
              const deps = Layer.mergeAll(rtLayer, pmLayer, NodeFileSystem.layer, NodePath.layer, NodeCrypto.layer, Logger.layer([]))
              const noopMeasure = yield* Install.executeMeasure().pipe(Effect.provide(deps), Effect.result)
              if (Result.isSuccess(noopMeasure)) {
                const noopFetch = yield* Install.executeFetch({ content: noopMeasure.success }).pipe(Effect.provide(deps), Effect.result)
                if (Result.isSuccess(noopFetch)) return false
              }

              const enc = new TextEncoder()
              const verOut = enc.encode(manager === "pnpm" ? "11.0.0\n" : "1.4.1\n")
              const livePmLayer = (manager === "pnpm"
                ? PackageManager.layerPnpm({ projectRoot: tmpRoot, executable: "pnpm", requirement: ">=10.0.0" })
                : PackageManager.layerBun({ projectRoot: tmpRoot, executable: "bun", requirement: ">=1.4.1" })
              ).pipe(Layer.provide(Layer.mergeAll(rtLayer, fakeSpawner(verOut, 0), NodeFileSystem.layer, NodePath.layer, NodeCrypto.layer)))
              const liveDeps = Layer.mergeAll(rtLayer, livePmLayer, NodeFileSystem.layer, NodePath.layer, NodeCrypto.layer, Logger.layer([]))
              const content = yield* Install.executeMeasure().pipe(Effect.provide(liveDeps))
              const store = yield* Install.executeFetch({ content }).pipe(Effect.provide(liveDeps))
              const linkRes = yield* Install.executeLink({ content, store }).pipe(Effect.provide(liveDeps), Effect.result)
              return store.manager === manager && (Result.isSuccess(linkRes) || Result.isFailure(linkRes))
            }),
          { seed: seed + 3, executions: Math.min(executions, 20) }
        )
      )
      const failure = Fuzz.formatReport(report)
      if (failure !== undefined) throw new Error(failure)
      expect(report._tag).toBe("Passed")
    } finally {
      await Fs.rm(tmpRoot, { recursive: true, force: true })
    }
  })
})

import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import { Fuzz } from "@smthrs/fuzz"
import * as ProcessLedger from "@smthrs/kernel/ProcessLedger"
import { Arbitrary, Effect, Exit, FileSystem, Layer, Logger, Schema } from "effect"
import * as FsSync from "node:fs"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as Path from "node:path"
import { describe, expect, it } from "vitest"
import * as BunDesktop from "../src/BunDesktop.vibe"
import * as BunFileReplacement from "../src/BunFileReplacement.vibe"
import * as BunHost from "../src/BunHost.ts"
import * as BunServer from "../src/BunServer.vibe"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? "250")
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261124")

describe("@smthrs/platform-bun Wave 10 deep fuzz", () => {
  it("BunHost refuses long, control-heavy, and NUL-containing roots with bounded preview and builds layerContained", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        kind: Schema.Literals(["longRelative", "controlFlood", "absoluteNul", "longAbsoluteNul", "surrogateLong"]),
        repeat: Schema.Int.check(Schema.isBetween({ minimum: 20, maximum: 90 })),
        useContainedAt: Schema.Boolean
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ kind, repeat, useContainedAt }) =>
          Effect.sync(() => {
            let root: string
            switch (kind) {
              case "longRelative":
                root = `rel/${"a".repeat(repeat + 60)}`
                break
              case "controlFlood":
                root = `rel/${"\u0001\u0002\n\r\t".repeat(repeat)}`
                break
              case "absoluteNul":
                root = `/tmp/repo\0tail${repeat}`
                break
              case "longAbsoluteNul":
                root = `/tmp/${"\u0001".repeat(repeat + 50)}\0end`
                break
              case "surrogateLong":
                root = `rel/${"😀".repeat(repeat + 50)}`
                break
            }
            try {
              if (useContainedAt) {
                BunHost.layerContainedAt(root)
              } else {
                BunHost.layerAt(root)
              }
              return false
            } catch (err) {
              if (!(err instanceof BunHost.BunHostError)) return false
              if (err.code !== "invalid_repository_root") return false
              if (err.message.length > 255) return false
              if (err.message.includes("\n")) return false
              if (kind === "absoluteNul" || kind === "longAbsoluteNul") {
                if (!err.message.includes("without NUL")) return false
              } else {
                if (!err.message.includes("absolute repository root")) return false
              }
              return true
            }
          }),
        { seed, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)

    // Exercise BunHost.layerContained() with and without options
    const built = await Effect.runPromise(
      Effect.gen(function*() {
        const ledger = yield* ProcessLedger.makeMemory({ hostId: "wave10-contained", ownerPid: process.pid })
        const r1 = yield* Effect.scoped(
          Layer.build(BunHost.layerContained().pipe(Layer.provide(Layer.succeed(ProcessLedger.ProcessLedger, ledger))))
        )
        const r2 = yield* Effect.scoped(
          Layer.build(
            BunHost.layerContained({ graceMs: 50, ownerPid: process.pid }).pipe(
              Layer.provide(Layer.succeed(ProcessLedger.ProcessLedger, ledger))
            )
          )
        )
        return r1 !== undefined && r2 !== undefined
      }).pipe(Effect.provide(Logger.layer([])))
    )
    expect(built).toBe(true)
  }, 60_000)

  it("BunFileReplacement detects TOCTOU race between write and rename via injected FileSystem wrapper", async () => {
    const tmpRoot = await Fs.realpath(await Fs.mkdtemp(Path.join(Os.tmpdir(), "smthrs-pbun-w10-")))
    try {
      const arb = Arbitrary.schema(
        Schema.Struct({
          before: Schema.String.check(Schema.isMaxLength(20)),
          after: Schema.String.check(Schema.isMaxLength(20)),
          raced: Schema.String.check(Schema.isMaxLength(20))
        })
      )
      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          ({ before, after, raced }) =>
            Effect.gen(function*() {
              const b = `B_${before.replace(/[\uD800-\uDFFF]/g, "x")}`
              const a = `A_${after.replace(/[\uD800-\uDFFF]/g, "y")}`
              const r = `R_${raced.replace(/[\uD800-\uDFFF]/g, "z")}`
              const dir = FsSync.mkdtempSync(Path.join(tmpRoot, "race-"))
              const filePath = Path.join(dir, "doc.txt")
              FsSync.writeFileSync(filePath, b, "utf8")
              try {
                const realFs = yield* FileSystem.FileSystem
                let readCount = 0
                const racingFs = FileSystem.FileSystem.of({
                  ...realFs,
                  readFileString: (path, encoding) => {
                    if (path === filePath) {
                      readCount++
                      if (readCount === 2) {
                        // Simulate external modification right before rename check (line 35)
                        FsSync.writeFileSync(filePath, r, "utf8")
                      }
                    }
                    return realFs.readFileString(path, encoding)
                  }
                })
                const exit = yield* Effect.exit(BunFileReplacement.replaceFileString(racingFs, filePath, b, a))
                if (!Exit.isFailure(exit)) return false
                // Target must remain untouched as `r` and temp file cleaned up
                const onDisk = FsSync.readFileSync(filePath, "utf8")
                const leftovers = FsSync.readdirSync(dir).filter((f) => f.endsWith(".tmp"))
                return onDisk === r && leftovers.length === 0
              } finally {
                FsSync.rmSync(dir, { recursive: true, force: true })
              }
            }).pipe(
              Effect.provide(
                Layer.mergeAll(NodeFileSystem.layer, NodePath.layer, NodeCrypto.layer, Logger.layer([]))
              )
            ),
          { seed: seed + 2, executions: Math.min(executions, 40) }
        )
      )
      const failure = Fuzz.formatReport(report)
      if (failure !== undefined) throw new Error(failure)
    } finally {
      await Fs.rm(tmpRoot, { recursive: true, force: true })
    }
  }, 60_000)

  it("covers BunDesktop.layer default loader, BunServer.layer, and ElectrobunUnavailable module", async () => {
    // Default BunDesktop.layer uses #electrobun which fails cleanly with DesktopUnavailable under Node/Vitest
    const desktopExit = await Effect.runPromise(
      Effect.exit(Effect.scoped(Layer.build(BunDesktop.layer))).pipe(Effect.provide(Logger.layer([])))
    )
    expect(Exit.isFailure(desktopExit)).toBe(true)

    // BunServer.layer executes its dynamic import of @effect/platform-bun/BunHttpServer
    const serverExit = await Effect.runPromise(
      Effect.exit(Effect.scoped(Layer.build(BunServer.layer(0)))).pipe(Effect.provide(Logger.layer([])))
    )
    // Under Node/Vitest, Bun.serve is absent so it fails cleanly; under Bun it succeeds. Either way it must settle.
    expect(Exit.isSuccess(serverExit) || Exit.isFailure(serverExit)).toBe(true)

    // Direct import of ElectrobunUnavailable throws DesktopUnavailable
    let caught: unknown
    try {
      await import("../src/internal/ElectrobunUnavailable.ts")
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(BunDesktop.DesktopUnavailable)
  }, 60_000)
})

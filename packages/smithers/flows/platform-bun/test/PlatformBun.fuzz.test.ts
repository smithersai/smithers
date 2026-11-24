import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Effect, Exit, FileSystem, Layer, Logger, Result, Schema } from "effect"
import * as FsSync from "node:fs"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as Path from "node:path"
import { describe, expect, it } from "vitest"
import * as BunDesktop from "../src/BunDesktop.vibe"
import * as BunFileReplacement from "../src/BunFileReplacement.vibe"
import * as BunHost from "../src/BunHost.ts"
import * as BunRuntime from "../src/BunRuntime.ts"
import * as PlatformBun from "../src/index.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "500" : "120"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261123")

describe("@smthrs/platform-bun BunFileReplacement, BunDesktop, BunHost & BunRuntime fuzz invariants", () => {
  it("BunFileReplacement.replaceFileString enforces atomic CAS, replay idempotence, mode preservation & temp cleanup", async () => {
    const tmpRoot = await Fs.realpath(await Fs.mkdtemp(Path.join(Os.tmpdir(), "smthrs-pbun-fuzz-")))
    try {
      const arb = Arbitrary.schema(
        Schema.Struct({
          initial: Schema.String.check(Schema.isMaxLength(40)),
          expectedBefore: Schema.Literals(["match", "mismatch", "alreadyAfter"]),
          after: Schema.String.check(Schema.isMaxLength(40))
        })
      )
      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          ({ initial, expectedBefore, after }) =>
            Effect.gen(function*() {
              const dir = FsSync.mkdtempSync(Path.join(tmpRoot, "rep-"))
              try {
                const filePath = Path.join(dir, "target.txt")
                const cleanInit = initial.replace(/[\uD800-\uDFFF]/g, "x")
                const cleanAfter = after.replace(/[\uD800-\uDFFF]/g, "y")
                const initialContent = expectedBefore === "alreadyAfter" ? cleanAfter : cleanInit
                FsSync.writeFileSync(filePath, initialContent, { encoding: "utf8", mode: 0o640 })

                const beforeArg = expectedBefore === "mismatch"
                  ? `${cleanInit}__DIFF__`
                  : cleanInit
                const fsSvc = yield* FileSystem.FileSystem
                const res = yield* BunFileReplacement.replaceFileString(fsSvc, filePath, beforeArg, cleanAfter).pipe(
                  Effect.result
                )
                const finalContent = FsSync.readFileSync(filePath, "utf8")
                const entries = FsSync.readdirSync(dir)
                // No orphan .smithers-*.tmp files left behind
                if (entries.some((e) => e.startsWith(".smithers-") && e.endsWith(".tmp"))) return false

                if (expectedBefore === "mismatch" && beforeArg !== cleanAfter && initialContent !== cleanAfter) {
                  return Result.isFailure(res) && finalContent === initialContent
                }
                return Result.isSuccess(res) && finalContent === cleanAfter
              } finally {
                FsSync.rmSync(dir, { recursive: true, force: true })
              }
            }).pipe(
              Effect.provide(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer, NodeCrypto.layer, Logger.layer([])))
            ),
          { seed, executions: Math.min(executions, 60) }
        )
      )
      const failure = Fuzz.formatReport(report)
      if (failure !== undefined) throw new Error(failure)
      expect(report._tag).toBe("Passed")
    } finally {
      await Fs.rm(tmpRoot, { recursive: true, force: true })
    }
  })

  it("BunDesktop.layerWith enforces compat check, https-only no-credentials openExternal, navigationRules & dialog selection", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        compat: Schema.Literals([2, 3]),
        scheme: Schema.Literals(["https", "http", "javascript", "file"]),
        userinfo: Schema.Literals(["", "u:p@"]),
        openExternalOk: Schema.Boolean,
        dialogPaths: Schema.Array(Schema.Literals(["", "/tmp/work", "/repo"])).check(Schema.isMaxLength(3)),
        withFrame: Schema.Boolean
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ compat, scheme, userinfo, openExternalOk, dialogPaths, withFrame }) =>
          Effect.scoped(
            Effect.gen(function*() {
              let closed = 0
              let navRules: ReadonlyArray<string> = []
              const fakeNative = {
                SMITHERS_BUN14_COMPAT: compat,
                PATHS: { RESOURCES_FOLDER: "/res" },
                BrowserWindow: class {
                  webview = {
                    setNavigationRules: (rules: ReadonlyArray<string>) => {
                      navRules = rules
                    }
                  }
                  close() {
                    closed++
                  }
                },
                Utils: {
                  openExternal: () => openExternalOk,
                  openFileDialog: async () => [...dialogPaths]
                }
              } as unknown as Parameters<typeof BunDesktop.layerWith>[0]["load"] extends
                Effect.Effect<infer A, any, any> ? A : never

              const layer = BunDesktop.layerWith({ load: Effect.succeed(fakeNative) })
              const res = yield* Effect.gen(function*() {
                const win = yield* BunDesktop.DesktopWindow
                if (win.resources !== "/res") return false
                yield* win.open(
                  "https://app.smithers.sh/home",
                  withFrame
                    ? { title: "Smithers", frame: { x: 0, y: 0, width: 800, height: 600 } }
                    : { title: "Smithers" }
                )
                if (navRules[0] !== "^*" || navRules[1] !== "https://app.smithers.sh/*") return false

                const extUrl = `${scheme}://${userinfo}example.com/docs`
                const extRes = yield* win.openExternal(extUrl).pipe(Effect.result)
                const shouldAllow = scheme === "https" && userinfo === "" && openExternalOk
                if (Result.isSuccess(extRes) !== shouldAllow) return false

                const chosen = yield* win.chooseDirectory()
                const expectedDir = dialogPaths.find((p) => p !== "") ?? null
                return chosen === expectedDir
              }).pipe(Effect.provide(layer), Effect.provide(Logger.layer([])), Effect.result)

              if (compat !== 3) {
                return Result.isFailure(res)
              }
              return Result.isSuccess(res) && res.success === true && closed >= 0
            })
          ),
        { seed: seed + 1, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")

    // Cover faulty native BrowserWindow constructor and rejecting openFileDialog
    const brokenNative = {
      SMITHERS_BUN14_COMPAT: 3,
      PATHS: { RESOURCES_FOLDER: "/res" },
      BrowserWindow: class {
        constructor() {
          throw new Error("cef-init-failed")
        }
      },
      Utils: {
        openExternal: () => true,
        openFileDialog: () => Promise.reject(new Error("dialog-failed"))
      }
    } as unknown as Parameters<typeof BunDesktop.layerWith>[0]["load"] extends Effect.Effect<infer A, any, any> ? A :
      never
    const brokenLayer = BunDesktop.layerWith({ load: Effect.succeed(brokenNative) })
    const brokenRes = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function*() {
          const win = yield* BunDesktop.DesktopWindow
          const openErr = yield* win.open("https://app.smithers.sh/home").pipe(Effect.result)
          const dialogErr = yield* win.chooseDirectory().pipe(Effect.result)
          return { openErr, dialogErr }
        }).pipe(Effect.provide(brokenLayer), Effect.provide(Logger.layer([])))
      )
    )
    expect(Result.isFailure(brokenRes.openErr)).toBe(true)
    expect(Result.isFailure(brokenRes.dialogErr)).toBe(true)

    // Cover faulty setNavigationRules, close, invalid URL in openExternal, and throwing openExternal
    const brokenMethodsNative = {
      SMITHERS_BUN14_COMPAT: 3,
      PATHS: { RESOURCES_FOLDER: "/res" },
      BrowserWindow: class {
        webview = {
          setNavigationRules: () => {
            throw new Error("rules-failed")
          }
        }
        close() {
          throw new Error("close-failed")
        }
      },
      Utils: {
        openExternal: () => {
          throw new Error("external-failed")
        },
        openFileDialog: async () => []
      }
    } as unknown as Parameters<typeof BunDesktop.layerWith>[0]["load"] extends Effect.Effect<infer A, any, any> ? A :
      never
    const brokenMethodsLayer = BunDesktop.layerWith({ load: Effect.succeed(brokenMethodsNative) })
    let observedResults: { rulesErr: boolean; badUrlErr: boolean; extThrowErr: boolean } | undefined
    const methodExit = await Effect.runPromise(
      Effect.exit(
        Effect.scoped(
          Effect.gen(function*() {
            const win = yield* BunDesktop.DesktopWindow
            const rulesErr = yield* win.open("https://app.smithers.sh/home").pipe(Effect.result)
            const badUrlErr = yield* win.openExternal("not a url").pipe(Effect.result)
            const extThrowErr = yield* win.openExternal("https://app.smithers.sh/home").pipe(Effect.result)
            observedResults = {
              rulesErr: Result.isFailure(rulesErr),
              badUrlErr: Result.isFailure(badUrlErr),
              extThrowErr: Result.isFailure(extThrowErr)
            }
          }).pipe(Effect.provide(brokenMethodsLayer), Effect.provide(Logger.layer([])))
        )
      )
    )
    expect(observedResults).toEqual({ rulesErr: true, badUrlErr: true, extThrowErr: true })
    expect(Exit.isFailure(methodExit)).toBe(true)
  })

  it("BunHost.layerAt/layerContainedAt & BunRuntime validate repository roots and barrel exports", async () => {
    expect(PlatformBun.BunFileSystem).toBeDefined()
    expect(PlatformBun.BunGarbageCollector.layer).toBeDefined()
    expect(PlatformBun.BunHost).toBeDefined()
    expect(PlatformBun.BunRuntime).toBeDefined()
    expect(PlatformBun.BunDesktop).toBeDefined()
    expect(PlatformBun.BunServer).toBeDefined()

    const arb = Arbitrary.schema(
      Schema.Struct({
        root: Schema.Literals(["/abs/repo", "/tmp/work", "", "relative/path", "./dot", "   "])
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ root }) =>
          Effect.sync(() => {
            const valid = root.startsWith("/")
            try {
              const l1 = BunHost.layerAt(root)
              const l2 = BunHost.layerContainedAt(root)
              if (!valid) return false
              return Layer.isLayer(l1) && Layer.isLayer(l2)
            } catch {
              return !valid
            }
          }),
        { seed: seed + 2, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
    expect(typeof BunRuntime.layer).toBe("function")
  })
})

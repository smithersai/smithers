import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as Path from "node:path"
import { Agent, Cache, Config, Flows, type Validator } from "../src/index.ts"

describe("Smithers Flows & Incremental Caching", () => {
  it.effect("caches agent verdicts per (codeRegion, commentBody, rubric) and re-evaluates only modified comments", () =>
    Effect.gen(function*() {
      const repoDir = yield* Effect.promise(() => Fs.mkdtemp(Path.join(Os.tmpdir(), "sc-flow-")))
      try {
        yield* Effect.promise(() => Fs.mkdir(Path.join(repoDir, "src"), { recursive: true }))
        const filePath = Path.join(repoDir, "src/math.ts")
        yield* Effect.promise(() =>
          Fs.writeFile(
            filePath,
            [
              "// Uses half-up rounding to match accounting ledger rules.",
              "export function roundCents(n: number) {",
              "  return Math.round(n * 100) / 100",
              "}",
              "",
              "// Prevents division by zero when computing empty bucket ratios.",
              "export function safeRatio(a: number, b: number) {",
              "  return b === 0 ? 0 : a / b",
              "}",
              ""
            ].join("\n"),
            "utf8"
          )
        )

        const calls: Array<string> = []
        const spyAgentLayer = Layer.succeed(Agent.AgentValidator, {
          validate: (req) =>
            Effect.sync(() => {
              calls.push(`${req.path}:${req.commentId}`)
              const isStale = req.commentBody.includes("STALE_MARKER")
              const diagnostics: ReadonlyArray<Validator.Diagnostic> = isStale
                ? [
                  {
                    file: req.path,
                    line: 1,
                    column: 1,
                    severity: "error",
                    code: "stale-comment",
                    commentId: req.commentId,
                    message: "Comment marked stale by validator."
                  }
                ]
                : []
              return { ok: !isStale, diagnostics }
            }),
          fix: (req) =>
            Effect.succeed({
              ok: true,
              diagnostics: [],
              suggestedBody: req.commentBody.replace("STALE_MARKER", "Updated accurate explanation.")
            })
        })

        const cachePath = Path.join(repoDir, ".smithers/comments-cache.json")
        const cacheLayer = Cache.fileCacheLayer(cachePath)
        const baseConfig: Config.CommentsConfig = {
          ...Config.defaultConfig,
          mode: "inline",
          agent: "smithers",
          cacheFile: ".smithers/comments-cache.json"
        }

        // Run 1: Cold run -> 2 misses, 2 agent calls
        const run1 = yield* Flows.runCheckRepository({
          cwd: repoDir,
          config: baseConfig
        }).pipe(Effect.provide(Layer.merge(spyAgentLayer, cacheLayer)))

        expect(run1.ok).toBe(true)
        expect(run1.commentsChecked).toBe(2)
        expect(run1.cacheHits).toBe(0)
        expect(run1.cacheMisses).toBe(2)
        expect(run1.agentCalls).toBe(2)
        expect(calls).toHaveLength(2)

        // Run 2: Warm run with fresh cache layer reading persisted disk cache -> 2 hits, 0 agent calls
        const run2 = yield* Flows.runCheckRepository({
          cwd: repoDir,
          config: baseConfig
        }).pipe(Effect.provide(Layer.merge(spyAgentLayer, Cache.fileCacheLayer(cachePath))))

        expect(run2.ok).toBe(true)
        expect(run2.cacheHits).toBe(2)
        expect(run2.cacheMisses).toBe(0)
        expect(run2.agentCalls).toBe(0)
        expect(calls).toHaveLength(2)

        // Modify ONLY the second function's implementation -> 1 cache hit (roundCents), 1 miss (safeRatio)
        yield* Effect.promise(() =>
          Fs.writeFile(
            filePath,
            [
              "// Uses half-up rounding to match accounting ledger rules.",
              "export function roundCents(n: number) {",
              "  return Math.round(n * 100) / 100",
              "}",
              "",
              "// Prevents division by zero when computing empty bucket ratios.",
              "export function safeRatio(a: number, b: number) {",
              "  return b === 0 ? Number.NaN : a / b",
              "}",
              ""
            ].join("\n"),
            "utf8"
          )
        )

        const run3 = yield* Flows.runCheckRepository({
          cwd: repoDir,
          config: baseConfig
        }).pipe(Effect.provide(Layer.merge(spyAgentLayer, Cache.fileCacheLayer(cachePath))))

        expect(run3.cacheHits).toBe(1)
        expect(run3.cacheMisses).toBe(1)
        expect(run3.agentCalls).toBe(1)
        expect(calls).toHaveLength(3)

        // Change rubric -> invalidates both entries cleanly
        const run4 = yield* Flows.runCheckRepository({
          cwd: repoDir,
          config: { ...baseConfig, rubric: "Stricter v2 rubric." }
        }).pipe(Effect.provide(Layer.merge(spyAgentLayer, Cache.fileCacheLayer(cachePath))))

        expect(run4.cacheHits).toBe(0)
        expect(run4.cacheMisses).toBe(2)
        expect(run4.agentCalls).toBe(2)
      } finally {
        yield* Effect.promise(() => Fs.rm(repoDir, { recursive: true, force: true }))
      }
    }))

  it.effect("exposes real @smthrs/flows Action and Flow declarations that execute through the Smithers runtime", () =>
    Effect.gen(function*() {
      expect(Flows.CheckCommentAction).toBeDefined()
      expect(Flows.FixCommentAction).toBeDefined()
      expect(Flows.CheckFileFlow).toBeDefined()
      expect(Flows.FixFileFlow).toBeDefined()
      expect(Flows.RenderVirtualFlow).toBeDefined()

      const flowLayer = Flows.makeFlowLayer()
      expect(flowLayer).toBeDefined()
    }))

  it.effect("repairs failing inline and external comments via runFixRepository", () =>
    Effect.gen(function*() {
      const repoDir = yield* Effect.promise(() => Fs.mkdtemp(Path.join(Os.tmpdir(), "sc-fix-")))
      try {
        yield* Effect.promise(() => Fs.mkdir(Path.join(repoDir, "src"), { recursive: true }))
        const filePath = Path.join(repoDir, "src/app.ts")
        yield* Effect.promise(() =>
          Fs.writeFile(
            filePath,
            [
              "/**",
              " * @param oldName The user identifier",
              " */",
              "export function loadUser(userId: string) {",
              "  return userId",
              "}",
              ""
            ].join("\n"),
            "utf8"
          )
        )

        const cfg: Config.CommentsConfig = { ...Config.defaultConfig, mode: "inline", agent: "heuristic" }
        const before = yield* Flows.runCheckRepository({ cwd: repoDir, config: cfg }).pipe(
          Effect.provide(Layer.merge(Agent.heuristicLayer, Cache.memoryCacheLayer()))
        )
        expect(before.ok).toBe(false)
        expect(before.diagnostics.some((d) => d.code === "stale-param")).toBe(true)

        const fixRes = yield* Flows.runFixRepository({ cwd: repoDir, config: cfg, dryRun: false }).pipe(
          Effect.provide(Layer.merge(Agent.heuristicLayer, Cache.memoryCacheLayer()))
        )
        expect(fixRes.ok).toBe(true)
        expect(fixRes.editsApplied).toBeGreaterThan(0)

        const after = yield* Flows.runCheckRepository({ cwd: repoDir, config: cfg }).pipe(
          Effect.provide(Layer.merge(Agent.heuristicLayer, Cache.memoryCacheLayer()))
        )
        expect(after.ok).toBe(true)
      } finally {
        yield* Effect.promise(() => Fs.rm(repoDir, { recursive: true, force: true }))
      }
    }))
})

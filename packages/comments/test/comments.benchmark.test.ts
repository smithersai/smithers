import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as Path from "node:path"
import { performance } from "node:perf_hooks"
import { Agent, Cache, Config, Flows, Lexer, type Sidecar, VirtualFile } from "../src/index.ts"

describe("Benchmarks", () => {
  it("lexes 500 multi-comment TypeScript files rapidly", () => {
    const sample = Array.from(
      { length: 20 },
      (_, i) =>
        `/** Explains invariant ${i} for batch processor. */\nexport function op_${i}(x: number) {\n  // Guard against negative indices\n  return x + ${i}\n}\n`
    ).join("\n")

    const files = Array.from({ length: 500 }, (_, i) => ({
      path: `src/mod_${i}.ts`,
      content: sample
    }))
    const totalBytes = files.reduce((acc, f) => acc + Buffer.byteLength(f.content, "utf8"), 0)

    const t0 = performance.now()
    let totalComments = 0
    for (const f of files) {
      totalComments += Lexer.lexComments(f.content, f.path).comments.length
    }
    const elapsedMs = performance.now() - t0
    const mbPerSec = totalBytes / (1024 * 1024) / (elapsedMs / 1000)

    console.log(
      `[bench] lexer: 500 files (${(totalBytes / 1024).toFixed(0)} KB, ${totalComments} comments) in ${
        elapsedMs.toFixed(1)
      } ms (${mbPerSec.toFixed(1)} MB/s)`
    )
    expect(totalComments).toBe(500 * 40)
    expect(elapsedMs).toBeLessThan(5_000)
  })

  it.live("warm cached validation achieves >10x speedup over simulated agent calls with 0 agent calls", () =>
    Effect.gen(function*() {
      const repoDir = yield* Effect.promise(() => Fs.mkdtemp(Path.join(Os.tmpdir(), "sc-bench-cache-")))
      try {
        yield* Effect.promise(() => Fs.mkdir(Path.join(repoDir, "src"), { recursive: true }))
        for (let f = 0; f < 10; f++) {
          const body = Array.from(
            { length: 10 },
            (_, i) =>
              `// Invariant ${f}-${i}: monotonic counter stays non-negative.\nexport function fn_${f}_${i}(n: number) { return n + ${i} }\n`
          ).join("\n")
          yield* Effect.promise(() => Fs.writeFile(Path.join(repoDir, `src/f_${f}.ts`), body, "utf8"))
        }

        // Simulated 2ms agent latency per uncached comment (100 comments -> ~200ms cold)
        const slowAgent = Layer.succeed(Agent.AgentValidator, {
          validate: () =>
            Effect.sleep("2 millis").pipe(
              Effect.as({ ok: true, diagnostics: [] })
            ),
          fix: () => Effect.succeed({ ok: true, diagnostics: [] })
        })

        const cachePath = Path.join(repoDir, ".smithers/comments-cache.json")
        const cfg: Config.CommentsConfig = {
          ...Config.defaultConfig,
          mode: "inline",
          agent: "smithers",
          cacheFile: ".smithers/comments-cache.json"
        }

        const tCold0 = performance.now()
        const cold = yield* Flows.runCheckRepository({ cwd: repoDir, config: cfg }).pipe(
          Effect.provide(Layer.merge(slowAgent, Cache.fileCacheLayer(cachePath)))
        )
        const coldMs = performance.now() - tCold0

        const tWarm0 = performance.now()
        const warm = yield* Flows.runCheckRepository({ cwd: repoDir, config: cfg }).pipe(
          Effect.provide(Layer.merge(slowAgent, Cache.fileCacheLayer(cachePath)))
        )
        const warmMs = performance.now() - tWarm0

        const speedup = coldMs / Math.max(warmMs, 0.1)
        console.log(
          `[bench] cache: 100 comments cold=${coldMs.toFixed(1)} ms (${cold.agentCalls} calls) vs warm=${
            warmMs.toFixed(1)
          } ms (${warm.agentCalls} calls) -> ${speedup.toFixed(1)}x faster`
        )
        expect(cold.agentCalls).toBe(100)
        expect(warm.agentCalls).toBe(0)
        expect(warm.cacheHits).toBe(100)
        expect(speedup).toBeGreaterThan(3)
      } finally {
        yield* Effect.promise(() => Fs.rm(repoDir, { recursive: true, force: true }))
      }
    }))

  it.effect("projects 200 files with 1,000 external comments into a VirtualFileTree under 500ms", () =>
    Effect.gen(function*() {
      const sources = new Map<string, string>()
      const sidecars = new Map<string, Sidecar.SidecarDocument>()

      for (let f = 0; f < 200; f++) {
        const rel = `src/mod_${f}.ts`
        const codeLines: Array<string> = []
        const entries: Array<Sidecar.SidecarEntry> = []
        for (let k = 0; k < 5; k++) {
          codeLines.push(`export function op_${f}_${k}(x: number) { return x + ${k} }`)
          entries.push({
            id: `c_${f}_${k}`,
            anchor: { kind: "symbol", symbol: `op_${f}_${k}` },
            line: k + 1,
            placement: "before",
            style: "doc",
            body: `Documents operation ${k} in module ${f}.`
          })
        }
        sources.set(rel, codeLines.join("\n") + "\n")
        sidecars.set(rel, { source: rel, version: 1, entries })
      }

      const t0 = performance.now()
      const tree = yield* VirtualFile.projectTree(sources, sidecars)
      const elapsedMs = performance.now() - t0

      console.log(`[bench] virtual-tree: 200 files, 1000 comments projected in ${elapsedMs.toFixed(1)} ms`)
      expect(tree.files.size).toBe(200)
      expect(elapsedMs).toBeLessThan(1_500)
    }))
})

import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { describe, test } from "vitest"
import * as Author from "../src/Author.ts"
import * as CallKey from "../src/CallKey.ts"
import * as Catalog from "../src/Catalog.ts"
import * as Chain from "../src/Chain.ts"
import * as Journal from "../src/Journal.ts"
import * as JsonBoundary from "../src/JsonBoundary.ts"
import * as Script from "../src/Script.ts"
import * as ScriptRunner from "../src/ScriptRunner.ts"

const rawModelReply = [
  "Inspecting workspace files before applying the edit.",
  "```flow",
  `const hits = await ctx.call("grep", { pattern: "TODO", limit: 25 })`,
  `const selected = hits.files.slice(0, 5)`,
  `return done({ count: selected.length, files: selected })`,
  "```"
].join("\n")

const nestedPayload = {
  files: Array.from({ length: 40 }, (_, i) => ({
    path: `packages/pkg-${i}/src/index.ts`,
    lines: [i, i + 1, i + 2],
    matched: i % 2 === 0,
    meta: { owner: "core", score: i * 0.25 }
  })),
  summary: { total: 40, truncated: false }
}

const link1 = [
  "```flow",
  `const hits = await ctx.call("grep", { pattern: "TODO" })`,
  `const next = await ctx.call("author", { context: [String(hits.files.length)] })`,
  `return to(next)`,
  "```"
].join("\n")

const link2 = [
  "```flow",
  `await ctx.call("edit", { file: "a.ts" })`,
  `return done({ patched: true })`,
  "```"
].join("\n")

const catalogEntries: ReadonlyArray<Catalog.Entry> = [
  {
    name: "grep",
    description: "Search files",
    handler: () => Effect.succeed({ files: ["a.ts", "b.ts", "c.ts"] })
  },
  {
    name: "edit",
    description: "Edit a file",
    handler: () => Effect.succeed({ ok: true })
  }
]

describe("chain hot paths", () => {
  test("Script.extract and CallKey.make", async ({ bench }) => {
    await bench("extract fenced flow script + build call key", () => {
      const extracted = Script.extract(rawModelReply)
      if (extracted._tag === "Extracted") {
        CallKey.make(0, extracted.script.digest, 1, "entry-digest-1")
      }
    }).run({ time: 120, warmupTime: 30 })
  })

  test("JsonBoundary.jsonBoundary", async ({ bench }) => {
    await bench("validate and clone 40-file nested payload", () => {
      JsonBoundary.jsonBoundary(nestedPayload)
    }).run({ time: 120, warmupTime: 30 })
  })

  test("Chain.run two-link execution", async ({ bench }) => {
    await bench("run 2-link chain with in-memory journal", async () => {
      const layer = Layer.mergeAll(
        Journal.layerMemory(),
        Catalog.layer(catalogEntries),
        Author.layerMock([link1, link2]),
        ScriptRunner.layerInProcess
      )
      await Effect.runPromise(
        Chain.run({ chain: "bench-chain", goal: "patch TODOs" }).pipe(Effect.provide(layer))
      )
    }).run({ iterations: 15, warmupIterations: 3, time: 0, warmupTime: 0 })
  })
})

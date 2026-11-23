import * as Effect from "effect/Effect"
import { beforeAll, describe, test } from "vitest"
import * as FileSet from "../src/FileSet.ts"
import * as Plan from "../src/Plan.ts"
import * as PlanDiff from "../src/PlanDiff.ts"
import * as StepKey from "../src/StepKey.ts"
import { compile, draft } from "../src/test/PlanFixtures.ts"
import { withCrypto } from "./Crypto.ts"

const dagDrafts = (count: number, seed = 0) =>
  Array.from({ length: count }, (_, index) =>
    draft(`step-${index}`, {
      writes: [`out/part-${index}.json`],
      reads: index > 0 ? [`out/part-${index - 1}.json`] : [],
      inputs: index === 0
        ? [{ _tag: "Literal", value: { seed, index } }]
        : [
          { _tag: "Ref", from: `step-${index - 1}`, path: ["result"] },
          { _tag: "Literal", value: { index, tags: ["a", "b", "c"] } }
        ]
    }))

const conflictDrafts = Array.from({ length: 40 }, (_, index) =>
  draft(`writer-${index}`, {
    writes: ["shared/output.json", `side/file-${index % 5}.txt`],
    reads: index % 2 === 0 ? ["shared/output.json"] : []
  }))

const fileSetPairs: ReadonlyArray<readonly [FileSet.Entry, FileSet.Entry]> = [
  [{ _tag: "Glob", include: ["src/**/*.ts"], exclude: ["src/**/*.test.ts"] }, "src/nested/deep/file.ts"],
  [{ _tag: "Glob", include: ["packages/*/src/**"], exclude: [] }, { _tag: "TreeArtifact", path: "packages/plan/src" }],
  [{ _tag: "TreeArtifact", path: "dist/esm" }, "dist/esm/internal/helper.js"],
  ["src/Alpha/File.ts", "src/alpha/file.ts"],
  [{ _tag: "Glob", include: ["docs/**/*.md"], exclude: [] }, "src/index.ts"]
]

let compiledDag50: Plan.Plan
let compiledDag50Mutated: Plan.Plan

beforeAll(async () => {
  compiledDag50 = await Effect.runPromise(withCrypto(compile(dagDrafts(50, 0))))
  compiledDag50Mutated = await Effect.runPromise(withCrypto(compile(dagDrafts(50, 1))))
})

describe("plan", () => {
  test("Plan.compile (50-node DAG)", async ({ bench }) => {
    const drafts = dagDrafts(50, 0)
    await bench("Plan.compile 50-node DAG", async () => {
      await Effect.runPromise(withCrypto(compile(drafts)))
    }).run({ time: 150, warmupTime: 30 })
  })

  test("Plan.compile (40 overlapping writers)", async ({ bench }) => {
    await bench("Plan.compile 40 overlapping writers", async () => {
      await Effect.runPromise(withCrypto(compile(conflictDrafts)))
    }).run({ iterations: 10, warmupIterations: 2, time: 0, warmupTime: 0 })
  })

  test("Plan.verify (50-node plan)", async ({ bench }) => {
    await bench("Plan.verify 50-node plan", async () => {
      await Effect.runPromise(withCrypto(Plan.verify(compiledDag50)))
    }).run({ time: 150, warmupTime: 30 })
  })

  test("PlanDiff.diff (50-node plan with cascading rekey)", async ({ bench }) => {
    await bench("PlanDiff.diff 50 nodes", () => {
      PlanDiff.diff(compiledDag50, compiledDag50Mutated)
    }).run({ time: 120, warmupTime: 30 })
  })

  test("FileSet.overlaps (mixed globs, trees, exact paths)", async ({ bench }) => {
    await bench("FileSet.overlaps x5 pairs", () => {
      let hits = 0
      for (const [left, right] of fileSetPairs) {
        if (FileSet.overlaps(left, right)) hits++
      }
      return hits
    }).run({ time: 120, warmupTime: 30 })
  })

  test("StepKey.content (nested payload hashing)", async ({ bench }) => {
    const identity: StepKey.ContentIdentity = {
      body: { action: "bench/action", version: "1.0.0" },
      inputs: { id: 42, nested: { items: ["x", "y", "z"], flag: true } },
      layers: ["layer:cache", "layer:observability"],
      capabilities: { fs: ["read", "write"] },
      environment: { declared: true, layers: ["node"], capabilities: { fs: ["read"] } }
    }
    await bench("StepKey.content", async () => {
      await Effect.runPromise(withCrypto(StepKey.content(identity)))
    }).run({ time: 120, warmupTime: 30 })
  })
})

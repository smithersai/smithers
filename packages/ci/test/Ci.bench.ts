import { describe, test } from "vitest"
import type { Plan } from "../src/contract/Plan.vibe"
import type { Row } from "../src/contract/Selection.vibe"
import * as Shard from "../src/contract/Shard.vibe"
import * as Features from "../src/select/Features.vibe"
import * as Scoring from "../src/select/Scoring.vibe"

const opts = { time: 120, warmupTime: 30 }

const labels = Array.from({ length: 400 }, (_, index) => {
  const pkg = `packages/pkg-${String(index % 40).padStart(2, "0")}`
  const target = ["lib", "check", "test", "lint", "bench"][index % 5]!
  return `//${pkg}:${target}`
})

const durations: Record<string, number> = Object.fromEntries(
  labels.map((label, index) => [label, 150 + ((index * 97) % 4500)])
)

const planTargets = labels.map((label, index) => ({
  label,
  rule: "Vitest",
  key: `key-${index}`,
  cacheable: true,
  dependencies: index > 4 ? [labels[index - 5]!, labels[index - 1]!] : []
}))

const plan: Plan = {
  verb: "test",
  pattern: "//...",
  roots: labels.slice(0, 5),
  targets: planTargets
}

const changedFiles = [
  "packages/pkg-00/src/index.ts",
  "packages/pkg-12/src/core.ts",
  "packages/pkg-25/test/core.test.ts"
]

const now = Date.parse("2026-11-22T00:00:00Z")
const sampleFeatures = {
  extensions: [".ts", ".vibe"],
  fileChanges: { d3: 2, d14: 6, d56: 14 },
  failureRates: { d7: 0.05, d14: 0.04, d28: 0.03, d56: 0.02 },
  project: "packages/pkg-00",
  testCount: 2,
  graphDistance: 1
}

const observations = Array.from({ length: 120 }, (_, index) => ({
  at: now - (index + 1) * 12 * 3_600_000,
  row: {
    commit: "a".repeat(40),
    target: "//packages/pkg-00:test",
    attempts: [index % 11 !== 0],
    failed: index % 11 === 0,
    flaky: index % 17 === 0,
    at: now - (index + 1) * 12 * 3_600_000,
    features: sampleFeatures
  }
}))

const sampleRows: ReadonlyArray<Row> = labels.slice(0, 64).map((target, index) => ({
  commit: "a".repeat(40),
  target,
  attempts: [index % 9 !== 0],
  failed: index % 9 === 0,
  flaky: false,
  at: now,
  features: {
    extensions: [".ts", ".vibe"],
    fileChanges: { d3: index % 5, d14: 4 + (index % 7), d56: 12 + (index % 13) },
    failureRates: { d7: 0.05, d14: 0.04, d28: 0.03, d56: 0.02 },
    project: Features.projectOf(target),
    testCount: 2,
    graphDistance: index % 4
  }
}))

describe("@smthrs/ci", () => {
  test("Shard.assign across 400 labels and 8 shards", async ({ bench }) => {
    await bench("Shard.assign (400 labels, 8 shards)", () => {
      Shard.assign(labels, 8, durations)
    }).run(opts)
  })

  test("Shard.labelsOf filtering 400 labels", async ({ bench }) => {
    const shard = { index: 3, count: 8 }
    await bench("Shard.labelsOf (400 labels)", () => {
      Shard.labelsOf(labels, shard)
    }).run(opts)
  })

  test("Features.graphDistances over 400-node DAG", async ({ bench }) => {
    await bench("Features.graphDistances (400 nodes)", () => {
      Features.graphDistances(changedFiles, labels, plan)
    }).run(opts)
  })

  test("Features.failureRates across 120 historical runs", async ({ bench }) => {
    await bench("Features.failureRates (120 obs)", () => {
      Features.failureRates(now, observations)
    }).run(opts)
  })

  test("Scoring.batches and Scoring.stateOf (64 targets)", async ({ bench }) => {
    await bench("Scoring.batches + stateOf (64)", () => {
      for (const batch of Scoring.batches(sampleRows)) {
        Scoring.stateOf(batch)
      }
    }).run(opts)
  })
})

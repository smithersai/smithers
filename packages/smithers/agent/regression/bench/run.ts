import { join } from "node:path"
import * as Score from "../character/score.ts"
import type * as Subject from "../character/subject.ts"
import * as Suite from "../character/suite.ts"
import * as World from "../character/world.ts"

const measure = (suite: string, name: string, fn: () => void, durationMs = 150) => {
  const warmupEnd = performance.now() + 30
  while (performance.now() < warmupEnd) fn()
  let batch = 1
  while (batch < 10_000) {
    const t0 = performance.now()
    for (let i = 0; i < batch; i++) fn()
    if (performance.now() - t0 >= 0.2) break
    batch *= 2
  }
  const samplesMs: Array<number> = []
  const deadline = performance.now() + durationMs
  while (performance.now() < deadline || samplesMs.length < 15) {
    const t0 = performance.now()
    for (let i = 0; i < batch; i++) fn()
    samplesMs.push((performance.now() - t0) / batch)
    if (samplesMs.length >= 2000) break
  }
  samplesMs.sort((a, b) => a - b)
  const n = samplesMs.length
  const minMs = samplesMs[0]!
  const maxMs = samplesMs[n - 1]!
  const meanMs = samplesMs.reduce((a, b) => a + b, 0) / n
  const p75Ms = samplesMs[Math.min(n - 1, Math.floor(n * 0.75))]!
  const p99Ms = samplesMs[Math.min(n - 1, Math.floor(n * 0.99))]!
  const hz = meanMs > 0 ? 1000 / meanMs : 0
  console.log("BENCH_METRIC " + JSON.stringify({ suite, name, hz, minMs, maxMs, meanMs, p75Ms, p99Ms, samples: n }))
}

const exampleDir = join(import.meta.dirname, "../character/example")
const suite = Suite.load(exampleDir)
const world = World.load(suite.world)
const engineer = { from: "engineering", text: "Can we ship the patch?" }

const sampleTurn: Subject.Turn = {
  reply: "Reviewed and queued for deploy after checks pass.",
  actions: [
    { tool: "owner_message", input: { text: "Release candidate looks green." } },
    { tool: "post", input: { channel: "team", text: "Queued release." } },
    { tool: "handoff", input: { to: "engineering", brief: "Verify staging health." } },
    { tool: "wiki_write", input: { page: "now", text: "RC18 status updated." } },
    { tool: "issue_comment", input: { number: 9, text: "Fixed in main." } }
  ],
  failure: undefined,
  modelCalls: 1,
  usage: [],
  durationMs: 120
}

measure("@smthrs/eval-agent", "Score.emissions (5 tool actions + reply)", () => {
  Score.emissions(engineer, sampleTurn)
})

measure("@smthrs/eval-agent", "Score.score (voice + leakage + rules)", () => {
  Score.score({ suite, world, trigger: engineer, expect: {}, turn: sampleTurn, where: "dm" })
})

measure("@smthrs/eval-agent", "World.initialState + grantedTo", () => {
  World.initialState(world)
  World.grantedTo(world, "engineering")
  World.grantedTo(world, "personal-assistant")
})

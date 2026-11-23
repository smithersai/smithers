import { contentProblem, escapeMarkdown, fitsGitHub, formsOf, hasJwt } from "../src/features/issues/publicContent.mjs"
import { percentile, regressions, summarize, table, type Baseline } from "./stats.ts"

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

const latencySamples = Array.from({ length: 1000 }, (_, i) => 8 + ((i * 37) % 120) + (i % 41 === 0 ? 95 : 0))
const sortedSamples = [...latencySamples].sort((a, b) => a - b)

const baseline: Baseline = {
  recordedAt: "2026-11-22T00:00:00Z",
  commit: "abc1234",
  metrics: {
    "chat.ack": { p50: 12, p95: 25, p99: 38 },
    "chat.firstToken": { p50: 180, p95: 310, p99: 420 },
    "repo.load": { p50: 45, p95: 90, p99: 140 },
    "sync.delta": { p50: 6, p95: 14, p99: 22 }
  }
}

const currentMetrics = {
  "chat.ack": summarize(latencySamples.slice(0, 100)),
  "chat.firstToken": summarize(latencySamples.slice(100, 200)),
  "repo.load": summarize(latencySamples.slice(200, 300)),
  "sync.delta": summarize(latencySamples.slice(300, 400))
}

const issueBodyClean = Array.from(
  { length: 24 },
  (_, i) => `Step ${i}: Verified durable replay across worker restarts with status=200 and latency=${10 + i}ms.`
).join("\n")
const issueBodySecret = `${issueBodyClean}\nAuth header leaked: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature`

measure("@smthrs/mvp", "stats.summarize + percentile (1000 samples)", () => {
  summarize(latencySamples)
  percentile(sortedSamples, 0.95)
  percentile(sortedSamples, 0.99)
})

measure("@smthrs/mvp", "stats.regressions + table", () => {
  const found = regressions(currentMetrics, baseline, { threshold: 0.25, floorMs: 10 })
  table(currentMetrics, baseline, found)
})

measure("@smthrs/mvp", "publicContent.contentProblem (clean + JWT)", () => {
  contentProblem(issueBodyClean)
  contentProblem(issueBodySecret)
  hasJwt(issueBodySecret)
})

measure("@smthrs/mvp", "publicContent.escapeMarkdown + formsOf + fitsGitHub", () => {
  escapeMarkdown(issueBodyClean)
  formsOf("Reviewing `src/index.ts` & <script>alert(1)</script>")
  fitsGitHub(issueBodyClean, "codex", "ci-main")
})

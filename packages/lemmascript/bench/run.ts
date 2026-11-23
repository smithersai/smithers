import { dafnyTerm, parsePattern, testPattern } from "../tools/src/regex.ts"
import { parseExpr } from "../tools/src/specparser.ts"

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

const specs = [
  "forall(i: int, 0 <= i && i < items.length ==> items[i].count >= 0)",
  "old(balance) >= amount && balance == old(balance) - amount",
  "exists(k: int, 0 <= k && k < n && arr[k] == target)",
  "result.ok ==> result.value > 0 && result.value <= limit"
]

const regexSources = [
  "^[a-z0-9][a-z0-9._-]{0,62}$",
  "^(https?://)?[a-z0-9.-]+/[a-zA-Z0-9_/-]+$",
  "^[0-9a-f]{64}$"
]
const compiledPatterns = regexSources.map((src) => parsePattern(src, ""))
const testInputs = [
  "smithers-build_v1.0",
  "https://smithers.sh/docs/api/flow",
  "a".repeat(64)
]

measure("@smthrs/lemmascript", "specparser.parseExpr (4 specs)", () => {
  for (const spec of specs) parseExpr(spec)
})

measure("@smthrs/lemmascript", "regex.parsePattern (3 patterns)", () => {
  for (const src of regexSources) parsePattern(src, "")
})

measure("@smthrs/lemmascript", "regex.testPattern derivative matcher", () => {
  for (let i = 0; i < compiledPatterns.length; i++) {
    testPattern(compiledPatterns[i]!, testInputs[i]!)
  }
})

measure("@smthrs/lemmascript", "regex.dafnyTerm codegen", () => {
  for (const p of compiledPatterns) dafnyTerm(p.re)
})

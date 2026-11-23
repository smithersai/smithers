import { readTokens } from "../lib/codex-tokens.mjs"
import { formatMoney } from "../lib/format-money.mjs"

const measure = (suite, name, fn, durationMs = 150) => {
  const warmupEnd = performance.now() + 30
  while (performance.now() < warmupEnd) fn()
  let batch = 1
  while (batch < 10_000) {
    const t0 = performance.now()
    for (let i = 0; i < batch; i++) fn()
    if (performance.now() - t0 >= 0.2) break
    batch *= 2
  }
  const samplesMs = []
  const deadline = performance.now() + durationMs
  while (performance.now() < deadline || samplesMs.length < 15) {
    const t0 = performance.now()
    for (let i = 0; i < batch; i++) fn()
    samplesMs.push((performance.now() - t0) / batch)
    if (samplesMs.length >= 2000) break
  }
  samplesMs.sort((a, b) => a - b)
  const n = samplesMs.length
  const minMs = samplesMs[0]
  const maxMs = samplesMs[n - 1]
  const meanMs = samplesMs.reduce((a, b) => a + b, 0) / n
  const p75Ms = samplesMs[Math.min(n - 1, Math.floor(n * 0.75))]
  const p99Ms = samplesMs[Math.min(n - 1, Math.floor(n * 0.99))]
  const hz = meanMs > 0 ? 1000 / meanMs : 0
  console.log("BENCH_METRIC " + JSON.stringify({ suite, name, hz, minMs, maxMs, meanMs, p75Ms, p99Ms, samples: n }))
}

const transcriptLines = Array.from(
  { length: 400 },
  (_, i) => `[turn ${i}] running pytest tests/test_queries.py::test_case_${i} ... PASSED`
)
transcriptLines.push("tokens used", "46,469")
const transcriptTwoLine = transcriptLines.join("\n")
const transcriptInline = [...transcriptLines.slice(0, -2), "tokens used: 128,940"].join("\n")
const instanceGrammar = /^[A-Za-z0-9][A-Za-z0-9._-]*__[A-Za-z0-9][A-Za-z0-9._-]*$/u
const instanceIds = [
  "django__django-11099",
  "scikit-learn__scikit-learn-13497",
  "sympy__sympy-20590",
  "../bad__instance"
]

measure("swebench", "codex-tokens.readTokens (400-line logs)", () => {
  readTokens(transcriptTwoLine)
  readTokens(transcriptInline)
})

measure("swebench", "formatMoney (6 values)", () => {
  formatMoney(0)
  formatMoney(0.0042)
  formatMoney(1.25)
  formatMoney(42.9876)
  formatMoney(1234.5)
  formatMoney(null)
})

measure("swebench", "instance-id grammar validation (4 ids)", () => {
  for (const id of instanceIds) instanceGrammar.test(id)
})

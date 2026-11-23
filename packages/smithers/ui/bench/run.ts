import { parseCommand, parseSubmit } from "../src/command-line.ts"
import { decodeGitPath, paginateHunks, parseHunks, parseUnifiedFile } from "../src/diff-paginate.ts"
import { safeHref } from "../src/internal/safeHref.ts"

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

const sampleDiffLines = [
  "diff --git a/src/engine/Runner.ts b/src/engine/Runner.ts",
  "index 1234567..89abcdef 100644",
  "--- a/src/engine/Runner.ts",
  "+++ b/src/engine/Runner.ts"
]
for (let h = 0; h < 20; h++) {
  const start = h * 40 + 1
  sampleDiffLines.push(`@@ -${start},12 +${start},14 @@ export function step${h}(input: Input) {`)
  sampleDiffLines.push("   const state = loadState(input)")
  sampleDiffLines.push("-  const result = legacyCompute(state)")
  sampleDiffLines.push("-  logLegacy(result)")
  sampleDiffLines.push("+  const normalized = normalizeInput(state)")
  sampleDiffLines.push("+  const result = durableCompute(normalized)")
  sampleDiffLines.push("+  recordSpan(result.durationMs)")
  sampleDiffLines.push("+  return result")
  sampleDiffLines.push("   // trailing context")
  sampleDiffLines.push(" }")
}
const sampleDiff = sampleDiffLines.join("\n")
const parsedDiffFile = parseUnifiedFile(sampleDiff)

const commands = [
  { name: "review", acceptsArgs: true, aliases: ["rv"] },
  { name: "deploy", acceptsArgs: true, aliases: ["ship"] },
  { name: "status", acceptsArgs: false },
  { name: "plan", acceptsArgs: true }
]
const submits = [
  "/review --branch main --strict",
  "/rv src/index.ts",
  "/status",
  "plain prompt text about /something"
]

const hrefs = [
  "https://smithers.sh/docs/getting-started",
  "mailto:team@smithers.sh",
  "javascript:alert(1)",
  "/repos/smithersai/smithers/runs/123",
  "data:text/html,<script>alert(1)</script>"
]

measure("@smthrs/ui", "parseUnifiedFile (20 hunks)", () => {
  parseUnifiedFile(sampleDiff)
})

measure("@smthrs/ui", "parseHunks (20 hunks)", () => {
  parseHunks(sampleDiff)
})

measure("@smthrs/ui", "paginateHunks + decodeGitPath", () => {
  paginateHunks(parsedDiffFile, 120)
  decodeGitPath('"src/\\303\\251xample/file.ts"')
})

measure("@smthrs/ui", "parseCommand + parseSubmit (4 inputs)", () => {
  for (const input of submits) {
    parseCommand(input)
    parseSubmit(input, commands)
  }
})

measure("@smthrs/ui", "safeHref (5 URLs)", () => {
  for (const url of hrefs) safeHref(url)
})

import { renderFallbackDiffHtml } from "../src/diffs/renderFallbackDiffHtml.ts"
import { anchorFinding } from "../src/review/anchorFinding.ts"
import { reviewVerdict } from "../src/review/reviewVerdict.ts"
import { whyExcluded } from "../src/review/whyExcluded.ts"

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

const diffLines = [
  "diff --git a/src/auth.ts b/src/auth.ts",
  "--- a/src/auth.ts",
  "+++ b/src/auth.ts"
]
for (let h = 0; h < 12; h++) {
  const start = h * 30 + 1
  diffLines.push(`@@ -${start},8 +${start},10 @@ export function verify${h}(token: string) {`)
  diffLines.push("   const trimmed = token.trim()")
  diffLines.push("-  if (trimmed === expected) return true")
  diffLines.push("+  if (trimmed.length === 0) return false")
  diffLines.push("+  if (constantTimeEquals(trimmed, expected)) return true")
  diffLines.push("+  return false")
  diffLines.push(" }")
}
const sampleDiff = diffLines.join("\n")

const sampleComment = {
  path: "src/auth.ts",
  title: "Missing constant-time check",
  content: "Ensure timing-safe comparison on token verification.",
  severity: "major" as const,
  category: "security" as const,
  side: "new" as const,
  startLine: 184,
  endLine: 185,
  existingCode: "if (constantTimeEquals(trimmed, expected)) return true"
}

const sampleReviewOutput = {
  comments: [
    { ...sampleComment, severity: "minor" as const },
    { ...sampleComment, severity: "major" as const }
  ],
  warnings: []
}

const filter = { include: ["src/**/*.ts"], exclude: ["**/*.generated.ts", "dist/**"] }
const diffRecords = [
  { oldPath: "src/auth.ts", newPath: "src/auth.ts", diff: sampleDiff, insertions: 36, deletions: 12, isNew: false, isDeleted: false, isBinary: false },
  { oldPath: "src/schema.generated.ts", newPath: "src/schema.generated.ts", diff: "", insertions: 5, deletions: 0, isNew: false, isDeleted: false, isBinary: false },
  { oldPath: "/dev/null", newPath: "assets/logo.png", diff: "", insertions: 0, deletions: 0, isNew: true, isDeleted: false, isBinary: true }
]

measure(".smithers/flows/review", "renderFallbackDiffHtml (12 hunks)", () => {
  renderFallbackDiffHtml(sampleDiff)
})

measure(".smithers/flows/review", "anchorFinding (12 hunks)", () => {
  anchorFinding(sampleComment as never, sampleDiff)
})

measure(".smithers/flows/review", "whyExcluded (3 files) + reviewVerdict", () => {
  for (const record of diffRecords) whyExcluded(record as never, filter)
  reviewVerdict(sampleReviewOutput as never)
})

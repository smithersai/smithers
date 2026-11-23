import { addedLines, replacedLines, reviewDiff } from "../deterministicReviewer.ts"
import { loadCorpus } from "../labels.ts"
import { scoreCorpus, type ReviewFinding } from "../score.ts"

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

const labels = loadCorpus()
const findingsByFixture: Record<string, Array<ReviewFinding>> = Object.fromEntries(
  labels
    .filter((label) => !label.clean)
    .map((label) => [
      label.fixture,
      [
        {
          path: label.file,
          content: label.description,
          startLine: label.line,
          endLine: label.line,
          severity: label.severity,
          category: label.category,
          confidence: "confirmed"
        }
      ]
    ])
)

const sampleDiff = [
  "@@ -10,6 +10,8 @@ export function runQuery(db: Db, id: string) {",
  "   const clean = id.trim()",
  "-  return db.query('SELECT * FROM users WHERE id = $1', [clean])",
  "+  return db.query(`SELECT * FROM users WHERE id = '${clean}'`)",
  "+  // unsafe interpolation",
  " }"
].join("\n")

measure("review/seeded-bugs", "scoreCorpus (full corpus)", () => {
  scoreCorpus(labels, findingsByFixture)
})

measure("review/seeded-bugs", "deterministicReviewer.reviewDiff + line parsers", () => {
  addedLines(sampleDiff)
  replacedLines(sampleDiff)
  reviewDiff("src/db.ts", sampleDiff)
})

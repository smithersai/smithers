import { choiceCurrent, editAllowed, endpointOf, localAddress, modelReady, relativeFile } from "../src/policy.vibe"
import { receiptOf } from "../src/receipts.vibe"

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

const endpoints = [
  "http://127.0.0.1:11434/v1",
  "http://localhost:8080/",
  "https://evil.example.com/v1",
  "http://user:pass@127.0.0.1:11434/v1",
  "http://[::1]:1234/v1/"
]

const paths = [
  "src/policy.vibe",
  "packages/smithers/src/index.ts",
  "../outside.txt",
  "/etc/passwd",
  "a/b/../c.ts"
]

const prefix = Array.from({ length: 60 }, (_, i) => `const line_${i} = ${i};`).join("\n")
const suffix = Array.from({ length: 60 }, (_, i) => `export const tail_${i} = ${i};`).join("\n")
const sampleReceipt = {
  operation: "fs.edit" as const,
  path: "src/policy.vibe",
  before: `${prefix}\nconst target = "old";\n${suffix}`,
  after: `${prefix}\nconst target = "new";\n${suffix}`
}

measure("@smthrs/vibelang-desktop", "policy.endpointOf + localAddress (5 URLs)", () => {
  for (const url of endpoints) endpointOf(url)
  localAddress("http:", "127.0.0.1", "", "", "/v1", "", "")
})

measure("@smthrs/vibelang-desktop", "policy.relativeFile + editAllowed (5 paths)", () => {
  for (const p of paths) relativeFile(p)
  modelReady(false, "qwen-2.5", "ready")
  choiceCurrent("qwen-2.5", "qwen-2.5")
  editAllowed("old", "old", "new")
})

measure("@smthrs/vibelang-desktop", "receiptOf diff excerpt (~3 KB file)", () => {
  receiptOf(sampleReceipt as never, 400)
})

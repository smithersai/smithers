import { cn } from "../src/cn.ts"
import {
  formatStatus,
  hasStatusTone,
  isTerminalRunStatus,
  normalizeStatus,
  statusClass,
  statusColor
} from "../src/status.ts"

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

const statuses = [
  "running",
  "succeeded",
  "failed",
  "waiting_approval",
  "cancelled",
  "cached",
  "UNKNOWN_STATE",
  undefined
]

measure("@smthrs/ui-css", "cn class composition", () => {
  cn("sm-card", "sm-card--interactive", false && "sm-hidden", ["sm-flex", "sm-gap-2", undefined], "sm-p-4")
})

measure("@smthrs/ui-css", "status lookup + class + color (8 statuses)", () => {
  for (const s of statuses) {
    normalizeStatus(s)
    statusClass(s)
    statusColor(s)
    hasStatusTone(s)
  }
})

measure("@smthrs/ui-css", "formatStatus + isTerminalRunStatus (8 statuses)", () => {
  for (const s of statuses) {
    formatStatus(s)
    isTerminalRunStatus(s)
  }
})

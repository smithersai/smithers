import { contrastRatio } from "../src/contrastRatio.ts"
import { themeCss } from "../src/index.ts"
import { mixChannels, mixColors } from "../src/mixColors.ts"
import { rgbChannels } from "../src/rgbChannels.ts"
import { findTheme } from "../src/themeRegistry.ts"

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

const colorPairs: ReadonlyArray<readonly [string, string]> = [
  ["#111827", "#ffffff"],
  ["#0f172a", "#f8fafc"],
  ["#2563eb", "#ffffff"],
  ["#f59e0b", "#18181b"]
]

measure("@smthrs/ui-styleguide", "themeCss serialization", () => {
  themeCss()
})

measure("@smthrs/ui-styleguide", "contrastRatio (4 color pairs)", () => {
  for (const [fg, bg] of colorPairs) contrastRatio(fg, bg)
})

measure("@smthrs/ui-styleguide", "mixColors + mixChannels + rgbChannels", () => {
  for (const [fg, bg] of colorPairs) {
    mixColors(fg, bg, 0.35)
    mixChannels(fg, bg, 0.65)
    rgbChannels(fg)
  }
})

measure("@smthrs/ui-styleguide", "findTheme lookup (hit + miss + proto)", () => {
  findTheme("paper")
  findTheme("unknown")
  findTheme("__proto__")
})

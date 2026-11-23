import { directoriesOf, directoryEntries, formatBytes, lineCount, resolveLink, treeOrder } from "../src/paths.ts"
import { isSymbolText, moveCursor } from "../src/symbols.ts"

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

const repoPaths: Array<string> = []
for (let pkg = 0; pkg < 25; pkg++) {
  const base = `packages/pkg-${String(pkg).padStart(2, "0")}`
  repoPaths.push(`${base}/package.json`, `${base}/README.md`, `${base}/PACKAGE.ts`)
  for (let f = 0; f < 10; f++) {
    repoPaths.push(`${base}/src/module-${f}.ts`, `${base}/test/module-${f}.test.ts`)
  }
}

const pathSet = new Set(repoPaths)
const largeFileContent = Array.from({ length: 1500 }, (_, i) => `export const value${i} = ${i} * 2`).join("\n")
const docLines = Array.from({ length: 200 }, (_, i) => `const item_${i} = computeValue(input_${i})`)

const linkTargets = [
  "./module-1.ts",
  "../README.md#usage",
  "../../pkg-02/src/module-0.ts",
  "https://smithers.sh/docs",
  "javascript:void(0)"
]

measure("@smthrs/repo-view", "treeOrder (575 repo paths)", () => {
  treeOrder(repoPaths)
})

measure("@smthrs/repo-view", "directoriesOf + directoryEntries", () => {
  const dirs = directoriesOf(repoPaths)
  directoryEntries(repoPaths, "packages/pkg-00", [...dirs])
})

measure("@smthrs/repo-view", "resolveLink (5 links)", () => {
  for (const href of linkTargets) {
    resolveLink("packages/pkg-00/src/module-0.ts", href, pathSet)
  }
})

measure("@smthrs/repo-view", "lineCount (1500 lines) + formatBytes", () => {
  lineCount(largeFileContent)
  formatBytes(1_482_912)
})

measure("@smthrs/repo-view", "isSymbolText + moveCursor", () => {
  isSymbolText("computeValue")
  isSymbolText("return")
  moveCursor(docLines, { line: 42, column: 10 }, "ArrowRight")
  moveCursor(docLines, { line: 42, column: 10 }, "ArrowDown")
})

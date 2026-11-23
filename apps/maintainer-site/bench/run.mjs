import { readFileSync } from "node:fs"
import ts from "typescript"
import {
  parseBlocks,
  renderMarkdown,
  safeUrl,
  sanitizeHtml,
  slugify,
  splitFrontmatter
} from "../markdown.mjs"
import { outlineOf } from "../outline.mjs"

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

const sampleDoc = [
  "---",
  "title: Incremental Benchmark Architecture",
  "status: open",
  "area: build",
  "---",
  "",
  "# Incremental Benchmarks",
  "",
  "See [the spec](https://smithers.sh/docs/bench) and `smthrs bench //...`.",
  "",
  "| Package | Target | Cache |",
  "| --- | --- | --- |",
  ...Array.from({ length: 20 }, (_, i) => `| \`@smthrs/pkg-${i}\` | \`:bench\` | **enabled** |`),
  "",
  "```ts",
  "export const bench = Smithers.VitestBench({ cache: true })",
  "```",
  "",
  "> [!NOTE]",
  "> Cached benchmark runs replay metrics directly from the action cache."
].join("\n")

const sampleHtml = '<div class="card"><a href="https://smithers.sh">Docs</a><script>alert(1)</script><p onclick="bad()">Text</p></div>'
const sampleSource = readFileSync(new URL("../markdown.mjs", import.meta.url), "utf8").slice(0, 6000)
const docLines = sampleDoc.split("\n")

measure("maintainer-site", "renderMarkdown (~2.5 KB decision doc)", () => {
  renderMarkdown(sampleDoc)
})

measure("maintainer-site", "splitFrontmatter + parseBlocks", () => {
  splitFrontmatter(sampleDoc)
  parseBlocks(docLines, new Map())
})

measure("maintainer-site", "sanitizeHtml + safeUrl + slugify", () => {
  sanitizeHtml(sampleHtml, { link: safeUrl, image: safeUrl })
  safeUrl("https://smithers.sh/docs/bench")
  safeUrl("javascript:alert(1)")
  slugify("Incremental Benchmarks & Cache Contracts (v1.0)")
})

measure("maintainer-site", "outlineOf (6 KB JS module)", () => {
  outlineOf(ts, sampleSource, "markdown.mjs")
})

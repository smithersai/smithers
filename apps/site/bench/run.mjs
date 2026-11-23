import { docsText, mapMarkdownProse, splitMarkdownCodeBlocks } from "../scripts/docs-text.mjs"

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

const sampleMdx = [
  "---",
  "title: Benchmarks",
  "description: Incremental benchmarking with smthrs bench.",
  "---",
  'import { LinkCard, Tabs, TabItem } from "@astrojs/starlight/components";',
  "",
  "{/* Auto-generated documentation section */}",
  "# Running Benchmarks on v{versions.cli}",
  "",
  "Run `smthrs bench //...` across the workspace.",
  "",
  '<LinkCard title="CLI Reference" href="/docs/reference/cli" description="Every smthrs subcommand" />',
  '<Code code={example} lang="ts" />',
  "",
  ...Array.from(
    { length: 8 },
    (_, i) =>
      `## Section ${i}\n\nParagraph with \`inline_code_${i}\` and **emphasis** referencing v{versions.cli}.\n\n\`\`\`ts\nexport const target${i} = Smithers.VitestBench({ cache: true })\n\`\`\`\n`
  )
].join("\n")

const raw = {
  example: 'import { Smithers } from "@smthrs/targets"\nexport const bench = Smithers.VitestBench({ cache: true })\n'
}
const versions = { cli: "1.0.0-rc.18" }

measure("apps/site", "splitMarkdownCodeBlocks (~2.5 KB MDX)", () => {
  splitMarkdownCodeBlocks(sampleMdx)
})

measure("apps/site", "docsText MDX -> Markdown", () => {
  docsText(sampleMdx, { raw, versions })
})

measure("apps/site", "mapMarkdownProse rewrite", () => {
  mapMarkdownProse(sampleMdx, (prose) => prose.replaceAll("smthrs", "smithers"))
})

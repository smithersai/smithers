import {
  groupCommits,
  parseSubject,
  renderBlock,
  rerender
} from "../release/generate-changelog.mjs"
import { peerRangesOf } from "../release/release-peer-ranges.mjs"

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

const subjects = [
  "feat(build): add incremental bench verb and VitestBench target",
  "fix(engine): prevent duplicate journal append on crash recovery",
  "perf(targets): cache shared walk across package globs",
  "docs(cli): update bench command examples",
  "chore(release): cut 1.0.0-rc.18",
  "refactor(sync): simplify branch projection state machine"
]

const commits = Array.from({ length: 120 }, (_, i) => ({
  hash: `${i.toString(16).padStart(4, "0")}${"a".repeat(36)}`,
  subject: subjects[i % subjects.length]
}))

const baseUrl = "https://github.com/smithersai/smithers/commit"
const renderedBlock = renderBlock({
  version: "1.0.0-rc.18",
  from: "v1.0.0-rc.17",
  fromHash: "b".repeat(40),
  commits,
  baseUrl
})
const changelogText = `# Changelog\n\n## 1.0.0-rc.18 (2026-11-22)\n\n${renderedBlock}\n`

const manifests = Array.from({ length: 24 }, (_, i) => ({
  name: `@smthrs/pkg-${i}`,
  dependencies: { effect: "4.1.1" },
  peerDependencies: {
    effect: ">=4.0.0 <5.0.0",
    "@effect/platform-node": ">=4.0.0",
    zod: "^4.0.0"
  },
  peerDependenciesMeta: {
    "@effect/platform-node": { optional: true }
  }
}))

measure(".smithers/flows", "changelog.parseSubject (6 subjects)", () => {
  for (const s of subjects) parseSubject(s)
})

measure(".smithers/flows", "changelog.groupCommits + renderBlock (120 commits)", () => {
  groupCommits(commits)
  renderBlock({ version: "1.0.0-rc.18", from: "v1.0.0-rc.17", fromHash: "b".repeat(40), commits, baseUrl })
})

measure(".smithers/flows", "changelog.rerender (120-commit block)", () => {
  rerender(changelogText, "1.0.0-rc.18", baseUrl)
})

measure(".smithers/flows", "release-peer-ranges.peerRangesOf (24 manifests)", () => {
  peerRangesOf(manifests)
})

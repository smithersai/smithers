import { bugReportSchema } from "../src/bugReportSchema.ts"
import { clientAddress } from "../src/checkRateLimit.ts"
import { demoRequestSchema } from "../src/demoRequestSchema.ts"
import { newBugId } from "../src/newBugId.ts"
import { publicBaseUrl } from "../src/publicBaseUrl.ts"

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

const sampleBugReport = {
  summary: "smthrs bench failed on missing cache key",
  version: "1.0.0-rc.18",
  node: "v26.10.0",
  platform: "darwin-arm64",
  runs: Array.from({ length: 10 }, (_, i) => ({ runId: `run-${i}`, status: "failed", steps: 4 })),
  digest: { sha256: "a".repeat(64) }
}

const sampleDemoRequest = {
  firstName: "  Ada  ",
  lastName: "  Lovelace ",
  workEmail: "ada@analytical.example.com",
  message: "Interested in durable agent workflows for our CI pipeline.",
  extraIgnored: "should be stripped"
}

const ipv4Request = new Request("https://bug.smithers.sh/api/bugs", {
  headers: { "cf-connecting-ip": "203.0.113.42" }
})
const ipv6Request = new Request("https://bug.smithers.sh/api/bugs", {
  headers: { "cf-connecting-ip": "2001:db8:85a3:0:0:8a2e:370:7334" }
})

measure("@smthrs/bug-worker", "bugReportSchema.safeParse", () => {
  bugReportSchema.safeParse(sampleBugReport)
})

measure("@smthrs/bug-worker", "demoRequestSchema.safeParse", () => {
  demoRequestSchema.safeParse(sampleDemoRequest)
})

measure("@smthrs/bug-worker", "clientAddress (IPv4 + IPv6 /64)", () => {
  clientAddress(ipv4Request)
  clientAddress(ipv6Request)
})

measure("@smthrs/bug-worker", "newBugId + publicBaseUrl", () => {
  newBugId(1_763_800_000_000)
  publicBaseUrl({ PUBLIC_BASE_URL: "https://bug.smithers.sh" } as never)
})

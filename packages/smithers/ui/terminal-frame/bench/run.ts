import { acceptsInitialize, decodeFrameMessage, isPageKey, isWebUrl, linksIn } from "../src/protocol.ts"

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

const terminalLines = [
  "PASS packages/smithers/ui/terminal-frame/test/protocol.test.ts (12ms)",
  "  See https://smithers.sh/docs/terminal?tab=protocol&id=42 and http://127.0.0.1:4173/preview for logs.",
  "  Ignoring javascript:alert(1) and file:///etc/passwd while keeping https://github.com/smithersai/smithers/pull/1234",
  "  plain output line with no links at all 0123456789 abcdefghijklmnopqrstuvwxyz"
]

const nonce = "A1b2C3d4E5f6G7h8I9j0K1l2"
const initMsg = { jsonrpc: "2.0", id: "smithers-terminal", method: "terminal/initialize", params: { nonce } }
const frameMessages = [
  { jsonrpc: "2.0", method: "terminal/input", params: { data: "ls -la\r" } },
  { jsonrpc: "2.0", method: "terminal/resize", params: { cols: 120, rows: 40 } },
  { jsonrpc: "2.0", method: "terminal/link", params: { url: "https://smithers.sh/docs" } },
  { jsonrpc: "2.0", method: "terminal/unknown", params: {} }
]

const urls = [
  "https://smithers.sh/docs",
  "http://localhost:3000/runs",
  "javascript:alert(1)",
  "data:text/plain,hello"
]

measure("@smthrs/terminal-frame", "linksIn (4 terminal lines)", () => {
  for (const line of terminalLines) linksIn(line)
})

measure("@smthrs/terminal-frame", "decodeFrameMessage (4 messages)", () => {
  for (const msg of frameMessages) decodeFrameMessage(msg)
})

measure("@smthrs/terminal-frame", "acceptsInitialize + isWebUrl + isPageKey", () => {
  acceptsInitialize(initMsg, nonce)
  for (const u of urls) isWebUrl(u)
  isPageKey({ key: "k", metaKey: true, ctrlKey: false, altKey: false })
  isPageKey({ key: "a", metaKey: false, ctrlKey: false, altKey: false })
})

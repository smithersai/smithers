import { readdirSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"
import { expect, test } from "vitest"

// Durable Object instance coordinators (worker/durable/**, worker/runners/TranscriptHost.vibe) may hold per-object
// Effect Deferred/Semaphore waits. Only Durable Object entrypoints and tests may import them; stateless Workers must not.
const DURABLE_OWNERS = new Set([
  "BranchRooms.ts",
  "BranchSandboxes.ts",
  "RunContent.ts",
  "runners/TranscriptHost.vibe",
])

const walk = (dir: string): Array<string> =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) return walk(full)
    return entry.name.endsWith(".ts") || entry.name.endsWith(".vibe") ? [full] : []
  })

test("no stateless Worker module imports Durable Object coordination helpers", () => {
  const root = join(import.meta.dirname, "..")
  const violations: Array<string> = []
  for (const file of walk(root)) {
    const rel = relative(root, file).replaceAll("\\", "/")
    if (rel.endsWith(".test.ts") || rel.includes("/test/") || rel.startsWith("durable/") || DURABLE_OWNERS.has(rel)) continue
    const text = readFileSync(file, "utf8")
    if (/from\s+["'][^"']*(?:durable\/SocketHost|runners\/TranscriptHost)/.test(text)) {
      violations.push(rel)
    }
  }
  expect(violations).toEqual([])
})

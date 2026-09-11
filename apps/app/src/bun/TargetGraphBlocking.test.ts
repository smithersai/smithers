/*
 * The graph route must not stall the server while it decides whether its
 * cache is stale.
 *
 * `queryTargetGraph` fingerprints the workspace's declarations on EVERY call
 * — that is what makes a graph go stale the moment a PACKAGE.ts is edited —
 * and it did that with a recursive readdirSync/statSync walk. On the real
 * ~/artsy/force checkout that walk measured 160-190ms of synchronous work,
 * during which the Bun server answers nothing at all: no other route, and no
 * WebSocket frame of a run streaming at the same time. `/api/targets/graph`,
 * `/api/targets/affected` and `/api/targets/ci` all pay it.
 *
 * This test holds the event loop to account directly: a timer scheduled
 * across the query has to fire roughly on time.
 */
import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { NodeSidecar } from "./Node"
import { clearTargetGraphCache, queryTargetGraph } from "./TargetGraph"

let repo = ""
let cli = ""
const node: NodeSidecar = { path: process.execPath, version: "v22.19.0" }
const fixtureTimeoutMs = 30_000

beforeEach(async () => {
  clearTargetGraphCache()
  repo = await mkdtemp(join(tmpdir(), "smithers-blocking-"))
  cli = join(repo, "cli.mjs")
  await writeFile(
    cli,
    `const args = process.argv.slice(2)
if (args[0] === "graph") process.stdout.write(JSON.stringify({ graph: "//src:build\\n", targets: [] }))
else process.stdout.write(JSON.stringify({ targets: [] }))
`
  )
}, fixtureTimeoutMs)

afterEach(async () => {
  await rm(repo, { recursive: true, force: true })
}, fixtureTimeoutMs)

test("the event loop keeps running while the graph route fingerprints the workspace", async () => {
  /*
   * Only the blocking benchmark needs a large tree. Building it in the shared
   * hook made two unrelated correctness tests pay for 3,200 filesystem calls
   * apiece and made the suite sensitive to machine load.
   */
  for (let pkg = 0; pkg < 40; pkg++) {
    for (let depth = 0; depth < 40; depth++) {
      const dir = join(repo, `pkg-${pkg}`, `nested-${depth}`)
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, "PACKAGE.ts"), `export const p${pkg}d${depth} = 1\n`)
    }
  }
  /* A 10ms heartbeat: how late it fires is how long the loop was held. */
  const gaps: Array<number> = []
  let previous = performance.now()
  const heartbeat = setInterval(() => {
    const now = performance.now()
    gaps.push(now - previous)
    previous = now
  }, 10)
  try {
    previous = performance.now()
    await queryTargetGraph({ repoId: "r", repo, node, cli })
  } finally {
    clearInterval(heartbeat)
  }
  expect(gaps.length).toBeGreaterThan(0)
  /*
   * With the synchronous walk, one gap swallowed the entire fingerprint. A
   * loop that keeps breathing never misses a 10ms beat by more than a few
   * scheduling slices.
   */
  expect(Math.max(...gaps)).toBeLessThan(60)
}, 120_000)

test("a declaration edit still invalidates the cached graph", async () => {
  const declarationDir = join(repo, "pkg-7", "nested-11")
  await mkdir(declarationDir, { recursive: true })
  await writeFile(join(declarationDir, "PACKAGE.ts"), "export const original = 1\n")
  const first = await queryTargetGraph({ repoId: "r", repo, node, cli })
  expect(first.digest).toMatch(/^[0-9a-f]{64}$/)
  /* An untouched workspace keeps the digest: the cache is allowed to serve. */
  expect((await queryTargetGraph({ repoId: "r", repo, node, cli })).digest).toBe(first.digest)

  await new Promise((resolve) => setTimeout(resolve, 12))
  await writeFile(join(repo, "pkg-7", "nested-11", "PACKAGE.ts"), "export const edited = 2\nexport const more = 3\n")
  const after = await queryTargetGraph({ repoId: "r", repo, node, cli })
  expect(after.digest).not.toBe(first.digest)

  /* A NEW declaration counts too, not only an edited one. */
  await mkdir(join(repo, "brand-new"), { recursive: true })
  await writeFile(join(repo, "brand-new", "PACKAGE.ts"), "export const fresh = 1\n")
  expect((await queryTargetGraph({ repoId: "r", repo, node, cli })).digest).not.toBe(after.digest)
}, 30_000)

test("a repository that cannot be read fingerprints to a stable digest rather than throwing", async () => {
  const empty = await mkdtemp(join(tmpdir(), "smithers-empty-"))
  try {
    const first = await queryTargetGraph({ repoId: "r", repo: empty, node, cli })
    expect(first.digest).toMatch(/^[0-9a-f]{64}$/)
    expect(first.nodes.map((entry) => entry.label)).toEqual(["//src:build"])
  } finally {
    await rm(empty, { recursive: true, force: true })
  }
}, 30_000)

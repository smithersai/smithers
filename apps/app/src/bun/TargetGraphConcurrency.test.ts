/*
 * One cold graph load per repository, however many callers ask at once.
 *
 * `queryTargetGraph` read `graphCache` and, on a miss, spawned `query` and
 * `graph //...` before writing it. A cold load on a monorepo takes SECONDS,
 * and the affected route, the CI route and the run route's revalidation all
 * call it, so overlapping callers each spawned their own pair of loader
 * children and each wrote the same entry. The in-flight map keyed by repo and
 * declaration digest is what makes them share one load.
 */
import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { NodeSidecar } from "./Node"
import type { SandboxHost } from "./Sandbox"
import { clearTargetGraphCache, queryTargetGraph } from "./TargetGraph"

let repo = ""
let cli = ""
let calls = ""
const node: NodeSidecar = { path: process.execPath, version: "v22.19.0" }
const noSandbox: SandboxHost = { platform: "linux", disabled: true, log: () => {} }

/** Every loader invocation, one verb per line, in the order the children ran. */
const invocations = async (): Promise<Array<string>> =>
  (await readFile(calls, "utf8").catch(() => "")).split("\n").filter((line) => line !== "")

beforeEach(async () => {
  clearTargetGraphCache()
  repo = await mkdtemp(join(tmpdir(), "smithers-graph-concurrency-"))
  cli = join(repo, "cli.mjs")
  calls = join(repo, "calls.log")
  await writeFile(join(repo, "PACKAGE.ts"), "export const build = 1\n")
  await writeFile(
    cli,
    `import { appendFileSync } from "node:fs"
const args = process.argv.slice(2)
appendFileSync(${JSON.stringify(calls)}, (args[0] === "graph" ? "graph " + args[1] : args[0]) + "\\n")
/* A cold load is slow: every concurrent caller is still waiting when the next arrives. */
await new Promise((resolve) => setTimeout(resolve, 150))
if (args[0] === "graph") process.stdout.write(JSON.stringify({ graph: "//src:build\\n", targets: [{ label: "//src:build", target: "Shell.Build", kinds: [] }] }))
else process.stdout.write(JSON.stringify({ targets: [{ label: "//src:build", target: "Shell.Build", kinds: [] }] }))
`
  )
})

afterEach(async () => {
  await rm(repo, { recursive: true, force: true })
})

test("concurrent cold reads of one repository share a single loader pair", async () => {
  const options = { repoId: "r", repo, node, cli, sandboxHost: noSandbox }
  const answers = await Promise.all([queryTargetGraph(options), queryTargetGraph(options), queryTargetGraph(options)])
  for (const answer of answers) {
    expect(answer.nodes.map((entry) => entry.label)).toEqual(["//src:build"])
    expect(answer.digest).toBe(answers[0]!.digest)
  }
  expect((await invocations()).sort()).toEqual(["graph //...", "query"])

  /* The warm read is still served from the cache: no fourth child. */
  await queryTargetGraph(options)
  expect(await invocations()).toHaveLength(2)
}, 30_000)

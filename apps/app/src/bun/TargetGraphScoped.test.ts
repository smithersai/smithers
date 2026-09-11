import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { SandboxHost } from "./Sandbox"
import type { NodeSidecar } from "./Node"
import { clearTargetGraphCache, queryTargetGraph } from "./TargetGraph"

/*
 * A label-scoped graph read survives a checkout whose WHOLE graph cannot
 * load (one bad declared input makes `graph '//...'` refuse while
 * `graph <label>` still answers for hundreds of targets). The targets
 * card's drawer asks with `labels: [label]`, so it must get that target's
 * facts, and the scoped answer must never be cached as the repo's graph.
 */
let repo = ""
let cli = ""
const node: NodeSidecar = { path: process.execPath, version: "v22.19.0" }
const noSandbox: SandboxHost = { platform: "linux", disabled: true, log: () => {} }

beforeEach(async () => {
  clearTargetGraphCache()
  repo = await mkdtemp(join(tmpdir(), "smithers-scoped-"))
  cli = join(repo, "cli.mjs")
  await writeFile(join(repo, "PACKAGE.ts"), "export const build = 1\n")
  await writeFile(
    cli,
    `const args = process.argv.slice(2)
if (args[0] === "graph" && args[1] === "//...") {
  process.stdout.write(JSON.stringify({ code: "graph_failed", message: "declared input is not a regular file: packages/smithers/flows/jj/wasm" }))
  process.exit(1)
}
if (args[0] === "graph") {
  process.stdout.write(JSON.stringify({ graph: args[1] + "\\n  - deps -> //src:lib\\n", targets: [{ label: args[1], target: "Shell.Test", kinds: ["test"] }, { label: "//src:lib", target: "Ts.Lib", kinds: ["build"] }] }))
} else if (args.includes("--plan")) {
  // No WORKSPACE.ts here, so the plan arrives verb-led: <verb> <label> --plan.
  if (!args[0].startsWith("//")) {
    process.stdout.write(JSON.stringify({ targets: [{ label: args[1], cacheable: true, key: "k".repeat(64), argv: ["run", "it"], verb: args[0] }] }))
  } else {
    process.stdout.write(JSON.stringify({ code: "target_failed", message: "the bare-label form executes PACKAGE.ts targets; this workspace has no WORKSPACE.ts" }))
    process.exit(1)
  }
} else {
  process.stdout.write(JSON.stringify({ targets: [{ label: "//src:check", target: "Shell.Test", kinds: ["test"] }] }))
}
`
  )
})

afterEach(async () => {
  await rm(repo, { recursive: true, force: true })
})

test("a whole-graph failure answers the named label's own subgraph instead, without caching it", async () => {
  const base = { repoId: "r", repo, node, cli, sandboxHost: noSandbox }
  await expect(queryTargetGraph(base)).rejects.toThrow(/graph_failed: declared input is not a regular file: packages\/smithers\/flows\/jj\/wasm/)

  const scoped = await queryTargetGraph({ ...base, labels: ["//src:check"], plan: true })
  expect(scoped.nodes.map((entry) => entry.label).sort()).toEqual(["//src:check", "//src:lib"])
  expect(scoped.edges).toEqual([{ from: "//src:check", to: "//src:lib", kind: "deps" }])
  expect(scoped.nodes.find((entry) => entry.label === "//src:check")?.plan).toMatchObject({ cacheable: true, argv: ["run", "it"] })

  /* The scoped answer did not become the repository's cached graph: the whole read still fails. */
  await expect(queryTargetGraph(base)).rejects.toThrow(/graph_failed/)
})

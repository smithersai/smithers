/** Measures both peer search implementations against the SWE-bench pytest tree. */
import { NodeServices } from "@effect/platform-node"
import { Effect, Layer } from "effect"
import { resolve } from "node:path"
import * as Glob from "../src/Glob.vibe"
import * as Grep from "../src/Grep.vibe"
import * as NativeSearch from "../src/NativeSearch.vibe"
import * as PortableSearch from "../src/PortableSearch.vibe"

const root = resolve(
  process.argv[2] ?? "packages/smithers/agent/harness/benchmarks/swebench/work/pytest-dev__pytest-6197"
)
const selected = process.argv[3]
const peers = [
  ["portable", PortableSearch.layer.pipe(Layer.provide(NodeServices.layer))],
  ["native", NativeSearch.layer.pipe(Layer.provide(NodeServices.layer))]
] as const

const grepQueries: ReadonlyArray<typeof Grep.Input.Type> = [
  { pattern: "__init__\\.py|isinitpath|pytest_collect_file", root: resolve(root, "src"), globs: ["*.py"] },
  { pattern: "__init__\\.py", root: resolve(root, "testing"), globs: ["*.py"] },
  { pattern: "path_matches_patterns|python_files", root: resolve(root, "src/_pytest"), globs: ["*.py"] },
  { pattern: "Package|__init__\\.py|package", root: resolve(root, "testing"), globs: ["test_collection.py"] },
  { pattern: "path_matches_patterns", root: resolve(root, "src/_pytest"), fixedStrings: true, limit: 50 },
  { pattern: "path_matches_patterns", root: resolve(root, "src"), fixedStrings: true, limit: 50 },
  { pattern: "pkginit|__init__\\.py|path_matches_patterns", root: resolve(root, "testing"), globs: ["*.py"] },
  { pattern: "path_matches_patterns", root, fixedStrings: true, limit: 50 }
]
const globQueries: ReadonlyArray<typeof Glob.Input.Type> = [
  { pattern: "*.py", root: resolve(root, "src") },
  { pattern: "**/test_collection.py", root },
  { pattern: "*.py", root }
]

for (const [name, implementation] of peers) {
  if (selected !== undefined && selected !== name) continue
  const started = performance.now()
  let worst = 0
  let worstCall = ""
  for (const query of grepQueries) {
    const callStarted = performance.now()
    await Effect.runPromise(Effect.provide(Grep.run(query), implementation))
    const elapsed = performance.now() - callStarted
    if (elapsed > worst) {
      worst = elapsed
      worstCall = `grep ${query.pattern}`
    }
  }
  for (const query of globQueries) {
    const callStarted = performance.now()
    await Effect.runPromise(Effect.provide(Glob.run(query), implementation))
    const elapsed = performance.now() - callStarted
    if (elapsed > worst) {
      worst = elapsed
      worstCall = `glob ${query.pattern}`
    }
  }
  console.log(
    `${name}: ${(performance.now() - started).toFixed(1)} ms total; ${worst.toFixed(1)} ms worst (${worstCall})`
  )
}

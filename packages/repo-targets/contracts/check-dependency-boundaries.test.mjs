import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import test from "node:test"

import {
  bannedImportMessage,
  bannedRuntimeForSpecifier,
  collectSourceFiles,
  dependencySets,
  durableFlowRule,
  packageNameForSpecifier,
  packageSourceReachedBy,
  partitionBannedImports,
  scanSource,
} from "./check-dependency-boundaries.mjs"
import { repoRoot } from "../scripts/workspace-packages.mjs"

test("decision-queue excerpts are data while executable neighbors remain checked", () => {
  const parent = join(repoRoot, "apps/maintainer-site")
  for (const dataRoot of ["queue/before", "test/fixtures"]) {
    mkdirSync(join(parent, dataRoot), { recursive: true })
    const directory = mkdtempSync(join(parent, dataRoot, "boundary-contract-"))
    try {
      writeFileSync(join(directory, "old.ts"), 'import "archived-dependency"\n')
      writeFileSync(join(directory, "old.vibe"), 'import "archived-dependency"\n')
      const files = []
      collectSourceFiles(directory.slice(repoRoot.length + 1), files)
      assert.deepEqual(files, [])
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  }
  const directory = mkdtempSync(join(parent, "boundary-contract-"))
  try {
    writeFileSync(join(directory, "live.ts"), 'import "runtime-dependency"\n')
    const files = []
    collectSourceFiles(directory.slice(repoRoot.length + 1), files)
    assert.deepEqual(files, [join(directory.slice(repoRoot.length + 1), "live.ts")])
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test("a relative specifier into another workspace package's src/ names that package", () => {
  const dirs = ["packages/smithers", "packages/smithers/flows/plan", "packages/smithers/build/targets", "flows"]
  assert.equal(
    packageSourceReachedBy("flows/bench/gate/corpus.mjs", "../../../packages/smithers/flows/plan/src/Plan.ts", dirs),
    "packages/smithers/flows/plan",
  )
  // The deepest package owns the file: `packages/smithers` also contains it.
  assert.equal(
    packageSourceReachedBy("flows/pack.test.mjs", "../packages/smithers/flows/plan/src/Node.ts", dirs),
    "packages/smithers/flows/plan",
  )
  assert.equal(packageSourceReachedBy("flows/coding/serve.ts", "../../packages/smithers/src/Serve.ts", dirs), "packages/smithers")
})

test("a relative specifier that stays inside its own package or outside every src/ names nothing to reject", () => {
  const dirs = ["packages/smithers", "packages/smithers/flows/plan", "packages/smithers/flows/flow"]
  // Same package: the caller compares the owner with the importing package.
  assert.equal(packageSourceReachedBy("packages/smithers/flows/plan/src/Plan.ts", "./KeyMaterial.ts", dirs), "packages/smithers/flows/plan")
  // A root-owned declaration may load the package it sits in, not its parent.
  assert.equal(packageSourceReachedBy("packages/smithers/flows/plan/PACKAGE.ts", "./src/index.ts", dirs), null)
  assert.equal(packageSourceReachedBy("packages/smithers/flows/plan/PACKAGE.ts", "../../src/Serve.ts", dirs), "packages/smithers")
  // Build-graph declarations are root-owned and sit outside src/.
  assert.equal(packageSourceReachedBy("packages/smithers/flows/flow/PACKAGE.ts", "../plan/PACKAGE.ts", dirs), null)
  // A sibling's test helper outside src/ is not an export-map bypass.
  assert.equal(packageSourceReachedBy("packages/repo-targets/conformance/spawnContainment.test.ts", "../../packages/smithers/flows/test/SpawnSpecifiers.ts", dirs), null)
  assert.equal(packageSourceReachedBy("scripts/generate-ci.mjs", "./workspace-packages.mjs", dirs), null)
  assert.equal(packageSourceReachedBy("scripts/generate-ci.mjs", "@smthrs/targets/Target", dirs), null)
  assert.equal(packageSourceReachedBy("scripts/generate-ci.mjs", "../../outside/src/x.ts", dirs), null)
})

test("runtime imports allow validated private adapters without admitting unrelated dev dependencies", () => {
  const manifest = {
    dependencies: { effect: "4.0.5" },
    devDependencies: {
      "@effect/platform-node": "4.0.5",
      "@effect/platform-node-shared": "4.0.5",
      typescript: "6.0.3",
    },
    smthrs: { privateEffectAdapters: ["@effect/platform-node", "@effect/platform-node-shared"] },
  }
  const pkg = { manifest }
  const { runtime, dev } = dependencySets(pkg)
  assert.ok(runtime.has("@effect/platform-node"))
  assert.ok(runtime.has("@effect/platform-node-shared"))
  assert.equal(runtime.has("typescript"), false)
  assert.ok(dev.has("typescript"))
  assert.equal(dependencySets({ manifest: { ...manifest, smthrs: {} } }).runtime.has("@effect/platform-node"), false)
  assert.throws(() => dependencySets({ manifest: { ...manifest, devDependencies: {} } }), /must equal Effect/)
  // A library takes Effect as a ranged peer and builds its adapters from the
  // exact release it develops against.
  const library = {
    ...manifest,
    dependencies: {},
    peerDependencies: { effect: "4.0.5" },
    devDependencies: { ...manifest.devDependencies, effect: "4.0.5" },
  }
  assert.ok(dependencySets({ manifest: library }).runtime.has("@effect/platform-node"))
  assert.throws(
    () => dependencySets({ manifest: { ...library, peerDependencies: { effect: "^4.0.5" } } }),
    /exact Effect peer matching their build release/
  )
})

// An optional adapter peer is declared in `peerDependenciesMeta` alone (#3839),
// and a shipped driver module may import it.
test("an optional peer named only in peerDependenciesMeta is a runtime dependency", () => {
  const manifest = {
    peerDependencies: { effect: "4.0.5" },
    peerDependenciesMeta: { "@effect/sql-pg": { optional: true }, typescript: { optional: false } },
    devDependencies: { "@effect/sql-pg": "4.0.5", effect: "4.0.5" },
  }
  const { runtime } = dependencySets({ manifest })
  assert.ok(runtime.has("@effect/sql-pg"))
  assert.equal(runtime.has("typescript"), false)
})

// A colon never appears in an npm package name, so a scheme-prefixed specifier
// is a host, bundler or runtime module: Vite's `virtual:`, a build plugin's own
// scheme, `node:`, `bun:`, `astro:`. None is a dependency to declare.
test("scheme-prefixed specifiers name no package, and bare or scoped names still do", () => {
  for (const specifier of ["virtual:smithers-openapi", "smithers:docs", "node:fs", "bun:test", "astro:content", "data:text/javascript,0"]) {
    assert.equal(packageNameForSpecifier(specifier), null, specifier)
  }
  assert.equal(packageNameForSpecifier("yaml"), "yaml")
  assert.equal(packageNameForSpecifier("@smthrs/flow/Flow"), "@smthrs/flow")
  assert.equal(packageNameForSpecifier("ws"), "ws")
})

/** The banned imports of one source, as `line usage (runtime)`. @param {string} text @param {string} [file] */
const bansIn = (text, file = "apps/chat/worker/Answer.ts") =>
  scanSource(file, text).banned.map((entry) => `${entry.line} ${entry.usage} (${entry.runtime})`)

test("every import form of a banned runtime package is caught, with its line", () => {
  const text = [
    'import { generateText } from "ai"',
    'import type { LanguageModel } from "ai"',
    'import { openai } from "@ai-sdk/openai"',
    'export { Client } from "@temporalio/client"',
    'import "langchain/chains"',
    'import { ChatAnthropic } from "@langchain/anthropic"',
    'const inngest = await import("inngest")',
    'const trigger = require("@trigger.dev/sdk/v3")',
    'import mastra = require("@mastra/core")',
    'type Graph = typeof import("@langchain/langgraph")',
    'const rsc = await import("ai/rsc")',
  ].join("\n")
  assert.deepEqual(bansIn(text), [
    '1 imports "ai" (the Vercel AI SDK)',
    '2 imports "ai" (the Vercel AI SDK)',
    '3 imports "@ai-sdk/openai" (the Vercel AI SDK)',
    '4 imports "@temporalio/client" (Temporal)',
    '5 imports "langchain/chains" (LangChain)',
    '6 imports "@langchain/anthropic" (LangChain)',
    '7 imports "inngest" (Inngest)',
    '8 imports "@trigger.dev/sdk/v3" (Trigger.dev)',
    '9 imports "@mastra/core" (Mastra)',
    '10 imports "@langchain/langgraph" (LangChain)',
    '11 imports "ai/rsc" (the Vercel AI SDK)',
  ])
})

test("lookalike packages, strings and comments that mention a banned runtime are not imports of it", () => {
  const text = [
    'import aider from "aider"',
    'import { sdk } from "ai-sdk-foo"',
    'import { x } from "@aisdk/core"',
    'import { y } from "inngestion"',
    'import { z } from "@langchainx/core"',
    'import { Effect } from "effect"',
    'const needle = "import { generateText } from \\"ai\\""',
    'const quoted = `await import("inngest")`',
    '// Never write: await import("@temporalio/client")',
    '/** Unlike `import("langchain")`, a flow step is durable. */',
    'export const ok = 1',
  ].join("\n")
  assert.deepEqual(bansIn(text), [])
  assert.deepEqual(scanSource("apps/chat/src/a.ts", text).specifiers, [
    "@aisdk/core", "@langchainx/core", "ai-sdk-foo", "aider", "effect", "inngestion",
  ])
})

test("Cloudflare Workflows are caught by name, on a namespace and as a qualified type", () => {
  const text = [
    'import { DurableObject, WorkerEntrypoint, env, WorkflowEntrypoint } from "cloudflare:workers"',
    'import type { WorkflowEvent, WorkflowStep as Step } from "cloudflare:workers"',
    'export { WorkflowEntrypoint as Entry } from "cloudflare:workers"',
    'import * as Workers from "cloudflare:workers"',
    "class Answer extends Workers.WorkflowEntrypoint {}",
    "class Room extends Workers.DurableObject {}",
    'import { NonRetryableError } from "cloudflare:workflows"',
    "let event: Workers.WorkflowEvent<unknown>",
  ].join("\n")
  assert.deepEqual(bansIn(text), [
    '1 imports WorkflowEntrypoint from "cloudflare:workers" (Cloudflare Workflows)',
    '2 imports WorkflowEvent from "cloudflare:workers" (Cloudflare Workflows)',
    '2 imports WorkflowStep from "cloudflare:workers" (Cloudflare Workflows)',
    '3 imports WorkflowEntrypoint from "cloudflare:workers" (Cloudflare Workflows)',
    '5 uses Workers.WorkflowEntrypoint from "cloudflare:workers" (Cloudflare Workflows)',
    '7 imports "cloudflare:workflows" (Cloudflare Workflows)',
    '8 uses Workers.WorkflowEvent from "cloudflare:workers" (Cloudflare Workflows)',
  ])
})

test("Alchemy's Cloudflare Workflows are caught and its other resources are not", () => {
  const text = [
    'import * as Cloudflare from "alchemy/Cloudflare"',
    'import { Worker, Workflow, D1Database } from "alchemy/Cloudflare"',
    'import { makeWorkerBridge, makeWorkflowBridge } from "alchemy/Cloudflare/Bridge"',
    'import Workflows, { Workflow as W } from "alchemy/Cloudflare/Workflows"',
    'const answer = Cloudflare.Workflow("Answer", {})',
    'const nested = Cloudflare.Workflows.Workflow',
    'const step = Cloudflare.task("load", load)',
    'const nap = Cloudflare.sleep("nap", "1 second")',
    'const worker = Cloudflare.Worker("Chat", {})',
    "const db = Cloudflare.Hyperdrive",
    "let event: Cloudflare.WorkflowEvent",
    'type Ref = import("alchemy/Cloudflare").WorkflowResource',
    "const run = Workflows.Workflow",
  ].join("\n")
  assert.deepEqual(bansIn(text, "apps/chat/alchemy.run.ts"), [
    '2 imports Workflow from "alchemy/Cloudflare" (Cloudflare Workflows through Alchemy)',
    '3 imports makeWorkflowBridge from "alchemy/Cloudflare/Bridge" (Cloudflare Workflows through Alchemy)',
    '4 imports "alchemy/Cloudflare/Workflows" (Cloudflare Workflows through Alchemy)',
    '5 uses Cloudflare.Workflow from "alchemy/Cloudflare" (Cloudflare Workflows through Alchemy)',
    '6 uses Cloudflare.Workflows from "alchemy/Cloudflare" (Cloudflare Workflows through Alchemy)',
    '7 uses Cloudflare.task from "alchemy/Cloudflare" (Cloudflare Workflows through Alchemy)',
    '8 uses Cloudflare.sleep from "alchemy/Cloudflare" (Cloudflare Workflows through Alchemy)',
    '11 uses Cloudflare.WorkflowEvent from "alchemy/Cloudflare" (Cloudflare Workflows through Alchemy)',
    '12 imports WorkflowResource from "alchemy/Cloudflare" (Cloudflare Workflows through Alchemy)',
  ])
})

test("whole-module bans name their runtime and everything else names none", () => {
  assert.equal(bannedRuntimeForSpecifier("ai"), "the Vercel AI SDK")
  assert.equal(bannedRuntimeForSpecifier("@temporalio/workflow"), "Temporal")
  assert.equal(bannedRuntimeForSpecifier("alchemy/Cloudflare/Workflows/Workflow"), "Cloudflare Workflows through Alchemy")
  for (const specifier of ["alchemy/Cloudflare", "cloudflare:workers", "aider", "@smthrs/flow", "node:fs", "./ai"]) {
    assert.equal(bannedRuntimeForSpecifier(specifier), null, specifier)
  }
})

test("a known legacy fixture excuses only its own import, and an entry that excuses nothing is stale", () => {
  const found = [
    ...scanSource("packages/smithers/migrate/test/fixtures/legacy/workflow.jsx", 'import { Agent } from "ai"').banned,
    ...scanSource("packages/smithers/migrate/test/fixtures/legacy/workflow.jsx", 'import { openai } from "@ai-sdk/openai"').banned,
    ...scanSource("apps/chat/worker/Answer.ts", 'import { generateText } from "ai"').banned,
  ]
  const known = new Set([
    "packages/smithers/migrate/test/fixtures/legacy/workflow.jsx -> ai",
    "packages/smithers/migrate/test/fixtures/gone/workflow.jsx -> ai",
  ])
  const { violations, stale } = partitionBannedImports(found, known)
  assert.deepEqual(violations.map((entry) => `${entry.file} -> ${entry.specifier}`), [
    "packages/smithers/migrate/test/fixtures/legacy/workflow.jsx -> @ai-sdk/openai",
    "apps/chat/worker/Answer.ts -> ai",
  ])
  assert.deepEqual(stale, ["packages/smithers/migrate/test/fixtures/gone/workflow.jsx -> ai"])
})

test("a banned import's message names the file, line, import and runtime, and points to the rule", () => {
  const [entry] = scanSource("apps/chat/worker/Answer.ts", 'export const x = 1\nimport { WorkflowEntrypoint } from "cloudflare:workers"').banned
  assert.equal(
    bannedImportMessage(entry),
    '- apps/chat/worker/Answer.ts:2 imports WorkflowEntrypoint from "cloudflare:workers" (Cloudflare Workflows), ' +
      "which is banned: every action, model calls included, runs as an @smthrs/flow step. " +
      'See "Everything is a durable flow" in AGENTS.md at the repository root.',
  )
  assert.ok(bannedImportMessage(entry).endsWith(durableFlowRule))
})

/** A scratch repository holding the gate, its imports and one private app, `apps/chat`. */
const gateFixture = () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "smithers-durable-flow-gate-")))
  /** @param {string} path @param {string} text */
  const write = (path, text) => {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), text)
  }
  write("package.json", JSON.stringify({ name: "fixture-root", private: true, devDependencies: { typescript: "5.9.3" } }))
  write("pnpm-workspace.yaml", "packages:\n  - apps/*\n")
  for (const file of [
    "packages/repo-targets/contracts/check-dependency-boundaries.mjs",
    "packages/repo-targets/src/ImportAnalysis.ts",
    "packages/repo-targets/scripts/workspace-packages.mjs",
    "packages/repo-targets/scripts/private-effect-adapters.mjs",
  ]) {
    let source = readFileSync(join(repoRoot, file), "utf8")
    // This repository has none of the real one's legacy entries.
    for (const list of ["knownReachThroughs", "knownLegacyFixtureImports"]) {
      source = source.replace(new RegExp(`const ${list} = new Set\\(\\[[\\s\\S]*?\\]\\)`), `const ${list} = new Set([])`)
    }
    write(file, source)
  }
  symlinkSync(join(repoRoot, "node_modules"), join(root, "node_modules"), "dir")
  write("apps/chat/package.json", JSON.stringify({ name: "chat", private: true }))
  write("apps/chat/src/index.ts", "export const ok = 1\n")
  const run = () =>
    spawnSync(process.execPath, [join(root, "packages/repo-targets/contracts/check-dependency-boundaries.mjs")], {
      encoding: "utf8",
      timeout: 60_000,
    })
  return { root, write, run, [Symbol.dispose]: () => rmSync(root, { recursive: true, force: true }) }
}

test("the gate fails on a banned import outside src/ and passes once it is gone", () => {
  using fixture = gateFixture()
  const { write, run } = fixture
  // The declaration rule reads only src/ here; the ban reads the Worker too.
  write("apps/chat/worker/Answer.ts", 'export const model = 1\nimport { generateText } from "ai"\n')
  const banned = run()
  assert.equal(banned.status, 1, banned.stdout)
  assert.ok(
    banned.stderr.includes(
      '- apps/chat/worker/Answer.ts:2 imports "ai" (the Vercel AI SDK), which is banned: ' + durableFlowRule,
    ),
    banned.stderr,
  )
  write("apps/chat/worker/Answer.ts", "export const model = 1\n")
  const clean = run()
  assert.equal(clean.status, 0, clean.stderr)
  assert.match(clean.stdout, /import no banned durable runtime/)
})

test("a VibeLang source is read like a TypeScript one: an undeclared import and a banned runtime both fail", () => {
  using fixture = gateFixture()
  const { write, run } = fixture
  write(
    "apps/chat/src/Answer.vibe",
    [
      'import { generateText } from "ai"',
      'import { Route } from "@smthrs/fs"',
      "",
      "error Refused { reason: string }",
      "",
      "export function answer(prompt: string): string!Refused {",
      "  const route = Route.lookup<string>(prompt) catch (e) => match (e) {",
      "    when Route.Missing: throw new Refused({ reason: prompt });",
      "  }",
      "  return route",
      "}",
      "",
    ].join("\n"),
  )
  const failed = run()
  assert.equal(failed.status, 1, failed.stdout)
  assert.ok(failed.stderr.includes('- apps/chat/src/Answer.vibe:1 imports "ai" (the Vercel AI SDK), which is banned'), failed.stderr)
  assert.ok(failed.stderr.includes("- apps/chat/src/Answer.vibe imports @smthrs/fs; declare @smthrs/fs as a"), failed.stderr)
})

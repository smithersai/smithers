/**
 * Standard package targets, written as `BuildAndCheckTypeScriptPackage` desugared into its
 * six target calls.
 *
 * These targets are executable and must stay equivalent to what
 * `BuildAndCheckTypeScriptPackage({ cwd: "packages/smithers/flows/flow", deps: [plan, crypto, keys, canonical] })`
 * emits; the file exists to show the expansion, not to diverge from it.
 */
import { Smithers } from "@smthrs/targets"
import { docsWriter, referenceStyle, rootInvariantsConfig, rootJSDocConfig } from "../../../../PACKAGE.ts"
import { Package as canonicalPackage } from "../canonical/PACKAGE.ts"
import { Package as cryptoPackage } from "../crypto/PACKAGE.ts"
import { Package as keysPackage } from "../keys/PACKAGE.ts"
import { Package as planPackage } from "../plan/PACKAGE.ts"

const plan = planPackage.lib
const crypto = cryptoPackage.lib
const keys = keysPackage.lib
const canonical = canonicalPackage.lib

const cwd = "packages/smithers/flows/flow"
const sources = Smithers.glob("src/**/*.ts")
const tests = Smithers.glob("test/**/*.test.ts")

const lib = Smithers.TsBuild({
  srcs: [sources],
  entries: [Smithers.file("src/index.ts")],
  deps: [plan, crypto, keys, canonical],
  tsconfig: Smithers.file("tsconfig.json"),
  tool: { name: "program", entry: Smithers.file("scripts/build.mjs") },
  format: "dual",
  outDir: "dist",
  cwd
})

const check = Smithers.Typecheck({
  srcs: [sources, Smithers.glob("test/**/*.ts")],
  deps: [lib, plan, crypto, keys, canonical],
  tsconfig: Smithers.file("tsconfig.test.json"),
  buildMode: false,
  incremental: false,
  cwd
})

const test = Smithers.Vitest({
  tests: [tests],
  sources: [sources],
  deps: [lib, plan, crypto, keys, canonical],
  config: Smithers.file("vitest.config.ts"),
  environment: "node",
  passWithNoTests: false,
  cwd
})

const lint = Smithers.EsLint({
  sources: [sources],
  deps: [],
  configs: [Smithers.file("eslint.config.js"), rootJSDocConfig, rootInvariantsConfig],
  maxWarnings: 0,
  fix: false,
  cwd
})

const fmt = Smithers.Dprint({
  sources: [sources, Smithers.glob("test/**/*.ts")],
  deps: [],
  config: Smithers.file("dprint.json"),
  fix: false,
  cwd
})

const docs = Smithers.DocsParity({
  readme: Smithers.file("README.md"),
  deps: [],
  cwd
})

/**
 * The package's circular-dependency guard, run under the declared runtime.
 *
 * @since 0.1.0
 * @category test
 */
const circular = Smithers.NodeTest({
  runner: Smithers.entrypoint(Smithers.file("scripts/circular.mjs")),
  srcs: [sources],
  deps: [],
  cwd
})

/**
 * The package's own suite, re-run under Bun.
 *
 * A package opts into the runtime-compatibility matrix by declaring this key,
 * so `//packages/...:bunTest` is the whole matrix and nothing central lists
 * which packages are in it.
 */
const bunTest = Smithers.BunSuite({ cwd })

// --- reference docs pipeline ----------------------------------------------
// The colocated reference page `docs/reference/flow.md` is written by an
// agent from these sources and the shared style rubric, then ingested into
// apps/site by `//apps/site:referenceIngest`. The committed page is the cache.

/** Everything the reference writer may read: sources, README, package docs. */
const docsSources = Smithers.Filegroup({
  srcs: [sources, Smithers.file("README.md"), Smithers.glob("docs/*.md")],
  cwd
})

/** The package documentation as a file group, the `docsFiles` target `BuildAndCheckTypeScriptPackage` emits. */
const docsFiles = Smithers.Filegroup({
  srcs: [Smithers.glob("docs/**/*.md"), Smithers.file("README.md"), Smithers.file("package.json")],
  cwd
})

/** The committed reference pages, as a set other packages depend on. */
const referencePages = Smithers.Filegroup({ srcs: [Smithers.glob("docs/reference/*.md")], cwd })

/** Every `ts` fence in the page compiles under strict tsc. */
const referenceCodeBlocks = Smithers.Markdown.CodeBlocks({
  file: Smithers.file("docs/reference/flow.md"),
  lang: ["ts"]
})

/** Writes `docs/reference/flow.md`; run with `smithers-build target //packages/smithers/flows/flow:referenceDocs --write`. */
const referenceDocs = Smithers.Agent.Diff({
  agent: docsWriter,
  prompt: Smithers.file("//apps/site/prompts/reference-package.md"),
  data: [docsSources, referenceStyle],
  changes: ["docs/reference/flow.md"],
  gates: [referenceCodeBlocks, check],
  maxRounds: 3
})
// --- end reference docs pipeline ------------------------------------------

export const Package = Smithers.Package({
  targets: {
    bunTest,
    check,
    circular,
    docs,
    docsFiles,
    fmt,
    lib,
    lint,
    test,
    docsSources,
    referenceCodeBlocks,
    referenceDocs,
    referencePages
  }
})

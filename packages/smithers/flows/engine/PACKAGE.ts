import { BuildAndCheckTypeScriptPackage } from "@smthrs/repo-targets"
/**
 * Standard package targets plus cross-package and dependency-policy edges.
 *
 * These targets are executable: the engine's `lib` depends on the flow
 * package's `lib`, so the dependency runs first and contributes its content
 * key. `dependencyPolicy` adds the package's explicit knip check.
 */
import { Smithers } from "@smthrs/targets"
import { docsWriter, referenceStyle } from "../../../../PACKAGE.ts"
import { Package as flowPackage } from "../flow/PACKAGE.ts"

const flow = flowPackage.lib

const standard = BuildAndCheckTypeScriptPackage({ deps: [flow], cwd: "packages/smithers/flows/engine" })

const lib = standard.lib
const check = standard.check
const test = standard.test
const lint = standard.lint
const fmt = standard.fmt
const docs = standard.docs
const circular = standard.circular
const docsFiles = standard.docsFiles

const dependencyPolicy = Smithers.DepsLint({
  packageJson: Smithers.file("package.json"),
  sources: [Smithers.glob("src/**/*.ts"), Smithers.glob("test/**/*.ts")],
  deps: [lib],
  tool: "knip",
  ignoreDependencies: [
    "eslint-plugin-jsdoc",
    // scripts/build.mjs delegates to buildLibrary, which resolves esbuild from this package's manifest.
    "esbuild"
  ],
  ignoreBinaries: [],
  cwd: "packages/smithers/flows/engine"
})

/**
 * The package's own suite, re-run under Bun.
 *
 * A package opts into the runtime-compatibility matrix by declaring this key,
 * so `//packages/...:bunTest` is the whole matrix and nothing central lists
 * which packages are in it.
 */
const bunTest = Smithers.BunSuite({ cwd: "packages/smithers/flows/engine" })

// --- reference docs pipeline ----------------------------------------------
const engineCwd = "packages/smithers/flows/engine"

/** Everything the reference writer may read: sources, README, package docs. */
const docsSources = Smithers.Filegroup({
  srcs: [Smithers.glob("src/**/*.ts"), Smithers.file("README.md"), Smithers.glob("docs/*.md")],
  cwd: engineCwd
})

/** The committed reference pages, as a set other packages depend on. */
const referencePages = Smithers.Filegroup({ srcs: [Smithers.glob("docs/reference/*.md")], cwd: engineCwd })

/** Every `ts` fence in the page compiles under strict tsc. */
const referenceCodeBlocks = Smithers.Markdown.CodeBlocks({
  file: Smithers.file("docs/reference/engine.md"),
  lang: ["ts"]
})

/** Writes `docs/reference/engine.md`; run with `smithers-build target //packages/smithers/flows/engine:referenceDocs --write`. */
const referenceDocs = Smithers.Agent.Diff({
  agent: docsWriter,
  prompt: Smithers.file("//apps/site/prompts/reference-package.md"),
  data: [docsSources, referenceStyle],
  changes: ["docs/reference/engine.md"],
  gates: [referenceCodeBlocks, check],
  maxRounds: 3
})
// --- end reference docs pipeline ------------------------------------------

export const Package = Smithers.Package({
  targets: {
    bunTest,
    check,
    circular,
    dependencyPolicy,
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

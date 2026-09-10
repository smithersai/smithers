/** Standard package targets for the published target authoring surface. */
import { Smithers } from "@smthrs/targets"
import { docsWriter, referenceStyle, rootInvariantsConfig, rootJSDocConfig } from "../../../../PACKAGE.ts"

const cwd = "packages/smithers/build/targets"
const sources = Smithers.glob("src/**/*.ts")
const tests = Smithers.glob("test/**/*.test.ts")
const testSupportSources = Smithers.glob("test-support/**/*.ts")
const testSupport = Smithers.Filegroup({ srcs: [testSupportSources], cwd })

const lib = Smithers.TsBuild({
  srcs: [sources],
  entries: [Smithers.file("src/index.ts")],
  deps: [],
  tsconfig: Smithers.file("tsconfig.json"),
  tool: { name: "program", entry: Smithers.file("scripts/build.mjs") },
  format: "dual",
  outDir: "dist",
  cwd
})

const check = Smithers.Typecheck({
  srcs: [sources, Smithers.glob("test/**/*.ts"), testSupportSources],
  deps: [lib],
  tsconfig: Smithers.file("tsconfig.test.json"),
  buildMode: false,
  incremental: false,
  cwd
})

const test = Smithers.Vitest({
  tests: [tests],
  sources: [sources],
  deps: [lib, testSupport],
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
  sources: [sources, Smithers.glob("test/**/*.ts"), testSupportSources],
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

// --- reference docs pipeline ----------------------------------------------
/** Everything the reference writer may read: sources, README, package docs, the rule table. */
const docsSources = Smithers.Filegroup({
  srcs: [sources, Smithers.file("README.md"), Smithers.glob("docs/*.md")],
  cwd
})

/**
 * The package's documentation as a file group (`docs/**`, the README, and
 * package.json), matching the filegroup BuildAndCheckTypeScriptPackage emits. The docs-site
 * content sync in `apps/docs/targets/PACKAGE.ts` depends on it by label, the
 * one way an input reaches across a package boundary.
 */
const docsFiles = Smithers.Filegroup({
  srcs: [Smithers.glob("docs/**/*.md"), Smithers.file("README.md"), Smithers.file("package.json")],
  cwd
})

/** The committed reference pages, as a set other packages depend on. */
const referencePages = Smithers.Filegroup({ srcs: [Smithers.glob("docs/reference/*.md")], cwd })

/** Every `ts` fence in the package page compiles under strict tsc. */
const referenceCodeBlocks = Smithers.Markdown.CodeBlocks({
  file: Smithers.file("docs/reference/targets.md"),
  lang: ["ts"]
})

/** Writes `docs/reference/targets.md`, the package page. */
const referenceDocs = Smithers.Agent.Diff({
  agent: docsWriter,
  prompt: Smithers.file("//apps/site/prompts/reference-package.md"),
  data: [docsSources, referenceStyle],
  changes: ["docs/reference/targets.md"],
  gates: [referenceCodeBlocks, check],
  maxRounds: 3
})

/**
 * One rule page per catalog rule. The seed is the hand-maintained page under
 * packages/smithers/build/docs/reference/targets, named as a `//` file input
 * because globs never cross a package boundary.
 */
const rulePage = (slug: string, seed: string) => {
  const page = `docs/reference/${slug}.md`
  const codeBlocks = Smithers.Markdown.CodeBlocks({ file: Smithers.file(page), lang: ["ts"] })
  const write = Smithers.Agent.Diff({
    agent: docsWriter,
    prompt: Smithers.file("//apps/site/prompts/reference-target-rule.md"),
    data: [
      docsSources,
      referenceStyle,
      Smithers.file(`//packages/smithers/build/docs/reference/targets/${seed}`),
      Smithers.file("//packages/smithers/build/targets/docs/rules.md")
    ],
    changes: [page],
    gates: [codeBlocks, check],
    maxRounds: 3
  })
  return { codeBlocks, write }
}

const filegroupRule = rulePage("filegroup", "filegroup.md")
const agentDiffRule = rulePage("agent-diff", "README.md")
const referenceFilegroupCodeBlocks = filegroupRule.codeBlocks
const referenceFilegroupDocs = filegroupRule.write
const referenceAgentDiffCodeBlocks = agentDiffRule.codeBlocks
const referenceAgentDiffDocs = agentDiffRule.write
// --- end reference docs pipeline ------------------------------------------

export const Package = Smithers.Package({
  targets: {
    check,
    circular,
    docs,
    docsFiles,
    fmt,
    lib,
    lint,
    test,
    testSupport,
    docsSources,
    referenceAgentDiffCodeBlocks,
    referenceAgentDiffDocs,
    referenceCodeBlocks,
    referenceDocs,
    referenceFilegroupCodeBlocks,
    referenceFilegroupDocs,
    referencePages
  }
})

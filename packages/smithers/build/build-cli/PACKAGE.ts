/** Standard package targets for the published build CLI. */
import { Smithers } from "@smthrs/targets"
import { rootInvariantsConfig, rootJSDocConfig } from "../../../../PACKAGE.ts"

const cwd = "packages/smithers/build/build-cli"
const sources = Smithers.glob("src/**/*.ts")
const javascript = Smithers.glob("src/**/*.js")
const tests = Smithers.glob("test/**/*.test.ts")

/**
 * The workspace trees the suites load: PACKAGE.ts and WORKSPACE.ts fixtures,
 * their goldens, and the checked-in files the render suites compare against.
 *
 * They are behavioural input to `PackageExecution`, `MultiRepo`, and the
 * CI-render suites, so they belong in the test target's key. Without them,
 * editing a fixture left the key unchanged and the run reported a cache hit
 * on a result that predated the edit.
 */
const fixtures = Smithers.glob("test/fixtures/**/*")
const routedFixture = Smithers.file("test/fixtures/force-spec/.github/PACKAGE.ts")

/** `Docs.test.ts` reads the package documentation, so it is key material. */
const prose = Smithers.glob("docs/**/*.md")
const readme = Smithers.file("README.md")

/**
 * The W4 package-API sweep harness. `SweepHarness.test.ts` imports its
 * classifiers and reads its expectations fixture, so the module is key
 * material for the suite.
 */
const sweep = Smithers.glob("scripts/package-api-sweep.*")

const lib = Smithers.TsBuild({
  srcs: [sources, javascript],
  entries: [Smithers.file("src/index.ts")],
  deps: [],
  tsconfig: Smithers.file("tsconfig.json"),
  tool: { name: "program", entry: Smithers.file("scripts/build.mjs") },
  format: "dual",
  outDir: "dist",
  cwd
})

const check = Smithers.Typecheck({
  srcs: [sources, javascript, Smithers.glob("test/**/*.ts")],
  deps: [lib],
  tsconfig: Smithers.file("tsconfig.test.json"),
  buildMode: false,
  incremental: false,
  cwd
})

const test = Smithers.Vitest({
  tests: [tests],
  sources: [sources, javascript, fixtures, routedFixture, prose, readme, sweep],
  deps: [lib],
  config: Smithers.file("vitest.config.ts"),
  environment: "node",
  passWithNoTests: false,
  // The serial suite reached 93 completed files before the default 20 minute
  // target bound on the release runner; keep the run finite with room to finish.
  timeoutMs: 1_800_000,
  cwd
})

const lint = Smithers.EsLint({
  sources: [sources, javascript],
  deps: [],
  configs: [Smithers.file("eslint.config.js"), rootJSDocConfig, rootInvariantsConfig],
  maxWarnings: 0,
  fix: false,
  cwd
})

const fmt = Smithers.Dprint({
  sources: [sources, javascript, Smithers.glob("test/**/*.ts")],
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
 * The package's documentation as a file group (`docs/**`, the README, and
 * package.json), matching the filegroup BuildAndCheckTypeScriptPackage emits. The docs-site
 * content sync in `apps/docs/build-cli/PACKAGE.ts` depends on it by label,
 * the one way an input reaches across a package boundary.
 */
const docsFiles = Smithers.Filegroup({
  srcs: [Smithers.glob("docs/**/*.md"), Smithers.file("README.md"), Smithers.file("package.json")],
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
  srcs: [sources, javascript],
  deps: [],
  cwd
})

export const Package = Smithers.Package({
  targets: { check, circular, docs, docsFiles, fmt, lib, lint, test }
})

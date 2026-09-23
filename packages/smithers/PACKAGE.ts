import { BuildAndCheckTypeScriptPackage } from "@smthrs/repo-targets"
/** Standard package targets plus package-owned documentation generation. */
import { Smithers } from "@smthrs/targets"
import { docsWriter, referenceStyle } from "../../PACKAGE.ts"

const { check, circular, docs, docsFiles, fmt, lib, lint, test } = BuildAndCheckTypeScriptPackage({
  deps: [],
  cwd: "packages/smithers",
  // On the Node 22 CI hosts this complete process-boundary suite took
  // 1166.5 s on macOS and was killed at 1200.1 s on Ubuntu. Keep its
  // aggregate coverage gate in one run, with twice the observed completed
  // duration available; individual test deadlines remain unchanged.
  testTimeoutMs: 40 * 60_000,
  // `scripts/build.mjs` bundles the TUI that `smthrs tui` runs.
  buildInputs: [Smithers.glob("//apps/tui/src/**/*.ts"), Smithers.glob("//apps/tui/src/**/*.tsx")],
  tests: Smithers.glob("test/**/*.test.ts", { exclude: ["test/faults/**"] })
})

/**
 * The package's fault-injection cases.
 *
 * A package opts into the matrix by declaring this key, so
 * `//packages/...:faults` is the whole matrix and nothing central lists which
 * packages are in it. The tier is separate from `test` because its cases are
 * machine-global — they kill process groups, bind ephemeral ports, and read
 * the process table — so they run serially, without coverage, from
 * `vitest.faults.config.ts`.
 */
const faults = Smithers.FaultSuite({ cwd: "packages/smithers" })

// --- reference docs pipeline ----------------------------------------------
const cliCwd = "packages/smithers"

/**
 * Everything the CLI reference writer may read: the command sources, README,
 * package docs, and the manifest whose version the docs pin. The site's
 * `//apps/site:cliData` generator lists this group in `data`, so a help
 * string, a removed-command anchor, or the version moves the docs' key.
 */
const docsSources = Smithers.Filegroup({
  srcs: [
    Smithers.glob("src/**/*.ts"),
    Smithers.file("README.md"),
    Smithers.file("package.json"),
    Smithers.glob("docs/*.md")
  ],
  cwd: cliCwd
})

/** The committed colocated CLI reference pages. Not ingested into apps/site yet; see apps/site/prompts/CLI-DIFF.md. */
const referencePages = Smithers.Filegroup({ srcs: [Smithers.glob("docs/reference/cli/*.md")], cwd: cliCwd })

/** One `docs/reference/cli/<verb>.md` page per shipped verb in src/Verb.ts; the writer reads the verb off its write-set path. */
const verbPage = (verb: string) =>
  Smithers.Agent.Diff({
    agent: docsWriter,
    prompt: Smithers.file("//apps/site/prompts/reference-cli-verb.md"),
    data: [docsSources, referenceStyle],
    changes: [`docs/reference/cli/${verb}.md`],
    gates: [check],
    maxRounds: 3
  })

const referenceCliPlan = verbPage("plan")
const referenceCliRun = verbPage("run")
const referenceCliUp = verbPage("up")
// --- end reference docs pipeline ------------------------------------------

export const Package = Smithers.Package({
  targets: {
    check,
    circular,
    docs,
    docsFiles,
    faults,
    fmt,
    lib,
    lint,
    test,
    docsSources,
    referenceCliPlan,
    referenceCliRun,
    referenceCliUp,
    referencePages
  }
})

/**
 * What the app's rules read: a rule that holds the Worker's own top-level sources holds every Worker source at any
 * depth (worker/github, worker/branch, worker/flows), a rule that reads no tests reads no test support either, and a
 * rule that reads some test support reads all of it. Each glob is matched as its checker matches it: `node:path`
 * `matchesGlob` for import rules (ImportRulesCheck) and minimatch with `dot` for Jev rules (LlmLint), which agree on
 * these globs.
 */
import { readdirSync, readFileSync } from "node:fs"
import { matchesGlob } from "node:path"
import { describe, expect, it } from "vitest"
import { importRules, jevRules } from "./PACKAGE.ts"

/** Every `.ts` file under worker/, app-relative with `/`. */
const workerFiles: ReadonlyArray<string> = readdirSync(new URL("worker", import.meta.url), { recursive: true })
  .map((path) => `worker/${String(path).split("\\").join("/")}`)
  .filter((path) => path.endsWith(".ts"))
  .sort()

/** A test, or code only tests load: anything under a `test/` directory. */
const isTest = (path: string) => path.endsWith(".test.ts")
const isTestSupport = (path: string) => !isTest(path) && path.split("/").slice(0, -1).includes("test")

const server = workerFiles.filter((path) => !isTest(path) && !isTestSupport(path))
const topLevel = server.filter((path) => path.split("/").length === 2)
const nested = server.filter((path) => path.split("/").length > 2)
const tests = workerFiles.filter(isTest)
const support = workerFiles.filter(isTestSupport)

const scopes = [
  ...importRules.flatMap((rule, index) =>
    rule.files === undefined ? [] : [{ name: `import rule ${index} (${rule.kind})`, files: rule.files }]
  ),
  ...jevRules.map((rule) => ({ name: `Jev rule ${rule.id}`, files: rule.files }))
]

const reads = (files: ReadonlyArray<string>, path: string) => files.some((glob) => matchesGlob(path, glob))

describe("the app's rule scopes", () => {
  it("allows only the built-in metadata, UI and flow registries to name plugin modules", () => {
    const rule = importRules.find((rule) => rule.because.startsWith("plugin.core-names-no-plugin:"))!
    const files = rule.files!
    expect(["src/plugins/builtin.ts", "src/plugins/builtinFlows.ts", "src/plugins/manifests.ts"].filter((path) => reads(files, path))).toEqual([])
    for (const path of ["src/plugins/plugins.ts", "src/plugins/other.ts", "src/plugins/nested/builtin.ts", "src/features/branch/steps.ts", "worker/branch/Creation.ts"]) {
      expect(reads(files, path), path).toBe(true)
    }
  })

  it("find Worker sources in subdirectories, tests and test support to check", () => {
    expect(topLevel.length).toBeGreaterThan(0)
    expect(nested.length).toBeGreaterThan(0)
    expect(tests.length).toBeGreaterThan(0)
    expect(support.some((path) => path.startsWith("worker/test/"))).toBe(true)
    expect(support.some((path) => !path.startsWith("worker/test/"))).toBe(true)
  })

  it.each(scopes)("$name: reading a top-level Worker source reads every nested one", ({ files }) => {
    if (!topLevel.some((path) => reads(files, path))) return
    expect(nested.filter((path) => !reads(files, path))).toEqual([])
  })

  it.each(scopes)("$name: reading no test reads no test support", ({ files }) => {
    if (tests.some((path) => reads(files, path))) return
    expect(support.filter((path) => reads(files, path))).toEqual([])
  })

  it.each(scopes)("$name: reading some test support reads all of it", ({ files }) => {
    if (!support.some((path) => reads(files, path))) return
    expect(support.filter((path) => !reads(files, path))).toEqual([])
  })
})

/**
 * GitHub's Actions, check and commit-status APIs and webhook events (github.no-actions in docs/rules.md): a
 * `/repos/…/actions/` path, `check-runs`, `check-suites`, `/statuses/`, a commit's `/status`, `check_run`,
 * `workflow_run`, and the SDK's `CheckRun` step. The app's own `/$owner/$repo/actions` route for Smithers flow runs
 * (decision 0014) has no `/repos/` before it.
 */
const githubActions =
  /\/repos\/[^\s"'`]*\/actions\/|\bcheck[-_]runs?\b|\bcheck[-_]suites?\b|\/statuses\/|\/commits\/[^\s"'`]*\/status(?:es)?\b|\bworkflow_(?:run|job|dispatch)\b|\b(?:layer)?CheckRun/

/** Every file under the app's source roots, app-relative with `/`. */
const appFiles: ReadonlyArray<string> = ["src", "worker", "db"].flatMap((root) =>
  readdirSync(new URL(root, import.meta.url), { recursive: true })
    .map((path) => `${root}/${String(path).split("\\").join("/")}`)
)

describe("github.no-actions", () => {
  it.each([
    "`/repos/${repository}/actions/runs`",
    "`/repos/${repository}/commits/${sha}/check-runs`",
    "`/repos/${repository}/check-suites/${id}`",
    "`/repos/${repository}/statuses/${sha}`",
    "`/repos/${repository}/commits/${sha}/status`",
    "case \"check_run\":",
    "\"workflow_run\"",
    "GitHub.Actions.CheckRun",
    "GitHub.Actions.layerCheckRun"
  ])("names %s", (text) => {
    expect(githubActions.test(text)).toBe(true)
  })

  it.each([
    "`/${owner}/${repo}/actions/runs/${runId}`",
    "import { open } from \"./actions\"",
    "store.statuses.tanstack",
    "GitHub.Actions.AddLabels"
  ])("lets %s through", (text) => {
    expect(githubActions.test(text)).toBe(false)
  })

  it("finds none in the files its Jev rule reads", () => {
    const files = jevRules.find((rule) => rule.id === "github.no-actions")?.files ?? []
    const read = appFiles.filter((path) => reads(files, path))
    expect(read.length).toBeGreaterThan(0)
    expect(read.filter((path) => githubActions.test(readFileSync(new URL(path, import.meta.url), "utf8")))).toEqual([])
  })
})

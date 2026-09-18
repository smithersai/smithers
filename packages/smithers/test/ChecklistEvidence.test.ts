/**
 * The facts the checklist reads, for the repositories the fixtures elsewhere
 * do not describe.
 *
 * `Suggest.test.ts` and `SuggestSurface.test.ts` drive the verb through one
 * JavaScript repository each, which leaves the rest of the evidence reader
 * and several rule arms unasserted: the runners named by a script other than
 * vitest, the languages a polyglot checkout declares, a runner configured
 * without a `test` script, a workspace described by `PACKAGE.ts`, and a
 * GitHub repository with no test runner at all. Each one changes what an
 * operator is offered, so each is pinned here against the same public
 * surface.
 */
import { describe, expect, it } from "vitest"
import * as Checklist from "../src/suggest/Checklist.ts"

const rule = (id: string): Checklist.Rule => {
  const found = Checklist.checks.find((check) => check.id === id)
  if (found === undefined) throw new Error(`no rule ${id}`)
  return found
}

describe("the evidence a repository leaves", () => {
  it("names the runner a test script spells, whichever one it is", () => {
    const jest = Checklist.memoryRepository("/jest", {
      "package.json": JSON.stringify({ scripts: { test: "jest --ci" } })
    })
    const bun = Checklist.memoryRepository("/bun", {
      "package.json": JSON.stringify({ scripts: { test: "bun test --coverage" } })
    })
    const other = Checklist.memoryRepository("/other", {
      "package.json": JSON.stringify({ scripts: { test: "make check" } })
    })
    expect(Checklist.evidence(jest).testRunner).toBe("jest")
    expect(Checklist.evidence(bun).testRunner).toBe("bun test")
    // Nothing recognised: the script itself is the best name available.
    expect(Checklist.evidence(other).testRunner).toBe("make check")
  })

  it("lists every language a polyglot checkout declares", () => {
    const polyglot = Checklist.memoryRepository("/polyglot", {
      "package.json": JSON.stringify({ scripts: { test: "jest" } }),
      "tsconfig.json": "{}",
      "Cargo.toml": "[package]\nname = \"x\"\n",
      "go.mod": "module example.com/x\n",
      "pyproject.toml": "[project]\nname = \"x\"\n"
    })
    expect(Checklist.evidence(polyglot).language).toEqual(["javascript", "typescript", "rust", "go", "python"])
  })

  it("cites only the runner's own files when no test script names it", () => {
    const repository = Checklist.memoryRepository("/runner", {
      "package.json": "{}",
      "vitest.config.ts": "export default {}"
    })
    const facts = Checklist.evidence(repository)
    expect(facts.testRunner).toBe("vitest")
    // `package.json` declares no test script, so citing it would send the
    // agent to a file that says nothing about the suggestion.
    expect(rule("test-target").match(facts, repository)).toMatchObject({ files: ["vitest.config.ts"] })
  })

  it("cites PACKAGE.ts as the layout when a build manifest is the only one", () => {
    const repository = Checklist.memoryRepository("/package-ts", {
      "PACKAGE.ts": "export const Package = {}",
      "package.json": JSON.stringify({ scripts: { build: "smthrs ci" } })
    })
    const facts = Checklist.evidence(repository)
    expect(facts.packageFile).toBe(true)
    expect(facts.monorepo).toEqual([])
    expect(rule("agents-md").match(facts, repository)).toMatchObject({ files: ["PACKAGE.ts"] })
  })

  it("offers a sandboxed review to a GitHub repository that has no runner", () => {
    const repository = Checklist.memoryRepository("/no-runner", {
      ".github/workflows/ci.yml": "on: push\n"
    })
    const facts = Checklist.evidence(repository)
    expect(facts).toMatchObject({ github: true, testRunner: undefined })
    const suggestion = rule("sandboxed-review").match(facts, repository)
    expect(suggestion).toMatchObject({ files: [".git/config"] })
    expect(suggestion!.why).toContain("the review can run in a sandbox")
  })
})

/**
 * A repository with one dependency and no lockfile, whose CI is `npm install`
 * then `npm test`.
 *
 * With no lockfile, `npm install` reads every package under `node_modules` to
 * decide what to keep. Anything the replay put there is a package npm did not
 * ask for: npm stops on it, the step fails where the repository's own CI
 * passes, and every commit is a mismatch. So the replay puts nothing into a
 * checkout but the generated files.
 *
 * The real program replays two commits with the real `npm`, `node` and
 * `smthrs`.
 */
import { afterAll, describe, expect, it } from "vitest"
import type { ReplayReport } from "../../src/contract/ReplayReport.ts"
import { bin, commit, git, remove, spawn, temporary } from "./repo.ts"

const made: Array<string> = []
afterAll(() => made.forEach(remove))

const workflow = [
  "name: CI",
  "on: [push]",
  "jobs:",
  "  test:",
  "    runs-on: ubuntu-latest",
  "    steps:",
  "      - uses: actions/checkout@v4",
  "      - run: npm install",
  "      - run: npm test",
  ""
].join("\n")

const test = "require(\"node:assert\").strictEqual(require(\"dependency\"), \"ok\")\n"

/** The repository: a package that depends on one beside it, and a test that loads the dependency. */
const repository = (): string => {
  const root = temporary("npm-install")
  made.push(root)
  git(root, "init", "--quiet", "--initial-branch=main")
  commit(root, "base", {
    ".github/workflows/ci.yml": workflow,
    ".gitignore": "node_modules\npackage-lock.json\n",
    "dependency/index.js": "module.exports = \"ok\"\n",
    "dependency/package.json": JSON.stringify({ name: "dependency", version: "1.0.0" }),
    "package.json": JSON.stringify({
      name: "fixture",
      version: "1.0.0",
      scripts: { test: "node test.js" },
      dependencies: { dependency: "file:./dependency" }
    }),
    "test.js": test
  })
  return root
}

describe("a repository with no lockfile whose CI is npm install, then npm test", () => {
  it("passes in normal mode at every commit, as the repository's own CI does", async () => {
    const root = repository()
    commit(root, "the test says more", { "test.js": `${test}console.log("ok")\n` })
    const outcome = await spawn(bin, ["--commits", "2", "--json"], root)
    const report = JSON.parse(outcome.stdout) as ReplayReport
    expect(report.commits.map((entry) => [entry.baseline.ok, entry.normal?.ok, entry.mismatches])).toEqual([
      [true, true, []],
      [true, true, []]
    ])
    expect(report.mismatches).toBe(0)
    // No step failed, so no line tells the person to change a tool's ignore list.
    expect(`${outcome.stdout}${outcome.stderr}`).not.toContain("ignore list")
    expect(outcome.code).toBe(0)
  }, 540_000)
})

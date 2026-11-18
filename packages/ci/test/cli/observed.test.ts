/**
 * The most common CI, end to end: an npm workspace whose two jobs are
 * `npm ci` then `npm run lint`, and `npm ci` then `npm test`. Nobody says what
 * those commands read.
 *
 * The real program replays five commits of a real repository with the real
 * `npm`, `node` and `smthrs`. A step runs again only when a file its last run
 * read has changed, and its verdict always equals the verdict of the
 * repository's own CI. The reads are recorded by `strace`, so the case runs on
 * a Linux host that has it.
 */
import { execFileSync } from "node:child_process"
import { afterAll, describe, expect, it } from "vitest"
import type { ReplayReport } from "../../src/contract/ReplayReport.ts"
import { bin, commit, git, observes, pathWithout, remove, spawn, spawnWith, temporary } from "./repo.ts"

const made: Array<string> = []
afterAll(() => made.forEach(remove))

const workflow = [
  "name: CI",
  "on:",
  "  push:",
  "    branches: [main]",
  "  pull_request:",
  "jobs:",
  "  lint:",
  "    runs-on: ubuntu-latest",
  "    steps:",
  "      - uses: actions/checkout@v4",
  "      - run: npm ci",
  "      - run: npm run lint",
  "  test:",
  "    runs-on: ubuntu-latest",
  "    steps:",
  "      - uses: actions/checkout@v4",
  "      - run: npm ci",
  "      - run: npm test",
  ""
].join("\n")

const passing = "require(\"node:assert\").strictEqual(require(\"./value.js\"), \"ok\")\n"

/** A package whose `npm test` runs every test file `node --test` finds in it. */
const packageOf = (name: string): Readonly<Record<string, string>> => ({
  [`packages/${name}/package.json`]: JSON.stringify({
    name: `@fixture/${name}`,
    version: "1.0.0",
    scripts: { test: "node --test" }
  }),
  [`packages/${name}/${name}.test.js`]: passing,
  [`packages/${name}/value.js`]: "module.exports = \"ok\"\n"
})

/** The repository at its first commit: a lint script, two packages with one test each, and docs nothing reads. */
const repository = (): string => {
  const root = temporary("observed")
  made.push(root)
  git(root, "init", "--quiet", "--initial-branch=main")
  commit(root, "base", {
    ".github/workflows/ci.yml": workflow,
    ".gitignore": "node_modules\n",
    "docs/readme.md": "# Fixture\n",
    "lint.js": "if (require(\"./package.json\").private !== true) process.exit(1)\n",
    "package.json": JSON.stringify({
      name: "fixture",
      private: true,
      workspaces: ["packages/*"],
      scripts: { lint: "node lint.js", test: "npm run test --workspaces" }
    }),
    ...packageOf("a"),
    ...packageOf("b")
  })
  // The lockfile `npm ci` needs, written by npm itself. The workspace has no package to download.
  execFileSync("npm", ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund", "--offline"], {
    cwd: root,
    stdio: "ignore"
  })
  commit(root, "lockfile")
  return root
}

describe("a repository whose CI is npm ci, then npm run lint and npm test", () => {
  it.skipIf(!observes)(
    "reruns a step only when a file it read changed, with the verdicts of the repository's own CI",
    async () => {
      const root = repository()
      commit(root, "docs only", { "docs/readme.md": "# Fixture\n\nMore words.\n" })
      commit(root, "break what a test imports", { "packages/a/value.js": "module.exports = \"broken\"\n" })
      commit(root, "repair it", { "packages/a/value.js": "module.exports = \"ok\"\n", "docs/readme.md": "# Fixture\n" })
      commit(root, "a new test file that fails", {
        "packages/b/extra.test.js": "require(\"node:assert\").strictEqual(1, 2)\n"
      })

      // The newest commit fails on purpose, and its verdict is what is compared: nothing is left out.
      const outcome = await spawn(bin, ["--commits", "5", "--json", "--no-trial"], root)
      expect(outcome.stderr).not.toContain("reads are not observed")
      const report = JSON.parse(outcome.stdout) as ReplayReport
      const subjects = git(root, "log", "--reverse", "--format=%H %s", "-5").trim().split("\n")
      const normal = (subject: string) => {
        const hash = subjects.find((line) => line.endsWith(` ${subject}`))?.split(" ")[0]
        const replayed = report.commits.find((entry) => entry.commit === hash)
        const counts = replayed?.normal?.counts
        return {
          baseline: replayed?.baseline.ok,
          hit: counts?.hit,
          failed: counts?.failed,
          // `npm ci` always runs; every other step ran, hit or failed.
          steps: counts === undefined ? undefined : counts.hit + counts.ran + counts.failed + counts.skipped,
          mismatches: replayed?.mismatches
        }
      }
      const steps = normal("lockfile").steps
      expect(steps).toBeGreaterThanOrEqual(3)
      // The first commit has nothing to reuse.
      expect(normal("lockfile")).toEqual({ baseline: true, hit: 0, failed: 0, steps, mismatches: [] })
      // Neither step read the docs, so both are answered from the cache.
      expect(normal("docs only")).toEqual({ baseline: true, hit: 2, failed: 0, steps, mismatches: [] })
      // The test step read the file, so it runs again and fails as the repository's CI does. Lint did not read it.
      expect(normal("break what a test imports")).toEqual({
        baseline: false,
        hit: 1,
        failed: 1,
        steps,
        mismatches: []
      })
      // Every file is as an earlier passing run left it.
      expect(normal("repair it")).toEqual({ baseline: true, hit: 2, failed: 0, steps, mismatches: [] })
      // A new file in a directory the test runner listed: the test step runs again and finds the failing test.
      expect(normal("a new test file that fails")).toEqual({
        baseline: false,
        hit: 1,
        failed: 1,
        steps,
        mismatches: []
      })
      expect(report.mismatches).toBe(0)
      expect(outcome.code).toBe(0)
    },
    540_000
  )

  it.skipIf(process.platform !== "linux")(
    "says once, on standard error, when this machine cannot record what a step reads",
    async () => {
      const root = repository()
      commit(root, "docs only", { "docs/readme.md": "# Fixture\n\nMore words.\n" })
      const tools = temporary("no-strace")
      made.push(tools)
      const outcome = await spawnWith(bin, ["--commits", "2", "--json"], root, { PATH: pathWithout("strace", tools) })
      const sentence = "smithers-ci: this machine cannot record what a step reads (strace is not installed). "
        + "A step that names no inputs runs on every commit. On Linux, install strace."
      expect(outcome.stderr.split("\n").filter((line) => line === sentence)).toHaveLength(1)
      expect(outcome.stdout).not.toContain("cannot record")
      expect(outcome.code).toBe(0)
    },
    540_000
  )
})

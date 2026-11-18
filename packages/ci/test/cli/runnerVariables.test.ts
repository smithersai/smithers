/**
 * The variables a GitHub runner gives every step, end to end.
 *
 * The real program replays four commits of a real repository with the real
 * `smthrs` and `node`, under `strace`. No step's script names a variable:
 * each runs a program that reads its environment from its own code, as a
 * test does. Every step is given the commit and the run's number, in the
 * baseline and as a target. A step that used one of them runs again at every
 * commit and is never answered with another commit's result. A step that
 * used none is reused when no file it read has changed.
 *
 * The program is started from a shell that holds variables of its own under a runner's names. None reaches a
 * step: `CI` is `true` unless the workflow sets it, and a step's script finds no variable of the program.
 */
import { afterAll, describe, expect, it } from "vitest"
import type { ReplayReport } from "../../src/contract/ReplayReport.ts"
import { bin, commit, git, observes, remove, spawn, temporary } from "./repo.ts"

const made: Array<string> = []
afterAll(() => made.forEach(remove))

const job = (name: string, run: string): ReadonlyArray<string> => [
  `  ${name}:`,
  "    runs-on: ubuntu-latest",
  "    steps:",
  "      - uses: actions/checkout@v4",
  `      - run: ${run}`
]

const workflow = [
  "name: CI",
  "on:",
  "  push:",
  "    branches: [main]",
  "  pull_request:",
  "jobs:",
  ...job("snapshot", "node test/snapshot.js"),
  ...job("parity", "node test/parity.js"),
  ...job("plain", "node test/plain.js"),
  ...job("dump", "sh tools/dump.sh"),
  "  own:",
  "    runs-on: ubuntu-latest",
  "    steps:",
  "      - uses: actions/checkout@v4",
  "      - run: test \"$CI\" = false",
  "        env:",
  "          CI: \"false\"",
  ""
].join("\n")

/** What the shell that starts the program holds under a runner's names. */
const persons: Readonly<Record<string, string>> = {
  CI: "1",
  GITHUB_ACTOR: "zz-persons-own",
  GITHUB_REPOSITORY: "zz-persons-own/repository",
  GITHUB_TOKEN: "zz-persons-own-token",
  RUNNER_DEBUG: "1",
  RUNNER_NAME: "zz-persons-own"
}

const files: Readonly<Record<string, string>> = {
  ".github/workflows/ci.yml": workflow,
  ".gitignore": "out\n",
  "docs/readme.md": "# Fixture\n",
  "src/value.txt": "ok\n",
  // A test that prints the commit into a snapshot. It fails where no runner gave it one.
  "test/snapshot.js": [
    "const fs = require(\"node:fs\")",
    "const commit = process.env.GITHUB_SHA ?? \"\"",
    "if (!/^[0-9a-f]{40}$/.test(commit)) { console.error(`GITHUB_SHA is no commit: ${commit}`); process.exit(1) }",
    "fs.mkdirSync(\"out\", { recursive: true })",
    "fs.writeFileSync(\"out/snapshot.txt\", `built at ${commit}\\n`)",
    ""
  ].join("\n"),
  // A test whose verdict is another at every other run: it passes when the run's number is even.
  "test/parity.js": "process.exit(Number(process.env.GITHUB_RUN_NUMBER) % 2)\n",
  // A test that reads a file and no variable of the run.
  "test/plain.js":
    "if (!require(\"node:fs\").readFileSync(\"src/value.txt\", \"utf8\").startsWith(\"ok\")) process.exit(1)\n",
  // A script that names no variable of the run and writes every one it was given. It fails when `CI` is not
  // `true`, and when it finds a variable of the program that runs it or anything of the shell that started that.
  "tools/dump.sh": [
    "set -e",
    "mkdir -p out",
    "env > out/env.txt",
    "grep -qx 'CI=true' out/env.txt",
    "! grep -E '^(SMITHERS_|SMTHRS_|RUNNER_DEBUG=)|zz-persons-own' out/env.txt",
    ""
  ].join("\n")
}

describe("a workflow whose steps read a runner's variables from their own code", () => {
  it.skipIf(!observes)(
    "runs a step that used the commit or the run's number again at every commit, and reuses one that used neither",
    async () => {
      const root = temporary("runner-variables")
      made.push(root)
      git(root, "init", "--quiet", "--initial-branch=main")
      commit(root, "base", files)
      commit(root, "docs only", { "docs/readme.md": "# Fixture\n\nMore words.\n" })
      commit(root, "docs again", { "docs/readme.md": "# Fixture\n\nOther words.\n" })
      commit(root, "the file a test reads changes", { "src/value.txt": "ok, still\n" })

      const outcome = await spawn(bin, ["--commits", "4", "--no-apply-check", "--json"], root, {
        ...process.env,
        ...persons
      })
      expect(outcome.stderr).not.toContain("reads are not observed")
      const report = JSON.parse(outcome.stdout) as ReplayReport
      const subjects = git(root, "log", "--reverse", "--format=%H %s", "-4").trim().split("\n")
      const at = (subject: string) => {
        const hash = subjects.find((line) => line.endsWith(` ${subject}`))?.split(" ")[0]
        const replayed = report.commits.find((entry) => entry.commit === hash)
        const counts = replayed?.normal?.counts
        return {
          baseline: replayed?.baseline.ok,
          baselineFailed: (replayed?.baseline.failures ?? []).map((failure) => failure.step),
          hit: counts?.hit,
          failed: (replayed?.normal?.failures ?? []).map((failure) => failure.step),
          steps: counts === undefined ? undefined : counts.hit + counts.ran + counts.failed + counts.skipped,
          mismatches: replayed?.mismatches
        }
      }
      const parity = at("base").baselineFailed
      // The first commit is run 1: the test that passes at an even number fails, in the baseline and as a target.
      // Every other test passes: the one that needs the commit, the one that looks for `CI=true` and for anything
      // of the shell that started the program, and the one whose workflow sets `CI` itself.
      expect(parity).toHaveLength(1)
      expect(parity?.[0]).toContain("parity")
      expect(at("base")).toEqual({
        baseline: false,
        baselineFailed: parity,
        hit: 0,
        failed: parity,
        steps: 5,
        mismatches: []
      })
      // Nothing a step read changed. The two tests that read no variable of the run are answered from the first
      // commit's run. The three that used the commit or the run's number ran again: run 2 is even, so that test
      // now passes.
      expect(at("docs only")).toEqual({
        baseline: true,
        baselineFailed: [],
        hit: 2,
        failed: [],
        steps: 5,
        mismatches: []
      })
      // Run 3: it fails again, as it does in the baseline. An answer from run 2 would have been a pass.
      expect(at("docs again")).toEqual({
        baseline: false,
        baselineFailed: parity,
        hit: 2,
        failed: parity,
        steps: 5,
        mismatches: []
      })
      // The file the plain test reads is another, so it runs too. The test of `CI` reads no file.
      expect(at("the file a test reads changes")).toEqual({
        baseline: true,
        baselineFailed: [],
        hit: 1,
        failed: [],
        steps: 5,
        mismatches: []
      })
      expect(report.mismatches).toBe(0)
    },
    540_000
  )
})

/**
 * A file a step made is the step's own.
 *
 * uv fills its cache as many package managers do: it makes a directory under
 * a temporary name, writes the package into it, moves the directory to its
 * place, then reads and rewrites a file of it. The step found nothing there
 * when it began, so nothing there is an input of the step, and the step is
 * reused at the next commit. uv names a directory it makes `dir/`, with a
 * slash at the end; the build filed `dir/` apart from `dir`, so the move did
 * not carry the files in it, and every such step ran again at every commit:
 * `.../pyyaml-6.0.3.dist-info/RECORD changed while it ran`.
 *
 * A file that was there when the step began and changed while it ran still
 * keeps the step from being reused: here the step reads `seed` and appends
 * to it under another name, `alias`, so what it read is not what is there.
 *
 * The real program replays two commits with the real `smthrs` and the real
 * tracer, with no network.
 */
import { afterAll, describe, expect, it } from "vitest"
import type { ReplayReport } from "../../src/contract/ReplayReport.ts"
import { bin, commit, git, observes, remove, spawn, temporary } from "./repo.ts"

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
  "      - name: own",
  "        run: sh own.sh",
  "      - name: seed",
  "        run: echo a > \"$HOME/seed\" && ln \"$HOME/seed\" \"$HOME/alias\"",
  "      - name: grow",
  "        run: cat \"$HOME/seed\" && echo b >> \"$HOME/alias\"",
  ""
].join("\n")

// What uv does in its cache, in the job's home, which is empty when the job starts.
const own = [
  "set -e",
  "c=\"$HOME/.cache/tool\"",
  "mkdir -p \"$c/archive\"",
  "t=\"$c/.tmp$$\"",
  "mkdir \"$t\" \"$t/pkg/\"",
  "echo one > \"$t/pkg/RECORD\"",
  "a=\"$c/archive/$$-$(date +%s%N)\"",
  "mv \"$t\" \"$a\"",
  "cat \"$a/pkg/RECORD\"",
  "echo two >> \"$a/pkg/RECORD\"",
  "cat data.txt",
  ""
].join("\n")

describe("a file a step made", () => {
  it.skipIf(!observes)("is the step's own, and the step is reused when nothing it read changed", async () => {
    const root = temporary("own-files")
    made.push(root)
    git(root, "init", "--quiet", "--initial-branch=main")
    commit(root, "base", {
      ".github/workflows/ci.yml": workflow,
      "own.sh": own,
      "data.txt": "1\n",
      "docs/readme.md": "# Fixture\n"
    })
    commit(root, "docs", { "docs/readme.md": "# Fixture\n\nMore.\n" })
    commit(root, "more docs", { "docs/readme.md": "# Fixture\n\nMore words.\n" })
    const outcome = await spawn(bin, ["--commits", "2", "--json", "--no-trial", "--no-apply-check"], root)
    expect(outcome.stderr).not.toContain("reads are not observed")
    const report = JSON.parse(outcome.stdout) as ReplayReport
    expect(
      report.commits.map((entry) => [
        entry.normal.counts.hit,
        entry.normal.notReused?.map((step) => [step.step, step.reason.replace(/^\/\S*\/seed /, "<home>/seed ")]),
        entry.mismatches.length
      ])
    ).toEqual([
      [2, [["ci.yml:test: grow", "<home>/seed changed while it ran"]], 0],
      [2, [["ci.yml:test: grow", "<home>/seed changed while it ran"]], 0]
    ])
    expect(outcome.code).toBe(0)
  }, 900_000)
})

// click's typing job: `actions/cache` puts `.mypy_cache` back at every commit, from one entry while `pyproject.toml`
// is the same, and mypy reads `cache.db` and writes it again. The step read the same file at a commit that changed
// only docs as at the commit before; what it left there differs, since the cache step puts back the older entry.
const cachedWorkflow = [
  "name: CI",
  "on: [push]",
  "jobs:",
  "  typing:",
  "    runs-on: ubuntu-latest",
  "    steps:",
  "      - uses: actions/checkout@v4",
  "      - uses: actions/cache@v4",
  "        with:",
  "          path: ./.c",
  "          key: c-${{ hashFiles('key.txt') }}",
  "      - name: check",
  "        run: sh check.sh",
  ""
].join("\n")

const check = [
  "mkdir -p .c",
  "cat src.txt",
  "if [ -f .c/db ]; then cat .c/db; fi",
  "date +%s%N >> .c/db",
  ""
].join("\n")

describe("a file a cache step puts back, which a step reads and rewrites", () => {
  it.skipIf(!observes)("is held as the step found it, and the step is reused when it finds it so again", async () => {
    const root = temporary("found-files")
    made.push(root)
    git(root, "init", "--quiet", "--initial-branch=main")
    commit(root, "base", {
      ".github/workflows/ci.yml": cachedWorkflow,
      "check.sh": check,
      "key.txt": "1\n",
      "src.txt": "one\n",
      "docs/readme.md": "# Fixture\n"
    })
    commit(root, "a source change", { "src.txt": "two\n" })
    commit(root, "docs", { "docs/readme.md": "# Fixture\n\nMore.\n" })
    const outcome = await spawn(bin, ["--commits", "2", "--json", "--no-trial", "--no-apply-check"], root)
    expect(outcome.stderr).not.toContain("reads are not observed")
    const report = JSON.parse(outcome.stdout) as ReplayReport
    expect(
      report.commits.map((entry) => [
        entry.normal.counts.hit,
        entry.normal.notReused?.map((step) => [step.step, step.reason]),
        entry.mismatches.length
      ])
    ).toEqual([
      // The cache step restores and saves at every commit; the check runs where its source changed.
      [0, [["ci.yml:typing: check", "src.txt changed"]], 0],
      [1, undefined, 0]
    ])
    expect(outcome.code).toBe(0)
  }, 900_000)
})

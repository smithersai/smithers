/**
 * Nothing of Smithers CI is in the checkout a step sees. A repository whose
 * CI checks that its tree holds what the commit holds, by every means a step
 * has: `git status` with and without ignored files, `git clean`, the files
 * on disk against `git ls-files`, a listing of the root, and what git itself
 * keeps beside the files: stashes, worktrees, refs, local configuration,
 * hooks, the bits of the index, whether the history is whole. Each check
 * passes in a fresh clone on a CI machine, so each passes in a replay both
 * ways, and in the CI `apply` writes.
 */

import * as Schema from "effect/Schema"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { ReplayReport } from "../../src/contract/ReplayReport.ts"
import { stateDirectory, workflowPath, workspacePath } from "../../src/generate/Render.ts"
import { smthrs } from "../replay/fixture.ts"
import { commit, node, program, project, removeProjects, run, write } from "./project.ts"

const scratch: Array<string> = []
const temporary = (): string => {
  const directory = mkdtempSync(join(tmpdir(), "smithers-ci-clean-tree-"))
  scratch.push(directory)
  return directory
}

afterAll(() => {
  removeProjects()
  for (const directory of scratch.splice(0)) rmSync(directory, { recursive: true, force: true })
})

/**
 * The checks, by job. Each is one line a CI step runs at the root of its checkout, and each passes in a fresh
 * clone of the repository.
 */
const checks: Readonly<Record<string, string>> = {
  // Three of the four ways the second review found the cache and the generated files.
  cleanstatus: `test -z "$(git status --porcelain)"`,
  cleanignored: `test -z "$(git status --porcelain --ignored)"`,
  cleangit: `test -z "$(git clean -ndx)"`,
  cleanfind:
    `diff <(find . -path ./.git -prune -o -type f -print -o -type l -print | sed 's#^./##' | sort) <(git ls-files | sort)`,
  // A directory with nothing in it is in no listing of files: none is left behind either.
  emptydirs: `test -z "$(find . -path ./.git -prune -o -type d -empty -print)"`,
  // What git keeps beside the files.
  stash: `test -z "$(git stash list)"`,
  worktrees:
    `test -d .git && test "$(git worktree list --porcelain | grep -c '^worktree ')" = 1 && test ! -e .git/worktrees`,
  // The history is whole, as in the clone a baseline step runs in: no copy is cut short.
  shallow: `test "$(git rev-parse --is-shallow-repository)" = false && test ! -e .git/shallow`,
  refs: `test -z "$(git for-each-ref --format='%(refname)' | grep -vE '^refs/(heads|tags|remotes/origin)/')"`,
  config:
    `test -z "$(git config --local --name-only --list | grep -viE '^(core\\.(repositoryformatversion|filemode|bare|logallrefupdates|ignorecase|precomposeunicode|symlinks)|remote\\.origin\\.(url|fetch|pushurl)|branch\\..*)$')"`,
  hooks: `test -z "$(ls .git/hooks 2>/dev/null | grep -v '\\.sample$')"`,
  // An index entry marked assume-unchanged or skip-worktree is listed with another letter than H.
  indexbits: `test -z "$(git ls-files -v | grep -v '^H ')" && test -z "$(git ls-files -t | grep -v '^H ')"`,
  exclude: `test -z "$(grep -v '^#' .git/info/exclude 2>/dev/null | grep .)"`,
  // No variable of Smithers build or Smithers CI reaches a step, and none that the generated workflow sets for it.
  variables: `test -z "$(env | grep -E '^(SMITHERS|SMTHRS)_|^NODE_COMPILE_CACHE=|^VIBELANG_CACHE_DIR=')"`,
  // What a CI machine says of itself is said everywhere a step runs, whatever the shell that started the program holds.
  runner: `test "$CI" = true && test "$GITHUB_ACTIONS" = true`,
  // A step that leaves an ignored file finds the tree as clean as the commit says, at the next commit too.
  leavesignored: `test ! -e out/seen && mkdir -p out && touch out/seen`
}

/**
 * The fourth way: a listing of the root. A replayed commit holds no directory of Smithers CI's. After `apply`
 * the repository holds `.smithers`, committed, and still no cache directory.
 */
const inReplay = { ...checks, cleanls: `test -z "$(ls -A | grep -E '^\\.(flows|smithers)$')"` }
const afterApply = { ...checks, cleanls: `test -z "$(ls -A | grep -E '^\\.flows$')" && test -d .smithers` }

const workflow = (jobs: Readonly<Record<string, string>>): string =>
  [
    "name: CI",
    "on: [push, pull_request]",
    "jobs:",
    ...Object.entries(jobs).flatMap(([id, command]) => [
      `  ${id}:`,
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - uses: actions/checkout@v4",
      `      - run: ${JSON.stringify(command)}`
    ]),
    ""
  ].join("\n")

const files = (jobs: Readonly<Record<string, string>>): Readonly<Record<string, string>> => ({
  // As most repositories: an ignore file that names nothing of Smithers CI.
  ".gitignore": "out\nnode_modules\n",
  "docs/r.md": "1\n",
  "src/m": "ok\n",
  ".github/workflows/ci.yml": workflow(jobs)
})

/** Every file and link under `root` but `.git`, from the root, sorted. */
const listed = (root: string, directory = ""): ReadonlyArray<string> =>
  readdirSync(join(root, directory), { withFileTypes: true }).flatMap((entry) => {
    const path = directory === "" ? entry.name : `${directory}/${entry.name}`
    if (path === ".git") return []
    return entry.isDirectory() ? listed(root, path) : [path]
  }).sort()

const tracked = (root: string): ReadonlyArray<string> =>
  run(root, "git", ["ls-files"]).stdout.split("\n").filter((line) => line !== "").sort()

describe("a repository whose CI checks that its checkout holds what the commit holds", () => {
  it("replays with every check passing both ways, at every commit", () => {
    const root = project(files(inReplay), false)
    write(root, { "docs/r.md": "2\n" })
    commit(root, "docs only")
    write(root, { "src/m": "ok\n# 2\n" })
    commit(root, "a source")
    const replayed = node(root, program, ["--commits", "3", "--json"])
    expect(replayed.status, replayed.output).toBe(0)
    const report = Schema.decodeUnknownSync(Schema.fromJsonString(ReplayReport))(replayed.stdout)
    expect(report.commits).toHaveLength(3)
    for (const entry of report.commits) {
      expect(entry.baseline.failures ?? [], entry.commit).toEqual([])
      expect(entry.normal.failures ?? [], entry.commit).toEqual([])
      expect(entry.mismatches, entry.commit).toEqual([])
    }
    expect(report.mismatches).toBe(0)
    expect(report.notReplayed ?? []).toEqual([])
    // The replay wrote nothing to the repository either.
    expect(run(root, "git", ["status", "--porcelain", "--ignored"]).stdout).toBe("")
    expect(listed(root)).toEqual(tracked(root))
  }, 3_600_000)

  it("passes every check in the CI apply writes, on a runner and on a person's machine", () => {
    const root = project(files(afterApply), false)
    const wrote = node(root, program, ["apply"])
    expect(wrote.status, wrote.output).toBe(0)
    expect(wrote.output).toContain(`wrote ${workspacePath}\n`)
    // apply leaves the repository's ignore file as it is: nothing of Smithers CI is in the checkout to ignore.
    expect(wrote.output).not.toContain(".gitignore")
    expect(readFileSync(join(root, ".gitignore"), "utf8")).toBe("out\nnode_modules\n")
    commit(root, "smithers-ci apply")
    // What apply wrote is part of the repository now, and nothing else is in it.
    expect(run(root, "git", ["status", "--porcelain", "--ignored"]).stdout).toBe("")

    // On a runner the workflow names a directory outside the checkout, and saves and restores it.
    const text = readFileSync(join(root, workflowPath), "utf8")
    expect(text).toContain(`--cache-dir "${stateDirectory}"`)
    expect(text).toContain(`          path: |\n            ${stateDirectory}/cache\n`)
    expect(text).not.toContain(".flows")
    const runner = temporary()
    const state = join(runner, "smithers-ci")
    // The command of the generated workflow, with the smthrs of this repository.
    const generatedCi = (extra: ReadonlyArray<string>, env: Readonly<Record<string, string>> = {}) => {
      const ran = spawnSync(smthrs, ["ci", "//...", "--jobs", "1", "--ui", "plain", ...extra], {
        cwd: root,
        encoding: "utf8",
        env: { ...process.env, ...env },
        maxBuffer: 64 * 1024 * 1024
      })
      return { status: ran.status, output: `${ran.stdout}${ran.stderr}` }
    }
    // As the workflow starts it: the cache directory named, and the variables the workflow sets for smthrs alone.
    const first = generatedCi(["--cache-dir", state], {
      NODE_COMPILE_CACHE: join(state, "node-compile-cache"),
      SMITHERS_CACHE_TOKEN: "not-a-token"
    })
    expect(first.status, first.output).toBe(0)
    expect(readdirSync(state)).toContain("cache")
    // The checkout still holds what the commit holds: every file is a tracked one. A job runs in a copy of its
    // own, so what a step leaves is not in the checkout either.
    expect(listed(root)).toEqual(tracked(root))
    expect(run(root, "git", ["status", "--porcelain"]).stdout).toBe("")

    // On a person's machine no flag is given: the cache is in the user's cache directory.
    const cacheHome = temporary()
    const home = temporary()
    mkdirSync(join(home, "empty"))
    const own = generatedCi([], { XDG_CACHE_HOME: cacheHome, HOME: home })
    expect(own.status, own.output).toBe(0)
    const kept = readdirSync(join(cacheHome, "smithers"))
    expect(kept).toHaveLength(1)
    expect(listed(root)).toEqual(tracked(root))
    expect(run(root, "git", ["status", "--porcelain"]).stdout).toBe("")
  }, 3_600_000)
})

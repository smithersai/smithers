/**
 * The generated targets run by hand, `smthrs ci '//...'` with no runner's variables, reuse what they reuse on a
 * runner: the runner text's own question of which commit is checked out is no read of the step's.
 */
import * as Effect from "effect/Effect"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll, describe, expect, it } from "vitest"
import { ci } from "../src/contract/Inventory.vibe"
import { files } from "../src/generate/index.vibe"
import { assemble } from "../src/inventory/Draft.vibe"
import { readWorkflow } from "../src/inventory/GithubActions.vibe"
import { observes } from "./cli/repo.ts"

const cli = fileURLToPath(new URL("../../smithers/bin/smithers.mjs", import.meta.url))
const slow = 600_000
const made: Array<string> = []
afterAll(() => {
  for (const path of made) rmSync(path, { recursive: true, force: true })
})

/** The variables of this process but the runner's: a person's shell. */
const byHand = (): NodeJS.ProcessEnv =>
  Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(?:GITHUB|RUNNER)_/.test(name)))

const git = (root: string, ...args: ReadonlyArray<string>): string => {
  const result = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.test", ...args], {
    cwd: root,
    encoding: "utf8"
  })
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`)
  return result.stdout.trim()
}

const path = ".github/workflows/ci.yml"

/** A repository on a branch, holding a workflow, its sources and the files generated for it, committed. */
const repository = (workflow: string, sources: Readonly<Record<string, string>>): string => {
  const root = mkdtempSync(join(tmpdir(), "smithers-ci-by-hand-"))
  made.push(root, `${root}.state`)
  mkdirSync(`${root}.state`)
  git(root, "init", "-q", "--initial-branch=main", ".")
  const read = assemble("example/real", "0000000000000000000000000000000000000006", [readWorkflow(path, workflow)])
  const generated = Effect.runSync(files(ci(read)))
  const all = [
    [path, workflow] as const,
    ...Object.entries(sources),
    ...generated.map((file) => [file.path, file.content] as const)
  ]
  for (const [name, content] of all) {
    mkdirSync(dirname(join(root, name)), { recursive: true })
    writeFileSync(join(root, name), content)
  }
  git(root, "add", "-A")
  git(root, "commit", "-q", "-m", "first")
  return root
}

/** Runs every target by hand and gives each one's status. */
const execute = (root: string, name: string): Readonly<Record<string, string>> => {
  const results = join(`${root}.state`, `${name}.json`)
  const ran = spawnSync(
    process.execPath,
    [cli, "ci", "//...", "--jobs", "1", "--cache-dir", `${root}.state`, "--results-file", results],
    { cwd: root, encoding: "utf8", env: byHand(), maxBuffer: 64 * 1024 * 1024 }
  )
  expect(ran.status, `${ran.stdout}${ran.stderr}`).toBe(0)
  const record = JSON.parse(readFileSync(results, "utf8")) as {
    readonly results: ReadonlyArray<{ readonly label: string; readonly status: string }>
  }
  return Object.fromEntries(record.results.map((target) => [target.label.replace(/^\/\/:ci\.yml-/, ""), target.status]))
}

const workflow = `
on: push
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: grep -q source input.txt
      - run: grep -q notes notes.txt
      - run: git rev-parse HEAD
      - run: git log -1 --format=%s
      - run: echo "$GITHUB_SHA"
`

describe.runIf(observes)("the generated targets run by hand", () => {
  it("reuse every step at the same commit, and at the next one every step whose files did not change", () => {
    const root = repository(workflow, { "input.txt": "source\n", "notes.txt": "notes\n" })
    expect(execute(root, "first")).toEqual({
      "test-1": "ran",
      "test-2": "ran",
      "test-3": "ran",
      "test-4": "ran",
      "test-5": "ran"
    })
    expect(execute(root, "second")).toEqual({
      "test-1": "hit",
      "test-2": "hit",
      "test-3": "hit",
      "test-4": "hit",
      "test-5": "hit"
    })
    writeFileSync(join(root, "notes.txt"), "notes again\n")
    git(root, "commit", "-q", "-am", "change the notes")
    // The step that read the notes runs again, and so do the three that read the commit; the first is reused.
    expect(execute(root, "third")).toEqual({
      "test-1": "hit",
      "test-2": "ran",
      "test-3": "ran",
      "test-4": "ran",
      "test-5": "ran"
    })
  }, slow)
})

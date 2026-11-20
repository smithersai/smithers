/**
 * What the jobs of one baseline run keep, as jobs that start together see it: real directories and real hard
 * links, and the real `smithers-ci` on a repository whose jobs fail when they restore what a job beside them saved.
 */
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import type * as Path from "effect/Path"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import type { ReplayReport } from "../../src/contract/ReplayReport.ts"
import { addEntries, backTo, keep, pathsIn, viewOf } from "../../src/replay/Kept.vibe"
import { bin, commit, git, spawn, temporary } from "../cli/repo.ts"

const made: Array<string> = []
afterAll(() => made.forEach((path) => rmSync(path, { recursive: true, force: true })))

const scratch = (): string => {
  const directory = mkdtempSync(join(tmpdir(), "replay-kept-"))
  made.push(directory)
  return directory
}

const run = <A, E>(work: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>): Promise<A> =>
  Effect.runPromise(Effect.provide(work, NodeServices.layer))

/** An entry as a save leaves it: its files, and its key last. `at` is the time it was saved, in seconds. */
const entry = (store: string, paths: string, name: string, key: string | undefined, at = 1_700_000_000): string => {
  const directory = join(store, "actions-cache", paths, name)
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, "work.tar"), `files of ${name}`)
  if (key !== undefined) writeFileSync(join(directory, "key"), key)
  utimesSync(directory, at, at)
  return directory
}

const entriesOf = (store: string): ReadonlyArray<string> =>
  existsSync(join(store, "actions-cache"))
    ? readdirSync(join(store, "actions-cache")).flatMap((paths) =>
      readdirSync(join(store, "actions-cache", paths)).map((name) => `${paths}/${name}`)
    ).toSorted()
    : []

describe("what a way keeps, for a commit that runs again", () => {
  it("is put back: what the first run added is gone, and what was there before stays with its bytes", async () => {
    const kept = scratch()
    mkdirSync(join(kept, "cache", "ab"), { recursive: true })
    writeFileSync(join(kept, "cache", "ab", "entry"), "before")
    writeFileSync(join(kept, "record.json"), "{}")
    const before = await run(pathsIn(kept))
    expect([...before].sort()).toEqual(["cache", "cache/ab", "cache/ab/entry", "record.json"])
    // The run that is thrown away adds a file beside an old one, and a new directory with files under it.
    writeFileSync(join(kept, "cache", "ab", "other"), "new")
    mkdirSync(join(kept, "cache", "cd", "deep"), { recursive: true })
    writeFileSync(join(kept, "cache", "cd", "deep", "entry"), "new")
    mkdirSync(join(kept, "machine"))
    await run(backTo(kept, before))
    expect([...(await run(pathsIn(kept)))].sort()).toEqual([...before].sort())
    expect(readFileSync(join(kept, "cache", "ab", "entry"), "utf8")).toBe("before")
    // Nothing added, nothing removed.
    await run(backTo(kept, before))
    expect([...(await run(pathsIn(kept)))].sort()).toEqual([...before].sort())
  })
})

describe("what a job sees of the store", () => {
  it("is every finished entry the store holds, as hard links that keep the entry's time", async () => {
    const root = scratch()
    const store = join(root, "store")
    const saved = entry(store, "p1", "e1", "tool-1", 1_700_000_100)
    // A save that did not end has no key: nobody restores it. A stray file is no entry.
    entry(store, "p1", "unfinished", undefined)
    writeFileSync(join(store, "actions-cache", "note"), "not an entry")
    const view = join(root, "view")
    await run(viewOf(store, [], view))
    expect(entriesOf(view)).toEqual(["p1/e1"])
    const copy = join(view, "actions-cache", "p1", "e1")
    expect(readFileSync(join(copy, "key"), "utf8")).toBe("tool-1")
    // The same file, not a copy of it, and the time the entry was saved at.
    expect(statSync(join(copy, "work.tar")).ino).toBe(statSync(join(saved, "work.tar")).ino)
    expect(statSync(copy).mtimeMs).toBe(1_700_000_100_000)
  })

  it("holds what the jobs it waited for saved, and nothing of a job beside it", async () => {
    const root = scratch()
    const store = join(root, "store")
    entry(store, "p1", "old", "tool-1")
    const [one, two, after] = ["one", "two", "after"].map((name) => join(root, "views", name)) as [
      string,
      string,
      string
    ]
    await run(viewOf(store, [], one))
    await run(viewOf(store, [], two))
    // Each job saves into its own view.
    entry(one, "p1", "new", "tool-2")
    expect(entriesOf(two)).toEqual(["p1/old"])
    expect(entriesOf(store)).toEqual(["p1/old"])
    // A job that waited for the first sees what it saved; a view that was never made adds nothing.
    await run(viewOf(store, [one, join(root, "views", "never-ran")], after))
    expect(entriesOf(after)).toEqual(["p1/new", "p1/old"])
  })

  it("is made for a store that holds nothing yet", async () => {
    const root = scratch()
    await run(viewOf(join(root, "no-store"), [], join(root, "view")))
    expect(readdirSync(join(root, "view"))).toEqual([])
  })
})

describe("what a run's jobs saved", () => {
  it("is added to the store when the run has ended, the first job's entry first", async () => {
    const root = scratch()
    const store = join(root, "store")
    entry(store, "p1", "old", "tool-1")
    const one = join(root, "one")
    const two = join(root, "two")
    await run(viewOf(store, [], one))
    await run(viewOf(store, [], two))
    // Two jobs that started together saved the same key, and the second one more.
    writeFileSync(join(entry(one, "p1", "new", "tool-2"), "work.tar"), "the first job's files")
    writeFileSync(join(entry(two, "p1", "new", "tool-2"), "work.tar"), "the second job's files")
    entry(two, "p2", "other", "deps-1")
    await run(keep([one, two], store))
    expect(entriesOf(store)).toEqual(["p1/new", "p1/old", "p2/other"])
    expect(readFileSync(join(store, "actions-cache", "p1", "new", "work.tar"), "utf8")).toBe("the first job's files")
    // What the store held is the file it held.
    expect(readFileSync(join(store, "actions-cache", "p1", "old", "work.tar"), "utf8")).toBe("files of old")
  })

  it("keeps an entry whose time the file system does not tell, with the time it is added at", async () => {
    const root = scratch()
    const from = join(root, "from")
    entry(from, "p1", "e1", "tool-1", 1_600_000_000)
    // A file system that reports no modification time, as some do.
    const timeless = Layer.effect(
      FileSystem.FileSystem,
      Effect.gen(function*() {
        const real = yield* FileSystem.FileSystem
        return {
          ...real,
          stat: (path: string) => Effect.map(real.stat(path), (info) => ({ ...info, mtime: Option.none() }))
        }
      })
    )
    await Effect.runPromise(
      Effect.provide(addEntries(from, join(root, "to")), Layer.provideMerge(timeless, NodeServices.layer))
    )
    const added = join(root, "to", "actions-cache", "p1", "e1")
    expect(readFileSync(join(added, "key"), "utf8")).toBe("tool-1")
    expect(statSync(added).mtimeMs).toBeGreaterThan(1_700_000_000_000)
  })
})

const runner = process.platform === "darwin" ? "macos-latest" : "ubuntu-latest"

const steps = (role: string): string => `
    runs-on: ${runner}
    steps:
      - uses: actions/checkout@v4
      - id: cache
        uses: actions/cache@v4
        with:
          path: .tool-cache
          key: tool-\${{ hashFiles('tool.lock') }}
      - run: sh build.sh ${role} "\${{ steps.cache.outputs.cache-hit }}"`

// Two jobs that start together, and one that waits for both. Each keeps the same directory under the same key.
const workflow = `
on: push
jobs:
  one:${steps("beside")}
  two:${steps("beside")}
  after:
    needs: [one, two]${steps("after")}
`

// With `new-lock` in the tree the commit changed the lockfile: a job beside another must find no cache, as it
// finds none on a machine of its own that started with the other's, and the job that waited must find what they
// saved. With `same-lock` every job must find what the commit before saved.
const build = [
  "found=$2",
  "if [ -f new-lock ] && [ \"$1\" = beside ] && [ \"$found\" = true ]; then",
  "  echo 'restored what a job beside it saved in the same run' >&2; exit 1",
  "fi",
  "if [ -f new-lock ] && [ \"$1\" = after ] && [ \"$found\" != true ]; then",
  "  echo 'did not restore what the jobs it waited for saved' >&2; exit 1",
  "fi",
  "if [ -f same-lock ] && [ \"$found\" != true ]; then",
  "  echo 'did not restore what the last run saved' >&2; exit 1",
  "fi",
  "mkdir -p .tool-cache && echo built > .tool-cache/tool",
  "cat src.txt",
  ""
].join("\n")

/** Three commits: the first run's, one that changes the lockfile, and one that changes a source file. */
const repository = (): string => {
  const root = temporary("replay-kept")
  made.push(root)
  git(root, "init", "--quiet", "--initial-branch=main")
  commit(root, "base", {
    ".github/workflows/ci.yml": workflow,
    "build.sh": build,
    "src.txt": "one\n",
    "tool.lock": "1\n"
  })
  commit(root, "a new lockfile", { "tool.lock": "2\n", "new-lock": "" })
  git(root, "rm", "--quiet", "new-lock")
  commit(root, "a source change", { "same-lock": "", "src.txt": "two\n" })
  return root
}

describe("a replay of jobs that start together and keep the same cache", () => {
  it("lets no job restore what a job beside it saved in the same run, in the baseline and as targets", async () => {
    const outcome = await spawn(bin, ["--commits", "2", "--no-apply-check", "--json"], repository())
    const report = JSON.parse(outcome.stdout) as ReplayReport
    expect(report.notReplayed ?? []).toEqual([])
    expect(report.commits).toHaveLength(2)
    for (const replayed of report.commits) {
      // A job that restored another's cache, or missed the one it waited for, fails its build.
      expect((replayed.baseline.failures ?? []).map((failure) => `${failure.step}: ${failure.reason}`)).toEqual([])
      expect((replayed.normal.failures ?? []).map((failure) => `${failure.step}: ${failure.reason}`)).toEqual([])
      expect(replayed.baseline.ok).toBe(true)
      expect(replayed.normal.ok).toBe(true)
      expect(replayed.mismatches).toEqual([])
    }
    expect(report.mismatches).toBe(0)
    expect(outcome.code).toBe(0)
  }, 600_000)
})

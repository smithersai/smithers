/**
 * No file of Smithers CI's is created inside a replay's copy of the
 * repository. The replay's own directory is kept when it ends, and each
 * mode's copy is listed and compared with what git lists at the commit: the
 * files on disk, what git calls changed, untracked or ignored, and what git
 * itself keeps beside the files.
 */

import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { execFileSync } from "node:child_process"
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { basename, join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import type { Failure, ReplayParts } from "../../src/contract/Parts.ts"
import type { ReplayReport } from "../../src/contract/ReplayReport.ts"
import { compiledCode, Options, run } from "../../src/replay/index.ts"
import { job, linkTargets, makeSmallRepository, smthrs } from "./fixture.ts"
import { keepingWork, parts } from "./TestParts.vibe"

const made: Array<string> = []
afterAll(() => {
  for (const directory of made) {
    // A step's home can hold a directory nothing can be removed from.
    execFileSync("chmod", ["-R", "u+rwX", directory])
    rmSync(directory, { recursive: true, force: true })
  }
})

const git = (root: string, ...args: ReadonlyArray<string>): string =>
  execFileSync("git", ["-c", "user.name=Replay", "-c", "user.email=replay@example.com", ...args], {
    cwd: root,
    encoding: "utf8"
  })

const lines = (text: string): ReadonlyArray<string> => text.split("\n").filter((line) => line !== "")

/** Every file and link under `root` but `.git`, from the root, sorted. */
const onDisk = (root: string, directory = ""): ReadonlyArray<string> =>
  readdirSync(join(root, directory), { withFileTypes: true }).flatMap((entry) => {
    const path = directory === "" ? entry.name : `${directory}/${entry.name}`
    if (path === ".git") return []
    return entry.isDirectory() ? onDisk(root, path) : [path]
  }).sort()

describe("a replay's copy of the repository", () => {
  it("holds the commit's files and nothing else, in normal and in fast mode", async () => {
    const clean = `test -z "$(git status --porcelain --ignored)" && test -z "$(git clean -ndx)"`
    const root = makeSmallRepository([job("a", "sh a.sh"), job("clean", clean)])
    made.push(root)
    // As most repositories: an ignore file that names nothing of Smithers CI.
    writeFileSync(join(root, ".gitignore"), "node_modules\n")
    git(root, "commit", "--quiet", "-am", "an ignore file of the repository's own")
    writeFileSync(join(root, "b.txt"), "b\n")
    git(root, "add", "-A")
    git(root, "commit", "--quiet", "-m", "another file")

    // The machine decides whether steps run in a jail: where they do, the cache beside the copy is still written.
    const host = Layer.succeed(Options, {
      smthrs: [smthrs],
      reruns: 0,
      prepare: (directory: string) => Effect.sync(() => linkTargets(directory))
    })
    const kept: Array<string> = []
    const report = await Effect.runPromise(
      run({ root, commits: 2, modes: ["normal", "fast"] }, parts("none") as unknown as ReplayParts<never>).pipe(
        Effect.provide(Layer.provideMerge(host, Layer.provideMerge(keepingWork(kept), NodeServices.layer)))
      ) as Effect.Effect<ReplayReport, Failure>
    )
    made.push(...kept)
    expect(report.commits).toHaveLength(2)
    expect(report.mismatches).toBe(0)
    for (const commit of report.commits) {
      expect(commit.baseline, commit.commit).toMatchObject({ ok: true, counts: { ran: 2, failed: 0 } })
      expect(commit.normal, commit.commit).toMatchObject({ ok: true, counts: { failed: 0 } })
    }
    // The second commit changes no file a step reads: normal mode reuses what the first commit stored beside it.
    expect(report.commits[1]?.normal.counts.hit).toBeGreaterThan(0)

    expect(kept).toHaveLength(1)
    const work = kept[0] as string
    const tracked = lines(git(root, "ls-files")).toSorted()
    expect(tracked).toEqual([".gitignore", "a.sh", "b.txt", "ci.json"])
    for (const mode of ["normal", "fast"]) {
      const copy = join(work, mode, basename(root))
      // The files on disk are the commit's, by a listing that asks git nothing.
      expect(onDisk(copy), mode).toEqual(tracked)
      // git agrees, ignored files included, and would remove nothing.
      expect(git(copy, "status", "--porcelain", "--ignored"), mode).toBe("")
      expect(git(copy, "clean", "-ndx"), mode).toBe("")
      expect(git(copy, "rev-parse", "HEAD").trim(), mode).toBe(git(root, "rev-parse", "HEAD").trim())
      // Nothing hides a file: no exclude entry, no index bit, no ignore line that the commit does not hold.
      const exclude = join(copy, ".git", "info", "exclude")
      const excluded = existsSync(exclude) ? lines(readFileSync(exclude, "utf8")) : []
      expect(excluded.filter((line) => !line.startsWith("#")), mode).toEqual([])
      expect(lines(git(copy, "ls-files", "-v")).filter((line) => !line.startsWith("H ")), mode).toEqual([])
      expect(readFileSync(join(copy, ".gitignore"), "utf8"), mode).toBe("node_modules\n")
      // What git keeps beside the files is what a clone holds: no stash, one worktree, no ref or hook of ours.
      expect(git(copy, "stash", "list"), mode).toBe("")
      expect(lines(git(copy, "worktree", "list", "--porcelain")).filter((line) => line.startsWith("worktree ")), mode)
        .toHaveLength(1)
      expect(
        lines(git(copy, "for-each-ref", "--format=%(refname)")).filter((ref) =>
          !/^refs\/(heads|tags|remotes\/origin)\//.test(ref)
        ),
        mode
      ).toEqual([])
      const hooks = join(copy, ".git", "hooks")
      expect((existsSync(hooks) ? readdirSync(hooks) : []).filter((name) => !name.endsWith(".sample")), mode).toEqual(
        []
      )
      expect(
        lines(git(copy, "config", "--local", "--name-only", "--list")).filter((name) =>
          !/^(core\.(repositoryformatversion|filemode|bare|logallrefupdates|ignorecase|precomposeunicode|symlinks)|remote\.origin\.(url|fetch|pushurl)|branch\..*)$/
            .test(name)
        ),
        mode
      ).toEqual([])

      // What Smithers build keeps, and the generated workspace file, are beside the copy.
      expect(readdirSync(join(work, "state", mode)), mode).toEqual(expect.arrayContaining(["cache", compiledCode]))
      expect(readdirSync(join(work, "declared", mode)), mode).toEqual(
        expect.arrayContaining(["WORKSPACE.smithers", "node_modules"])
      )
    }
    // The repository itself is as it was.
    expect(git(root, "status", "--porcelain", "--ignored")).toBe("")
  }, 1_800_000)
})

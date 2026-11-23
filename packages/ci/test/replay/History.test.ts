/**
 * A replay of a partial clone fetches what the clone lacks from its own remote, and a replay of a shallow clone
 * replays the commits it holds. Real clones of a real repository served over `file://`, no network.
 */
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import type { Failure, ReplayParts, ReplayRequest } from "../../src/contract/Parts.vibe"
import type { ReplayReport } from "../../src/contract/ReplayReport.vibe"
import { cannotFetch, fetchMissing, noRemote, readyHistory, shallow } from "../../src/replay/History.vibe"
import { Progress, run } from "../../src/replay/index.vibe"
import { job, makeSmallRepository } from "./fixture.ts"
import { options, parts } from "./TestParts.vibe"

const created: Array<string> = []
const track = (path: string): string => {
  created.push(path)
  return path
}
afterAll(() => {
  for (const path of created) rmSync(path, { recursive: true, force: true })
})

const git = (root: string, ...args: ReadonlyArray<string>): string =>
  execFileSync("git", ["-c", "user.name=Replay", "-c", "user.email=replay@example.com", ...args], {
    cwd: root,
    encoding: "utf8"
  }).trim()

const scratch = (): string => track(mkdtempSync(join(tmpdir(), "replay-history-")))

/** A repository of four commits, each changing `a.sh` and a file in a directory, served with filters allowed. */
const upstream = (): string => {
  const root = track(makeSmallRepository([job("a", "sh a.sh")]))
  for (const n of [1, 2, 3]) {
    writeFileSync(join(root, "a.sh"), `# change ${n}\nexit 0\n`)
    execFileSync("mkdir", ["-p", join(root, "deep", "er")])
    writeFileSync(join(root, "deep", "er", "notes.txt"), `notes ${n}\n`)
    git(root, "add", "-A")
    git(root, "commit", "--quiet", "-m", `change ${n}`)
  }
  git(root, "config", "uploadpack.allowFilter", "true")
  return root
}

/** A clone of `root` made with `flags`, as a person makes one. */
const cloneOf = (root: string, ...flags: ReadonlyArray<string>): string => {
  const clone = join(scratch(), "clone")
  git(tmpdir(), "clone", "--quiet", ...flags, `file://${root}`, clone)
  return clone
}

/** What `clone` lacks of its history. */
const lacking = (clone: string): number =>
  git(clone, "rev-list", "--objects", "--missing=print", "--all").split("\n").filter((line) => line.startsWith("?"))
    .length

/** The replay's own clone of `clone`, made as a replay makes it. */
const sourceOf = (clone: string): string => {
  const source = join(scratch(), "source")
  git(tmpdir(), "clone", "--quiet", "--no-checkout", clone, source)
  return source
}

const ready = (clone: string, source: string, asked: number, warm: boolean) => {
  const said: Array<string> = []
  const say = (line: string) => Effect.sync(() => void said.push(line))
  return Effect.runPromise(
    Effect.provide(readyHistory(clone, source, asked, warm, say), NodeServices.layer) as Effect.Effect<void, Failure>
  ).then(
    () => ({ said, failure: undefined }),
    (failure: Failure) => ({ said, failure })
  )
}

const base = parts("none") as unknown as ReplayParts<never>

const replay = (root: string, commits: number, extra: Partial<ReplayRequest> = {}) => {
  const said: Array<string> = []
  const listening = Layer.succeed(Progress, { say: (line: string) => Effect.sync(() => void said.push(line)) })
  return Effect.runPromise(
    run({ root, commits, modes: ["normal"], warm: true, ...extra }, base).pipe(
      Effect.provide(Layer.provideMerge(Layer.merge(options as never, listening), NodeServices.layer))
    ) as Effect.Effect<ReplayReport, Failure>
  ).then((report) => ({ report, said }))
}

const fetchingLine = /^this partial clone lacks \d+ objects? the replayed commits check out: fetching them from origin$/

describe("a replay of a partial clone", () => {
  it("fetches what the replayed commits lack from the clone's remote, says how many, and replays them", async () => {
    const clone = cloneOf(upstream(), "--filter=blob:none")
    const before = lacking(clone)
    expect(before).toBeGreaterThan(0)
    const { report, said } = await replay(clone, 2)
    expect(report.commits).toHaveLength(2)
    expect(report.commits.every((entry) => entry.baseline.ok && entry.normal.ok)).toBe(true)
    expect(report.firstRun).toBeDefined()
    expect(said.filter((line) => fetchingLine.test(line))).toHaveLength(1)
    // The person's clone is as it was: the objects went to the replay's own clone.
    expect(lacking(clone)).toBe(before)
  }, 600_000)

  it("fetches the directories a clone made with --filter=tree:0 lacks, with what they hold", async () => {
    const clone = cloneOf(upstream(), "--filter=tree:0")
    const source = sourceOf(clone)
    const { said, failure } = await ready(clone, source, 3, true)
    expect(failure).toBeUndefined()
    expect(said.length).toBeGreaterThan(0)
    for (const line of said) expect(line).toMatch(fetchingLine)
    for (const commit of git(source, "rev-list", "HEAD").split("\n")) git(source, "ls-tree", "-r", commit)
    expect(git(source, "rev-list", "--objects", "--missing=print", "--all")).not.toMatch(/^\?/m)
  }, 120_000)

  it("fetches what the commit before the oldest holds, for a replay that starts cold", async () => {
    // The oldest replayed commit moves a file and changes it: naming what it changed reads the file before.
    const root = track(makeSmallRepository([job("a", "sh a.sh")]))
    writeFileSync(join(root, "big.txt"), Array.from({ length: 200 }, (_, n) => `${n}\n`).join(""))
    git(root, "add", "-A")
    git(root, "commit", "--quiet", "-m", "big")
    git(root, "mv", "big.txt", "moved.txt")
    writeFileSync(join(root, "moved.txt"), "extra\n", { flag: "a" })
    git(root, "commit", "--quiet", "-am", "move")
    writeFileSync(join(root, "a.sh"), "exit 0\n# newest\n")
    git(root, "commit", "--quiet", "-am", "newest")
    git(root, "config", "uploadpack.allowFilter", "true")
    const clone = cloneOf(root, "--filter=blob:none")
    const source = sourceOf(clone)
    const { failure } = await ready(clone, source, 2, false)
    expect(failure).toBeUndefined()
    expect(git(source, "show", "--format=", "--name-only", "--diff-merges=first-parent", "HEAD~1")).toBe("moved.txt")
  }, 120_000)

  it("fetches nothing for a full clone", async () => {
    const clone = cloneOf(upstream())
    expect(await ready(clone, sourceOf(clone), 3, true)).toEqual({ said: [], failure: undefined })
  }, 120_000)

  it("fetches from the remote the configuration names, at a path relative to the clone", async () => {
    const root = upstream()
    const clone = cloneOf(root, "--filter=blob:none", "--origin", "upstream")
    git(clone, "config", "extensions.partialClone", "upstream")
    // The clone is two directories below the temporary directory that holds the repository.
    expect(join(clone, "..", "..")).toBe(join(root, ".."))
    git(clone, "remote", "set-url", "upstream", join("..", "..", root.split("/").at(-1) as string))
    const { said, failure } = await ready(clone, sourceOf(clone), 4, false)
    expect(failure).toBeUndefined()
    expect(said[0]).toMatch(/fetching them from upstream$/)
  }, 120_000)

  it("fetches from a remote named by its path", async () => {
    const root = upstream()
    const clone = cloneOf(root, "--filter=blob:none")
    git(clone, "remote", "set-url", "origin", root)
    const { said, failure } = await ready(clone, sourceOf(clone), 4, false)
    expect(failure).toBeUndefined()
    expect(said).toHaveLength(1)
  }, 120_000)

  it("stops with one line naming the cause and the Git command when the remote cannot be reached", async () => {
    const clone = cloneOf(upstream(), "--filter=blob:none")
    git(clone, "remote", "set-url", "origin", "file:///nowhere/at/all")
    const { report, failure } = await replay(clone, 2).then(
      ({ report }) => ({ report, failure: undefined }),
      (failure: Failure) => ({ report: undefined, failure })
    )
    expect(report).toBeUndefined()
    expect(failure?.code).toBe("command-failed")
    expect(failure?.message).not.toContain("\n")
    expect(failure?.message).toMatch(
      /^this partial clone lacks \d+ objects the replayed commits check out, and fetching them failed \(fatal: '\/nowhere\/at\/all' does not appear to be a git repository\): run `git -c remote\.origin\.partialclonefilter= fetch --refetch origin` where origin can be reached, or replay a full clone$/
    )
  }, 120_000)

  it("names no password of the remote's address", async () => {
    const clone = cloneOf(upstream(), "--filter=blob:none")
    git(clone, "remote", "set-url", "origin", "https://someone:hunter2@127.0.0.1:9/repository.git")
    const { failure } = await ready(clone, sourceOf(clone), 4, false)
    expect(failure?.code).toBe("command-failed")
    expect(failure?.message).toMatch(/^this partial clone lacks \d+ objects .*127\.0\.0\.1/)
    expect(failure?.message).not.toContain("hunter2")
  }, 120_000)

  it("stops when the remote is an address over ssh that does not answer", async () => {
    const clone = cloneOf(upstream(), "--filter=blob:none")
    git(clone, "remote", "set-url", "origin", "nobody@nowhere.invalid:repository.git")
    const { failure } = await ready(clone, sourceOf(clone), 4, false)
    expect(failure?.code).toBe("command-failed")
    expect(failure?.message).toMatch(/fetching them failed \(ssh: .*nowhere\.invalid.*\): run `git -c remote\.origin/)
    expect(failure?.message).not.toMatch(/[\r\n]/)
  }, 120_000)

  it("stops with the command that adds a remote when it has none", async () => {
    const clone = cloneOf(upstream(), "--filter=blob:none")
    git(clone, "remote", "remove", "origin")
    const { failure } = await ready(clone, sourceOf(clone), 4, false)
    expect(failure?.code).toBe("command-failed")
    expect(failure?.message).toBe(noRemote(lacking(clone), "origin"))
    expect(failure?.message).toContain("git remote add origin")
  }, 120_000)

  it("fails as a step of the command, exit 4", async () => {
    const { failureExitCodes } = await import("../../src/contract/Command.vibe")
    expect(failureExitCodes["command-failed"]).toBe(4)
    expect(cannotFetch(1, "origin", "why")).toBe(
      "this partial clone lacks 1 object the replayed commits check out, and fetching them failed (why): " +
        "run `git -c remote.origin.partialclonefilter= fetch --refetch origin` where origin can be reached, " +
        "or replay a full clone"
    )
  })
})

describe("a replay of a shallow clone", () => {
  it("replays the commits it holds and says how many there are and how to get more", async () => {
    const clone = cloneOf(upstream(), "--depth", "1")
    const { report, said } = await replay(clone, 3, { warm: false })
    expect(report.commits).toHaveLength(1)
    expect(said).toContain(shallow(1, 3, 2))
    expect(shallow(1, 3, 2)).toBe(
      "this shallow clone holds 1 commit of the 3 asked for: replaying what it holds; `git fetch --deepen=2` gets the rest"
    )
  }, 600_000)

  it("counts the commit a warm start runs first in the commits to get", async () => {
    const clone = cloneOf(upstream(), "--depth", "2")
    const { said, failure } = await ready(clone, sourceOf(clone), 3, true)
    expect(failure).toBeUndefined()
    expect(said).toEqual([
      "this shallow clone holds 2 commits of the 3 asked for: replaying what it holds; `git fetch --deepen=2` gets the rest"
    ])
  }, 120_000)

  it("says nothing of a full clone that has fewer commits than asked for", async () => {
    const clone = cloneOf(upstream())
    expect(await ready(clone, sourceOf(clone), 10, true)).toEqual({ said: [], failure: undefined })
  }, 120_000)
})

/** fetchMissing alone, for a list of commits the replay asks for. */
describe("fetching what a clone lacks", () => {
  it("fetches nothing a checkout of the clone already brought", async () => {
    const clone = cloneOf(upstream(), "--filter=blob:none")
    const said: Array<string> = []
    await Effect.runPromise(
      Effect.provide(
        fetchMissing(
          clone,
          sourceOf(clone),
          [git(clone, "rev-parse", "HEAD")],
          (line) => Effect.sync(() => void said.push(line))
        ),
        NodeServices.layer
      ) as Effect.Effect<void>
    )
    // The newest commit is checked out in the clone, so it holds every object of it.
    expect(said).toEqual([])
  }, 120_000)
})

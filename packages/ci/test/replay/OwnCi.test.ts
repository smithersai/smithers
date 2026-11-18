/** Each commit is replayed with the CI that commit had, read from its own tree. */
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { execFileSync } from "node:child_process"
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import type { Failure, ReplayParts } from "../../src/contract/Parts.ts"
import type { ReplayReport } from "../../src/contract/ReplayReport.ts"
import { run } from "../../src/replay/index.ts"
import { job, makeSmallRepository } from "./fixture.ts"
import { options, parts } from "./TestParts.vibe"

const created: Array<string> = []
const track = (root: string): string => {
  created.push(root)
  return root
}
afterAll(() => {
  for (const root of created) rmSync(root, { recursive: true, force: true })
})

type Parts = ReplayParts<never>
const base = parts("none") as unknown as Parts

const replay = (root: string, overrides: Partial<Parts> = {}): Promise<ReplayReport> =>
  Effect.runPromise(
    run({ root, commits: 2, modes: ["normal"] }, { ...base, ...overrides }).pipe(
      Effect.provide(Layer.provideMerge(options as never, NodeServices.layer))
    ) as Effect.Effect<ReplayReport, Failure>
  )

const failureOf = (attempt: Promise<ReplayReport>): Promise<Failure> =>
  attempt.then(
    () => {
      throw new Error("the replay succeeded")
    },
    (cause: { readonly message: string }) => JSON.parse(JSON.stringify(cause)) as Failure
  )

const git = (root: string, ...args: ReadonlyArray<string>): string =>
  execFileSync("git", ["-C", root, "-c", "user.name=Replay", "-c", "user.email=replay@example.com", ...args], {
    encoding: "utf8"
  }).trim()

/** Commits the working tree of `root` with its CI set to `jobs`, and gives the commit. */
const commitWith = (root: string, jobs: ReadonlyArray<unknown>): string => {
  const file = join(root, "ci.json")
  writeFileSync(file, JSON.stringify({ ...(JSON.parse(readFileSync(file, "utf8")) as object), jobs }))
  git(root, "add", "-A")
  git(root, "commit", "--quiet", "-m", "next")
  return git(root, "rev-parse", "HEAD")
}

describe("a replay of commits whose CI differs", () => {
  it("runs each commit with the CI it had", async () => {
    // Review finding 10: the older commit ran the newest commit's `sh verify.sh`, which it does not have, and failed.
    const root = track(makeSmallRepository([job("a", "sh a.sh")]))
    renameSync(join(root, "a.sh"), join(root, "verify.sh"))
    commitWith(root, [job("a", "sh verify.sh"), job("b", "true")])
    const report = await replay(root)
    expect(report.commits.map((commit) => [commit.baseline.counts, commit.normal.counts, commit.mismatches])).toEqual([
      [{ hit: 0, ran: 1, failed: 0, skipped: 0 }, { hit: 0, ran: 1, failed: 0, skipped: 0 }, []],
      [{ hit: 0, ran: 2, failed: 0, skipped: 0 }, { hit: 0, ran: 2, failed: 0, skipped: 0 }, []]
    ])
    expect(report.notReplayedCommits).toBeUndefined()
  }, 240_000)

  it("leaves out an older commit that had no CI, and lists it with the reason", async () => {
    const root = track(makeSmallRepository([]))
    const first = git(root, "rev-parse", "HEAD")
    const second = commitWith(root, [job("a", "sh a.sh")])
    const report = await replay(root)
    expect(report.commits.map((commit) => commit.commit)).toEqual([second])
    expect(report.notReplayedCommits).toEqual([{
      commit: first,
      reason: "no job runs on a push or a pull request, and the repository root has no `ci` recipe or script"
    }])
    expect(report.baselineWallMs).toBe(report.commits[0]?.baseline.wallMs)
  }, 240_000)

  it("still fails when the newest commit has no CI, and when an older commit cannot be read at all", async () => {
    const root = track(makeSmallRepository([job("a", "sh a.sh")]))
    commitWith(root, [])
    expect(await failureOf(replay(root))).toMatchObject({ code: "unsupported", part: "replay" })
    commitWith(root, [job("a", "sh a.sh")])
    // The newest commit is read first; the read of the older one then fails for a reason that is not about its CI.
    let reads = 0
    const read: Parts["read"] = (copy) => {
      reads += 1
      return reads === 1
        ? base.read(copy)
        : Effect.fail({ code: "command-failed", message: "git could not read the tree", part: "inventory" })
    }
    expect(await failureOf(replay(root, { read }))).toEqual({
      code: "command-failed",
      message: "git could not read the tree",
      part: "inventory"
    })
  }, 240_000)
})

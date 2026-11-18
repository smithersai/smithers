import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import { execFileSync } from "node:child_process"
import { rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import type { Failure, ReplayParts } from "../../src/contract/Parts.ts"
import { ReplayReport } from "../../src/contract/ReplayReport.ts"
import { Progress, run } from "../../src/replay/index.ts"
import { unavailable } from "../../src/select/Failure.ts"
import { score } from "../../src/select/index.ts"
import { job, makeSmallRepository } from "./fixture.ts"
import { files, modelFailingAfter, options, read, rowsOfEachCommit } from "./TestParts.vibe"

const created: Array<string> = []
afterAll(() => {
  for (const root of created) rmSync(root, { recursive: true, force: true })
})

const git = (root: string, ...args: ReadonlyArray<string>): string =>
  execFileSync("git", ["-c", "user.name=Replay", "-c", "user.email=replay@example.com", ...args], {
    cwd: root,
    encoding: "utf8"
  }).trim()

/** Three commits. `a` fails at the first, so a fast mode that skips it has a mismatch there. */
const threeCommits = (): { readonly root: string; readonly commits: ReadonlyArray<string> } => {
  const root = makeSmallRepository([job("a", "sh a.sh")])
  created.push(root)
  writeFileSync(join(root, "a.sh"), "exit 1\n")
  git(root, "commit", "--quiet", "--all", "--amend", "-m", "one")
  const first = git(root, "rev-parse", "HEAD")
  writeFileSync(join(root, "a.sh"), "exit 0\n")
  git(root, "commit", "--quiet", "--all", "-m", "two")
  const second = git(root, "rev-parse", "HEAD")
  writeFileSync(join(root, "a.sh"), "# three\nexit 0\n")
  git(root, "commit", "--quiet", "--all", "-m", "three")
  return { root, commits: [first, second, git(root, "rev-parse", "HEAD")] }
}

const replayed = async (root: string, parts: ReplayParts<never>, answers: number) => {
  const said: Array<string> = []
  const progress = Layer.succeed(Progress, { say: (line: string) => Effect.sync(() => void said.push(line)) })
  const replay = run(
    { root, commits: 3, modes: ["normal", "fast"], settings: { scoreCutoff: 0.5, countCutoff: 0 } },
    parts
  ).pipe(
    Effect.provide(
      Layer.mergeAll(modelFailingAfter(answers), progress, Layer.provideMerge(options, NodeServices.layer))
    )
  ) as Effect.Effect<ReplayReport, Failure>
  return { replay, said }
}

const parts = { read, files, rows: rowsOfEachCommit, score } as unknown as ReplayParts<never>

describe("a model that stops answering at the second of three commits", () => {
  it(
    "still runs the baseline and normal mode for every commit, and the report says fast mode was not measured",
    async () => {
      const { commits, root } = threeCommits()
      const { replay, said } = await replayed(root, parts, 1)
      const report = await Effect.runPromise(replay)

      expect(Schema.decodeUnknownSync(ReplayReport)(report)).toEqual(report)
      expect(report.commits.map((commit) => commit.commit)).toEqual(commits)
      expect(report.commits.map((commit) => commit.baseline.ok)).toEqual([false, true, true])
      expect(report.commits.map((commit) => commit.normal.ok)).toEqual([false, true, true])
      expect(report.fastNotMeasured).toBe(
        unavailable({ _tag: "flows/model/ClassifierError", code: "unreachable" } as never)
      )

      // The first commit was measured in fast mode, and part of a measurement is not one.
      expect(report.commits.every((commit) => !("fast" in commit))).toBe(true)
      expect(report.mismatches).toBe(0)
      expect(report).not.toHaveProperty("fastWallMs")
      expect(report).not.toHaveProperty("selection")

      const at = (index: number) => `${index + 1}/3 ${commits[index]!.slice(0, 7)}`
      // The replay also says how it confines its steps; these are the lines for the commits.
      expect(said.filter((line) => /^\d\/3 /.test(line))).toEqual([
        `${at(0)} baseline`,
        `${at(0)} normal`,
        `${at(0)} fast`,
        `${at(1)} baseline`,
        `${at(1)} normal`,
        `${at(1)} fast not measured`,
        `${at(2)} baseline`,
        `${at(2)} normal`
      ])
    },
    600_000
  )

  it("keeps fast mode's numbers when the model answers every commit", async () => {
    const { root } = threeCommits()
    const { replay } = await replayed(root, parts, 3)
    const report = await Effect.runPromise(replay)
    expect(report).not.toHaveProperty("fastNotMeasured")
    expect(report.commits.every((commit) => commit.fast !== undefined)).toBe(true)
    expect(report.commits[0]!.mismatches).toEqual([{
      label: "//:a0_0",
      mode: "fast",
      baseline: "fail",
      got: "skipped"
    }])
    expect(report.selection).toBeDefined()
  }, 600_000)

  it("stays a failure when scoring fails for any other reason", async () => {
    const { root } = threeCommits()
    const broken: Failure = { code: "invalid-document", message: "the rows are wrong", part: "select" }
    const { replay } = await replayed(root, { ...parts, score: () => Effect.fail(broken) }, 3)
    expect(await Effect.runPromise(Effect.flip(replay))).toEqual(broken)
  }, 600_000)
})

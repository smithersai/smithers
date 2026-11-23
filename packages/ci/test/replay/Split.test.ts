import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { execFileSync } from "node:child_process"
import { rmSync } from "node:fs"
import { basename } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { type Step, withSteps } from "../../src/contract/Inventory.vibe"
import type { Decompose, Failure, ReplayParts } from "../../src/contract/Parts.vibe"
import type { ReplayReport } from "../../src/contract/ReplayReport.vibe"
import { path as targetMapPath, type TargetMap } from "../../src/contract/TargetMap.vibe"
import { run } from "../../src/replay/index.vibe"
import { job, makeSmallRepository } from "./fixture.ts"
import { generated, options, parts } from "./TestParts.vibe"

const created: Array<string> = []
afterAll(() => {
  for (const root of created) rmSync(root, { recursive: true, force: true })
})

type Parts = ReplayParts<never>

/** Splits every step in two: the second half runs `second`. */
const inTwo = (second: string): Decompose<never> => (_root, ci) =>
  Effect.succeed(withSteps(ci, (entry) =>
    entry.steps.flatMap((step): ReadonlyArray<Step> => [
      { ...step, id: `${step.id}x`, from: step.id },
      { ...step, id: `${step.id}y`, from: step.id, command: second }
    ])))

/** The test generator's files, with the target map naming the step each target was split from. */
const files: Parts["files"] = (inventory) => {
  const from = new Map(inventory.jobs.flatMap((entry) => entry.steps.map((step) => [step.id, step.from ?? step.id])))
  return Effect.succeed(
    generated(inventory).map((file) => {
      if (file.path !== targetMapPath) return file
      const map = JSON.parse(file.content) as TargetMap
      const targets = map.targets.map((target) => ({ ...target, step: from.get(target.step) }))
      return { ...file, content: JSON.stringify({ ...map, targets }) }
    })
  )
}

const replay = (
  decompose: Decompose<never>,
  jobs: ReadonlyArray<unknown> = [job("a", "sh a.sh")]
): Promise<ReplayReport> => {
  const root = makeSmallRepository(jobs)
  created.push(root)
  const chosen = { ...(parts("none") as unknown as Parts), files, decompose }
  return Effect.runPromise(
    run({ root, commits: 1, modes: ["normal"] }, chosen).pipe(
      Effect.provide(Layer.provideMerge(options as never, NodeServices.layer))
    ) as Effect.Effect<ReplayReport, Failure>
  )
}

describe("the copies a replay reads and runs in", () => {
  /** The test reader, which also reports the directory name and the remote of the copy it was given. */
  const seen = (base: Parts): Parts["read"] => (root) =>
    Effect.map(base.read(root), (inventory) => {
      const remote = execFileSync("git", ["-C", root, "config", "--get", "remote.origin.url"], { encoding: "utf8" })
      return { ...inventory, repository: `${basename(root)} ${remote.trim()}` }
    })

  const named = async (remote: string | undefined): Promise<readonly [string, string]> => {
    const root = makeSmallRepository([job("a", "sh a.sh")])
    created.push(root)
    if (remote !== undefined) execFileSync("git", ["-C", root, "remote", "add", "origin", remote])
    const base = parts("none") as unknown as Parts
    const report = await Effect.runPromise(
      run({ root, commits: 1, modes: ["normal"] }, { ...base, read: seen(base) }).pipe(
        Effect.provide(Layer.provideMerge(options as never, NodeServices.layer))
      ) as Effect.Effect<ReplayReport, Failure>
    )
    return [basename(root), report.repository]
  }

  it("have the repository's directory name and its remote, without the remote's credentials", async () => {
    const [directory, repository] = await named("https://will:ghp_secret@example.com/acme/widgets.git")
    expect(repository).toBe(`${directory} https://example.com/acme/widgets.git`)
  }, 600_000)

  it("keep the directory name when the repository has no remote", async () => {
    const [directory, repository] = await named(undefined)
    expect(repository.startsWith(`${directory} `)).toBe(true)
    expect(repository).not.toContain("example.com")
  }, 600_000)
})

describe("a replay whose steps were split", () => {
  it("runs the step once in the baseline and its two targets in normal mode, and they agree", async () => {
    const [commit] = (await replay(inTwo("sh a.sh"))).commits
    expect(commit!.baseline.counts).toEqual({ hit: 0, ran: 1, failed: 0, skipped: 0 })
    expect(commit!.normal.counts).toEqual({ hit: 0, ran: 2, failed: 0, skipped: 0 })
    expect(commit!.mismatches).toEqual([])
  }, 600_000)

  it("reports the step, by its id, when one of its targets fails and the step passed", async () => {
    const report = await replay(inTwo("exit 1"))
    expect(report.commits[0]!.baseline.ok).toBe(true)
    expect(report.commits[0]!.normal.counts.failed).toBe(1)
    expect(report.commits[0]!.mismatches).toEqual([{ label: "a0", mode: "normal", baseline: "pass", got: "fail" }])
    expect(report.mismatches).toBe(1)
  }, 600_000)

  it("compares a split step of a matrix job variant by variant, and reruns each variant as itself", async () => {
    // Review finding 7: variant one fails in CI and as a target alike. Its rerun was answered by variant two's pass,
    // which made the baseline flaky and the replay report a mismatch.
    const suites = { ...job("m", "test ${{ matrix.suite }} = two"), matrix: [{ suite: "one" }, { suite: "two" }] }
    const report = await replay(inTwo("true"), [suites])
    const [commit] = report.commits
    expect(commit!.baseline.counts).toEqual({ hit: 0, ran: 1, failed: 1, skipped: 0 })
    // In variant one the first half fails and the second, which follows it, is skipped: together, a failure.
    expect(commit!.normal.counts).toEqual({ hit: 0, ran: 2, failed: 1, skipped: 1 })
    expect(commit!.mismatches).toEqual([])
    expect(report.flaky).toBe(0)
  }, 600_000)

  it("names the variant in the mismatch when one variant's target differs", async () => {
    // The step passes in both variants; the second half of the split fails only where the suite is `one`.
    const suites = { ...job("m", "true"), matrix: [{ suite: "one" }, { suite: "two" }] }
    const report = await replay(inTwo("test ${{ matrix.suite }} = two"), [suites])
    expect(report.commits[0]!.mismatches).toEqual([
      { label: "m0 (suite=one)", mode: "normal", baseline: "pass", got: "fail" }
    ])
  }, 600_000)
})

/** How often a failed step runs again, in real repositories, with the real `smthrs`. */
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { execFileSync } from "node:child_process"
import { rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import type { Failure, ReplayParts, ReplayRequest } from "../../src/contract/Parts.ts"
import type { ReplayReport } from "../../src/contract/ReplayReport.ts"
import { run } from "../../src/replay/index.ts"
import { text } from "../../src/report/index.ts"
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

const base = parts("none") as unknown as ReplayParts<never>

// The host of these tests reruns once; a request that names a number is given that number.
const start = (root: string, commits: number, extra: Partial<ReplayRequest> = {}) =>
  Effect.runPromise(
    run({ root, commits, modes: ["normal"], ...extra }, base).pipe(
      Effect.provide(Layer.provideMerge(options as never, NodeServices.layer))
    ) as Effect.Effect<ReplayReport, Failure>
  )

const git = (root: string, ...args: ReadonlyArray<string>): string =>
  execFileSync("git", ["-c", "user.name=Replay", "-c", "user.email=replay@example.com", ...args], {
    cwd: root,
    encoding: "utf8"
  }).trim()

/** A new commit whose `a.sh` is `content`. */
const commit = (root: string, content: string): void => {
  writeFileSync(join(root, "a.sh"), content)
  git(root, "add", "-A")
  git(root, "commit", "--quiet", "--allow-empty", "-m", "another")
}

const failingWith = (message: string, code = 1): string => `echo '${message}' >&2\nexit ${code}\n`

/** A repository whose one job runs `a.sh`, which fails with `message` at its first commit. */
const failing = (message = "expected 2, got 3"): string => {
  const root = track(makeSmallRepository([job("a", "sh a.sh"), job("ok", "true")]))
  commit(root, failingWith(message))
  return root
}

describe("a step that fails", () => {
  it("runs once more in each way when the request asks for one rerun, and the report says so", async () => {
    const report = await start(failing(), 1, { reruns: 1 })
    expect(report.reruns?.count).toBe(2)
    expect(report.reruns?.ms).toBeGreaterThan(0)
    expect(report.commits[0]?.baseline.failures?.[0]?.reason).toBe("expected 2, got 3")
    expect(report.commits[0]?.mismatches).toEqual([])
    expect(text(report)).toMatch(/^2 failed steps ran again, which took .+ and is in none of these times$/m)
  }, 600_000)

  it("runs again as often as the request says, and never with 0", async () => {
    const twice = await start(failing(), 1, { reruns: 2 })
    expect(twice.reruns?.count).toBe(4)
    const never = await start(failing(), 1, { reruns: 0 })
    expect(never.reruns).toBeUndefined()
    expect(never.commits[0]?.baseline.ok).toBe(false)
    expect(text(never)).not.toContain("ran again")
  }, 600_000)

  it("is not run again when it failed the same way at the commit before", async () => {
    const root = failing()
    commit(root, `# the same failure\n${failingWith("expected 2, got 3")}`)
    const report = await start(root, 2, { reruns: 1 })
    // Once in each way at the first commit, and at the second commit not at all.
    expect(report.reruns?.count).toBe(2)
    expect(report.commits.map((entry) => entry.baseline.ok)).toEqual([false, false])
    expect(report.commits[1]?.mismatches).toEqual([])
  }, 600_000)

  it("runs again when it fails another way than at the commit before", async () => {
    const root = failing()
    commit(root, failingWith("expected 2, got 4"))
    commit(root, failingWith("expected 2, got 4", 7))
    const report = await start(root, 3, { reruns: 1 })
    // Another first line at the second commit, another exit code at the third: once in each way at each commit.
    expect(report.reruns?.count).toBe(6)
  }, 600_000)

  it("is not run again at the first counted commit when it failed the same way in the first run", async () => {
    const root = failing()
    commit(root, `# the same failure\n${failingWith("expected 2, got 3")}`)
    const report = await start(root, 1, { reruns: 1, warm: true })
    expect(report.firstRun?.normalMs).toBeGreaterThan(0)
    expect(report.reruns).toBeUndefined()
    expect(report.commits[0]?.baseline.failures?.[0]?.reason).toBe("expected 2, got 3")
    expect(report.commits[0]?.normal.failures?.[0]?.reason).toBe("expected 2, got 3")
  }, 600_000)

  it(
    "counts the one more run of a job that failed the first run, and does not run it again when it stays",
    async () => {
      // Broken at the commit before and at the oldest counted commit, fixed at the newest.
      const root = failing()
      commit(root, `# the same failure\n${failingWith("expected 2, got 3")}`)
      commit(root, "exit 0\n")
      const report = await start(root, 2, { reruns: 1, warm: true, trial: true })
      expect(report.notReplayed).toBeUndefined()
      // The one more run at the newest commit, where it passes; none at the oldest, in the baseline or as a target.
      expect(report.reruns?.count).toBe(1)
      expect(report.commits.map((entry) => entry.baseline.ok)).toEqual([false, true])
      expect(text(report)).toMatch(/^1 failed step ran again, which took .+ and is in none of these times$/m)
    },
    600_000
  )
})

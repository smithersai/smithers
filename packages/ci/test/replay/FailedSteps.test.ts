/** Steps that fail in real temporary repositories, run by the real `smthrs`. */
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { execFileSync } from "node:child_process"
import { rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import type { Failure, ReplayParts, ReplayRequest } from "../../src/contract/Parts.ts"
import type { ReplayReport } from "../../src/contract/ReplayReport.ts"
import { Options, run } from "../../src/replay/index.ts"
import { job, linkTargets, makeSmallRepository, smthrs } from "./fixture.ts"
import { options, parts } from "./TestParts.vibe"

const created: Array<string> = []
const track = (root: string): string => {
  created.push(root)
  return root
}
afterAll(() => {
  for (const root of created) rmSync(root, { recursive: true, force: true })
})

const missing = "smithers-ci-test-no-such-program"
const installed = `\`${missing}\` is not installed on this machine`

const base = parts("none") as unknown as ReplayParts<never>

const start = (root: string, commits: number, host: Layer.Layer<never, never, never>) => {
  const request: ReplayRequest = { root, commits, modes: ["normal"] }
  return Effect.runPromise(
    run(request, base).pipe(Effect.provide(Layer.provideMerge(host, NodeServices.layer))) as Effect.Effect<
      ReplayReport,
      Failure
    >
  )
}

const replay = (root: string, commits = 1, host: Layer.Layer<never, never, never> = options as never) =>
  start(root, commits, host)

const refusal = (root: string, commits = 1): Promise<Failure> =>
  replay(root, commits).then(
    () => {
      throw new Error("the replay succeeded")
    },
    (cause: { readonly message: string }) => JSON.parse(JSON.stringify(cause)) as Failure
  )

const git = (root: string, ...args: ReadonlyArray<string>): string =>
  execFileSync("git", ["-c", "user.name=Replay", "-c", "user.email=replay@example.com", ...args], {
    cwd: root,
    encoding: "utf8"
  }).trim()

/** Commits `content` as `a.sh` on top of `root`, and returns the commit. */
const commitScript = (root: string, content: string): string => {
  writeFileSync(join(root, "a.sh"), content)
  git(root, "add", "-A")
  git(root, "commit", "--quiet", "--allow-empty", "-m", "change a.sh")
  return git(root, "rev-parse", "HEAD")
}

describe("a step whose program is not installed", () => {
  it("is named with exit 127 and the missing program, in the baseline and in the mode", async () => {
    const root = track(makeSmallRepository([job("ok", "sh a.sh"), job("tool", `${missing} --version`)]))
    const [commit] = (await replay(root)).commits
    const expected = [{ step: "tool0", reason: installed, exitCode: 127, command: `${missing} --version` }]
    expect(commit?.baseline.failures).toEqual(expected)
    expect(commit?.normal.failures).toEqual(expected)
  }, 600_000)
})

describe("a baseline that fails at every commit", () => {
  it("is refused with the newest commit's first failure, and no report", async () => {
    const root = track(makeSmallRepository([job("first", `${missing} one`), job("second", "exit 9")]))
    commitScript(root, "exit 0\n")
    const newest = git(root, "rev-parse", "HEAD").slice(0, 7)
    expect(await refusal(root, 2)).toEqual({
      code: "unsupported",
      part: "replay",
      message: [
        "this repository's CI does not pass on this machine, so there is no speedup to measure. No step passed at any of the 2 replayed commits.",
        `First failure at ${newest}:`,
        "  step     first0",
        `  command  ${missing} one`,
        "  exit     127",
        `  error    ${installed}`
      ].join("\n")
    })
  }, 600_000)

  it("gives a report with no speedup when some step passes but no commit passes whole", async () => {
    const root = track(makeSmallRepository([job("ok", "sh a.sh"), job("bad", "echo broken >&2; exit 3")]))
    const report = await replay(root)
    expect(report).toMatchObject({ speedup: 0, speedupCommits: 0, baselineWallMs: 0, normalWallMs: 0 })
    expect(report.commits[0]?.baseline.failures).toEqual([
      { step: "bad0", reason: "broken", exitCode: 3, command: "echo broken >&2; exit 3" }
    ])
  }, 600_000)
})

describe("one failing commit among passing ones", () => {
  it("is shown with its failure and left out of the speedup", async () => {
    const root = track(makeSmallRepository([job("a", "sh a.sh")]))
    commitScript(root, "echo 'the script broke' >&2\nexit 4\n")
    commitScript(root, "exit 0\n")
    const report = await replay(root, 3)
    const [first, broken, last] = report.commits
    const failure = { step: "a0", reason: "the script broke", exitCode: 4, command: "sh a.sh" }
    expect(broken?.baseline).toMatchObject({ ok: false, failures: [failure] })
    expect(broken?.normal).toMatchObject({ ok: false, failures: [failure] })
    expect(first?.baseline.failures).toBeUndefined()
    expect(last?.normal.failures).toBeUndefined()
    expect(report.speedupCommits).toBe(2)
    expect(report.baselineWallMs).toBe((first?.baseline.wallMs ?? 0) + (last?.baseline.wallMs ?? 0))
    expect(report.normalWallMs).toBe((first?.normal.wallMs ?? 0) + (last?.normal.wallMs ?? 0))
  }, 600_000)
})

describe("what a failure says", () => {
  it("names a step that fails only in a mode", async () => {
    // A mode's copy is in a directory named for the mode; a baseline checkout is not.
    const step = `case "$PWD" in */normal/*) echo 'found the mode' >&2; exit 5;; esac`
    const root = track(makeSmallRepository([job("mode", step)]))
    const [commit] = (await replay(root)).commits
    expect(commit?.baseline.failures).toBeUndefined()
    expect(commit?.normal.failures).toEqual([
      { step: "mode0", reason: "found the mode", exitCode: 5, command: step }
    ])
  }, 600_000)

  it("falls back to the last line a step printed", async () => {
    const root = track(makeSmallRepository([job("ok", "sh a.sh"), job("quiet", "echo one; echo 'two failed'; exit 6")]))
    const [commit] = (await replay(root)).commits
    expect(commit?.baseline.failures?.[0]).toMatchObject({ reason: "two failed", exitCode: 6 })
  }, 600_000)

  it("keeps the start of a long error output", async () => {
    const noisy = "printf 'x%.0s' {1..5000} >&2; sleep 0.5; echo later >&2; exit 2"
    const root = track(makeSmallRepository([job("ok", "sh a.sh"), job("noisy", noisy)]))
    const [failure] = (await replay(root)).commits[0]?.baseline.failures ?? []
    expect(failure).toMatchObject({ step: "noisy0", exitCode: 2, reason: "x".repeat(200) })
  }, 600_000)

  it("withholds a credential a step printed or holds in its command", async () => {
    const token = `ghp_${"b".repeat(30)}`
    const root = track(makeSmallRepository([job("ok", "sh a.sh"), job("leak", `echo "denied ${token}" >&2; exit 1`)]))
    const report = await replay(root)
    expect(JSON.stringify(report)).not.toContain(token)
    expect(report.commits[0]?.baseline.failures?.[0]?.reason).toBe("denied [withheld]")
    // `smthrs` withholds it first in what it prints for a target, in its own words.
    expect(report.commits[0]?.normal.failures?.[0]?.reason).toBe("denied [REDACTED]")
  }, 600_000)

  it("says a step could not start in a directory its commit does not have", async () => {
    const root = track(makeSmallRepository([job("ok", "sh a.sh"), job("gone", "true", { cwd: "no-such-directory" })]))
    const [failure] = (await replay(root)).commits[0]?.baseline.failures ?? []
    expect(failure?.step).toBe("gone0")
    expect(failure?.reason).toMatch(/^could not start: /)
    expect(failure).not.toHaveProperty("exitCode")
  }, 600_000)

  it("says a step ran past its time limit", async () => {
    const root = track(makeSmallRepository([job("ok", "sh a.sh"), job("slow", "sleep 20")]))
    const limited = Layer.succeed(Options, {
      smthrs: [smthrs],
      reruns: 0,
      prepare: (directory) => Effect.sync(() => linkTargets(directory)),
      stepTimeout: "1 second"
    })
    const [failure] = (await replay(root, 1, limited as never)).commits[0]?.baseline.failures ?? []
    expect(failure).toMatchObject({ step: "slow0", exitCode: 124, reason: "it ran past the limit of 1s for one step" })
  }, 600_000)

  it("lists failures in the order of the CI, whichever job ended first", async () => {
    const root = track(
      makeSmallRepository([job("slow", "sleep 2; exit 1"), job("quick", "exit 1"), job("ok", "sh a.sh")])
    )
    const steps = (await replay(root)).commits[0]?.baseline.failures?.map((failure) => failure.step)
    expect(steps).toEqual(["slow0", "quick0"])
  }, 600_000)
})

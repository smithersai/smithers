import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { existsSync, rmSync } from "node:fs"
import { join, relative } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import type { Failure, ReplayParts, ReplayRequest } from "../../src/contract/Parts.ts"
import type { ReplayReport } from "../../src/contract/ReplayReport.ts"
import { path as targetMapPath } from "../../src/contract/TargetMap.ts"
import { Options, run } from "../../src/replay/index.ts"
import {
  job,
  linkTargets,
  makeEmptyDirectory,
  makeEmptyRepository,
  makeSmallRepository,
  recordingSmthrs
} from "./fixture.ts"
import { generated, noTemporaryDirectories, noWrites, options, parts } from "./TestParts.vibe"

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
const request = (root: string, extra: Partial<ReplayRequest> = {}): ReplayRequest => ({
  root,
  commits: 1,
  modes: ["normal"],
  ...extra
})

const withCommand = (command: string) =>
  Layer.succeed(Options, {
    smthrs: [command],
    reruns: 1,
    prepare: (directory) => Effect.sync(() => linkTargets(directory))
  })

const withSmthrs = (command: string) =>
  Layer.succeed(Options, { smthrs: [command], reruns: 1, prepare: () => Effect.void })

const replay = (
  root: string,
  overrides: Partial<Parts> = {},
  extra: Partial<ReplayRequest> = {},
  host: Layer.Layer<never, never, never> = options as never
): Promise<ReplayReport> =>
  Effect.runPromise(
    run(request(root, extra), { ...base, ...overrides }).pipe(
      Effect.provide(Layer.provideMerge(host, NodeServices.layer))
    ) as Effect.Effect<ReplayReport, Failure>
  )

const failureOf = (attempt: Promise<ReplayReport>): Promise<Failure> =>
  attempt.then(
    () => {
      throw new Error("the replay succeeded")
    },
    (cause: { readonly message: string }) => JSON.parse(JSON.stringify(cause)) as Failure
  )

const passing = [job("a", "sh a.sh")]

describe("a replay that cannot run", () => {
  it("refuses a directory that is not a repository", async () => {
    const failure = await failureOf(replay(track(makeEmptyDirectory())))
    expect(failure).toMatchObject({ code: "not-a-repository", part: "replay" })
  })

  it("reports git's failure on a repository with no commits", async () => {
    const failure = await failureOf(replay(track(makeEmptyRepository())))
    expect(failure.code).toBe("command-failed")
    expect(failure.message).toContain("git rev-list failed")
  })

  it("is unsupported when no job runs on a change", async () => {
    const root = track(makeSmallRepository([{ ...job("nightly", "exit 0"), triggers: ["schedule"] }]))
    expect(await failureOf(replay(root))).toMatchObject({ code: "unsupported" })
  })

  it("refuses jobs that need each other", async () => {
    const root = track(makeSmallRepository([job("a", "true", { needs: ["b"] }), job("b", "true", { needs: ["a"] })]))
    const failure = await failureOf(replay(root))
    expect(failure.code).toBe("invalid-document")
    expect(failure.message).toContain("job a")
  })

  it("refuses generated files with no target map", async () => {
    const root = track(makeSmallRepository(passing))
    const failure = await failureOf(replay(root, { files: () => Effect.succeed([]) }))
    expect(failure.code).toBe("invalid-document")
    expect(failure.message).toContain(targetMapPath)
  })

  it("refuses a target map it cannot read", async () => {
    const root = track(makeSmallRepository(passing))
    const files: Parts["files"] = () => Effect.succeed([{ path: targetMapPath, content: "{" }])
    expect(await failureOf(replay(root, { files }))).toMatchObject({ code: "invalid-document" })
  })

  it("is unsupported when no step has a target", async () => {
    const root = track(makeSmallRepository(passing))
    const files: Parts["files"] = (inventory) => Effect.succeed(generated(inventory, () => false))
    expect(await failureOf(replay(root, { files }))).toMatchObject({ code: "unsupported" })
  })

  it("refuses a generated file outside the repository and writes nothing there", async () => {
    const root = track(makeSmallRepository(passing))
    const name = `escaped-${created.length}`
    const files: Parts["files"] = (inventory) =>
      Effect.succeed([...generated(inventory), { path: `../../../../../../../../tmp/${name}`, content: "x" }])
    const failure = await failureOf(replay(root, { files }))
    expect(failure.code).toBe("invalid-document")
    expect(existsSync(join("/tmp", name))).toBe(false)
  })

  it("reports a Smithers build that cannot start", async () => {
    const root = track(makeSmallRepository(passing))
    const failure = await failureOf(replay(root, {}, {}, withSmthrs("/no/such/smthrs") as never))
    expect(failure.code).toBe("command-failed")
    expect(failure.message).toContain("could not run /no/such/smthrs")
  })

  it("reports a Smithers build that writes no run record", async () => {
    const root = track(makeSmallRepository(passing))
    const failure = await failureOf(replay(root, {}, {}, withSmthrs("true") as never))
    expect(failure.code).toBe("command-failed")
    expect(failure.message).toContain("wrote no run record")
  })

  it("reports a workspace Smithers build cannot load, with its reason", async () => {
    const broken: Parts["files"] = (inventory) =>
      Effect.succeed([...generated(inventory), { path: "PACKAGE.ts", content: "export const Package = 1\n" }])
    const failure = await failureOf(replay(track(makeSmallRepository(passing)), { files: broken }))
    expect(failure.code).toBe("command-failed")
    expect(failure.message).toContain("wrote no run record")
    expect(failure.message).toContain("ci_failed")
  }, 120_000)

  it("reports a temporary directory it cannot make", async () => {
    const root = track(makeSmallRepository(passing))
    const failure = await failureOf(replay(root, {}, {}, noTemporaryDirectories as never))
    expect(failure.code).toBe("command-failed")
    expect(failure.message).toContain("could not make a directory")
  })

  it("reports a generated file it cannot write", async () => {
    const root = track(makeSmallRepository(passing))
    const failure = await failureOf(replay(root, {}, {}, noWrites as never))
    expect(failure.code).toBe("command-failed")
    expect(failure.message).toContain("could not write .smithers/WORKSPACE.ts")
  })
})

describe("a replay that runs", () => {
  it("accepts a root relative to the working directory", async () => {
    const root = track(makeSmallRepository(passing))
    const report = await replay(relative(process.cwd(), root), {}, { commits: 0 })
    expect(report.commits).toEqual([])
  })

  it("does not wait for a process a step leaves running", async () => {
    // The process outlives this test, so waiting for its pipe to close would time the test out.
    const root = track(makeSmallRepository([job("x", "sleep 240 & exit 0"), ...passing]))
    const files: Parts["files"] = (inventory) => Effect.succeed(generated(inventory, (entry) => entry.step !== "x0"))
    const report = await replay(root, { files })
    expect(report.commits[0]?.baseline.ok).toBe(true)
  }, 200_000)

  it("uses the default fast-mode settings when the request gives none, and gives rows the commit's plan", async () => {
    const root = track(makeSmallRepository(passing))
    const planned: Array<ReadonlyArray<string>> = []
    const rows: Parts["rows"] = (repository, record, plan) => {
      planned.push(plan?.targets.map((target) => target.label) ?? [])
      return base.rows(repository, record)
    }
    // A score of 0 is under every cutoff, but the default keeps the five highest-scoring targets.
    const report = await replay(root, { rows }, { modes: ["normal", "fast"] })
    expect(report.commits[0]?.fast?.counts).toEqual({ hit: 0, ran: 1, failed: 0, skipped: 0 })
    expect(report.selection).toMatchObject({ rows: 1, selected: 1 })
    expect(planned).toEqual([["//:a0_0"]])
  }, 120_000)

  it("never runs more targets at once than the target map allows", async () => {
    const root = track(makeSmallRepository(passing))
    const recording = recordingSmthrs(false)
    track(recording.directory)
    const files: Parts["files"] = (inventory) =>
      Effect.succeed(
        generated(inventory).map((file) =>
          file.path === targetMapPath ? { ...file, content: file.content.replace("{", `{"maxJobs":1,`) } : file
        )
      )
    await replay(root, { files }, { jobs: 8 }, withCommand(recording.command) as never)
    expect(recording.commands().filter((line) => line.startsWith("ci ")).every((line) => line.endsWith("--jobs 1")))
      .toBe(true)
  }, 120_000)

  it("reports a plan Smithers build did not print", async () => {
    const root = track(makeSmallRepository(passing))
    const recording = recordingSmthrs(true)
    track(recording.directory)
    const failure = await failureOf(
      replay(root, {}, { modes: ["normal", "fast"] }, withCommand(recording.command) as never)
    )
    expect(failure.code).toBe("command-failed")
    expect(failure.message).toContain("printed no plan")
  }, 120_000)

  it("runs a step with no target but gives it no verdict, and it still stops its job", async () => {
    const root = track(makeSmallRepository([
      job("x", "true", { more: ["sh a.sh"] }),
      job("y", "exit 1", { more: ["sh a.sh", "true"] })
    ]))
    const files: Parts["files"] = (inventory) =>
      Effect.succeed(generated(inventory, (entry) => !["x0", "y0", "y2"].includes(entry.step)))
    const [commit] = (await replay(root, { files })).commits
    expect(commit?.baseline.counts).toEqual({ hit: 0, ran: 1, failed: 0, skipped: 1 })
    // The target for y's second step depends on y0, which fails, so normal mode skips it too.
    expect(commit?.normal.counts.skipped).toBe(1)
    expect(commit?.mismatches).toEqual([])
  }, 120_000)

  it("fails a step whose directory is missing, without stopping the replay, and reports the mismatch", async () => {
    const root = track(makeSmallRepository([job("a", "sh a.sh", { cwd: "gone" })]))
    const report = await replay(root, {}, { cache: "http://127.0.0.1:9" })
    const [commit] = report.commits
    expect(commit?.baseline.counts).toEqual({ hit: 0, ran: 0, failed: 1, skipped: 0 })
    expect(commit?.normal.ok).toBe(true)
    expect(commit?.mismatches).toEqual([{ label: "//:a0_0", mode: "normal", baseline: "fail", got: "pass" }])
  }, 180_000)
})

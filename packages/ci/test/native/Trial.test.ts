/** A repository's own targets on a machine where part of them cannot pass, or where one stops making progress. */
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { rmSync } from "node:fs"
import { afterAll, describe, expect, it } from "vitest"
import { failsHere, needsLeftOut } from "../../src/contract/Inventory.ts"
import type { Failure, ReplayParts, ReplayRequest } from "../../src/contract/Parts.ts"
import type { ReplayReport } from "../../src/contract/ReplayReport.ts"
import { read } from "../../src/inventory/index.ts"
import { type Host, own } from "../../src/native/index.ts"
import { noProgress } from "../../src/replay/Failures.ts"
import { Options, Progress } from "../../src/replay/index.ts"
import { unconfined } from "../replay/place.ts"
import { ownFiles } from "./own.ts"
import { commit, git, repository } from "./repo.ts"
import { rows, scoreKeeping } from "./support.vibe"

const made: Array<string> = []
const keep = (root: string): string => {
  made.push(root)
  return root
}
afterAll(() => made.forEach((root) => rmSync(root, { recursive: true, force: true })))

const parts: ReplayParts<Host> = {
  read,
  files: () => Effect.fail({ code: "invalid-document", message: "nothing may be generated", part: "generate" }),
  rows,
  score: scoreKeeping("//:c", "none")
}

const host = Layer.mergeAll(
  Layer.succeed(Options, { smthrs: ["never-used"], reruns: 1, prepare: () => Effect.void, confine: unconfined }),
  Layer.succeed(Progress, { say: () => Effect.void })
)

const replay = (root: string, extra: Partial<ReplayRequest> = {}): Promise<ReplayReport> =>
  Effect.runPromise(
    own({ root, commits: 1, modes: ["normal"], trial: true, ...extra }, parts, "WORKSPACE.ts").pipe(
      Effect.provide(Layer.provideMerge(host, NodeServices.layer))
    ) as Effect.Effect<ReplayReport, Failure>
  )

const refusal = (root: string, extra: Partial<ReplayRequest> = {}): Promise<Failure> =>
  replay(root, extra).then(
    () => {
      throw new Error("the replay succeeded")
    },
    (cause: { readonly message: string }) => JSON.parse(JSON.stringify(cause)) as Failure
  )

const broken = "echo broken >&2\nexit 1\n"
const blocked = "d=$(mktemp -d)\nmkfifo $d/pipe\ncat $d/pipe\n"

describe("a target that cannot pass on this machine", { timeout: 600_000 }, () => {
  it("is left out and listed, and the others are measured at every commit", async () => {
    const root = keep(repository({ ...ownFiles(), "c.sh": broken }))
    commit(root, "a change", { "a.sh": "# changed\nexit 0\n" })
    const report = await replay(root, { commits: 2 })
    expect(report.notReplayed).toContainEqual({
      job: "//:c",
      reasons: [{ feature: failsHere, detail: "broken" }]
    })
    expect(report.jobs).toEqual({ replayed: 2, total: 3 })
    expect(report.trialMs).toBeGreaterThan(0)
    expect(report.speedupCommits).toBe(2)
    for (const replayed of report.commits) {
      expect(replayed.baseline.ok).toBe(true)
      expect(replayed.baseline.counts.ran).toBe(2)
      expect(replayed.mismatches).toEqual([])
    }
  })

  it("takes the targets that wait on it with it", async () => {
    const report = await replay(keep(repository({ ...ownFiles(), "a.sh": broken })))
    expect(report.notReplayed).toEqual(expect.arrayContaining([
      { job: "//:a", reasons: [{ feature: failsHere, detail: "broken" }] },
      {
        job: "//:b",
        reasons: [{ feature: needsLeftOut, detail: "//:b needs a target that fails here, which is not replayed" }]
      }
    ]))
    expect(report.jobs).toEqual({ replayed: 1, total: 3 })
    expect(report.commits[0]?.baseline.counts.ran).toBe(1)
  })

  it("still lets a commit that cannot be planned fail as it would", async () => {
    const root = keep(repository({ ...ownFiles(), "PACKAGE.ts": "this is not a package\n" }))
    commit(root, "a package, with one target that fails", {
      "PACKAGE.ts": ownFiles()["PACKAGE.ts"] as string,
      "c.sh": broken
    })
    const report = await replay(root, { commits: 2 })
    expect(report.commits[0]?.baseline.ok).toBe(false)
    expect(report.commits[1]?.baseline.ok).toBe(true)
  })
})

describe("targets of which none passes", { timeout: 600_000 }, () => {
  it("are refused with the first failure", async () => {
    const root = keep(repository({ ...ownFiles(), "a.sh": broken, "c.sh": broken }))
    const at = git(root, "rev-parse", "HEAD").trim().slice(0, 7)
    const { code, message } = await refusal(root)
    expect(code).toBe("unsupported")
    expect(message).toContain(`No job passed at ${at}.`)
    expect(message).toContain("  error    broken")
  })

  it("are refused as before when the patterns select none", async () => {
    const failure = await refusal(keep(repository(ownFiles())), { targets: ["//nothing/here/..."] })
    expect(failure.code).toBe("unsupported")
  })
})

describe("a run that stops making progress", { timeout: 600_000 }, () => {
  const minutes = 0.1

  it("fails its target with the reason, in the baseline and in normal mode", async () => {
    const root = keep(repository({ ...ownFiles(), "c.sh": blocked }))
    const [replayed] = (await replay(root, { trial: false, stallMinutes: minutes })).commits
    const expected = [expect.objectContaining({ step: "//:c", reason: noProgress(minutes) })]
    expect(replayed?.baseline.failures).toEqual(expected)
    expect(replayed?.normal.failures).toEqual(expected)
  })

  it("is an install that fails, with the reason", async () => {
    const hanging = "setInterval(() => {}, 1 << 30)\n"
    const root = keep(repository({ ...ownFiles(), "tools/install.mjs": hanging }))
    const { code, message } = await refusal(root, { trial: false, stallMinutes: minutes })
    expect(code).toBe("unsupported")
    expect(message).toContain(noProgress(minutes))
  })
})

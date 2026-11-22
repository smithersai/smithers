/**
 * A replay asked for some CI jobs only (`--job`): it runs those jobs and every job they need, and counts the CI's
 * other jobs as not asked for, apart from the jobs it cannot replay.
 */
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import { rmSync } from "node:fs"
import { afterAll, describe, expect, it } from "vitest"
import { unknownJobs, unknownJobsSentence } from "../../src/contract/Command.ts"
import type { Inventory } from "../../src/contract/Inventory.ts"
import type { Failure, ReplayParts, ReplayRequest } from "../../src/contract/Parts.ts"
import { ReplayReport } from "../../src/contract/ReplayReport.ts"
import { asking, noneAsked, toReplay } from "../../src/replay/Asked.ts"
import { run } from "../../src/replay/index.ts"
import { inventoryWith, job, makeSmallRepository } from "./fixture.ts"
import { options, parts } from "./TestParts.vibe"

const created: Array<string> = []
afterAll(() => {
  for (const path of created) rmSync(path, { recursive: true, force: true })
})

/** The test repository's CI: a; b needs a; c; d; f needs c; h needs f; k; m with two variants; nightly. */
const inventory = inventoryWith("unused") as unknown as Inventory
const ids = (chosen: Inventory): ReadonlyArray<string> => chosen.jobs.map((entry) => entry.id)
const ci = (jobs: ReadonlyArray<unknown>): Inventory => ({ ...inventory, jobs }) as unknown as Inventory

describe("the jobs a replay is asked for", () => {
  it("are those jobs and every job they need, through others, with the rest counted as not asked for", () => {
    const chosen = asking(inventory, ["h"])
    expect(ids(chosen.inventory)).toEqual(["c", "f", "h"])
    expect(chosen.asked).toEqual({
      jobs: ["h"],
      needed: [{ job: "c", for: ["h"] }, { job: "f", for: ["h"] }],
      notAsked: 6
    })
  })

  it("are named once each, in the order asked, and an id that names no job is not asked for", () => {
    const chosen = asking(inventory, ["h", "b", "h", "zzz"])
    expect(chosen.asked.jobs).toEqual(["h", "b"])
    expect(chosen.asked.needed.map((entry) => entry.job)).toEqual(["a", "c", "f"])
    expect(chosen.asked.notAsked).toBe(4)
    expect(asking(inventory, ["zzz"]).asked).toEqual({ jobs: [], needed: [], notAsked: 9 })
  })

  it("never name a job asked for as one that came with another", () => {
    const chosen = asking(inventory, ["f", "h"])
    expect(chosen.asked.needed).toEqual([{ job: "c", for: ["f"] }])
    expect(ids(chosen.inventory)).toEqual(["c", "f", "h"])
  })

  it("say each job a needed job came for", () => {
    const shared = ci([
      job("base", "true"),
      job("one", "true", { needs: ["base"] }),
      job("two", "true", { needs: ["base"] })
    ])
    expect(asking(shared, ["two", "one"]).asked.needed).toEqual([{ job: "base", for: ["one", "two"] }])
  })

  it("end where jobs need each other in a ring", () => {
    const ring = ci([
      job("x", "true", { needs: ["y"] }),
      job("y", "true", { needs: ["z"] }),
      job("z", "true", { needs: ["y"] })
    ])
    expect(asking(ring, ["x"]).asked.needed).toEqual([{ job: "y", for: ["x"] }, { job: "z", for: ["x"] }])
  })

  it("keep a need the CI does not hold where the replay's own rules find it", () => {
    const missing = ci([job("p", "true", { needs: ["gone"] }), job("q", "true")])
    const chosen = asking(missing, ["p"])
    expect(chosen.asked).toEqual({ jobs: ["p"], needed: [], notAsked: 1 })
    expect(chosen.inventory.jobs[0]?.needs).toEqual(["gone"])
  })

  it("say so when a commit's CI holds none of them", () => {
    expect(noneAsked(["a", "a", "b"])).toBe("none of the jobs asked for is in this commit's CI: a, b")
    expect(toReplay(inventory, ["zzz"])).toEqual({ refusal: noneAsked(["zzz"]) })
  })

  it("are every job when none was asked for", () => {
    expect(toReplay(inventory, undefined)).toEqual({ inventory })
    expect(toReplay(inventory, ["a"])).toEqual(asking(inventory, ["a"]))
  })
})

describe("an id that names no job", () => {
  it("is found among the ids given, once each, in their order", () => {
    expect(unknownJobs(inventory, ["a", "zzz", "zzz", "yy", "h"])).toEqual(["zzz", "yy"])
    expect(unknownJobs(inventory, ["a", "m"])).toEqual([])
  })

  it("is said with every job the CI has", () => {
    expect(unknownJobsSentence(ci([job("a", "true"), job("b", "true")]), ["zzz"])).toBe(
      "--job zzz names no job of this CI; its jobs are a, b"
    )
    expect(unknownJobsSentence(ci([]), ["zzz", "yy"])).toBe("--job zzz, yy name no jobs of this CI; its jobs are none")
  })
})

const base = parts("none") as unknown as ReplayParts<never>

const replaying = (root: string, extra: Partial<ReplayRequest>) =>
  run({ root, commits: 1, modes: ["normal"], ...extra }, base).pipe(
    Effect.provide(Layer.provideMerge(options as never, NodeServices.layer))
  ) as Effect.Effect<ReplayReport, Failure>

describe("a replay asked for one job", () => {
  it("runs it and the job it needs, and counts the other job as not asked for, never as left out", async () => {
    const root = makeSmallRepository([
      job("a", "sh a.sh"),
      job("b", "sh a.sh", { needs: ["a"] }),
      job("k", "sh a.sh")
    ])
    created.push(root)
    const report = await Effect.runPromise(replaying(root, { only: ["b"] }))
    expect(Schema.decodeUnknownSync(ReplayReport)(report)).toEqual(report)
    expect(report.asked).toEqual({ jobs: ["b"], needed: [{ job: "a", for: ["b"] }], notAsked: 1 })
    expect(report.jobs).toEqual({ replayed: 2, total: 2 })
    expect(report.notReplayed ?? []).toEqual([])
    expect(report.commits[0]?.baseline.counts.ran).toBe(2)
  }, 540_000)

  it("stops, saying so, when no job of the CI is one asked for", async () => {
    const root = makeSmallRepository([job("a", "sh a.sh")])
    created.push(root)
    const failure = await Effect.runPromise(Effect.flip(replaying(root, { only: ["zzz"] })))
    expect(failure).toMatchObject({ code: "unsupported", message: noneAsked(["zzz"]) })
  }, 540_000)
})

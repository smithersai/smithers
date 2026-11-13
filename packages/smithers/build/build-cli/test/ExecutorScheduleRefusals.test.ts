/**
 * The scheduler and plan merge refuse what they cannot run faithfully: a
 * bound that is not a number, an abort that lands while targets are being
 * dispatched, a work list that changes under the scheduler, and a merged plan
 * whose dependency no plan contains.
 */
import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import { mergePlans, resolveJobs, schedule, scheduleEffect } from "../src/Executor.ts"
import type * as Planner from "../src/Planner.ts"

/** A planned target reduced to the fields the scheduler reads. */
const target = (
  label: string,
  ...dependencies: ReadonlyArray<string>
): Planner.PlannedTarget => ({ label, dependencies, attrs: {} } as unknown as Planner.PlannedTarget)

/** A planned target with the fields the merge reads. */
const planned = (
  label: string,
  dependencies: ReadonlyArray<string>
): Planner.PlannedTarget => ({ label, dependencies, attrs: {}, keyPreview: label } as unknown as Planner.PlannedTarget)

describe("the concurrency bound", () => {
  it("names the type of a non-number bound passed by a programmatic caller", () => {
    expect(() => resolveJobs("4" as unknown as number)).toThrow(
      new TypeError("jobs must be a positive integer, received string")
    )
  })

  it("rejects a non-number bound before running any target", async () => {
    const started: Array<string> = []
    const exit = await Effect.runPromiseExit(
      scheduleEffect([target("//:a")], "2" as unknown as number, (label) => Effect.sync(() => started.push(label)))
    )
    expect(exit._tag).toBe("Failure")
    expect(String(exit._tag === "Failure" ? exit.cause : "")).toContain(
      "jobs must be a positive integer, received string"
    )
    expect(started).toEqual([])
  })
})

describe("shared dependencies", () => {
  it("releases a dependent only after its last dependency settles", async () => {
    const started: Array<string> = []
    await schedule(
      [
        target("//:top", "//:left", "//:right"),
        target("//:left", "//:base"),
        target("//:right", "//:base"),
        target("//:base")
      ],
      1,
      async (label) => {
        started.push(label)
      }
    )
    expect(started).toEqual(["//:base", "//:left", "//:right", "//:top"])
  })

  it("merges a diamond with the shared dependency listed once", () => {
    const plan: Planner.Plan = {
      verb: "build",
      pattern: "//...",
      roots: ["//:top"],
      targets: [
        planned("//:base", []),
        planned("//:left", ["//:base"]),
        planned("//:right", ["//:base"]),
        planned("//:top", ["//:left", "//:right"])
      ],
      edges: [],
      warnings: []
    }
    const merged = mergePlans([plan])
    expect(merged.targets.map((entry) => entry.label)).toEqual(["//:base", "//:left", "//:right", "//:top"])
    expect(merged.edges).toEqual([
      { from: "//:base", to: "//:left" },
      { from: "//:left", to: "//:top" },
      { from: "//:base", to: "//:right" },
      { from: "//:right", to: "//:top" }
    ])
  })
})

describe("scheduler refusals during a run", () => {
  it("stops dispatching when the signal aborts while a target is being started", async () => {
    const controller = new AbortController()
    const started: Array<string> = []
    const run = schedule([target("//:a"), target("//:b"), target("//:c")], 3, async (label) => {
      started.push(label)
      controller.abort(new Error("operator pressed ctrl-c"))
    }, controller.signal)
    await expect(run).rejects.toThrow("operator pressed ctrl-c")
    expect(started).toEqual(["//:a"])
  })

  it("rejects instead of resolving when the work list grows after validation", async () => {
    const targets: Array<Planner.PlannedTarget> = [target("//:a")]
    const started: Array<string> = []
    const run = schedule(targets, 1, async (label) => {
      started.push(label)
      targets.push(target("//:late"))
    })
    await expect(run).rejects.toThrow("scheduler stalled after dispatching 1 of 2 targets")
    expect(started).toEqual(["//:a"])
  })
})

describe("mergePlans", () => {
  it("refuses a dependency that no merged plan contains", () => {
    const plan: Planner.Plan = {
      verb: "build",
      pattern: "//...",
      roots: ["//:root"],
      targets: [planned("//:root", ["//:absent"])],
      edges: [],
      warnings: []
    }
    expect(() => mergePlans([plan])).toThrow("merged plan depends on missing target //:absent")
  })
})

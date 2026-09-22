import { afterAll, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  batches,
  declaredBatches,
  declaredOnDiskPriority,
  declaredPriorities,
  discovered,
  discoveredFlow,
  main,
  specs
} from "../src/16-fan-out-fan-in.ts"

const directory = mkdtempSync(join(tmpdir(), "flows-examples-"))

afterAll(() => rmSync(directory, { recursive: true, force: true }))

it("declares three batches of at most two, urgent checks first", () => {
  expect(declaredBatches).toEqual([
    ["audit", "licence"],
    ["lint", "types"],
    ["unit"]
  ])
})

it("holds every batch to at most the concurrency it is given", () => {
  expect(batches(specs, 1)).toEqual([["audit"], ["licence"], ["lint"], ["types"], ["unit"]])
  expect(batches(specs, 4)).toEqual([["audit", "licence", "lint", "types"], ["unit"]])
  expect(batches(specs, 5)).toEqual([["audit", "licence", "lint", "types", "unit"]])
  expect(batches(specs, 9)).toEqual([["audit", "licence", "lint", "types", "unit"]])
  expect(batches([], 2)).toEqual([])
})

// A bound the loop cannot advance by is refused rather than looped on: zero and
// negatives never terminate, and a fractional or non-finite bound would group
// checks the helper's doc line does not describe.
it("refuses a concurrency that is not a positive integer", () => {
  for (const concurrency of [0, -1, -2, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    expect(() => batches(specs, concurrency)).toThrow(
      `batch concurrency must be a positive integer: ${concurrency}`
    )
  }
  // The refusal does not depend on there being checks to batch.
  expect(() => batches([], 0)).toThrow("batch concurrency must be a positive integer: 0")
})

it("carries each check's priority into the built plan", () => {
  expect(declaredPriorities()).toEqual({
    lint: 0,
    types: 0,
    unit: 0,
    audit: 9,
    licence: 5
  })
})

// `it.live` rather than `it.effect`: the checks overlap on the real clock, and
// a test clock nobody advances would leave the first batch asleep forever.
it.live("runs at most two checks at a time and joins every verdict", () =>
  Effect.gen(function*() {
    const summary = yield* main(join(directory, "gate.sqlite"))

    expect(summary.report).toBe("lint:clean types:clean unit:clean audit:clean licence:clean")
    // A re-drive under the same execution id reads every recorded verdict back.
    // The fan-out members replay rather than dispatch a second time.
    expect(summary.replayed).toBe(summary.report)
    // The bound is topology, so it holds at run time as well as in the plan.
    expect(summary.maxInFlight).toBe(2)
    // The release blocker and the licence check share the first batch.
    expect(summary.started.slice(0, 2).sort()).toEqual(["audit", "licence"])
    expect(summary.started.slice(2, 4).sort()).toEqual(["lint", "types"])
    expect(summary.started[4]).toBe("unit")
    // Every check ran exactly once across BOTH executions: a fan-out is five
    // steps, not one step five times, and a replayed member is not a sixth.
    expect(summary.dispatches).toEqual({ lint: 1, types: 1, unit: 1, audit: 1, licence: 1 })
    expect(summary.eventTypes).toContain("flows.engine.attempt-started")
  }), { timeout: 60_000 })

// `it.live` for the same reason `main`'s test is: the checks overlap on the
// real clock.
it.live("runs the same gate when the project declares it on disk", () =>
  Effect.gen(function*() {
    const summary = yield* discovered(join(directory, "discovered.sqlite"))

    // Nothing in the example names this flow; the directory it was found in
    // does. The module IS the flow, so it delegates to nothing and the bridge
    // runs the graph the file declares under its own tag.
    expect(summary.flow).toBe(discoveredFlow)
    expect(summary.delegate).toBeUndefined()
    expect(summary.tag).toBe("examples/ProjectGate")

    // The priority the file declares is lowered onto the delegating node, so it
    // reaches the plan the same way `Node.priority` does inside a body.
    expect(summary.lowered).toBe(declaredOnDiskPriority)
    expect(summary.planned).toContain(declaredOnDiskPriority)
    // And it sits beside the priorities the body states itself.
    expect(summary.planned).toContain(9)
    expect(summary.planned).toContain(5)

    // Same topology, so same bound and same report.
    expect(summary.maxInFlight).toBe(2)
    expect(summary.report).toBe("lint:clean types:clean unit:clean audit:clean licence:clean")
  }), { timeout: 60_000 })

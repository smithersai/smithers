import { describe, it } from "@effect/vitest"
import { Action, Flow, Graph } from "@smthrs/flow"
import * as Node from "@smthrs/plan/Node"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Schema from "effect/Schema"
import { expect } from "vitest"
import * as ScanFixVerify from "../src/ScanFixVerify.vibe"
import { execute } from "./Execute.ts"
import { callsTo } from "./Graphs.ts"

// One stage flow per role, tagged with its own name. Core named a stage by the
// single capability it declared and counted calls by reading that capability
// back off key material; `@smthrs/flow` names a call by the callee's tag, so
// the shared `callsTo` counts exactly the same calls by that tag.
const flowNamed = (tag: string) =>
  Flow.make(tag, {
    payload: {
      input: Schema.optional(Schema.Unknown),
      iteration: Schema.optional(Schema.Unknown),
      issue: Schema.optional(Schema.Unknown),
      index: Schema.optional(Schema.Unknown),
      issues: Schema.optional(Schema.Unknown),
      fixes: Schema.optional(Schema.Unknown)
    },
    success: Schema.Unknown,
    error: Schema.Unknown,
    capabilities: [tag],
    body: Node.capture({ tag }, (payload) => Node.succeed(payload))
  })

const scan = flowNamed("sfv/scan")
const fix = flowNamed("sfv/fix")
const verify = flowNamed("sfv/verify")

describe("ScanFixVerify", () => {
  it("declares a bounded scan, fan-out fix, and verify per retry", () => {
    const pattern = ScanFixVerify.make({
      scan,
      fix,
      verify,
      maxRetries: 2,
      maxIssues: 3,
      concurrency: 2
    })
    const graph = Graph.build(pattern, { input: { path: "src" } })

    expect(Flow.isFlow(pattern)).toBe(true)
    expect(callsTo(graph, "sfv/scan")).toHaveLength(2)
    expect(callsTo(graph, "sfv/fix")).toHaveLength(6)
    expect(callsTo(graph, "sfv/verify")).toHaveLength(2)
    expect(Graph.nodes(graph).filter((node) => node.kind === "All")).toHaveLength(4)
  })

  it("keeps the caller's name and description on the declared flow", () => {
    const options = { scan, fix, verify, maxRetries: 1, maxIssues: 1, concurrency: 1 }
    const pattern = ScanFixVerify.make({ ...options, name: "lint-fix", description: "Fix what the linter found." })

    expect(pattern._tag).toBe("lint-fix")
    expect(pattern.description).toBe("Fix what the linter found.")
    expect(ScanFixVerify.make(options).description).toBeUndefined()
  })

  it("rejects invalid bounds", () => {
    const options = { scan, fix, verify, maxRetries: 1, maxIssues: 1, concurrency: 1 }
    for (
      const invalid of [0, -1, 1.5, Number.NaN, Infinity, Number.MAX_SAFE_INTEGER + 1].flatMap((value) => [
        { ...options, maxRetries: value },
        { ...options, maxIssues: value },
        { ...options, concurrency: value }
      ])
    ) {
      expect(() => ScanFixVerify.make(invalid)).toThrow(
        expect.objectContaining({
          code: "invalid_decorator",
          message: "ScanFixVerify maxRetries, maxIssues, and concurrency must be positive safe integers"
        })
      )
    }
  })

  it("reads the signals a verifier may carry", () => {
    expect(ScanFixVerify.resolved(true)).toBe(true)
    expect(ScanFixVerify.resolved({ resolved: true })).toBe(true)
    expect(ScanFixVerify.resolved(false)).toBe(false)
    expect(ScanFixVerify.resolved(Object.create({ resolved: true }))).toBe(false)
    expect(ScanFixVerify.resolved("resolved")).toBe(false)
    expect(ScanFixVerify.resolved({ resolved: "true" })).toBe(false)
    expect(ScanFixVerify.resolved(undefined)).toBe(false)
  })

  describe("executed declaration", () => {
    it.effect("bounds fixes in flight and holds the next batch until slots are free", () =>
      Effect.gen(function*() {
        const concurrency = 2
        const gates = yield* Effect.all([Deferred.make<void>(), Deferred.make<void>(), Deferred.make<void>()])
        const arrivals = yield* Effect.all([Deferred.make<void>(), Deferred.make<void>(), Deferred.make<void>()])
        const finished = yield* Effect.all([Deferred.make<void>(), Deferred.make<void>(), Deferred.make<void>()])
        const started: Array<number> = []
        let inFlight = 0
        let peak = 0
        const Scan = Action.make("sfv/concurrency-scan", {
          payload: { input: Schema.Unknown, iteration: Schema.Number },
          success: Schema.Array(Schema.String)
        })
        const Fix = Action.make("sfv/concurrency-fix", {
          payload: { issue: Schema.String, index: Schema.Number, iteration: Schema.Number },
          success: Schema.String
        })
        const pattern = ScanFixVerify.make<Action.Requirement<"sfv/concurrency-scan" | "sfv/concurrency-fix">>({
          scan: Scan,
          fix: Fix,
          verify: flowNamed("sfv/concurrency-verify"),
          maxRetries: 2,
          maxIssues: 3,
          concurrency
        })
        const fiber = yield* Effect.forkChild(
          Effect.promise(() =>
            execute(
              pattern,
              { input: "repo" },
              "sfv-concurrency",
              Scan.toLayer(({ iteration }) => Effect.succeed(iteration === 1 ? ["a", "b", "c"] : [])),
              Fix.toLayer(({ issue, index }) =>
                Effect.gen(function*() {
                  started.push(index)
                  inFlight += 1
                  peak = Math.max(peak, inFlight)
                  yield* Deferred.succeed(arrivals[index]!, undefined)
                  yield* Deferred.await(gates[index]!)
                  inFlight -= 1
                  yield* Deferred.succeed(finished[index]!, undefined)
                  return `fixed ${issue}`
                })
              )
            )
          ),
          { startImmediately: true }
        )

        yield* Effect.all([Deferred.await(arrivals[0]!), Deferred.await(arrivals[1]!)])
        expect(inFlight).toBe(concurrency)
        expect(peak).toBe(concurrency)
        expect(started).toEqual([0, 1])
        expect(yield* Deferred.isDone(arrivals[2]!)).toBe(false)

        yield* Deferred.succeed(gates[0]!, undefined)
        yield* Deferred.await(finished[0]!)
        // Batches wait for every member, even after one slot becomes free.
        expect(yield* Deferred.isDone(arrivals[2]!)).toBe(false)
        yield* Deferred.succeed(gates[1]!, undefined)
        yield* Deferred.await(arrivals[2]!)
        expect(yield* Deferred.isDone(finished[1]!)).toBe(true)
        yield* Deferred.succeed(gates[2]!, undefined)

        expect(yield* Fiber.join(fiber)).toMatchObject({ iterations: 2, remaining: [], resolved: true })
        expect(started).toEqual([0, 1, 2])
        expect(inFlight).toBe(0)
        expect(peak).toBe(concurrency)
      }))

    // Each stage records an observation through a declared action on the engine.
    const observe = Action.make("sfv/observe", {
      payload: { pattern: Schema.String },
      success: Schema.Struct({ paths: Schema.Array(Schema.String) })
    })
    const called: Array<string> = []
    let rounds: ReadonlyArray<ReadonlyArray<string>> = []
    const observationLayer = observe.toLayer((payload) =>
      Effect.sync(() => {
        const pattern = (payload as { readonly pattern: string }).pattern
        called.push(pattern)
        const round = /^scan\/(\d+)$/.exec(pattern)
        const paths = round === null ? [] : rounds[Number(round[1]) - 1] ?? []
        return { paths }
      })
    )
    const stage = <F extends Schema.Struct.Fields>(
      tag: string,
      payload: F,
      pattern: (input: any) => string,
      answer: (input: any, paths: ReadonlyArray<string>) => unknown
    ) =>
      Flow.make(tag, {
        payload,
        success: Schema.Unknown,
        error: Schema.Unknown,
        body: Node.capture({ tag }, (input: any) =>
          Node.map(
            Node.all({ found: observe.call({ pattern: pattern(input) }), input: Node.succeed(input) }),
            Node.capture({ tag, answer: true }, (settled: any) => answer(settled.input, settled.found.paths))
          ))
      })
    const scanStage = stage(
      "sfv/exec-scan",
      { input: Schema.Unknown, iteration: Schema.Number },
      ({ iteration }) => `scan/${iteration}`,
      (_, paths) => paths
    )
    const fixStage = stage(
      "sfv/exec-fix",
      { issue: Schema.Unknown, index: Schema.Number, iteration: Schema.Number },
      ({ index, iteration }) => `fix/${iteration}/${index}`,
      ({ issue }) => `fixed ${issue}`
    )
    const verifyStage = stage(
      "sfv/exec-verify",
      { input: Schema.Unknown, issues: Schema.Unknown, fixes: Schema.Unknown, iteration: Schema.Number },
      ({ iteration }) => `verify/${iteration}`,
      ({ fixes, iteration }) => ({ fixes, iteration, resolved: true })
    )
    const executed = async (script: ReadonlyArray<ReadonlyArray<string>>, executionId: string) => {
      called.length = 0
      rounds = script
      const pattern = ScanFixVerify.make({
        scan: scanStage,
        fix: fixStage,
        verify: verifyStage,
        maxRetries: 2,
        maxIssues: 3,
        concurrency: 3
      })
      return { report: await execute(pattern, { input: "repo" }, executionId, observationLayer), calls: [...called] }
    }
    it("fixes only the issues the scan returned and stops on a clean rescan", async () => {
      const script = [["issue-a"], []]
      const { report, calls } = await executed(script, "sfv-clean-rescan")

      expect(calls).toEqual(["scan/1", "fix/1/0", "verify/1", "scan/2"])
      expect(report).toEqual({
        iterations: 2,
        remaining: [],
        resolved: true,
        verifications: [{ fixes: ["fixed issue-a"], iteration: 1, resolved: true }]
      })
    })

    it("never fixes or verifies when the first scan is clean", async () => {
      const { report, calls } = await executed([], "sfv-clean-first")

      expect(calls).toEqual(["scan/1"])
      expect(report).toEqual({ iterations: 1, remaining: [], resolved: true, verifications: [] })
    })

    it("reports the remaining issues and every verification at the retry bound", async () => {
      const script = [["issue-a", "issue-b"], ["issue-b"]]
      const { report, calls } = await executed(script, "sfv-bound")

      expect([...calls].sort()).toEqual(
        ["fix/1/0", "fix/1/1", "fix/2/0", "scan/1", "scan/2", "verify/1", "verify/2"]
      )
      expect(report).toEqual({
        iterations: 2,
        remaining: ["issue-b"],
        resolved: false,
        verifications: [
          { fixes: ["fixed issue-a", "fixed issue-b"], iteration: 1, resolved: true },
          { fixes: ["fixed issue-b"], iteration: 2, resolved: true }
        ]
      })
    })
  })
})

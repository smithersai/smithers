/**
 * The four probabilistic-selection laws, asserted through the scheduler the
 * way the PlanScheduler suite asserts evaluation: the graph is declared as
 * data, driven, and asserted on. The standard fixture is the spec's worked
 * example — `build` feeds `engine-tests`, `lint-docs` stands alone — so the
 * sinks are exactly the two leaves and `build` is the node no verdict may
 * touch.
 */
import { describe, expect, it } from "@effect/vitest"
import { Journal } from "@smthrs/journal"
import { Jj } from "@smthrs/kernel"
import { KeyMaterial, Plan } from "@smthrs/plan"
import { type Ownership, RunStore } from "@smthrs/run-store"
import { CacheStore } from "@smthrs/step-cache"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { vi } from "vitest"
import * as JournalRecords from "../src/internal/JournalRecords.ts"
import * as PlanScheduler from "../src/PlanScheduler.ts"
import * as Selection from "../src/Selection.ts"
import * as StepBoundary from "../src/StepBoundary.ts"
import * as TestStores from "../src/test/TestStores.ts"
import { sha256, withCrypto } from "./Sha256.ts"

const owner: Ownership.OwnerId = { hostId: "selection-host", pid: 47, nonce: "selection-process" }

const jjLayer = Layer.succeed(
  Jj.Jj,
  Jj.make({
    snapshot: () => Effect.succeed({ changeId: "selection-snapshot" as never }),
    restore: () => Effect.void,
    diff: () => Effect.succeed(""),
    workspaceAdd: () => Effect.void,
    workspaceForget: () => Effect.void,
    status: () => Effect.succeed("")
  })
)

interface DraftOptions {
  readonly inputs?: ReadonlyArray<KeyMaterial.InputRef>
}

const draft = (id: string, options: DraftOptions = {}): Plan.NodeDraft => ({
  id,
  material: {
    version: KeyMaterial.version,
    kind: "sealed",
    body: { action: id },
    inputs: options.inputs ?? [],
    layers: [],
    capabilities: []
  },
  effects: {
    reads: [],
    writes: [`${id}.out`],
    boundaryMode: "hard"
  }
})

/**
 * The spec's worked example: `engine-tests` consumes `build`, so the sinks
 * are `engine-tests` and `lint-docs` and the one non-sink is `build`.
 */
const reviewGraph = () => [
  draft("build"),
  draft("engine-tests", { inputs: [{ _tag: "Pending", from: "build" }] }),
  draft("lint-docs")
]

const compile = (nodes: ReadonlyArray<Plan.NodeDraft>) =>
  Plan.compile({ planId: "plan-1", flow: "example/Review", nodes })

const activate = (runId: string) =>
  Effect.gen(function*() {
    const runs = yield* RunStore.RunStore
    yield* runs.create(runId, "{}")
    const row = yield* runs.get(runId)
    const snapshot = { status: row.status, owner: row.owner, heartbeatAtMs: row.heartbeatAtMs }
    const claim = yield* runs.claim(runId, snapshot, owner, 1)
    /* v8 ignore next */
    if (claim._tag !== "Claimed") return yield* Effect.die(new Error("claim lost"))
    const activated = yield* runs.activate(runId, owner, claim.claimedAtMs, snapshot)
    /* v8 ignore next */
    if (activated._tag !== "Activated") return yield* Effect.die(new Error("activation lost"))
  })

const outcomes = (report: PlanScheduler.Report): Record<string, PlanScheduler.Outcome> =>
  Object.fromEntries(report.settlements.map((settlement) => [settlement.nodeId, settlement.outcome]))

const edge = (overrides: Partial<Selection.SuspectedEdge> = {}): Selection.SuspectedEdge => ({
  scope: "packages/smithers/flows/engine/**",
  affects: "lint-docs",
  confidence: 0.03,
  validFromMs: 0,
  evidence: ["merges:41-of-50"],
  ...overrides
})

const beliefs = (...edges: Array<Selection.SuspectedEdge>): Selection.BeliefSnapshot => ({
  pinnedAtMs: 1_000,
  edges
})

const changed = ["packages/smithers/flows/engine/src/PlanScheduler.ts"]

const policy: Selection.Policy = { deferBelow: 0.05 }

interface Harness {
  readonly executor: PlanScheduler.Executor
  readonly selection?: Layer.Layer<Selection.Selection> | undefined
}

const harness = (options: Harness) =>
  Layer.mergeAll(
    StepBoundary.layerTest(),
    jjLayer,
    PlanScheduler.layerExecutor(options.executor),
    ...(options.selection === undefined ? [] : [options.selection])
  )

interface DriveOptions {
  readonly runId: string
  readonly selection?: Layer.Layer<Selection.Selection> | undefined
  readonly options?: PlanScheduler.Options["selection"] | undefined
  /** Dispatch keys to probe the cache for, beyond the settlements' own. */
  readonly probe?: ReadonlyArray<string> | undefined
}

/**
 * Drives the plan in a fresh store bundle and returns everything the laws
 * assert on: outcomes, dispatch keys, the cache rows those keys address, the
 * executed node ids, and the run's journal. Bundles are isolated, and every
 * fixture in them is deterministic, so two drives of the same plan are
 * comparable byte for byte — which is exactly what law 1 asserts.
 */
const drive = (plan: Plan.Plan, options: DriveOptions) =>
  Effect.gen(function*() {
    const executed: Array<string> = []
    const executor: PlanScheduler.Executor = {
      execute: ({ node }) =>
        Effect.sync(() => {
          executed.push(node.id)
          return { ran: node.id }
        })
    }
    yield* activate(options.runId)
    const service = PlanScheduler.make({
      runId: options.runId,
      owner,
      sourceId: `scheduler/${options.runId}`,
      ...(options.options === undefined ? {} : { selection: options.options })
    })
    const report = yield* Effect.provide(
      service.run(plan),
      harness({ executor, selection: options.selection })
    )
    const cache = yield* CacheStore.CacheStore
    const rows: Record<string, { keyDigest: string; result: unknown } | null> = {}
    for (const settlement of report.settlements) {
      if (settlement.dispatchKey === "") {
        rows[settlement.nodeId] = null
        continue
      }
      const row = yield* cache.get(sha256(settlement.dispatchKey))
      rows[settlement.nodeId] = Option.isNone(row)
        ? null
        : { keyDigest: row.value.keyDigest, result: row.value.result }
    }
    const probed: Record<string, boolean> = {}
    for (const key of options.probe ?? []) {
      probed[key] = Option.isSome(yield* cache.get(sha256(key)))
    }
    const events = yield* JournalRecords.entries(options.runId, undefined, 512)
    return { events: events.entries, executed, probed, report, rows }
  }).pipe(Effect.provide(TestStores.layer()))

describe("Selection laws through the scheduler", () => {
  it.effect("changes nothing when nobody opted in — no layer, no options, no selection records", () =>
    Effect.gen(function*() {
      const plan = yield* withCrypto(compile(reviewGraph()))
      const result = yield* withCrypto(drive(plan, { runId: "run-default" }))
      expect(outcomes(result.report)).toEqual({ build: "built", "engine-tests": "built", "lint-docs": "built" })
      expect(result.events.some((entry) => entry.eventType.startsWith("flows.engine.selection-"))).toBe(false)
    }))

  it.effect("law 1: admitted work is byte-identical under layerNoop and layerHeuristic — same keys, same cache rows", () =>
    Effect.gen(function*() {
      const plan = yield* withCrypto(compile(reviewGraph()))
      // Confidence 0.9 clears the threshold, so the heuristic admits the sink
      // the edge names: both drives must produce the same everything.
      const selection = { changed, beliefs: beliefs(edge({ confidence: 0.9 })), policy }
      const noop = yield* withCrypto(
        drive(plan, { runId: "run-law1-noop", selection: Selection.layerNoop, options: selection })
      )
      const heuristic = yield* withCrypto(
        drive(plan, { runId: "run-law1-heuristic", selection: Selection.layerHeuristic, options: selection })
      )
      expect(outcomes(noop.report)).toEqual({ build: "built", "engine-tests": "built", "lint-docs": "built" })
      expect(outcomes(heuristic.report)).toEqual(outcomes(noop.report))
      const keys = (report: PlanScheduler.Report) =>
        Object.fromEntries(report.settlements.map((settlement) => [settlement.nodeId, settlement.dispatchKey]))
      expect(keys(heuristic.report)).toEqual(keys(noop.report))
      expect(Object.values(noop.rows).every((row) => row !== null)).toBe(true)
      expect(heuristic.rows).toEqual(noop.rows)
    }))

  it.effect("law 2: deferred is not passed — no execution, no cache row, a journaled debt distinct from skipped and clean", () =>
    Effect.gen(function*() {
      const plan = yield* withCrypto(compile(reviewGraph()))
      const selection = { changed, beliefs: beliefs(edge()), policy }
      // The control drive admits everything, which pins the dispatch key the
      // deferred node WOULD have been recorded under — keys are deterministic
      // across bundles, which is what law 1 just proved.
      const control = yield* withCrypto(drive(plan, { runId: "run-law2-control", options: selection }))
      expect(outcomes(control.report)).toEqual({ build: "built", "engine-tests": "built", "lint-docs": "built" })
      const lintKey = control.report.settlements.find((settlement) => settlement.nodeId === "lint-docs")!.dispatchKey
      expect(control.rows["lint-docs"]).not.toBeNull()

      const deferred = yield* withCrypto(
        drive(plan, {
          runId: "run-law2-defer",
          selection: Selection.layerHeuristic,
          options: selection,
          probe: [lintKey]
        })
      )
      expect(outcomes(deferred.report)).toEqual({ build: "built", "engine-tests": "built", "lint-docs": "deferred" })
      expect(deferred.executed).not.toContain("lint-docs")
      expect(deferred.report.settlements.find((settlement) => settlement.nodeId === "lint-docs")).toMatchObject({
        attempts: 0,
        dispatchKey: "",
        outcome: "deferred"
      })
      // No cache row under the key the work would have carried: the deferral
      // wrote nothing the cache could ever serve as passed.
      expect(deferred.probed[lintKey]).toBe(false)
      const debts = deferred.events.filter((entry) => entry.eventType === "flows.engine.selection-deferred")
      expect(debts).toHaveLength(1)
      expect(debts[0]?.payload).toMatchObject({
        edge: { affects: "lint-docs", scope: "packages/smithers/flows/engine/**" },
        likelihood: 0.03,
        nodeId: "lint-docs",
        planKey: plan.nodes.find((node) => node.id === "lint-docs")!.key
      })
    }))

  it.effect("law 3: only sinks are offered, and a verdict naming a non-sink is ignored and journaled", () =>
    Effect.gen(function*() {
      const plan = yield* withCrypto(compile(reviewGraph()))
      const offered: Array<ReadonlyArray<Selection.Candidate>> = []
      // A rogue selector: it records what it was offered, then defers `build`,
      // which the plan needs — the law says the guess cannot remove it —
      // proposes a node the plan already contains, and proposes the plan's own
      // flow name, which `present` also accounts for.
      const rogue = Selection.layer(Selection.make({
        select: (input) =>
          Effect.sync(() => {
            offered.push(input.sinks)
            const verdicts: Array<Selection.Selected> = [
              { nodeId: "build", verdict: { _tag: "Defer", edge: edge({ affects: "build" }), likelihood: 0.01 } },
              {
                nodeId: "build",
                verdict: { _tag: "Propose", flow: "build", edge: edge({ affects: "build" }), confidence: 0.5 }
              },
              {
                nodeId: "example/Review",
                verdict: {
                  _tag: "Propose",
                  flow: "example/Review",
                  edge: edge({ affects: "example/Review" }),
                  confidence: 0.5
                }
              },
              ...input.sinks.map((candidate): Selection.Selected => ({
                nodeId: candidate.nodeId,
                verdict: { _tag: "Admit" }
              }))
            ]
            return verdicts
          })
      }))
      const result = yield* withCrypto(
        drive(plan, { runId: "run-law3", selection: rogue, options: { changed, beliefs: beliefs(), policy } })
      )
      expect(offered).toHaveLength(1)
      expect(offered[0]!.map((candidate) => candidate.nodeId)).toEqual(["engine-tests", "lint-docs"])
      expect(outcomes(result.report)).toEqual({ build: "built", "engine-tests": "built", "lint-docs": "built" })
      const observations = result.events.filter((entry) => entry.eventType === "flows.engine.selection-inconsistent")
      expect(observations).toHaveLength(3)
      expect(observations[0]?.payload).toMatchObject({
        nodeId: "build",
        reason: "not-a-deferrable-sink",
        verdict: "Defer"
      })
      expect(observations[1]?.payload).toMatchObject({
        nodeId: "build",
        reason: "proposes-a-present-node",
        verdict: "Propose"
      })
      expect(observations[2]?.payload).toMatchObject({
        nodeId: "example/Review",
        reason: "proposes-a-present-node",
        verdict: "Propose"
      })
      expect(result.events.some((entry) => entry.eventType === "flows.engine.selection-proposed")).toBe(false)
    }))

  it.effect("law 4: the full override restores full execution and journals itself", () =>
    Effect.gen(function*() {
      const plan = yield* withCrypto(compile(reviewGraph()))
      const result = yield* withCrypto(
        drive(plan, {
          runId: "run-law4-full",
          selection: Selection.layerHeuristic,
          options: { changed, beliefs: beliefs(edge()), policy, full: true }
        })
      )
      expect(outcomes(result.report)).toEqual({ build: "built", "engine-tests": "built", "lint-docs": "built" })
      expect(result.events.some((entry) => entry.eventType === "flows.engine.selection-overridden")).toBe(true)
      expect(result.events.some((entry) => entry.eventType === "flows.engine.selection-deferred")).toBe(false)
    }))

  it.effect("journals a proposal for a flow the plan cannot see, and appends nothing", () =>
    Effect.gen(function*() {
      const plan = yield* withCrypto(compile(reviewGraph()))
      const result = yield* withCrypto(
        drive(plan, {
          runId: "run-propose",
          selection: Selection.layerHeuristic,
          options: { changed, beliefs: beliefs(edge({ affects: "update-engine-docs", confidence: 0.82 })), policy }
        })
      )
      expect(outcomes(result.report)).toEqual({ build: "built", "engine-tests": "built", "lint-docs": "built" })
      expect(result.report.appended).toEqual([])
      const proposals = result.events.filter((entry) => entry.eventType === "flows.engine.selection-proposed")
      expect(proposals).toHaveLength(1)
      expect(proposals[0]?.payload).toMatchObject({
        confidence: 0.82,
        edge: { scope: "packages/smithers/flows/engine/**" },
        flow: "update-engine-docs"
      })
    }))
})

describe("Selection.layerHeuristic", () => {
  const heuristic = Selection.makeHeuristic()

  const input = (overrides: Partial<Selection.Input> = {}): Selection.Input => ({
    changed,
    sinks: [{ nodeId: "lint-docs", planKey: "key-lint" }],
    present: ["example/Review", "build", "engine-tests", "lint-docs"],
    beliefs: beliefs(edge()),
    policy,
    ...overrides
  })

  it.effect("defers a sink whose best likelihood is below the threshold", () =>
    Effect.gen(function*() {
      const verdicts = yield* withCrypto(heuristic.select(input()))
      expect(verdicts).toEqual([{
        nodeId: "lint-docs",
        verdict: { _tag: "Defer", edge: edge(), likelihood: 0.03 }
      }])
    }))

  it.effect("admits at exactly deferBelow — the threshold is strict", () =>
    Effect.gen(function*() {
      const verdicts = yield* withCrypto(heuristic.select(input({ beliefs: beliefs(edge({ confidence: 0.05 })) })))
      expect(verdicts).toEqual([{ nodeId: "lint-docs", verdict: { _tag: "Admit" } }])
    }))

  it.effect("admits a sink no live edge names", () =>
    Effect.gen(function*() {
      const verdicts = yield* withCrypto(
        heuristic.select(input({ beliefs: beliefs(edge({ affects: "engine-tests" })) }))
      )
      expect(verdicts).toEqual([{ nodeId: "lint-docs", verdict: { _tag: "Admit" } }])
    }))

  it.effect("judges by the BEST likelihood among matching edges", () =>
    Effect.gen(function*() {
      const confident = yield* withCrypto(heuristic.select(input({
        beliefs: beliefs(edge({ confidence: 0.02 }), edge({ confidence: 0.9 }))
      })))
      expect(confident).toEqual([{ nodeId: "lint-docs", verdict: { _tag: "Admit" } }])
      const timid = yield* withCrypto(heuristic.select(input({
        beliefs: beliefs(edge({ confidence: 0.02 }), edge({ confidence: 0.04 }), edge({ confidence: 0.01 }))
      })))
      expect(timid).toEqual([{
        nodeId: "lint-docs",
        verdict: { _tag: "Defer", edge: edge({ confidence: 0.04 }), likelihood: 0.04 }
      }])
    }))

  it.effect("matches scopes as path globs — `**` crosses separators, `*` and `?` do not", () =>
    Effect.gen(function*() {
      const verdictFor = (scope: string) =>
        Effect.gen(function*() {
          return (yield* withCrypto(heuristic.select(input({ beliefs: beliefs(edge({ scope })) }))))[0]!.verdict._tag
        })
      // The changed path is packages/smithers/flows/engine/src/PlanScheduler.ts throughout: a
      // matching scope makes the low-confidence edge live, which defers.
      expect(yield* verdictFor("packages/smithers/flows/engine/**")).toBe("Defer")
      // One `*` per directory level, because `*` is what this cell proves does
      // not cross a separator: the changed path is three levels under `packages/`.
      expect(yield* verdictFor("packages/*/*/*/src/PlanScheduler.ts")).toBe("Defer")
      expect(yield* verdictFor("packages/smithers/flows/engine/src/PlanScheduler.t?")).toBe("Defer")
      expect(yield* verdictFor("packages/smithers/flows/engine/src/PlanScheduler.ts")).toBe("Defer")
      expect(yield* verdictFor("packages/*.ts")).toBe("Admit")
      expect(yield* verdictFor("packages/smithers/flows/engine/src")).toBe("Admit")
    }))

  it.effect("ignores an edge that is not yet valid at the snapshot's pin", () =>
    Effect.gen(function*() {
      const verdicts = yield* withCrypto(heuristic.select(input({
        beliefs: beliefs(edge({ validFromMs: 5_000 }), edge({ affects: "docs-only", validFromMs: 5_000 }))
      })))
      expect(verdicts).toEqual([{ nodeId: "lint-docs", verdict: { _tag: "Admit" } }])
    }))

  it.effect("proposes a flow the plan does not contain, once, under the highest-confidence edge", () =>
    Effect.gen(function*() {
      const verdicts = yield* withCrypto(heuristic.select(input({
        beliefs: beliefs(
          edge({ affects: "update-engine-docs", confidence: 0.2 }),
          edge({ affects: "update-engine-docs", confidence: 0.7 }),
          edge({ affects: "update-engine-docs", confidence: 0.4 })
        )
      })))
      expect(verdicts).toEqual([
        { nodeId: "lint-docs", verdict: { _tag: "Admit" } },
        {
          nodeId: "update-engine-docs",
          verdict: {
            _tag: "Propose",
            confidence: 0.7,
            edge: edge({ affects: "update-engine-docs", confidence: 0.7 }),
            flow: "update-engine-docs"
          }
        }
      ])
    }))

  it.effect("never proposes a name the plan already accounts for", () =>
    Effect.gen(function*() {
      const verdicts = yield* withCrypto(heuristic.select(input({
        beliefs: beliefs(edge({ affects: "build", confidence: 0.9 }), edge({ affects: "example/Review" }))
      })))
      expect(verdicts).toEqual([{ nodeId: "lint-docs", verdict: { _tag: "Admit" } }])
    }))
})

describe("Selection.Verdict", () => {
  const decode = Schema.decodeUnknownOption(Selection.Verdict)

  it("refines Defer.likelihood to [0, 1], symmetric with Propose.confidence", () => {
    const within = decode({ _tag: "Defer", edge: edge(), likelihood: 0.5 })
    expect(Option.isSome(within)).toBe(true)
    const above = decode({ _tag: "Defer", edge: edge(), likelihood: 1.5 })
    expect(Option.isNone(above)).toBe(true)
    const below = decode({ _tag: "Defer", edge: edge(), likelihood: -0.1 })
    expect(Option.isNone(below)).toBe(true)
  })
})

describe("Selection.debt", () => {
  it.effect("round-trips: a deferral is owed until the run's guess-free full pass repays it", () =>
    Effect.gen(function*() {
      const plan = yield* withCrypto(compile(reviewGraph()))
      const executor: PlanScheduler.Executor = { execute: ({ node }) => Effect.succeed({ ran: node.id }) }
      const program = Effect.gen(function*() {
        yield* activate("run-debt")
        const guessing = PlanScheduler.make({
          runId: "run-debt",
          owner,
          sourceId: "scheduler/run-debt",
          selection: { changed, beliefs: beliefs(edge()), policy }
        })
        const first = yield* Effect.provide(
          guessing.run(plan),
          harness({ executor, selection: Selection.layerHeuristic })
        )
        const owedAfterFirst = yield* Selection.debt("run-debt")
        // The follow-up is the guess-free full pass: same run, same plan,
        // selection forced full. Cached branches stay clean; only the debt runs.
        const repaying = PlanScheduler.make({
          runId: "run-debt",
          owner,
          sourceId: "scheduler/run-debt-full",
          selection: { changed, beliefs: beliefs(edge()), policy, full: true }
        })
        const second = yield* Effect.provide(
          repaying.run(plan),
          harness({ executor, selection: Selection.layerHeuristic })
        )
        const owedAfterSecond = yield* Selection.debt("run-debt")
        const events = yield* JournalRecords.entries("run-debt", undefined, 512)
        const recordedAt = events.entries.find((entry) => entry.eventType === "flows.engine.selection-deferred")!.seq
        return { first, owedAfterFirst, owedAfterSecond, recordedAt, second }
      }).pipe(Effect.provide(TestStores.layer()))

      const { first, owedAfterFirst, owedAfterSecond, recordedAt, second } = yield* withCrypto(program)
      expect(outcomes(first)).toEqual({ build: "built", "engine-tests": "built", "lint-docs": "deferred" })
      expect(owedAfterFirst).toHaveLength(1)
      expect(owedAfterFirst[0]).toMatchObject({
        edge: { affects: "lint-docs" },
        likelihood: 0.03,
        nodeId: "lint-docs",
        planId: "plan-1",
        planKey: plan.nodes.find((node) => node.id === "lint-docs")!.key
      })
      // The provenance points at the journal record itself.
      expect(owedAfterFirst[0]!.seq).toBe(recordedAt)
      expect(outcomes(second)).toEqual({ build: "clean", "engine-tests": "clean", "lint-docs": "built" })
      expect(owedAfterSecond).toEqual([])
    }))

  it.effect("folds one run only: a settlement under another runId does not repay", () =>
    Effect.gen(function*() {
      // Repayment is same-run: the fold reads one run's journal, so the same
      // planKey settled `built` under a different runId leaves the debt open.
      const plan = yield* withCrypto(compile(reviewGraph()))
      const executor: PlanScheduler.Executor = { execute: ({ node }) => Effect.succeed({ ran: node.id }) }
      const program = Effect.gen(function*() {
        yield* activate("run-debt-owing")
        yield* activate("run-debt-foreign")
        const guessing = PlanScheduler.make({
          runId: "run-debt-owing",
          owner,
          sourceId: "scheduler/run-debt-owing",
          selection: { changed, beliefs: beliefs(edge()), policy }
        })
        yield* Effect.provide(guessing.run(plan), harness({ executor, selection: Selection.layerHeuristic }))
        const journal = yield* Journal.Journal
        yield* journal.emitDurable(
          JournalRecords.nodeSettled(
            { runId: "run-debt-foreign", lineageId: "run-debt-foreign/root", sourceId: "scheduler/run-debt-foreign" },
            { planKey: plan.nodes.find((node) => node.id === "lint-docs")!.key, outcome: "built" }
          ),
          owner
        )
        return yield* Selection.debt("run-debt-owing")
      }).pipe(Effect.provide(TestStores.layer()))
      const owed = yield* withCrypto(program)
      expect(owed).toHaveLength(1)
      expect(owed[0]).toMatchObject({ nodeId: "lint-docs" })
    }))

  it.effect("skips records it cannot decode and reads past the first page of the journal", () =>
    Effect.gen(function*() {
      // The fold reads the journal a page at a time, and nothing follows it to
      // pick up a deferral a single page left behind — so filler records push
      // the only real one past page one, and malformed records of both event
      // types prove an undecodable payload is skipped, not a crash.
      const plan = yield* withCrypto(compile(reviewGraph()))
      const executor: PlanScheduler.Executor = { execute: ({ node }) => Effect.succeed({ ran: node.id }) }
      const program = Effect.gen(function*() {
        yield* activate("run-debt-paged")
        const journal = yield* Journal.Journal
        const at = (sourceId: string) => ({ runId: "run-debt-paged", lineageId: "run-debt-paged/root", sourceId })
        yield* Effect.forEach(
          Array.from({ length: 600 }, (_, index) => index),
          (index) => journal.emitDurable(JournalRecords.runDecision(at(`filler/${index}`), { index }), owner),
          { discard: true }
        )
        yield* journal.emitDurable(JournalRecords.selectionDeferred(at("malformed/deferred"), {}), owner)
        yield* journal.emitDurable(JournalRecords.nodeSettled(at("malformed/settled"), {}), owner)
        const service = PlanScheduler.make({
          runId: "run-debt-paged",
          owner,
          sourceId: "scheduler/run-debt-paged",
          selection: { changed, beliefs: beliefs(edge()), policy }
        })
        yield* Effect.provide(service.run(plan), harness({ executor, selection: Selection.layerHeuristic }))
        return yield* Selection.debt("run-debt-paged")
      }).pipe(Effect.provide(TestStores.layer()))
      const owed = yield* withCrypto(program)
      expect(owed).toHaveLength(1)
      expect(owed[0]).toMatchObject({ nodeId: "lint-docs" })
    }))

  it.effect("law 6: repaidBy is a pure widening — a listed run's real settlement closes, a skipped one does not", () =>
    Effect.gen(function*() {
      const plan = yield* withCrypto(compile(reviewGraph()))
      const executor: PlanScheduler.Executor = { execute: ({ node }) => Effect.succeed({ ran: node.id }) }
      const program = Effect.gen(function*() {
        yield* activate("run-debt-widen")
        yield* activate("run-recert-skip")
        yield* activate("run-recert-real")
        const guessing = PlanScheduler.make({
          runId: "run-debt-widen",
          owner,
          sourceId: "scheduler/run-debt-widen",
          selection: { changed, beliefs: beliefs(edge()), policy }
        })
        yield* Effect.provide(guessing.run(plan), harness({ executor, selection: Selection.layerHeuristic }))
        const journal = yield* Journal.Journal
        const lintKey = plan.nodes.find((node) => node.id === "lint-docs")!.key
        const at = (runId: string, sourceId: string) => ({ runId, lineageId: `${runId}/root`, sourceId })
        // A repaying run that only *skipped* the work has not repaid it.
        yield* journal.emitDurable(
          JournalRecords.nodeSettled(at("run-recert-skip", "scheduler/run-recert-skip"), {
            planKey: lintKey,
            outcome: "skipped"
          }),
          owner
        )
        // A repaying run's own deferral records are opens, and a repayment fold
        // must never read them as new debt for the deferring run.
        yield* journal.emitDurable(
          JournalRecords.selectionDeferred(at("run-recert-real", "selection/foreign-deferred"), {
            planId: "plan-other",
            nodeId: "other-node",
            planKey: "key-other",
            edge: edge(),
            likelihood: 0.01
          }),
          owner
        )
        yield* journal.emitDurable(
          JournalRecords.nodeSettled(at("run-recert-real", "scheduler/run-recert-real"), {
            planKey: lintKey,
            outcome: "built"
          }),
          owner
        )
        const sameRun = yield* Selection.debt("run-debt-widen")
        const skippedOnly = yield* Selection.debt("run-debt-widen", { repaidBy: ["run-recert-skip"] })
        const repaid = yield* Selection.debt("run-debt-widen", { repaidBy: ["run-recert-real"] })
        return { repaid, sameRun, skippedOnly }
      }).pipe(Effect.provide(TestStores.layer()))
      const { repaid, sameRun, skippedOnly } = yield* withCrypto(program)
      // The v1 same-run fold is untouched by the widening.
      expect(sameRun).toHaveLength(1)
      expect(skippedOnly).toHaveLength(1)
      expect(repaid).toEqual([])
    }))
})

describe("PlanScheduler.recertify", () => {
  it.effect("re-drives the plan guess-free under a fresh run and reports the drained debt", () =>
    Effect.gen(function*() {
      const plan = yield* withCrypto(compile(reviewGraph()))
      const executor: PlanScheduler.Executor = { execute: ({ node }) => Effect.succeed({ ran: node.id }) }
      const program = Effect.gen(function*() {
        yield* activate("run-recert-a")
        yield* activate("run-recert-b")
        const guessing = PlanScheduler.make({
          runId: "run-recert-a",
          owner,
          sourceId: "scheduler/run-recert-a",
          selection: { changed, beliefs: beliefs(edge()), policy }
        })
        const first = yield* Effect.provide(
          guessing.run(plan),
          harness({ executor, selection: Selection.layerHeuristic })
        )
        const result = yield* Effect.provide(
          PlanScheduler.recertify({
            plan,
            deferringRunId: "run-recert-a",
            options: {
              runId: "run-recert-b",
              owner,
              sourceId: "scheduler/run-recert-b",
              selection: { changed, beliefs: beliefs(edge()), policy }
            }
          }),
          harness({ executor, selection: Selection.layerHeuristic })
        )
        const deferringStillOpenAlone = yield* Selection.debt("run-recert-a")
        const overridden = yield* JournalRecords.entries("run-recert-b", undefined, 512)
        return { deferringStillOpenAlone, first, overridden: overridden.entries, result }
      }).pipe(Effect.provide(TestStores.layer()))
      const { deferringStillOpenAlone, first, overridden, result } = yield* withCrypto(program)
      expect(outcomes(first)).toEqual({ build: "built", "engine-tests": "built", "lint-docs": "deferred" })
      expect(result.runId).toBe("run-recert-b")
      // Guess-free by construction: the repaying run journals the override.
      expect(overridden.some((entry) => entry.eventType === "flows.engine.selection-overridden")).toBe(true)
      expect(outcomes(result.report)).toEqual({ build: "clean", "engine-tests": "clean", "lint-docs": "built" })
      expect(result.remaining).toEqual([])
      // The deferring run's own journal was never written: same-run debt stays open.
      expect(deferringStillOpenAlone).toHaveLength(1)
    }))
})

describe("Selection.card", () => {
  it("renders the spec's row grammar exactly", () => {
    const lines = Selection.card({
      settlements: [
        { nodeId: "read-pr", outcome: "clean" },
        { nodeId: "run-tests", outcome: "built" },
        { nodeId: "lint-docs", outcome: "deferred" },
        { nodeId: "flaky", outcome: "failed" }
      ],
      deferrals: [{ nodeId: "lint-docs", likelihood: 0.03 }],
      proposals: [{ flow: "update-engine-docs", confidence: 0.81, scope: "packages/smithers/flows/engine/src/**" }],
      cadence: "nightly",
      risk: { level: "medium", reasons: ["packages/smithers/flows/kernel/** -> security-review (0.5)"] }
    })
    expect(lines).toEqual([
      "  cached    read-pr",
      "  run       run-tests",
      "  deferred  lint-docs    fail likelihood 0.03 - recert nightly",
      "  failed    flaky",
      "  proposed  update-engine-docs    suspected edge 0.81 - packages/smithers/flows/engine/src/** touched",
      "  risk      medium - packages/smithers/flows/kernel/** -> security-review (0.5)"
    ])
  })

  it("omits the risk line when no annotation is passed and defaults an unmatched deferral to zero", () => {
    const lines = Selection.card({
      settlements: [{ nodeId: "lint-docs", outcome: "deferred" }],
      deferrals: [],
      proposals: [],
      cadence: "per-merge"
    })
    expect(lines).toEqual(["  deferred  lint-docs    fail likelihood 0 - recert per-merge"])
  })
})

describe("Selection.risk", () => {
  const changedEngine = ["packages/smithers/flows/engine/src/PlanScheduler.ts"]

  it("levels sit on the pinned boundaries: 0.4 opens medium, 0.7 opens high", () => {
    const at = (confidence: number) =>
      Selection.risk({ changed: changedEngine, beliefs: beliefs(edge({ confidence })) })
    expect(at(0.39).level).toBe("low")
    expect(at(0.4).level).toBe("medium")
    expect(at(0.69).level).toBe("medium")
    expect(at(0.7).level).toBe("high")
  })

  it("names each contributing edge and excludes non-matching or not-yet-valid ones", () => {
    const annotated = Selection.risk({
      changed: changedEngine,
      beliefs: beliefs(
        edge({ confidence: 0.8 }),
        edge({ affects: "security-review", confidence: 0.5, scope: "packages/smithers/flows/kernel/**" }),
        edge({ affects: "future", confidence: 0.99, validFromMs: 2_000 })
      )
    })
    expect(annotated.level).toBe("high")
    expect(annotated.reasons).toEqual(["packages/smithers/flows/engine/** -> lint-docs (0.8)"])
    const quiet = Selection.risk({ changed: ["docs/README.md"], beliefs: beliefs(edge()) })
    expect(quiet).toEqual({ level: "low", reasons: [] })
  })
})

describe("Selection.proposeReadSet", () => {
  it("selects matching workspace paths for the flow's live edges, deduplicated, in input order", () => {
    const selected = Selection.proposeReadSet({
      beliefs: beliefs(
        edge({ affects: "update-engine-docs", scope: "packages/smithers/flows/engine/src/**" }),
        edge({ affects: "other-flow", scope: "docs/**" }),
        edge({ affects: "update-engine-docs", scope: "packages/smithers/flows/plan/**", validFromMs: 2_000 })
      ),
      flow: "update-engine-docs",
      paths: [
        "packages/smithers/flows/engine/src/PlanScheduler.ts",
        "docs/pages/selection.md",
        "packages/smithers/flows/engine/src/PlanScheduler.ts",
        "packages/smithers/flows/plan/src/Plan.ts",
        "packages/smithers/flows/engine/src/Selection.ts"
      ]
    })
    expect(selected).toEqual([
      "packages/smithers/flows/engine/src/PlanScheduler.ts",
      "packages/smithers/flows/engine/src/Selection.ts"
    ])
  })
})

describe("Selection.layerHeuristic stats", () => {
  const heuristic = Selection.makeHeuristic()

  const input = (sinks: Selection.Input["sinks"], overrides: Partial<Selection.Input> = {}): Selection.Input => ({
    changed,
    sinks,
    present: ["example/Review", "build", "engine-tests", "lint-docs"],
    beliefs: beliefs(edge()),
    policy,
    ...overrides
  })

  it.effect("failure history keeps a flaky sink from being deferred", () =>
    Effect.gen(function*() {
      const verdicts = yield* withCrypto(
        heuristic.select(input([{ nodeId: "lint-docs", planKey: "key-lint", stats: { failures: 1, runs: 2 } }]))
      )
      expect(verdicts).toEqual([{ nodeId: "lint-docs", verdict: { _tag: "Admit" } }])
    }))

  it.effect("a zero failure rate leaves the edge's likelihood in charge", () =>
    Effect.gen(function*() {
      const verdicts = yield* withCrypto(
        heuristic.select(input([{ nodeId: "lint-docs", planKey: "key-lint", stats: { failures: 0, runs: 5 } }]))
      )
      expect(verdicts).toEqual([{
        nodeId: "lint-docs",
        verdict: { _tag: "Defer", edge: edge(), likelihood: 0.03 }
      }])
    }))

  it.effect("stats alone never defer: a sink no live edge names is admitted whatever its history", () =>
    Effect.gen(function*() {
      const verdicts = yield* withCrypto(
        heuristic.select(
          input([{ nodeId: "engine-tests", planKey: "key-tests", stats: { failures: 9, runs: 9 } }])
        )
      )
      expect(verdicts).toEqual([{ nodeId: "engine-tests", verdict: { _tag: "Admit" } }])
    }))
})

describe("Selection scope matching", () => {
  for (
    const [scope, paths, expected] of [
      ["src/**", ["src/a.ts", "src/nested/b.ts", "beside/a.ts", "x/src/a.ts"], ["src/a.ts", "src/nested/b.ts"]],
      ["src/*.ts", ["src/a.ts", "src/nested/b.ts", "src/a.tsx"], ["src/a.ts"]],
      ["src/?.ts", ["src/a.ts", "src/ab.ts", "src//.ts"], ["src/a.ts"]],
      ["src/a[1]+(x).ts", ["src/a[1]+(x).ts", "src/a1x.ts"], ["src/a[1]+(x).ts"]],
      ["src/**/b.ts", ["src/x/b.ts", "src/x/y/b.ts", "src/b.ts", "src/x/b.tsx"], ["src/x/b.ts", "src/x/y/b.ts"]],
      ["**.md", ["a.md", "docs/x/a.md", "a.mdx"], ["a.md", "docs/x/a.md"]],
      ["src/***.ts", ["src/a.ts", "src/a/b.ts", "x/src/a.ts"], ["src/a.ts", "src/a/b.ts"]],
      ["src/*/*", ["src/a/b", "src/a", "src/a/b/c", "src//b"], ["src/a/b", "src//b"]]
    ] as const
  ) {
    it(`preserves glob and literal semantics for ${scope}`, () => {
      const snapshot = beliefs(edge({ scope }), edge({ scope }))
      expect(Selection.proposeReadSet({ beliefs: snapshot, flow: "lint-docs", paths: [...paths, ...paths] }))
        .toEqual(expected)
      for (const path of paths) {
        const matches = (expected as ReadonlyArray<string>).includes(path)
        expect(Selection.risk({ beliefs: snapshot, changed: [path] }).reasons).toHaveLength(matches ? 2 : 0)
        const selected = Effect.runSync(
          Selection.makeHeuristic().select({
            beliefs: snapshot,
            changed: [path],
            sinks: [{ nodeId: "lint-docs", planKey: "lint-key" }],
            present: ["lint-docs"],
            policy
          })
        )
        expect(selected[0]!.verdict._tag).toBe(matches ? "Defer" : "Admit")
      }
    })
  }

  for (const operation of ["risk", "select", "proposeReadSet"] as const) {
    it(`${operation} compiles each distinct eligible scope once per invocation at scale`, () => {
      const scopes = Array.from({ length: 250 }, (_, index) => `packages/p${index}/src/**`)
      const snapshot = beliefs(
        ...scopes.flatMap((scope) => [edge({ scope }), edge({ scope })]),
        edge({ scope: "future/**", validFromMs: 2_000 })
      )
      const paths = Array.from({ length: 500 }, (_, index) => `packages/unrelated${index}/src/index.ts`)
      const run = () => {
        if (operation === "risk") {
          expect(Selection.risk({ beliefs: snapshot, changed: paths })).toEqual({ level: "low", reasons: [] })
        } else if (operation === "proposeReadSet") {
          expect(Selection.proposeReadSet({ beliefs: snapshot, flow: "lint-docs", paths })).toEqual([])
        } else {
          expect(Effect.runSync(
            Selection.makeHeuristic().select({
              beliefs: snapshot,
              changed: paths,
              sinks: [{ nodeId: "lint-docs", planKey: "lint-key" }],
              present: ["lint-docs"],
              policy
            })
          )).toEqual([{ nodeId: "lint-docs", verdict: { _tag: "Admit" } }])
        }
      }
      // Each compilation starts by splitting the glob on **. Counting that
      // work catches per-path compilation without a machine-dependent timer.
      const split = vi.spyOn(String.prototype, "split")
      try {
        run()
        expect(split.mock.calls.filter(([separator]) => (separator as unknown) === "**")).toHaveLength(scopes.length)
        run()
        expect(split.mock.calls.filter(([separator]) => (separator as unknown) === "**")).toHaveLength(
          2 * scopes.length
        )
      } finally {
        split.mockRestore()
      }
    })
  }

  it("matches a many-wildcard scope in linear time, even one stored before the cap", () => {
    const scope = "**a".repeat(12) + "**b"
    const path = "a".repeat(40)
    const snapshot = beliefs(edge({ scope }))
    const started = performance.now()
    expect(Selection.risk({ beliefs: snapshot, changed: [path] }).reasons).toEqual([])
    expect(Selection.proposeReadSet({ beliefs: snapshot, flow: "lint-docs", paths: [path] })).toEqual([])
    expect(Selection.risk({ beliefs: snapshot, changed: [`${path}b`] }).reasons).toHaveLength(1)
    // The backtracking RegExp took minutes here; the linear matcher takes microseconds.
    expect(performance.now() - started).toBeLessThan(250)
  })

  it(`refuses a scope with more than ${Selection.maxScopeWildcards} * or ** wildcards at the schema`, () => {
    const decode = Schema.decodeUnknownExit(Selection.SuspectedEdge)
    expect(decode(edge({ scope: "**a".repeat(7) + "*" }))._tag).toBe("Success")
    expect(decode(edge({ scope: "**a".repeat(8) + "*" }))._tag).toBe("Failure")
    expect(decode(edge({ scope: "src/?/?/?/?/?/?/?/?/?.ts" }))._tag).toBe("Success")
  })
})

/**
 * The mapping from a driven graph's records to journal entries, and what the
 * store does when the journal refuses one.
 *
 * The mapping is pure and the refusal is not, so both are here: a record that
 * cannot be written is a fact about ownership or about the journal, and the
 * store's answer to each differs.
 */
import { FlowEngine } from "@smthrs/engine"
import type { FlowRuntime as FlowRuntimeTypes } from "@smthrs/flow"
import { Flow, FlowRuntime } from "@smthrs/flow"
import { Journal, JournalEvent } from "@smthrs/journal"
import { Jj } from "@smthrs/kernel"
import { RunStore } from "@smthrs/run-store"
import { Cause, Effect, Exit, Layer, Schema } from "effect"
import { describe, expect, it, vi } from "vitest"
import * as EngineStore from "../src/EngineStore.ts"
import * as NodeJournal from "../src/internal/NodeJournal.ts"
import * as StepBoundary from "../src/StepBoundary.ts"
import * as TestStores from "../src/test/TestStores.ts"
import { runPromise } from "./Sha256.ts"

const scope: NodeJournal.Scope = {
  runId: "run",
  sourceId: "host",
  lineageId: "lineage",
  root: "/repo"
}

const node = (id: string, extra: Partial<FlowRuntimeTypes.NodeSummary> = {}): FlowRuntimeTypes.NodeSummary => ({
  id,
  kind: "ActionCall",
  dependsOn: [],
  tier: "sealed",
  ...extra
})

describe("the records a driven graph makes, as journal entries", () => {
  it("addresses every record by its own source id, at sequence zero", () => {
    const records: ReadonlyArray<FlowRuntimeTypes.NodeRecord> = [
      {
        _tag: "PlanRecorded",
        sourceId: "plan/0/0",
        flow: "build",
        generation: 0,
        page: 0,
        pages: 2,
        nodeCount: 2,
        nodes: [node("read", { action: "fs/read" })],
        edges: [{ from: "read", to: "double", reason: "value" }]
      },
      {
        _tag: "SubgraphAppended",
        sourceId: "plan/0/1",
        flow: "build",
        generation: 0,
        page: 1,
        pages: 2,
        nodes: [node("double")],
        edges: []
      },
      { _tag: "NodeScheduled", sourceId: "node/read/1", nodeId: "read", kind: "ActionCall", attempt: 1 },
      {
        _tag: "NodeSettled",
        sourceId: "node/read/1/settled",
        nodeId: "read",
        outcome: "clean",
        attempts: 1,
        stepKeyDigests: ["a1"]
      }
    ]
    const entries = records.map((record) => NodeJournal.entry(scope, record))
    expect(entries.map((entry) => entry.sourceId)).toEqual([
      "host/plan/0/0",
      "host/plan/0/1",
      "host/node/read/1",
      "host/node/read/1/settled"
    ])
    expect(entries.every((entry) => entry.sourceSeq === 0)).toBe(true)
    expect(entries.map((entry) => entry.dedupe)).toEqual(["content", "identity", "identity", "identity"])
    expect(entries.map((entry) => entry.eventType)).toEqual([
      "flows.engine.plan-recorded",
      "flows.engine.subgraph-appended",
      "flows.engine.node-scheduled",
      "flows.engine.node-settled"
    ])
    const recorded = entries[0]!.payload as Record<string, unknown>
    // The COUNT of the whole graph, not of this page.
    expect(recorded["nodes"]).toBe(2)
    expect(recorded["graph"]).toEqual({
      nodes: [{ id: "read", kind: "ActionCall", dependsOn: [], tier: "sealed", action: "fs/read" }],
      edges: [{ from: "read", to: "double", reason: "value" }]
    })
    expect((entries[1]!.payload as Record<string, unknown>)["nodeIds"]).toEqual(["double"])
    expect(entries[3]!.payload).toEqual({
      nodeId: "read",
      outcome: "clean",
      attempts: 1,
      stepKeyDigests: ["a1"]
    })
  })

  it("names a tag and an effect declaration only where the node has one", () => {
    const entry = NodeJournal.entry(scope, {
      _tag: "PlanRecorded",
      sourceId: "plan/0/0",
      flow: "build",
      generation: 0,
      page: 0,
      pages: 1,
      nodeCount: 2,
      nodes: [
        node("join", { kind: "Map" }),
        node("read", { action: "fs/read", effects: { reads: ["a"], writes: [], boundaryMode: "hard" } })
      ],
      edges: []
    })
    const graph = (entry.payload as Record<string, unknown>)["graph"] as {
      readonly nodes: ReadonlyArray<Record<string, unknown>>
    }
    expect(graph.nodes[0]).toEqual({ id: "join", kind: "Map", dependsOn: [], tier: "sealed" })
    expect(graph.nodes[1]!["effects"]).toEqual({ reads: ["a"], writes: [], boundaryMode: "hard" })
  })

  it("takes the root the host names, and none where the host names none", () => {
    expect(NodeJournal.hostRoot("/explicit", { process: { cwd: () => "/cwd" } })).toBe("/explicit")
    expect(NodeJournal.hostRoot(undefined, { process: { cwd: () => "/cwd" } })).toBe("/cwd")
    // A worker and a browser have no process to ask, so nothing is recorded
    // rather than a path a reader would have to guess the meaning of.
    expect(NodeJournal.hostRoot(undefined, {})).toBeUndefined()
    expect(NodeJournal.hostRoot(undefined, { process: {} })).toBeUndefined()
  })

  it("records a declaration path relative to the root, and no path at all otherwise", () => {
    const site = (root: string | undefined, path: string) => {
      const entry = NodeJournal.entry({ ...scope, root }, {
        _tag: "SubgraphAppended",
        sourceId: "plan/0/1",
        flow: "build",
        generation: 0,
        page: 1,
        pages: 2,
        nodes: [node("read", { declaredAt: { path, line: 12 } })],
        edges: []
      })
      const graph = (entry.payload as Record<string, unknown>)["graph"] as {
        readonly nodes: ReadonlyArray<Record<string, unknown>>
      }
      return graph.nodes[0]!["declaredAt"]
    }
    expect(site("/repo", "/repo/src/Build.ts")).toEqual({ path: "src/Build.ts", line: 12 })
    expect(site("/repo/", "/repo/src/Build.ts")).toEqual({ path: "src/Build.ts", line: 12 })
    // A host that cannot say where its sources live, a path outside the root,
    // and the root itself all record nothing rather than an absolute path or
    // an empty one.
    expect(site(undefined, "/repo/src/Build.ts")).toBeUndefined()
    expect(site("/repo", "/elsewhere/src/Build.ts")).toBeUndefined()
    expect(site("/repo", "/repo/")).toBeUndefined()
    expect(site("/repo", "")).toBeUndefined()
  })

  /*
   * D-068: the root a path is stripped against and the revision that path's
   * bytes were read at are the same kind of fact — only the writer knows
   * them — so they travel together, on every page that carries sites.
   */
  it("names the revision the host read its sources at, on every page of the graph", () => {
    const pages = (sourceRevision: string | undefined) =>
      [
        {
          _tag: "PlanRecorded" as const,
          sourceId: "plan/0/0",
          flow: "build",
          generation: 0,
          page: 0,
          pages: 2,
          nodeCount: 2,
          nodes: [node("read", { declaredAt: { path: "/repo/src/Build.ts", line: 12 } })],
          edges: []
        },
        {
          _tag: "SubgraphAppended" as const,
          sourceId: "plan/0/1",
          flow: "build",
          generation: 0,
          page: 1,
          pages: 2,
          nodes: [node("double")],
          edges: []
        }
      ].map((record) =>
        ((NodeJournal.entry({ ...scope, ...(sourceRevision === undefined ? {} : { sourceRevision }) }, record)
          .payload as Record<string, unknown>)["graph"] as Record<string, unknown>)["sourceRevision"]
      )

    expect(pages("b".repeat(40))).toEqual(["b".repeat(40), "b".repeat(40)])
    /* A host served out of no version control names none, on every page. */
    expect(pages(undefined)).toEqual([undefined, undefined])
  })

  it("treats a filesystem root as no root, so a home directory never reaches a journal", () => {
    // `process.cwd()` is "/" for a launchd or Finder launched host, and a
    // root of "/" would make every absolute path "relative", publishing the
    // operator's home directory into a run's permanent history.
    expect(NodeJournal.relativePath("/", "/Users/operator/project/Build.ts")).toBeUndefined()
    expect(NodeJournal.relativePath("", "/Users/operator/project/Build.ts")).toBeUndefined()
    expect(NodeJournal.relativePath("C:/", "C:/Users/operator/project/Build.ts")).toBeUndefined()
    expect(NodeJournal.relativePath("C:", "C:/Users/operator/project/Build.ts")).toBeUndefined()
    const entry = NodeJournal.entry({ ...scope, root: "/" }, {
      _tag: "SubgraphAppended",
      sourceId: "plan/0/1",
      flow: "build",
      generation: 0,
      page: 1,
      pages: 2,
      nodes: [node("read", { declaredAt: { path: "/Users/operator/project/Build.ts", line: 12 } })],
      edges: []
    })
    const graph = (entry.payload as Record<string, unknown>)["graph"] as {
      readonly nodes: ReadonlyArray<Record<string, unknown>>
    }
    expect(graph.nodes[0]!["declaredAt"]).toBeUndefined()
  })
})

const jj = Layer.succeed(
  Jj.Jj,
  Jj.make({
    snapshot: () => Effect.succeed({ commitId: "test", changeId: "test" }),
    restore: () => Effect.void,
    diff: () => Effect.succeed(""),
    workspaceAdd: () => Effect.void,
    workspaceForget: () => Effect.void,
    status: () => Effect.succeed("")
  })
)

const Empty = Flow.make("node-journal/empty", { payload: {}, success: Schema.Number, body: () => undefined as never })

const scheduled: FlowRuntimeTypes.NodeRecord = {
  _tag: "NodeScheduled",
  sourceId: "node/read/1",
  nodeId: "read",
  kind: "ActionCall",
  attempt: 1
}

/**
 * Records one node against a store whose journal answers `failure`.
 *
 * The record is written into a run this store does not own, so the unrefused
 * path is not reachable here and is not asserted here: three real runs in
 * `InterpreterNodeJournal.test.ts` are the evidence for it. What this harness
 * isolates is the answer to a refusal, which a real run cannot stage.
 */
/**
 * Records `scheduled` against a journal that refuses node records with
 * `failure`, on whichever channel the engine writes them: queued with the
 * run's next write, or, from a journal without that channel (`deferred`
 * false), at once.
 */
const recordAgainst = (failure: Journal.JournalError, deferred = true, flush = false) =>
  runPromise(
    Effect.scoped(Effect.gen(function*() {
      const real = yield* Journal.Journal
      const journal: Journal.Service = {
        ...real,
        emitDurable: (record, owner) =>
          record.eventType.startsWith("flows.engine.node-")
            ? Effect.fail(failure)
            : real.emitDurable(record, owner),
        emitDeferred: deferred ? () => Effect.fail(failure) : undefined
      }
      const engine = yield* EngineStore.make({
        owner: { hostId: "node-journal-refusal" },
        journalSource: "refusal",
        isAlive: () => Effect.succeed(false)
      }).pipe(Effect.provideService(Journal.Journal, journal))
      return yield* Effect.exit(
        engine.recordNode!(scheduled, { flush }).pipe(
          Effect.provideService(
            FlowRuntime.FlowInstance,
            FlowEngine.makeInstance(Empty as unknown as Flow.Any, "refusal-run")
          )
        )
      )
    })).pipe(
      Effect.provide(jj),
      Effect.provide(StepBoundary.layerTest()),
      Effect.provide(TestStores.layerAt(":memory:")),
      Effect.orDie
    )
  )

describe("what identifies a recorded plan", () => {
  const plan = (
    extra: Partial<FlowRuntimeTypes.PlanRecorded> = {},
    site: { readonly path: string; readonly line: number } | undefined = { path: "/repo/src/Answer.ts", line: 12 }
  ): FlowRuntimeTypes.PlanRecorded => ({
    _tag: "PlanRecorded",
    sourceId: "plan/0/0",
    flow: "answer",
    digest: "structure",
    generation: 0,
    page: 0,
    pages: 1,
    nodeCount: 2,
    nodes: [node("ask", { action: "ask", ...(site === undefined ? {} : { declaredAt: site }) }), node("map")],
    edges: [{ from: "ask", to: "map", reason: "value" }],
    ...extra
  })
  const payload = (record: FlowRuntimeTypes.PlanRecorded, at: NodeJournal.Scope = scope) =>
    NodeJournal.entry(at, record).payload as Readonly<Record<string, unknown>>
  const same = (left: FlowRuntimeTypes.PlanRecorded, right: FlowRuntimeTypes.PlanRecorded) =>
    NodeJournal.samePlan(payload(left), payload(right))

  it("is the digest and the header, never a site, a revision or the page layout", () => {
    const rebuilt = plan({ pages: 3, nodes: [node("ask", { action: "ask" })] }, { path: "/repo/dist/App.js", line: 49 })
    expect(payload(plan())["graph"]).not.toEqual(payload(rebuilt)["graph"])
    expect(same(plan(), rebuilt)).toBe(true)
    expect(NodeJournal.samePlan(payload(plan()), payload(plan(), { ...scope, sourceRevision: "a".repeat(40) })))
      .toBe(true)
    expect(NodeJournal.planIdentity(payload(plan()))).toEqual({
      flow: "answer",
      digest: "structure",
      generation: 0,
      nodes: 2,
      page: 0
    })
  })

  it("tells a changed structure apart", () => {
    expect(same(plan(), plan({ digest: "restructured" }))).toBe(false)
    expect(same(plan(), plan({ nodeCount: 3 }))).toBe(false)
    expect(same(plan(), plan({ flow: "other" }))).toBe(false)
    expect(same(plan(), plan({ digest: undefined }))).toBe(false)
  })

  it("compares a plan with no digest by its whole content, without sites", () => {
    const undigested = (extra: Partial<FlowRuntimeTypes.PlanRecorded> = {}, site?: { path: string; line: number }) =>
      plan({ digest: undefined, ...extra }, site)
    expect(same(undigested(), undigested({}, { path: "/repo/dist/App.js", line: 49 }))).toBe(true)
    expect(NodeJournal.samePlan(payload(undigested()), payload(undigested(), { ...scope, root: undefined })))
      .toBe(true)
    expect(same(undigested(), undigested({ nodes: [node("ask", { action: "other" }), node("map")] }))).toBe(false)
    expect(same(undigested(), undigested({ edges: [] }))).toBe(false)
    expect(same(undigested(), undigested({ pages: 2 }))).toBe(false)
  })

  it("compares a malformed row as it stands", () => {
    const header = { flow: "answer", generation: 0, nodes: 1 }
    for (const graph of [undefined, "graph", { nodes: "nodes" }, { nodes: ["node", { id: "a" }] }]) {
      expect(NodeJournal.planIdentity({ ...header, graph })).toEqual({ ...header, graph })
    }
    expect(NodeJournal.samePlan({ ...header, graph: { nodes: ["node"] } }, { ...header, graph: { nodes: [7] } }))
      .toBe(false)
  })
})

describe("a node record the journal refuses", () => {
  it("self-interrupts when the owner fence is lost, rather than narrating a run it no longer owns", async () => {
    const exit = await recordAgainst(new Journal.JournalError({ code: "fence_lost", message: "fence lost" }))
    expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
  })

  it("dies on any other journal failure, rather than dropping the record", async () => {
    const exit = await recordAgainst(new Journal.JournalError({ code: "read_failed", message: "journal unavailable" }))
    expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
  })

  it("writes at once to a journal that cannot queue, and treats its refusal the same", async () => {
    const lost = await recordAgainst(new Journal.JournalError({ code: "fence_lost", message: "fence lost" }), false)
    expect(Exit.isFailure(lost) && Cause.hasInterruptsOnly(lost.cause)).toBe(true)
    const failed = await recordAgainst(new Journal.JournalError({ code: "read_failed", message: "unavailable" }), false)
    expect(Exit.isFailure(failed) && Cause.hasDies(failed.cause)).toBe(true)
  })

  it("propagates an immediate progress write's failure instead of deferring it", async () => {
    const failed = await recordAgainst(
      new Journal.JournalError({ code: "read_failed", message: "unavailable" }),
      true,
      true
    )
    expect(Exit.isFailure(failed) && Cause.hasDies(failed.cause)).toBe(true)
  })
})

describe("what a node settled with, as a journal row keeps it", () => {
  const settled = (value: unknown): Record<string, unknown> =>
    NodeJournal.entry(scope, {
      _tag: "NodeSettled",
      sourceId: "node/read/1/settled",
      nodeId: "read",
      outcome: "built",
      attempts: 1,
      stepKeyDigests: [],
      value
    }).payload as Record<string, unknown>

  const summary = (value: unknown) =>
    settled(value)["result"] as { readonly preview: string; readonly bytes: number; readonly truncated: boolean }

  it("keeps a small value whole, with the size of its encoding", () => {
    const result = summary({ region: "us-east-1", count: 3 })
    expect(result).toEqual({ preview: `{"region":"us-east-1","count":3}`, bytes: 32, truncated: false })
  })

  it("scrubs a credential the field name gives away, before anything is cut", () => {
    // The key is what makes this a secret: no rule over encoded text can see
    // a field name once the value is a string inside a larger string, which is
    // why redaction runs over the decoded value and not over the preview.
    const result = summary({ apiKey: "totally-ordinary-looking-value", region: "us-east-1" })
    expect(result.preview).toContain("us-east-1")
    expect(result.preview).not.toContain("totally-ordinary-looking-value")
    expect(result.preview).toContain("[REDACTED]")
  })

  it("cuts a long value to the ceiling and says it did, keeping the true size", () => {
    const result = summary({ body: "x".repeat(8_000) })
    expect(result.truncated).toBe(true)
    expect(result.preview.length).toBe(NodeJournal.maximumResultBytes)
    expect(result.bytes).toBeGreaterThan(8_000)
  })

  it("never splits a surrogate pair at the cut", () => {
    const result = summary({ body: "😀".repeat(4_000) })
    expect(result.truncated).toBe(true)
    // A lone high surrogate would encode as U+FFFD and read as corruption.
    expect(/[\uD800-\uDBFF]$/.test(result.preview)).toBe(false)
  })

  it("names the size alone for a value too large to walk", () => {
    const result = summary({ body: "x".repeat(NodeJournal.maximumSummarizedBytes) })
    expect(result).toEqual({ preview: "", bytes: expect.any(Number), truncated: true })
    expect(result.bytes).toBeGreaterThan(NodeJournal.maximumSummarizedBytes)
  })

  it("keeps a cycle, a function and a typed failure, because the redactor names them", () => {
    const cyclic: Record<string, unknown> = { name: "loop" }
    cyclic["self"] = cyclic
    expect(summary(cyclic).preview).toContain("[Circular]")
    expect(summary({ run: () => 1 }).preview).toContain("[Function]")
    expect(summary({ _tag: "Doomed", message: "it failed" }).preview).toContain("Doomed")
  })

  it("measures and cuts multi-byte text the way a UTF-8 encoder counts it", () => {
    // `e` with an accent is two bytes and a CJK ideograph is three. A row
    // bounded by CHARACTERS would keep 2,048 of these and write a 5 kB row,
    // and a cut that counted them as one byte each would report a size the
    // store disagrees with.
    const value = { body: "\u00e9\u4e2d".repeat(2_000) }
    const encoder = new TextEncoder()
    const encoded = JSON.stringify(value)
    const result = summary(value)

    expect(result.bytes).toBe(encoder.encode(encoded).length)
    expect(result.truncated).toBe(true)
    const kept = encoder.encode(result.preview).length
    expect(kept).toBeLessThanOrEqual(NodeJournal.maximumResultBytes)
    // And it is the LONGEST prefix within the budget: the next character of
    // the encoding is what did not fit.
    expect(result.preview).toBe(encoded.slice(0, result.preview.length))
    expect(kept + encoder.encode(encoded.charAt(result.preview.length)).length)
      .toBeGreaterThan(NodeJournal.maximumResultBytes)
  })

  it("holds the ceiling for a value only the redactor can measure", () => {
    // A cycle makes the value's own encoding throw, so the cheap size above
    // says nothing about it. The redacted encoding is what the ceiling is
    // then read off, and past it the row keeps the size and nothing else
    // rather than writing 64 KiB of collapsed cycle.
    const cyclic: Record<string, unknown> = { body: "x".repeat(NodeJournal.maximumSummarizedBytes) }
    cyclic["self"] = cyclic
    const result = summary(cyclic)
    expect(result.preview).toBe("")
    expect(result.truncated).toBe(true)
    expect(result.bytes).toBeGreaterThan(NodeJournal.maximumSummarizedBytes)
  })

  it("summarizes nothing for a value JSON has no word for", () => {
    // The entry never asks, because a record carrying no value writes no
    // result at all. Asked directly, the summary's answer is nothing rather
    // than an empty preview, which would read as "it settled with nothing".
    expect(NodeJournal.resultSummary(undefined)).toBeUndefined()
  })

  it("keeps nothing of a plain Error, whose message is not an own enumerable field", () => {
    // `message`, `name` and `stack` are own but NOT enumerable, so the walk
    // reaches none of them and the preview is an empty object. A reader must
    // not present `{}` as the failure text; naming an Error the way the
    // redactor names a function belongs to `@smthrs/journal`.
    expect(summary(new Error("it failed")).preview).toBe("{}")
  })

  it("records no summary at all for a value that will not encode", () => {
    expect(settled(1n)["result"]).toBeUndefined()
    expect(settled(undefined)["result"]).toBeUndefined()
  })
})

describe("what the summary costs a large value", () => {
  it("names a large value's size without walking it, so the redactor is never asked", () => {
    // A rebuilt member would be one more object and thirteen more rule scans
    // per string, on the journal write path, for every node of every graph.
    // The proof the walk was skipped is that a credential SURVIVES: nothing
    // rewrote it, because the preview keeps nothing to rewrite.
    const summary = NodeJournal.resultSummary({
      apiKey: "sk-live-abcdefgh12345678",
      body: "x".repeat(NodeJournal.maximumSummarizedBytes)
    })!
    expect(summary.preview).toBe("")
    expect(summary.truncated).toBe(true)
    expect(summary.bytes).toBeGreaterThan(NodeJournal.maximumSummarizedBytes)
  })
})

describe("original plan observations", () => {
  it.each([
    "absent",
    "self",
    "self-no-revision",
    "ancestor",
    "ancestor-no-revision",
    "unrelated",
    "other-sequence",
    "paged"
  ])(
    "preserves only attested original metadata: %s",
    async (scenario) => {
      const observed = await runPromise(
        Effect.scoped(Effect.gen(function*() {
          const runId = "fork-plan"
          const root = FlowEngine.Lineage.root(runId)
          const inherited = FlowEngine.Lineage.root("parent-plan")
          yield* (yield* RunStore.RunStore).create(
            runId,
            JSON.stringify({
              version: 1,
              flowName: Empty._tag,
              payload: {},
              forkKeyRunIds: scenario.startsWith("self") ? [] : ["parent-plan"]
            })
          )
          const real = yield* Journal.Journal
          const record: FlowRuntimeTypes.PlanRecorded = {
            _tag: "PlanRecorded",
            sourceId: "plan/0/0",
            flow: Empty._tag,
            generation: 0,
            page: 0,
            pages: 1,
            nodeCount: 0,
            nodes: [],
            edges: []
          }
          const seedScope = {
            runId,
            sourceId: "fork-plan",
            lineageId: scenario.startsWith("self") ? root : scenario === "unrelated" ? "stranger" : inherited,
            ...(scenario.endsWith("no-revision") ? {} : { sourceRevision: "ancestor-revision" })
          }
          // Ownerless historical fixture admission; re-emission below remains fenced.
          if (scenario === "paged") {
            for (let i = 0; i < 256; i++) {
              yield* real.emitDurableUnfenced(NodeJournal.entry(seedScope, { ...record, sourceId: `plan/older/${i}` }))
            }
          }
          if (scenario !== "absent") {
            const entry = NodeJournal.entry(seedScope, record)
            yield* real.emitDurableUnfenced(
              scenario === "other-sequence" ? { ...entry, sourceSeq: JournalEvent.SourceSeq.make(1) } : entry
            )
          }
          const writes: Array<JournalEvent.Input> = []
          // The refused write is where the entry recordNode emits is observed,
          // so this journal does not know what it holds: one that does skips
          // re-emitting a plan it already holds byte for byte.
          const journal: Journal.Service = {
            ...real,
            recorded: undefined,
            emitDurable: (entry) => {
              writes.push(entry)
              return Effect.fail(new Journal.JournalError({ code: "read_failed", message: "write refused" }))
            }
          }
          const engine = yield* EngineStore.make({
            owner: { hostId: "fork-plan" },
            journalSource: "fork-plan",
            sourceRevision: "current-revision"
          }).pipe(
            Effect.provideService(Journal.Journal, journal)
          )
          const exit = yield* engine.recordNode!(record).pipe(
            Effect.provideService(FlowRuntime.FlowInstance, FlowEngine.makeInstance(Empty, runId)),
            Effect.exit
          )
          expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
          expect(writes).toHaveLength(1)
          const attested = scenario.startsWith("self") || scenario === "ancestor" ||
            scenario === "ancestor-no-revision" || scenario === "paged"
          return {
            entry: writes[0]!,
            payload:
              NodeJournal.entry(attested ? seedScope : { ...seedScope, sourceRevision: "current-revision" }, record)
                .payload,
            root,
            inherited
          }
        })).pipe(
          Effect.provide(jj),
          Effect.provide(StepBoundary.layerTest()),
          Effect.provide(TestStores.layerAt(":memory:"))
        )
      )
      expect(observed.entry.meta).toEqual({
        lineageId: scenario === "ancestor" || scenario === "ancestor-no-revision" || scenario === "paged"
          ? observed.inherited
          : observed.root
      })
      expect(observed.entry.payload).toEqual(observed.payload)
    }
  )
})

describe("plan provenance lookup", () => {
  const record: FlowRuntimeTypes.PlanRecorded = {
    _tag: "PlanRecorded",
    sourceId: "plan/0/0",
    flow: Empty._tag,
    generation: 0,
    page: 0,
    pages: 1,
    nodeCount: 0,
    nodes: [],
    edges: []
  }

  const check = <E>(
    body: (
      engine: FlowRuntimeTypes.FlowRuntime["Service"],
      real: Journal.Service,
      reads: ReturnType<typeof vi.fn>
    ) => Effect.Effect<void, E, RunStore.RunStore>
  ) =>
    runPromise(
      Effect.scoped(Effect.gen(function*() {
        const real = yield* Journal.Journal
        const reads = vi.fn(real.entries)
        const engine = yield* EngineStore.make({
          owner: { hostId: "provenance" },
          journalSource: "provenance",
          sourceRevision: () => revision
        }).pipe(Effect.provideService(Journal.Journal, {
          ...real,
          entries: reads,
          // This harness isolates journal content deduplication from ownership.
          emitDurable: (entry) => real.emitDurableUnfenced(entry)
        }))
        yield* body(engine, real, reads)
      })).pipe(
        Effect.provide(jj),
        Effect.provide(StepBoundary.layerTest()),
        Effect.provide(TestStores.layerAt(":memory:"))
      )
    )

  let revision = "first"
  it.each(["missing-lineage", "invalid-lineage", "invalid-payload"])(
    "refuses an undecodable %s row with plan_changed",
    async (shape) => {
      await check((engine, real) =>
        Effect.gen(function*() {
          const runId = "legacy-plan"
          yield* (yield* RunStore.RunStore).create(
            runId,
            JSON.stringify({ version: 1, flowName: Empty._tag, payload: {} })
          )
          const entry = NodeJournal.entry({
            runId,
            sourceId: "provenance",
            lineageId: FlowEngine.Lineage.root(runId),
            sourceRevision: "old"
          }, record)
          yield* real.emitDurableUnfenced({
            ...entry,
            ...(shape === "missing-lineage" ?
              { meta: {} } :
              shape === "invalid-lineage" ?
              { meta: { lineageId: 42 } } :
              { payload: { graph: null } })
          })
          const result = yield* engine.recordNode!(record).pipe(
            Effect.provideService(FlowRuntime.FlowInstance, FlowEngine.makeInstance(Empty, runId)),
            Effect.flip
          )
          expect(result).toMatchObject({ code: "plan_changed" })
        })
      )
    }
  )

  it("reads once per instance and source and pins provenance after the first write", async () => {
    revision = "first"
    await check((engine, _real, reads) =>
      Effect.gen(function*() {
        const runId = "memoized-plan"
        yield* (yield* RunStore.RunStore).create(
          runId,
          JSON.stringify({ version: 1, flowName: Empty._tag, payload: {} })
        )
        const instance = FlowEngine.makeInstance(Empty, runId)
        const observe = (input: FlowRuntimeTypes.PlanRecorded) =>
          Effect.gen(function*() {
            yield* engine.nodeRecordBytes!(input)
            yield* engine.recordNode!(input)
            yield* engine.nodeRecordBytes!(input)
            yield* engine.recordNode!(input)
          }).pipe(Effect.provideService(FlowRuntime.FlowInstance, instance))
        // A size measurement before a write must not pin a revision never written.
        yield* engine.nodeRecordBytes!(record).pipe(Effect.provideService(FlowRuntime.FlowInstance, instance))
        revision = "written"
        yield* observe(record)
        revision = "later"
        yield* observe(record)
        expect(reads).toHaveBeenCalledTimes(1)
        yield* observe({ ...record, sourceId: "plan/1/0", generation: 1 })
        expect(reads).toHaveBeenCalledTimes(2)
        yield* Effect.gen(function*() {
          yield* Effect.all([engine.nodeRecordBytes!(record), engine.nodeRecordBytes!(record)], {
            concurrency: "unbounded"
          })
          yield* engine.recordNode!(record)
          yield* engine.nodeRecordBytes!(record)
        }).pipe(Effect.provideService(FlowRuntime.FlowInstance, FlowEngine.makeInstance(Empty, runId)))
        expect(reads).toHaveBeenCalledTimes(3)
      })
    )
  })

  it("keeps the pages an earlier build recorded, and appends none of the rebuilt plan's", async () => {
    await check((engine, real) =>
      Effect.gen(function*() {
        const runId = "rebuilt-plan"
        yield* (yield* RunStore.RunStore).create(
          runId,
          JSON.stringify({ version: 1, flowName: Empty._tag, payload: {} })
        )
        const cwd = process.cwd()
        const page = (site: string, count: number, index: number, generation = 0) => ({
          sourceId: `plan/${generation}/${index}`,
          flow: Empty._tag,
          generation,
          page: index,
          pages: count,
          nodes: [node(`node-${index}`, { declaredAt: { path: `${cwd}/${site}`, line: 10 + index } })],
          edges: []
        })
        const pages = (site: string, count: number, generation = 0): ReadonlyArray<FlowRuntimeTypes.NodeRecord> => [
          {
            _tag: "PlanRecorded",
            digest: `structure-${generation}`,
            nodeCount: 3,
            ...page(site, count, 0, generation)
          },
          ...Array.from({ length: count - 1 }, (_, index) => ({
            _tag: "SubgraphAppended" as const,
            ...page(site, count, index + 1, generation)
          }))
        ]
        const walk = (
          records: ReadonlyArray<FlowRuntimeTypes.NodeRecord>,
          instance = FlowEngine.makeInstance(Empty, runId)
        ) =>
          Effect.forEach(records, (record) => engine.recordNode!(record), { discard: true }).pipe(
            Effect.provideService(FlowRuntime.FlowInstance, instance)
          )
        const rows = Effect.map(
          real.entries({ runId: JournalEvent.RunId.make(runId), limit: 100 }),
          (entries) => entries.entries.map((entry) => ({ sourceId: entry.sourceId, payload: entry.payload }))
        )
        yield* walk([...pages("src/Answer.ts", 2), ...pages("src/Answer.ts", 1, 1)])
        const recorded = yield* rows
        // The rebuilt plans page differently because their sites encode differently.
        const rebuilt = FlowEngine.makeInstance(Empty, runId)
        yield* walk([...pages("dist/App-3f2a1c.js", 3), ...pages("dist/App-3f2a1c.js", 1, 1)], rebuilt)
        expect(yield* rows).toEqual(recorded)
        // A plan no earlier build recorded still writes its pages.
        yield* walk([{ _tag: "SubgraphAppended", ...page("dist/App-3f2a1c.js", 2, 1, 2) }], rebuilt)
        expect((yield* rows).map((row) => row.sourceId)).toEqual([
          "provenance/plan/0/0",
          "provenance/plan/0/1",
          "provenance/plan/1/0",
          "provenance/plan/2/1"
        ])
        const changed = yield* walk([{
          _tag: "PlanRecorded",
          digest: "restructured",
          nodeCount: 3,
          ...page("src/Answer.ts", 2, 0)
        }]).pipe(Effect.flip)
        expect(changed).toMatchObject({ code: "plan_changed", flow: Empty._tag })
      })
    )
  })
})

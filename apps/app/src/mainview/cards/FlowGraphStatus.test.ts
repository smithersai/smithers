/*
 * The live run graph's fold, over a run a real engine actually drove.
 *
 * Every row below comes out of `fixtures/GraphRunJournal.json`, which
 * `scripts/flow-graph-record-journal.ts` recorded from the bridged stack the
 * flow-graph host holds open. Where a case needs evidence the recording does
 * not contain — a `clean` settlement, a skip, a rewind, an evidence gap — the
 * row is a RECORDED row with one field changed, and the test says which. A
 * hand-built envelope would prove the fold reads bytes this app never sees.
 */
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import type { JournalRecord } from "./RunTrace"
import { foldRunGraph, runGraphOf } from "./FlowGraphStatus"

interface Recorded {
  readonly flow: string
  readonly runId: string
  readonly plan: {
    readonly planId: string
    readonly digest: string
    readonly nodes: ReadonlyArray<{ readonly id: string; readonly dependsOn: ReadonlyArray<string> }>
  }
  readonly rows: ReadonlyArray<JournalRecord>
}

const RECORDED: Recorded = JSON.parse(readFileSync(new URL("./fixtures/GraphRunJournal.json", import.meta.url), "utf8"))
const ROWS = RECORDED.rows
const PLAN_IDS = RECORDED.plan.nodes.map((node) => node.id)

/** The envelope of one recorded engine row, for the cases that edit one field. */
const envelopeOf = (row: JournalRecord) => row.payload as {
  readonly executionId: string
  readonly generation: number
  readonly sequence: number
  readonly emittedAtMs: number
  readonly eventType: string
  readonly payload: Record<string, unknown>
}

/** The journal sequence past every recorded row, for the rows a case appends. */
const after = (rows: ReadonlyArray<JournalRecord> = ROWS): number => (rows.at(-1)?.sequence ?? 0) + 1

/** A recorded row replayed as a row the projection has not served before. */
const replayed = (row: JournalRecord, at: number, envelope: Record<string, unknown> = {}): JournalRecord => ({
  ...row,
  sequence: at,
  payload: { ...envelopeOf(row), sequence: envelopeOf(row).sequence + 10_000, ...envelope }
})

/** The recorded row of one event type naming one node. */
const rowFor = (eventType: string, nodeId: string): JournalRecord => {
  const row = rowsOf(eventType).find((candidate) => envelopeOf(candidate).payload["nodeId"] === nodeId)
  if (row === undefined) throw new Error(`the recording carries no ${eventType} for ${nodeId}`)
  return row
}

/** The fixture flow's own plan record, replayed one generation on: a rewind. */
const rewind = (at: number): JournalRecord => {
  const plan = rowsOf("flows.engine.plan-recorded").find((row) => envelopeOf(row).payload["flow"] === RECORDED.flow)
  if (plan === undefined) throw new Error("the recording records no plan for the fixture flow")
  const envelope = envelopeOf(plan)
  return { ...plan, sequence: at, payload: { ...envelope, generation: 1, payload: { ...envelope.payload, generation: 1 } } }
}

/** Every recorded row of one event type, in journal order. */
const rowsOf = (eventType: string): ReadonlyArray<JournalRecord> =>
  ROWS.filter((row) => row.kind === "control.engine.event" && envelopeOf(row).eventType === eventType)

/** One recorded row with one field of its engine payload changed, and nothing else. */
const edited = (row: JournalRecord, fields: Record<string, unknown>): JournalRecord => {
  const envelope = envelopeOf(row)
  return { ...row, payload: { ...envelope, payload: { ...envelope.payload, ...fields } } }
}

/** The execution that drove the plan's own nodes. */
const planGraph = () => {
  const graph = runGraphOf(foldRunGraph(ROWS), { planNodeIds: PLAN_IDS })
  if (graph === undefined) throw new Error("the recording carries no execution covering the plan's nodes")
  return graph
}

describe("the run graph folded from recorded run-events", () => {
  test("decodes every recorded engine row, and refuses none of them", () => {
    const fold = foldRunGraph(ROWS)
    expect(fold.unreadable).toEqual([])
    expect(fold.unproven).toBe(false)
    // Four executions drove this run: the control run's wrapper, the fixture
    // flow, and the two flows the gate is nested in.
    expect(fold.executions.map((execution) => execution.flow).sort()).toEqual([
      "agent/run",
      "gateway/GraphFixture",
      "gateway/graph/Ask",
      "gateway/graph/Gate"
    ])
  })

  test("reports a state for every plan node id, off the execution that drove them", () => {
    const graph = planGraph()
    expect(graph.flow).toBe(RECORDED.flow)
    expect(graph.nodes.map((node) => node.id).sort()).toEqual([...PLAN_IDS].sort())
    expect([...graph.status.keys()].sort()).toEqual([...PLAN_IDS].sort())
    expect([...graph.status.values()].every((run) => run.status === "settled")).toBe(true)
    // The edges the engine drew, with the reason it drew each one. A plan's
    // own `dependsOn` names no reason.
    expect(graph.edges.length).toBeGreaterThan(PLAN_IDS.length)
    expect(new Set(graph.edges.map((edge) => edge.reason))).toEqual(new Set(["continuation", "value", "failure"]))
  })

  test("carries the outcome the engine recorded for each node, and invents none", () => {
    const outcomes = new Map([...planGraph().status].map(([id, run]) => [id, run.outcome]))
    // The catch arm's protected node really did fail inside a run that
    // completed: the recovery is the sibling node, not a rewritten outcome.
    expect(outcomes.get("root.flow.then.map.all.recovered.protected")).toBe("failed")
    expect(outcomes.get("root.flow.then.map.all.recovered")).toBe("built")
    expect([...outcomes.values()].filter((outcome) => outcome === "failed")).toHaveLength(1)
    // No `clean`, no `skipped` and no `deferred` were recorded (D-044): this
    // host cannot serve one run's node from another run's record.
    expect([...new Set(outcomes.values())].sort()).toEqual(["built", "failed"])
  })

  /*
   * D-052: the settlement names the dispatches it ran under and carries a
   * bounded, redacted preview of what it settled with. Both are the node's
   * own evidence, so the fold keeps them for the drawer that lists them.
   */
  test("keeps the dispatch identities and the bounded result each settlement recorded", () => {
    const status = runGraphOf(foldRunGraph(ROWS), { planNodeIds: PLAN_IDS })?.status

    expect(status?.get("root.flow.then.map.all.retried")).toMatchObject({
      outcome: "built",
      attempts: 2,
      stepKeyDigests: ["5162572eae1c45470841762db4ba42e807da01669a2499fb5276b60fc4c68561"],
      result: { preview: "\"flaky:recorded\"", bytes: 16, truncated: false }
    })
    /* A node that dispatched nothing claims no digest, and says so. */
    expect(status?.get("root.flow.andThen")?.stepKeyDigests).toEqual([])
    /* A failed node's result IS its bounded typed failure, the same field. */
    expect(status?.get("root.flow.then.map.all.recovered.protected")).toMatchObject({
      outcome: "failed",
      result: { preview: "\"doomed:recorded\"", truncated: false }
    })
  })

  test("counts the attempts the node records number, which is two for the retried step", () => {
    const status = planGraph().status
    // `gateway/graph/Flaky` failed its first ATTEMPT and succeeded on its
    // second, and its settlement carries the engine's own count of its
    // dispatches rather than the walk's count of the node. This fold says
    // what the node record says.
    expect(status.get("root.flow.then.map.all.retried")).toMatchObject({ outcome: "built", attempts: 2 })
    // Every other node ran once, so a raised count is evidence and not noise.
    expect(
      [...status].filter(([id]) => id !== "root.flow.then.map.all.retried").map(([, run]) => run.attempts)
    ).toEqual(PLAN_IDS.filter((id) => id !== "root.flow.then.map.all.retried").map(() => 1))

    // The same recorded rows with the count raised again: the fold reads the
    // number off the record and does not cap or recompute it.
    const raised = ROWS.map((row) =>
      row.kind === "control.engine.event" && envelopeOf(row).payload["nodeId"] === "root.flow.then.map.all.retried"
        ? edited(row, envelopeOf(row).eventType === "flows.engine.node-settled" ? { attempts: 3 } : { attempt: 3 })
        : row
    )
    const rescheduled = runGraphOf(foldRunGraph(raised), { planNodeIds: PLAN_IDS })?.status
    expect(rescheduled?.get("root.flow.then.map.all.retried")?.attempts).toBe(3)
  })

  test("reads a settled node's outcome word off the record, whatever the word is", () => {
    const settled = rowsOf("flows.engine.node-settled")
      .find((row) => envelopeOf(row).payload["nodeId"] === "root.flow.then.map.all.cached")
    if (settled === undefined) throw new Error("the recording settles no cacheable node")
    for (const outcome of ["clean", "skipped", "deferred"] as const) {
      // A recorded settlement with its outcome word changed. Nothing on this
      // host produces `clean` (D-044); the fold still has to carry it, because
      // a host with a cache environment will.
      const rows = ROWS.map((row) => row === settled ? edited(row, { outcome }) : row)
      const run = runGraphOf(foldRunGraph(rows), { planNodeIds: PLAN_IDS })?.status.get("root.flow.then.map.all.cached")
      expect(run).toMatchObject({ status: "settled", outcome })
    }
  })

  /*
   * A node wider than one page is seated with no dependencies on it and
   * continued on the pages that follow, each carrying the next slice of
   * `dependsOn`. That is how `@smthrs/flow` records an input-driven fan-in at
   * any width, so the fold has to union the slices.
   */
  test("unions the dependency slices of a node paged across records", () => {
    const plan = rowsOf("flows.engine.plan-recorded")
      .find((row) => envelopeOf(row).payload["flow"] === RECORDED.flow)
    if (plan === undefined) throw new Error("the recording records no plan for the fixture flow")
    const envelope = envelopeOf(plan)
    const graph = envelope.payload["graph"] as {
      readonly nodes: ReadonlyArray<{ readonly id: string; readonly dependsOn: ReadonlyArray<string> }>
      readonly edges: ReadonlyArray<unknown>
    }
    const wide = graph.nodes.find((node) => node.dependsOn.length > 1)
    if (wide === undefined) throw new Error("the recording plans no node with two dependencies")
    // The recorded page with that node's dependency list cut in two: the seat
    // keeps the first, and one subgraph page carries the rest.
    const seated = edited(plan, {
      graph: {
        ...graph,
        nodes: graph.nodes.map((node) => node === wide ? { ...node, dependsOn: wide.dependsOn.slice(0, 1) } : node)
      }
    })
    const continued: JournalRecord = {
      ...plan,
      sequence: after(),
      payload: {
        ...envelope,
        sequence: envelope.sequence + 10_000,
        eventType: "flows.engine.subgraph-appended",
        payload: {
          flow: envelope.payload["flow"],
          generation: envelope.payload["generation"],
          nodeIds: [wide.id],
          page: 1,
          pages: 2,
          graph: { nodes: [{ ...wide, dependsOn: wide.dependsOn.slice(1) }], edges: [] }
        }
      }
    }
    const paged = runGraphOf(
      foldRunGraph([...ROWS.map((row) => row === plan ? seated : row), continued]),
      { planNodeIds: PLAN_IDS }
    )
    expect(paged?.nodes.find((node) => node.id === wide.id)?.dependsOn).toEqual([...wide.dependsOn])
    // Nothing else moved: the seat and the continuation describe one node.
    expect(paged?.nodes.map((node) => node.id).sort()).toEqual([...PLAN_IDS].sort())
  })

  test("keeps a node running when its settlement never arrives", () => {
    const settled = rowsOf("flows.engine.node-settled")
      .find((row) => envelopeOf(row).payload["nodeId"] === "root.flow.then.map.all.steady")
    const without = ROWS.filter((row) => row !== settled)
    const run = runGraphOf(foldRunGraph(without), { planNodeIds: PLAN_IDS })?.status.get("root.flow.then.map.all.steady")
    expect(run).toMatchObject({ status: "running", attempts: 1 })
    expect(run?.outcome).toBeUndefined()
    expect(run?.settledAt).toBeUndefined()
  })

  test("leaves a node of the recorded graph pending until a record names it", () => {
    const untouched = ROWS.filter((row) =>
      !(row.kind === "control.engine.event" &&
        envelopeOf(row).payload["nodeId"] === "root.flow.then.map.all.cached")
    )
    const run = runGraphOf(foldRunGraph(untouched), { planNodeIds: PLAN_IDS })?.status.get("root.flow.then.map.all.cached")
    expect(run).toEqual({ status: "pending", attempts: 0 })
  })

  test("keeps two executions apart, though both name a node `root`", () => {
    const fold = foldRunGraph(ROWS)
    const wrapper = fold.executions.find((execution) => execution.flow === "agent/run")
    const fixture = fold.executions.find((execution) => execution.flow === RECORDED.flow)
    expect(wrapper?.executionId).toBe(RECORDED.runId)
    expect(fixture?.executionId).not.toBe(RECORDED.runId)
    // Both graphs carry `root` and `root.flow`. Folding on the node id alone
    // would merge four executions into one wrong graph.
    expect(wrapper?.status.get("root")).toMatchObject({ action: "agent/run", outcome: "built" })
    expect(fixture?.status.get("root")).toMatchObject({ action: RECORDED.flow, outcome: "built" })
    expect(wrapper?.nodes).toHaveLength(2)
    expect(fixture?.nodes).toHaveLength(PLAN_IDS.length)
  })

  test("drops a row the fold has already read, however often the projection repeats it", () => {
    // The projection holds no durable cursor, so a reconnecting pump re-reads
    // pages it has already served. An edge counted twice is a second arrow
    // drawn over the first.
    const doubled = foldRunGraph([...ROWS, ...ROWS])
    const once = foldRunGraph(ROWS)
    const shapeOf = (fold: ReturnType<typeof foldRunGraph>) =>
      fold.executions.map((execution) => [execution.executionId, execution.edges, [...execution.status]])
    expect(shapeOf(doubled)).toEqual(shapeOf(once))
    expect(runGraphOf(doubled, { planNodeIds: PLAN_IDS })?.edges).toEqual(planGraph().edges)
  })

  test("a later generation of one execution rewinds that execution and no other", () => {
    const fixture = rowsOf("flows.engine.plan-recorded")
      .find((row) => envelopeOf(row).payload["flow"] === RECORDED.flow)
    if (fixture === undefined) throw new Error("the recording records no plan for the fixture flow")
    // The recorded plan record of that execution, replayed at generation 1:
    // what a rewound projection copies when the engine re-drives a run.
    const envelope = envelopeOf(fixture)
    const rewound: JournalRecord = {
      ...fixture,
      sequence: (ROWS.at(-1)?.sequence ?? 0) + 1,
      payload: { ...envelope, generation: 1, payload: { ...envelope.payload, generation: 1 } }
    }
    const fold = foldRunGraph([...ROWS, rewound])
    const fixtureGraph = fold.executions.find((execution) => execution.executionId === envelope.executionId)
    expect(fixtureGraph?.generation).toBe(1)
    // Every node of the re-driven graph is back to pending: the earlier
    // generation's settlements describe work the rewind discarded.
    expect([...fixtureGraph?.status.values() ?? []].every((run) => run.status === "pending")).toBe(true)
    // The wrapper was not rewound, so its own settlements stand.
    expect(fold.executions.find((execution) => execution.flow === "agent/run")?.status.get("root")?.status)
      .toBe("settled")
  })

  test("ignores a row from a generation the projection has already rewound past", () => {
    // The rewind lands, and then a page from generation 0 arrives late: the
    // settlement it carries describes work the rewind discarded.
    const stale = replayed(rowFor("flows.engine.node-settled", "root.flow.then.map.all.steady"), after() + 1)
    const fold = foldRunGraph([...ROWS, rewind(after()), stale])
    const graph = runGraphOf(fold, { planNodeIds: PLAN_IDS })
    expect(graph?.generation).toBe(1)
    expect(graph?.status.get("root.flow.then.map.all.steady")).toEqual({ status: "pending", attempts: 0 })
  })

  test("a rewind keeps the hole the projection had already admitted", () => {
    const scheduled = rowFor("flows.engine.node-scheduled", "root.flow.then.map.all.steady")
    const gap: JournalRecord = {
      sequence: after(),
      occurredAt: ROWS.at(-1)?.occurredAt,
      kind: "control.engine.projection-gap",
      payload: { executionId: envelopeOf(scheduled).executionId, generation: 0, reason: "compacted", throughSequence: 40 }
    }
    const graph = runGraphOf(foldRunGraph([...ROWS, gap, rewind(after() + 1)]), { planNodeIds: PLAN_IDS })
    expect(graph?.generation).toBe(1)
    // Re-driving the graph does not fill the hole in its history: every node
    // of the rewound execution is unproven, not pending.
    expect([...graph?.status.values() ?? []].every((run) => run.status === "unproven")).toBe(true)
  })

  test("a row it cannot read is a hole, so the nodes it might have moved are unproven", () => {
    // The engine adds fields; every payload here is decoded strictly, so a
    // record carrying one this build does not know is refused. What that
    // record would have said about its execution is then unknowable, and a
    // node left reading `pending` would be a claim nothing supports.
    const settled = rowFor("flows.engine.node-settled", "root.flow.then.map.all.steady")
    const rows = ROWS.map((row) => row === settled ? edited(row, { invented: "a field this build does not know" }) : row)
    const fold = foldRunGraph(rows)
    expect(fold.unreadable).toEqual([settled.sequence ?? -1])
    expect(fold.unproven).toBe(true)
    const graph = runGraphOf(fold, { planNodeIds: PLAN_IDS })
    expect(graph?.status.get("root.flow.then.map.all.steady")?.status).toBe("unproven")
    // A node that settled before the refused row keeps its own settlement.
    expect(graph?.status.get("root.flow.andThen")).toMatchObject({ status: "settled", outcome: "built" })
    // The hole belongs to the execution that wrote the row, and no other.
    expect(fold.executions.find((execution) => execution.flow === "agent/run")?.status.get("root")?.status)
      .toBe("settled")
  })

  test("a gap that names no execution leaves every execution unproven", () => {
    const scheduled = rowFor("flows.engine.node-scheduled", "root.flow.then.map.all.steady")
    const through = ROWS.slice(0, ROWS.indexOf(scheduled) + 1)
    // A gap row the fold cannot scope says only that history is missing, so
    // it covers the whole run rather than the execution it failed to name.
    const gap: JournalRecord = {
      sequence: after(through),
      occurredAt: through.at(-1)?.occurredAt,
      kind: "control.engine.projection-gap",
      payload: { reason: "compacted" }
    }
    const fold = foldRunGraph([...through, gap])
    expect(fold.unproven).toBe(true)
    expect(runGraphOf(fold, { planNodeIds: PLAN_IDS })?.status.get("root.flow.then.map.all.steady")?.status)
      .toBe("unproven")
    // The wrapper is a different execution and the gap named nobody, so its
    // unsettled nodes are unproven too.
    expect(fold.executions.find((execution) => execution.flow === "agent/run")?.status.get("root")?.status)
      .toBe("unproven")
  })

  test("keeps the time a node first started, however often it is scheduled again", () => {
    const scheduled = rowFor("flows.engine.node-scheduled", "root.flow.then.map.all.retried")
    const first = envelopeOf(scheduled).emittedAtMs
    const again = replayed(scheduled, after(), { emittedAtMs: first + 60_000 })
    const run = runGraphOf(foldRunGraph([...ROWS, again]), { planNodeIds: PLAN_IDS })
      ?.status.get("root.flow.then.map.all.retried")
    expect(run?.startedAt).toBe(first)
    expect(run?.status).toBe("running")
  })

  test("an evidence gap leaves the nodes it covers unproven, never idle", () => {
    const scheduled = rowsOf("flows.engine.node-scheduled")
      .find((row) => envelopeOf(row).payload["nodeId"] === "root.flow.then.map.all.steady")
    if (scheduled === undefined) throw new Error("the recording schedules no steady node")
    const through = ROWS.slice(0, ROWS.indexOf(scheduled) + 1)
    const gap: JournalRecord = {
      sequence: (through.at(-1)?.sequence ?? 0) + 1,
      occurredAt: through.at(-1)?.occurredAt,
      kind: "control.engine.projection-gap",
      payload: { executionId: envelopeOf(scheduled).executionId, generation: 0, reason: "compacted", throughSequence: 40 }
    }
    const fold = foldRunGraph([...through, gap])
    expect(fold.unproven).toBe(true)
    const graph = runGraphOf(fold, { planNodeIds: PLAN_IDS })
    expect(graph?.status.get("root.flow.then.map.all.steady")?.status).toBe("unproven")
    // A node the gap's execution never reached is unproven too: after a hole
    // in the history, "pending" is a claim nothing supports.
    expect(graph?.status.get("root.flow.then.map.all.cached")?.status).toBe("unproven")
    // A node that settled BEFORE the gap keeps its recorded settlement.
    expect(graph?.status.get("root.flow.andThen")).toMatchObject({ status: "settled", outcome: "built" })
  })

  test("prefers the flow the card launched when two executions cover the plan equally", () => {
    // Every execution of this run names a node `root` and a node `root.flow`,
    // so a plan whose nodes are only those two is covered by all four. The
    // flow the card launched breaks the tie; first-seen would draw the
    // `agent/run` wrapper under the fixture flow's heading.
    const both = ["root", "root.flow"]
    const fold = foldRunGraph(ROWS)
    expect(runGraphOf(fold, { planNodeIds: both, flow: RECORDED.flow })?.flow).toBe(RECORDED.flow)
    expect(runGraphOf(fold, { planNodeIds: both, flow: "agent/run" })?.flow).toBe("agent/run")
    // With no flow to prefer, the first execution covering the plan stands.
    expect(runGraphOf(fold, { planNodeIds: both })?.flow).toBe("agent/run")
    // A better-covered execution still wins over the launched flow's name.
    expect(runGraphOf(fold, { planNodeIds: PLAN_IDS, flow: "agent/run" })?.flow).toBe(RECORDED.flow)
  })

  test("names the execution by flow when no plan is held, and nothing when neither is", () => {
    const fold = foldRunGraph(ROWS)
    expect(runGraphOf(fold, { flow: RECORDED.flow })?.nodes).toHaveLength(PLAN_IDS.length)
    expect(runGraphOf(fold, { flow: "gateway/NothingRanThis" })).toBeUndefined()
    expect(runGraphOf(fold, {})).toBeUndefined()
    expect(runGraphOf(foldRunGraph([]), { planNodeIds: PLAN_IDS })).toBeUndefined()
  })

  /*
   * D-068: the sites a page carries were read out of one tree, and the page
   * says which. The execution takes the revision every page of it agrees on:
   * one that names another, and one that names none, both leave the
   * execution with no revision, because a site opened at another page's
   * revision is a file nobody recorded.
   */
  test("takes the revision its pages agree on, and none where they do not", () => {
    const pages = rowsOf("flows.engine.plan-recorded")
      .filter((row) => envelopeOf(row).payload["flow"] === RECORDED.flow)
    expect(pages.length).toBeGreaterThan(0)
    /*
     * One page with a revision on it. A page replayed at the SAME engine
     * sequence is the same page — the fold collapses it — so a case that
     * appends a second page gives it a sequence of its own.
     */
    const withGraph = (row: JournalRecord, sourceRevision?: string, sequence?: number): JournalRecord => {
      const envelope = envelopeOf(row)
      const graph = envelope.payload["graph"] as Record<string, unknown>
      const page = edited(row, { graph: { ...graph, ...(sourceRevision === undefined ? {} : { sourceRevision }) } })
      if (sequence === undefined) return page
      return { ...page, sequence, payload: { ...(page.payload as Record<string, unknown>), sequence } }
    }
    const named = (rows: ReadonlyArray<JournalRecord>) =>
      runGraphOf(foldRunGraph(rows), { planNodeIds: PLAN_IDS, flow: RECORDED.flow })?.sourceRevision

    /* Unrecorded, as every row of this recording is. */
    expect(named(ROWS)).toBeUndefined()

    const revision = "b".repeat(40)
    const agreed = ROWS.map((row) => pages.includes(row) ? withGraph(row, revision) : row)
    expect(named(agreed)).toBe(revision)

    /* One page appended at another revision: the execution names neither. */
    const appended = [...agreed, withGraph(pages[0]!, "c".repeat(40), after())]
    expect(named(appended)).toBeUndefined()

    /* And one page that names nothing is the same answer. */
    const silent = [...agreed, withGraph(pages[0]!, undefined, after())]
    expect(named(silent)).toBeUndefined()
  })

  test("carries the recorded node anatomy a card draws: the action tag, the kind and the tier", () => {
    const nodes = new Map(planGraph().nodes.map((node) => [node.id, node]))
    expect(nodes.get("root.flow.then.map.all.steady")).toMatchObject({
      kind: "ActionCall",
      tier: "sealed",
      action: "gateway/graph/Steady"
    })
    // A merge node dispatches nothing, so it names no action rather than
    // borrowing one.
    expect(nodes.get("root.flow.then.map")?.action).toBeUndefined()
  })
})

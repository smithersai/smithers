/**
 * Selector-correlated gateway row schemas.
 */
import type { ControlSchema } from "@smthrs/control"
import { Effect, Schema, Stream } from "effect"
import { describe, expect, expectTypeOf, it } from "vitest"
import * as GatewayProjection from "../src/GatewayProjection.ts"
import * as GatewaySchema from "../src/GatewaySchema.ts"
import type * as Projections from "../src/Projections.ts"

const run: ControlSchema.RunSummary = {
  runId: "run-1",
  flowId: "deploy",
  status: "running",
  createdAt: 1,
  updatedAt: 2
}

const event = (sequence: number, kind: string, payload: unknown): ControlSchema.ControlEvent => ({
  sequence,
  kind,
  runId: "run-1",
  occurredAt: sequence,
  payload: payload as ControlSchema.ControlEvent["payload"]
})

const started = event(1, "control.agent.cell-call-started", { flowName: "write" })
const settled = event(2, "control.agent.cell-call-settled", {
  flowName: "write",
  outcome: "success",
  value: "done"
})
const approval = event(3, "control.approval.requested", {
  runId: "run-1",
  requestId: "gate",
  question: "Ship?",
  payload: {
    target: {
      _tag: "Node",
      runId: "run-1",
      requestId: "gate",
      digest: "digest",
      envelope: { capabilities: [], flows: [], budget: {} }
    },
    scope: "run",
    idempotencyKey: "approve:gate"
  }
})
const accepted = event(4, "control.run.accepted", { runId: "run-1", status: "accepted" })

const cases = [
  [{ _tag: "workspace-runs" }, GatewayProjection.runSummary(run, [])],
  [{ _tag: "run-summary", runId: "run-1" }, GatewayProjection.runSummary(run, [])],
  [{ _tag: "run-events", runId: "run-1" }, accepted],
  [{ _tag: "transcript", runId: "run-1" }, GatewayProjection.transcript([accepted])[0]],
  [{ _tag: "run-tree", runId: "run-1" }, GatewayProjection.runTree(run, [started])[0]],
  [{ _tag: "approvals", runId: "run-1" }, GatewayProjection.approvals([approval])[0]],
  [{ _tag: "node-output", runId: "run-1", nodeId: "call-1" }, GatewayProjection.nodeOutput([started, settled])[0]]
] as const satisfies ReadonlyArray<readonly [GatewaySchema.ProjectionSelector, unknown]>

describe("GatewaySchema.rowSchemaFor", () => {
  for (const [selector, row] of cases) {
    it(`decodes ${selector._tag} rows and rejects another shape`, () => {
      const schema = GatewaySchema.rowSchemaFor(selector)
      expect(Schema.decodeUnknownSync(schema)(row)).toEqual(row)
      expect(() => Schema.decodeUnknownSync(schema)({ definitelyWrong: true })).toThrow()
    })
  }
})

describe("selector-correlated wire payloads", () => {
  it("rejects rows and deltas that do not belong to their selector", () => {
    const selector = { _tag: "run-summary" as const, runId: "run-1" }
    const cursor = {
      selector,
      projection: selector._tag,
      runId: selector.runId,
      value: 4,
      offset: 0
    }
    for (
      const candidate of [
        { _tag: "row", selector, cursor, row: accepted },
        { _tag: "delta", selector, cursor, delta: [accepted] }
      ]
    ) {
      expect(() => Schema.decodeUnknownSync(GatewaySchema.GatewayFrame)(candidate)).toThrow()
    }
    expect(() => Schema.decodeUnknownSync(GatewaySchema.ProjectionSnapshot)({ selector, cursor, rows: [accepted] }))
      .toThrow()
  })
})

describe("the served selector-to-row table", () => {
  /** A cursor for one selector, which every selector-correlated shape carries. */
  const cursorFor = (selector: GatewaySchema.ProjectionSelector) => ({
    selector,
    projection: selector._tag,
    runId: (selector as { readonly runId?: string }).runId ?? null,
    value: 0,
    offset: 0
  })

  it("serves one row schema per projection name, and no name the read path cannot answer", () => {
    expect([...cases].map(([selector]) => selector._tag).sort())
      .toEqual([...GatewaySchema.ProjectionName.literals].sort())
  })

  for (const [selector, row] of cases) {
    // A row from a projection whose row schema differs, so the mismatch is a
    // real one: `workspace-runs` and `run-summary` share `RunSummaryRow`.
    const [, foreign] = cases.find(([other]) =>
      GatewaySchema.rowSchemaFor(other) !== GatewaySchema.rowSchemaFor(selector)
    )!
    const cursor = cursorFor(selector)

    it(`pairs ${selector._tag} with its row in snapshots, row frames, and deltas alike`, () => {
      const snapshot = Schema.decodeUnknownSync(GatewaySchema.ProjectionSnapshot)
      const frame = Schema.decodeUnknownSync(GatewaySchema.GatewayFrame)

      expect(snapshot({ selector, cursor, rows: [row] })).toBeDefined()
      expect(frame({ _tag: "row", selector, cursor, row })).toBeDefined()
      expect(frame({ _tag: "delta", selector, cursor, delta: [row] })).toBeDefined()

      expect(() => snapshot({ selector, cursor, rows: [foreign] })).toThrow()
      expect(() => frame({ _tag: "row", selector, cursor, row: foreign })).toThrow()
      expect(() => frame({ _tag: "delta", selector, cursor, delta: [foreign] })).toThrow()
    })
  }
})

/**
 * Compile-time only: the annotated results are the assertion. `requestId` and
 * `nodeId` are read off the rows a literal selector answers with, with no
 * assertion in between, and a union of every projection's rows would not
 * compile here.
 */
const readsSelectorRows = (projections: Projections.Service) => ({
  requestIds: Effect.map(
    projections.snapshot({ _tag: "approvals", runId: "run-1" }),
    (snapshot): ReadonlyArray<string> => snapshot.rows.map((approval) => approval.requestId)
  ),
  nodeIds: Stream.map(
    projections.subscribe({ _tag: "run-tree", runId: "run-1" }),
    (frame): string | null => frame._tag === "row" ? frame.row.nodeId : null
  )
})

describe("a selector's result type", () => {
  it("keeps the selector's own row, so a caller reads its fields without an assertion", () => {
    expectTypeOf<GatewaySchema.RowOf<GatewaySchema.ApprovalsSelector>>()
      .toEqualTypeOf<GatewayProjection.ApprovalRow>()
    expectTypeOf<GatewaySchema.SnapshotOf<GatewaySchema.RunTreeSelector>["rows"][number]>()
      .toEqualTypeOf<GatewayProjection.RunTreeRow>()
    expect(readsSelectorRows).toBeTypeOf("function")
  })

  it("stays the whole union for a selector chosen at runtime", () => {
    expectTypeOf<GatewaySchema.SnapshotOf<GatewaySchema.ProjectionSelector>>()
      .toEqualTypeOf<GatewaySchema.ProjectionSnapshot>()
    expectTypeOf<GatewaySchema.FrameOf<GatewaySchema.ProjectionSelector>>()
      .toEqualTypeOf<GatewaySchema.GatewayFrame>()
  })
})

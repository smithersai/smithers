import { expect, test } from "bun:test"
import { authoredSources } from "./FlowAuthoringReceipts"

const event = (sequence: number, eventType: string, payload: unknown, executionId = "author", generation = 0) => ({
  sequence, kind: "control.engine.event", payload: {
    version: 1, executionId, generation, sequence, eventId: `event-${sequence}`,
    sourceId: "engine", sourceSequence: sequence, emittedAtMs: sequence, eventType, payload, meta: {}
  }
})
const attempt = { runId: "author", stepKeyDigest: "a".repeat(64), attempt: 1, bundleIdentity: "bundle-1" }
const captured = event(1, "flows.engine.diff-bundle-captured", { ...attempt, changedPaths: ["flows/review/flow.ts", "README.md"] })
const applied = event(2, "flows.engine.copy-back-settled", { ...attempt, rebases: 0, queued: [], dispatched: [] })

test("a captured diff is not an applied source change; the matching copy-back is", () => {
  expect(authoredSources([captured])).toEqual([])
  expect(authoredSources([applied])).toEqual([])
  expect(authoredSources([captured, applied])).toEqual([{
    receipt: 'author:0:event-2', path: "flows/review/flow.ts", flowId: "review"
  }])
  expect(authoredSources([captured, applied, applied])).toHaveLength(1)
})

test("bundle, attempt, execution and generation must all match", () => {
  for (const mismatch of [
    event(2, "flows.engine.copy-back-settled", { ...attempt, bundleIdentity: "other" }),
    event(2, "flows.engine.copy-back-settled", { ...attempt, attempt: 2 }),
    event(2, "flows.engine.copy-back-settled", attempt, "other"),
    event(2, "flows.engine.copy-back-settled", attempt, "author", 1)
  ]) expect(authoredSources([captured, mismatch])).toEqual([])
})

test("the real agent's successful write, edit and apply_patch outputs identify sources, never its prose", () => {
  const rows = [
    { sequence: 1, kind: "control.agent.cell-call-settled", payload: { callId: "c1", flowName: "write", outcome: "success", value: { path: "flows/new/flow.mdx", bytesWritten: 20, created: true } } },
    { sequence: 2, kind: "control.agent.cell-call-settled", payload: { callId: "c2", flowName: "edit", outcome: "success", value: { path: "flows/new/flow.mdx", replacements: 1 } } },
    { sequence: 3, kind: "control.agent.cell-call-settled", payload: { callId: "c3", flowName: "apply_patch", outcome: "success", value: { added: ["flows/nested/check/flow.ts"], modified: [], deleted: [] } } }
  ]
  expect(authoredSources(rows).map(row => row.flowId)).toEqual(["new", "new", "nested/check"])
  expect(authoredSources([
    { kind: "control.agent.cell-call-started", payload: { flowName: "write", input: { path: "flows/no/flow.ts" } } },
    ...rows.map(row => ({ ...row, payload: { ...row.payload, outcome: "failure" } })),
    { kind: "control.agent.text", payload: { text: "Wrote flows/no/flow.ts" } }
  ])).toEqual([])
})

test("rejects unbound absolute paths, traversal, malformed receipts and non-entry files", () => {
  for (const path of ["/tmp/flows/no/flow.ts", "flows/../flow.ts", "flows/no/helper.ts", "flows/no/flow.ts\0", "flows/no\\evil/flow.ts"]) {
    expect(authoredSources([event(1, "flows.engine.diff-bundle-captured", { ...attempt, changedPaths: [path] }), applied])).toEqual([])
  }
  expect(authoredSources([{ kind: "control.engine.event", payload: { eventType: "flows.engine.copy-back-settled" } }])).toEqual([])
})

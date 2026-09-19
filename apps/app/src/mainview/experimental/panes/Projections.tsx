/*
 * Mock: Projections. Behind VITE_SMITHERS_EXPERIMENTAL, reached by
 * `/experimental.projections`. Self-contained on purpose — see ../Pane.ts.
 *
 * The generic reader. Every other debug surface in the app is one preset of
 * this: a run card is `run-summary`, a transcript is `transcript`, an inbox is
 * `approvals`. So the pane selects a projection, shows the cursor its rows
 * were read at, the frames `Projection.Subscribe` delivered them in, and one
 * row expanded into the fields its row schema actually declares
 * (GatewaySchema, GatewayProjection, GatewayRpcs).
 */
import { pane, type ExperimentalPaneContext } from "../Pane"
import { Badge, Facts, Rail, Section, Split, Steps, Table, type Tone } from "../Primitives"

interface ProjectionRow {
  readonly id: string
  readonly [field: string]: string
}

interface ProjectionDef {
  readonly id: string
  readonly label: string
  readonly note: string
  readonly tone: Tone
  readonly selector: string
  readonly runId: string
  readonly value: string
  readonly offset: string
  readonly delta: string
  readonly columns: ReadonlyArray<string>
  readonly fields: ReadonlyArray<string>
  readonly rows: ReadonlyArray<ProjectionRow>
}

const PROJECTIONS: ReadonlyArray<ProjectionDef> = [
  {
    id: "workspace-runs",
    label: "workspace-runs",
    note: "RunSummaryRow",
    tone: "info",
    selector: `{ _tag: "workspace-runs" }`,
    runId: "null",
    value: "0",
    offset: "0",
    delta: "replaces every row",
    columns: ["runId", "flowId", "status", "turns", "calls"],
    fields: ["runId", "flowId", "status", "seat", "planDigest", "lineageId", "turns", "calls", "callsFailed", "inputTokens", "outputTokens", "verdict", "updatedAt"],
    rows: [
      { id: "run-42", runId: "run-42", flowId: "system/release", status: "running", seat: "opus-5", planDigest: "plan_7c11…4e0a", lineageId: "lin1_8ef3…b70c", turns: "18", calls: "204", callsFailed: "3", inputTokens: "812440", outputTokens: "41208", verdict: "running · awaiting approval", updatedAt: "1758182401221" },
      { id: "run-41", runId: "run-41", flowId: "system/plan", status: "completed", seat: "gpt-6-astra", planDigest: "plan_5d02…9ab7", lineageId: "lin1_44aa…21e9", turns: "6", calls: "38", callsFailed: "0", inputTokens: "102338", outputTokens: "8802", verdict: "completed", updatedAt: "1758179740008" }
    ]
  },
  {
    id: "run-summary",
    label: "run-summary",
    note: "RunSummaryRow",
    tone: "info",
    selector: `{ _tag: "run-summary", runId: "run-42" }`,
    runId: "run-42",
    value: "1184",
    offset: "0",
    delta: "replaces the row",
    columns: ["runId", "status", "waitingReason", "steeringPending", "turns"],
    fields: ["runId", "flowId", "status", "waitingReason", "steeringPending", "parentRunId", "roundOrdinal", "editsAttempted", "editsSucceeded", "diagnosis", "finalOutput", "createdAt", "updatedAt"],
    rows: [
      { id: "run-42", runId: "run-42", flowId: "system/release", status: "running", waitingReason: "approval", steeringPending: "1", parentRunId: "run-39", roundOrdinal: "3", editsAttempted: "27", editsSucceeded: "24", turns: "18", diagnosis: "parked on the publish gate", finalOutput: "—", createdAt: "1758170104900", updatedAt: "1758182401221" }
    ]
  },
  {
    id: "run-events",
    label: "run-events",
    note: "ControlEvent",
    tone: "warn",
    selector: `{ _tag: "run-events", runId: "run-42" }`,
    runId: "run-42",
    value: "1184",
    offset: "0",
    delta: "appends one event",
    columns: ["sequence", "kind", "runId", "occurredAt"],
    fields: ["cursor", "sequence", "kind", "runId", "occurredAt", "payload"],
    rows: [
      { id: "e1184", cursor: "1184:0", sequence: "1184", kind: "control.steer.enqueued", runId: "run-42", occurredAt: "1758182401221", payload: `{ "messageId": "msg_7f1e" }` },
      { id: "e1183", cursor: "1183:0", sequence: "1183", kind: "control.status.observed", runId: "run-42", occurredAt: "1758182390114", payload: `{ "checkerId": "jev.session" }` },
      { id: "e1179", cursor: "1179:0", sequence: "1179", kind: "flows.engine.attempt-finished", runId: "run-42", occurredAt: "1758182301770", payload: `{ "state": "failed" }` }
    ]
  },
  {
    id: "transcript",
    label: "transcript",
    note: "TranscriptRow",
    tone: "warn",
    selector: `{ _tag: "transcript", runId: "run-42" }`,
    runId: "run-42",
    value: "1184",
    offset: "2",
    delta: "appends the event's rows",
    columns: ["turn", "kind", "callId", "text"],
    fields: ["runId", "sequence", "turn", "at", "kind", "callId", "text"],
    rows: [
      { id: "t1181", runId: "run-42", sequence: "1181", turn: "18", at: "1758182377401", kind: "assistant", callId: "call_7c02", text: "publishing 12 of 50 packages" },
      { id: "t1178", runId: "run-42", sequence: "1178", turn: "17", at: "1758182291002", kind: "tool-result", callId: "call_7bf9", text: "npm ERR! 401 Unauthorized" }
    ]
  },
  {
    id: "run-tree",
    label: "run-tree",
    note: "RunTreeRow",
    tone: "info",
    selector: `{ _tag: "run-tree", runId: "run-42" }`,
    runId: "run-42",
    value: "1184",
    offset: "0",
    delta: "replaces every node",
    columns: ["nodeId", "label", "status", "seat"],
    fields: ["runId", "nodeId", "label", "status", "seat", "startedAt", "endedAt", "parentRunId"],
    rows: [
      { id: "n12", runId: "run-42", nodeId: "12", label: "publish", status: "running", seat: "opus-5", startedAt: "1758182201004", endedAt: "—", parentRunId: "—" },
      { id: "n11", runId: "run-42", nodeId: "11", label: "verify", status: "failed", seat: "gpt-6-astra", startedAt: "1758181904220", endedAt: "1758182199881", parentRunId: "—" }
    ]
  },
  {
    id: "approvals",
    label: "approvals",
    note: "ApprovalRow",
    tone: "bad",
    selector: `{ _tag: "approvals" }`,
    runId: "null",
    value: "0",
    offset: "0",
    delta: "replaces every gate",
    columns: ["runId", "requestId", "title", "status"],
    fields: ["runId", "waitRunId", "questionProvenance", "requestId", "title", "payload", "requestedAt", "status"],
    rows: [
      { id: "req_2a07", runId: "run-42", waitRunId: "run-42-n12", questionProvenance: "events", requestId: "req_2a07", title: "publish 38 packages to npm", payload: "HumanTask", requestedAt: "1758182380117", status: "pending" },
      { id: "req_19f4", runId: "run-39", waitRunId: "—", questionProvenance: "legacy-observation", requestId: "req_19f4", title: "force deploy to canary", payload: "HumanTask", requestedAt: "1758179001440", status: "approved" }
    ]
  },
  {
    id: "node-output",
    label: "node-output",
    note: "NodeOutputRow",
    tone: "muted",
    selector: `{ _tag: "node-output", runId: "run-42", nodeId: "11" }`,
    runId: "run-42",
    value: "1180",
    offset: "0",
    delta: "replaces the output",
    columns: ["nodeId", "outcome", "settledAt"],
    fields: ["runId", "nodeId", "outcome", "output", "settledAt"],
    rows: [
      { id: "o11", runId: "run-42", nodeId: "11", outcome: "failure", output: "npm ERR! 401 Unauthorized", settledAt: "1758182199881" }
    ]
  }
]

export const Pane = pane({
  id: "projections",
  title: "Projections",
  summary: "Any gateway projection, by cursor, row by row",
  packages: ["@smthrs/gateway"],
  render: (context) => <ProjectionsBody {...context} />
})

function ProjectionsBody({ props, set: runCommandSet }: ExperimentalPaneContext) {
  const projection = typeof props.projection === "string" ? props.projection : "run-events"
  const row = typeof props.row === "string" ? props.row : ""
  const selected = PROJECTIONS.find((entry) => entry.id === projection)
  const expanded = selected?.rows.find((entry) => entry.id === row)
  return (
    <Split
      left={
        <>
          <Section title="Projections"><Rail items={PROJECTIONS} selected={projection} onSelect={(id) => runCommandSet("projection", id)} /></Section>
          <Section title="Cursor">
            <Facts rows={[
              { label: "selector", value: selected?.selector ?? "—", mono: true },
              { label: "projection", value: projection, mono: true },
              { label: "runId", value: selected?.runId ?? "—", mono: true },
              { label: "value", value: selected?.value ?? "—", mono: true },
              { label: "offset", value: selected?.offset ?? "—", mono: true }
            ]} />
          </Section>
        </>
      }
      right={
        <>
          <Section title="Subscription" right={<Badge tone="ok">Projection.Subscribe</Badge>}>
            <Steps steps={[
              { id: "1", label: "snapshot-start", note: `cursor ${selected?.value ?? "0"}`, tone: "muted" },
              { id: "2", label: "row", note: `${selected?.rows.length ?? 0} frames`, tone: "info" },
              { id: "3", label: "snapshot-end", note: `cursor ${selected?.value ?? "0"}`, tone: "ok" },
              { id: "4", label: "delta", note: selected?.delta ?? "—", tone: "info" },
              { id: "5", label: "heartbeat", note: "keepalive", tone: "muted" }
            ]} />
          </Section>
          <Section title="Rows" right={<Badge tone={selected?.tone ?? "muted"}>{selected?.note ?? "—"}</Badge>}>
            <Table
              columns={(selected?.columns ?? []).map((key) => ({ key, label: key, mono: true }))}
              rows={selected?.rows ?? []}
              selected={row}
              onSelect={(id) => runCommandSet("row", id)}
              empty="No rows at this cursor."
            />
          </Section>
          {expanded === undefined ? null : (
            <Section title="Row" right={<Badge tone="muted">{expanded.id}</Badge>}>
              <Facts rows={(selected?.fields ?? []).map((key) => ({
                label: key,
                value: expanded[key] ?? "—",
                mono: true
              }))} />
            </Section>
          )}
        </>
      }
    />
  )
}

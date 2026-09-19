/*
 * Mock: Notifications. Behind VITE_SMITHERS_EXPERIMENTAL, reached by
 * `/experimental.notifications`. Self-contained on purpose — see ../Pane.ts.
 *
 * The queue is not a list: it is a fold of `flows/notifications/Admitted` and
 * `flows/notifications/Promoted` journal records, and `NotificationState` is
 * what that fold leaves. So the drawing is the derivation — the decision each
 * admission committed, the record a `rejected-full` never wrote, the boundary
 * that promoted, and whether the notification came from a person or a
 * machine. Fields belong to `Notification`, `NotificationEvent`,
 * `NotificationState`, `NotificationQueue`, `AlertPolicy` and `AlertSink`.
 */
import { pane, type ExperimentalPaneContext } from "../Pane"
import { Badge, Code, Facts, Section, Split, Steps, Table } from "../Primitives"

const PROJECTION = [
  { id: "p41", label: "Admitted", note: "human-steer · admitted · items 1", tone: "ok" as const },
  { id: "p42", label: "Admitted", note: "system-event · admitted · items 2", tone: "ok" as const },
  { id: "p43", label: "Admitted", note: "system-event · coalesced · items 2", tone: "warn" as const },
  { id: "p44", label: "Admitted", note: "human-followup · admitted · items 3", tone: "ok" as const },
  { id: "p47", label: "Promoted", note: "turn-close · 1 id · items 2", tone: "info" as const }
]

const RECEIPTS = [
  {
    rid: "r1",
    id: "ntf_9c21a4",
    tag: "human-steer",
    origin: "human" as const,
    delivery: "steer",
    decision: "admitted",
    tone: "ok" as const,
    seq: "41",
    duplicate: "no",
    lineage: "lin_main",
    coalescing: "—",
    fingerprint: "sha256:4d9f…713e",
    actor: "will",
    sourceRunId: "run_8c31f0",
    sourceLineageId: "lin_main",
    sourceTurn: 12,
    payload: `{ "kind": "Message", "text": "stop after the failing test" }`,
    pending: false
  },
  {
    rid: "r2",
    id: "ntf_4d07be",
    tag: "system-event",
    origin: "system" as const,
    delivery: "queue",
    decision: "admitted",
    tone: "ok" as const,
    seq: "42",
    duplicate: "no",
    lineage: "lin_main",
    coalescing: "run_8c31f0:stalled",
    fingerprint: "sha256:9e91…cb95",
    actor: "alert-runtime",
    sourceRunId: "run_8c31f0",
    sourceLineageId: "lin_main",
    sourceTurn: 12,
    payload: `{ "condition": "stalled", "severity": "warning" }`,
    pending: false
  },
  {
    rid: "r3",
    id: "ntf_6f3d1c",
    tag: "system-event",
    origin: "system" as const,
    delivery: "queue",
    decision: "coalesced",
    tone: "warn" as const,
    seq: "43",
    duplicate: "no",
    lineage: "lin_main",
    coalescing: "run_8c31f0:stalled",
    fingerprint: "sha256:6496…0196",
    actor: "alert-runtime",
    sourceRunId: "run_8c31f0",
    sourceLineageId: "lin_main",
    sourceTurn: 13,
    payload: `{ "condition": "stalled", "severity": "critical" }`,
    pending: true
  },
  {
    rid: "r4",
    id: "ntf_77e0c3",
    tag: "human-followup",
    origin: "human" as const,
    delivery: "queue",
    decision: "admitted",
    tone: "ok" as const,
    seq: "44",
    duplicate: "no",
    lineage: "lin_main",
    coalescing: "—",
    fingerprint: "sha256:18b6…0e04",
    actor: "will",
    sourceRunId: "run_8c31f0",
    sourceLineageId: "lin_main",
    sourceTurn: 13,
    payload: `{ "kind": "Thinking", "level": "high" }`,
    pending: true
  },
  {
    rid: "r5",
    id: "ntf_9c21a4",
    tag: "human-steer",
    origin: "human" as const,
    delivery: "steer",
    decision: "admitted",
    tone: "muted" as const,
    seq: "41",
    duplicate: "yes",
    lineage: "lin_main",
    coalescing: "—",
    fingerprint: "sha256:4d9f…713e",
    actor: "will",
    sourceRunId: "run_8c31f0",
    sourceLineageId: "lin_main",
    sourceTurn: 12,
    payload: `{ "kind": "Message", "text": "stop after the failing test" }`,
    pending: false
  },
  {
    rid: "r6",
    id: "ntf_b5518f",
    tag: "system-event",
    origin: "system" as const,
    delivery: "queue",
    decision: "rejected-full",
    tone: "bad" as const,
    seq: "—",
    duplicate: "no",
    lineage: "lin_probe",
    coalescing: "—",
    fingerprint: "sha256:c8fc…84f0",
    actor: "harness",
    sourceRunId: "run_1f77a0",
    sourceLineageId: "lin_probe",
    sourceTurn: 4,
    payload: `{ "condition": "quota-parked", "severity": "info" }`,
    pending: false
  }
]

const DELIVERIES = [
  {
    id: "alert:run_8c31f0:stalled:1758204300000",
    condition: "stalled",
    severity: "warning",
    event: "flows.alerts.delivered",
    status: "202",
    code: "—",
    tone: "ok" as const
  },
  {
    id: "alert:run_8c31f0:waiting-approval:1758203100000",
    condition: "waiting-approval",
    severity: "critical",
    event: "flows.alerts.failed",
    status: "503",
    code: "sink_rejected",
    tone: "bad" as const
  },
  {
    id: "alert:run_4a1b77:quota-parked:1758201900000",
    condition: "quota-parked",
    severity: "info",
    event: "flows.alerts.failed",
    status: "—",
    code: "sink_timeout",
    tone: "warn" as const
  },
  {
    id: "alert:run_ff0a13:failed:1758198300000",
    condition: "failed",
    severity: "critical",
    event: "flows.alerts.delivered",
    status: "200",
    code: "—",
    tone: "ok" as const
  }
]

const RULES = `rules:
  waiting-approval  afterMs 900000    critical  owner @fucory
  failed            afterMs 0         critical  owner @fucory
  stalled           afterMs 1800000   warning
  quota-parked      afterMs 300000    info`

export const Pane = pane({
  id: "notifications",
  title: "Notifications",
  summary: "The queue, its admission policy and its sinks",
  packages: ["@smthrs/notifications"],
  render: (context) => <NotificationsBody {...context} />
})

function NotificationsBody({ props, set: runCommandSet }: ExperimentalPaneContext) {
  const rid = typeof props.rid === "string" ? props.rid : "r3"
  const receipt = RECEIPTS.find((row) => row.rid === rid)
  return (
    <Split
      left={
        <>
          <Section title="Projection" right="flows/notifications">
            <Steps steps={PROJECTION} />
          </Section>
          <Section title="NotificationState">
            <Facts rows={[
              { label: "capacity", value: "128", mono: true },
              { label: "items", value: "2", mono: true },
              { label: "steer", value: "0", mono: true },
              { label: "queue", value: "2", mono: true },
              { label: "cursor", value: "seq 47", mono: true }
            ]} />
          </Section>
          <Section title="AlertPolicy" right={<Badge tone="info">4 detectors</Badge>}>
            <Code>{RULES}</Code>
          </Section>
        </>
      }
      right={
        <>
          <Section title="Admissions" right="admitted · coalesced · rejected-full">
            <Table
              columns={[
                { key: "notification", label: "notificationId", mono: true },
                { key: "tag", label: "_tag" },
                { key: "delivery", label: "delivery" },
                { key: "decision", label: "decision" },
                { key: "seq", label: "seq", mono: true, right: true }
              ]}
              rows={RECEIPTS.map((row) => ({
                id: row.rid,
                notification: row.id,
                tag: <Badge tone={row.origin === "human" ? "info" : "muted"}>{row.tag}</Badge>,
                delivery: row.delivery,
                decision: <Badge tone={row.tone}>{row.decision}</Badge>,
                seq: row.seq
              }))}
              selected={rid}
              onSelect={(id) => runCommandSet("rid", id)}
            />
          </Section>
          {receipt === undefined ? null : (
            <Section
              title="Notification"
              right={<Badge tone={receipt.seq === "—" ? "bad" : "ok"}>{receipt.seq === "—" ? "nothing written" : `seq ${receipt.seq}`}</Badge>}
            >
              <Facts rows={[
                { label: "targetLineageId", value: receipt.lineage, mono: true },
                { label: "coalescingKey", value: receipt.coalescing, mono: true },
                { label: "fingerprint", value: receipt.fingerprint, mono: true },
                { label: "duplicate", value: receipt.duplicate },
                { label: "sourceActor", value: receipt.actor, mono: true },
                { label: "sourceRunId", value: receipt.sourceRunId, mono: true },
                { label: "sourceLineageId", value: receipt.sourceLineageId, mono: true },
                { label: "sourceTurn", value: receipt.sourceTurn, mono: true },
                { label: "pending", value: receipt.pending ? "yes" : "no" }
              ]} />
              <Code label="payload">{receipt.payload}</Code>
            </Section>
          )}
          <Section title="Drain" right={<Badge tone="ok">turn-close</Badge>}>
            <Facts rows={[
              { label: "runId", value: "run_8c31f0", mono: true },
              { label: "targetLineageId", value: "lin_main", mono: true },
              { label: "boundary", value: "turn-close", mono: true },
              { label: "cutoffSeq", value: "45", mono: true },
              { label: "wouldIdle", value: "no" },
              { label: "promoted", value: "ntf_9c21a4", mono: true },
              { label: "duplicate", value: "no" }
            ]} />
          </Section>
          <Section title="Sink" right="layerWebhook">
            <Facts rows={[
              { label: "url", value: "https://pager.internal/smithers", mono: true },
              { label: "Idempotency-Key", value: "alertId(alert)", mono: true },
              { label: "timeout", value: "10 s", mono: true },
              { label: "redirect", value: "manual" }
            ]} />
            <Table
              columns={[
                { key: "id", label: "alertId", mono: true },
                { key: "severity", label: "severity" },
                { key: "event", label: "eventType", mono: true },
                { key: "code", label: "code", right: true }
              ]}
              rows={DELIVERIES.map((row) => ({
                id: row.id,
                severity: <Badge tone={row.tone}>{row.severity}</Badge>,
                event: row.event,
                code: row.code
              }))}
            />
          </Section>
        </>
      }
    />
  )
}

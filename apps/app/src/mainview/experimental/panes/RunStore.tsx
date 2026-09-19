/*
 * Mock: Run store. Behind VITE_SMITHERS_EXPERIMENTAL, reached by
 * `/experimental.run-store`. Self-contained on purpose — see ../Pane.ts.
 *
 * What a person stares at when a run is stuck: which process holds the
 * `flows_runs` owner fence and how old its heartbeat is, what every claim path
 * answered, every `flows_attempts` row with why it ended, the
 * `flows_run_parents` lineage, and the next `flows_clock_deadlines` row that
 * will wake it.
 */
import { pane, type ExperimentalPaneContext } from "../Pane"
import { Badge, Facts, Graph, Section, Split, Steps, Table } from "../Primitives"

type Tone = "ok" | "warn" | "bad" | "info" | "muted"

interface AttemptMock {
  readonly id: string
  readonly stepKeyDigest: string
  readonly attempt: number
  readonly state: string
  readonly tone: Tone
  readonly startedAtMs: string
  readonly ended: string
}

interface RunMock {
  readonly id: string
  readonly status: string
  readonly tone: Tone
  readonly depth: number
  readonly lane: number
  readonly owner: string
  readonly heartbeat: string
  readonly claim: string
  readonly createdAtMs: string
  readonly startedAtMs: string
  readonly finishedAtMs: string
  readonly cancelRequestedAtMs: string
  readonly waiting: string
  readonly lineage: string
  readonly parentRunId: string
  readonly revision: number
  readonly ladder: ReadonlyArray<{ readonly id: string; readonly label: string; readonly note: string; readonly tone: Tone }>
  readonly attempts: ReadonlyArray<AttemptMock>
}

const RUNS: ReadonlyArray<RunMock> = [
  {
    id: "run_2f10bc",
    status: "completed",
    tone: "ok",
    depth: 0,
    lane: 1,
    owner: "—",
    heartbeat: "—",
    claim: "—",
    createdAtMs: "1 758 141 780 004",
    startedAtMs: "1 758 141 780 120",
    finishedAtMs: "1 758 141 998 733",
    cancelRequestedAtMs: "—",
    waiting: "—",
    lineage: "lin_7742 · round 0",
    parentRunId: "—",
    revision: 4102,
    ladder: [
      { id: "1", label: "claimAndOwn", note: "Activated", tone: "ok" },
      { id: "2", label: "heartbeat", note: "Updated · 219 pulses", tone: "ok" },
      { id: "3", label: "transition", note: "Transitioned · completed", tone: "ok" },
      { id: "4", label: "owner columns", note: "NULL on exit", tone: "muted" }
    ],
    attempts: [
      { id: "a1", stepKeyDigest: "key1_a71d03…5b6e", attempt: 0, state: "succeeded", tone: "ok", startedAtMs: "1 758 141 780 140", ended: `outcome_json { "diagnostics": 0 }` },
      { id: "a2", stepKeyDigest: "key1_0c4ab8…77f2", attempt: 0, state: "succeeded", tone: "ok", startedAtMs: "1 758 141 802 110", ended: `outcome_json { "failed": 0 }` }
    ]
  },
  {
    id: "run_8ac431",
    status: "running",
    tone: "info",
    depth: 1,
    lane: 1,
    owner: "mac-studio-01 · 4417 · 6f1c0a2d",
    heartbeat: "1 758 142 042 512 · 41 s ago",
    claim: "—",
    createdAtMs: "1 758 142 003 900",
    startedAtMs: "1 758 142 004 001",
    finishedAtMs: "—",
    cancelRequestedAtMs: "1 758 142 240 118",
    waiting: "—",
    lineage: "lin_7742 · round 1",
    parentRunId: "run_2f10bc",
    revision: 4812,
    ladder: [
      { id: "1", label: "heartbeat", note: "FenceLost", tone: "bad" },
      { id: "2", label: "claim", note: "AlreadyClaimed", tone: "warn" },
      { id: "3", label: "claimAndOwn", note: "EvidenceRequired", tone: "warn" },
      { id: "4", label: "steal", note: "LivenessUnconfirmed", tone: "bad" },
      { id: "5", label: "transition", note: "GuardFailed · cancelRequested", tone: "bad" }
    ],
    attempts: [
      { id: "b1", stepKeyDigest: "key1_5b2077…ff41", attempt: 0, state: "succeeded", tone: "ok", startedAtMs: "1 758 142 004 140", ended: `outcome_json { "artifact": "b309fa…d41c" }` },
      { id: "b2", stepKeyDigest: "key1_2fa8d6…b590", attempt: 0, state: "failed", tone: "bad", startedAtMs: "1 758 142 042 400", ended: `error_json { "_tag": "ProcessExited", "code": 1 }` },
      { id: "b3", stepKeyDigest: "key1_2fa8d6…b590", attempt: 1, state: "running", tone: "info", startedAtMs: "1 758 142 042 512", ended: "—" },
      { id: "b4", stepKeyDigest: "key1_e80c15…3d42", attempt: 0, state: "retrying", tone: "warn", startedAtMs: "1 758 142 233 781", ended: `error_json { "_tag": "RateLimited" }` }
    ]
  },
  {
    id: "run_c04e77",
    status: "suspended",
    tone: "warn",
    depth: 2,
    lane: 0,
    owner: "—",
    heartbeat: "—",
    claim: "mac-studio-01 · 4417 · 6f1c0a2d",
    createdAtMs: "1 758 142 042 600",
    startedAtMs: "1 758 142 042 640",
    finishedAtMs: "—",
    cancelRequestedAtMs: "—",
    waiting: "clock · wake 1 758 142 342 512 · wait_sign",
    lineage: "—",
    parentRunId: "run_8ac431",
    revision: 4780,
    ladder: [
      { id: "1", label: "transition", note: "Transitioned · suspended", tone: "ok" },
      { id: "2", label: "owner columns", note: "NULL while suspended", tone: "muted" },
      { id: "3", label: "claim", note: "Claimed · awaiting activate", tone: "info" },
      { id: "4", label: "activate", note: "blocked · wake not due", tone: "warn" }
    ],
    attempts: [
      { id: "c1", stepKeyDigest: "key1_9e0743…21ac", attempt: 0, state: "succeeded", tone: "ok", startedAtMs: "1 758 142 042 641", ended: `outcome_json { "merged": 2 }` }
    ]
  },
  {
    id: "run_51db9e",
    status: "failed",
    tone: "bad",
    depth: 2,
    lane: 2,
    owner: "—",
    heartbeat: "—",
    claim: "—",
    createdAtMs: "1 758 142 043 010",
    startedAtMs: "1 758 142 043 088",
    finishedAtMs: "1 758 142 233 902",
    cancelRequestedAtMs: "1 758 142 233 700",
    waiting: "—",
    lineage: "—",
    parentRunId: "run_8ac431",
    revision: 4801,
    ladder: [
      { id: "1", label: "requestCancel", note: "CancelRequested", tone: "warn" },
      { id: "2", label: "transition", note: "Transitioned · failed", tone: "bad" },
      { id: "3", label: "cancel_acknowledgement_json", note: "recorded", tone: "muted" },
      { id: "4", label: "requestCancel", note: "Terminal · failed", tone: "muted" }
    ],
    attempts: [
      { id: "d1", stepKeyDigest: "key1_c41902…0a7d", attempt: 0, state: "failed", tone: "bad", startedAtMs: "1 758 142 043 090", ended: `error_json { "_tag": "CacheConflict" }` },
      { id: "d2", stepKeyDigest: "key1_c41902…0a7d", attempt: 1, state: "cancelled", tone: "muted", startedAtMs: "1 758 142 233 705", ended: `error_json { "_tag": "CancelRequested" }` }
    ]
  }
]

const EDGES: ReadonlyArray<readonly [string, string]> = [
  ["run_2f10bc", "run_8ac431"],
  ["run_8ac431", "run_c04e77"],
  ["run_8ac431", "run_51db9e"]
]

const DEADLINES = [
  { id: "1", clockName: "sign-timeout", deferredName: "wait_sign", dueAtMs: "1 758 142 342 512", due: "in 4 m 58 s", tone: "info" as const },
  { id: "2", clockName: "publish-window", deferredName: "wait_publish", dueAtMs: "1 758 145 942 512", due: "in 1 h 4 m", tone: "muted" as const }
]

export const Pane = pane({
  id: "run-store",
  title: "Run store",
  summary: "Who owns a run, its attempts, its fence and its next deadline",
  packages: ["@smthrs/run-store", "@smthrs/engine"],
  render: (context) => <RunStoreBody {...context} />
})

function RunStoreBody({ props, set: runCommandSet }: ExperimentalPaneContext) {
  const runId = typeof props.runId === "string" ? props.runId : "run_8ac431"
  const run = RUNS.find((entry) => entry.id === runId) ?? RUNS[0]
  return (
    <Split
      left={
        <>
          <Section title="Lease">
            <Facts rows={[
              { label: "heartbeatInterval", value: "1 s", mono: true },
              { label: "heartbeatStaleAfter", value: "30 s", mono: true },
              { label: "heartbeatSkewAllowance", value: "10 s", mono: true },
              { label: "heartbeatWriteTolerance", value: "19 s", mono: true }
            ]} />
          </Section>
          <Section title="flows_clock_deadlines">
            <Table
              columns={[
                { key: "clockName", label: "clock_name", mono: true },
                { key: "due", label: "Due", right: true }
              ]}
              rows={DEADLINES.map((row) => ({
                id: row.id,
                clockName: row.clockName,
                due: <Badge tone={row.tone}>{row.due}</Badge>
              }))}
            />
          </Section>
          <Section title="flows_deferred_completions">
            <Facts rows={[
              { label: "deferred_name", value: "wait_review", mono: true },
              { label: "completed_at_ms", value: "1 758 142 101 004", mono: true },
              { label: "consumed_at_ms", value: <Badge tone="warn">null</Badge> }
            ]} />
          </Section>
        </>
      }
      right={
        <>
          <Section title="Lineage" right={<Badge tone="muted">flows_run_parents</Badge>}>
            <Graph
              nodes={RUNS.map((entry) => ({
                id: entry.id,
                label: entry.id,
                depth: entry.depth,
                lane: entry.lane,
                tone: entry.tone
              }))}
              edges={EDGES}
              selected={runId}
              onSelect={(id) => runCommandSet("runId", id)}
            />
          </Section>
          {run === undefined ? null : (
            <>
              <Section title={run.id} right={<Badge tone={run.tone}>{run.status}</Badge>}>
                <Facts rows={[
                  { label: "owner", value: run.owner, mono: true },
                  { label: "heartbeat_at_ms", value: run.heartbeat, mono: true },
                  { label: "claim", value: run.claim, mono: true },
                  { label: "started_at_ms", value: run.startedAtMs, mono: true },
                  { label: "finished_at_ms", value: run.finishedAtMs, mono: true },
                  { label: "cancel_requested_at_ms", value: run.cancelRequestedAtMs, mono: true },
                  { label: "waiting", value: run.waiting, mono: true },
                  { label: "parent_run_id", value: run.parentRunId, mono: true },
                  { label: "lineage", value: run.lineage, mono: true },
                  { label: "revision", value: run.revision, mono: true }
                ]} />
              </Section>
              <Section title="Ownership">
                <Steps steps={run.ladder} />
              </Section>
              <Section title="flows_attempts" right={`${run.attempts.length} rows`}>
                <Table
                  columns={[
                    { key: "stepKeyDigest", label: "step_key_digest", mono: true },
                    { key: "attempt", label: "#", mono: true, right: true },
                    { key: "state", label: "state" },
                    { key: "ended", label: "Why it ended", mono: true }
                  ]}
                  rows={run.attempts.map((row) => ({
                    id: row.id,
                    stepKeyDigest: row.stepKeyDigest,
                    attempt: row.attempt,
                    state: <Badge tone={row.tone}>{row.state}</Badge>,
                    ended: row.ended
                  }))}
                  empty="No attempts."
                />
              </Section>
            </>
          )}
        </>
      }
    />
  )
}

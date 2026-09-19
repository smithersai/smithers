/*
 * Mock: Triggers. Behind VITE_SMITHERS_EXPERIMENTAL, reached by
 * `/experimental.triggers`. Self-contained on purpose — see ../Pane.ts.
 *
 * The shipped card lists triggers and their next occurrences. The half it
 * cannot show is the half that decides: the claim an occurrence won or was
 * refused, the overlap action behind a fire that never ran, what a catch-up
 * policy owes after downtime, and the raw bytes a channel verified before
 * anything decoded them. Every row is a column of `flows_triggers` or
 * `flows_trigger_fires`, or a field of `ClaimDecision`, `Overlap`, `CatchUp`,
 * `Channel` and `Webhook`.
 */
import { pane, type ExperimentalPaneContext } from "../Pane"
import { Badge, Code, Facts, Graph, Rail, Section, Split, Steps, Table } from "../Primitives"

const TRIGGERS = [
  { id: "pr-triage", label: "pr-triage", note: "*/5 * * * *", tone: "info" as const },
  { id: "nightly-audit", label: "nightly-audit", note: "0 3 * * *", tone: "muted" as const },
  { id: "weekly-digest", label: "weekly-digest", note: "0 9 * * 1", tone: "muted" as const },
  { id: "stale-sweep", label: "stale-sweep", note: "disabled", tone: "bad" as const }
]

const DECLARATIONS = [
  {
    id: "pr-triage",
    flow_id: "triage.pull-request",
    input_json: `{"repo":"smithersai/smithers","label":"needs-triage"}`,
    cron: "*/5 * * * *",
    timezone: "UTC",
    overlap: "supersede",
    catch_up: "one",
    max_catch_up: 12,
    enabled: true,
    revision: 7,
    last_fired_at_ms: "14:35:00Z",
    pending_at_ms: "—",
    active_run_id: "trigger-reservation:pr-triage:1758205200000",
    owed: "1 occurrence, 14:40:00Z",
    bound: "within 12"
  },
  {
    id: "nightly-audit",
    flow_id: "audit.packages",
    input_json: `{"scope":"packages/*"}`,
    cron: "0 3 * * *",
    timezone: "America/New_York",
    overlap: "skip",
    catch_up: "none",
    max_catch_up: 0,
    enabled: true,
    revision: 2,
    last_fired_at_ms: "03:00:00Z",
    pending_at_ms: "—",
    active_run_id: "—",
    owed: "none",
    bound: "policy none"
  },
  {
    id: "weekly-digest",
    flow_id: "digest.weekly",
    input_json: `{"channel":"#smithers"}`,
    cron: "0 9 * * 1",
    timezone: "UTC",
    overlap: "buffer-one",
    catch_up: "all",
    max_catch_up: 3,
    enabled: true,
    revision: 4,
    last_fired_at_ms: "09:00:00Z (Mon)",
    pending_at_ms: "09:00:00Z (Mon +1w)",
    active_run_id: "run_4a1b77",
    owed: "4 missed",
    bound: "catch_up_bound_exceeded"
  },
  {
    id: "stale-sweep",
    flow_id: "sweep.stale-branches",
    input_json: `{"olderThanDays":30}`,
    cron: "0 */6 * * *",
    timezone: "UTC",
    overlap: "skip",
    catch_up: "one",
    max_catch_up: 4,
    enabled: false,
    revision: 11,
    last_fired_at_ms: "06:00:00Z",
    pending_at_ms: "—",
    active_run_id: "—",
    owed: "1 occurrence, 18:00:00Z",
    bound: "trigger_disabled"
  }
]

const FIRES = [
  {
    id: "1758205200000",
    trigger: "pr-triage",
    at: "14:40:00Z",
    outcome: "—",
    tone: "info" as const,
    run_id: "trigger-reservation:pr-triage:1758205200000",
    action: "supersede",
    lease: "Expired",
    running: "yes",
    pending: "—",
    expected_revision: 7,
    refusal: "—",
    writes: [
      { id: "w1", label: "ReleaseReservation", note: "expected trigger-reservation:pr-triage:1758204900000", tone: "warn" as const },
      { id: "w2", label: "SetOutcome", note: "superseded · whileOpen", tone: "warn" as const },
      { id: "w3", label: "SetRunId", note: "run_8c31f0", tone: "info" as const },
      { id: "w4", label: "Reserve", note: "claimedAt 14:40:00Z", tone: "ok" as const }
    ]
  },
  {
    id: "1758204900000",
    trigger: "pr-triage",
    at: "14:35:00Z",
    outcome: "launched",
    tone: "ok" as const,
    run_id: "run_8c31f0",
    action: "fire",
    lease: "Idle",
    running: "no",
    pending: "—",
    expected_revision: 7,
    refusal: "—",
    writes: [{ id: "w1", label: "Reserve", note: "claimedAt 14:35:00Z", tone: "ok" as const }]
  },
  {
    id: "1758204600000",
    trigger: "pr-triage",
    at: "14:30:00Z",
    outcome: "superseded",
    tone: "warn" as const,
    run_id: "run_8c31f0",
    action: "supersede",
    lease: "Held",
    running: "yes",
    pending: "—",
    expected_revision: 6,
    refusal: "revision_mismatch",
    writes: []
  },
  {
    id: "1758204300000",
    trigger: "pr-triage",
    at: "14:25:00Z",
    outcome: "completed",
    tone: "ok" as const,
    run_id: "run_71ae02",
    action: "fire",
    lease: "Idle",
    running: "no",
    pending: "—",
    expected_revision: 6,
    refusal: "—",
    writes: [{ id: "w1", label: "AdvanceCursor", note: "14:25:00Z", tone: "ok" as const }]
  },
  {
    id: "1758157200000",
    trigger: "nightly-audit",
    at: "03:00:00Z",
    outcome: "launched",
    tone: "ok" as const,
    run_id: "run_02d9c4",
    action: "fire",
    lease: "Idle",
    running: "no",
    pending: "—",
    expected_revision: 2,
    refusal: "—",
    writes: [{ id: "w1", label: "Reserve", note: "claimedAt 03:00:00Z", tone: "ok" as const }]
  },
  {
    id: "1758070800000",
    trigger: "nightly-audit",
    at: "03:00:00Z (−1d)",
    outcome: "skipped",
    tone: "muted" as const,
    run_id: "—",
    action: "skip",
    lease: "Held",
    running: "yes",
    pending: "—",
    expected_revision: 2,
    refusal: "—",
    writes: [
      { id: "w1", label: "SetOutcome", note: "skipped", tone: "muted" as const },
      { id: "w2", label: "AdvanceCursor", note: "03:00:00Z (−1d)", tone: "ok" as const }
    ]
  },
  {
    id: "1757842800000",
    trigger: "weekly-digest",
    at: "09:00:00Z (Mon)",
    outcome: "buffered",
    tone: "warn" as const,
    run_id: "—",
    action: "buffer",
    lease: "Held",
    running: "yes",
    pending: "09:00:00Z (Mon)",
    expected_revision: 4,
    refusal: "—",
    writes: [
      { id: "w1", label: "SetOutcome", note: "buffered", tone: "warn" as const },
      { id: "w2", label: "AdvanceCursor", note: "09:00:00Z (Mon)", tone: "ok" as const },
      { id: "w3", label: "SetPending", note: "09:00:00Z (Mon)", tone: "warn" as const }
    ]
  },
  {
    id: "1757238000000",
    trigger: "weekly-digest",
    at: "09:00:00Z (Mon −1w)",
    outcome: "failed",
    tone: "bad" as const,
    run_id: "run_ff0a13",
    action: "fire",
    lease: "Idle",
    running: "no",
    pending: "—",
    expected_revision: 4,
    refusal: "—",
    writes: [{ id: "w1", label: "AdvanceCursor", note: "09:00:00Z (Mon −1w)", tone: "ok" as const }]
  },
  {
    id: "1758132000000",
    trigger: "stale-sweep",
    at: "18:00:00Z",
    outcome: "—",
    tone: "bad" as const,
    run_id: "—",
    action: "—",
    lease: "Idle",
    running: "no",
    pending: "—",
    expected_revision: 11,
    refusal: "trigger_disabled",
    writes: []
  }
]

const INBOUND = `{
  "start": {
    "flowId": "triage.pull-request",
    "input": { "number": 4412, "action": "opened" }
  }
}`

const LEASES = ["Held", "Expired", "Idle"]
const ACTIONS = ["skip", "fire", "buffer", "supersede"]

export const Pane = pane({
  id: "triggers",
  title: "Triggers",
  summary: "Cron rules, their fires, and the claim and overlap decisions",
  packages: ["@smthrs/triggers"],
  render: (context) => <TriggersBody {...context} />
})

function TriggersBody({ props, set: runCommandSet }: ExperimentalPaneContext) {
  const trigger = typeof props.trigger === "string" ? props.trigger : "pr-triage"
  const fire = typeof props.fire === "string" ? props.fire : "1758205200000"
  const declaration = DECLARATIONS.find((row) => row.id === trigger) ?? DECLARATIONS[0]!
  const fires = FIRES.filter((row) => row.trigger === trigger)
  const claim = fires.find((row) => row.id === fire)
  const lit = (on: boolean) => (on ? ("info" as const) : ("muted" as const))
  const nodes = [
    { id: "claim", label: "claimFire", depth: 0, lane: 1, tone: "info" as const },
    {
      id: "refuse",
      label: "refuse",
      depth: 1,
      lane: 1,
      tone: claim !== undefined && claim.refusal !== "—" ? ("bad" as const) : ("ok" as const)
    },
    ...LEASES.map((name, index) => ({
      id: name,
      label: name,
      depth: 2,
      lane: index,
      tone: lit(claim?.lease === name)
    })),
    { id: "decide", label: "Overlap.decide", depth: 3, lane: 1, tone: "info" as const },
    ...ACTIONS.map((name, index) => ({
      id: name,
      label: name,
      depth: 4,
      lane: index,
      tone: lit(claim?.action === name)
    }))
  ]
  const edges: ReadonlyArray<readonly [string, string]> = [
    ["claim", "refuse"],
    ...LEASES.map((name) => ["refuse", name] as const),
    ...LEASES.map((name) => [name, "decide"] as const),
    ...ACTIONS.map((name) => ["decide", name] as const)
  ]
  return (
    <Split
      left={
        <>
          <Section title="Triggers"><Rail items={TRIGGERS} selected={trigger} onSelect={(id) => runCommandSet("trigger", id)} /></Section>
          <Section
            title="flows_triggers"
            right={<Badge tone={declaration.enabled ? "ok" : "bad"}>{declaration.enabled ? "enabled" : "disabled"}</Badge>}
          >
            <Facts rows={[
              { label: "flow_id", value: declaration.flow_id, mono: true },
              { label: "input_json", value: declaration.input_json, mono: true },
              { label: "cron", value: declaration.cron, mono: true },
              { label: "timezone", value: declaration.timezone, mono: true },
              { label: "overlap", value: <Badge tone="info">{declaration.overlap}</Badge> },
              { label: "revision", value: declaration.revision, mono: true },
              { label: "last_fired_at_ms", value: declaration.last_fired_at_ms, mono: true },
              { label: "pending_at_ms", value: declaration.pending_at_ms, mono: true },
              { label: "active_run_id", value: declaration.active_run_id, mono: true }
            ]} />
          </Section>
        </>
      }
      right={
        <>
          <Section title="flows_trigger_fires" right={`${fires.length} rows`}>
            <Table
              columns={[
                { key: "at", label: "occurrence_at_ms", mono: true },
                { key: "outcome", label: "outcome" },
                { key: "action", label: "action" },
                { key: "run", label: "run_id", mono: true, right: true }
              ]}
              rows={fires.map((row) => ({
                id: row.id,
                at: row.at,
                outcome: <Badge tone={row.tone}>{row.outcome}</Badge>,
                action: row.action,
                run: row.run_id
              }))}
              selected={fire}
              onSelect={(id) => runCommandSet("fire", id)}
              empty="No fires."
            />
          </Section>
          <Section
            title="ClaimDecision"
            right={claim === undefined
              ? undefined
              : <Badge tone={claim.refusal === "—" ? "ok" : "bad"}>{claim.refusal === "—" ? "Decided" : "Refused"}</Badge>}
          >
            <Graph nodes={nodes} edges={edges} />
          </Section>
          {claim === undefined ? null : (
            <>
              <Section title="Snapshot">
                <Facts rows={[
                  { label: "expectedRevision", value: `${claim.expected_revision} / ${declaration.revision}`, mono: true },
                  { label: "lease", value: claim.lease, mono: true },
                  { label: "running", value: claim.running },
                  { label: "pending", value: claim.pending, mono: true },
                  { label: "due", value: claim.at, mono: true },
                  { label: "refusal", value: claim.refusal === "—" ? "—" : <Badge tone="bad">{claim.refusal}</Badge> }
                ]} />
              </Section>
              <Section title="Writes" right={`${claim.writes.length}`}>
                {claim.writes.length === 0
                  ? <Facts rows={[{ label: "ledger", value: "untouched" }]} />
                  : <Steps steps={claim.writes} />}
              </Section>
            </>
          )}
          <Section title="CatchUp" right={<Badge tone={declaration.bound.includes("exceeded") ? "bad" : "ok"}>{declaration.catch_up}</Badge>}>
            <Facts rows={[
              { label: "max_catch_up", value: declaration.max_catch_up, mono: true },
              { label: "owed", value: declaration.owed },
              { label: "bound", value: declaration.bound, mono: true }
            ]} />
          </Section>
          <Section title="Channel" right={<Badge tone="ok">verified</Badge>}>
            <Facts rows={[
              { label: "name", value: "github-pulls", mono: true },
              { label: "header", value: "x-smithers-signature", mono: true },
              { label: "body", value: "6 144 bytes, owned copy", mono: true },
              { label: "compare", value: "constantTimeEqual" },
              { label: "credential", value: "Redacted<CredentialRef>", mono: true },
              { label: "idempotencyKey", value: "7d3f0c1e-9b44-4d1a-8e12-0a55c9f27e31", mono: true }
            ]} />
            <Code label="inbound">{INBOUND}</Code>
          </Section>
        </>
      }
    />
  )
}

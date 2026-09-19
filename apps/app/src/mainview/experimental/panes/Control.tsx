/*
 * Mock: Control plane. Behind VITE_SMITHERS_EXPERIMENTAL, reached by
 * `/experimental.control`. Self-contained on purpose — see ../Pane.ts.
 *
 * One run, read four ways: how it came to exist (Lineage), what its checkers
 * observed (Health, JevSessionChecker), which steering commands are still in
 * flight (Steering, control_signal_commands), and which credentials it may
 * name. The credential half is drawn as names and cipher state only, because
 * that is exactly what crosses the boundary: `Credential.resolve` is the one
 * operation that touches a secret, and it never reaches a surface.
 */
import { pane, type ExperimentalPaneContext } from "../Pane"
import { Badge, Facts, Rail, Section, Split, Table } from "../Primitives"

const RUNS = [
  { id: "run-42", label: "run-42", note: "healthy", tone: "ok" as const },
  { id: "run-41", label: "run-41", note: "awaiting-human", tone: "warn" as const },
  { id: "run-39", label: "run-39", note: "wedged-node", tone: "bad" as const },
  { id: "run-38", label: "run-38", note: "runaway-loop", tone: "bad" as const },
  { id: "run-31", label: "run-31", note: "completed", tone: "muted" as const }
]

const CHECKS = [
  { id: "c1", checkerId: "jev.session", outcome: "ok", tone: "ok" as const, activity: "needs-input", reason: "prompt-detected", evidenceSeq: 812 },
  { id: "c2", checkerId: "lifecycle.run", outcome: "ok", tone: "ok" as const, activity: "unknown", reason: "event-wait", evidenceSeq: 804 },
  { id: "c3", checkerId: "lifecycle.session", outcome: "timeout", tone: "warn" as const, activity: "unknown", reason: "probe-timeout", evidenceSeq: 799 }
]

const COMMANDS = [
  { id: "cmd_7f21", kind: "signal", state: "pending", tone: "warn" as const, waitToken: "wait_a30c", seq: 1184 },
  { id: "cmd_7f1e", kind: "steer", state: "delivered", tone: "ok" as const, waitToken: "—", seq: 1183 },
  { id: "cmd_7f0b", kind: "signal", state: "rejected", tone: "bad" as const, waitToken: "wait_91ff", seq: 1179 },
  { id: "cmd_7ef4", kind: "signal", state: "terminal", tone: "muted" as const, waitToken: "wait_7c02", seq: 1166 }
]

const MUTATIONS = [
  { id: "m1", verb: "run", receipt: "Accepted", tone: "ok" as const, key: "cli:run:8f31…", target: "control_runs" },
  { id: "m2", verb: "approve", receipt: "Parked", tone: "warn" as const, key: "cli:approve:2a07…", target: "control_tokens" },
  { id: "m3", verb: "steer", receipt: "AlreadyApplied", tone: "muted" as const, key: "web:steer:5c99…", target: "control_run_messages" },
  { id: "m4", verb: "resume", receipt: "Conflict", tone: "bad" as const, key: "web:resume:5c99…", target: "control_run_resumes" },
  { id: "m5", verb: "cancel", receipt: "Terminal", tone: "muted" as const, key: "cli:cancel:b140…", target: "control_runs" }
]

const CREDENTIALS = [
  { id: "cred_github", name: "github.token", version: 4, updated: "2026-09-16", scope: "Node" },
  { id: "cred_gateway", name: "ai-gateway.key", version: 2, updated: "2026-09-11", scope: "Plan" },
  { id: "cred_npm", name: "npm.publish", version: 7, updated: "2026-09-18", scope: "Node" }
]

export const Pane = pane({
  id: "control",
  title: "Control plane",
  summary: "Lineage, credentials, steering and health",
  packages: ["@smthrs/control"],
  render: (context) => <ControlBody {...context} />
})

function ControlBody({ props, set: runCommandSet }: ExperimentalPaneContext) {
  const run = typeof props.run === "string" ? props.run : "run-42"
  const credential = typeof props.credential === "string" ? props.credential : ""
  const selected = CREDENTIALS.find((row) => row.id === credential)
  return (
    <Split
      left={
        <>
          <Section title="Runs"><Rail items={RUNS} selected={run} onSelect={(id) => runCommandSet("run", id)} /></Section>
          <Section title="Lineage">
            <Facts rows={[
              { label: "Origin", value: <Badge tone="info">fork</Badge> },
              { label: "Parent", value: "run-39", mono: true },
              { label: "Lineage", value: "lin1_8ef3…b70c", mono: true },
              { label: "Round", value: "3 of 32", mono: true },
              { label: "Created seq", value: "1104", mono: true }
            ]} />
          </Section>
        </>
      }
      right={
        <>
          <Section title="Health" right={<Badge tone="warn">awaiting-human</Badge>}>
            <Facts rows={[
              { label: "State", value: "running", mono: true },
              { label: "Activity", value: <Badge tone="warn">needs-input</Badge> },
              { label: "Attention", value: <Badge tone="warn">needs-input</Badge> },
              { label: "Freshness", value: <Badge tone="ok">fresh</Badge> },
              { label: "Reason", value: "prompt-detected", mono: true },
              { label: "Monitor", value: "mon_4417 · incarnation 3", mono: true }
            ]} />
            <Table
              columns={[
                { key: "checkerId", label: "Checker", mono: true },
                { key: "outcome", label: "Outcome" },
                { key: "activity", label: "Report" },
                { key: "reason", label: "Reason", mono: true },
                { key: "evidenceSeq", label: "Evidence", mono: true, right: true }
              ]}
              rows={CHECKS.map((row) => ({
                id: row.id,
                checkerId: row.checkerId,
                outcome: <Badge tone={row.tone}>{row.outcome}</Badge>,
                activity: row.activity,
                reason: row.reason,
                evidenceSeq: row.evidenceSeq
              }))}
            />
          </Section>
          <Section title="Steering" right="control_signal_commands">
            <Table
              columns={[
                { key: "id", label: "Command", mono: true },
                { key: "kind", label: "Verb", mono: true },
                { key: "state", label: "Delivery" },
                { key: "waitToken", label: "Wait", mono: true },
                { key: "seq", label: "Seq", mono: true, right: true }
              ]}
              rows={COMMANDS.map((row) => ({
                id: row.id,
                kind: row.kind,
                state: <Badge tone={row.tone}>{row.state}</Badge>,
                waitToken: row.waitToken,
                seq: row.seq
              }))}
            />
          </Section>
          <Section title="Receipts" right="control_mutations">
            <Table
              columns={[
                { key: "verb", label: "Verb", mono: true },
                { key: "receipt", label: "Receipt" },
                { key: "key", label: "Idempotency key", mono: true },
                { key: "target", label: "Table", mono: true, right: true }
              ]}
              rows={MUTATIONS.map((row) => ({
                id: row.id,
                verb: row.verb,
                receipt: <Badge tone={row.tone}>{row.receipt}</Badge>,
                key: row.key,
                target: row.target
              }))}
            />
          </Section>
          <Section title="Credentials" right={<Badge tone="ok">names only</Badge>}>
            <Table
              columns={[
                { key: "name", label: "Name", mono: true },
                { key: "id", label: "Id", mono: true },
                { key: "version", label: "Version", mono: true, right: true },
                { key: "secret", label: "Secret", right: true }
              ]}
              rows={CREDENTIALS.map((row) => ({
                id: row.id,
                name: row.name,
                version: row.version,
                secret: <Badge tone="muted">sealed</Badge>
              }))}
              selected={credential}
              onSelect={(id) => runCommandSet("credential", id)}
            />
          </Section>
          {selected === undefined ? null : (
            <Section title="Credential" right={<Badge tone="warn">resolve: adapter only</Badge>}>
              <Facts rows={[
                { label: "Name", value: selected.name, mono: true },
                { label: "Id", value: selected.id, mono: true },
                { label: "Journaled", value: "id + name", mono: true },
                { label: "Ciphertext", value: <Badge tone="muted">sealed</Badge> },
                { label: "Nonce", value: "per record, never reused", mono: true },
                { label: "Cipher", value: "AES-256-GCM", mono: true },
                { label: "Version", value: `${selected.version} · ${selected.updated}`, mono: true },
                { label: "Grant scope", value: selected.scope, mono: true }
              ]} />
            </Section>
          )}
        </>
      }
    />
  )
}

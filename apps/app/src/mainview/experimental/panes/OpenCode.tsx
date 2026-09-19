/*
 * Mock: OpenCode server. Behind VITE_SMITHERS_EXPERIMENTAL, reached by
 * `/experimental.opencode`. Self-contained on purpose — see ../Pane.ts.
 *
 * Protocol v1 as rows. The hosted app at app.opencode.ai connects to this
 * server the way it connects to `opencode serve`, and everything it renders
 * is a row in `<directory>/.smithers/opencode.sqlite`: a session, a message
 * header, the parts behind it, a pending permission, a grant, an open turn,
 * one health record per frame. The debug half is `Projection.fold`: the
 * harness `AgentEvent` on the left, the v1 event and part it becomes on the
 * right, with part ids derived from the message, the frame and a slot so a
 * replayed frame updates a card instead of appending a second one.
 */
import { pane, type ExperimentalPaneContext } from "../Pane"
import { Badge, Code, Facts, Rail, Section, Split, Table } from "../Primitives"

const SESSIONS = [
  { id: "ses_8f21c0", label: "ses_8f21c0", note: "🟢 progressing", tone: "ok" as const },
  { id: "ses_8f1d44", label: "ses_8f1d44", note: "🔴 needs you", tone: "bad" as const },
  { id: "ses_8ef902", label: "ses_8ef902", note: "🟡 no edit yet", tone: "warn" as const },
  { id: "ses_8ee7b1", label: "ses_8ee7b1", note: "⚪ unavailable", tone: "muted" as const }
]

const MESSAGES = [
  { id: "msg_4a01", role: "user", parts: 1, tokens: "—", cost: "—" },
  { id: "msg_4a02", role: "assistant", parts: 9, tokens: "18 412", cost: "$0.041" },
  { id: "msg_4a03", role: "user", parts: 1, tokens: "—", cost: "—" },
  { id: "msg_4a04", role: "assistant", parts: 6, tokens: "21 004", cost: "$0.048" }
]

const PARTS = [
  { id: "prt_4a02_0001", type: "step-start", tool: "—", status: "—", tone: "muted" as const },
  { id: "prt_4a02_0002", type: "reasoning", tool: "—", status: "—", tone: "muted" as const },
  { id: "prt_4a02_0003", type: "tool", tool: "read", status: "completed", tone: "ok" as const },
  { id: "prt_4a02_0004", type: "tool", tool: "glob", status: "completed", tone: "ok" as const },
  { id: "prt_4a02_0005", type: "tool", tool: "bash", status: "pending", tone: "warn" as const },
  { id: "prt_4a02_0006", type: "tool", tool: "classify", status: "running", tone: "info" as const },
  { id: "prt_4a02_0007", type: "text", tool: "—", status: "—", tone: "muted" as const },
  { id: "prt_4a02_0008", type: "step-finish", tool: "—", status: "end_turn", tone: "ok" as const }
]

const FOLD = [
  { id: "1", event: "turn-opened", emits: "message.part.updated", part: "step-start", tone: "muted" as const },
  { id: "2", event: "model-delta", emits: "message.part.delta", part: "reasoning", tone: "muted" as const },
  { id: "3", event: "model-settled", emits: "session.updated", part: "text", tone: "ok" as const },
  { id: "4", event: "model-retried", emits: "session.status", part: "retry", tone: "warn" as const },
  { id: "5", event: "cell-call-started", emits: "message.part.updated", part: "tool · running", tone: "info" as const },
  { id: "6", event: "cell-call-settled", emits: "message.part.updated", part: "tool · completed", tone: "ok" as const },
  { id: "7", event: "permission-required", emits: "permission.asked", part: "tool · pending", tone: "warn" as const },
  { id: "8", event: "read-only-demanded", emits: "message.part.updated", part: "tool · error", tone: "bad" as const },
  { id: "9", event: "claim-demanded", emits: "message.part.updated", part: "tool · error", tone: "bad" as const },
  { id: "10", event: "cell-settled", emits: "session.idle", part: "step-finish", tone: "ok" as const }
]

const PERMISSION = `{
  "id": "per_91c4",
  "sessionID": "ses_8f21c0",
  "permission": "bash",
  "patterns": ["pnpm test *", "pnpm *"],
  "always": ["pnpm test *"],
  "metadata": { "command": "pnpm test packages/smithers/agent/std" },
  "tool": { "messageID": "msg_4a02", "callID": "call_0f31" }
}`

const TABLES = [
  { id: "opencode_sessions", name: "opencode_sessions", columns: "id, created_ms, info", rows: "4" },
  { id: "opencode_messages", name: "opencode_messages", columns: "id, session_id, info", rows: "31" },
  { id: "opencode_parts", name: "opencode_parts", columns: "id, message_id, session_id, part", rows: "268" },
  { id: "opencode_permissions", name: "opencode_permissions", columns: "id, session_id, request", rows: "1" },
  { id: "opencode_turns", name: "opencode_turns", columns: "message_id, session_id, turn", rows: "1" },
  { id: "opencode_grants", name: "opencode_grants", columns: "session_id, kind, key, seq", rows: "6" },
  { id: "opencode_health", name: "opencode_health", columns: "seq, session_id, message_id, record", rows: "42" }
]

const GRANTS = [
  { id: "1", kind: "always", key: "bash:pnpm test *", tone: "ok" as const },
  { id: "2", kind: "once", key: "bash:git status", tone: "info" as const },
  { id: "3", kind: "reject", key: "bash:rm *", tone: "bad" as const }
]

export const Pane = pane({
  id: "opencode",
  title: "OpenCode server",
  summary: "Protocol v1 sessions, parts and permission cards",
  packages: ["@smthrs/opencode"],
  render: (context) => <OpenCodeBody {...context} />
})

function OpenCodeBody({ props, set: runCommandSet }: ExperimentalPaneContext) {
  const session = typeof props.session === "string" ? props.session : "ses_8f21c0"
  const message = typeof props.message === "string" ? props.message : "msg_4a02"
  const parked = session === "ses_8f1d44"
  return (
    <Split
      left={
        <>
          <Section title="Sessions" right={<Badge tone="ok">connected</Badge>}>
            <Rail items={SESSIONS} selected={session} onSelect={(id) => runCommandSet("session", id)} />
          </Section>
          <Section title="Health">
            <Facts rows={[
              { label: "Classifier", value: "harness/health", mono: true },
              { label: "Floor", value: "0.50", mono: true },
              { label: "Deadline", value: "1500 ms", mono: true },
              { label: "Reason", value: parked ? "needs you (0.94)" : "progressing" },
              { label: "Frame", value: "7 of 100", mono: true }
            ]} />
          </Section>
        </>
      }
      right={
        <>
          <Section title="Messages" right={session}>
            <Table
              columns={[
                { key: "id", label: "id", mono: true },
                { key: "role", label: "Role" },
                { key: "parts", label: "Parts", right: true },
                { key: "tokens", label: "Tokens", mono: true, right: true },
                { key: "cost", label: "Cost", mono: true, right: true }
              ]}
              rows={MESSAGES}
              selected={message}
              onSelect={(id) => runCommandSet("message", id)}
            />
          </Section>
          <Section title="Parts" right={message}>
            <Table
              columns={[
                { key: "id", label: "id", mono: true },
                { key: "type", label: "type", mono: true },
                { key: "tool", label: "tool", mono: true },
                { key: "status", label: "state", right: true }
              ]}
              rows={PARTS.map((row) => ({
                id: row.id,
                type: row.type,
                tool: row.tool,
                status: row.status === "—" ? "—" : <Badge tone={row.tone}>{row.status}</Badge>
              }))}
            />
          </Section>
          <Section title="Permission" right={<Badge tone={parked ? "warn" : "muted"}>{parked ? "asked" : "none pending"}</Badge>}>
            <Code label="permission.asked">{PERMISSION}</Code>
            <Table
              columns={[
                { key: "kind", label: "Grant" },
                { key: "key", label: "key", mono: true }
              ]}
              rows={GRANTS.map((row) => ({
                id: row.id,
                kind: <Badge tone={row.tone}>{row.kind}</Badge>,
                key: row.key
              }))}
            />
          </Section>
          <Section title="Fold" right="AgentEvent → v1">
            <Table
              columns={[
                { key: "event", label: "AgentEvent", mono: true },
                { key: "emits", label: "Emits", mono: true },
                { key: "part", label: "Part" }
              ]}
              rows={FOLD.map((row) => ({
                id: row.id,
                event: row.event,
                emits: row.emits,
                part: <Badge tone={row.tone}>{row.part}</Badge>
              }))}
            />
          </Section>
          <Section title="Store" right=".smithers/opencode.sqlite">
            <Table
              columns={[
                { key: "name", label: "Table", mono: true },
                { key: "columns", label: "Columns", mono: true },
                { key: "rows", label: "Rows", right: true }
              ]}
              rows={TABLES}
            />
          </Section>
        </>
      }
    />
  )
}

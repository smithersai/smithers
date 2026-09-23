/*
 * Mock: Database. Behind VITE_SMITHERS_EXPERIMENTAL, reached by
 * `/experimental.database`. Self-contained on purpose — see ../Pane.ts.
 *
 * Every durable write in Smithers goes through one function. DurableWriter.write
 * takes the process permit, opens sql.withTransaction, and replays the whole
 * body when WriteRetry classifies the failure as transient — so the only place
 * a lock conflict can be seen is here, in the attempt ladder and the
 * flows_db_write_retries counter. Beside it, the ladder that decides what the
 * file even contains: one MigrationSet per package, each in its own block of
 * 1000 ids, applied into flows_migrations.
 */
import { pane, type ExperimentalPaneContext } from "../Pane"
import { Badge, Facts, Rail, Section, Split, Steps, Table } from "../Primitives"

const BACKENDS = [
  { id: "node", label: "NodeDatabase", note: "bound", tone: "ok" as const },
  { id: "bun", label: "BunDatabase", note: "available", tone: "muted" as const },
  { id: "test", label: "TestDatabase", note: ":memory:", tone: "muted" as const },
  { id: "cloudflare", label: "cloudflare/", note: "not exported", tone: "warn" as const }
]

const LADDER = [
  { id: "journal", offset: 0, applied: 12, head: "journal_dedup", tone: "ok" as const },
  { id: "run-store", offset: 1000, applied: 6, head: "run-store_run_source", tone: "ok" as const },
  { id: "step-cache", offset: 2000, applied: 4, head: "step-cache_recorded", tone: "ok" as const },
  { id: "engine-store", offset: 3000, applied: 3, head: "engine-store_selection_store", tone: "ok" as const },
  { id: "plan", offset: 4000, applied: 9, head: "plan_merge_intents", tone: "ok" as const },
  { id: "time-travel", offset: 5000, applied: 7, head: "time-travel_receipts", tone: "ok" as const },
  { id: "control", offset: 6000, applied: 11, head: "control_signal_commands", tone: "ok" as const },
  { id: "memory", offset: 7000, applied: 8, head: "memory_vectors", tone: "ok" as const },
  { id: "integrations", offset: 8000, applied: 2, head: "integrations_cursors", tone: "warn" as const },
  { id: "history", offset: 8000, applied: 0, head: "—", tone: "bad" as const }
]

const APPLIED = [
  { id: "8001", name: "integrations_cursors", at: "2026-09-18 04:12:07" },
  { id: "7007", name: "memory_vectors", at: "2026-09-16 21:40:55" },
  { id: "6010", name: "control_signal_commands", at: "2026-09-16 21:40:55" },
  { id: "5006", name: "time-travel_receipts", at: "2026-09-12 08:03:19" },
  { id: "3002", name: "engine-store_selection_store", at: "2026-09-12 08:03:19" }
]

const WRITE = [
  { id: "1", label: "gate.withPermit", note: "1 permit", tone: "muted" as const },
  { id: "2", label: "sql.withTransaction", note: "outermost", tone: "info" as const },
  { id: "3", label: "flows_journal_events", note: "SQLITE_BUSY", tone: "bad" as const },
  { id: "4", label: "replay", note: "attempt 2 · 58 ms", tone: "warn" as const },
  { id: "5", label: "commit", note: "12 rows", tone: "ok" as const },
  { id: "6", label: "afterCommit", note: "2 effects", tone: "muted" as const }
]

const CLASSIFY = [
  { id: "busy", cause: "SQLITE_BUSY*", code: "busy", retried: "yes", tone: "ok" as const },
  { id: "locked", cause: "SQLITE_LOCKED*", code: "busy", retried: "yes", tone: "ok" as const },
  { id: "40001", cause: "40001", code: "busy", retried: "yes", tone: "ok" as const },
  { id: "55P03", cause: "55P03", code: "busy", retried: "yes", tone: "ok" as const },
  { id: "ioerr", cause: "SQLITE_IOERR", code: "io", retried: "never", tone: "bad" as const },
  { id: "23505", cause: "23505", code: "constraint", retried: "never", tone: "bad" as const }
]

export const Pane = pane({
  id: "database",
  title: "Database",
  summary: "The migration ladder, the backend, and write retries",
  packages: ["@smthrs/database"],
  render: (context) => <DatabaseBody {...context} />
})

function DatabaseBody({ props, set: runCommandSet }: ExperimentalPaneContext) {
  const namespace = typeof props.namespace === "string" ? props.namespace : "history"
  const selected = LADDER.find((row) => row.id === namespace) ?? LADDER[0]
  return (
    <Split
      left={
        <>
          <Section title="Backend" right={<Badge tone="ok">node</Badge>}>
            <Rail items={BACKENDS} />
          </Section>
          <Section title="Open">
            <Facts rows={[
              { label: "filename", value: ".smithers/smithers.db", mono: true },
              { label: "ladder", value: "40 attempts · 5 → 250 ms" },
              { label: "guard", value: "flows_migrations present", mono: true },
              { label: "nodeFloor", value: ">=26.4.0", mono: true },
              { label: "release", value: "1.0.0-rc.0", mono: true },
              { label: "ignored", value: "SMITHERS_TEST_PG_URL", mono: true }
            ]} />
          </Section>
        </>
      }
      right={
        <>
          <Section title="Ladder" right="idBlock 1000">
            <Table
              columns={[
                { key: "id", label: "namespace", mono: true },
                { key: "offset", label: "idOffset", mono: true, right: true },
                { key: "applied", label: "applied", mono: true, right: true },
                { key: "head", label: "head", mono: true }
              ]}
              rows={LADDER.map((row) => ({
                id: row.id,
                offset: row.tone === "ok" ? row.offset : <Badge tone={row.tone}>{row.offset}</Badge>,
                applied: row.applied,
                head: row.head
              }))}
              selected={namespace}
              onSelect={(id) => runCommandSet("namespace", id)}
            />
          </Section>
          {selected.tone === "bad"
            ? (
              <Section title="MigrationError" right={<Badge tone="bad">BadState</Badge>}>
                <Facts rows={[
                  { label: "message", value: "Migration id 8000 is claimed twice: integrations and history", mono: true },
                  { label: "namespace", value: selected.id, mono: true },
                  { label: "idOffset", value: selected.offset, mono: true }
                ]} />
              </Section>
            )
            : null}
          <Section title="flows_migrations" right={<Badge tone="muted">67 rows</Badge>}>
            <Table
              columns={[
                { key: "id", label: "migration_id", mono: true, right: true },
                { key: "name", label: "name", mono: true },
                { key: "at", label: "created_at", mono: true }
              ]}
              rows={APPLIED}
            />
          </Section>
          <Section title="DurableWriter.write" right={<Badge tone="warn">replayed</Badge>}>
            <Steps steps={WRITE} />
          </Section>
          <Section title="WriteRetry" right={<Badge tone="info">flows_db_write_retries 47</Badge>}>
            <Facts rows={[
              { label: "maxAttempts", value: 10, mono: true },
              { label: "baseDelayMs", value: 50, mono: true },
              { label: "maxDelayMs", value: 10_000, mono: true },
              { label: "schedule", value: "exponential ▸ jittered ▸ capped ▸ upTo(9)", mono: true },
              { label: "gate", value: "Semaphore(1), taken before acquire" },
              { label: "nested", value: "savepoint, never retried" }
            ]} />
          </Section>
          <Section title="classifySqlError">
            <Table
              columns={[
                { key: "cause", label: "cause", mono: true },
                { key: "code", label: "code", mono: true },
                { key: "retried", label: "retried", right: true }
              ]}
              rows={CLASSIFY.map((row) => ({
                id: row.id,
                cause: row.cause,
                code: row.code,
                retried: <Badge tone={row.tone}>{row.retried}</Badge>
              }))}
            />
          </Section>
        </>
      }
    />
  )
}

/*
 * Mock: Sync. Behind VITE_SMITHERS_EXPERIMENTAL, reached by
 * `/experimental.sync`. Self-contained on purpose — see ../Pane.ts.
 *
 * The read path is replay-then-follow: `Sync.Read` pages durable entries until
 * `done`, then `Sync.Subscribe` follows from the same per-run cursors. The one
 * question a follower cannot answer today is where it actually is — which
 * cursor, which generation, how far behind the server's tail, and whether it
 * is still paging or already following — so the pane draws that transition and
 * the refusals that send a follower back to a snapshot (SyncProtocol,
 * SyncRpcs, SyncClient, SyncError).
 */
import { pane, type ExperimentalPaneContext } from "../Pane"
import { Badge, Bars, Facts, Rail, Section, Split, Steps, Table } from "../Primitives"

const RUNS = [
  {
    id: "run-42",
    label: "run-42",
    note: "behind 7",
    tone: "ok" as const,
    afterSeq: "1184",
    generation: "2",
    tail: "1191",
    behind: 7,
    delivered: "1184",
    applied: "1181",
    phase: "following",
    phaseTone: "ok" as const
  },
  {
    id: "run-41",
    label: "run-41",
    note: "live",
    tone: "ok" as const,
    afterSeq: "903",
    generation: "0",
    tail: "903",
    behind: 0,
    delivered: "903",
    applied: "903",
    phase: "following",
    phaseTone: "ok" as const
  },
  {
    id: "run-39",
    label: "run-39",
    note: "behind 574",
    tone: "warn" as const,
    afterSeq: "412",
    generation: "1",
    tail: "986",
    behind: 574,
    delivered: "412",
    applied: "412",
    phase: "replaying",
    phaseTone: "warn" as const
  },
  {
    id: "run-38",
    label: "run-38",
    note: "compacted",
    tone: "bad" as const,
    afterSeq: "0",
    generation: "3",
    tail: "220",
    behind: 220,
    delivered: "0",
    applied: "0",
    phase: "refused",
    phaseTone: "bad" as const
  }
]

const REFUSALS = [
  { id: "r1", code: "compacted", tone: "bad" as const, runId: "run-38", detail: "cursor 0 below checkpoint 180", recovery: "onResync" },
  { id: "r2", code: "lineage_changed", tone: "warn" as const, runId: "run-39", detail: "generation 0 → 1", recovery: "resubscribed" },
  { id: "r3", code: "backpressure", tone: "warn" as const, runId: "run-42", detail: "credit 256 spent", recovery: "resubscribed" }
]

export const Pane = pane({
  id: "sync",
  title: "Sync",
  summary: "The read path's cursor and how far behind it is",
  packages: ["@smthrs/sync"],
  render: (context) => <SyncBody {...context} />
})

function SyncBody({ props, set: runCommandSet }: ExperimentalPaneContext) {
  const run = typeof props.run === "string" ? props.run : "run-39"
  const selected = RUNS.find((row) => row.id === run)
  const following = selected?.phase === "following"
  return (
    <Split
      left={
        <>
          <Section title="Runs"><Rail items={RUNS} selected={run} onSelect={(id) => runCommandSet("run", id)} /></Section>
          <Section title="Scope">
            <Facts rows={[
              { label: "scope", value: `{ _tag: "Workspace" }`, mono: true },
              { label: "protocolVersion", value: "1", mono: true },
              { label: "credit", value: "256 of 4096", mono: true },
              { label: "limit", value: "256 of 1024", mono: true },
              { label: "frame cap", value: "2 MiB", mono: true }
            ]} />
          </Section>
        </>
      }
      right={
        <>
          <Section title="Phase" right={<Badge tone={selected?.phaseTone ?? "muted"}>{selected?.phase ?? "—"}</Badge>}>
            <Steps steps={[
              { id: "1", label: "Sync.Read", note: "256 entries · done false", tone: "ok" },
              { id: "2", label: "Sync.Read", note: following ? "118 entries · done true" : "paging", tone: following ? "ok" : "warn" },
              { id: "3", label: "Sync.Subscribe", note: following ? "credit 256" : "not opened", tone: following ? "ok" : "muted" },
              {
                id: "4",
                label: "Entries",
                note: following ? `fromSeq ${selected?.afterSeq ?? "—"} · toSeq ${selected?.tail ?? "—"}` : "—",
                tone: following ? "info" : "muted"
              },
              { id: "5", label: "Heartbeat", note: following ? "idle" : "—", tone: "muted" }
            ]} />
          </Section>
          <Section title="Cursor" right={<Badge tone="muted">{`generation ${selected?.generation ?? "—"}`}</Badge>}>
            <Facts rows={[
              { label: "runId", value: selected?.id ?? "—", mono: true },
              { label: "afterSeq", value: selected?.afterSeq ?? "—", mono: true },
              { label: "generation", value: selected?.generation ?? "—", mono: true },
              { label: "server tail", value: selected?.tail ?? "—", mono: true },
              { label: "behind", value: `${selected?.behind ?? 0} entries`, mono: true }
            ]} />
          </Section>
          <Section title="Behind" right="server tail minus delivered">
            <Bars rows={RUNS.map((row) => ({
              label: row.id,
              value: row.behind,
              display: `${row.behind}`,
              tone: row.tone
            }))} />
          </Section>
          <Section title="Progress" right="delivered · applied">
            <Table
              columns={[
                { key: "id", label: "Run", mono: true },
                { key: "delivered", label: "delivered", mono: true, right: true },
                { key: "applied", label: "applied", mono: true, right: true },
                { key: "generation", label: "generation", mono: true, right: true },
                { key: "phase", label: "Phase" }
              ]}
              rows={RUNS.map((row) => ({
                id: row.id,
                delivered: row.delivered,
                applied: row.applied,
                generation: row.generation,
                phase: <Badge tone={row.phaseTone}>{row.phase}</Badge>
              }))}
              selected={run}
              onSelect={(id) => runCommandSet("run", id)}
            />
          </Section>
          <Section title="Refusals" right={<Badge tone="bad">SyncError</Badge>}>
            <Table
              columns={[
                { key: "code", label: "Code", mono: true },
                { key: "runId", label: "Run", mono: true },
                { key: "detail", label: "Cursor" },
                { key: "recovery", label: "Recovery", mono: true, right: true }
              ]}
              rows={REFUSALS.map((row) => ({
                id: row.id,
                code: <Badge tone={row.tone}>{row.code}</Badge>,
                runId: row.runId,
                detail: row.detail,
                recovery: row.recovery
              }))}
            />
            <Facts rows={[
              { label: "checkpointSeq", value: "180", mono: true },
              { label: "Sync.Snapshot", value: "run-card v3 · atLeastSeq 180", mono: true },
              { label: "restored", value: "seq 204", mono: true },
              { label: "resumed", value: <Badge tone="ok">afterSeq 204</Badge> }
            ]} />
          </Section>
        </>
      }
    />
  )
}

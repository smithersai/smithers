/*
 * Mock: Time travel. Behind VITE_SMITHERS_EXPERIMENTAL, reached by
 * `/experimental.time-travel`. Self-contained on purpose — see ../Pane.ts.
 *
 * The four verbs all act at a FRAME, so the frame is the selection here:
 * `replay` and `inspect` fold the prefix, `fork` copies it, `rewind`
 * truncates the suffix, and only the last one can refuse. What decides that
 * refusal is the effect boundary recorded at the frame and the compensation
 * handler that resolves against it, so those two are the pane's debug half
 * (Frame, EffectBoundary, CompensationHandlers, TimeTravelStore).
 */
import { pane, type ExperimentalPaneContext } from "../Pane"
import { Badge, Empty, Facts, Graph, Rail, Section, Split, Table } from "../Primitives"

const FRAMES = [
  {
    id: "58",
    label: "seq 58",
    note: "tail",
    tone: "muted" as const,
    changeId: "kqzvwxor",
    planDigest: "plan_7c11…4e0a",
    fork: "1 warning",
    forkTone: "warn" as const,
    rewind: "revertible",
    rewindTone: "ok" as const,
    rewindCode: "—",
    effect: {
      id: "eff_0a71c4",
      kind: "jj.commit",
      tier: "compensable",
      tierTone: "warn" as const,
      status: "succeeded",
      statusTone: "ok" as const,
      durableBoundary: "crossed",
      idempotencyKey: "run-42:58:jj.commit",
      compensation: "jj.commit/abandon"
    },
    handlers: [
      {
        id: "h1",
        kind: "jj.commit",
        compensation: "jj.commit/abandon",
        classification: "revertible",
        tone: "ok" as const,
        residue: "abandons zkqmvrpt"
      }
    ]
  },
  {
    id: "41",
    label: "seq 41",
    note: "irreversible",
    tone: "bad" as const,
    changeId: "zkqmvrpt",
    planDigest: "plan_7c11…4e0a",
    fork: "2 warnings",
    forkTone: "warn" as const,
    rewind: "blocking",
    rewindTone: "bad" as const,
    rewindCode: "irreversible",
    effect: {
      id: "eff_9b30de",
      kind: "github.pull-request.create",
      tier: "irreversible",
      tierTone: "bad" as const,
      status: "succeeded",
      statusTone: "ok" as const,
      durableBoundary: "crossed",
      idempotencyKey: "none",
      compensation: "github.pull-request/close"
    },
    handlers: [
      {
        id: "h1",
        kind: "github.pull-request.create",
        compensation: "github.pull-request/close",
        classification: "blocking",
        tone: "bad" as const,
        residue: "smithersai/smithers#1347 stays open"
      },
      {
        id: "h2",
        kind: "http.post",
        compensation: "http.post/none",
        classification: "warning",
        tone: "warn" as const,
        residue: "webhook already delivered"
      }
    ]
  },
  {
    id: "29",
    label: "seq 29",
    note: "compensable",
    tone: "warn" as const,
    changeId: "wruvpmzx",
    planDigest: "plan_5d02…9ab7",
    fork: "no warnings",
    forkTone: "ok" as const,
    rewind: "warning",
    rewindTone: "warn" as const,
    rewindCode: "—",
    effect: {
      id: "eff_44f1a8",
      kind: "fs.write",
      tier: "compensable",
      tierTone: "warn" as const,
      status: "unknown",
      statusTone: "warn" as const,
      durableBoundary: "crossed",
      idempotencyKey: "run-42:29:fs.write",
      compensation: "fs.write/restore"
    },
    handlers: [
      {
        id: "h1",
        kind: "fs.write",
        compensation: "fs.write/restore",
        classification: "warning",
        tone: "warn" as const,
        residue: "packages/smithers/PACKAGE.ts rewritten"
      }
    ]
  },
  {
    id: "12",
    label: "seq 12",
    note: "sealed",
    tone: "ok" as const,
    changeId: "mpsuqntl",
    planDigest: "plan_5d02…9ab7",
    fork: "no warnings",
    forkTone: "ok" as const,
    rewind: "revertible",
    rewindTone: "ok" as const,
    rewindCode: "—",
    effect: {
      id: "eff_1c07bb",
      kind: "model.turn",
      tier: "sealed",
      tierTone: "ok" as const,
      status: "succeeded",
      statusTone: "ok" as const,
      durableBoundary: "not crossed",
      idempotencyKey: "run-42:12:model.turn",
      compensation: "none"
    },
    handlers: []
  },
  {
    id: "0",
    label: "seq 0",
    note: "always addressable",
    tone: "muted" as const,
    changeId: "vznlortk",
    planDigest: "—",
    fork: "no warnings",
    forkTone: "ok" as const,
    rewind: "nothing to archive",
    rewindTone: "muted" as const,
    rewindCode: "—",
    effect: undefined,
    handlers: []
  }
]

const EDGES = [
  { id: "run-42-f1", kind: "fork", tone: "warn" as const, parentSeq: 41, attached: "0" },
  { id: "run-42-c3", kind: "child", tone: "muted" as const, parentSeq: 29, attached: "1" },
  { id: "run-42-r2", kind: "continuation", tone: "ok" as const, parentSeq: 29, attached: "1" }
]

const NODES = [
  { id: "run-42", label: "run-42", depth: 0, lane: 1, tone: "info" as const },
  { id: "run-42-f1", label: "run-42-f1", depth: 1, lane: 0, tone: "warn" as const },
  { id: "run-42-c3", label: "run-42-c3", depth: 1, lane: 2, tone: "muted" as const },
  { id: "run-42-r2", label: "run-42-r2", depth: 2, lane: 1, tone: "ok" as const }
]

const LINKS: ReadonlyArray<readonly [string, string]> = [
  ["run-42", "run-42-f1"],
  ["run-42", "run-42-c3"],
  ["run-42", "run-42-r2"]
]

export const Pane = pane({
  id: "time-travel",
  title: "Time travel",
  summary: "Replay, fork and rewind a run at a frame",
  packages: ["@smthrs/time-travel"],
  render: (context) => <TimeTravelBody {...context} />
})

function TimeTravelBody({ props, set: runCommandSet }: ExperimentalPaneContext) {
  const frame = typeof props.frame === "string" ? props.frame : "41"
  const selected = FRAMES.find((row) => row.id === frame)
  return (
    <Split
      left={
        <>
          <Section title="Frames"><Rail items={FRAMES} selected={frame} onSelect={(id) => runCommandSet("frame", id)} /></Section>
          <Section title="Snapshot">
            <Facts rows={[
              { label: "Run", value: "run-42", mono: true },
              { label: "Lineage", value: "lin1_8ef3…b70c", mono: true },
              { label: "Frame", value: `seq ${frame}`, mono: true },
              { label: "Change", value: selected?.changeId ?? "—", mono: true },
              { label: "Plan digest", value: selected?.planDigest ?? "—", mono: true }
            ]} />
          </Section>
        </>
      }
      right={
        <>
          <Section title="Verbs" right={<Badge tone="info">{`seq ${frame}`}</Badge>}>
            <Table
              columns={[
                { key: "verb", label: "Verb", mono: true },
                { key: "verdict", label: "Verdict" },
                { key: "detail", label: "At this frame" },
                { key: "code", label: "Code", mono: true, right: true }
              ]}
              rows={[
                { id: "replay", verb: "replay", verdict: <Badge tone="ok">ok</Badge>, detail: `${frame} entries folded`, code: "—" },
                { id: "inspect", verb: "inspect", verdict: <Badge tone="ok">ok</Badge>, detail: "service defaults", code: "—" },
                {
                  id: "fork",
                  verb: "fork",
                  verdict: <Badge tone={selected?.forkTone ?? "muted"}>ok</Badge>,
                  detail: selected?.fork ?? "—",
                  code: "—"
                },
                {
                  id: "rewind",
                  verb: "rewind",
                  verdict: <Badge tone={selected?.rewindTone ?? "muted"}>{selected?.rewind ?? "—"}</Badge>,
                  detail: `${selected?.handlers.length ?? 0} handler(s) preflighted`,
                  code: selected?.rewindCode ?? "—"
                }
              ]}
            />
          </Section>
          <Section title="Effect boundary" right="sealed · compensable · irreversible">
            {selected?.effect === undefined ? <Empty>No effect crossed at this frame.</Empty> : (
              <Facts rows={[
                { label: "Effect", value: selected.effect.id, mono: true },
                { label: "Kind", value: selected.effect.kind, mono: true },
                { label: "Tier", value: <Badge tone={selected.effect.tierTone}>{selected.effect.tier}</Badge> },
                { label: "Status", value: <Badge tone={selected.effect.statusTone}>{selected.effect.status}</Badge> },
                { label: "Durable boundary", value: selected.effect.durableBoundary },
                { label: "Idempotency key", value: selected.effect.idempotencyKey, mono: true },
                { label: "Compensation", value: selected.effect.compensation, mono: true }
              ]} />
            )}
          </Section>
          <Section title="Compensation" right="what a rewind would run">
            <Table
              columns={[
                { key: "kind", label: "Handler", mono: true },
                { key: "compensation", label: "Descriptor", mono: true },
                { key: "classification", label: "Assessment" },
                { key: "residue", label: "Residue" }
              ]}
              rows={(selected?.handlers ?? []).map((row) => ({
                id: row.id,
                kind: row.kind,
                compensation: row.compensation,
                classification: <Badge tone={row.tone}>{row.classification}</Badge>,
                residue: row.residue
              }))}
              empty="No handler resolves at this frame."
            />
          </Section>
          <Section title="Lineage" right="flows_time_travel_edges">
            <Graph nodes={NODES} edges={LINKS} selected="run-42-f1" />
            <Table
              columns={[
                { key: "id", label: "Child", mono: true },
                { key: "kind", label: "Kind" },
                { key: "parentSeq", label: "Parent seq", mono: true, right: true },
                { key: "attached", label: "Attached", mono: true, right: true }
              ]}
              rows={EDGES.map((row) => ({
                id: row.id,
                kind: <Badge tone={row.tone}>{row.kind}</Badge>,
                parentSeq: row.parentSeq,
                attached: row.attached
              }))}
            />
          </Section>
          <Section title="Fork" right={<Badge tone="ok">committed</Badge>}>
            <Facts rows={[
              { label: "Child run", value: "run-42-f1", mono: true },
              { label: "Edge", value: "fork · parent seq 41", mono: true },
              { label: "Workspace", value: ".flows/forks/run-42-f1", mono: true },
              { label: "Warnings", value: <Badge tone="warn">2</Badge> },
              { label: "Intent", value: "reclaimed", mono: true }
            ]} />
          </Section>
        </>
      }
    />
  )
}

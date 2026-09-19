/*
 * Mock: Journal. Behind VITE_SMITHERS_EXPERIMENTAL, reached by
 * `/experimental.journal`. Self-contained on purpose — see ../Pane.ts.
 *
 * `flows_journal_events` is written once and never updated: a row's identity
 * is `(run_id, source_id, source_seq)`, its order is `(run_id, seq)`, and a
 * retry resolves to the original receipt rather than a second row. The tail
 * is drawn with the seq the fold is capped at, so a projection is visibly a
 * function of a prefix — plus `flows_journal_checkpoints` and the `OwnerId`
 * fence `emitDurable` refuses without.
 */
import { pane, type ExperimentalPaneContext } from "../Pane"
import { Badge, Code, Facts, Section, Split, Table } from "../Primitives"

type Tone = "ok" | "warn" | "bad" | "info" | "muted"

interface EventMock {
  readonly id: string
  readonly seq: number
  readonly eventType: string
  readonly sourceId: string
  readonly sourceSeq: number
  readonly emittedAtMs: number
  readonly receipt: string
  readonly tone: Tone
  readonly contentHash: string
  readonly payload: string
}

const EVENTS: ReadonlyArray<EventMock> = [
  {
    id: "112",
    seq: 112,
    eventType: "flows.engine.plan-recorded",
    sourceId: "engine",
    sourceSeq: 41,
    emittedAtMs: 1758142004001,
    receipt: "Accepted",
    tone: "ok",
    contentHash: "a41c7e…0b92",
    payload: `{
  "planId": "plan_6f3c9a",
  "flow": "build",
  "digest": "key1_e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  "baseDigest": "key1_e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  "generation": 0,
  "nodes": 5,
  "outcome": "Recorded"
}`
  },
  {
    id: "113",
    seq: 113,
    eventType: "flows.engine.node-scheduled",
    sourceId: "engine",
    sourceSeq: 42,
    emittedAtMs: 1758142004118,
    receipt: "Accepted",
    tone: "ok",
    contentHash: "77b204…ce18",
    payload: `{
  "planId": "plan_6f3c9a",
  "nodeId": "build",
  "kind": "step",
  "planKey": "key1_e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  "dispatchKey": "key1_ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  "attempt": 1,
  "priority": 0,
  "waited": 3
}`
  },
  {
    id: "114",
    seq: 114,
    eventType: "flows.engine.attempt-started",
    sourceId: "engine",
    sourceSeq: 43,
    emittedAtMs: 1758142004140,
    receipt: "Accepted",
    tone: "ok",
    contentHash: "1d90ff…44a3",
    payload: `{
  "runId": "run_8ac431",
  "stepKeyDigest": "key1_ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  "attempt": 1,
  "tier": "sealed"
}`
  },
  {
    id: "115",
    seq: 115,
    eventType: "flows.harness.turn-opened.v1",
    sourceId: "harness-7",
    sourceSeq: 1,
    emittedAtMs: 1758142006902,
    receipt: "Accepted",
    tone: "ok",
    contentHash: "0cb381…7e50",
    payload: `{
  "_tag": "turn-opened",
  "eventType": "flows.harness.turn-opened.v1",
  "seat": "builder",
  "modelParams": { "maxTokens": 4096 },
  "activeToolNames": [],
  "contextDigest": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
}`
  },
  {
    id: "116",
    seq: 116,
    eventType: "flows.harness.cell-call-settled.v1",
    sourceId: "harness-7",
    sourceSeq: 2,
    emittedAtMs: 1758142009441,
    receipt: "Duplicate · committed",
    tone: "info",
    contentHash: "bb1024…9fa7",
    payload: `{
  "_tag": "cell-call-settled",
  "eventType": "flows.harness.cell-call-settled.v1",
  "flowName": "fs/read",
  "identity": {
    "session": "run_8ac431",
    "frame": 1,
    "cell": "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    "ordinal": 0,
    "declaration": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    "layers": []
  },
  "result": { "outcome": "success", "value": "export const build = true" }
}`
  },
  {
    id: "118",
    seq: 118,
    eventType: "flows.engine.attempt-finished",
    sourceId: "engine",
    sourceSeq: 44,
    emittedAtMs: 1758142042353,
    receipt: "Accepted",
    tone: "ok",
    contentHash: "5f2ac0…10d6",
    payload: `{
  "runId": "run_8ac431",
  "stepKeyDigest": "key1_ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  "attempt": 1,
  "state": "succeeded"
}`
  },
  {
    id: "119",
    seq: 119,
    eventType: "flows.engine.node-settled",
    sourceId: "engine",
    sourceSeq: 45,
    emittedAtMs: 1758142042400,
    receipt: "Accepted",
    tone: "ok",
    contentHash: "c73e91…2b44",
    payload: `{
  "planId": "plan_6f3c9a",
  "nodeId": "build",
  "planKey": "key1_e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  "dispatchKey": "key1_ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  "outcome": "built",
  "attempts": 1,
  "rebases": 0
}`
  },
  {
    id: "120",
    seq: 120,
    eventType: "flows.engine.clock-scheduled",
    sourceId: "engine",
    sourceSeq: 46,
    emittedAtMs: 1758142042512,
    receipt: "Accepted",
    tone: "ok",
    contentHash: "2e0a57…88c1",
    payload: `{
  "flowName": "build",
  "executionId": "run_8ac431",
  "clockName": "sign-deadline",
  "deferredName": "wait_sign",
  "dueAtMs": 1758142342512
}`
  },
  {
    id: "121",
    seq: 121,
    eventType: "flows.engine.cache-conflict",
    sourceId: "engine",
    sourceSeq: 47,
    emittedAtMs: 1758142233781,
    receipt: "Accepted",
    tone: "bad",
    contentHash: "9a44b2…dd07",
    payload: `{
  "cacheKey": "key1_ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  "verdict": "tolerate",
  "existing": { "recordedRunId": "run_71bf20", "recordedEventSeq": 89, "createdAtMs": 1758141700000 },
  "attempted": { "recordedRunId": "run_8ac431", "recordedEventSeq": 118, "createdAtMs": 1758142042353 }
}`
  },
  {
    id: "122",
    seq: 122,
    eventType: "flows.engine.run-decision",
    sourceId: "engine",
    sourceSeq: 48,
    emittedAtMs: 1758142234010,
    receipt: "Accepted",
    tone: "ok",
    contentHash: "ea1075…3c6f",
    payload: `{
  "decision": "transitioned",
  "status": "suspended",
  "owner": { "hostId": "mac-studio-01", "pid": 4417, "nonce": "6f1c0a2d" },
  "state": { "version": 1, "flowName": "build", "payload": {}, "result": { "_tag": "Suspended" } },
  "executionFact": {
    "version": 1,
    "baseline": "legacy",
    "observation": {
      "executionId": "run_8ac431",
      "flowName": "build",
      "status": "suspended",
      "createdAtMs": 1758141800000,
      "startedAtMs": 1758141802000,
      "finishedAtMs": null,
      "parentRunId": null,
      "lineageId": "run_8ac431",
      "roundOrdinal": 0,
      "cancelRequestedAtMs": null,
      "treeVersion": 1,
      "parentPolicy": "cancel",
      "waiting": { "reason": "timer", "wakeAtMs": 1758142342512, "tokenDigest": null, "point": null, "request": null }
    }
  }
}`
  }
]

const CHECKPOINTS = [
  { id: "96", seq: 96, createdAtMs: 1758141802110, compactedAtMs: 1758142004000 },
  { id: "111", seq: 111, createdAtMs: 1758142003908, compactedAtMs: null },
  { id: "119", seq: 119, createdAtMs: 1758142042604, compactedAtMs: null }
]

export const Pane = pane({
  id: "journal",
  title: "Journal",
  summary: "The append-only event tail with a sequence scrubber",
  packages: ["@smthrs/journal"],
  render: (context) => <JournalBody {...context} />
})

function JournalBody({ props, set: runCommandSet }: ExperimentalPaneContext) {
  const cap = typeof props.cap === "string" ? props.cap : "118"
  const capSeq = Number(cap)
  const selected = EVENTS.find((entry) => entry.id === cap)
  const folded = EVENTS.filter((entry) => entry.seq <= capSeq)
  const checkpoint = CHECKPOINTS.filter((entry) => entry.seq <= capSeq).at(-1)
  return (
    <Split
      left={
        <>
          <Section title="Run">
            <Facts rows={[
              { label: "run_id", value: "run_8ac431", mono: true },
              { label: "generation", value: "2 · after_seq 95", mono: true },
              { label: "committed tail", value: 122, mono: true },
              { label: "identity", value: "(run_id, source_id, source_seq)", mono: true },
              { label: "gap", value: "seq 117 · drop-newest", mono: true }
            ]} />
          </Section>
          <Section title="Owner fence" right={<Badge tone="ok">held</Badge>}>
            <Facts rows={[
              { label: "hostId", value: "mac-studio-01", mono: true },
              { label: "pid", value: 4417, mono: true },
              { label: "nonce", value: "6f1c0a2d", mono: true },
              { label: "emitDurable", value: "112 → 122", mono: true },
              { label: "refused", value: <Badge tone="bad">fence_lost · 2</Badge> }
            ]} />
          </Section>
          <Section title="flows_journal_checkpoints">
            <Table
              columns={[
                { key: "seq", label: "Seq", mono: true },
                { key: "createdAtMs", label: "Created", mono: true },
                { key: "compactedAtMs", label: "Compacted", mono: true, right: true }
              ]}
              rows={CHECKPOINTS.map((row) => ({
                id: row.id,
                seq: row.seq,
                createdAtMs: row.createdAtMs,
                compactedAtMs: row.compactedAtMs
              }))}
            />
          </Section>
        </>
      }
      right={
        <>
          <Section title="flows_journal_events" right={<Badge tone="muted">append-only</Badge>}>
            <Table
              columns={[
                { key: "seq", label: "Seq", mono: true },
                { key: "eventType", label: "event_type", mono: true },
                { key: "source", label: "Source", mono: true },
                { key: "fold", label: "Fold", right: true }
              ]}
              rows={EVENTS.map((row) => ({
                id: row.id,
                seq: row.seq,
                eventType: row.eventType,
                source: `${row.sourceId}#${row.sourceSeq}`,
                fold: row.seq <= capSeq ? <Badge tone="ok">folded</Badge> : <Badge tone="muted">after cap</Badge>
              }))}
              selected={cap}
              onSelect={(id) => runCommandSet("cap", id)}
            />
          </Section>
          <Section title={`Fold ≤ seq ${cap}`} right={`${folded.length} entries`}>
            <Facts rows={[
              { label: "projection", value: "flows/engine/execution", mono: true },
              { label: "checkpoint", value: checkpoint === undefined ? "—" : `seq ${checkpoint.seq}`, mono: true },
              { label: "state", value: "running · 4 nodes settled · 1 wait", mono: true },
              { label: "replay", value: <Badge tone="ok">same prefix, same state</Badge> }
            ]} />
          </Section>
          {selected === undefined ? null : (
            <>
              <Section title="Receipt" right={<Badge tone={selected.tone}>{selected.receipt}</Badge>}>
                <Facts rows={[
                  { label: "event_id", value: `flows:event:10:run_8ac431${selected.sourceId.length}:${selected.sourceId}${selected.sourceSeq}`, mono: true },
                  { label: "emitted_at_ms", value: selected.emittedAtMs, mono: true },
                  { label: "dedupe", value: "content", mono: true },
                  { label: "content_hash", value: selected.contentHash, mono: true }
                ]} />
              </Section>
              <Section title="payload_json">
                <Code label={`seq ${selected.seq}`}>{selected.payload}</Code>
              </Section>
            </>
          )}
        </>
      }
    />
  )
}

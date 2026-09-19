/*
 * Mock: Memory. Behind VITE_SMITHERS_EXPERIMENTAL, reached by
 * `/experimental.memory`. Self-contained on purpose — see ../Pane.ts.
 *
 * The model reaches this through two operations it calls by name, `remember`
 * and `recall`. So the pane answers the question a bank cannot: why did this
 * row come back. The three recall bindings score the same query side by side —
 * RecallKeyword counts matched terms, RecallFts returns bm25, RecallSemantic
 * multiplies cosine by a 7-day recency half life — a note's supersedes chain
 * says which text is still live, and Maintenance says what would be dropped.
 */
import { pane, type ExperimentalPaneContext } from "../Pane"
import { Badge, Bars, Facts, Graph, Rail, Section, Split, Table } from "../Primitives"

const ROWS = [
  {
    id: "release/cut",
    label: "release/cut",
    note: "0.86",
    tone: "ok" as const,
    bank: "global-notes",
    kind: "note",
    status: "accepted",
    tags: "branch:main, source:chat",
    ttlMs: "—",
    updatedAtMs: "2026-09-17 18:04",
    text: "cut 1.0.0-rc.0 from main after the drift lint is green",
    keyword: 0.75,
    keywordDisplay: "3 / 4 terms",
    fts: 0.84,
    ftsDisplay: "bm25 0.84",
    semantic: 0.86,
    semanticDisplay: "cosine 0.94 · recency 0.91"
  },
  {
    id: "release/blockers",
    label: "release/blockers",
    note: "0.71",
    tone: "ok" as const,
    bank: "global-notes",
    kind: "note",
    status: "accepted",
    tags: "branch:main",
    ttlMs: "—",
    updatedAtMs: "2026-09-16 09:22",
    text: "NPM_TOKEN returns 401; publishing is blocked until it is reminted",
    keyword: 0.5,
    keywordDisplay: "2 / 4 terms",
    fts: 0.61,
    ftsDisplay: "bm25 0.61",
    semantic: 0.71,
    semanticDisplay: "cosine 0.82 · recency 0.87"
  },
  {
    id: "agent/reviewer/style",
    label: "agent/reviewer/style",
    note: "0.44",
    tone: "muted" as const,
    bank: "agent:reviewer",
    kind: "fact",
    status: "—",
    tags: "scope:review",
    ttlMs: "604 800 000",
    updatedAtMs: "2026-09-11 14:47",
    text: "reviews name the file and the line, never the author",
    keyword: 0.25,
    keywordDisplay: "1 / 4 terms",
    fts: 0.18,
    ftsDisplay: "bm25 0.18",
    semantic: 0.44,
    semanticDisplay: "cosine 0.73 · recency 0.60"
  },
  {
    id: "release/tag-order",
    label: "release/tag-order",
    note: "superseded",
    tone: "warn" as const,
    bank: "global-notes",
    kind: "note",
    status: "accepted",
    tags: "branch:main",
    ttlMs: "—",
    updatedAtMs: "2026-09-04 11:30",
    text: "push the tag before the dispatch dry run",
    keyword: 0.5,
    keywordDisplay: "2 / 4 terms",
    fts: 0.55,
    ftsDisplay: "bm25 0.55",
    semantic: 0.39,
    semanticDisplay: "cosine 0.77 · recency 0.51"
  }
]

// One edge is one memory_note_supersedes row, drawn superseder_id → target_id.
const SUPERSEDES = {
  nodes: [
    { id: "b207", label: "note b207", depth: 0, lane: 1, tone: "ok" as const },
    { id: "8c31", label: "note 8c31", depth: 1, lane: 0, tone: "muted" as const },
    { id: "19dd", label: "note 19dd", depth: 1, lane: 2, tone: "muted" as const },
    { id: "4f0a", label: "note 4f0a", depth: 2, lane: 0, tone: "muted" as const }
  ],
  edges: [["b207", "8c31"], ["b207", "19dd"], ["8c31", "4f0a"]] as ReadonlyArray<readonly [string, string]>
}

const NOTES = [
  { id: "b207", status: "accepted", superseder: "—", recall: "returned", created: "2026-09-17 18:04" },
  { id: "8c31", status: "accepted", superseder: "note b207", recall: "dropped", created: "2026-09-12 08:19" },
  { id: "19dd", status: "rejected", superseder: "note b207", recall: "dropped", created: "2026-09-09 21:50" },
  { id: "4f0a", status: "accepted", superseder: "note 8c31", recall: "dropped", created: "2026-09-04 11:30" }
]

const MAINTENANCE = [
  { id: "ttlGc", op: "ttlGc", table: "memory_facts", drop: "14 facts" },
  { id: "limitHistory", op: "limitHistory", table: "memory_messages", drop: "320 messages" },
  { id: "compact", op: "compact", table: "memory_threads", drop: "2 threads · 148 messages" }
]

export const Pane = pane({
  id: "memory",
  title: "Memory",
  summary: "Facts, notes and threads, with the recall ranking that found them",
  packages: ["@smthrs/memory"],
  render: (context) => <MemoryBody {...context} />
})

function MemoryBody({ props, set: runCommandSet }: ExperimentalPaneContext) {
  const row = typeof props.row === "string" ? props.row : "release/cut"
  const note = typeof props.note === "string" ? props.note : "b207"
  const selected = ROWS.find((item) => item.id === row) ?? ROWS[0]
  const selectedNote = NOTES.find((item) => item.id === note) ?? NOTES[0]
  if (selected === undefined || selectedNote === undefined) return null
  return (
    <Split
      left={
        <>
          <Section title="recall">
            <Facts rows={[
              { label: "banks", value: "global-notes, agent:reviewer", mono: true },
              { label: "query", value: "why is the release blocked", mono: true },
              { label: "tagGroups", value: "branch:main · match all", mono: true },
              { label: "maxTokens", value: "2048", mono: true },
              { label: "budget", value: "mid · 8 rows", mono: true }
            ]} />
          </Section>
          <Section title="Rows" right={<Badge tone="info">4 of 8</Badge>}>
            <Rail items={ROWS} selected={row} onSelect={(id) => runCommandSet("row", id)} />
          </Section>
        </>
      }
      right={
        <>
          <Section title={selected.id} right={<Badge tone={selected.tone}>{selected.kind}</Badge>}>
            <Facts rows={[
              { label: "bank", value: selected.bank, mono: true },
              { label: "text", value: selected.text },
              { label: "tags", value: selected.tags, mono: true },
              { label: "status", value: selected.status, mono: true },
              { label: "ttlMs", value: selected.ttlMs, mono: true },
              { label: "updatedAtMs", value: selected.updatedAtMs, mono: true },
              { label: "written by", value: "remember", mono: true }
            ]} />
          </Section>
          <Section title="Ranking" right={<Badge tone="info">RecallSemantic bound</Badge>}>
            <Bars
              max={1}
              rows={[
                { label: "keyword", value: selected.keyword, display: selected.keywordDisplay, tone: "muted" },
                { label: "fts", value: selected.fts, display: selected.ftsDisplay, tone: "muted" },
                { label: "semantic", value: selected.semantic, display: selected.semanticDisplay, tone: "info" }
              ]}
            />
          </Section>
          <Section title="memory_note_supersedes" right={<Badge tone="ok">note b207 live</Badge>}>
            <Graph nodes={SUPERSEDES.nodes} edges={SUPERSEDES.edges} selected={note} onSelect={(id) => runCommandSet("note", id)} />
            <Facts rows={[
              { label: "superseder_id", value: selectedNote.superseder, mono: true },
              { label: "status", value: selectedNote.status, mono: true },
              { label: "created_at_ms", value: selectedNote.created, mono: true },
              { label: "recall", value: selectedNote.recall, mono: true }
            ]} />
          </Section>
          <Section title="Maintenance" right={<Badge tone="warn">dry run</Badge>}>
            <Table
              columns={[
                { key: "op", label: "Operation", mono: true },
                { key: "table", label: "Table", mono: true },
                { key: "drop", label: "Would drop", right: true }
              ]}
              rows={MAINTENANCE}
            />
          </Section>
        </>
      }
    />
  )
}

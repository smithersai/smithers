/*
 * Mock: Cell loop. Behind VITE_SMITHERS_EXPERIMENTAL, reached by
 * `/experimental.cell-loop`. Self-contained on purpose — see ../Pane.ts.
 *
 * The reference pane. What it draws is the one question the product cannot
 * answer today: the model wrote a program, the program called out, and
 * nothing on screen says what the program was, what it called, what came back
 * from the ledger rather than the world, or what the realm still holds. Every
 * row here is a field the harness already keeps (Cell, CallLedger,
 * VariablesPanel, ContextWindow, Compaction, CompletionClaim).
 */
import { pane, type ExperimentalPaneContext } from "../Pane"
import { Badge, Code, Facts, Rail, Section, Split, Table } from "../Primitives"

const CELL = `const files = await ctx.call("fs/glob", { pattern: "packages/*/PACKAGE.ts" })
const stale = []
for (const file of files.paths) {
  const text = await ctx.call("fs/read", { path: file })
  if (!text.body.includes("cacheToken")) stale.push(file)
}
print(stale.length, "packages without a cache token")
stale`

const CALLS = [
  { id: "1", name: "fs/glob", verdict: "run", tone: "info" as const, ms: "142 ms", size: "31 paths" },
  { id: "2", name: "fs/read", verdict: "hit", tone: "ok" as const, ms: "0 ms", size: "4.1 KiB" },
  { id: "3", name: "fs/read", verdict: "replay", tone: "muted" as const, ms: "0 ms", size: "3.8 KiB" },
  { id: "4", name: "fs/read", verdict: "run", tone: "info" as const, ms: "18 ms", size: "12.4 KiB" },
  { id: "5", name: "shell/run", verdict: "denied", tone: "bad" as const, ms: "—", size: "gate: capability" }
]

const VARIABLES = [
  { id: "files", type: "object", size: "31 keys", bound: "cell 4" },
  { id: "stale", type: "array", size: "6 items", bound: "cell 7" },
  { id: "report", type: "string", size: "2.1 KiB", bound: "cell 7" },
  { id: "ctx", type: "object", size: "—", bound: "realm" }
]

const CELLS = [
  { id: "7", label: "cell 7", note: "5 calls", tone: "info" as const },
  { id: "6", label: "cell 6", note: "2 calls", tone: "muted" as const },
  { id: "5", label: "cell 5", note: "compacted", tone: "warn" as const },
  { id: "4", label: "cell 4", note: "1 call", tone: "muted" as const }
]

export const Pane = pane({
  id: "cell-loop",
  title: "Cell loop",
  summary: "The model's cell, its calls, its variables and the exact context window",
  packages: ["@smthrs/harness", "@smthrs/chain"],
  render: (context) => <CellLoopBody {...context} />
})

function CellLoopBody({ props, set: runCommandSet }: ExperimentalPaneContext) {
  const cell = typeof props.cell === "string" ? props.cell : "7"
  const call = typeof props.call === "string" ? props.call : ""
  const selected = CALLS.find((row) => row.id === call)
  return (
    <Split
      left={
        <>
          <Section title="Cells"><Rail items={CELLS} selected={cell} onSelect={(id) => runCommandSet("cell", id)} /></Section>
          <Section title="Context window">
            <Facts rows={[
              { label: "Sent", value: "18 412 tokens", mono: true },
              { label: "Cached", value: "16 990 tokens", mono: true },
              { label: "Compacted", value: "2 cells dropped at cell 5" },
              { label: "Digest", value: "cw1_3f9a…c204", mono: true }
            ]} />
          </Section>
        </>
      }
      right={
        <>
          <Section title={`Cell ${cell}`} right={<Badge tone="ok">settled</Badge>}>
            <Code>{CELL}</Code>
          </Section>
          <Section title="Calls" right="run · hit · replay">
            <Table
              columns={[
                { key: "name", label: "Flow", mono: true },
                { key: "verdict", label: "Verdict" },
                { key: "size", label: "Result", mono: true },
                { key: "ms", label: "Took", mono: true, right: true }
              ]}
              rows={CALLS.map((row) => ({
                id: row.id,
                name: row.name,
                verdict: <Badge tone={row.tone}>{row.verdict}</Badge>,
                size: row.size,
                ms: row.ms
              }))}
              selected={call}
              onSelect={(id) => runCommandSet("call", id)}
            />
          </Section>
          {selected === undefined ? null : (
            <Section title="Call">
              <Facts rows={[
                { label: "Key", value: `call1_${selected.id}a4c…9f21`, mono: true },
                { label: "Verdict", value: selected.verdict },
                { label: "Journal", value: selected.verdict === "replay" ? "read from the journal, not the world" : "appended" }
              ]} />
            </Section>
          )}
          <Section title="Variables" right="what the realm holds">
            <Table
              columns={[
                { key: "id", label: "Name", mono: true },
                { key: "type", label: "Type" },
                { key: "size", label: "Size", mono: true },
                { key: "bound", label: "Bound", right: true }
              ]}
              rows={VARIABLES}
            />
          </Section>
          <Section title="Completion brake">
            <Facts rows={[
              { label: "Claim", value: <Badge tone="warn">refused</Badge> },
              { label: "Why", value: "the tree did not move and no check ran" },
              { label: "Check", value: "UnmovedTree", mono: true }
            ]} />
          </Section>
        </>
      }
    />
  )
}

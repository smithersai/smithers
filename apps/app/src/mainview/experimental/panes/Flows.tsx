/*
 * Mock: Flow declarations. Behind VITE_SMITHERS_EXPERIMENTAL, reached by
 * `/experimental.flows`. Self-contained on purpose — see ../Pane.ts.
 *
 * One declaration, six readings. `flows/review/flow.mdx` is a FlowDescriptor,
 * a built Graph of NodeAst tags, an Effects.Declaration narrowed per node, a
 * Placement per node, four Annotations keys, a KeyMaterial record, and the
 * Markdown MarkdownFlow.renderPrompt actually hands the model. Nothing here
 * is a summary of the flow: each section is a projection the core already
 * computes (Graph.nodes / .edges / .effects / .placements / .keyMaterial).
 */
import { pane, type ExperimentalPaneContext } from "../Pane"
import { Badge, Code, Facts, Graph, Section, Split, Table, type Tone } from "../Primitives"

const MARKDOWN = `---
description: Reviews the uncommitted change in this repository and returns a verdict with the reasons behind it.
capabilities: ["fs:read:**", "proc:spawn:*"]
model: openai:gpt-6-sol
budget:
  tokens: 200000
  milliseconds: 600000
---

# Review the working-copy change

Review the uncommitted change in this repository. The appended arguments may
narrow the review to a path; with no arguments, review everything.

<skill_resources>flows/review</skill_resources>`

interface FlowNode {
  readonly id: string
  readonly label: string
  readonly kind: string
  readonly depth: number
  readonly lane: number
  readonly tone: Tone
  readonly placement: string
  readonly laneId: string
  readonly priority: number
  readonly declared: string
  readonly effective: string
  readonly mode: string
  readonly tier: string
  readonly material: string
}

const NODES: ReadonlyArray<FlowNode> = [
  {
    id: "root",
    label: "AndThen",
    kind: "AndThen",
    depth: 0,
    lane: 1,
    tone: "muted",
    placement: "Local",
    laneId: "—",
    priority: 0,
    declared: "—",
    effective: "r **",
    mode: "expected",
    tier: "compensable",
    material: "key1_0a93…41bc"
  },
  {
    id: "root.first",
    label: "FlowCall",
    kind: "FlowCall",
    depth: 1,
    lane: 1,
    tone: "muted",
    placement: "Local",
    laneId: "—",
    priority: 0,
    declared: "r **",
    effective: "r **",
    mode: "expected",
    tier: "sealed",
    material: "key1_7f21…c40d"
  },
  {
    id: "root.andThen.all.lint",
    label: "Dynamic",
    kind: "Dynamic",
    depth: 2,
    lane: 0,
    tone: "info",
    placement: "Sandbox",
    laneId: "review",
    priority: 10,
    declared: "r src/**",
    effective: "r src/**",
    mode: "hermetic",
    tier: "sealed",
    material: "key1_b8c0…19af"
  },
  {
    id: "root.andThen.all.tests",
    label: "FlowCall",
    kind: "FlowCall",
    depth: 2,
    lane: 1,
    tone: "warn",
    placement: "Sandbox",
    laneId: "review",
    priority: 10,
    declared: "w **",
    effective: "w src/out",
    mode: "expected",
    tier: "compensable",
    material: "key1_2e44…8d7e"
  },
  {
    id: "root.andThen.all.diff",
    label: "FlowCall",
    kind: "FlowCall",
    depth: 2,
    lane: 2,
    tone: "muted",
    placement: "Local",
    laneId: "—",
    priority: 0,
    declared: "r **",
    effective: "r **",
    mode: "expected",
    tier: "sealed",
    material: "key1_cc10…5502"
  },
  {
    id: "root.andThen.lane-merge",
    label: "LaneMerge",
    kind: "LaneMerge",
    depth: 3,
    lane: 1,
    tone: "warn",
    placement: "Local",
    laneId: "review",
    priority: 0,
    declared: "—",
    effective: "w src/out",
    mode: "expected",
    tier: "compensable",
    material: "key1_9ab3…e071"
  },
  {
    id: "root.map",
    label: "Map",
    kind: "Map",
    depth: 4,
    lane: 1,
    tone: "ok",
    placement: "Client",
    laneId: "—",
    priority: 0,
    declared: "—",
    effective: "—",
    mode: "hermetic",
    tier: "sealed",
    material: "key1_45d8…aa30"
  }
]

const EDGES: ReadonlyArray<{ readonly id: string; readonly from: string; readonly to: string; readonly reason: string; readonly tone: Tone }> = [
  { id: "e1", from: "root", to: "root.first", reason: "value", tone: "muted" },
  { id: "e2", from: "root.first", to: "root.andThen.all.lint", reason: "continuation", tone: "muted" },
  { id: "e3", from: "root.first", to: "root.andThen.all.tests", reason: "continuation", tone: "muted" },
  { id: "e4", from: "root.first", to: "root.andThen.all.diff", reason: "continuation", tone: "muted" },
  { id: "e5", from: "root.andThen.all.lint", to: "root.andThen.lane-merge", reason: "lane-merge", tone: "warn" },
  { id: "e6", from: "root.andThen.all.tests", to: "root.andThen.lane-merge", reason: "conflict", tone: "bad" },
  { id: "e7", from: "root.andThen.all.diff", to: "root.map", reason: "value", tone: "muted" },
  { id: "e8", from: "root.andThen.lane-merge", to: "root.map", reason: "value", tone: "muted" }
]

export const Pane = pane({
  id: "flows",
  title: "Flow declarations",
  summary: "A flow's graph, effects, placement and key material",
  packages: ["@smthrs/core", "@smthrs/flow", "@smthrs/registry"],
  render: (context) => <FlowsBody {...context} />
})

function FlowsBody({ props, set: runCommandSet }: ExperimentalPaneContext) {
  const node = typeof props.node === "string" ? props.node : "root.andThen.all.tests"
  const selected = NODES.find((row) => row.id === node) ?? NODES[0]
  return (
    <Split
      left={
        <>
          <Section title="Descriptor" right={<Badge tone="ok">review</Badge>}>
            <Facts rows={[
              { label: "path", value: "flows/review/flow.mdx", mono: true },
              { label: "body", value: "Markdown", mono: true },
              { label: "input", value: "MarkdownArgs", mono: true },
              { label: "output", value: "MarkdownOutput", mono: true },
              { label: "model", value: "openai:gpt-6-sol", mono: true },
              { label: "capabilities", value: "fs:read:** · proc:spawn:*", mono: true },
              { label: "budget", value: "200 000 tokens · 600 000 ms", mono: true },
              { label: "modelInvocable", value: "true", mono: true },
              { label: "provenance", value: "local · flows/", mono: true }
            ]} />
          </Section>
          <Section title="Diagnostics" right={<Badge tone="warn">2</Badge>}>
            <Facts rows={[
              { label: "write_conflict", value: "all.tests ▸ all.lint · lane", mono: true },
              { label: "effect_outside_envelope", value: "all.tests w ** ▸ src/out", mono: true }
            ]} />
          </Section>
        </>
      }
      right={
        <>
          <Section title="Graph" right={<Badge tone="muted">7 nodes · 8 edges</Badge>}>
            <Graph
              nodes={NODES.map((row) => ({
                id: row.id,
                label: row.label,
                depth: row.depth,
                lane: row.lane,
                tone: row.tone
              }))}
              edges={EDGES.map((edge) => [edge.from, edge.to] as const)}
              selected={node}
              onSelect={(id) => runCommandSet("node", id)}
            />
          </Section>
          <Section title={selected.id} right={<Badge tone={selected.tone}>{selected.kind}</Badge>}>
            <Facts rows={[
              { label: "placement", value: `flows/core/Placement/${selected.placement}`, mono: true },
              { label: "lane", value: selected.laneId, mono: true },
              { label: "priority", value: selected.priority, mono: true },
              { label: "keyMaterial", value: selected.material, mono: true },
              { label: "version", value: "flows/key-material/v2", mono: true },
              { label: "kind", value: selected.tier, mono: true },
              { label: "layers", value: "flows/review · @smthrs/registry", mono: true }
            ]} />
          </Section>
          <Section title="Effects" right="declared ▸ effective">
            <Table
              columns={[
                { key: "node", label: "Node", mono: true },
                { key: "declared", label: "declared", mono: true },
                { key: "effective", label: "effective", mono: true },
                { key: "mode", label: "mode", mono: true, right: true }
              ]}
              rows={NODES.map((row) => ({
                id: row.id,
                node: row.id,
                declared: row.declared,
                effective: row.declared === row.effective
                  ? row.effective
                  : <Badge tone="warn">{row.effective}</Badge>,
                mode: row.mode
              }))}
              selected={node}
              onSelect={(id) => runCommandSet("node", id)}
            />
          </Section>
          <Section title="Edges">
            <Table
              columns={[
                { key: "from", label: "From", mono: true },
                { key: "to", label: "To", mono: true },
                { key: "reason", label: "reason" }
              ]}
              rows={EDGES.map((edge) => ({
                id: edge.id,
                from: edge.from,
                to: edge.to,
                reason: <Badge tone={edge.tone}>{edge.reason}</Badge>
              }))}
            />
          </Section>
          <Section title="Markdown" right={<Badge tone="info">renderPrompt</Badge>}>
            <Code>{MARKDOWN}</Code>
          </Section>
        </>
      }
    />
  )
}

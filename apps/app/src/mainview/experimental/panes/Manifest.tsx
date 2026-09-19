/*
 * Mock: App manifest. Behind VITE_SMITHERS_EXPERIMENTAL, reached by
 * `/experimental.manifest`. Self-contained on purpose — see ../Pane.ts.
 *
 * Smithers drawing its own declaration. An app is declared once in a
 * PACKAGE.ts and every other name comes from where a file sits, so the thing
 * worth seeing is the resolution nobody can read off the tree: a layer file
 * applies to its own directory and below, the nearest ancestor of each kind
 * wins, and nothing merges. The flow table is that resolution, per flow, with
 * the distance each winner sat at. Fields are `@smthrs/create-app`'s own —
 * AppRoutes, FlowRoute, PageRoute, PaneRoute, resolveLayer, RoutesReport.
 */
import { pane, type ExperimentalPaneContext } from "../Pane"
import { Badge, Code, Facts, Section, Split, Table } from "../Primitives"

const TREE = `aomi/
├─ PACKAGE.ts                     App = CreateApp({ name: "aomi" })
├─ AGENT.ts                       Agent    openai:gpt-5.5
├─ SANDBOX.ts                     Sandbox  heapBytes 128 MiB
├─ TOOLS.ts                       Tools    tevm · ui · promote
├─ app/
│  ├─ layout.tsx                  default
│  ├─ page.tsx                    default        /
│  ├─ overview/page.tsx           default        /overview
│  ├─ operate/logs/page.tsx       default        /operate/logs
│  └─ panes/
│     ├─ build-plan.tsx           Pane           build-plan
│     └─ chain-balance.tsx        Pane           chain-balance
├─ flows/
│  ├─ build/
│  │  ├─ AGENT.ts                 Agent    openai:gpt-5.6-sol
│  │  └─ flow.ts                  Flow           build
│  └─ chat/flow.ts                Flow           chat
└─ tools/
   ├─ tevm.ts
   ├─ ui.ts
   └─ promote.ts`

const GRAMMAR = [
  { id: "agent", file: "AGENT.ts", export: "Agent" },
  { id: "sandbox", file: "SANDBOX.ts", export: "Sandbox" },
  { id: "tools", file: "TOOLS.ts", export: "Tools" },
  { id: "flow", file: "flows/<id>/flow.ts", export: "Flow" },
  { id: "pane", file: "app/panes/<name>.tsx", export: "Pane" },
  { id: "page", file: "app/**/page.tsx", export: "default" },
  { id: "layout", file: "app/layout.tsx", export: "default" }
]

const FLOWS = [
  {
    id: "build",
    file: "flows/build/flow.ts",
    chat: false,
    agent: "flows/build/AGENT.ts",
    agentUp: "0 up",
    agentTone: "info" as const,
    sandbox: "SANDBOX.ts",
    sandboxUp: "2 up",
    tools: "TOOLS.ts",
    toolsUp: "2 up",
    seat: "openai:gpt-5.6-sol",
    calls: 64,
    maxFrames: 24
  },
  {
    id: "chat",
    file: "flows/chat/flow.ts",
    chat: true,
    agent: "AGENT.ts",
    agentUp: "2 up",
    agentTone: "muted" as const,
    sandbox: "SANDBOX.ts",
    sandboxUp: "2 up",
    tools: "TOOLS.ts",
    toolsUp: "2 up",
    seat: "openai:gpt-5.5",
    calls: 32,
    maxFrames: 12
  }
]

const PANES = [
  { id: "build-files", file: "app/panes/build-files.tsx" },
  { id: "build-plan", file: "app/panes/build-plan.tsx" },
  { id: "chain-balance", file: "app/panes/chain-balance.tsx" },
  { id: "chain-block", file: "app/panes/chain-block.tsx" },
  { id: "chain-contract", file: "app/panes/chain-contract.tsx" },
  { id: "chain-tx", file: "app/panes/chain-tx.tsx" }
]

const PAGES = [
  { id: "/", file: "app/page.tsx" },
  { id: "/build", file: "app/build/page.tsx" },
  { id: "/overview", file: "app/overview/page.tsx" },
  { id: "/projects", file: "app/projects/page.tsx" },
  { id: "/providers", file: "app/providers/page.tsx" },
  { id: "/integrations", file: "app/integrations/page.tsx" },
  { id: "/settings", file: "app/settings/page.tsx" },
  { id: "/operate/deployments", file: "app/operate/deployments/page.tsx" },
  { id: "/operate/logs", file: "app/operate/logs/page.tsx" },
  { id: "/operate/observability", file: "app/operate/observability/page.tsx" },
  { id: "/operate/transactions", file: "app/operate/transactions/page.tsx" },
  { id: "/operate/usage", file: "app/operate/usage/page.tsx" }
]

export const Pane = pane({
  id: "manifest",
  title: "App manifest",
  summary: "Smithers rendering its own PACKAGE.ts: routes, panes, flows and layers",
  packages: ["@smthrs/create-app"],
  render: (context) => <ManifestBody {...context} />
})

function ManifestBody({ props, set: runCommandSet }: ExperimentalPaneContext) {
  const flow = typeof props.flow === "string" ? props.flow : "build"
  const selected = FLOWS.find((row) => row.id === flow)
  return (
    <Split
      left={
        <>
          <Section title="App" right={<Badge tone="ok">clean</Badge>}>
            <Facts rows={[
              { label: "name", value: "aomi", mono: true },
              { label: "dirs", value: "app · flows · tools", mono: true },
              { label: "deploy", value: "aomi.example.com", mono: true },
              { label: "routes.gen.ts", value: "12 pages · 6 panes · 2 flows" },
              { label: "routes.ui.gen.ts", value: "layout · pages · panes · flowSummaries" }
            ]} />
          </Section>
          <Section title="Grammar">
            <Table
              columns={[
                { key: "file", label: "File", mono: true },
                { key: "export", label: "Export", mono: true }
              ]}
              rows={GRAMMAR.map((row) => ({ id: row.id, file: row.file, export: row.export }))}
            />
          </Section>
        </>
      }
      right={
        <>
          <Section title="Tree">
            <Code>{TREE}</Code>
          </Section>
          <Section title="Layers" right="nearest ancestor wins · nothing merges">
            <Table
              columns={[
                { key: "flow", label: "Flow", mono: true },
                { key: "agent", label: "AGENT.ts", mono: true },
                { key: "sandbox", label: "SANDBOX.ts", mono: true },
                { key: "tools", label: "TOOLS.ts", mono: true }
              ]}
              rows={FLOWS.map((row) => ({
                id: row.id,
                flow: row.id,
                agent: <Badge tone={row.agentTone}>{row.agent}</Badge>,
                sandbox: row.sandbox,
                tools: row.tools
              }))}
              selected={flow}
              onSelect={(id) => runCommandSet("flow", id)}
            />
          </Section>
          {selected === undefined ? null : (
            <Section
              title={selected.id}
              right={selected.chat ? <Badge tone="info">chat</Badge> : <Badge tone="muted">flow</Badge>}
            >
              <Facts rows={[
                { label: "file", value: selected.file, mono: true },
                { label: "Agent", value: `${selected.agent} · ${selected.agentUp}`, mono: true },
                { label: "seat", value: selected.seat, mono: true },
                { label: "limits.calls", value: selected.calls, mono: true },
                { label: "maxFrames", value: selected.maxFrames, mono: true },
                { label: "Sandbox", value: `${selected.sandbox} · ${selected.sandboxUp}`, mono: true },
                { label: "Tools", value: `${selected.tools} · ${selected.toolsUp}`, mono: true }
              ]} />
            </Section>
          )}
          <Section title="Pages" right={<Badge tone="muted">generated</Badge>}>
            <Table
              columns={[
                { key: "id", label: "Route", mono: true },
                { key: "file", label: "File", mono: true }
              ]}
              rows={PAGES}
            />
          </Section>
          <Section title="Panes">
            <Table
              columns={[
                { key: "id", label: "Name", mono: true },
                { key: "file", label: "File", mono: true }
              ]}
              rows={PANES}
            />
          </Section>
        </>
      }
    />
  )
}

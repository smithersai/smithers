/*
 * Mock: Plan and step keys. Behind VITE_SMITHERS_EXPERIMENTAL, reached by
 * `/experimental.plan`. Self-contained on purpose — see ../Pane.ts.
 *
 * What replay determinism rests on, drawn once: the keyed action graph
 * (`flows_plans`, `flows_plan_nodes`, `flows_plan_edges`), the selected node's
 * `key1_` step key beside the exact `StepKey.content` material it was derived
 * from, and the `PlanDiff` against the previous plan of the same flow — added,
 * removed, rekeyed, each rekey blamed on the field that moved it.
 */
import { pane, type ExperimentalPaneContext } from "../Pane"
import { Badge, Code, Facts, Graph, Section, Split, Table } from "../Primitives"

type Tier = "sealed" | "compensable" | "irreversible"

interface PlanNodeMock {
  readonly id: string
  readonly kind: "step" | "agent" | "merge"
  readonly tier: Tier
  readonly key: string
  readonly depth: number
  readonly lane: number
  readonly generation: number
  readonly priority: number
  readonly dependsOn: string
  readonly conflicts: string
  readonly strategy: "serialize" | "lane" | "fail"
  readonly runtime: "delay-rebase" | "stop-merge"
  readonly material: string
}

const NODES: ReadonlyArray<PlanNodeMock> = [
  {
    id: "checkout",
    kind: "step",
    tier: "sealed",
    key: "key1_31b0f4…c9de",
    depth: 0,
    lane: 1,
    generation: 0,
    priority: 0,
    dependsOn: "—",
    conflicts: "—",
    strategy: "serialize",
    runtime: "delay-rebase",
    material: `StepKey.content({
  body: { version: "flows/key-material/v2", declaration: { action: "jj/snapshot", rev: "@" } },
  inputs: {},
  layers: ["NodeFileSystem", "@smthrs/jj"],
  capabilities: { declared: ["fs:read:.", "fs:write:work/**", "jj:snapshot:."] },
  environment: { declared: true, layers: ["NodeFileSystem"], capabilities: {} },
  hermetic: { readSet: [], writeSet: [{ _tag: "TreeArtifact", path: "work" }], boundaryMode: "hard" }
})`
  },
  {
    id: "typecheck",
    kind: "step",
    tier: "sealed",
    key: "key1_a71d03…5b6e",
    depth: 1,
    lane: 0,
    generation: 0,
    priority: 0,
    dependsOn: "checkout",
    conflicts: "—",
    strategy: "serialize",
    runtime: "delay-rebase",
    material: `StepKey.content({
  body: { version: "flows/key-material/v2", declaration: { action: "tsc", project: "flows" } },
  inputs: { "0": StepKey.digestInput("key1_31b0f4…c9de", { reference: "ref" }) },
  layers: ["NodeFileSystem"],
  capabilities: { declared: ["fs:read:packages/**", "proc:spawn:tsc"] },
  environment: { declared: true, layers: ["NodeFileSystem"], capabilities: {} },
  hermetic: {
    readSet: [{ path: "tsconfig.json", digest: "4c9e21…1a20" }],
    writeSet: [{ _tag: "Glob", include: ["**/*.tsbuildinfo"] }],
    boundaryMode: "hard"
  }
})`
  },
  {
    id: "test",
    kind: "step",
    tier: "sealed",
    key: "key1_0c4ab8…77f2",
    depth: 1,
    lane: 1,
    generation: 0,
    priority: 2,
    dependsOn: "checkout",
    conflicts: "—",
    strategy: "serialize",
    runtime: "delay-rebase",
    material: `StepKey.content({
  body: { version: "flows/key-material/v2", declaration: { action: "vitest", project: "flows" } },
  inputs: { "0": StepKey.digestInput("key1_31b0f4…c9de", { reference: "ref" }) },
  layers: ["NodeFileSystem"],
  capabilities: { declared: ["fs:read:packages/**", "proc:spawn:bun"] },
  environment: { declared: true, layers: ["NodeFileSystem"], capabilities: {} },
  hermetic: {
    readSet: [{ path: "packages/smithers/flows/plan/test", digest: "d208b7…61c4" }],
    writeSet: [{ _tag: "Glob", include: ["coverage/**"] }],
    boundaryMode: "hard"
  }
})`
  },
  {
    id: "lint",
    kind: "step",
    tier: "sealed",
    key: "key1_77ce10…b108",
    depth: 1,
    lane: 2,
    generation: 0,
    priority: 0,
    dependsOn: "checkout",
    conflicts: "—",
    strategy: "lane",
    runtime: "delay-rebase",
    material: `StepKey.content({
  body: { version: "flows/key-material/v2", declaration: { action: "eslint", project: "flows" } },
  inputs: { "0": StepKey.digestInput("key1_31b0f4…c9de", { reference: "ref" }) },
  layers: ["NodeFileSystem"],
  capabilities: { declared: ["fs:read:packages/**"] },
  environment: { declared: true, layers: ["NodeFileSystem"], capabilities: {} },
  hermetic: { readSet: [], writeSet: [], boundaryMode: "hard" }
})`
  },
  {
    id: "build",
    kind: "step",
    tier: "sealed",
    key: "key1_5b2077…ff41",
    depth: 2,
    lane: 0,
    generation: 0,
    priority: 4,
    dependsOn: "typecheck, test",
    conflicts: "changelog · dist/**",
    strategy: "serialize",
    runtime: "delay-rebase",
    material: `StepKey.content({
  body: { version: "flows/key-material/v2", declaration: { action: "build", target: "@smthrs/plan" } },
  inputs: {
    "0": StepKey.digestInput("key1_a71d03…5b6e", { reference: "ref" }),
    "1": StepKey.digestInput("key1_0c4ab8…77f2", { reference: "ref" })
  },
  layers: ["NodeFileSystem", "@smthrs/build"],
  capabilities: { declared: ["fs:read:packages/**", "fs:write:dist/**", "proc:spawn:bun"] },
  environment: { declared: true, layers: ["NodeFileSystem"], capabilities: {} },
  hermetic: {
    readSet: [{ path: "packages/smithers/flows/plan/src", digest: "b309fa…d41c" }],
    writeSet: [{ _tag: "Glob", include: ["dist/**"] }],
    removes: ["dist/**"],
    boundaryMode: "hard"
  }
})`
  },
  {
    id: "changelog",
    kind: "agent",
    tier: "sealed",
    key: "key1_c41902…0a7d",
    depth: 2,
    lane: 2,
    generation: 2,
    priority: 0,
    dependsOn: "lint",
    conflicts: "build · dist/**",
    strategy: "lane",
    runtime: "stop-merge",
    material: `StepKey.content({
  body: { version: "flows/key-material/v2", declaration: { agent: "codex", task: "changelog" } },
  inputs: { "0": StepKey.digestInput("key1_77ce10…b108", { reference: "pending" }) },
  layers: ["@smthrs/harness"],
  capabilities: { declared: ["fs:write:CHANGELOG.md", "net:post:api.openai.com"] },
  environment: { declared: true, layers: ["@smthrs/harness"], capabilities: {} },
  hermetic: { readSet: [], writeSet: ["CHANGELOG.md"], boundaryMode: "expected" }
})`
  },
  {
    id: "bundle",
    kind: "merge",
    tier: "sealed",
    key: "key1_9e0743…21ac",
    depth: 3,
    lane: 1,
    generation: 1,
    priority: 0,
    dependsOn: "build, changelog",
    conflicts: "—",
    strategy: "serialize",
    runtime: "stop-merge",
    material: `StepKey.content({
  body: { version: "flows/key-material/v2", declaration: { merge: ["build", "changelog"] } },
  inputs: {
    "0": StepKey.digestInput("key1_5b2077…ff41", { reference: "ref" }),
    "1": StepKey.digestInput("key1_c41902…0a7d", { reference: "ref-projected", path: ["entry"] })
  },
  layers: ["NodeFileSystem"],
  capabilities: { declared: ["fs:read:dist/**", "fs:write:dist/**"] },
  environment: { declared: true, layers: ["NodeFileSystem"], capabilities: {} },
  hermetic: { readSet: [], writeSet: [{ _tag: "Glob", include: ["dist/**"] }], boundaryMode: "hard" }
})`
  },
  {
    id: "sign",
    kind: "step",
    tier: "compensable",
    key: "key1_2fa8d6…b590",
    depth: 4,
    lane: 1,
    generation: 1,
    priority: 0,
    dependsOn: "bundle",
    conflicts: "—",
    strategy: "serialize",
    runtime: "stop-merge",
    material: `StepKey.planIdentity({
  version: "flows/key-material/v2",
  kind: "compensable",
  body: { action: "cosign", scope: "release" },
  inputs: [{ _tag: "Ref", from: "bundle", path: [] }],
  layers: ["@smthrs/crypto"],
  capabilities: ["proc:spawn:cosign"]
}, { bundle: "key1_9e0743…21ac" })`
  },
  {
    id: "publish",
    kind: "step",
    tier: "irreversible",
    key: "key1_e80c15…3d42",
    depth: 5,
    lane: 1,
    generation: 1,
    priority: 0,
    dependsOn: "sign",
    conflicts: "—",
    strategy: "fail",
    runtime: "stop-merge",
    material: `StepKey.planIdentity({
  version: "flows/key-material/v2",
  kind: "irreversible",
  body: { action: "npm/publish", tag: "latest" },
  inputs: [{ _tag: "Ref", from: "sign", path: [] }],
  layers: ["NodeHttpClient"],
  capabilities: ["net:post:registry.npmjs.org"]
}, { sign: "key1_2fa8d6…b590" })`
  }
]

const EDGES: ReadonlyArray<readonly [string, string]> = [
  ["checkout", "typecheck"],
  ["checkout", "test"],
  ["checkout", "lint"],
  ["typecheck", "build"],
  ["test", "build"],
  ["lint", "changelog"],
  ["build", "bundle"],
  ["changelog", "bundle"],
  ["bundle", "sign"],
  ["sign", "publish"]
]

const TIER_TONE = {
  sealed: "info",
  compensable: "warn",
  irreversible: "bad"
} as const

const GENERATIONS = [
  { id: "0", generation: 0, nodes: 6, digest: "key1_c11842…40aa", note: "base_digest" },
  { id: "1", generation: 1, nodes: 8, digest: "key1_7d9206…31e5", note: "append" },
  { id: "2", generation: 2, nodes: 9, digest: "key1_ff0193…8b3c", note: "head" }
]

const DIFF = [
  { id: "changelog", verdict: "added", tone: "ok" as const, from: "—", to: "key1_c41902…0a7d", changed: "—" },
  { id: "review", verdict: "removed", tone: "bad" as const, from: "key1_6ab0f9…d7c1", to: "—", changed: "—" },
  { id: "build", verdict: "rekeyed", tone: "warn" as const, from: "key1_18cc74…9e03", to: "key1_5b2077…ff41", changed: "body" },
  { id: "bundle", verdict: "rekeyed", tone: "warn" as const, from: "key1_4402ab…7f18", to: "key1_9e0743…21ac", changed: "input[0]" },
  { id: "sign", verdict: "rekeyed", tone: "warn" as const, from: "key1_bb1d30…c206", to: "key1_2fa8d6…b590", changed: "input[0]" },
  { id: "publish", verdict: "rekeyed", tone: "warn" as const, from: "key1_05e9c7…a884", to: "key1_e80c15…3d42", changed: "input[0]" }
]

export const Pane = pane({
  id: "plan",
  title: "Plan and step keys",
  summary: "The keyed action graph, its step keys and the diff between revisions",
  packages: ["@smthrs/plan", "@smthrs/core"],
  render: (context) => <PlanBody {...context} />
})

function PlanBody({ props, set: runCommandSet }: ExperimentalPaneContext) {
  const nodeId = typeof props.nodeId === "string" ? props.nodeId : "build"
  const node = NODES.find((entry) => entry.id === nodeId)
  return (
    <Split
      left={
        <>
          <Section title="Plan">
            <Facts rows={[
              { label: "plan_id", value: "plan_6f3c9a", mono: true },
              { label: "flow", value: "release", mono: true },
              { label: "generation", value: 2, mono: true },
              { label: "base_digest", value: "key1_c11842…40aa", mono: true },
              { label: "digest", value: "key1_ff0193…8b3c", mono: true },
              { label: "nodes", value: 9, mono: true }
            ]} />
          </Section>
          <Section title="Generations" right={<Badge tone="muted">append-only</Badge>}>
            <Table
              columns={[
                { key: "generation", label: "Gen", mono: true },
                { key: "nodes", label: "Nodes", mono: true, right: true },
                { key: "note", label: "" }
              ]}
              rows={GENERATIONS.map((row) => ({
                id: row.id,
                generation: row.generation,
                nodes: row.nodes,
                note: row.note
              }))}
            />
          </Section>
          <Section title="Scheduling">
            <Facts rows={[
              { label: "Limits", value: "steps 4 · agents 1", mono: true },
              { label: "Active", value: "steps 3 · agents 1", mono: true },
              { label: "Admitted", value: "typecheck, test" },
              { label: "Deferred", value: "changelog · waited 3" }
            ]} />
          </Section>
        </>
      }
      right={
        <>
          <Section title="Graph" right={<Badge tone="info">step · agent · merge</Badge>}>
            <Graph
              nodes={NODES.map((entry) => ({
                id: entry.id,
                label: entry.id,
                depth: entry.depth,
                lane: entry.lane,
                tone: entry.kind === "merge" ? "muted" : TIER_TONE[entry.tier]
              }))}
              edges={EDGES}
              selected={nodeId}
              onSelect={(id) => runCommandSet("nodeId", id)}
            />
          </Section>
          {node === undefined ? null : (
            <>
              <Section title={node.id} right={<Badge tone={TIER_TONE[node.tier]}>{node.tier}</Badge>}>
                <Facts rows={[
                  { label: "key", value: node.key, mono: true },
                  { label: "kind", value: node.kind, mono: true },
                  { label: "dependsOn", value: node.dependsOn, mono: true },
                  { label: "conflicts", value: node.conflicts, mono: true },
                  { label: "strategy", value: `${node.strategy} · ${node.runtime}`, mono: true },
                  { label: "priority", value: node.priority, mono: true },
                  { label: "generation", value: node.generation, mono: true },
                  {
                    label: "reuse",
                    value: node.tier === "sealed"
                      ? <Badge tone="ok">cross-run</Badge>
                      : <Badge tone="warn">ordinal · run-local</Badge>
                  }
                ]} />
              </Section>
              <Section title="Key material" right="canonical JSON · SHA-256">
                <Code label={node.key}>{node.material}</Code>
              </Section>
            </>
          )}
          <Section title="Diff" right="plan_2b90c1 → plan_6f3c9a">
            <Table
              columns={[
                { key: "id", label: "Node", mono: true },
                { key: "verdict", label: "Verdict" },
                { key: "from", label: "From", mono: true },
                { key: "to", label: "To", mono: true },
                { key: "changed", label: "Changed", mono: true, right: true }
              ]}
              rows={DIFF.map((row) => ({
                id: row.id,
                verdict: <Badge tone={row.tone}>{row.verdict}</Badge>,
                from: row.from,
                to: row.to,
                changed: row.changed
              }))}
            />
            <Facts rows={[{ label: "unchanged", value: "checkout, typecheck, test, lint", mono: true }]} />
          </Section>
        </>
      }
    />
  )
}

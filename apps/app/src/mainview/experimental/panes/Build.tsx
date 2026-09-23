/*
 * Mock: Build targets. Behind VITE_SMITHERS_EXPERIMENTAL, reached by
 * `/experimental.build`. Self-contained on purpose — see ../Pane.ts.
 *
 * The app can already list targets. What it cannot answer is the only question
 * anyone asks a build system: why did this target run. That answer is four
 * fields of key material hashed under one header, a local verdict, and a
 * remote store that either served the bytes or degraded to local-only — beside
 * the two selections nobody can see today, Affected.select's exact reverse
 * closure and the advisory rows in flows_selection_suspected_edges.
 */
import { pane, type ExperimentalPaneContext } from "../Pane"
import { Badge, Facts, Graph, Section, Split, Table, type Tone } from "../Primitives"

interface Target {
  readonly id: string
  readonly label: string
  readonly rule: string
  readonly kinds: string
  readonly status: string
  readonly tone: Tone
  readonly source: string
  readonly ms: string
  readonly key: string
  readonly local: string
  readonly remote: string
  readonly capabilities: string
  readonly depth: number
  readonly lane: number
}

const TARGETS: ReadonlyArray<Target> = [
  {
    id: ":srcs",
    label: ":srcs",
    rule: "Filegroup",
    kinds: "build",
    status: "hit",
    tone: "ok",
    source: "local",
    ms: "0 ms",
    key: "3ab7f0c9…e12d",
    local: "candidate",
    remote: "not-probed",
    capabilities: "fs:read",
    depth: 0,
    lane: 1
  },
  {
    id: ":lib",
    label: ":lib",
    rule: "TsBuild",
    kinds: "build",
    status: "hit",
    tone: "ok",
    source: "remote",
    ms: "0 ms",
    key: "8f2c9a10…41ab",
    local: "miss",
    remote: "hit · 412 KiB",
    capabilities: "fs:read · fs:write · proc:spawn",
    depth: 1,
    lane: 1
  },
  {
    id: ":check",
    label: ":check",
    rule: "Typecheck",
    kinds: "lint",
    status: "hit",
    tone: "ok",
    source: "local",
    ms: "0 ms",
    key: "c4410b7e…9d02",
    local: "candidate",
    remote: "not-probed",
    capabilities: "fs:read · proc:spawn",
    depth: 2,
    lane: 0
  },
  {
    id: ":test",
    label: ":test",
    rule: "Vitest",
    kinds: "test",
    status: "ran",
    tone: "info",
    source: "—",
    ms: "41.2 s",
    key: "0e93aa54…77c1",
    local: "miss",
    remote: "miss",
    capabilities: "fs:read · fs:write · proc:spawn · net:loopback",
    depth: 2,
    lane: 1
  },
  {
    id: ":lint",
    label: ":lint",
    rule: "EsLint",
    kinds: "lint",
    status: "failed",
    tone: "bad",
    source: "—",
    ms: "8.9 s",
    key: "61fd2c08…b430",
    local: "miss",
    remote: "miss",
    capabilities: "fs:read · proc:spawn",
    depth: 2,
    lane: 2
  },
  {
    id: ":docs",
    label: ":docs",
    rule: "DocsParity",
    kinds: "docs",
    status: "skipped",
    tone: "muted",
    source: "—",
    ms: "—",
    key: "—",
    local: "miss",
    remote: "not-probed",
    capabilities: "fs:read",
    depth: 2,
    lane: 3
  }
]

const EDGES: ReadonlyArray<readonly [string, string]> = [
  [":srcs", ":lib"],
  [":lib", ":check"],
  [":lib", ":test"],
  [":lib", ":lint"],
  [":lib", ":docs"]
]

const AFFECTED = [
  { id: "a1", label: "//packages/smithers/build:lib", reasons: "src/Runtime.ts" },
  { id: "a2", label: "//packages/smithers/build:test", reasons: "src/Runtime.ts · dependent" },
  { id: "a3", label: "//packages/smithers/build/build-cli:lib", reasons: "dependent" },
  { id: "a4", label: "//packages/smithers/build/targets:test", reasons: "dependent" },
  { id: "a5", label: "//apps/app:browserE2e", reasons: "dependent" }
]

const MATRIX = [
  { id: "m1", job: "cache-publish", os: "ubuntu-latest", advisory: "—", tone: "muted" as const },
  { id: "m2", job: "test", os: "ubuntu-latest", advisory: "—", tone: "muted" as const },
  { id: "m3", job: "packages", os: "ubuntu-latest", advisory: "false", tone: "ok" as const },
  { id: "m4", job: "packages", os: "macos-latest", advisory: "true", tone: "warn" as const },
  { id: "m5", job: "packages", os: "windows-latest", advisory: "true", tone: "warn" as const }
]

const SUSPECTED = [
  { id: "s1", scope: "packages/smithers/build/src/**", affects: "//packages/smithers/build:test", confidence: "0.86" },
  { id: "s2", scope: "crates/flows-jj/**", affects: "//crates/flows-jj:cargoTest", confidence: "0.94" },
  { id: "s3", scope: "docs/**", affects: "//packages/smithers/build:docs", confidence: "0.41" }
]

export const Pane = pane({
  id: "build",
  title: "Build targets",
  summary: "The target graph, cache hits and the affected set",
  packages: ["@smthrs/build-cli", "@smthrs/build"],
  render: (context) => <BuildBody {...context} />
})

function BuildBody({ props, set: runCommandSet }: ExperimentalPaneContext) {
  const target = typeof props.target === "string" ? props.target : ":lib"
  const selected = TARGETS.find((row) => row.id === target) ?? TARGETS[0]
  return (
    <Split
      left={
        <>
          <Section title="Workspace" right={<Badge tone="ok">split</Badge>}>
            <Facts rows={[
              { label: "cache.directory", value: ".flows", mono: true },
              { label: "remote", value: "api.jjhub.tech", mono: true },
              { label: "namespace", value: "smithersai/smithers", mono: true },
              { label: "runtime", value: "Node 26.4.0", mono: true },
              { label: "packageManager", value: "Pnpm 11.16.0", mono: true },
              { label: "environment", value: "Nix flake", mono: true },
              { label: "EXECUTION_FORMAT", value: 5, mono: true }
            ]} />
          </Section>
          <Section title="Diff">
            <Facts rows={[
              { label: "base", value: "origin/main", mono: true },
              { label: "head", value: "@", mono: true },
              { label: "files", value: 14, mono: true },
              { label: "globalInputs", value: 0, mono: true },
              { label: "conservative", value: <Badge tone="ok">false</Badge> }
            ]} />
          </Section>
        </>
      }
      right={
        <>
          <Section title="Graph" right={<Badge tone="muted">//packages/smithers/build</Badge>}>
            <Graph
              nodes={TARGETS.map((row) => ({
                id: row.id,
                label: row.label,
                depth: row.depth,
                lane: row.lane,
                tone: row.tone
              }))}
              edges={EDGES}
              selected={target}
              onSelect={(id) => runCommandSet("target", id)}
            />
          </Section>
          <Section title="Targets" right="hit · ran · failed · skipped">
            <Table
              columns={[
                { key: "label", label: "Target", mono: true },
                { key: "rule", label: "Rule", mono: true },
                { key: "status", label: "Status" },
                { key: "source", label: "Bytes", mono: true },
                { key: "ms", label: "Took", mono: true, right: true }
              ]}
              rows={TARGETS.map((row) => ({
                id: row.id,
                label: row.label,
                rule: row.rule,
                status: <Badge tone={row.tone}>{row.status}</Badge>,
                source: row.source,
                ms: row.ms
              }))}
              selected={target}
              onSelect={(id) => runCommandSet("target", id)}
            />
          </Section>
          <Section title={selected.label} right={<Badge tone={selected.tone}>{selected.status}</Badge>}>
            <Facts rows={[
              { label: "key", value: selected.key, mono: true },
              { label: "header", value: "smithers-build-key/1", mono: true },
              { label: "kinds", value: selected.kinds, mono: true },
              { label: "layers", value: "[]", mono: true },
              { label: "capabilities", value: selected.capabilities, mono: true },
              { label: "local", value: selected.local, mono: true },
              { label: "remote", value: selected.remote, mono: true }
            ]} />
          </Section>
          <Section title="Affected" right={<Badge tone="info">5 targets</Badge>}>
            <Table
              columns={[
                { key: "label", label: "Target", mono: true },
                { key: "reasons", label: "reasons", mono: true }
              ]}
              rows={AFFECTED}
            />
          </Section>
          <Section title="CI matrix" right="failFast false · 7 required">
            <Table
              columns={[
                { key: "job", label: "Job", mono: true },
                { key: "os", label: "os", mono: true },
                { key: "advisory", label: "advisory", right: true }
              ]}
              rows={MATRIX.map((row) => ({
                id: row.id,
                job: row.job,
                os: row.os,
                advisory: row.advisory === "—" ? row.advisory : <Badge tone={row.tone}>{row.advisory}</Badge>
              }))}
            />
          </Section>
          <Section title="flows_selection_suspected_edges" right={<Badge tone="muted">advisory</Badge>}>
            <Table
              columns={[
                { key: "scope", label: "scope", mono: true },
                { key: "affects", label: "affects", mono: true },
                { key: "confidence", label: "confidence", mono: true, right: true }
              ]}
              rows={SUSPECTED}
            />
          </Section>
        </>
      }
    />
  )
}

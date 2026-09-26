/*
 * Mock: Version control. Behind VITE_SMITHERS_EXPERIMENTAL, reached by
 * `/experimental.jj`. Self-contained on purpose — see ../Pane.ts.
 *
 * Nine operations behind one service tag, every one of them a capability the
 * kernel checks and a `jj` argv some layer spawned. A run's tree moves and the
 * only evidence today is whatever the step printed, so a `snapshot_refused`
 * reads as "the agent did nothing" rather than as jj refusing a file.
 */
import { pane, type ExperimentalPaneContext } from "../Pane"
import { Badge, Facts, Section, Split, Table, type Tone } from "../Primitives"

interface Entry {
  readonly id: string
  readonly method: string
  readonly action: string
  readonly tier: "sealed" | "compensable"
  readonly argument: string
  readonly command: string
  readonly result: string
  readonly ms: string
  readonly tone: Tone
  readonly code?: string
  readonly cause?: string
}

const LOG: ReadonlyArray<Entry> = [
  {
    id: "o1",
    method: "root",
    action: "jj:root",
    tier: "sealed",
    argument: "/Users/will/smithers/apps/app",
    command: "jj root",
    result: "/Users/will/smithers",
    ms: "12 ms",
    tone: "ok"
  },
  {
    id: "o2",
    method: "status",
    action: "jj:status",
    tier: "sealed",
    argument: ".",
    command: "jj status",
    result: "2 files changed",
    ms: "31 ms",
    tone: "ok"
  },
  {
    id: "o3",
    method: "snapshot",
    action: "jj:snapshot",
    tier: "compensable",
    argument: "before the risky step",
    command: "jj op log -n1 -T id · jj log --at-op=<operation> -r @",
    result: "kqmzxrolnvpt",
    ms: "184 ms",
    tone: "ok"
  },
  {
    id: "o4",
    method: "workspaceAdd",
    action: "jj:workspace-add",
    tier: "compensable",
    argument: "lane-1 → /Users/will/smithers-lane-1",
    command: "jj workspace add --name=lane-1 --revision=kqmzxrolnvpt -- /Users/will/smithers-lane-1",
    result: "added",
    ms: "921 ms",
    tone: "ok"
  },
  {
    id: "o5",
    method: "diff",
    action: "jj:diff",
    tier: "sealed",
    argument: "kqmzxrolnvpt:@",
    command: "jj diff --from kqmzxrolnvpt --to @ --git",
    result: "4.2 KiB",
    ms: "66 ms",
    tone: "ok"
  },
  {
    id: "o6",
    method: "snapshot",
    action: "jj:snapshot",
    tier: "compensable",
    argument: "after the risky step",
    command: "jj op log -n1 -T id",
    result: "snapshot_refused",
    ms: "240 ms",
    tone: "bad",
    code: "snapshot_refused",
    cause: "Refused to snapshot some files: target/debug/build.log (1.4 GiB)"
  },
  {
    id: "o7",
    method: "restore",
    action: "jj:restore",
    tier: "compensable",
    argument: "kqmzxrolnvpt",
    command: "jj restore --from kqmzxrolnvpt",
    result: "restored",
    ms: "148 ms",
    tone: "ok"
  },
  {
    id: "o8",
    method: "revert",
    action: "jj:revert",
    tier: "compensable",
    argument: "ztuvwxyzmnop",
    command: "jj revert -r ztuvwxyzmnop --insert-before @",
    result: "3 files",
    ms: "210 ms",
    tone: "ok"
  },
  {
    id: "o9",
    method: "workspaceForget",
    action: "jj:workspace-forget",
    tier: "compensable",
    argument: "lane-1",
    command: "jj workspace forget -- lane-1",
    result: "forgotten",
    ms: "54 ms",
    tone: "ok"
  }
]

const OPERATIONS = [
  { id: "snapshot", action: "jj:snapshot", tier: "compensable", member: "required", command: "jj op log -n1 -T id" },
  { id: "restore", action: "jj:restore", tier: "compensable", member: "required", command: "jj restore --from <rev>" },
  { id: "diff", action: "jj:diff", tier: "sealed", member: "required", command: "jj diff --from <a> --to <b> --git" },
  {
    id: "workspaceAdd",
    action: "jj:workspace-add",
    tier: "compensable",
    member: "required",
    command: "jj workspace add --name=<name> -- <path>"
  },
  {
    id: "workspaceForget",
    action: "jj:workspace-forget",
    tier: "compensable",
    member: "required",
    command: "jj workspace forget -- <name>"
  },
  { id: "status", action: "jj:status", tier: "sealed", member: "required", command: "jj status" },
  { id: "root", action: "jj:root", tier: "sealed", member: "optional", command: "jj root" },
  { id: "revert", action: "jj:revert", tier: "compensable", member: "optional", command: "jj revert -r <rev> --insert-before @" },
  { id: "opRestore", action: "jj:op-restore", tier: "compensable", member: "optional", command: "jj op restore <operation>" }
]

export const Pane = pane({
  id: "jj",
  title: "Version control",
  summary: "Every jj operation a run ran",
  packages: ["@smthrs/jj"],
  render: (context) => <JjBody {...context} />
})

function JjBody({ props, set: runCommandSet }: ExperimentalPaneContext) {
  const op = typeof props.op === "string" ? props.op : "o6"
  const entry = LOG.find((row) => row.id === op)
  if (entry === undefined) return null
  return (
    <Split
      left={
        <>
          <Section title="Layer">
            <Facts rows={[
              { label: "Layer", value: "NodeJj.layerSpawnerAt", mono: true },
              { label: "Binary", value: "/opt/homebrew/bin/jj", mono: true },
              { label: "Chosen by", value: "SMITHERS_JJ_PATH", mono: true },
              { label: "Version", value: "0.41.2", mono: true },
              { label: "Minimum", value: "0.39.0", mono: true },
              { label: "Root", value: "/Users/will/smithers", mono: true },
              { label: "Ceiling", value: "64 MiB per stream" }
            ]} />
          </Section>
          <Section title="Lock" right="per repository">
            <Facts rows={[
              { label: "Owner", value: ".jj/smithers.lock", mono: true },
              { label: "Held by", value: "pid 4417", mono: true },
              { label: "Permits", value: "1" },
              { label: "Waiters", value: "0" },
              { label: "Serialized", value: "snapshot, restore, diff", mono: true }
            ]} />
          </Section>
        </>
      }
      right={
        <>
          <Section title="Log" right={`${LOG.length} operations`}>
            <Table
              columns={[
                { key: "n", label: "#", right: true },
                { key: "method", label: "Method", mono: true },
                { key: "argument", label: "Argument", mono: true },
                { key: "result", label: "Result" },
                { key: "ms", label: "Took", mono: true, right: true }
              ]}
              rows={LOG.map((row, index) => ({
                id: row.id,
                n: index + 1,
                method: row.method,
                argument: row.argument,
                result: <Badge tone={row.tone}>{row.result}</Badge>,
                ms: row.ms
              }))}
              selected={op}
              onSelect={(id) => runCommandSet("op", id)}
            />
          </Section>
          <Section
            title={entry.method}
            right={entry.code === undefined ? <Badge tone="ok">settled</Badge> : <Badge tone="bad">{entry.code}</Badge>}
          >
            <Facts rows={[
              { label: "Capability", value: entry.action, mono: true },
              { label: "Tier", value: entry.tier },
              { label: "Command", value: entry.command, mono: true },
              ...(entry.code === undefined
                ? [{ label: "Result", value: entry.result, mono: true }]
                : [
                  { label: "Error", value: "@smthrs/jj/JjError", mono: true },
                  { label: "Message", value: `${entry.code}: Jj.${entry.method}`, mono: true },
                  { label: "Cause", value: entry.cause ?? "", mono: true }
                ]),
              { label: "Took", value: entry.ms, mono: true }
            ]} />
          </Section>
          <Section title="Operations" right="one service tag">
            <Table
              columns={[
                { key: "id", label: "Method", mono: true },
                { key: "action", label: "Capability", mono: true },
                { key: "tier", label: "Tier" },
                { key: "member", label: "Member" },
                { key: "command", label: "Command", mono: true }
              ]}
              rows={OPERATIONS.map((row) => ({
                id: row.id,
                action: row.action,
                tier: row.tier,
                member: row.member === "optional" ? <Badge tone="muted">optional</Badge> : "required",
                command: row.command
              }))}
              selected={entry.method}
              onSelect={(method) => runCommandSet("op", LOG.find((row) => row.method === method)?.id ?? op)}
            />
          </Section>
        </>
      }
    />
  )
}

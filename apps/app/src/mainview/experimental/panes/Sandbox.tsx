/*
 * Mock: Sandbox. Behind VITE_SMITHERS_EXPERIMENTAL, reached by
 * `/experimental.sandbox`. Self-contained on purpose — see ../Pane.ts.
 *
 * Nine providers adapt a vendor session to `Sandbox.Provider`, and
 * `Sandbox.commandProvider` projects one onto the narrower
 * `RemoteChildProcessSpawner.Provider`. What no surface shows is the matrix:
 * which optional members a provider actually implements, which
 * `SandboxConformance` checks held against it, whether its session is still
 * answering a ping, and which machine a step really ran on.
 */
import { pane, type ExperimentalPaneContext } from "../Pane"
import { Badge, Facts, Rail, Section, Split, Table, type Tone } from "../Primitives"

interface Violation {
  readonly check: string
  readonly expected: string
  readonly actual: string
}

interface Provider {
  readonly id: string
  readonly module: string
  readonly seam: string
  readonly session: string
  readonly remoteId: string
  readonly workdir: string
  readonly kill: boolean
  readonly ping: boolean
  /** Native `Session.files` overrides for operations `fileSystem` would probe. */
  readonly files: boolean
  readonly skipped: ReadonlyArray<string>
  readonly violations: ReadonlyArray<Violation>
  readonly health: "Healthy" | "Unhealthy"
  readonly reason?: "unresponsive" | "ping_failed"
  readonly message?: string
  readonly probes?: number
}

const CHECKS = [
  "runs-in-its-workdir",
  "roots-a-relative-cwd",
  "delivers-the-environment",
  "delivers-standard-input",
  "reports-a-nonzero-exit",
  "signals-a-running-command",
  "round-trips-binary-bytes",
  "creates-parent-directories",
  "reacquires-its-session",
  "answers-a-ping"
]

const NO_KILL = ["signals-a-running-command"]

const PROVIDERS: ReadonlyArray<Provider> = [
  {
    id: "aws",
    module: "AwsSandbox",
    seam: "Sandbox.Provider",
    session: "run:01JQ8/plan",
    remoteId: "arn:aws:ecs:us-east-1:task/4f8c1a",
    workdir: "/workspace",
    kill: true,
    ping: true,
    files: false,
    skipped: [],
    violations: [],
    health: "Healthy"
  },
  {
    id: "cloudflare",
    module: "CloudflareSandbox",
    seam: "Sandbox.Provider",
    session: "run:01JQ8/fetch",
    remoteId: "do:sandbox-9a21c4",
    workdir: "/workspace",
    kill: false,
    ping: true,
    files: false,
    skipped: NO_KILL,
    violations: [],
    health: "Healthy"
  },
  {
    id: "container",
    module: "ContainerSandbox",
    seam: "Sandbox.Provider",
    session: "run:01JQ8/implement",
    remoteId: "smithers-sbx-7f3a",
    workdir: "/workspace",
    kill: true,
    ping: true,
    files: true,
    skipped: [],
    violations: [],
    health: "Unhealthy",
    reason: "ping_failed",
    message: "exit 125",
    probes: 2
  },
  {
    id: "daytona",
    module: "DaytonaSandbox",
    seam: "Sandbox.Provider",
    session: "run:01JQ8/docs",
    remoteId: "ws-3c9f20",
    workdir: "/home/daytona/workspace",
    kill: false,
    ping: true,
    files: false,
    skipped: NO_KILL,
    violations: [],
    health: "Healthy"
  },
  {
    id: "directory",
    module: "DirectorySandbox",
    seam: "Sandbox.Provider",
    session: "run:01JQ8/review",
    remoteId: "/tmp/smithers-sbx-2f10",
    workdir: "/tmp/smithers-sbx-2f10",
    kill: true,
    ping: true,
    files: true,
    skipped: [],
    violations: [{
      check: "signals-a-running-command",
      expected: "the command stops within Commands.stopsWithin",
      actual: "kill answered success, pid 48211 still running after 5 s"
    }],
    health: "Healthy"
  },
  {
    id: "just-bash",
    module: "JustBashSandbox",
    seam: "Sandbox.Provider",
    session: "run:01JQ8/plan",
    remoteId: "jb-0",
    workdir: "/workspace",
    kill: false,
    ping: true,
    files: true,
    skipped: NO_KILL,
    violations: [],
    health: "Healthy"
  },
  {
    id: "kubernetes",
    module: "KubernetesSandbox",
    seam: "Sandbox.Provider",
    session: "run:01JQ8/test",
    remoteId: "pod/smithers-sbx-91c4",
    workdir: "/workspace",
    kill: true,
    ping: true,
    files: false,
    skipped: [],
    violations: [],
    health: "Healthy"
  },
  {
    id: "microsandbox",
    module: "MicrosandboxSandbox",
    seam: "Sandbox.Provider",
    session: "run:01JQ8/build",
    remoteId: "msb-6d0e93",
    workdir: "/workspace",
    kill: false,
    ping: true,
    files: false,
    skipped: NO_KILL,
    violations: [],
    health: "Healthy"
  },
  {
    id: "vercel",
    module: "VercelSandbox",
    seam: "Sandbox.Provider",
    session: "run:01JQ8/publish",
    remoteId: "sbx_ka8t1p",
    workdir: "/vercel/sandbox",
    kill: false,
    ping: true,
    files: false,
    skipped: NO_KILL,
    violations: [],
    health: "Healthy"
  }
]

const PLACEMENT = [
  { id: "p1", step: "plan", provider: "just-bash", session: "run:01JQ8/plan", remoteId: "jb-0", result: "exit 0", tone: "ok" as Tone },
  {
    id: "p2",
    step: "implement",
    provider: "container",
    session: "run:01JQ8/implement",
    remoteId: "smithers-sbx-7f3a",
    result: "unavailable",
    tone: "bad" as Tone
  },
  {
    id: "p3",
    step: "test",
    provider: "kubernetes",
    session: "run:01JQ8/test",
    remoteId: "pod/smithers-sbx-91c4",
    result: "exit 1",
    tone: "warn" as Tone
  },
  {
    id: "p4",
    step: "review",
    provider: "directory",
    session: "run:01JQ8/review",
    remoteId: "/tmp/smithers-sbx-2f10",
    result: "exit 0",
    tone: "ok" as Tone
  }
]

const railNote = (provider: Provider): { readonly note: string; readonly tone: Tone } =>
  provider.violations.length > 0
    ? { note: `${provider.violations.length} violation`, tone: "bad" }
    : provider.skipped.length > 0
    ? { note: `${provider.skipped.length} skipped`, tone: "muted" }
    : { note: "conforms", tone: "ok" }

export const Pane = pane({
  id: "sandbox",
  title: "Sandbox",
  summary: "Where a step ran, which provider served it and whether it is alive",
  packages: ["@smthrs/sandbox"],
  render: (context) => <SandboxBody {...context} />
})

function SandboxBody({ props, set: runCommandSet }: ExperimentalPaneContext) {
  const id = typeof props.id === "string" ? props.id : "container"
  const provider = PROVIDERS.find((row) => row.id === id)
  if (provider === undefined) return null
  const violation = provider.violations[0]
  return (
    <Split
      left={
        <>
          <Section title="Providers">
            <Rail
              items={PROVIDERS.map((row) => ({ id: row.id, label: row.module, ...railNote(row) }))}
              selected={id}
              onSelect={(id) => runCommandSet("id", id)}
            />
          </Section>
          <Section title="Supervision">
            <Facts rows={[
              { label: "Interval", value: "10 seconds" },
              { label: "Tolerance", value: "2" },
              { label: "Probes", value: String(provider.probes ?? 0) },
              { label: "Reason", value: provider.reason ?? "—", mono: true },
              { label: "Message", value: provider.message ?? "—", mono: true }
            ]} />
          </Section>
        </>
      }
      right={
        <>
          <Section
            title={provider.module}
            right={
              provider.health === "Healthy"
                ? <Badge tone="ok">Healthy</Badge>
                : <Badge tone="bad">Unhealthy</Badge>
            }
          >
            <Facts rows={[
              { label: "Seam", value: provider.seam, mono: true },
              { label: "Session", value: provider.session, mono: true },
              { label: "Remote", value: provider.remoteId, mono: true },
              { label: "Workdir", value: provider.workdir, mono: true },
              {
                label: "Provides",
                value: (
                  <>
                    <Badge tone={provider.ping ? "ok" : "muted"}>ping</Badge>
                    {" "}
                    <Badge tone={provider.kill ? "ok" : "muted"}>kill</Badge>
                    {" "}
                    <Badge tone={provider.files ? "ok" : "muted"}>files</Badge>
                  </>
                )
              },
              { label: "Host", value: "ChildProcessSpawner, FileSystem, Path, SandboxHealth", mono: true }
            ]} />
          </Section>
          <Section title="Conformance" right="SandboxConformance.check">
            <Table
              columns={[
                { key: "check", label: "Check", mono: true },
                { key: "verdict", label: "Verdict", right: true }
              ]}
              rows={CHECKS.map((check) => ({
                id: check,
                check,
                verdict: provider.violations.some((entry) => entry.check === check)
                  ? <Badge tone="bad">failed</Badge>
                  : provider.skipped.includes(check)
                  ? <Badge tone="muted">skipped</Badge>
                  : <Badge tone="ok">held</Badge>
              }))}
            />
          </Section>
          {violation === undefined ? null : (
            <Section title="Violation">
              <Facts rows={[
                { label: "Check", value: violation.check, mono: true },
                { label: "Expected", value: violation.expected },
                { label: "Actual", value: violation.actual }
              ]} />
            </Section>
          )}
          <Section title="Placement" right="where the step ran">
            <Table
              columns={[
                { key: "step", label: "Step" },
                { key: "provider", label: "Provider" },
                { key: "session", label: "Session", mono: true },
                { key: "remoteId", label: "Remote", mono: true },
                { key: "result", label: "Result", right: true }
              ]}
              rows={PLACEMENT.map((row) => ({
                id: row.id,
                step: row.step,
                provider: row.provider,
                session: row.session,
                remoteId: row.remoteId,
                result: <Badge tone={row.tone}>{row.result}</Badge>
              }))}
              selected={PLACEMENT.find((row) => row.provider === id)?.id}
              onSelect={(selected) => runCommandSet("id", PLACEMENT.find((row) => row.id === selected)?.provider ?? id)}
            />
          </Section>
        </>
      }
    />
  )
}

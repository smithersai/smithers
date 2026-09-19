/*
 * Mock: Harnesses. Behind VITE_SMITHERS_EXPERIMENTAL, reached by
 * `/experimental.harnesses`. Self-contained on purpose — see ../Pane.ts.
 *
 * `detectHarnessesWith` already answers, for every id in `HARNESS_IDS`,
 * whether the binary is on this machine, what version it is, and which
 * account it is signed into — and nothing shows the probe that decided it.
 * The three reads are `findBinary` down the candidate dirs, `<binary>
 * --version` under `probeEnv`, and the vendor's own `Signal` file.
 */
import { pane, type ExperimentalPaneContext } from "../Pane"
import { Badge, Bars, Facts, Rail, Section, Split, Steps, Table, type Tone } from "../Primitives"

type Status = "signed-in" | "api-key" | "binary-only" | "unavailable"

interface Harness {
  readonly id: string
  readonly displayName: string
  readonly binary: string | null
  readonly version: string | null
  readonly status: Status
  readonly account: string | null
  readonly launch: string
  /** The `Signal` read that answered: a vendor file, or an API-key variable. */
  readonly signal: string
  readonly suggestions: ReadonlyArray<string>
  readonly listable: boolean
  /** No `models` entry: the binary's `--help` names no verified model flag. */
  readonly modelFlag: boolean
}

const STATUS_TONE: Readonly<Record<Status, Tone>> = {
  "signed-in": "ok",
  "api-key": "info",
  "binary-only": "warn",
  unavailable: "muted"
}

const HARNESSES: ReadonlyArray<Harness> = [
  {
    id: "claude",
    displayName: "Claude Code",
    binary: "~/.local/bin/claude",
    version: "2.1.247",
    status: "signed-in",
    account: "roninfucory@gmail.com",
    launch: "claude",
    signal: "~/.claude.json oauthAccount",
    suggestions: ["claude-fable-5", "fable", "opus", "sonnet"],
    listable: false,
    modelFlag: true
  },
  {
    id: "codex",
    displayName: "Codex",
    binary: "/opt/homebrew/bin/codex",
    version: "0.58.0",
    status: "signed-in",
    account: "roninfucory@gmail.com",
    launch: "codex",
    signal: "~/.codex/auth.json tokens.id_token email",
    suggestions: ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"],
    listable: false,
    modelFlag: true
  },
  {
    id: "gemini",
    displayName: "Gemini",
    binary: null,
    version: null,
    status: "unavailable",
    account: null,
    launch: "gemini",
    signal: "~/.gemini/oauth_creds.json",
    suggestions: [],
    listable: false,
    modelFlag: true
  },
  {
    id: "kimi",
    displayName: "Kimi",
    binary: "~/.local/bin/kimi",
    version: "0.4.2",
    status: "signed-in",
    account: "kimi-code",
    launch: "kimi",
    signal: "~/.kimi/credentials/kimi-code.json",
    suggestions: [],
    listable: false,
    modelFlag: true
  },
  {
    id: "opencode",
    displayName: "OpenCode",
    binary: "~/.opencode/bin/opencode",
    version: "1.18.22",
    status: "signed-in",
    account: "kimi-for-coding, cerebras",
    launch: "opencode",
    signal: "~/.local/share/opencode/auth.json",
    suggestions: ["kimi-for-coding/k3", "cerebras/gpt-oss-120b"],
    listable: true,
    modelFlag: true
  },
  {
    id: "opencode-kimi",
    displayName: "OpenCode · Kimi",
    binary: "~/.opencode/bin/opencode",
    version: "1.18.22",
    status: "signed-in",
    account: "kimi-for-coding",
    launch: "opencode --model kimi-for-coding/k3",
    signal: "~/.local/share/opencode/auth.json kimi-for-coding",
    suggestions: ["kimi-for-coding/k3"],
    listable: true,
    modelFlag: true
  },
  {
    id: "opencode-cerebras",
    displayName: "OpenCode · Cerebras",
    binary: "~/.opencode/bin/opencode",
    version: "1.18.22",
    status: "signed-in",
    account: "cerebras",
    launch: "opencode --model cerebras/gpt-oss-120b",
    signal: "~/.local/share/opencode/auth.json cerebras",
    suggestions: ["cerebras/gpt-oss-120b", "cerebras/gemma-4-31b"],
    listable: true,
    modelFlag: true
  },
  {
    id: "crush",
    displayName: "Crush",
    binary: "/opt/homebrew/bin/crush",
    version: "0.1.11",
    status: "api-key",
    account: "ANTHROPIC_API_KEY",
    launch: "crush",
    signal: "env ANTHROPIC_API_KEY",
    suggestions: [],
    listable: false,
    modelFlag: false
  },
  {
    id: "amp",
    displayName: "Amp",
    binary: null,
    version: null,
    status: "unavailable",
    account: null,
    launch: "amp",
    signal: "~/.config/amp/secrets.json",
    suggestions: [],
    listable: false,
    modelFlag: false
  },
  {
    id: "cursor-agent",
    displayName: "Cursor Agent",
    binary: "~/.local/bin/cursor-agent",
    version: "2026.09.03",
    status: "binary-only",
    account: null,
    launch: "cursor-agent",
    signal: "~/.cursor/auth.json",
    suggestions: ["gpt-5", "sonnet-4", "sonnet-4-thinking"],
    listable: false,
    modelFlag: true
  },
  {
    id: "hermes",
    displayName: "Hermes",
    binary: null,
    version: null,
    status: "unavailable",
    account: null,
    launch: "hermes",
    signal: "~/.hermes/auth.json",
    suggestions: ["anthropic/claude-sonnet-4.6"],
    listable: false,
    modelFlag: true
  },
  {
    id: "pi",
    displayName: "Pi",
    binary: "~/.bun/bin/pi",
    version: "0.9.4",
    status: "signed-in",
    account: "~/.pi/agent/auth.json",
    launch: "pi",
    signal: "~/.pi/agent/auth.json",
    suggestions: [],
    listable: false,
    modelFlag: false
  }
]

const CANDIDATE_DIRS = [
  { id: "d1", label: "~/.local/bin", note: "claude, kimi, cursor-agent", tone: "ok" as Tone },
  { id: "d2", label: "~/.bun/bin", note: "pi", tone: "ok" as Tone },
  { id: "d3", label: "/opt/homebrew/bin", note: "codex, crush", tone: "ok" as Tone },
  { id: "d4", label: "/usr/local/bin", tone: "muted" as Tone },
  { id: "d5", label: "~/.nvm/versions/node/v24.6.0/bin", tone: "muted" as Tone },
  { id: "d6", label: "~/.cargo/bin", tone: "muted" as Tone },
  { id: "d7", label: "~/.opencode/bin", note: "opencode", tone: "ok" as Tone },
  { id: "d8", label: "$PATH", note: "14 entries", tone: "muted" as Tone }
]

const STATUSES = [
  { label: "signed-in", value: 7, display: "7", tone: "ok" as Tone },
  { label: "api-key", value: 1, display: "1", tone: "info" as Tone },
  { label: "binary-only", value: 1, display: "1", tone: "warn" as Tone },
  { label: "unavailable", value: 3, display: "3", tone: "muted" as Tone }
]

export const Pane = pane({
  id: "harnesses",
  title: "Harnesses",
  summary: "Which agent CLIs this machine has and who they are signed in as",
  packages: ["@smthrs/harness-detect"],
  render: (context) => <HarnessesBody {...context} />
})

function HarnessesBody({ props, set: runCommandSet }: ExperimentalPaneContext) {
  const id = typeof props.id === "string" ? props.id : "codex"
  const harness = HARNESSES.find((row) => row.id === id)
  if (harness === undefined) return null
  const found = harness.binary !== null
  return (
    <Split
      left={
        <>
          <Section title="Harnesses">
            <Rail
              items={HARNESSES.map((row) => ({
                id: row.id,
                label: row.id,
                note: row.status,
                tone: STATUS_TONE[row.status]
              }))}
              selected={id}
              onSelect={(id) => runCommandSet("id", id)}
            />
          </Section>
          <Section title="Status"><Bars rows={STATUSES} /></Section>
          <Section title="Candidate dirs" right="searched in order">
            <Steps steps={CANDIDATE_DIRS} />
          </Section>
        </>
      }
      right={
        <>
          <Section title={harness.displayName} right={<Badge tone={STATUS_TONE[harness.status]}>{harness.status}</Badge>}>
            <Facts rows={[
              { label: "Id", value: harness.id, mono: true },
              { label: "Binary", value: harness.binary ?? "—", mono: true },
              { label: "Version", value: harness.version ?? "—", mono: true },
              { label: "Account", value: harness.account ?? "—", mono: true },
              { label: "Launch", value: harness.launch, mono: true },
              {
                label: "Models",
                value: !harness.modelFlag
                  ? <Badge tone="muted">no model flag</Badge>
                  : harness.suggestions.length === 0
                  ? <Badge tone="info">free text</Badge>
                  : (
                    <>
                      {harness.suggestions.join(", ")}
                      {harness.listable ? <> <Badge tone="ok">listable</Badge></> : null}
                    </>
                  )
              }
            ]} />
          </Section>
          <Section title="Probe" right="probeEnv · 21 keys">
            <Steps steps={[
              {
                id: "s1",
                label: `findBinary("${harness.launch.split(" ")[0]}")`,
                note: harness.binary ?? "no candidate dir, no PATH entry",
                tone: found ? "ok" : "bad"
              },
              {
                id: "s2",
                label: "--version",
                note: found ? `${harness.version ?? "unparsed"} · under 3000 ms` : "skipped",
                tone: found ? "ok" : "muted"
              },
              {
                id: "s3",
                label: harness.signal,
                note: found ? (harness.account ?? "no credential") : "skipped",
                tone: !found ? "muted" : harness.account === null ? "warn" : "ok"
              }
            ]} />
          </Section>
          <Section title="Rows" right="HARNESS_IDS order">
            <Table
              columns={[
                { key: "id", label: "Id", mono: true },
                { key: "version", label: "Version", mono: true },
                { key: "status", label: "Status" },
                { key: "account", label: "Account", mono: true, right: true }
              ]}
              rows={HARNESSES.map((row) => ({
                id: row.id,
                version: row.version ?? "—",
                status: <Badge tone={STATUS_TONE[row.status]}>{row.status}</Badge>,
                account: row.account ?? "—"
              }))}
              selected={id}
              onSelect={(id) => runCommandSet("id", id)}
            />
          </Section>
        </>
      }
    />
  )
}

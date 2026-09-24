/*
 * Mock: Models and seats. Behind VITE_SMITHERS_EXPERIMENTAL, reached by
 * `/experimental.models`. Self-contained on purpose — see ../Pane.ts.
 *
 * The question the product cannot answer today: a seat went dark and nothing
 * says which model it sat on, which credential signed for it, or how far the
 * request got. A seat is one of the six built-in roles of
 * `@smthrs/rpc/AgentRoles` or a decision seat Jev answers; its model id
 * resolves to one `Route` — `Endpoint`, `Protocol`, `Framing`, `Auth` — and
 * `ModelCatalog.contextWindowTokensFor` reads the window off the id alone.
 * The last section is the debug half: `RequestExecutor` spends at most two
 * retries, and `authentication` is not one of the codes it spends them on.
 */
import { pane, type ExperimentalPaneContext } from "../Pane"
import { Badge, Bars, Code, Facts, Rail, Section, Split, Steps, Table } from "../Primitives"

const SEATS = [
  {
    id: "orchestrator",
    kind: "role" as const,
    label: "Orchestrator",
    purpose: "Plans, writes flows frame by frame, delegates most work.",
    modelId: "claude-fable-5",
    modelLabel: "Fable 5",
    harness: "claude",
    harnessState: "signed-in",
    floor: "—",
    fallback: "claude-sonnet-4-5",
    delegates: "yes",
    routeId: "anthropic",
    protocolId: "anthropic-messages",
    url: "https://api.anthropic.com/v1/messages",
    framing: "sse",
    credential: "x-api-key ← ANTHROPIC_API_KEY",
    header: "anthropic-version: 2023-06-01",
    deferred: "supported",
    window: 1_000_000,
    windowText: "1 000 000",
    zdr: "—",
    deadline: "—",
    state: "authentication",
    tone: "bad" as const
  },
  {
    id: "explainer",
    kind: "role" as const,
    label: "Explainer",
    purpose: "Explains errors, code, runs and decisions in plain language.",
    modelId: "kimi-for-coding/k3",
    modelLabel: "Kimi K3",
    harness: "opencode-kimi",
    harnessState: "api-key",
    floor: "—",
    fallback: "—",
    delegates: "no",
    routeId: "kimi-for-coding",
    protocolId: "openai-chat-completions",
    url: "https://api.moonshot.ai/v1/chat/completions",
    framing: "sse",
    credential: "Authorization: Bearer ← MOONSHOT_API_KEY",
    header: "—",
    deferred: "off",
    window: 128_000,
    windowText: "128 000",
    zdr: "—",
    deadline: "—",
    state: "ready",
    tone: "ok" as const
  },
  {
    id: "implementation",
    kind: "role" as const,
    label: "Implementation",
    purpose: "Implements non-trivial changes end to end, with tests.",
    modelId: "gpt-6-sol",
    modelLabel: "GPT-5.6 Sol",
    harness: "codex",
    harnessState: "signed-in",
    floor: "—",
    fallback: "claude-sonnet-4-5",
    delegates: "no",
    routeId: "openai",
    protocolId: "openai-responses",
    url: "https://api.openai.com/v1/responses",
    framing: "sse",
    credential: "Authorization: Bearer ← OPENAI_API_KEY",
    header: "—",
    deferred: "supported",
    window: 400_000,
    windowText: "400 000",
    zdr: "—",
    deadline: "—",
    state: "ready",
    tone: "ok" as const
  },
  {
    id: "trivial-implementation",
    kind: "role" as const,
    label: "Trivial implementation",
    purpose: "Small, low-risk, mechanical changes, quickly.",
    modelId: "gpt-6-luna",
    modelLabel: "GPT-5.6 Luna",
    harness: "codex",
    harnessState: "signed-in",
    floor: "—",
    fallback: "—",
    delegates: "no",
    routeId: "openai",
    protocolId: "openai-responses",
    url: "https://api.openai.com/v1/responses",
    framing: "sse",
    credential: "Authorization: Bearer ← OPENAI_API_KEY",
    header: "—",
    deferred: "supported",
    window: 400_000,
    windowText: "400 000",
    zdr: "—",
    deadline: "—",
    state: "rate_limited",
    tone: "warn" as const
  },
  {
    id: "ui",
    kind: "role" as const,
    label: "UI",
    purpose: "Builds and reviews UI and visual work.",
    modelId: "kimi-for-coding/k3",
    modelLabel: "Kimi K3",
    harness: "opencode-kimi",
    harnessState: "api-key",
    floor: "—",
    fallback: "—",
    delegates: "no",
    routeId: "kimi-for-coding",
    protocolId: "openai-chat-completions",
    url: "https://api.moonshot.ai/v1/chat/completions",
    framing: "sse",
    credential: "Authorization: Bearer ← MOONSHOT_API_KEY",
    header: "—",
    deferred: "off",
    window: 128_000,
    windowText: "128 000",
    zdr: "—",
    deadline: "—",
    state: "ready",
    tone: "ok" as const
  },
  {
    id: "fast-ui",
    kind: "role" as const,
    label: "Fast UI",
    purpose: "Fast, cheap UI iterations.",
    modelId: "cerebras/qwen-3.8-27b",
    modelLabel: "Cerebras Qwen 3.8 27B",
    harness: "opencode-cerebras",
    harnessState: "binary-only",
    floor: "—",
    fallback: "—",
    delegates: "no",
    routeId: "cerebras",
    protocolId: "openai-chat-completions",
    url: "https://api.cerebras.ai/v1/chat/completions",
    framing: "sse",
    credential: "Authorization: Bearer ← CEREBRAS_API_KEY",
    header: "—",
    deferred: "off",
    window: 128_000,
    windowText: "128 000",
    zdr: "—",
    deadline: "—",
    state: "no_route",
    tone: "muted" as const
  },
  {
    id: "front-door",
    kind: "decision" as const,
    label: "Front door",
    purpose: "Reads whether a message is a command.",
    modelId: "typesafe-ai/jev",
    modelLabel: "Jev",
    harness: "—",
    harnessState: "—",
    floor: "0.85",
    fallback: "—",
    delegates: "—",
    routeId: "evaluator",
    protocolId: "jev 0.0.1 · spec 4",
    url: "https://ai-gateway.vercel.sh/v4/ai/evaluation-model",
    framing: "json",
    credential: "Authorization: Bearer ← AI_GATEWAY_API_KEY",
    header: "—",
    deferred: "—",
    window: 0,
    windowText: "—",
    zdr: "on",
    deadline: "1500 ms",
    state: "ready",
    tone: "ok" as const
  },
  {
    id: "completion-brake",
    kind: "decision" as const,
    label: "Completion brake",
    purpose: "Judges a completion claim against the run's evidence.",
    modelId: "typesafe-ai/jev",
    modelLabel: "Jev",
    harness: "—",
    harnessState: "—",
    floor: "0.80",
    fallback: "—",
    delegates: "—",
    routeId: "evaluator",
    protocolId: "jev 0.0.1 · spec 4",
    url: "https://ai-gateway.vercel.sh/v4/ai/evaluation-model",
    framing: "json",
    credential: "Authorization: Bearer ← AI_GATEWAY_API_KEY",
    header: "—",
    deferred: "—",
    window: 0,
    windowText: "—",
    zdr: "on",
    deadline: "1500 ms",
    state: "ready",
    tone: "ok" as const
  },
  {
    id: "health",
    kind: "decision" as const,
    label: "Health",
    purpose: "Reads whether a run is working, idle or needs a person.",
    modelId: "typesafe-ai/jev",
    modelLabel: "Jev",
    harness: "—",
    harnessState: "—",
    floor: "0.50",
    fallback: "—",
    delegates: "—",
    routeId: "evaluator",
    protocolId: "jev 0.0.1 · spec 4",
    url: "https://ai-gateway.vercel.sh/v4/ai/evaluation-model",
    framing: "json",
    credential: "Authorization: Bearer ← AI_GATEWAY_API_KEY",
    header: "—",
    deferred: "—",
    window: 0,
    windowText: "—",
    zdr: "on",
    deadline: "1500 ms",
    state: "ready",
    tone: "ok" as const
  }
]

const MODELS = [
  { id: "claude-fable-5", provider: "anthropic", protocol: "anthropic-messages", window: "1 000 000", seats: "1" },
  { id: "claude-sonnet-4-5", provider: "anthropic", protocol: "anthropic-messages", window: "200 000", seats: "0" },
  { id: "gpt-6-sol", provider: "openai", protocol: "openai-responses", window: "400 000", seats: "1" },
  { id: "gpt-6-luna", provider: "openai", protocol: "openai-responses", window: "400 000", seats: "1" },
  { id: "kimi-for-coding/k3", provider: "kimi-for-coding", protocol: "openai-chat-completions", window: "128 000", seats: "2" },
  { id: "cerebras/qwen-3.8-27b", provider: "cerebras", protocol: "openai-chat-completions", window: "128 000", seats: "1" },
  { id: "typesafe-ai/jev", provider: "typesafe-ai", protocol: "evaluation-model", window: "—", seats: "3" }
]

const PREPARED = `POST https://api.anthropic.com/v1/messages
anthropic-version: 2023-06-01
content-type: application/json
x-api-key: <redacted>

{"model":"claude-fable-5","max_tokens":4096,"stream":true,
 "system":[…],"messages":[…],"tools":[…]}`

const FAILED = [
  { id: "1", label: "prepare", note: "routeId anthropic · 41.2 KiB", tone: "muted" as const },
  { id: "2", label: "sign", note: "x-api-key", tone: "muted" as const },
  { id: "3", label: "attempt 1", note: "401 authentication_error", tone: "bad" as const },
  { id: "4", label: "refresh", note: "auth.refresh undefined", tone: "muted" as const },
  { id: "5", label: "settle", note: "ModelError authentication", tone: "bad" as const }
]

const SETTLED = [
  { id: "1", label: "prepare", note: "18.4 KiB", tone: "muted" as const },
  { id: "2", label: "sign", note: "Authorization", tone: "muted" as const },
  { id: "3", label: "attempt 1", note: "200 · 312 ms", tone: "ok" as const },
  { id: "4", label: "stream", note: "142 frames", tone: "ok" as const },
  { id: "5", label: "settle", note: "end_turn · 6 118 tokens", tone: "ok" as const }
]

const ROLE_SEATS = SEATS.filter((seat) => seat.kind === "role")
const DECISION_SEATS = SEATS.filter((seat) => seat.kind === "decision")

export const Pane = pane({
  id: "models",
  title: "Models and seats",
  summary: "Which model each role uses, its credential and its route",
  packages: ["@smthrs/model", "@smthrs/harness-detect"],
  render: (context) => <ModelsBody {...context} />
})

function ModelsBody({ props, set: runCommandSet }: ExperimentalPaneContext) {
  const id = typeof props.id === "string" ? props.id : "orchestrator"
  const seat = SEATS.find((row) => row.id === id) ?? SEATS[0]
  const failing = seat.tone === "bad"
  return (
    <Split
      left={
        <>
          <Section title="Agent roles">
            <Rail
              items={ROLE_SEATS.map((row) => ({ id: row.id, label: row.label, note: row.modelLabel, tone: row.tone }))}
              selected={id}
              onSelect={(id) => runCommandSet("id", id)}
            />
          </Section>
          <Section title="Decision seats">
            <Rail
              items={DECISION_SEATS.map((row) => ({ id: row.id, label: row.label, note: row.floor, tone: row.tone }))}
              selected={id}
              onSelect={(id) => runCommandSet("id", id)}
            />
          </Section>
        </>
      }
      right={
        <>
          <Section title={seat.label} right={<Badge tone={seat.tone}>{seat.state}</Badge>}>
            <Facts rows={[
              { label: "Purpose", value: seat.purpose },
              { label: "Model", value: seat.modelId, mono: true },
              seat.kind === "role"
                ? { label: "Harness", value: <Badge tone={seat.harnessState === "signed-in" ? "ok" : "warn"}>{`${seat.harness} · ${seat.harnessState}`}</Badge> }
                : { label: "Floor", value: seat.floor, mono: true },
              seat.kind === "role"
                ? { label: "Fallback", value: seat.fallback, mono: true }
                : { label: "Deadline", value: seat.deadline, mono: true },
              seat.kind === "role"
                ? { label: "Delegates", value: seat.delegates }
                : { label: "Zero data retention", value: seat.zdr }
            ]} />
          </Section>
          <Section title="Route" right={<Badge tone="info">{seat.framing}</Badge>}>
            <Facts rows={[
              { label: "Route", value: seat.routeId, mono: true },
              { label: "Protocol", value: seat.protocolId, mono: true },
              { label: "Endpoint", value: `POST ${seat.url}`, mono: true },
              { label: "Credential", value: seat.credential, mono: true },
              { label: "Header", value: seat.header, mono: true },
              { label: "Deferred tools", value: seat.deferred },
              { label: "Context window", value: seat.windowText, mono: true }
            ]} />
            <Code label="prepared">{PREPARED}</Code>
          </Section>
          <Section title="Models" right={`${MODELS.length} ids`}>
            <Table
              columns={[
                { key: "id", label: "Model id", mono: true },
                { key: "provider", label: "Provider" },
                { key: "protocol", label: "Protocol", mono: true },
                { key: "window", label: "Window", mono: true, right: true },
                { key: "seats", label: "Seats", right: true }
              ]}
              rows={MODELS}
            />
          </Section>
          <Section title="Context window" right="ModelCatalog">
            <Bars rows={ROLE_SEATS.map((row) => ({
              label: `${row.label} · ${row.modelLabel}`,
              value: row.window,
              display: row.windowText,
              tone: row.id === seat.id ? "info" : "muted"
            }))} />
          </Section>
          <Section title="Request" right={<Badge tone={failing ? "bad" : "ok"}>{failing ? "terminal" : "settled"}</Badge>}>
            <Steps steps={failing ? FAILED : SETTLED} />
            <Facts rows={[
              { label: "Retries", value: "0 of 2", mono: true },
              { label: "Retryable", value: failing ? "no — authentication" : "yes" },
              { label: "Rebuild transport", value: "after 3 transport failures" },
              { label: "Sealed view", value: "publicHeaders", mono: true }
            ]} />
          </Section>
        </>
      }
    />
  )
}

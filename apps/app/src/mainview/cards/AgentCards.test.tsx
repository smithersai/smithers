import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, describe, expect, test } from "bun:test"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import type { Card } from "../state/AppState"
import { agentCardFamily, AgentModelsCardBody, AgentsCardBody } from "./AgentCards"

/*
 * Agents as data (custom-agents.md): the Agents card's rows and acts, and
 * the models card. Every act is asserted as the flow it names. The New-agent
 * form is the generic flow form (FlowFormCards.test.tsx; CustomAgents.test.ts
 * renders it from the live harness seam).
 */

GlobalRegistrator.register()

afterAll(async () => {
  for (let tick = 0; tick < 3; tick += 1) await new Promise((resolve) => setTimeout(resolve, 0))
  await GlobalRegistrator.unregister()
})

type AgentsCard = Extract<Card, { kind: "agents" }>
type AgentModelsCard = Extract<Card, { kind: "agent-models" }>

const base = { title: "Agents", status: "active" as const, createdAt: 0, ordinal: 0 }

const agentsCard = (payload: AgentsCard["payload"]): AgentsCard => ({ ...base, id: "agents", kind: "agents", payload })

const orchestrator: AgentsCard["payload"]["agents"][number] = {
  id: "orchestrator",
  label: "Orchestrator",
  purpose: "Plans and delegates.",
  harness: "claude",
  harnessName: "Claude Code",
  model: { provider: "anthropic", id: "claude-fable-5", label: "Fable 5" },
  builtin: true,
  available: true,
  reason: "",
  account: "will@example.com"
}
const reviewer: AgentsCard["payload"]["agents"][number] = {
  ...orchestrator,
  id: "reviewer",
  label: "Reviewer",
  purpose: "Reviews diffs.",
  harness: "codex",
  harnessName: "Codex",
  model: { provider: "openai", id: "gpt-5.6-terra", label: "GPT-5.6 Terra" },
  builtin: false,
  account: "OPENAI_API_KEY"
}
const docs: AgentsCard["payload"]["agents"][number] = {
  ...reviewer,
  id: "docs-writer",
  label: "Docs writer",
  harness: "opencode-kimi",
  harnessName: "OpenCode · Kimi",
  model: { provider: "kimi-for-coding", id: "kimi-for-coding/k3", label: "Kimi K3" },
  available: false,
  reason: "OpenCode · Kimi has no credential for Kimi K3",
  account: ""
}

const mount = (node: React.ReactNode): HTMLElement => {
  const host = document.createElement("div")
  document.body.append(host)
  flushSync(() => {
    createRoot(host).render(node)
  })
  return host
}

const recorder = () => {
  const calls: Array<[string, string | undefined]> = []
  return { calls, onRunCommand: (name: string, args?: string) => void calls.push([name, args]) }
}

const click = (host: HTMLElement, selector: string): void => {
  const element = host.querySelector<HTMLElement>(selector)
  if (element === null) throw new Error(`no element for ${selector}`)
  element.click()
}

describe("the Agents card", () => {
  test("lists every agent with its harness, model, and live availability, and each act names its flow", () => {
    const { calls, onRunCommand } = recorder()
    const host = mount(<AgentsCardBody card={agentsCard({ native: true, agents: [orchestrator, reviewer, docs] })} onRunCommand={onRunCommand} />)
    const rows = [...host.querySelectorAll<HTMLElement>("[data-agent]")]
    expect(rows.map((row) => row.dataset.agent)).toEqual(["orchestrator", "reviewer", "docs-writer"])
    expect(rows[0]?.textContent).toContain("Orchestrator")
    expect(rows[0]?.textContent).toContain("Claude Code · claude-fable-5 · ● will@example.com")
    expect(rows[1]?.textContent).toContain("Reviewer (mine)")
    expect(rows[2]?.textContent).toContain("○ OpenCode · Kimi has no credential for Kimi K3")
    // A built-in offers Launch and Edit, never Remove; a custom one offers Remove too; an unavailable one offers no Launch.
    expect(host.querySelector("[data-testid=agents-launch-orchestrator]")).not.toBeNull()
    expect(host.querySelector("[data-testid=agents-remove-orchestrator]")).toBeNull()
    expect(host.querySelector("[data-testid=agents-remove-reviewer]")).not.toBeNull()
    expect(host.querySelector("[data-testid=agents-launch-docs-writer]")).toBeNull()
    expect(host.querySelector("[data-testid=agents-edit-docs-writer]")).not.toBeNull()
    click(host, "[data-testid=agents-launch-orchestrator]")
    click(host, "[data-testid=agents-edit-reviewer]")
    click(host, "[data-testid=agents-remove-reviewer]")
    click(host, "[data-testid=agents-new]")
    expect(calls).toEqual([
      ["agent.role", "orchestrator"],
      ["agent.new", "reviewer"],
      ["agent.remove", "reviewer"],
      ["agent.new", undefined]
    ])
    // Every button is the flow it runs.
    expect(host.querySelector("[data-testid=agents-launch-orchestrator]")?.getAttribute("data-flow")).toBe("agent.role")
    expect(host.querySelector("[data-testid=agents-remove-reviewer]")?.getAttribute("data-flow")).toBe("agent.remove")
  })

  test("on the web host it lists nothing local and says where agents run", () => {
    const host = mount(<AgentsCardBody card={agentsCard({ native: false, agents: [] })} onRunCommand={() => {}} />)
    expect(host.textContent).toBe("Agents run on the native app's harnesses.")
    expect(host.querySelector("[data-flow]")).toBeNull()
  })

  test("the last act's refusal stays on the card", () => {
    const host = mount(<AgentsCardBody card={agentsCard({ native: true, agents: [orchestrator], error: "The server answered 500" })} onRunCommand={() => {}} />)
    expect(host.querySelector("[role=alert]")?.textContent).toBe("The server answered 500")
  })
})

describe("the models card", () => {
  test("lists what the harness printed, or the reason it printed nothing", () => {
    const card: AgentModelsCard = {
      ...base,
      id: "agent-models-opencode",
      kind: "agent-models",
      title: "Models · OpenCode",
      payload: { harnessId: "opencode", displayName: "OpenCode", models: ["kimi-for-coding/k3", "cerebras/gpt-oss-120b"], source: "list" }
    }
    const host = mount(<AgentModelsCardBody card={card} />)
    expect([...host.querySelectorAll("li")].map((row) => row.textContent)).toEqual(["kimi-for-coding/k3", "cerebras/gpt-oss-120b"])
    const empty = mount(<AgentModelsCardBody card={{ ...card, payload: { ...card.payload, models: [], reason: "opencode models exited 2: no credential" } }} />)
    expect(empty.textContent).toBe("opencode models exited 2: no credential")
  })
})

/*
 * The agent card's cloud variant (UI-COVERAGE-GAPS.md "agents · Cloud agent
 * sessions"): the session's header, its SSE-fed transcript rows, and the Stop
 * door while the session is active. Rendered through the family's entry, so
 * the variant dispatch is what the test covers.
 */
describe("the agent card's cloud variant", () => {
  type AgentCard = Extract<Card, { kind: "agent" }>
  type CloudPayload = Extract<AgentCard["payload"], { readonly cloud: true }>
  const cloudCard = (payload: CloudPayload): AgentCard => ({
    ...base,
    id: "agent-session-sess-1",
    kind: "agent",
    title: "Fix the retry loop · will/smithers",
    payload
  })
  const render = (card: AgentCard, onRunCommand: (name: string, args?: string) => void = () => {}): HTMLElement =>
    mount(<>{agentCardFamily.agent.render(card, { onRunCommand } as never)}</>)
  const transcript: CloudPayload["transcript"] = [
    { id: 41, role: "user", sequence: 1, createdAt: "2026-09-14T09:00:01Z", parts: [{ type: "text", text: "Fix the retry loop" }] },
    {
      id: 42,
      role: "assistant",
      sequence: 2,
      createdAt: "2026-09-14T09:00:20Z",
      parts: [
        { type: "tool_call", text: `{"name":"Read","arguments":{"path":"src/index.ts"}}` },
        { type: "text", text: "The loop never decrements." }
      ]
    }
  ]

  test("the header carries session · repository · provider · state, and the transcript its rows", () => {
    const { calls, onRunCommand } = recorder()
    const host = render(cloudCard({
      cloud: true,
      displayName: "Fix the retry loop",
      sessionId: "sess-1",
      repo: "will/smithers",
      provider: "codex",
      workspaceId: "ws-1",
      state: "active",
      task: "Fix the retry loop",
      transcript
    }), onRunCommand)
    expect(host.querySelector("[data-testid=agent-session-header]")?.textContent)
      .toBe("session sess-1 · will/smithers · codex · active")
    const rows = [...host.querySelectorAll<HTMLElement>("[data-testid=agent-session-transcript] > li")]
    expect(rows).toHaveLength(2)
    expect(rows[0]?.dataset.role).toBe("user")
    expect(rows[0]?.textContent).toContain("Fix the retry loop")
    expect(rows[1]?.textContent).toContain("tool_call:")
    expect(rows[1]?.textContent).toContain("The loop never decrements.")
    /* Stop while active, bound to the flow with the session id. */
    const stop = host.querySelector("[data-testid=agent-session-stop-sess-1]")
    expect(stop?.getAttribute("data-flow")).toBe("agent.session.stop")
    click(host, "[data-testid=agent-session-stop-sess-1]")
    expect(calls).toEqual([["agent.session.stop", "sess-1"]])
  })

  test("a terminal session offers no Stop, and an unknown provider renders nothing in its place", () => {
    const host = render(cloudCard({
      cloud: true,
      displayName: "Fix the retry loop",
      sessionId: "sess-1",
      repo: "will/smithers",
      provider: null,
      workspaceId: null,
      state: "completed",
      transcript: []
    }))
    expect(host.querySelector("[data-testid=agent-session-header]")?.textContent).toBe("session sess-1 · will/smithers · completed")
    expect(host.querySelector("[data-flow]")).toBeNull()
    expect(host.querySelector("[data-testid=agent-session-transcript]")).toBeNull()
  })

  test("the last act's refusal stays on the card, and the pill is the session's state in the card words", () => {
    const host = render(cloudCard({
      cloud: true,
      displayName: "Fix the retry loop",
      sessionId: "sess-1",
      repo: "will/smithers",
      provider: "claude",
      workspaceId: null,
      state: "active",
      transcript: [],
      error: "agent session already has an active run"
    }))
    expect(host.querySelector("[role=alert]")?.textContent).toBe("agent session already has an active run")
    const pill = (state: string): string => agentCardFamily.agent.pill(cloudCard({
      cloud: true, displayName: "", sessionId: "sess-1", repo: "will/smithers", provider: null, workspaceId: null, state, transcript: []
    }))
    expect(pill("active")).toBe("running")
    expect(pill("completed")).toBe("done")
    expect(pill("failed")).toBe("failed")
    expect(pill("cancelled")).toBe("stopped")
  })
})

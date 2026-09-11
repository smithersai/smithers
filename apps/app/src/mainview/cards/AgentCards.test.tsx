import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, describe, expect, test } from "bun:test"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import type { Card } from "../state/AppState"
import { AgentModelsCardBody, AgentsCardBody } from "./AgentCards"

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

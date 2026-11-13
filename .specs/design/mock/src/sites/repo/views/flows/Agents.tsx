import { useCallback, useEffect } from "react"
import { useMock } from "../../../core/mock"
import { Link, navigate } from "../../../core/router"
import { repo, settings, to } from "../../fixtures"
import type { Agent } from "../../fixtures/types"
import { Empty, Failed, Loading, registerSlash, useView } from "../../frame"
import { ViewFrame as RepoFrame } from "../checklist/ViewFrame"
import { Box, Icon, Markdown, PageHeader, toast } from "../../ui"
import options from "./model-options.json"
import { allAgents, saveAgentModel, useAgents } from "./agent-models"

const AgentCard = ({ agent, model, onModel }: { agent: Agent; model: string; onModel: (model: string) => void }) => {
  const { flags } = useMock()
  const agents = useAgents()
  const canEdit = flags.as === "in" && flags.role === "member"
  const provider = agent.connection === "codex" ? "Codex" : "Claude"
  const models = [...new Set([model, ...options[agent.harness], ...agents.filter(item => item.harness === agent.harness).map(item => item.model)])]
  return (
    <Box className="repo-flows-agent-card" header={(
      <div className="repo-flows-agent-heading"><Icon name="agent" size={19} /><h2>{agent.name}</h2></div>
    )}>
      <div className="repo-flows-agent-content">
        <dl className="repo-flows-agent-facts">
          <div><dt>Agent</dt><dd>{agent.harness === "codex" ? "Codex" : "Claude Code"}</dd></div>
          <div>
            <dt><label htmlFor={`repo-agent-${agent.id}`}>Model</label></dt>
            <dd>
              {canEdit ? <select
                className="repo-ui-input"
                id={`repo-agent-${agent.id}`}
                title={`/agent.model ${agent.id} ${model}${canEdit ? "" : " · Only members can edit agent models."}`}
                disabled={!canEdit}
                value={model}
                onChange={event => onModel(event.target.value)}
              >
                {models.map(name => <option key={name} value={name}>{name}</option>)}
              </select> : <span id={`repo-agent-${agent.id}`}>{model}</span>}
            </dd>
          </div>
          <div><dt>Paid by</dt><dd><Link to={to("settings/models")}>{provider} subscription</Link></dd></div>
          <div>
            <dt>Flows</dt>
            <dd className="repo-flows-agent-links">
              {agent.flows.map(name => <Link key={name} to={to(`flows/${name}`)}>{name}</Link>)}
            </dd>
          </div>
        </dl>
        <details className="repo-flows-instructions">
          <summary title={`/agents.instructions ${agent.id}`}>Instructions</summary>
          <Markdown source={agent.instructions} dense />
        </details>
      </div>
    </Box>
  )
}

export const AgentsReady = () => {
  const { flags } = useMock()
  const agents = useAgents()
  const disconnected = [...new Set(agents.map(agent => agent.connection))].filter(provider =>
    (flags.model === "none" && provider === "codex") || !settings.models.some(item => item.provider === provider && item.state === "connected"))
  const changeModel = useCallback((id: string, model: string) => {
    if (flags.as !== "in" || flags.role !== "member") return
    const agents = allAgents()
    const agent = agents.find(agent => agent.id === id)
    if (!agent) throw new Error("Agent not found.")
    if (![agent.model, ...options[agent.harness], ...agents.filter(item => item.harness === agent.harness).map(item => item.model)].includes(model)) {
      throw new Error(`Choose a ${agent.harness === "codex" ? "Codex" : "Claude"} model for ${agent.name}.`)
    }
    saveAgentModel(id, model)
    toast(`${agent.name} now uses ${model}.`)
  }, [flags.as, flags.role])
  useEffect(() => registerSlash("agent.model", {
    purpose: "Change an agent model",
    fields: [
      { name: "agent", label: "Agent", options: agents.map(agent => agent.id) },
      { name: "model", label: "Model", options: [...new Set([...Object.values(options).flat(), ...agents.map(agent => agent.model)])] }
    ],
    confirm: false,
    run: ({ agent, model }) => changeModel(agent, model)
  }), [changeModel])
  useEffect(() => registerSlash("model.connect", {
    purpose: "Connect a model subscription",
    fields: [{ name: "provider", label: "Provider", options: ["claude", "codex"], required: false }],
    confirm: false,
    run: ({ provider }, context) => { navigate(to(`settings/models${provider ? `?connect=${provider}` : ""}`)); context.closeAsk() }
  }), [])
  useEffect(() => registerSlash("agents.instructions", {
    purpose: "Read agent instructions",
    fields: [{ name: "agent", label: "Agent", options: agents.map(agent => agent.id) }],
    access: "public",
    confirm: false,
    run: ({ agent }, context) => {
      const card = document.getElementById(`repo-agent-${agent}`)?.closest(".repo-flows-agent-card")
      const details = card?.querySelector("details")
      if (details) details.open = !details.open
      context.closeAsk()
    }
  }), [])
  return (
    <>
      <PageHeader title="Agents" actions={<Link className="repo-ui-btn" to={to("flows")}>Flows</Link>} />
      {(flags.as === "out" || flags.role !== "member") && (
        <p className="repo-flows-permission">Only members can edit agent models.</p>
      )}
      {flags.as === "in" && flags.role === "member" && disconnected.map((provider, i) => <div className="repo-flows-agent-warning" role="status" key={provider}>
        <Icon name="issue" /><span>{provider === "codex" ? "Codex" : "Claude"} isn't connected.</span>
        <Link className={"repo-ui-btn" + (i === 0 ? " repo-ui-btn-primary" : "")} title={`/model.connect ${provider}`} to={to(`settings/models?connect=${provider}`)}>Connect {provider === "codex" ? "Codex" : "Claude"}</Link>
      </div>)}
      <div className="repo-flows-agents">
        {agents.map(agent => <AgentCard key={agent.id} agent={agent} model={agent.model} onModel={model => changeModel(agent.id, model)} />)}
      </div>
    </>
  )
}
export const AgentsLoading = () => <Loading rows={4} />
export const AgentsError = () => <Failed what="agents" reason="The model service didn't respond. Agent configuration hasn't loaded." />
export const AgentsEmpty = () => <Empty title="No agents yet." action={<Link to={to("flows")}>View flows</Link>} />
export const Agents = () => {
  const state = useView(`agents:${repo.slug}`)
  return (
    <RepoFrame tab="flows" title={`${repo.slug} · Agents`} askView="flows" askContext={`Agents in ${repo.slug}`}>
      {state === "loading" ? <AgentsLoading /> : state === "error" ? <AgentsError />
        : state === "empty" ? <AgentsEmpty /> : <AgentsReady key={repo.slug} />}
    </RepoFrame>
  )
}

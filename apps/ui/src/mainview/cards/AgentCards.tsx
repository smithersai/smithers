import { Button, Markdown } from "@smthrs/ui"
import type { Card } from "../state/AppState"
import { findAgentRole } from "@smthrs/rpc/AgentRoles"
import type { CardFamily, RunCommand } from "./CardFamily"
import { settledPill } from "./CardFamily"

/*
 * The agents as data (docs/workbench-lanes/custom-agents.md), as cards in
 * the chat (THE EMBED LAW): the Agents card lists every built-in and custom
 * agent with its harness's live availability and the acts each row offers
 * (Launch = agent.role, Edit = agent.new <id>, Remove = agent.remove); the
 * models card is what a harness's own list command printed. The New-agent
 * form is the generic flow form (THE FORM LAW, cards/FlowFormCards.tsx)
 * derived from agent.create's schema, which agent.new renders. Every act
 * names its flow through onRunCommand.
 */

type AgentsCard = Extract<Card, { kind: "agents" }>
type AgentModelsCard = Extract<Card, { kind: "agent-models" }>

export const AgentsCardBody = ({
  card,
  onRunCommand
}: {
  readonly card: AgentsCard
  readonly onRunCommand: RunCommand
}) => {
  const { native, agents, error } = card.payload
  if (!native) return <p className="smithers-card-note">Agents run on the native app's harnesses.</p>
  return (
    <div className="agents-card">
      <ul className="workflow-list" data-testid="agents-list">
        {agents.map((agent) => (
          <li key={agent.id} className="workflow-list-row agent-row" data-agent={agent.id} data-available={agent.available}>
            <span className="workflow-list-text">
              <strong>{agent.builtin ? agent.label : `${agent.label} (mine)`}</strong>
              <span title={agent.purpose}>
                {agent.harnessName} · {agent.model.id} · {agent.available ? `● ${agent.account === "" ? "signed in" : agent.account}` : `○ ${agent.reason}`}
              </span>
            </span>
            <span className="flow-run-actions">
              {agent.available ?
                (
                  <Button
                    size="sm"
                    variant="outline"
                    data-flow="agent.role"
                    data-testid={`agents-launch-${agent.id}`}
                    title={agent.purpose}
                    onClick={() => onRunCommand("agent.role", agent.id)}
                  >
                    Launch
                  </Button>
                ) :
                null}
              <Button
                size="sm"
                variant="outline"
                data-flow="agent.new"
                data-testid={`agents-edit-${agent.id}`}
                onClick={() => onRunCommand("agent.new", agent.id)}
              >
                Edit
              </Button>
              {agent.builtin ? null : (
                <Button
                  size="sm"
                  variant="outline"
                  data-flow="agent.remove"
                  data-testid={`agents-remove-${agent.id}`}
                  onClick={() => onRunCommand("agent.remove", agent.id)}
                >
                  Remove
                </Button>
              )}
            </span>
          </li>
        ))}
      </ul>
      <div className="flow-run-actions">
        <Button size="sm" data-flow="agent.new" data-testid="agents-new" onClick={() => onRunCommand("agent.new")}>
          New agent
        </Button>
      </div>
      {error !== undefined ?
        (
          <p className="sui-approval-error" role="alert">
            {error}
          </p>
        ) :
        null}
    </div>
  )
}

export const AgentModelsCardBody = ({ card }: { readonly card: AgentModelsCard }) => {
  const { displayName, models, reason } = card.payload
  return (
    <div className="agent-models">
      {models.length === 0 ?
        <p className="smithers-card-note">{reason ?? `${displayName} listed no models.`}</p> :
        (
          <ul className="workflow-list" data-testid="agent-models-list">
            {models.map((model) => (
              <li key={model} className="workflow-list-row">
                <span className="workflow-list-text">
                  <strong>{model}</strong>
                </span>
              </li>
            ))}
          </ul>
        )}
      {models.length > 0 && reason !== undefined ? <p className="smithers-card-note">{reason}</p> : null}
    </div>
  )
}

/*
 * A subagent launched from the `+` menu (docs/LOCAL-APP.md "Tabs"): which
 * harness, where it runs, whether it is still running, and the way back to
 * its tab — a registered flow (tab.select), so the card never owns the tab.
 */
const AgentCardBody = ({
  card,
  onRunCommand
}: {
  readonly card: Extract<Card, { kind: "agent" }>
  readonly onRunCommand: RunCommand
}) => {
  const { displayName, cwd, phase, exitCode, tabId, roleId, task } = card.payload
  // The purpose rode the card at launch (a custom agent's is in no table); older cards fall back to the built-in row.
  const purpose = card.payload.purpose ?? (roleId === undefined ? undefined : findAgentRole(roleId)?.purpose)
  const state = phase === "running"
    ? `${displayName} is running in ${cwd}.`
    : exitCode === null
    ? `${displayName} stopped.`
    : `${displayName} exited (${exitCode}).`
  return (
    <div className="agent-card" data-phase={phase} data-role={roleId}>
      {purpose !== undefined ? <p className="smithers-card-note agent-card-role">{purpose}</p> : null}
      {task !== undefined ? <p className="smithers-card-note agent-card-task">Task: {task}</p> : null}
      <p className="smithers-card-note">{state}</p>
      {phase === "running" ?
        (
          <div className="flow-run-actions">
            <Button
              size="sm"
              variant="outline"
              data-flow="tab.select"
              data-testid={`agent-open-tab-${tabId}`}
              onClick={() => onRunCommand("tab.select", tabId)}
            >
              Open tab
            </Button>
          </div>
        ) :
        null}
    </div>
  )
}

/* The explainer's answer (AgentRoles.ts): streams in place; says who was asked, never who answered. */
const ExplainCardBody = ({ card }: { readonly card: Extract<Card, { kind: "explain" }> }) => {
  const { question, answer, phase, answeredBy, error } = card.payload
  return (
    <div className="explain-card" data-phase={phase}>
      <p className="smithers-card-note explain-card-question">{question}</p>
      {answer !== "" ? <Markdown className="smithers-card-markdown" content={answer} /> : null}
      {phase === "asking" ? <p className="sui-approval-pending">Explaining…</p> : null}
      {phase === "failed" && error !== undefined ?
        (
          <p className="sui-approval-error" role="alert">
            {error}
          </p>
        ) :
        null}
      <p className="smithers-card-note explain-card-by">{answeredBy}</p>
    </div>
  )
}


export const agentCardFamily: CardFamily<"agent" | "explain" | "agents" | "agent-models"> = {
  agent: {
    render: (card, actions) => <AgentCardBody card={card} onRunCommand={actions.onRunCommand} />,
    /*
     * A subagent's pill is its process: running, done on a clean exit, failed
     * otherwise. A null exit code is the unknown outcome (Cards.ts: "null when
     * unknown (the tab was closed)"), so it wears the neutral "stopped" the
     * body already reads out — never a green Done nobody can vouch for.
     */
    pill: (card) => {
      if (card.payload.phase === "running") return "running"
      if (card.payload.exitCode === null) return "stopped"
      return card.payload.exitCode === 0 ? "done" : "failed"
    }
  },
  explain: {
    render: (card) => <ExplainCardBody card={card} />,
    pill: (card) => {
      if (card.payload.phase === "asking") return "running"
      return card.payload.phase === "answered" ? "done" : "failed"
    }
  },
  /* Agents as data: the listings settle when they render. */
  agents: {
    render: (card, actions) => <AgentsCardBody card={card} onRunCommand={actions.onRunCommand} />,
    pill: settledPill
  },
  "agent-models": {
    render: (card) => <AgentModelsCardBody card={card} />,
    pill: settledPill
  }
}

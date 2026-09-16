/*
 * The `agent` flows. One module per namespace: a lane that adds or edits a
 * flow here touches no other flow module, and Flows.ts registers each block in
 * the aggregator order.
 */
import { Schema } from "effect"
import { isAgentRoleId } from "@smthrs/rpc/AgentRoles"
import { flag, line, text } from "../FlowForms"
import { flow, NoPayload } from "./Declare"
import type { FlowEntry, Namespace } from "../registry"
import type { CommandActions } from "./Declare"

/** The `agent` namespace row: the slash tree lists it in registry.ts NAMESPACES order. */
export const namespace: Namespace = { id: "agent", label: "Agents", summary: "Delegate a task to an agent role" }

/** The `agent.*` flows: roles, delegation, the explainer, the list. */
export const agentFlows = (actions: CommandActions): ReadonlyArray<FlowEntry> => {
  /*
   * The explainer inside the app (AgentRoles.ts): one side turn on the
   * explainer role, answered as an embedded card. Callable by the model and
   * by a human through `/agent.explain`.
   */
  const EXPLAIN = {
    name: "agent.explain",
    summary: "Ask the Explainer to explain something",
    runtime: ["agent"] as const,
    args: "<what>",
    input: Schema.Struct({ what: Schema.String }),
    handler: ({ what }: { readonly what: string }) => actions.explain(what)
  }
  return [
  flow({
    /*
     * A named role (AgentRoles.ts) from the `+` menus: the role's harness and
     * model launch in a tab, and the conversation gets the subagent card.
     * The same launch as tab.harness, so the same confirm.
     */
    name: "agent.role",
    form: { fields: { roleId: { optionsFrom: "agents" } } },
    summary: "Launch a named agent (built-in) as a session",
    runtime: ["local.harnesses"],
    confirm: "launch an agent role as a session",
    args: "<roleId>",
    input: Schema.Struct({ roleId: Schema.String }),
    // A well-formed id resolves against the agents store in the controller; the store's list names the rest.
    handler: ({ roleId }) =>
      isAgentRoleId(roleId)
        ? actions.openHarnessTab("", { roleId })
        : `${roleId} is not an agent id (lowercase letters, digits and dashes). agent.list shows the agents.`
  }),
  flow({
    /*
     * The orchestrator's delegation: a role launches in its own tab with the
     * task as its first prompt, recorded as a subagent card here. The model
     * reads the result back with tab.read.
     */
    name: "agent.delegate",
    confirm: "delegate a task to an agent session",
    form: { fields: { roleId: { optionsFrom: "agents" } } },
    summary: "Delegate a task to an agent (built-in; agent.list shows them)",
    runtime: ["local.harnesses"],
    args: "<role> <task>",
    input: Schema.Struct({ roleId: Schema.String, task: Schema.String }),
    handler: ({ roleId, task }) =>
      isAgentRoleId(roleId)
        ? actions.openHarnessTab("", { roleId, task })
        : `${roleId} is not an agent id (lowercase letters, digits and dashes). agent.list shows the agents.`
  }),
  flow(EXPLAIN),
  flow({
    name: "agent.list",
    summary: "Show the agents: built-in, with what each can launch here",
    input: NoPayload,
    handler: () => actions.listAgents()
  }),
  ]
}

/** Root composes this alongside agentFlows after binding the controller. */
export const tutorialChangeFlows = (actions: import("../../state/controller/tutorialChange").TutorialChangeController): ReadonlyArray<FlowEntry> => [
  flow({ name: "agent.change", summary: "Inspect the repository and suggest a planned change", args: "[repo] [feature]",
    input: Schema.Struct({ repo: Schema.optional(Schema.String), feature: Schema.optional(Schema.String) }),
    form: { fields: { repo: { optionsFrom: "cloud-repos" } }, args: payload => line(text(payload, "repo"), flag(payload, "feature")) },
    confirm: "inspect the repository with an agent and prepare a change plan",
    handler: ({ repo, feature }) => actions.suggestTutorialChange(repo, feature) }),
  flow({
    name: "agent.change.start",
    summary: "Start the reviewed change plan", args: "<cardId>",
    input: Schema.Struct({ cardId: Schema.String }), confirm: "execute the reviewed plan and create its commits",
    handler: ({ cardId }) => actions.startTutorialChange(cardId) })
]

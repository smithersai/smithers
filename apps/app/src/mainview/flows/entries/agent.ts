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
    summary: "Launch a named agent (built-in or custom) as a session",
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
    summary: "Delegate a task to an agent (built-in or custom; agent.list shows them)",
    runtime: ["local.harnesses"],
    args: "<role> <task>",
    input: Schema.Struct({ roleId: Schema.String, task: Schema.String }),
    handler: ({ roleId, task }) =>
      isAgentRoleId(roleId)
        ? actions.openHarnessTab("", { roleId, task })
        : `${roleId} is not an agent id (lowercase letters, digits and dashes). agent.list shows the agents.`
  }),
  flow(EXPLAIN),
  /*
   * Agents as data (docs/workbench-lanes/custom-agents.md): the agents are
   * rows the user manages from the chat. Listing and the form render cards;
   * creating, editing, and removing an agent define what may spend money on
   * the human's harnesses, so the agent asks and the human confirms. The
   * web host has no local harnesses: agent.list says so on its card, and
   * the rest are absent there (runtime).
   */
  flow({
    name: "agent.list",
    summary: "Show the agents: built-in and custom, with what each can launch here",
    input: NoPayload,
    handler: () => actions.listAgents()
  }),
  flow({
    name: "agent.new",
    summary: "Open the New agent form (an existing id opens it for editing)",
    runtime: ["local.harnesses"],
    args: "[id] [harness] [model] [purpose]",
    input: Schema.Struct({
      id: Schema.optional(Schema.String),
      harness: Schema.optional(Schema.String),
      model: Schema.optional(Schema.String),
      purpose: Schema.optional(Schema.String)
    }),
    handler: (prefill) => actions.newAgent(prefill)
  })
  ]
}

/** The agent editor flows, registered after `form.*`. */
export const agentEditFlows = (actions: CommandActions): ReadonlyArray<FlowEntry> => [
  flow({
    name: "agent.create",
    form: { fields: { harness: { optionsFrom: "agent-harnesses" }, model: { optionsFrom: "harness-models", kind: "text" } } },
    summary: "Create an agent: an id, the harness that runs it, the model id that harness accepts, and its purpose",
    runtime: ["local.harnesses"],
    confirm: ({ id, harness, model }) => `create the agent ${String(id)} on ${String(harness)} with ${String(model)}`,
    args: "<id> <harness> <model> [purpose]",
    input: Schema.Struct({ id: Schema.String, harness: Schema.String, model: Schema.String, purpose: Schema.optional(Schema.String) }),
    handler: (input) => actions.createAgent(input)
  }),
  flow({
    name: "agent.edit",
    form: {
      fields: { id: { optionsFrom: "agents" }, model: { optionsFrom: "harness-models", kind: "text" } },
      args: (payload) => line(text(payload, "id"), flag(payload, "model"), flag(payload, "purpose"), flag(payload, "label"))
    },
    summary: "Change an agent's model, purpose, or name (a built-in keeps its harness)",
    runtime: ["local.harnesses"],
    confirm: ({ id }) => `edit the agent ${String(id)}`,
    args: "<id> [--model <id>] [--purpose <text>] [--label <name>]",
    input: Schema.Struct({
      id: Schema.String,
      model: Schema.optional(Schema.String),
      purpose: Schema.optional(Schema.String),
      label: Schema.optional(Schema.String)
    }),
    handler: ({ id, ...patch }) => actions.editAgent(id, patch)
  }),
  flow({
    name: "agent.remove",
    form: { fields: { id: { optionsFrom: "agents" } } },
    summary: "Remove a custom agent (a built-in cannot be removed)",
    runtime: ["local.harnesses"],
    confirm: ({ id }) => `remove the agent ${String(id)}`,
    args: "<id>",
    input: Schema.Struct({ id: Schema.String }),
    handler: ({ id }) => actions.removeAgent(id)
  }),
  flow({
    name: "agent.models",
    form: { fields: { harness: { optionsFrom: "agent-harnesses" } } },
    summary: "List the models a harness can run, as the harness reports them",
    runtime: ["local.harnesses"],
    args: "<harness>",
    input: Schema.Struct({ harness: Schema.String }),
    handler: ({ harness }) => actions.listHarnessModels(harness)
  })
]

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
    input: Schema.Struct({ cardId: Schema.String }), confirm: "execute the planned change and create one commit",
    handler: ({ cardId }) => actions.startTutorialChange(cardId) })
]

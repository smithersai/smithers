import {
  AGENT_ROLE_ID,
  AgentsResponseSchema,
  findAgentRole,
  isAgentRoleId,
  MODEL_ID,
  orderedAgentRoles
} from "@smthrs/rpc/AgentRoles"
import type { AgentPutRequest, AgentRole } from "@smthrs/rpc/AgentRoles"
import { hasCapability } from "@smthrs/rpc/AppBootstrap"
import { HARNESS_IDS } from "@smthrs/rpc/LocalApp"
import type { Harness } from "@smthrs/rpc/LocalApp"
import { roleMenuEntries } from "../../AgentRoleMenu"
import type { Card } from "../AppState"
import type { AppStore } from "../AppStore"
import type { ControllerContext } from "./context"
import { fetchHarnessModels, formRenderedText } from "./forms"
import type { FormsController } from "./forms"

/*
 * Agents as data (docs/workbench-lanes/custom-agents.md): the renderer's
 * half. `app-agents` mirrors `GET /api/agents` (loaded at boot beside the
 * harness list, re-read after every mutation); every act is a flow with
 * three doors (agent.list, agent.new, agent.create, agent.edit,
 * agent.remove, agent.models), and the management UI is cards in the chat —
 * THE EMBED LAW — whose state lives in their payloads. The New-agent form is
 * the generic flow form (THE FORM LAW, controller/forms.ts) derived from
 * agent.create's own schema; agent.new renders it. Availability is the
 * harness signal through roleMenuEntries, never guessed.
 */

export const AGENTS_CARD_ID = "agents"

type AgentsCard = Extract<Card, { kind: "agents" }>

export type HarnessId = Harness["id"]

export interface AgentsController {
  /** `GET /api/agents` → app-agents. Silent where no server answers (the web, a test). */
  readonly loadAgents: () => Promise<void>
  /** The agents as the menus list them: the mirror, or the built-ins until it loads. */
  readonly agentRoles: () => ReadonlyArray<AgentRole>
  /** `agent.list`: the Agents card, at the transcript's tail. */
  readonly listAgents: () => Promise<string | void>
  /** `agent.new [id] [harness] [model] [purpose]`: agent.create's form, prefilled; an existing id renders agent.edit's instead. */
  readonly newAgent: (prefill: { readonly id?: string; readonly harness?: string; readonly model?: string; readonly purpose?: string }) => Promise<string | void | { readonly value: string }>
  /** `agent.create <id> <harness> <model> [purpose]`. */
  readonly createAgent: (input: { readonly id: string; readonly harness: string; readonly model: string; readonly purpose?: string }) => Promise<string | void | { readonly value: string }>
  /** `agent.edit <id> [--model m] [--purpose p] [--label l]`. */
  readonly editAgent: (id: string, patch: { readonly model?: string; readonly purpose?: string; readonly label?: string }) => Promise<string | void | { readonly value: string }>
  /** `agent.remove <id>`: a built-in is refused with the reason. */
  readonly removeAgent: (id: string) => Promise<string | void | { readonly value: string }>
  /** `agent.models <harness>`: the harness's own model list as a card. */
  readonly listHarnessModels: (harness: string) => Promise<string | void>
}

export interface AgentsControllerDependencies {
  readonly nextOrdinal: () => number
  readonly loadHarnesses: () => Promise<void>
  /** The generic flow form (THE FORM LAW): agent.new renders agent.create's or agent.edit's through it. */
  readonly renderFlowForm: FormsController["renderFlowForm"]
}

/** The agents in menu order from the store's mirror; the built-ins while it is empty. */
export const currentAgentRoles = (store: Pick<AppStore, "collections">): ReadonlyArray<AgentRole> =>
  orderedAgentRoles([...store.collections.agents.values()])

/** `GET /api/agents` into app-agents; usable before the controller exists (tabs.ts resolves a role on demand). */
export const loadAgents = async (ctx: Pick<ControllerContext, "store" | "baseUrl" | "boundedFetch">): Promise<void> => {
  try {
    const response = await ctx.boundedFetch(`${ctx.baseUrl}/api/agents`)
    if (!response.ok) return
    const parsed = AgentsResponseSchema.safeParse(await response.json())
    if (!parsed.success) return
    ctx.store.dispatch({ type: "agents.loaded", actor: "system", agents: parsed.data.agents })
  } catch {
    // No server behind /api/agents (pure web, a test): the built-ins stand in.
  }
}

const isHarnessId = (value: string): value is HarnessId => (HARNESS_IDS as ReadonlyArray<string>).includes(value)

/** "docs-writer" → "Docs writer": the label a slash-created agent gets when the form named none. */
const labelFromId = (id: string): string => {
  const words = id.split("-").filter((word) => word !== "")
  const text = words.join(" ")
  return text.charAt(0).toUpperCase() + text.slice(1)
}

/*
 * The provider a model belongs to, for the row's label: the table's facts
 * (Claude Code is Anthropic's, Codex is OpenAI's), the prefix of a
 * provider-qualified id (`cerebras/gpt-oss-120b`), else the harness id.
 */
const providerOf = (harness: HarnessId, model: string): string => {
  if (model.includes("/")) return model.slice(0, model.indexOf("/"))
  if (harness === "claude") return "anthropic"
  if (harness === "codex") return "openai"
  return harness
}

export const createAgentsController = (ctx: ControllerContext, deps: AgentsControllerDependencies): AgentsController => {
  const { store, baseUrl } = ctx
  const { collections } = store

  const native = (): boolean => {
    const bootstrap = ctx.services.bootstrap
    return bootstrap !== undefined && hasCapability(bootstrap, "local.harnesses")
  }

  const agentRoles: AgentsController["agentRoles"] = () => currentAgentRoles(store)

  const load: AgentsController["loadAgents"] = () => loadAgents(ctx)

  const refresh = (): Promise<void> => Promise.all([deps.loadHarnesses(), load()]).then(() => undefined)

  const harnesses = (): ReadonlyArray<Harness> => [...collections.harnesses.values()]

  const agentsCard = (): AgentsCard | undefined => {
    const card = collections.cards.get(AGENTS_CARD_ID)
    return card?.kind === "agents" ? card : undefined
  }

  const agentsPayload = (): AgentsCard["payload"] => {
    if (!native()) return { native: false, agents: [] }
    const rows = harnesses()
    return {
      native: true,
      agents: roleMenuEntries(rows, agentRoles()).map((entry) => ({
        id: entry.role.id,
        label: entry.role.label,
        purpose: entry.role.purpose,
        harness: entry.role.harness,
        harnessName: rows.find((harness) => harness.id === entry.role.harness)?.displayName ?? entry.role.harness,
        model: entry.role.model,
        builtin: entry.role.builtin,
        available: entry.available,
        reason: entry.reason,
        account: entry.account
      }))
    }
  }

  /** The Agents card: at the tail when the human (or the model) asked for it, in place when a mutation refreshes it. */
  const renderAgentsCard = (toTail: boolean, error?: string): void => {
    const existing = agentsCard()
    if (!toTail && existing === undefined) return
    store.dispatch({
      type: "card.upsert",
      actor: ctx.commandActor,
      card: {
        id: AGENTS_CARD_ID,
        kind: "agents",
        title: "Agents",
        status: "active",
        createdAt: existing?.createdAt ?? Date.now(),
        ordinal: toTail || existing === undefined ? deps.nextOrdinal() : existing.ordinal,
        payload: { ...agentsPayload(), ...(error === undefined ? {} : { error }) }
      }
    })
  }

  const listAgents: AgentsController["listAgents"] = async () => {
    if (native()) await refresh()
    renderAgentsCard(true)
  }

  const fetchModels = (harness: HarnessId) => fetchHarnessModels(ctx, harness)

  /*
   * agent.new: the generic form (THE FORM LAW) for agent.create, prefilled
   * from the line; an existing id renders agent.edit's form with the row's
   * current model and purpose instead. The form runs as whoever asked for
   * it, so the agent's ask still confirms on submit.
   */
  const newAgent: AgentsController["newAgent"] = async (prefill) => {
    if (prefill.harness !== undefined && !isHarnessId(prefill.harness)) {
      return `There is no harness with id ${prefill.harness}. Harnesses: ${HARNESS_IDS.join(", ")}.`
    }
    if (prefill.model !== undefined && !MODEL_ID.test(prefill.model)) return `${prefill.model} is not a model id: no spaces, no leading dash.`
    await refresh()
    const existing = prefill.id === undefined ? undefined : findAgentRole(prefill.id, agentRoles())
    if (prefill.id !== undefined && existing === undefined && !isAgentRoleId(prefill.id)) {
      return `${prefill.id} is not an agent id: lowercase letters, digits and dashes, starting with a letter.`
    }
    const via = ctx.commandActor === "smithers" ? "agent" : "user"
    const rendered = existing === undefined
      ? deps.renderFlowForm({
        name: "agent.create",
        args: [prefill.id, prefill.harness, prefill.model, prefill.purpose].filter((part): part is string => part !== undefined).join(" "),
        via
      })
      : deps.renderFlowForm({
        name: "agent.edit",
        args: [
          existing.id,
          `--model ${prefill.model ?? existing.model.id}`,
          `--purpose ${prefill.purpose ?? existing.purpose}`,
          `--label ${existing.label}`
        ].join(" "),
        via
      })
    if (rendered === undefined) return "The agent form could not be rendered here."
    return { value: formRenderedText(rendered.missing) }
  }

  const putAgent = async (id: string, body: AgentPutRequest): Promise<string | undefined> => {
    const response = await ctx.boundedFetch(`${baseUrl}/api/agents/${id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    })
    if (!response.ok) return ctx.errorMessageOf(response, `The server answered ${response.status}`)
    return undefined
  }

  /** After a mutation: the mirror re-reads and the Agents card (if shown) refreshes in place; the form settles itself (forms.ts). */
  const settle = async (error: string | undefined): Promise<void> => {
    await load()
    renderAgentsCard(false, error)
  }

  const createAgent: AgentsController["createAgent"] = async (input) => {
    const id = input.id.trim()
    if (!isAgentRoleId(id)) return `${id} is not an agent id: lowercase letters, digits and dashes, starting with a letter (${String(AGENT_ROLE_ID)}).`
    if (!isHarnessId(input.harness)) return `There is no harness with id ${input.harness}. Harnesses: ${HARNESS_IDS.join(", ")}.`
    if (!MODEL_ID.test(input.model)) return `${input.model} is not a model id: no spaces, no leading dash.`
    await load()
    if (findAgentRole(id, agentRoles()) !== undefined) return `An agent named ${id} already exists — agent.edit ${id} changes it.`
    // The label is the id humanized ("docs-writer" → "Docs writer"); agent.edit --label renames it.
    const label = labelFromId(id)
    const purpose = input.purpose?.trim() ?? ""
    const error = await putAgent(id, {
      label,
      purpose,
      harness: input.harness,
      model: { provider: providerOf(input.harness, input.model), id: input.model, label: input.model }
    })
    await settle(error)
    if (error !== undefined) return error
    return { value: `created agent ${id}: ${label} on ${input.harness} with ${input.model}` }
  }

  const editAgent: AgentsController["editAgent"] = async (id, patch) => {
    await load()
    const existing = findAgentRole(id, agentRoles())
    if (existing === undefined) return `There is no agent named ${id}. Agents: ${agentRoles().map((role) => role.id).join(", ")}.`
    if (patch.model !== undefined && !MODEL_ID.test(patch.model)) return `${patch.model} is not a model id: no spaces, no leading dash.`
    if (patch.model === undefined && patch.purpose === undefined && patch.label === undefined) {
      return `agent.edit ${id} needs --model <id>, --purpose <text>, or --label <name>.`
    }
    if (patch.label !== undefined && patch.label.trim() === "") return "agent.edit's --label needs a name."
    const error = await putAgent(id, {
      label: patch.label?.trim() ?? existing.label,
      purpose: patch.purpose ?? existing.purpose,
      harness: existing.harness,
      model: patch.model === undefined ? existing.model : { provider: providerOf(existing.harness, patch.model), id: patch.model, label: patch.model },
      delegates: existing.delegates
    })
    await settle(error)
    if (error !== undefined) return error
    return { value: `edited agent ${id}` }
  }

  const removeAgent: AgentsController["removeAgent"] = async (id) => {
    await load()
    const existing = findAgentRole(id, agentRoles())
    if (existing === undefined) return `There is no agent named ${id}. Agents: ${agentRoles().map((role) => role.id).join(", ")}.`
    if (existing.builtin) {
      return `${existing.label} is a built-in agent and cannot be removed; its model and purpose can be edited (agent.edit ${id}).`
    }
    let error: string | undefined
    try {
      const response = await ctx.boundedFetch(`${baseUrl}/api/agents/${id}`, { method: "DELETE" })
      if (!response.ok) error = await ctx.errorMessageOf(response, `The server answered ${response.status}`)
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause)
    }
    await settle(error)
    if (error !== undefined) return error
    return { value: `removed agent ${id}` }
  }

  const listHarnessModels: AgentsController["listHarnessModels"] = async (harness) => {
    if (!isHarnessId(harness)) return `There is no harness with id ${harness}. Harnesses: ${HARNESS_IDS.join(", ")}.`
    await deps.loadHarnesses()
    const row = collections.harnesses.get(harness)
    const answer = await fetchModels(harness)
    const id = `agent-models-${harness}`
    const existing = collections.cards.get(id)
    store.dispatch({
      type: "card.upsert",
      actor: ctx.commandActor,
      card: {
        id,
        kind: "agent-models",
        title: `Models · ${row?.displayName ?? harness}`,
        status: "active",
        createdAt: existing?.createdAt ?? Date.now(),
        ordinal: deps.nextOrdinal(),
        payload: {
          harnessId: harness,
          displayName: row?.displayName ?? harness,
          models: answer.models,
          source: answer.source,
          ...(answer.reason === undefined ? {} : { reason: answer.reason })
        }
      }
    })
  }

  return { loadAgents: load, agentRoles, listAgents, newAgent, createAgent, editAgent, removeAgent, listHarnessModels }
}

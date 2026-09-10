import { HarnessModelsResponseSchema, orderedAgentRoles } from "@smthrs/rpc/AgentRoles"
import type { HarnessModelsResponse } from "@smthrs/rpc/AgentRoles"
import { HARNESS_IDS } from "@smthrs/rpc/LocalApp"
import type { Harness } from "@smthrs/rpc/LocalApp"
import type { Schema } from "effect"
import { roleMenuEntries } from "../../AgentRoleMenu"
import type { AgentInvocation } from "../../flows/AgentInvocation"
import type { CommandOutcome } from "../../flows/Commands"
import { assembleArgs, draftFrom, formFieldsFor, missingFields, partialPayload, submissionPayload } from "../../flows/FlowForms"
import type { FieldOption, FieldValue, FormDraft, FormField, FormHints, OptionProvider } from "../../flows/FlowForms"
import { payloadFor } from "../../flows/SlashPayload"
import { manifests } from "../../plugins/catalog"
import { actorSharedState } from "../ActorBindings"
import { knownRepositories } from "../RepoContext"
import type { Card } from "../AppState"
import type { ControllerContext } from "./context"

/*
 * THE FORM LAW (apps/ui/AGENTS.md; docs/workbench-lanes/flow-forms.md), the
 * controller half. A flow invoked without its required input renders the
 * `flow-form` card: its fields derive from the flow's input schema
 * (flows/FlowForms.ts), its options come from the seams named below and
 * nowhere else (NO INVENTION), and its draft IS the card payload — every
 * field commit is `form.set`, a card-payload update through the dispatcher,
 * never component state. `form.submit` assembles the one slash line the
 * flow's grammar parses and re-enters the run path AS THE ACTOR THAT ASKED:
 * a form the agent rendered submits as the agent, so a consequential flow
 * still confirms and the human's click stays the act (THE THREE-DOOR LAW).
 */

type FlowFormCard = Extract<Card, { kind: "flow-form" }>
type HarnessId = Harness["id"]

export interface FormRenderRequest {
  readonly name: string
  readonly args: string | undefined
  readonly via: "user" | "agent"
  readonly invocation?: AgentInvocation
  /** The flow's input schema and hints; looked up in the registry when the caller has only the name. */
  readonly input?: Schema.Top
  readonly hints?: FormHints
}

export interface FormRendered {
  readonly cardId: string
  /** The required fields the form still needs; every field when the line was malformed rather than short. */
  readonly missing: ReadonlyArray<string>
}

export interface FormsController {
  /** Render (or re-render) the form card for one flow, prefilled from a slash line. */
  readonly renderFlowForm: (request: FormRenderRequest) => FormRendered | undefined
  /** `form.set <cardId> <field> [value]`: one draft update; blank clears. */
  readonly setFormField: (cardId: string, field: string, value: string) => Promise<string | void>
  /** `form.submit <cardId>`: run the form's flow with the draft, as the actor that asked for it. */
  readonly submitForm: (cardId: string, invocation?: AgentInvocation) => Promise<string | void | { readonly value: string }>
  /** `card.dismiss <cardId>`: drop a form card (the form's Cancel). */
  readonly dismissCard: (cardId: string) => string | void
}

export interface FormsControllerDependencies {
  readonly nextOrdinal: () => number
}

/** The card id one flow's form lives under: a second render of the same flow replaces the first. */
export const formCardId = (flow: string): string => `form-${flow}`

/** The tool text an agent reads when its invocation rendered a form instead of running. */
export const formRenderedText = (missing: ReadonlyArray<string>): string =>
  `rendered a form for ${missing.join(", ")}: ask the user to fill it in`

const isHarnessId = (value: unknown): value is HarnessId =>
  typeof value === "string" && (HARNESS_IDS as ReadonlyArray<string>).includes(value)

/** `GET /api/harnesses/{id}/models`: the harness's own list, or the table's suggestions, with the reason when it printed nothing. */
export const fetchHarnessModels = async (
  ctx: Pick<ControllerContext, "baseUrl" | "boundedFetch" | "errorMessageOf">,
  harness: HarnessId
): Promise<HarnessModelsResponse> => {
  try {
    const response = await ctx.boundedFetch(`${ctx.baseUrl}/api/harnesses/${harness}/models`)
    if (!response.ok) {
      return { harnessId: harness, models: [], source: "suggestions", reason: await ctx.errorMessageOf(response, `The server answered ${response.status}`) }
    }
    const parsed = HarnessModelsResponseSchema.safeParse(await response.json())
    if (!parsed.success) return { harnessId: harness, models: [], source: "suggestions", reason: "The server's model list did not parse." }
    return parsed.data
  } catch (error) {
    return { harnessId: harness, models: [], source: "suggestions", reason: error instanceof Error ? error.message : String(error) }
  }
}

export const createFormsController = (ctx: ControllerContext, deps: FormsControllerDependencies): FormsController => {
  const { store } = ctx
  const { collections } = store
  // Authority comes only from a registry invocation, never from persisted or model-authored payloads.
  const continuations = actorSharedState(ctx, "form-continuations", () =>
    new Map<string, { readonly invocation: AgentInvocation; readonly payload: string }>())
  const continuationFor = (card: FlowFormCard): AgentInvocation | undefined => {
    const saved = continuations.get(card.id)
    if (saved?.payload === JSON.stringify(card.payload)) return saved.invocation
    // card.show/card.update may replace a form under an existing id. Its new
    // payload cannot borrow the replaced form's lineage or pending grant.
    continuations.delete(card.id)
    return undefined
  }

  /** The harness rows in the table's own order (HARNESS_IDS), whatever order the collection iterates. */
  const harnesses = (): ReadonlyArray<Harness> =>
    [...collections.harnesses.values()].sort(
      (left, right) => (HARNESS_IDS as ReadonlyArray<string>).indexOf(left.id) - (HARNESS_IDS as ReadonlyArray<string>).indexOf(right.id)
    )

  const formCard = (cardId: string): FlowFormCard | undefined => {
    const card = collections.cards.get(cardId)
    return card?.kind === "flow-form" ? card : undefined
  }

  /*
   * The harness a model list belongs to: the draft's own harness field, or
   * the harness of the agent the draft names (agent.edit keeps a built-in's
   * harness fixed, so the row is the truth).
   */
  const harnessOf = (draft: FormDraft): HarnessId | undefined => {
    const picked = draft["harness"] ?? draft["harnessId"]
    if (isHarnessId(picked)) return picked
    const agentId = draft["id"] ?? draft["roleId"]
    const role = typeof agentId === "string" ? collections.agents.get(agentId) : undefined
    return role?.harness
  }

  /** An installed harness with its credential state; `hosting` also needs a verified model flag (a custom agent binds a model). */
  const harnessOption = (harness: Harness, hosting: boolean): FieldOption => {
    const account = harness.account?.email ?? harness.account?.label ?? ""
    const label = account === "" ? harness.displayName : `${harness.displayName} · ${account}`
    if (harness.status === "unavailable") return { value: harness.id, label: harness.displayName, disabled: true, reason: "not installed" }
    if (harness.status === "binary-only") return { value: harness.id, label: harness.displayName, disabled: true, reason: "no credential" }
    if (hosting && harness.models === undefined) return { value: harness.id, label, disabled: true, reason: "no verified model flag" }
    return { value: harness.id, label }
  }

  /** The options a seam supplies for a provider, read at render; an empty list is a valid answer. */
  const optionsFor = (provider: OptionProvider, draft: FormDraft): ReadonlyArray<FieldOption> => {
    switch (provider) {
      case "harnesses":
        return harnesses().map((harness) => harnessOption(harness, false))
      case "agent-harnesses":
        return harnesses().map((harness) => harnessOption(harness, true))
      case "harness-models": {
        const harness = harnessOf(draft)
        const row = harness === undefined ? undefined : collections.harnesses.get(harness)
        return (row?.models?.suggestions ?? []).map((model) => ({ value: model, label: model }))
      }
      case "open-repos":
        return [...collections.repos.values()].map((repo) => ({ value: repo.id, label: `${repo.name} · ${repo.path}` }))
      case "cloud-repos":
        return [...collections.repositories.values()].map((repo) => ({ value: repo.id, label: repo.id }))
      case "bookmarks": {
        const seen = new Map<string, FieldOption>()
        for (const card of collections.cards.values()) {
          if (card.kind !== "branches") continue
          for (const bookmark of card.payload.bookmarks) {
            if (!seen.has(bookmark.name)) seen.set(bookmark.name, { value: bookmark.name, label: `${bookmark.name} · ${card.payload.repo}` })
          }
        }
        return [...seen.values()]
      }
      case "workspaces":
        return [...collections.cloudWorkspaces.values()].map((workspace) => ({ value: workspace.id, label: `${workspace.name} · ${workspace.status}` }))
      case "plugins": {
        const installed = store.session().plugins ?? []
        return manifests().map((manifest) =>
          installed.includes(manifest.id)
            ? { value: manifest.id, label: manifest.name, disabled: true, reason: "already installed" }
            : { value: manifest.id, label: manifest.name }
        )
      }
      case "agents":
        return roleMenuEntries(harnesses(), orderedAgentRoles([...collections.agents.values()])).map((entry) => ({
          value: entry.role.id,
          label: entry.title,
          ...(entry.available ? {} : { disabled: true, reason: entry.reason })
        }))
    }
  }

  /** The fields as the card payload carries them: the seam's options resolved for this draft, arrays copied for the wire. */
  const withOptions = (fields: ReadonlyArray<FormField>, draft: FormDraft): FlowFormCard["payload"]["fields"] =>
    fields.map((field) => {
      const options = field.optionsFrom === undefined ? field.options : optionsFor(field.optionsFrom, draft)
      const { options: _derived, ...rest } = field
      return options === undefined ? rest : { ...rest, options: [...options] }
    })

  const patch = (card: FlowFormCard, payload: FlowFormCard["payload"], status: Card["status"]): void => {
    const invocation = continuationFor(card)
    // Replace the payload so clearing an optional parse error is durable; patches merge omitted keys.
    store.dispatch({ type: "card.upsert", actor: ctx.commandActor, card: { ...card, payload, status } })
    if (invocation !== undefined) continuations.set(card.id, { invocation, payload: JSON.stringify(payload) })
  }

  /*
   * The harness's own list command answers after the render: when it names
   * models, they replace the table's suggestions on the model field — but
   * only while the draft still names that harness.
   */
  const refreshModelList = async (cardId: string): Promise<void> => {
    const card = formCard(cardId)
    if (card === undefined || !card.payload.fields.some((field) => field.optionsFrom === "harness-models")) return
    const harness = harnessOf(card.payload.draft)
    if (harness === undefined) return
    const answer = await fetchHarnessModels(ctx, harness)
    if (answer.models.length === 0) return
    const current = formCard(cardId)
    if (current === undefined || harnessOf(current.payload.draft) !== harness) return
    const fields = current.payload.fields.map((field) =>
      field.optionsFrom === "harness-models" ? { ...field, options: answer.models.map((model) => ({ value: model, label: model })) } : field
    )
    patch(current, { ...current.payload, fields }, current.status)
  }

  const renderFlowForm: FormsController["renderFlowForm"] = (request) => {
    const entry = request.input === undefined ? ctx.commands.find(request.name) : undefined
    const input = request.input ?? entry?.input
    const hints = request.hints ?? entry?.metadata.form
    if (input === undefined) return undefined
    const fields = formFieldsFor(input, hints)
    if (fields.length === 0) return undefined
    /* A line the grammar parses whole prefills exactly (agent.new's edit prefill); a line it refuses prefills what it can. */
    const parsed = payloadFor(
      request.name,
      request.args,
      (entry ?? ctx.commands.find(request.name))?.metadata.grammar,
      knownRepositories(ctx.store)
    )
    const given = "payload" in parsed ? parsed.payload : partialPayload(fields, hints, request.args)
    const draft = draftFrom(fields, given)
    const resolved = withOptions(fields, draft)
    const parseError = "error" in parsed && missingFields(resolved, draft).length === 0 ? { error: parsed.error } : {}
    const cardId = formCardId(request.name)
    // A human's menu action now continues in the form. Release the menu's
    // backdrop through the same transitions used by its close gestures.
    // Agent-created forms do not dismiss chrome the human is using.
    if (request.via === "user" && ctx.commandActor === "user") {
      const session = store.session()
      const menus = [
        ["tab.menu.toggled", session.tabMenuOpen],
        ["add-menu.toggled", session.addMenuOpen],
        ["connect-menu.toggled", session.connectMenuOpen],
        ["surfaces-menu.toggled", session.surfacesMenuOpen]
      ] as const
      for (const [type, open] of menus) {
        if (open === true) store.dispatch({ type, actor: "user", open: false })
      }
    }
    const existing = collections.cards.get(cardId)
    if (existing?.kind === "flow-form" && existing.payload.submitting === true) {
      return { cardId, missing: missingFields(existing.payload.fields, existing.payload.draft) }
    }
    continuations.delete(cardId)
    store.dispatch({
      type: "card.upsert",
      actor: ctx.commandActor,
      card: {
        id: cardId,
        kind: "flow-form",
        title: `/${request.name}`,
        status: "active",
        createdAt: existing?.createdAt ?? Date.now(),
        ordinal: deps.nextOrdinal(),
        payload: { flow: request.name, via: request.via, fields: resolved, draft, given, ...parseError }
      }
    })
    if (request.invocation !== undefined) {
      continuations.set(cardId, {
        invocation: request.invocation,
        payload: JSON.stringify({ flow: request.name, via: request.via, fields: resolved, draft, given, ...parseError })
      })
    }
    void refreshModelList(cardId)
    const missing = missingFields(resolved, draft)
    return { cardId, missing: missing.length > 0 ? missing : resolved.map((field) => field.name) }
  }

  const coerce = (field: FormField, value: string): { readonly value: FieldValue } | { readonly error: string } => {
    switch (field.kind) {
      case "number": {
        const number = Number(value)
        return Number.isFinite(number) ? { value: number } : { error: `${field.label} is a number; ${value} is not one.` }
      }
      case "boolean":
        return { value: ["true", "on", "yes", "1"].includes(value.toLowerCase()) }
      case "select": {
        const options = field.options ?? []
        if (options.length === 0) return { value }
        const option = options.find((candidate) => candidate.value === value)
        if (option === undefined) return { error: `${field.label} offers ${options.map((candidate) => candidate.value).join(", ")}; ${value} is not one of them.` }
        if (option.disabled === true) return { error: `${option.label} cannot be picked: ${option.reason ?? "it is not available here"}.` }
        return { value }
      }
      default:
        return { value }
    }
  }

  const setFormField: FormsController["setFormField"] = async (cardId, name, raw) => {
    const card = formCard(cardId)
    if (card === undefined) return `There is no form card ${cardId}.`
    if (card.status === "acted") return `The form ${cardId} was already submitted.`
    if (card.payload.submitting === true) return `The form ${cardId} is being submitted.`
    const field = card.payload.fields.find((candidate) => candidate.name === name)
    if (field === undefined) return `The form has no field ${name}; its fields are ${card.payload.fields.map((candidate) => candidate.name).join(", ")}.`
    const value = raw.trim()
    const { [name]: _cleared, ...rest } = card.payload.draft
    let draft: FormDraft = rest
    if (value !== "") {
      const coerced = coerce(field, value)
      if ("error" in coerced) return coerced.error
      draft = { ...rest, [name]: coerced.value }
    }
    const { error: _dropped, ...payload } = card.payload
    /*
     * Options were supplied at render and stay as the card holds them; only a
     * field that can change WHICH harness the model list belongs to
     * re-resolves the providers and re-reads the list (so a later commit on
     * another field never overwrites the list the harness answered with).
     */
    const dependency = ["harness", "harnessId", "id", "roleId"].includes(name)
    patch(card, { ...payload, draft, fields: dependency ? withOptions(card.payload.fields, draft) : card.payload.fields }, "active")
    if (dependency) await refreshModelList(cardId)
  }

  const describe = (outcome: CommandOutcome): string => {
    switch (outcome.status) {
      case "failed":
        return outcome.error
      case "unavailable":
        return outcome.reason
      case "unknown-command":
        return "no flow has that name any more"
      case "form":
        // A submission carries its payload by name, so the run path asking for a form again means the flow still lacks input: a defect to state, not hide.
        return `the filled form did not give /${outcome.flow} what it needs — it still needs ${outcome.fields.join(", ")}`
      case "executed":
        return outcome.value ?? ""
    }
  }

  const submitForm: FormsController["submitForm"] = async (cardId, invocation) => {
    const card = formCard(cardId)
    if (card === undefined) return `There is no form card ${cardId}.`
    if (card.status === "acted") return `The form ${cardId} was already submitted.`
    if (card.payload.submitting === true) return `The form ${cardId} is being submitted.`
    const missing = missingFields(card.payload.fields, card.payload.draft)
    if (missing.length > 0) {
      const labels = card.payload.fields.filter((field) => missing.includes(field.name)).map((field) => field.label)
      const error = `The form still needs: ${labels.join(", ")}.`
      patch(card, { ...card.payload, error }, "error")
      return error
    }
    const { flow, via } = card.payload
    const entry = ctx.commands.find(flow)
    if (entry === undefined) return `/${flow} is not available here.`
    /*
     * The submission is the form's NAMED payload (FlowForms.submissionPayload):
     * every field arrives under its own name and the flow's input schema
     * validates it, so a blank optional cannot shift the next field's value
     * into it. The assembled line is display copy — the card's echo, the
     * trace, and the confirmation message — and nothing parses it back.
     */
    const submission = submissionPayload(entry.input, card.payload.fields, card.payload.given, card.payload.draft)
    if ("error" in submission) {
      patch(card, { ...card.payload, error: submission.error }, "error")
      return submission.error
    }
    const represented = new Set(card.payload.fields.map((field) => field.name))
    const unrepresented = Object.fromEntries(Object.entries(card.payload.given).filter(([name]) => !represented.has(name)))
    const args = assembleArgs(card.payload.fields, entry.metadata.form, { ...unrepresented, ...card.payload.draft })
    const actor = ctx.commandActor
    /*
     * The continuation keeps the asker's actor: an agent-rendered form runs
     * as the agent (a consequential flow posts its confirm card, the human's
     * click runs it), a slash-rendered form runs as the human. The agent can
     * never launder an act through a human's form: its own call is the agent's.
     */
    const asAgent = via === "agent" || actor === "smithers"
    const continuation = invocation ?? continuationFor(card)
    patch(card, { ...card.payload, submitting: true }, "active")
    let outcome: CommandOutcome
    try {
      outcome = await ctx.commands.submit({
        name: flow,
        payload: submission.payload,
        actor: asAgent ? "agent" : "user",
        ...(args === "" ? {} : { display: args }),
        ...(asAgent && continuation !== undefined ? { invocation: continuation } : {})
      })
    } catch (cause) {
      outcome = { status: "failed", error: cause instanceof Error ? cause.message : String(cause) }
    }
    const current = formCard(cardId) ?? card
    if (outcome.status === "executed") {
      continuations.delete(cardId)
      const { error: _dropped, ...payload } = current.payload
      patch(current, { ...payload, submitting: false }, "acted")
      return { value: outcome.value ?? `submitted /${flow}${args === "" ? "" : ` ${args}`}` }
    }
    const error = describe(outcome)
    patch(current, { ...current.payload, submitting: false, error }, "error")
    // The card carries the refusal for the human; the agent reads it as its result.
    return actor === "smithers" ? error : undefined
  }

  const dismissCard: FormsController["dismissCard"] = (cardId) => {
    const card = collections.cards.get(cardId)
    if (card === undefined) return `There is no card ${cardId}.`
    if (card.kind !== "flow-form") return `/card.dismiss dismisses form cards; ${cardId} is a ${card.kind} card.`
    if (card.payload.submitting === true) return `The form ${cardId} is being submitted.`
    continuations.delete(cardId)
    store.dispatch({ type: "card.removed", actor: ctx.commandActor, id: cardId })
  }

  return { renderFlowForm, setFormField, submitForm, dismissCard }
}

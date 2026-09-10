import { RECOMMEND_OUTCOME_PATH, RECOMMEND_PATH } from "@smthrs/rpc/AgentApiRoutes"
import type { CatalogItem, CommandState } from "../flows/registry"
import { recommendedNames, visible } from "../flows/registry"
import { repoSuggestion } from "../Onboarding"
import type { RepoStep } from "../Onboarding"
import type { AppTransition, Card, Message, Suggestion } from "./AppState"

/*
 * The next-step pills as a WORKFLOW, not a rule (will, 2026-08-30): after every
 * material change the app tails the chat, lists every flow the user can invoke,
 * and asks the server's recommender (POST /api/recommend, a Cerebras call) for
 * the order it would click them in. This module is the pure half: what counts
 * as material, the request the contract fixes, the strict answer contract, and
 * the rule that stands in when the recommender cannot answer. The controller
 * half (controller/recommend.ts) owns the debounce, the request, the store
 * write, and the outcome report the eval scores.
 */

/** The registered flow the regeneration runs through (hidden, system-invoked). */
export const RECOMMEND_FLOW = "system.recommend"
/** A pill row longer than this is a menu, not a recommendation. */
export const MAX_RECOMMENDATIONS = 3

/** The recommend routes, spelled once in the rpc package the Worker shares. */
export { RECOMMEND_OUTCOME_PATH, RECOMMEND_PATH }

/** The tail the request carries: the newest messages, capped by count and by text. */
export const TAIL_MAX_MESSAGES = 12
export const TAIL_MAX_CHARS = 4000
/** The command list the request carries, capped; the server refuses more. */
export const COMMANDS_MAX = 300

/*
 * The transitions after which the recommendation is stale: the state a pill
 * answers has changed. Keystrokes, stream deltas, menus, and the recommender's
 * own write are deliberately absent: regenerating on those would loop.
 */
export const MATERIAL_TRANSITIONS: ReadonlySet<AppTransition["type"]> = new Set<AppTransition["type"]>([
  "repos.loaded",
  "connector.local.connected",
  "connector.removed",
  "message.response.completed",
  "message.response.failed",
  "card.approval.decided",
  "tab.opened",
  "tab.closed",
  "identity.session.loaded",
  "identity.session.cleared",
  "conversation.reset",
  "conversation.cleared"
])

export const isMaterialTransition = (type: string): boolean =>
  MATERIAL_TRANSITIONS.has(type as AppTransition["type"])

/** The compact state the recommender reads; every field is a projection of the store. */
export interface RecommendInput {
  readonly state: CommandState
  readonly catalog: ReadonlyArray<CatalogItem>
  readonly repoStep: RepoStep
  /** The active repository as `owner/name`, or null when none is selected. */
  readonly repo: string | null
  readonly messages: ReadonlyArray<Pick<Message, "role" | "text" | "act">>
  readonly cards: ReadonlyArray<Pick<Card, "kind" | "title" | "status">>
}

/** One tail entry on the wire. */
export interface RecommendTailEntry {
  readonly role: "user" | "assistant" | "system"
  readonly text: string
}

/** One invocable flow on the wire: its name and the one-line summary the slash menu shows. */
export interface RecommendCommand {
  readonly name: string
  readonly summary: string
}

/** The POST /api/recommend body, exactly as the contract fixes it. */
export interface RecommendRequest {
  readonly repo: string | null
  readonly tail: ReadonlyArray<RecommendTailEntry>
  readonly commands: ReadonlyArray<RecommendCommand>
}

/** The POST /api/recommend answer, validated against the registry. */
export interface RecommendAnswer {
  readonly id: string
  readonly model: string
  /** The ordered pills, capped at MAX_RECOMMENDATIONS; empty when nothing the server named is offerable. */
  readonly suggestions: ReadonlyArray<Suggestion>
}

const clip = (text: string, max: number): string => (text.length <= max ? text : `${text.slice(0, max - 1)}…`)

/**
 * The chat tail: the newest messages last, act markers and empty rows left
 * out, at most TAIL_MAX_MESSAGES entries and TAIL_MAX_CHARS of text. Over the
 * text cap the oldest entries leave first; a lone entry over it keeps its
 * newest characters, so the server never answers 413 to a client that
 * followed the contract.
 */
export const recommendTail = (
  messages: ReadonlyArray<Pick<Message, "role" | "text" | "act">>
): ReadonlyArray<RecommendTailEntry> => {
  const entries = messages
    .filter((message) => message.act === undefined && message.text.trim() !== "")
    .slice(-TAIL_MAX_MESSAGES)
    .map((message): RecommendTailEntry => ({
      role: message.role === "user" ? "user" : "assistant",
      text: message.text.trim()
    }))
  const total = (rows: ReadonlyArray<RecommendTailEntry>): number => rows.reduce((sum, row) => sum + row.text.length, 0)
  let tail = entries
  while (tail.length > 1 && total(tail) > TAIL_MAX_CHARS) tail = tail.slice(1)
  const only = tail[0]
  if (tail.length === 1 && only !== undefined && only.text.length > TAIL_MAX_CHARS) {
    tail = [{ role: only.role, text: only.text.slice(-TAIL_MAX_CHARS) }]
  }
  return tail
}

/** The request body: the active repository, the chat tail, and every offerable flow. */
export const recommendRequest = (input: Pick<RecommendInput, "repo" | "messages" | "catalog">): RecommendRequest => ({
  repo: input.repo,
  tail: recommendTail(input.messages),
  commands: visible(input.catalog)
    .slice(0, COMMANDS_MAX)
    .map((command): RecommendCommand => ({ name: command.name, summary: command.summary }))
})

/** The flow that opens the surface the user is already on: a no-op click, never a recommendation. */
export const currentSurfaceFlow = (surface: CommandState["surface"]): string =>
  surface === "world"
    ? "wiki"
    : surface === "connectors"
    ? "connect"
    : surface === "plugins"
    ? "plugins"
    : "chat"

const asString = (value: unknown): string | undefined => (typeof value === "string" && value.trim() !== "" ? value.trim() : undefined)

/**
 * The server's answer, validated against the registry: unknown and hidden
 * flows are dropped, duplicates collapse, the row is capped, the first is
 * gold. A body without an id or a command list is no answer at all
 * (undefined), never a thrown error; the caller keeps the rule's pills.
 */
export const parseRecommendation = (
  body: unknown,
  catalog: ReadonlyArray<CatalogItem>,
  surface?: CommandState["surface"]
): RecommendAnswer | undefined => {
  if (typeof body !== "object" || body === null) return undefined
  const record = body as Record<string, unknown>
  const id = asString(record.id)
  if (id === undefined || !Array.isArray(record.commands)) return undefined
  const model = asString(record.model) ?? "unknown"
  const allowed = new Map(visible(catalog).map((command) => [command.name, command]))
  const seen = new Set<string>()
  const suggestions: Array<Suggestion> = []
  for (const entry of record.commands) {
    const flow = asString(entry)?.replace(/^\/+/, "")
    if (flow === undefined) continue
    const command = allowed.get(flow)
    if (command === undefined || seen.has(flow)) continue
    // The live answer recommended "Continue chat" on the chat: a click that changes nothing.
    if (surface !== undefined && flow === currentSurfaceFlow(surface)) continue
    seen.add(flow)
    suggestions.push({
      id: `reco-${flow}`,
      label: clip(command.summary, 40),
      flow,
      emphasis: suggestions.length === 0 ? "primary" : "secondary"
    })
    if (suggestions.length >= MAX_RECOMMENDATIONS) break
  }
  return { id, model, suggestions }
}

/**
 * The rule the recommender replaces and falls back to: a pending gate or a
 * live run leads (lane runs: the next click when the workspace waits on the
 * human is the gate, and when runs are moving it is the inbox), then the repo
 * step (the onboarding pill), then the registry's recommendation order, capped.
 * While a turn streams the pills are disabled anyway, so the row is empty then.
 */
export const ruleSuggestions = (
  input: Pick<RecommendInput, "state" | "catalog" | "repoStep"> & Partial<Pick<RecommendInput, "cards">>
): ReadonlyArray<Suggestion> => {
  if (input.state.typing) return []
  const byName = new Map(visible(input.catalog).map((command) => [command.name, command]))
  const cards = input.cards ?? []
  const gateOpen = cards.some((card) => card.kind === "approval" && card.status === "active")
  const runLive = cards.some((card) => card.kind === "run-trace" && card.status === "active")
  const lifecycle: Array<Suggestion> = []
  if (gateOpen && byName.has("approvals.list")) {
    lifecycle.push({
      id: "reco-approvals.list",
      label: "Decide approvals",
      flow: "approvals.list",
      emphasis: "primary",
      why: "A run is parked on your decision."
    })
  } else if (runLive && byName.has("runs.list")) {
    lifecycle.push({
      id: "reco-runs.list",
      label: "See your runs",
      flow: "runs.list",
      emphasis: "primary",
      why: "Runs are live on your workspace."
    })
  }
  const lead = [...lifecycle, ...repoSuggestion(input.repoStep)]
  const rest = recommendedNames(input.state)
    .filter((name) => byName.has(name) && !lead.some((suggestion) => suggestion.flow === name))
    .map((name): Suggestion => ({
      id: `reco-${name}`,
      label: byName.get(name)?.summary ?? name,
      flow: name,
      emphasis: lead.length === 0 && name === recommendedNames(input.state)[0] ? "primary" : "secondary"
    }))
  return [...lead, ...rest].slice(0, MAX_RECOMMENDATIONS)
}

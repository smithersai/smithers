/*
 * The triggers seam: the dispatchers waiting on one repository, from two
 * sources that are never mixed (Factory design session 2026-09-07, mock 2).
 *
 * The DECLARATION is the `on` table of `.smithers/factory.json`, the
 * projection of `.smithers/FACTORY.ts`, read from the public mirror through
 * the contents route (GET /api/repos/{o}/{r}/contents/.smithers/factory.json,
 * the read path the app uses for every other repository file). It is
 * allowlisted for signed-out reads, so every visitor gets the declared rows.
 * A mirror that holds no projection yet answers 404, and that is "no rules
 * declared", not an error.
 *
 * The BOX is GET /api/workflow/triggers?repo=owner/repo (apps/server
 * workflowTriggers.ts): the trigger store and webhook registry of the
 * signed-in session's own box. Its `live` flag says whether a box answered;
 * the seam asks it only for a signed-in session, and a signed-out card
 * carries no live rows and no placeholders for them.
 */
import { WORKFLOW_TRIGGERS_PATH } from "@smthrs/rpc/AgentApiRoutes"
import { FACTORY_PROJECTION_PATH, FactoryProjectionSchema, ruleFlows } from "@smthrs/rpc/FactoryProjection"
import type { FactoryProjection, FactoryRule } from "@smthrs/rpc/FactoryProjection"
import type { Card } from "../AppState"
import { resolveTargetRepo } from "../RepoContext"
import type { SeamContext } from "./SeamContext"

type TriggerListCard = Extract<Card, { kind: "trigger-list" }>
export type TriggerRow = TriggerListCard["payload"]["triggers"][number]
export type WebhookRow = NonNullable<TriggerListCard["payload"]["webhooks"]>[number]

/** The signed-out card's whole text while the mirror holds no projection. */
export const NO_RULES_SENTENCE = "No rules declared yet"

/** The honest refusal of the register door until a register procedure crosses the relay. */
export const registerUnavailableSentence = (repo: string): string =>
  `A rule cannot be registered on ${repo} from here yet: declare it in .smithers/FACTORY.ts, or register it with the smthrs CLI on the box.`

export interface TriggersSeam {
  /** The dispatcher card (triggers.list): declared rows for every visitor, live rows when a box answered. */
  readonly listTriggers: (repo?: string) => Promise<string | void | { readonly value: string }>
  /** The register door (triggers.register): signed-in by requirement, and refusing honestly until it can act. */
  readonly registerTrigger: (repo?: string) => Promise<string | void>
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)

const repoBase = (ctx: SeamContext, repo: string): string => {
  const [owner = "", name = ""] = repo.split("/")
  return `${ctx.baseUrl}/api/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`
}

const readJson = async (ctx: SeamContext, url: string): Promise<{ status: number; body: unknown }> => {
  try {
    const response = await ctx.http(url)
    const body: unknown = await response.json().catch(() => undefined)
    return { status: response.status, body }
  } catch {
    return { status: 0, body: undefined }
  }
}

/** The contents route's document: base64 or plain text under `content`. */
const decodeContent = (body: unknown): string | null => {
  if (!isRecord(body) || typeof body.content !== "string") return null
  if (body.encoding === "base64") {
    try {
      return new TextDecoder().decode(Uint8Array.from(atob(body.content.replace(/\s+/g, "")), (char) => char.charCodeAt(0)))
    } catch {
      return null
    }
  }
  return body.content
}

/**
 * The declared rules, or the honest reason they could not be read. A 404 is
 * the mirror's own statement that no projection is committed: an empty
 * table. Anything else that is not a well-formed projection is an error
 * sentence, never an empty table pretending to be one.
 */
export const readDeclaredRules = async (
  ctx: SeamContext,
  repo: string
): Promise<ReadonlyArray<FactoryRule> | { readonly error: string }> => {
  const projection = await readFactoryProjection(ctx, repo)
  if ("error" in projection) return { error: `The rules of ${repo} couldn't be read: ${projection.error}` }
  return projection.absent ? [] : projection.projection.on
}

/**
 * The whole projection off the contents route, shared by the rules table and
 * the palette's target search: `absent` when the mirror 404s (nothing is
 * committed), the decoded projection when it parses, else the reason.
 */
export const readFactoryProjection = async (
  ctx: SeamContext,
  repo: string
): Promise<
  | { readonly absent: true }
  | { readonly absent: false; readonly projection: FactoryProjection }
  | { readonly error: string }
> => {
  const answer = await readJson(ctx, `${repoBase(ctx, repo)}/contents/${FACTORY_PROJECTION_PATH}`)
  if (answer.status === 404) return { absent: true }
  if (answer.status !== 200) return { error: `the mirror did not answer for ${FACTORY_PROJECTION_PATH}.` }
  const text = decodeContent(answer.body)
  let parsed: unknown
  try {
    parsed = text === null ? undefined : JSON.parse(text)
  } catch {
    parsed = undefined
  }
  const projection = FactoryProjectionSchema.safeParse(parsed)
  if (!projection.success) return { error: `${FACTORY_PROJECTION_PATH} is not a factory projection.` }
  return { absent: false, projection: projection.data }
}

const triggerRow = (value: unknown): TriggerRow | undefined => {
  if (!isRecord(value)) return undefined
  if (typeof value.id !== "string" || typeof value.flowId !== "string" || typeof value.cron !== "string") return undefined
  return {
    id: value.id,
    flowId: value.flowId,
    cron: value.cron,
    ...(typeof value.timezone === "string" ? { timezone: value.timezone } : {}),
    enabled: value.enabled === true,
    ...(typeof value.lastFiredAt === "number" ? { lastFiredAt: value.lastFiredAt } : {}),
    ...(typeof value.nextFireAt === "number" ? { nextFireAt: value.nextFireAt } : {}),
    ...(typeof value.activeRunId === "string" ? { activeRunId: value.activeRunId } : {})
  }
}

const webhookRow = (value: unknown): WebhookRow | undefined => {
  if (!isRecord(value) || typeof value.name !== "string") return undefined
  return { name: value.name, ...(typeof value.flowId === "string" ? { flowId: value.flowId } : {}) }
}

interface LiveList {
  readonly live: boolean
  readonly triggers: ReadonlyArray<TriggerRow>
  readonly webhooks: ReadonlyArray<WebhookRow>
}

const NO_LIVE: LiveList = { live: false, triggers: [], webhooks: [] }

/**
 * The box's rows. Only `live: true` with well-formed rows counts as an
 * answer; a route that did not answer, or answered without `live: true`,
 * is "no box answered" and the card shows no live column at all.
 */
export const readLiveTriggers = async (ctx: SeamContext, repo: string): Promise<LiveList> => {
  const answer = await readJson(ctx, `${ctx.baseUrl}${WORKFLOW_TRIGGERS_PATH}?repo=${encodeURIComponent(repo)}`)
  if (answer.status !== 200 || !isRecord(answer.body) || answer.body.status !== "ok" || answer.body.live !== true) return NO_LIVE
  const triggers = (Array.isArray(answer.body.triggers) ? answer.body.triggers : [])
    .map(triggerRow)
    .filter((row): row is TriggerRow => row !== undefined)
  const webhooks = (Array.isArray(answer.body.webhooks) ? answer.body.webhooks : [])
    .map(webhookRow)
    .filter((row): row is WebhookRow => row !== undefined)
  return { live: true, triggers, webhooks }
}

/** The one-line answer the slash and the agent get beside the card. */
const summarize = (repo: string, declared: ReadonlyArray<FactoryRule>, live: LiveList): string => {
  const parts: Array<string> = []
  if (declared.length > 0) {
    parts.push(
      `${declared.length} rule${declared.length === 1 ? "" : "s"} declared in .smithers/FACTORY.ts: ${
        declared.map((rule) => `${rule.event} runs ${ruleFlows(rule).join(", ")}`).join("; ")
      }`
    )
  }
  if (live.live) {
    const rows = [
      ...live.triggers.map((trigger) => `${trigger.id} runs ${trigger.flowId}`),
      ...live.webhooks.map((webhook) => `webhook ${webhook.name}${webhook.flowId === undefined ? "" : ` runs ${webhook.flowId}`}`)
    ]
    parts.push(rows.length === 0 ? "the box is listening with nothing registered" : `the box is listening: ${rows.join(", ")}`)
  }
  return parts.length === 0 ? `${NO_RULES_SENTENCE} on ${repo}.` : `Dispatcher on ${repo}: ${parts.join(". ")}.`
}

export const createTriggersSeam = (ctx: SeamContext): TriggersSeam => {
  const listTriggers = async (repoArg?: string): Promise<string | void | { readonly value: string }> => {
    const target = resolveTargetRepo(ctx.store, repoArg)
    if ("error" in target) return target.error
    const repo = target.repo
    const identity = ctx.store.collections.identitySessions.get("identity")
    const signedIn = identity?.state === "signed-in" && identity.allowlisted
    const [declared, live] = await Promise.all([
      readDeclaredRules(ctx, repo),
      signedIn ? readLiveTriggers(ctx, repo) : Promise.resolve(NO_LIVE)
    ])
    if ("error" in declared) return declared.error
    const cardId = `trigger-list-${repo}`
    const existing = ctx.store.collections.cards.get(cardId)
    const card: Card = {
      id: cardId,
      kind: "trigger-list",
      title: `Dispatcher · ${repo}`,
      status: "active",
      createdAt: existing?.createdAt ?? Date.now(),
      ordinal: ctx.nextOrdinal(),
      payload: {
        repo,
        declared: [...declared],
        live: live.live,
        triggers: [...live.triggers],
        webhooks: [...live.webhooks]
      }
    }
    ctx.dispatch({ type: "card.upsert", actor: ctx.actor(), card })
    return { value: summarize(repo, declared, live) }
  }

  /*
   * The register door exists so every door (button, slash, agent) meets the
   * same sign-in requirement and the same honest answer: no register
   * procedure crosses the relay yet, so nothing is written from here.
   */
  const registerTrigger = async (repoArg?: string): Promise<string | void> => {
    const target = resolveTargetRepo(ctx.store, repoArg)
    if ("error" in target) return target.error
    return registerUnavailableSentence(target.repo)
  }

  return { listTriggers, registerTrigger }
}

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
import { WORKFLOW_RPC_PATH, WORKFLOW_TRIGGERS_PATH } from "@smthrs/rpc/AgentApiRoutes"
import { FACTORY_PROJECTION_PATH, FactoryProjectionSchema, ruleFlows } from "@smthrs/rpc/FactoryProjection"
import type { FactoryProjection, FactoryRule } from "@smthrs/rpc/FactoryProjection"
import { refusalOf } from "@smthrs/rpc/Refusal"
import { refusalSentence } from "@smthrs/rpc/RefusalCopy"
import { Schema, SchemaRepresentation } from "effect"
import type { JsonSchema } from "effect"
import type { Card } from "../AppState"
import { resolveTargetRepo } from "../RepoContext"
import { errorMessage, unreachableSentence } from "./SeamContext"
import type { SeamContext } from "./SeamContext"

type TriggerListCard = Extract<Card, { kind: "trigger-list" }>
export type TriggerRow = TriggerListCard["payload"]["triggers"][number]
export type WebhookRow = NonNullable<TriggerListCard["payload"]["webhooks"]>[number]

/** The signed-out card's whole text while the mirror holds no projection. */
export const NO_RULES_SENTENCE = "No rules declared yet"

/*
 * The Worker's generic-trigger routes (apps/server repositoryTriggers.ts).
 * They address `flow:<slug>` repository jobs on Smithers Cloud, which the
 * shared route table does not name yet.
 */
const TRIGGER_REGISTRATIONS_PATH = "/api/workflow/trigger-registrations"
const TRIGGER_PAUSE_PATH = "/api/workflow/trigger-pause"
const TRIGGER_APPROVAL_PATH = "/api/workflow/trigger-approval"

/** The workspace built-in that registers a repository flow on a schedule. */
const REGISTRAR_FLOW = "repository/trigger"

/** A schedule's own name inside one repository (L36 §1.1). */
const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/

/** Plue's own words for a schedule that is not five UTC cron fields. */
export const CRON_REFUSAL = "schedule must have five cron fields in UTC"

/** What the trigger write door was asked to do. */
export interface TriggerWrite {
  /**
   * `register` prepares: it validates, plans the target flow, and offers the
   * human's approve button. `approve` is the human's alone. `pause` stops a
   * schedule they enabled.
   */
  readonly operation: "register" | "approve" | "pause"
  readonly repo?: string
  readonly flow?: string
  readonly slug?: string
  readonly schedule?: string
  /** The user's input for the target flow, as the form holds it: JSON text. */
  readonly input?: string
  /** The plan the preview showed, pinned so approval cannot drift to another one. */
  readonly planId?: string
  readonly planDigest?: string
}

export interface TriggersSeam {
  /** The dispatcher card (triggers.list): declared rows for every visitor, live rows when a box answered. */
  readonly listTriggers: (repo?: string) => Promise<string | void | { readonly value: string }>
  /** The trigger write door: register, approve, pause (triggers.register / .approve / .pause). */
  readonly registerTrigger: (request: TriggerWrite) => Promise<string | void | { readonly value: string }>
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

/**
 * One `flow:*` registration as the Worker publishes it (E9), read into the
 * dispatcher's own row shape. `cron` is the registration's schedule, which is
 * what a generic trigger always carries; the timezone is Plue's fixed UTC.
 */
const registrationRow = (value: unknown): TriggerRow | undefined => {
  if (!isRecord(value)) return undefined
  if (typeof value.slug !== "string" || typeof value.flowId !== "string" || typeof value.schedule !== "string") return undefined
  const next = typeof value.nextFireAt === "string" ? Date.parse(value.nextFireAt) : Number.NaN
  return {
    id: typeof value.registrationId === "string" ? value.registrationId : value.slug,
    flowId: value.flowId,
    cron: value.schedule,
    timezone: "UTC",
    enabled: value.enabled === true,
    ...(Number.isFinite(next) ? { nextFireAt: next } : {})
  }
}

/**
 * The repository's generic trigger registrations, through the Worker. A route
 * that did not answer is "no registrations read", never an empty listing
 * pretending the schedules were retired.
 */
export const readTriggerRegistrations = async (ctx: SeamContext, repo: string): Promise<LiveList> => {
  const answer = await readJson(ctx, `${ctx.baseUrl}${TRIGGER_REGISTRATIONS_PATH}?repo=${encodeURIComponent(repo)}`)
  if (answer.status !== 200 || !isRecord(answer.body) || answer.body.status !== "ok") return NO_LIVE
  const triggers = (Array.isArray(answer.body.rows) ? answer.body.rows : [])
    .map(registrationRow)
    .filter((row): row is TriggerRow => row !== undefined)
  return { live: true, triggers, webhooks: [] }
}

/** One relayed gateway procedure, as the workflow relay answers it. */
type Relayed =
  | { readonly ok: true; readonly value: Record<string, unknown> }
  | { readonly ok: false; readonly message: string }

/**
 * One call to the workspace through the existing `/api/workflow/rpc` relay.
 *
 * A refusal keeps the refusing party's own words: the host's module-form
 * sentence and the control plane's `flow_not_found` listing reach the human
 * exactly as they were written, which is the only way a truthful refusal
 * survives three hops.
 */
const relay = async (
  ctx: SeamContext,
  repo: string,
  procedure: string,
  payload: unknown
): Promise<Relayed> => {
  let response: Response
  try {
    response = await ctx.http(`${ctx.baseUrl}${WORKFLOW_RPC_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repo, procedure, payload })
    })
  } catch (error) {
    return { ok: false, message: unreachableSentence("the workspace", error) }
  }
  const body: unknown = await response.json().catch(() => undefined)
  if (!response.ok) {
    return { ok: false, message: refusalSentence(refusalOf({ body, status: response.status, message: errorMessage(body, "The workspace didn't answer.") })) }
  }
  if (!isRecord(body)) return { ok: false, message: "The workspace answered in a shape I didn't understand." }
  if (body.ok === true) return { ok: true, value: isRecord(body.payload) ? body.payload : {} }
  const error = isRecord(body.error) ? body.error : {}
  return { ok: false, message: typeof error.message === "string" && error.message !== "" ? error.message : "The workspace refused the call." }
}

/** One of the Worker's own trigger routes, with its typed refusal kept whole. */
const workerCall = async (
  ctx: SeamContext,
  path: string,
  body: unknown
): Promise<{ readonly ok: true; readonly value: Record<string, unknown> } | { readonly ok: false; readonly message: string }> => {
  let response: Response
  try {
    response = await ctx.http(`${ctx.baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    })
  } catch (error) {
    return { ok: false, message: unreachableSentence("Smithers Cloud", error) }
  }
  const answer: unknown = await response.json().catch(() => undefined)
  if (!response.ok || !isRecord(answer) || answer.status !== "ok") {
    return { ok: false, message: refusalSentence(refusalOf({ body: answer, status: response.status, message: errorMessage(answer, "Smithers Cloud didn't answer.") })) }
  }
  return { ok: true, value: answer }
}

/** What the target flow's own declared input schema says about the registered input, in its own words. */
const schemaRefusal = (document: unknown, input: unknown): string | undefined => {
  if (document === null || typeof document !== "object") return undefined
  /* The importer answers the open `Top`; a published input document decodes without services, which is what `decodeUnknownSync` needs. */
  let declared: Schema.Top & Schema.ConstraintDecoder<unknown, never>
  try {
    declared = SchemaRepresentation.fromJsonSchemaDocument(
      document as JsonSchema.Document<"draft-2020-12">
    ) as Schema.Top & Schema.ConstraintDecoder<unknown, never>
  } catch {
    return undefined
  }
  try {
    Schema.decodeUnknownSync(declared)(input)
    return undefined
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

/** The plan preview: the facts the workspace stated about what a fire would run. */
const previewOf = (plan: Record<string, unknown>, schedule: string): string => {
  const envelope = isRecord(plan.envelope) ? plan.envelope : {}
  const capabilities = Array.isArray(envelope.capabilities) ? envelope.capabilities.filter((value): value is string => typeof value === "string") : []
  const minutes = typeof envelope.milliseconds === "number" ? Math.round(envelope.milliseconds / 60_000) : undefined
  const digest = typeof plan.executionDigest === "string" ? plan.executionDigest.slice(0, 12) : ""
  return [
    `${String(plan.flowId)} · ${schedule} UTC`,
    capabilities.join(", "),
    [typeof envelope.tokens === "number" ? `${envelope.tokens} tokens` : undefined, minutes === undefined ? undefined : `${minutes} min`]
      .filter((part) => part !== undefined).join(" · "),
    digest
  ].filter((line) => line !== "").join("\n")
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
    const [declared, box, registered] = await Promise.all([
      readDeclaredRules(ctx, repo),
      signedIn ? readLiveTriggers(ctx, repo) : Promise.resolve(NO_LIVE),
      signedIn ? readTriggerRegistrations(ctx, repo) : Promise.resolve(NO_LIVE)
    ])
    if ("error" in declared) return declared.error
    const live: LiveList = {
      live: box.live || registered.live,
      triggers: [...box.triggers, ...registered.triggers],
      webhooks: box.webhooks
    }
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

  /** The prepared registration the approve button carries, as one JSON object. */
  const prepared = (request: TriggerWrite, repo: string, planId: string, planDigest: string): string =>
    JSON.stringify({
      repo,
      flow: request.flow,
      slug: request.slug,
      schedule: request.schedule,
      ...(request.input === undefined || request.input.trim() === "" ? {} : { input: request.input }),
      planId,
      planDigest
    })

  /**
   * Prepare a registration: validate it here, ask the workspace to plan the
   * target flow with exactly the input the human gave, show that plan, and
   * offer the approve button. Nothing is approved and nothing is registered.
   */
  const prepareTrigger = async (request: TriggerWrite, repo: string): Promise<string | void | { readonly value: string }> => {
    const slug = request.slug ?? ""
    if (!SLUG.test(slug)) return "A schedule name is lower-case letters, digits and dashes, up to 64 characters."
    const schedule = (request.schedule ?? "").trim()
    if (schedule.split(/\s+/).filter((field) => field !== "").length !== 5) return CRON_REFUSAL
    const text = (request.input ?? "").trim()
    let input: unknown = {}
    if (text !== "") {
      try {
        input = JSON.parse(text)
      } catch {
        return "Input is not valid JSON."
      }
    }
    const listed = await relay(ctx, repo, "List", { _tag: "flows" })
    if (!listed.ok) return listed.message
    const items = (Array.isArray(listed.value.items) ? listed.value.items : []).filter(isRecord)
    const target = items.find((item) => item.flowId === request.flow)
    if (target === undefined) {
      const names = items.map((item) => String(item.flowId)).join(", ")
      return `No flow "${request.flow}" is registered on this workspace. The workspace has: ${names}.`
    }
    const refusal = schemaRefusal(target.inputSchema, input)
    if (refusal !== undefined) return refusal
    const planned = await relay(ctx, repo, "Plan", {
      flowId: request.flow,
      input,
      idempotencyKey: `trigger:${repo}:${slug}:plan`
    })
    if (!planned.ok) return planned.message
    const planId = typeof planned.value.planId === "string" ? planned.value.planId : undefined
    const planDigest = typeof planned.value.digest === "string" ? planned.value.digest : undefined
    if (planId === undefined || planDigest === undefined) return "The workspace planned the flow but didn't name the plan."
    ctx.dispatch({
      type: "message.appended",
      actor: "system",
      text: previewOf(planned.value, schedule),
      action: { flow: "triggers.approve", args: prepared(request, repo, planId, planDigest), label: "Approve and register" }
    })
    return { value: `Prepared ${slug}. It registers when the user approves the plan.` }
  }

  /**
   * The human's approval, and only theirs (triggers.approve is userOnly).
   *
   * The plan is re-made under the same idempotency key and must reproduce the
   * pair the preview showed, so approving cannot drift to another plan. Then
   * the plan is approved, Smithers Cloud stamps who approved it, and the
   * workspace's registrar runs the test run and writes the registration.
   */
  const approveTrigger = async (request: TriggerWrite, repo: string): Promise<string | void | { readonly value: string }> => {
    const slug = request.slug ?? ""
    const planId = request.planId
    const planDigest = request.planDigest
    if (!SLUG.test(slug) || planId === undefined || planDigest === undefined) {
      return "This approval does not name a prepared registration."
    }
    const text = (request.input ?? "").trim()
    let input: unknown = {}
    if (text !== "") {
      try {
        input = JSON.parse(text)
      } catch {
        return "Input is not valid JSON."
      }
    }
    const planned = await relay(ctx, repo, "Plan", {
      flowId: request.flow,
      input,
      idempotencyKey: `trigger:${repo}:${slug}:plan`
    })
    if (!planned.ok) return planned.message
    if (planned.value.planId !== planId || planned.value.digest !== planDigest) {
      return "The plan changed since you saw it. Prepare the registration again."
    }
    const envelope = planned.value.envelope
    const approved = await relay(ctx, repo, "Approval.Submit", {
      target: { _tag: "Plan", planId, digest: planDigest, envelope },
      scope: "run",
      idempotencyKey: `approve:${planId}`,
      decision: "approve"
    })
    if (!approved.ok) return approved.message
    const receipt = await workerCall(ctx, TRIGGER_APPROVAL_PATH, { repo, slug, planId, planDigest, envelope })
    if (!receipt.ok) return receipt.message
    const registrar = await relay(ctx, repo, "Plan", {
      flowId: REGISTRAR_FLOW,
      input: {
        operation: "register",
        repo,
        slug,
        flow: request.flow,
        schedule: request.schedule,
        input,
        approvedPlanId: planId,
        approvedPlanDigest: planDigest
      },
      idempotencyKey: `trigger:${repo}:${slug}:register-plan`
    })
    if (!registrar.ok) return registrar.message
    const registrarPlan = typeof registrar.value.planId === "string" ? registrar.value.planId : undefined
    const registrarDigest = typeof registrar.value.digest === "string" ? registrar.value.digest : undefined
    if (registrarPlan === undefined || registrarDigest === undefined) {
      return "The workspace planned the registration but didn't name the plan."
    }
    const granted = await relay(ctx, repo, "Approval.Submit", {
      target: { _tag: "Plan", planId: registrarPlan, digest: registrarDigest, envelope: registrar.value.envelope },
      scope: "run",
      idempotencyKey: `approve:${registrarPlan}`,
      decision: "approve"
    })
    if (!granted.ok) return granted.message
    const started = await relay(ctx, repo, "Run", {
      _tag: "Plan",
      planId: registrarPlan,
      digest: registrarDigest,
      envelope: registrar.value.envelope,
      idempotencyKey: `trigger:${repo}:${slug}:register-run`
    })
    if (!started.ok) return started.message
    return { value: `Registering ${slug} on ${repo}.` }
  }

  /** Stop a schedule the human enabled, then re-read the listing so the card states it. */
  const pauseTrigger = async (request: TriggerWrite, repo: string): Promise<string | void | { readonly value: string }> => {
    const slug = request.slug ?? ""
    if (!SLUG.test(slug)) return "A schedule name is lower-case letters, digits and dashes, up to 64 characters."
    const paused = await workerCall(ctx, TRIGGER_PAUSE_PATH, { repo, slug })
    if (!paused.ok) return paused.message
    await listTriggers(repo)
    return { value: `Paused ${slug} on ${repo}.` }
  }

  /*
   * The one write door of the dispatcher. Every operation resolves the same
   * target repository first, so a button, a slash line and the agent all act
   * on the repository the human is looking at.
   */
  const registerTrigger = async (request: TriggerWrite): Promise<string | void | { readonly value: string }> => {
    const target = resolveTargetRepo(ctx.store, request.repo)
    if ("error" in target) return target.error
    if (request.operation === "approve") return approveTrigger(request, target.repo)
    if (request.operation === "pause") return pauseTrigger(request, target.repo)
    return prepareTrigger(request, target.repo)
  }

  return { listTriggers, registerTrigger }
}

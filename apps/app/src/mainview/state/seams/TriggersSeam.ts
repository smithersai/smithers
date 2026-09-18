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
import { repositoryJobWorkspace } from "../RepositoryJobs"
import { runtimeRunKey } from "../RuntimeProjection"
import type { RuntimeScope } from "../RuntimeProjection"
import { errorMessage, unreachableSentence } from "./SeamContext"
import type { SeamContext } from "./SeamContext"

type TriggerListCard = Extract<Card, { kind: "trigger-list" }>
export type TriggerRow = TriggerListCard["payload"]["triggers"][number]
export type WebhookRow = NonNullable<TriggerListCard["payload"]["webhooks"]>[number]

/** The signed-out card's whole text while the mirror holds no projection. */
export const NO_RULES_SENTENCE = "No rules declared yet"

/** The honest refusal of the register door while the workspace holds no registrar (L36 §2.4 step 4). */
export const registerUnavailableSentence = (repo: string): string =>
  `A schedule cannot be registered on ${repo} from here yet: this workspace has no repository/trigger flow.`

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

/**
 * The code a journalled failure carries in front of its sentence, as
 * internal/FailureSummary.ts writes the pair. The registrar's codes say whose
 * problem it is — `invalid_receipt` for the maintainer's input or their flow,
 * `execution` for a registration that never finished — so the app never reads
 * the prose to decide that, and the person reads the sentence alone.
 */
const JOURNALLED_CODE = /^[a-z][a-z0-9_]*: /

/** One registration attempt's run card; the same attempt never registers twice. */
const registrationCardId = (requestId: string): string => `trigger-register-${requestId}`

/** The run id a refused launch leaves on its card: the workspace named none. */
const unlaunchedRunId = (requestId: string): string => `pending-${requestId}`

/** A run this client has seen settle: nothing is left to watch or to reconnect to. */
const SETTLED_PHASES: ReadonlySet<string> = new Set(["completed", "failed", "cancelled", "stopped"])

type RunCardPayload = Extract<Card, { kind: "run-trace" }>["payload"]
type RunCardPatch = Pick<RunCardPayload, "runId" | "phase"> & Partial<RunCardPayload>

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
  /**
   * The one registration attempt this is, minted when the door prepares.
   * Every idempotency key of the attempt hangs off it, so pressing the same
   * button twice repeats one plan and preparing the schedule again — with a
   * corrected input, or against an edited flow — asks for a fresh one.
   */
  readonly requestId?: string
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

/**
 * The two pieces of the controller a registration needs, handed in rather
 * than rebuilt: the app's one run-watch and the app's one toast stack
 * (state/controller/workflow-pump.ts, state/controller/failures.ts).
 *
 * Registering is slow work — six relayed calls and then a run on the
 * workspace — so the approve door answers at once and both of these carry it
 * afterwards, which is what the instant-chat rule asks of every background act.
 */
export interface TriggersRuntime {
  /** Watch one run card; it settles when that run does. */
  readonly watchRun: (cardId: string) => Promise<void>
  /** Background work on the shared stack, under its 300 ms debounce; a string outcome is the failure line. */
  readonly withToast: <T>(key: string, title: string, doneTitle: string, work: () => Promise<T | string>) => Promise<T | string>
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
 *
 * `live` here says the route answered, which every repository's listing does
 * whether or not it holds a schedule; what the card calls listening is the
 * merge in `listTriggers`, which asks for a row.
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
 * The box this repository's reviewed jobs run on, as their own setups
 * recorded it: the workspace gateway that holds the registrar. Every relayed
 * call names it, and so does the registration's own run card, because a
 * gateway binding is what decides which of the two registries answers.
 */
const jobWorkspace = (ctx: SeamContext, repo: string): string | undefined =>
  repositoryJobWorkspace(
    ctx.store.collections.cards.values(),
    repo,
    ctx.store.collections.identitySessions.get("identity")?.login ?? null
  )

/**
 * One call to the workspace through the existing `/api/workflow/rpc` relay.
 *
 * The call names the workspace the repository's reviewed jobs run on, because
 * that box is the one holding the registrar: the workspace gateway runs the
 * coding host, whose catalog carries `repository/setup`, `repository/trigger`
 * and the five `repository-jobs/*` (flows/repository/registry.ts), while the
 * repository's own gateway runs the product host and carries the two
 * librarian flows. A relay call that names no workspace reaches the second
 * one, which answers `flow_not_found` for the registrar on every repository.
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
  const workspaceId = jobWorkspace(ctx, repo)
  let response: Response
  try {
    response = await ctx.http(`${ctx.baseUrl}${WORKFLOW_RPC_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repo, procedure, payload, ...(workspaceId === undefined ? {} : { workspaceId }) })
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
  if (typeof error.message === "string" && error.message !== "") return { ok: false, message: error.message }
  /* A box that is resuming, at capacity or over a quota answers 200 with that state and its own sentence (apps/server workflows.ts). */
  if (typeof body.message === "string" && body.message !== "") return { ok: false, message: body.message }
  return { ok: false, message: "The workspace refused the call." }
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

/**
 * The plan preview: the facts the workspace stated about what a fire would
 * run. The budget is what approving grants to every unattended fire, so it is
 * read from the envelope's own `budget` (control/ControlSchema.ts Envelope)
 * and shown beside the capabilities rather than left off the card.
 */
const previewOf = (plan: Record<string, unknown>, schedule: string): string => {
  const envelope = isRecord(plan.envelope) ? plan.envelope : {}
  const capabilities = Array.isArray(envelope.capabilities) ? envelope.capabilities.filter((value): value is string => typeof value === "string") : []
  const budget = isRecord(envelope.budget) ? envelope.budget : {}
  const minutes = typeof budget.milliseconds === "number" ? Math.round(budget.milliseconds / 60_000) : undefined
  const digest = typeof plan.executionDigest === "string" ? plan.executionDigest.slice(0, 12) : ""
  return [
    `${String(plan.flowId)} · ${schedule} UTC`,
    capabilities.join(", "),
    [typeof budget.tokens === "number" ? `${budget.tokens} tokens` : undefined, minutes === undefined ? undefined : `${minutes} min`]
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

export const createTriggersSeam = (ctx: SeamContext, runtime: TriggersRuntime): TriggersSeam => {
  /** The attempts this session has in flight, by requestId: a second press joins one rather than starting another. */
  const attempts = new Map<string, Promise<unknown>>()

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
    /* Listening means a box answered or a schedule is registered — never that the registrations route answered with nothing. */
    const live: LiveList = {
      live: box.live || registered.triggers.length > 0,
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
  const prepared = (request: TriggerWrite, repo: string, requestId: string, planId: string, planDigest: string): string =>
    JSON.stringify({
      requestId,
      repo,
      flow: request.flow,
      slug: request.slug,
      schedule: request.schedule,
      ...(request.input === undefined || request.input.trim() === "" ? {} : { input: request.input }),
      planId,
      planDigest
    })

  /**
   * The workspace's own flow list, or the reason a registration cannot be
   * made from here. A workspace with no registrar is answered in one sentence
   * before anything is planned and before any approval is asked for, so no
   * person approves a plan this app cannot go on to register.
   */
  const registrarFlows = async (
    repo: string
  ): Promise<ReadonlyArray<Record<string, unknown>> | { readonly error: string }> => {
    const listed = await relay(ctx, repo, "List", { _tag: "flows" })
    if (!listed.ok) return { error: listed.message }
    const items = (Array.isArray(listed.value.items) ? listed.value.items : []).filter(isRecord)
    return items.some((item) => item.flowId === REGISTRAR_FLOW) ? items : { error: registerUnavailableSentence(repo) }
  }

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
    const items = await registrarFlows(repo)
    if ("error" in items) return items.error
    const target = items.find((item) => item.flowId === request.flow)
    if (target === undefined) {
      const names = items.map((item) => String(item.flowId)).join(", ")
      return `No flow "${request.flow}" is registered on this workspace. The workspace has: ${names}.`
    }
    const refusal = schemaRefusal(target.inputSchema, input)
    if (refusal !== undefined) return refusal
    const requestId = crypto.randomUUID()
    const planned = await relay(ctx, repo, "Plan", {
      flowId: request.flow,
      input,
      idempotencyKey: `trigger:${requestId}:plan`
    })
    if (!planned.ok) return planned.message
    const planId = typeof planned.value.planId === "string" ? planned.value.planId : undefined
    const planDigest = typeof planned.value.digest === "string" ? planned.value.digest : undefined
    if (planId === undefined || planDigest === undefined) return "The workspace planned the flow but didn't name the plan."
    ctx.dispatch({
      type: "message.appended",
      actor: "system",
      text: previewOf(planned.value, schedule),
      action: { flow: "triggers.approve", args: prepared(request, repo, requestId, planId, planDigest), label: "Approve and register" }
    })
    return { value: `Prepared ${slug}. It registers when the user approves the plan.` }
  }

  /**
   * The durable card of one registration attempt. It is the registrar run's
   * own card, so the watch, the reconnect after a reload and the trace are
   * the ones every launched flow run already gets.
   *
   * The card records the box the registrar run was started on, because that
   * binding is what the run watch relays with (state/controller/workflow-pump.ts).
   * A card with none binds the poll to the repository's own gateway, which
   * holds no run of this registration and may hold an unrelated `run-1` of
   * its own: run ids are one counter per control plane.
   */
  const runCardOf = (requestId: string, repo: string, slug: string, patch: RunCardPatch): Card => {
    const existing = ctx.store.collections.cards.get(registrationCardId(requestId))
    const workspaceId = (existing?.kind === "run-trace" ? existing.payload.workspaceId : undefined) ?? jobWorkspace(ctx, repo)
    return {
      id: registrationCardId(requestId),
      kind: "run-trace",
      title: `Register ${slug} · ${repo}`,
      status: patch.phase === "failed" ? "error" : "active",
      createdAt: existing?.createdAt ?? Date.now(),
      ordinal: existing?.ordinal ?? ctx.nextOrdinal(),
      payload: {
        repo, gatewayBindingVersion: 1, ...(workspaceId === undefined ? {} : { workspaceId }),
        workflow: REGISTRAR_FLOW, steps: [], result: null, lastSeq: 0, ...patch
      }
    }
  }

  const putRunCard = (requestId: string, repo: string, slug: string, patch: RunCardPatch): Promise<unknown> =>
    ctx.dispatch({ type: "card.upsert", actor: ctx.actor(), card: runCardOf(requestId, repo, slug, patch) }).isPersisted.promise

  /**
   * Everything the approval sets off: the six relayed calls, then the
   * registrar run itself.
   *
   * Every refusal on the way is the refusing party's own sentence, and it
   * lands on this attempt's card as well as on the notice, so a person who
   * looked away still finds what happened.
   */
  const runRegistration = async (
    request: TriggerWrite,
    repo: string,
    slug: string,
    requestId: string,
    planId: string,
    planDigest: string,
    input: unknown
  ): Promise<string | { readonly value: string }> => {
    const refuse = async (message: string): Promise<string> => {
      await putRunCard(requestId, repo, slug, { runId: unlaunchedRunId(requestId), phase: "failed", error: message })
      return message
    }
    const items = await registrarFlows(repo)
    if ("error" in items) return refuse(items.error)
    const planned = await relay(ctx, repo, "Plan", {
      flowId: request.flow,
      input,
      idempotencyKey: `trigger:${requestId}:plan`
    })
    if (!planned.ok) return refuse(planned.message)
    if (planned.value.planId !== planId || planned.value.digest !== planDigest) {
      return refuse("The plan changed since you saw it. Prepare the registration again.")
    }
    const envelope = planned.value.envelope
    const approved = await relay(ctx, repo, "Approval.Submit", {
      target: { _tag: "Plan", planId, digest: planDigest, envelope },
      scope: "run",
      idempotencyKey: `approve:${planId}`,
      decision: "approve"
    })
    if (!approved.ok) return refuse(approved.message)
    const receipt = await workerCall(ctx, TRIGGER_APPROVAL_PATH, { repo, slug, flowId: request.flow, planId, planDigest, envelope })
    if (!receipt.ok) return refuse(receipt.message)
    const registrar = await relay(ctx, repo, "Plan", {
      flowId: REGISTRAR_FLOW,
      input: {
        requestId,
        operation: "register",
        repo,
        slug,
        flow: request.flow,
        schedule: request.schedule,
        input,
        approvedPlanId: planId,
        approvedPlanDigest: planDigest
      },
      idempotencyKey: `trigger:${requestId}:register-plan`
    })
    if (!registrar.ok) return refuse(registrar.message)
    const registrarPlan = typeof registrar.value.planId === "string" ? registrar.value.planId : undefined
    const registrarDigest = typeof registrar.value.digest === "string" ? registrar.value.digest : undefined
    if (registrarPlan === undefined || registrarDigest === undefined) {
      return refuse("The workspace planned the registration but didn't name the plan.")
    }
    const granted = await relay(ctx, repo, "Approval.Submit", {
      target: { _tag: "Plan", planId: registrarPlan, digest: registrarDigest, envelope: registrar.value.envelope },
      scope: "run",
      idempotencyKey: `approve:${registrarPlan}`,
      decision: "approve"
    })
    if (!granted.ok) return refuse(granted.message)
    const started = await relay(ctx, repo, "Run", {
      _tag: "Plan",
      planId: registrarPlan,
      digest: registrarDigest,
      envelope: registrar.value.envelope,
      idempotencyKey: `trigger:${requestId}:register-run`
    })
    if (!started.ok) return refuse(started.message)
    const runId = typeof started.value.runId === "string" ? started.value.runId : undefined
    if (runId === undefined) return refuse("The registration started but the workspace didn't name the run.")
    await putRunCard(requestId, repo, slug, { runId, phase: "running" })
    return watchRegistration(requestId, repo, slug)
  }

  /**
   * The refusing party's own sentence for a failed run, read from the run's
   * journal rather than from the gateway's verdict.
   *
   * The verdict is a one-line summary: it puts the failure's machine code in
   * front of the sentence and clips the pair to a hundred characters, so the
   * longer registrar refusals lose the instruction they end with. The journal
   * carries what the run actually recorded — `<code>: <sentence>` and then the
   * rendered cause — so the sentence behind the code is the whole of what the
   * person has to act on.
   */
  const refusalOfRun = (scope: RuntimeScope): string | undefined => {
    const events = ctx.store.committedRuntimeRun(runtimeRunKey(scope))?.events ?? []
    const failed = events.filter((event) => event.kind === "control.run.failed").at(-1)
    const payload = failed === undefined || !isRecord(failed.payload) ? undefined : failed.payload
    if (typeof payload?.cause !== "string") return undefined
    const line = payload.cause.split(/[\r\n]/, 1)[0] ?? ""
    return line.replace(JOURNALLED_CODE, "")
  }

  /**
   * The registrar run's own verdict, read from the evidence the run watch
   * committed. A refusal is the host's sentence, unrewritten; a completed
   * registration is re-read from Smithers Cloud so the dispatcher states the
   * schedule that now exists.
   */
  const watchRegistration = async (
    requestId: string,
    repo: string,
    slug: string
  ): Promise<string | { readonly value: string }> => {
    const cardId = registrationCardId(requestId)
    await runtime.watchRun(cardId)
    /* The run this attempt reached is the one on its card, in the box the card names, not the one this call was handed. */
    const held = ctx.store.collections.cards.get(cardId)
    const scope = held?.kind === "run-trace" ? held.payload : undefined
    const summary = scope === undefined ? undefined : ctx.store.committedRuntimeRun(runtimeRunKey(scope))?.summary
    if (summary?.status === "completed") {
      await listTriggers(repo)
      return { value: `${slug} runs on ${repo}.` }
    }
    if (scope !== undefined && (summary?.status === "failed" || summary?.status === "cancelled")) {
      return refusalOfRun(scope) ?? summary.verdict
    }
    return `The registration of ${slug} on ${repo} is no longer being watched.`
  }

  /**
   * The human's approval, and only theirs (triggers.approve is userOnly).
   *
   * The approval is answered at once; the workspace calls and the registrar
   * run happen behind one notice that settles from the run rather than from
   * its launch. Pressing again while the attempt is in flight, or while its
   * run is still being watched, joins what is already running: one plan, one
   * receipt, one run.
   *
   * The card appears when the attempt has something durable to say — the run
   * the workspace named, or the refusal that stopped it. A card naming a run
   * nobody started is what stranded the attempt across a reload: the app's own
   * resume watched a run the workspace had never heard of.
   */
  const approveTrigger = async (request: TriggerWrite, repo: string): Promise<string | void | { readonly value: string }> => {
    const slug = request.slug ?? ""
    const requestId = request.requestId
    const planId = request.planId
    const planDigest = request.planDigest
    if (!SLUG.test(slug) || requestId === undefined || request.flow === undefined || planId === undefined || planDigest === undefined) {
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
    const held = ctx.store.collections.cards.get(registrationCardId(requestId))
    const watching = held?.kind === "run-trace" && !SETTLED_PHASES.has(held.payload.phase) &&
      held.payload.runId !== unlaunchedRunId(requestId)
    if (!attempts.has(requestId) && !watching) {
      const attempt = runtime.withToast(
        `trigger.register.${repo}.${slug}`,
        `Registering ${slug} on ${repo}…`,
        `${slug} registered`,
        () => runRegistration(request, repo, slug, requestId, planId, planDigest, input)
      )
      attempts.set(requestId, attempt)
      void attempt.finally(() => {
        if (attempts.get(requestId) === attempt) attempts.delete(requestId)
      })
    }
    return { value: `Registering ${slug} on ${repo}.` }
  }

  /** Stop a schedule the human enabled, then re-read the listing so the card states it. */
  const pauseTrigger = async (request: TriggerWrite, repo: string): Promise<string | void | { readonly value: string }> => {
    const slug = request.slug ?? ""
    if (!SLUG.test(slug)) return "A schedule name is lower-case letters, digits and dashes, up to 64 characters."
    const paused = await workerCall(ctx, TRIGGER_PAUSE_PATH, { repo, slug })
    if (!paused.ok) return paused.message
    /* Smithers Cloud counts the registrations it stopped; a name it does not hold stops none, and that is not a pause. */
    if (typeof paused.value.paused === "number" && paused.value.paused < 1) {
      return `No schedule "${slug}" is registered on ${repo}.`
    }
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

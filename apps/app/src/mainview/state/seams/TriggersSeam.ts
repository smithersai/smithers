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
import { BudgetTokensSchema, SetupDraftSchema } from "@smthrs/rpc/RepositorySetup"
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

/** One manual dispatch's run card; every press is its own attempt, so every press is its own card. */
const dispatchCardId = (requestId: string): string => `trigger-run-${requestId}`

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

/**
 * How long one repository job may run, as the five reviewed jobs already bound
 * it (`SetupDraftSchema.budgetMinutes`, the same bound their card's control
 * carries). A schedule is a sixth job on the same box, and Smithers Cloud
 * refuses a registration past two hours, so the two bounds are the same one.
 */
const MINUTES = SetupDraftSchema.shape.budgetMinutes

/** What one unattended fire may spend, as the registrar bounds it (`deploymentTokens`, the same shared schema). */
const TOKENS = BudgetTokensSchema

/** The two limits an unattended fire is bounded by, named as the register door's grammar names them. */
export type LimitName = "tokens" | "minutes"

/** What each limit alone may be, in that grammar. A `Record` over the union, so neither can be forgotten. */
const LIMIT_RANGES: Readonly<Record<LimitName, string>> = {
  tokens: `--tokens ${TOKENS.minValue}..${TOKENS.maxValue}`,
  minutes: `--minutes ${MINUTES.minValue}..${MINUTES.maxValue}`
}

/** The whole of what a registration may name, in the grammar the register door takes. */
const LIMIT_RANGE = `${LIMIT_RANGES.tokens}, ${LIMIT_RANGES.minutes}`

/** The shape the two limits take: whole numbers inside that range. */
export const LIMIT_SHAPE = `Token and time limits are whole numbers: ${LIMIT_RANGE}.`

/**
 * What a registration naming one limit and not the other is missing: the
 * other one, and the range that one takes.
 *
 * An unattended fire is bounded by a PAIR — tokens and time — so half a pair
 * bounds nothing. Naming one is not a bad number, though, and `LIMIT_SHAPE`
 * said it was: `--tokens 150000` is inside the range that sentence quotes
 * (R102 B2).
 *
 * It is not a free choice between the pair and nothing either. This rule runs
 * before `limitsFor`, so its sentence is the FIRST one a person reads, and
 * `Name both limits, or neither` offered "neither" to a flow that declares no
 * limits of its own — `checks/fast`, the flow walk W1 registered — which
 * `limitsFor` then refuses with `unboundedFlowSentence` (R102b B1b). Only the
 * rule that has the flow in hand knows whether "neither" is open, so this one
 * states the missing half and nothing else.
 */
export const otherLimitSentence = (missing: LimitName): string =>
  `Name the other limit: ${LIMIT_RANGES[missing]}.`

/**
 * A flow whose own declaration cannot bound one unattended fire, and the
 * numbers that can.
 *
 * Unattended work is registered with the envelope it will run under. Smithers
 * Cloud refuses one with no finite token/time limits or past two hours
 * (`validateRepositoryJob`, "automatic work needs the reviewed envelope and
 * finite token/time limits") and the host's registrar refuses one past the
 * deployment's ceiling, on the registration run, after an approval row exists.
 * Saying it here, with the range, is the difference between a person reading
 * what to type and reading that something Smithers depends on refused them.
 */
export const unboundedFlowSentence = (flow: string): string =>
  `Set token and time limits: "${flow}" declares none. ${LIMIT_RANGE}.`

/** A flow whose own ceiling is past what one unattended fire may spend. */
export const overBoundFlowSentence = (flow: string): string =>
  `Set token and time limits: "${flow}" declares more than ${LIMIT_RANGE}.`

/** What the trigger write door was asked to do. */
export interface TriggerWrite {
  /**
   * `register` prepares: it validates, plans the target flow, and offers the
   * human's approve button. `approve` is the human's alone. `run` fires a
   * registered schedule once, now. `pause` stops a schedule they enabled.
   */
  readonly operation: "register" | "approve" | "run" | "pause"
  readonly repo?: string
  readonly flow?: string
  readonly slug?: string
  readonly schedule?: string
  /**
   * What every unattended fire of this schedule may spend, as the register
   * form holds it (text) and as the approve button carries it back (numbers).
   * Left out, the ceiling the scheduled flow declares for itself is used.
   */
  readonly tokens?: string | number
  readonly minutes?: string | number
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
  /** The trigger write door: register, approve, run, pause (triggers.register / .approve / .run / .pause). */
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
    slug: value.slug,
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

/** The value a declared property asks for, by the type its document declares. */
const exampleValue = (property: unknown): string => {
  const type = isRecord(property) && typeof property.type === "string" ? property.type : undefined
  return type === "number" || type === "integer" ? "0"
    : type === "boolean" ? "false"
    : type === "array" ? "[]"
    : type === "object" ? "{}"
    : '"…"'
}

/** `{"args": "…"}` — the input the flow's published document says it takes. */
const inputExample = (schema: Record<string, unknown>): string | undefined => {
  const properties = isRecord(schema.properties) ? schema.properties : {}
  const required = Array.isArray(schema.required) ? schema.required.filter((name): name is string => typeof name === "string") : []
  const names = required.length > 0 ? required : Object.keys(properties)
  return names.length === 0 ? undefined : `{${names.map((name) => `"${name}": ${exampleValue(properties[name])}`).join(", ")}}`
}

/** `args`, `args and label`, `args, label and window` — the names in one clause. */
const nameList = (names: ReadonlyArray<string>): string =>
  names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`

/**
 * What the target flow's own declared input schema says about the registered
 * input, as a sentence the person can act on.
 *
 * The decoder's own refusal is a JSON pointer, not a sentence — the canary
 * walk read `Missing key at ["args"]` off the register card and out of the
 * transcript (.artifacts/mvp-canary-walk-20260917/W1-e-triggers-register.json).
 * Nothing here parses that message: the refusal is written from the flow's
 * PUBLISHED document, which already names every input it requires and the type
 * of each, so the person is told which input to give and what to put in it.
 */
const schemaRefusal = (document: unknown, input: unknown, flow: string): string | undefined => {
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
  } catch {
    const schema = isRecord((document as Record<string, unknown>).schema) ? (document as Record<string, unknown>).schema as Record<string, unknown> : {}
    const example = inputExample(schema)
    /* A flow that declares no property still says what it takes, in the same words: `{}` is "nothing". */
    if (example === undefined) return `Input for "${flow}" takes ${exampleValue(schema)}.`
    const required = Array.isArray(schema.required) ? schema.required.filter((name): name is string => typeof name === "string") : []
    const missing = isRecord(input) ? required.filter((name) => !(name in input)) : required
    return missing.length > 0
      ? `Input for "${flow}" needs ${nameList(missing)}: ${example}.`
      : `Input for "${flow}" takes ${example}.`
  }
}

/** What every unattended fire of one schedule may spend, in the envelope's own units. */
interface TriggerLimits {
  readonly tokens: number
  readonly milliseconds: number
}

/**
 * Why the limits as typed cannot bound an unattended fire: a number is outside
 * the range the register door takes, or only one of the pair was named. The
 * two are different facts about what the person did, so they are told apart
 * here rather than by comparing sentences (R102 B2).
 */
type LimitsProblem =
  | { readonly problem: "out-of-range"; readonly error: string }
  | { readonly problem: "half-named"; readonly error: string }

/**
 * The limits the person typed, before anything is asked of the workspace:
 * nothing, two whole positive numbers, or the one refusal their shape earns.
 *
 * A limit is held to its range only when it was actually named. `--tokens
 * 150000` alone used to be told its number was not a whole number in range,
 * which is false about 150000 — what it is missing is the other half.
 */
const namedLimits = (request: TriggerWrite): TriggerLimits | LimitsProblem | undefined => {
  const tokens = String(request.tokens ?? "").trim()
  const minutes = String(request.minutes ?? "").trim()
  if (tokens === "" && minutes === "") return undefined
  const count = Number(tokens)
  const span = Number(minutes)
  if (tokens !== "" && !TOKENS.safeParse(count).success) return { problem: "out-of-range", error: LIMIT_SHAPE }
  if (minutes !== "" && !MINUTES.safeParse(span).success) return { problem: "out-of-range", error: LIMIT_SHAPE }
  if (tokens === "") return { problem: "half-named", error: otherLimitSentence("tokens") }
  if (minutes === "") return { problem: "half-named", error: otherLimitSentence("minutes") }
  return { tokens: count, milliseconds: span * 60_000 }
}

/**
 * The refusal the two limits' own shape earns, for a door that holds them
 * before the seam is asked for anything.
 *
 * The register form's own submit reaches `namedLimits` above and is refused
 * with zero network calls; a slash line naming the same number reached the
 * field and nothing else, because the line was short of the flow, name and
 * schedule the flow also needs and so never ran (walk W1). Both doors read
 * the one rule here, so neither restates the sentence.
 *
 * Only an out-of-range number is stated at the door. Half a pair is what the
 * open form is there to collect, so the card asks for it with its empty field
 * instead of contradicting the number the person just typed; the missing half
 * is refused at submit, where it is the whole of what is wrong.
 */
export const limitsRefusal = (named: Readonly<Record<string, unknown>>): string | undefined => {
  const limits = namedLimits({ operation: "register", ...named } as TriggerWrite)
  return limits !== undefined && "problem" in limits && limits.problem === "out-of-range" ? limits.error : undefined
}

/** The ceiling the scheduled flow declares for itself (`Descriptor.budgetOf` answers the undeclared case with an empty budget). */
const declaredLimits = (envelope: Record<string, unknown>): TriggerLimits | undefined => {
  const budget = isRecord(envelope.budget) ? envelope.budget : {}
  const tokens = budget.tokens
  const milliseconds = budget.milliseconds
  return typeof tokens === "number" && tokens > 0 && typeof milliseconds === "number" && milliseconds > 0
    ? { tokens, milliseconds }
    : undefined
}

/**
 * The limits this registration will carry: the person's, else the flow's own,
 * held to the one bound either way.
 *
 * Only the person's own numbers were held to it, while `Descriptor.BudgetCeiling`
 * bounds a declaration from above at nothing: a flow declaring four hours was
 * previewed, approved, and refused by Smithers Cloud, so the person read their
 * own registration coming back as something that was not their doing.
 */
const limitsFor = (
  named: TriggerLimits | undefined,
  envelope: Record<string, unknown>,
  flow: string
): TriggerLimits | { readonly error: string } => {
  const limits = named ?? declaredLimits(envelope)
  if (limits === undefined) return { error: unboundedFlowSentence(flow) }
  const bounded = TOKENS.safeParse(limits.tokens).success && limits.milliseconds <= MINUTES.maxValue! * 60_000
  return bounded ? limits : { error: overBoundFlowSentence(flow) }
}

/** The envelope the registration carries: the plan's, bounded by the limits the person approved. */
const reviewedEnvelope = (envelope: unknown, limits: TriggerLimits): Record<string, unknown> =>
  ({ ...(isRecord(envelope) ? envelope : {}), budget: { tokens: limits.tokens, milliseconds: limits.milliseconds } })

/**
 * A value the transcript's markdown must not read as syntax.
 *
 * The preview is appended as a message and rendered as Markdown
 * (TranscriptMessage.tsx), so `0 9 * * 1-5` came out as `0 9 1-5` and a `*`
 * capability as a bullet: the person approved a schedule they had not typed
 * (walk run 3, D3-N3). That renderer knows one code span — a single backtick
 * around at least one non-backtick byte (ui/primitives/markdown.tsx `INLINE`)
 * — so each backtick-free run is spanned and the backticks between them are
 * left bare, where no span can close on them and the renderer draws them.
 */
export const verbatim = (value: string): string =>
  value.split("`").map((run) => run === "" ? "" : `\`${run}\``).join("`")

/**
 * The plan preview: the facts the workspace stated about what a fire would
 * run, and the limits every one of those fires may spend.
 */
const previewOf = (plan: Record<string, unknown>, schedule: string, limits: TriggerLimits): string => {
  const envelope = isRecord(plan.envelope) ? plan.envelope : {}
  const capabilities = Array.isArray(envelope.capabilities) ? envelope.capabilities.filter((value): value is string => typeof value === "string") : []
  const digest = typeof plan.executionDigest === "string" ? plan.executionDigest.slice(0, 12) : ""
  return [
    `${String(plan.flowId)} · ${verbatim(schedule)} UTC`,
    capabilities.map(verbatim).join(", "),
    `${limits.tokens} tokens · ${Math.round(limits.milliseconds / 60_000)} min`,
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

  /**
   * The prepared registration the approve button carries, as one JSON object.
   *
   * It carries only what the person gave, never the limits derived from the
   * plan: the approve door plans the flow again anyway, so deriving them once
   * more there keeps one rule in one place and cannot round a declared ceiling
   * on the way through the button.
   */
  const prepared = (
    request: TriggerWrite,
    repo: string,
    requestId: string,
    planId: string,
    planDigest: string,
    named: TriggerLimits | undefined
  ): string =>
    JSON.stringify({
      requestId,
      repo,
      flow: request.flow,
      slug: request.slug,
      schedule: request.schedule,
      ...(request.input === undefined || request.input.trim() === "" ? {} : { input: request.input }),
      ...(named === undefined ? {} : { tokens: named.tokens, minutes: named.milliseconds / 60_000 }),
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
    const named = namedLimits(request)
    if (named !== undefined && "error" in named) return named.error
    const items = await registrarFlows(repo)
    if ("error" in items) return items.error
    const target = items.find((item) => item.flowId === request.flow)
    if (target === undefined) {
      const names = items.map((item) => String(item.flowId)).join(", ")
      return `No flow "${request.flow}" is registered on this workspace. The workspace has: ${names}.`
    }
    const refusal = schemaRefusal(target.inputSchema, input, String(request.flow))
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
    const limits = limitsFor(named, isRecord(planned.value.envelope) ? planned.value.envelope : {}, String(request.flow))
    if ("error" in limits) return limits.error
    ctx.dispatch({
      type: "message.appended",
      actor: "system",
      text: previewOf(planned.value, schedule, limits),
      action: { flow: "triggers.approve", args: prepared(request, repo, requestId, planId, planDigest, named), label: "Approve and register" }
    })
    return { value: `Prepared ${slug}. It registers when the user approves the plan.` }
  }

  /**
   * The durable card of one attempt, registration or dispatch. It is the
   * registrar run's own card, so the watch, the reconnect after a reload and
   * the trace are the ones every launched flow run already gets.
   *
   * The card records the box the registrar run was started on, because that
   * binding is what the run watch relays with (state/controller/workflow-pump.ts).
   * A card with none binds the poll to the repository's own gateway, which
   * holds no run of this attempt and may hold an unrelated `run-1` of
   * its own: run ids are one counter per control plane.
   */
  const runCardOf = (cardId: string, title: string, repo: string, patch: RunCardPatch): Card => {
    const existing = ctx.store.collections.cards.get(cardId)
    const workspaceId = (existing?.kind === "run-trace" ? existing.payload.workspaceId : undefined) ?? jobWorkspace(ctx, repo)
    return {
      id: cardId,
      kind: "run-trace",
      title,
      status: patch.phase === "failed" ? "error" : "active",
      createdAt: existing?.createdAt ?? Date.now(),
      ordinal: existing?.ordinal ?? ctx.nextOrdinal(),
      payload: {
        repo, gatewayBindingVersion: 1, ...(workspaceId === undefined ? {} : { workspaceId }),
        workflow: REGISTRAR_FLOW, steps: [], result: null, lastSeq: 0, ...patch
      }
    }
  }

  const putRunCard = (cardId: string, title: string, repo: string, patch: RunCardPatch): Promise<unknown> =>
    ctx.dispatch({ type: "card.upsert", actor: ctx.actor(), card: runCardOf(cardId, title, repo, patch) }).isPersisted.promise

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
    const cardId = registrationCardId(requestId)
    const title = `Register ${slug} · ${repo}`
    const refuse = async (message: string): Promise<string> => {
      await putRunCard(cardId, title, repo, { runId: unlaunchedRunId(requestId), phase: "failed", error: message })
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
    /*
     * The other door into this attempt is a carried payload, which may name no
     * limits at all. Unattended work is registered with the envelope it runs
     * under and Smithers Cloud refuses one with no finite pair, so the app
     * stops here — before the plan is approved and before a receipt is asked
     * for an envelope that would be refused.
     */
    const named = namedLimits(request)
    if (named !== undefined && "error" in named) return refuse(named.error)
    const limits = limitsFor(named, isRecord(envelope) ? envelope : {}, String(request.flow))
    if ("error" in limits) return refuse(limits.error)
    const approved = await relay(ctx, repo, "Approval.Submit", {
      target: { _tag: "Plan", planId, digest: planDigest, envelope },
      scope: "run",
      idempotencyKey: `approve:${planId}`,
      decision: "approve"
    })
    if (!approved.ok) return refuse(approved.message)
    /* The receipt states the envelope the registration will carry, which is the plan's bounded by those limits. */
    const receipt = await workerCall(ctx, TRIGGER_APPROVAL_PATH, {
      repo, slug, flowId: request.flow, planId, planDigest, envelope: reviewedEnvelope(envelope, limits)
    })
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
        budget: { tokens: limits.tokens, milliseconds: limits.milliseconds },
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
    await putRunCard(cardId, title, repo, { runId, phase: "running" })
    return watchAttempt(cardId, repo, `${slug} runs on ${repo}.`, `The registration of ${slug} on ${repo} is no longer being watched.`)
  }

  /**
   * Fire a schedule that is already registered, once, now (triggers.run).
   *
   * The registrar's own `fire` operation is the dispatch: it reads the
   * registration's revision and digest and asks Smithers Cloud to enqueue one
   * manual run of exactly that registration (flows/repository/triggers.ts
   * `Fire`). Each press mints its own request id, and the registrar derives
   * the dispatch key from the run it is executing, so two presses enqueue two
   * dispatches rather than returning the first one twice.
   */
  const dispatchTrigger = async (
    repo: string,
    slug: string,
    flow: string,
    schedule: string,
    requestId: string
  ): Promise<string | { readonly value: string }> => {
    const cardId = dispatchCardId(requestId)
    const title = `Run ${slug} · ${repo}`
    const refuse = async (message: string): Promise<string> => {
      await putRunCard(cardId, title, repo, { runId: unlaunchedRunId(requestId), phase: "failed", error: message })
      return message
    }
    /*
     * No flow listing first: nothing here is previewed and nothing is
     * approved, so there is no plan a person could approve that this app
     * could not go on to fire — the reason the register door lists. A box
     * without the registrar refuses the plan in its own words instead.
     */
    const planned = await relay(ctx, repo, "Plan", {
      flowId: REGISTRAR_FLOW,
      input: { requestId, operation: "fire", repo, slug, flow, schedule, input: {} },
      idempotencyKey: `trigger:${requestId}:fire-plan`
    })
    if (!planned.ok) return refuse(planned.message)
    const planId = typeof planned.value.planId === "string" ? planned.value.planId : undefined
    const planDigest = typeof planned.value.digest === "string" ? planned.value.digest : undefined
    if (planId === undefined || planDigest === undefined) return refuse("The workspace planned the dispatch but didn't name the plan.")
    const granted = await relay(ctx, repo, "Approval.Submit", {
      target: { _tag: "Plan", planId, digest: planDigest, envelope: planned.value.envelope },
      scope: "run",
      idempotencyKey: `approve:${planId}`,
      decision: "approve"
    })
    if (!granted.ok) return refuse(granted.message)
    const started = await relay(ctx, repo, "Run", {
      _tag: "Plan",
      planId,
      digest: planDigest,
      envelope: planned.value.envelope,
      idempotencyKey: `trigger:${requestId}:fire-run`
    })
    if (!started.ok) return refuse(started.message)
    const runId = typeof started.value.runId === "string" ? started.value.runId : undefined
    if (runId === undefined) return refuse("The dispatch started but the workspace didn't name the run.")
    await putRunCard(cardId, title, repo, { runId, phase: "running" })
    return watchAttempt(cardId, repo, `${slug} was dispatched on ${repo}.`, `The dispatch of ${slug} on ${repo} is no longer being watched.`)
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
   * A registrar run's own verdict, read from the evidence the run watch
   * committed. A refusal is the host's sentence, unrewritten; a completed run
   * re-reads the listing from Smithers Cloud so the dispatcher states what the
   * repository now holds.
   */
  const watchAttempt = async (
    cardId: string,
    repo: string,
    settled: string,
    unwatched: string
  ): Promise<string | { readonly value: string }> => {
    await runtime.watchRun(cardId)
    /* The run this attempt reached is the one on its card, in the box the card names, not the one this call was handed. */
    const held = ctx.store.collections.cards.get(cardId)
    const scope = held?.kind === "run-trace" ? held.payload : undefined
    const summary = scope === undefined ? undefined : ctx.store.committedRuntimeRun(runtimeRunKey(scope))?.summary
    if (summary?.status === "completed") {
      await listTriggers(repo)
      return { value: settled }
    }
    if (scope !== undefined && (summary?.status === "failed" || summary?.status === "cancelled")) {
      return refusalOfRun(scope) ?? summary.verdict
    }
    return unwatched
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

  /**
   * The Run now door: one dispatch of a schedule this repository already
   * holds, answered at once while the registrar run carries it (AGENTS.md,
   * instant chat).
   *
   * The registration is read first so a name nothing holds is refused here,
   * in the same words the pause door refuses one, instead of spending a plan
   * and a run to learn it from the host.
   */
  const runTrigger = async (request: TriggerWrite, repo: string): Promise<string | void | { readonly value: string }> => {
    const slug = request.slug ?? ""
    if (!SLUG.test(slug)) return "A schedule name is lower-case letters, digits and dashes, up to 64 characters."
    const registered = await readTriggerRegistrations(ctx, repo)
    const row = registered.triggers.find((trigger) => trigger.slug === slug)
    if (row === undefined) return `No schedule "${slug}" is registered on ${repo}.`
    const requestId = crypto.randomUUID()
    void runtime.withToast(
      `trigger.run.${repo}.${slug}`,
      `Running ${slug} on ${repo}…`,
      `${slug} dispatched`,
      () => dispatchTrigger(repo, slug, row.flowId, row.cron, requestId)
    )
    return { value: `Running ${slug} on ${repo}.` }
  }

  /*
   * A refused pause, said where it stays. The returned string reaches the
   * caller as the command-failure toast, which states itself and dismisses
   * after four seconds; a consequential door the human pressed needs an
   * answer that is still there when they look back, so the sentence is
   * appended to the transcript as well.
   */
  const refusePause = (message: string): string => {
    ctx.dispatch({ type: "message.appended", actor: "system", text: message, spoken: true })
    return message
  }

  /** Stop a schedule the human enabled, then re-read the listing so the card states it. */
  const pauseTrigger = async (request: TriggerWrite, repo: string): Promise<string | void | { readonly value: string }> => {
    const slug = request.slug ?? ""
    if (!SLUG.test(slug)) return "A schedule name is lower-case letters, digits and dashes, up to 64 characters."
    const paused = await workerCall(ctx, TRIGGER_PAUSE_PATH, { repo, slug })
    if (!paused.ok) return refusePause(paused.message)
    /* Smithers Cloud counts the registrations it stopped; a name it does not hold stops none, and that is not a pause. */
    if (typeof paused.value.paused === "number" && paused.value.paused < 1) {
      return refusePause(`No schedule "${slug}" is registered on ${repo}.`)
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
    if (request.operation === "run") return runTrigger(request, target.repo)
    if (request.operation === "pause") return pauseTrigger(request, target.repo)
    return prepareTrigger(request, target.repo)
  }

  return { listTriggers, registerTrigger }
}

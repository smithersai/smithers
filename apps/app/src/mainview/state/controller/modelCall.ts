/*
 * The composer: one `model-call` card per configured model, where a person
 * edits a REQUEST and the model generates the RESPONSE (Will: "I would expect
 * to be editing the request and then generating a response"). A decision
 * request is one JSON state authored as typed fields plus a map of typed
 * questions; a generation request is a prompt and a few parameters. Every
 * edit is a flow that rewrites the card, so the draft survives a reload and
 * the agent composes through the same doors. Ask snapshots the request, the
 * binding, the account and an identity onto the card before it dispatches;
 * from then on the draft is only a draft, and a reload resumes the snapshot.
 * The answer is kept with the request and the binding it answered, so an
 * edit after it is visibly stale and a rebound model keeps none of it (the
 * projection drops it with the record's last Test). Ask is requested at once
 * and runs under the shared toast stack, like a Test.
 *
 * The limits are the question classes' own (`@smthrs/model` Evaluator), stated
 * once in the contract (`modelCallProblemOf`): a request with a problem is
 * refused here before it leaves, and the card disables Ask on the same rule.
 */
import type { ModelCallDraft, ModelCallOutput, ModelCallPending, ModelCallProblem, ModelFieldKind, ModelQuestion, ModelQuestionType, ModelStateField } from "@smthrs/rpc/ConfiguredModel"
import { MODEL_CALL_NAME_MAX, MODEL_CALL_STATE_MAX_BYTES, MODEL_CALL_TEMPERATURE_TEXT_MAX, MODEL_CALL_TEXT_MAX, MODEL_FIELD_KEY, MODEL_NAME_RESERVED, MODEL_QUESTION_TYPES, ModelCallDraftSchema, ModelFieldKindSchema, bindingOf, modelCallDefault, modelCallInputOf, modelCallProblemOf, modelKindOf, modelStateOf } from "@smthrs/rpc/ConfiguredModel"
import { accountOwnerOf } from "../AccountOwner"
import type { CommandResult } from "../../flows/entries/Declare"
import { actorSharedState } from "../ActorBindings"
import type { Card, StoredModel } from "../AppState"
import { canonicalEventValue } from "../EventValue"
import type { ControllerContext } from "./context"
import { TOAST_SUPERSEDED } from "./failures"
import { MODELS_CARD_ID, callModelTest, modelFailureLine } from "./models"

type ModelCallCard = Extract<Card, { kind: "model-call" }>
type Payload = ModelCallCard["payload"]
type Decision = Extract<ModelCallDraft, { kind: "decision" }>
type Generation = Extract<ModelCallDraft, { kind: "generation" }>

/** The one composer card of a model. */
export const modelCallCardId = (id: string): string => `model-call-${id}`

/** `model.prompt`'s input: the fields to set. The temperature is text, as a form field is; blank clears it. */
export interface PromptInput {
  readonly id: string
  readonly system?: string | undefined
  readonly prompt?: string | undefined
  readonly maxTokens?: number | undefined
  readonly temperature?: string | undefined
}
/** `model.state`'s input: a field by key, or a new field named by the controller when `key` is absent; `was` renames the field that held that key; `remove` drops it. */
export interface FieldInput {
  readonly id: string
  readonly key?: string | undefined
  readonly kind?: string | undefined
  readonly value?: string | undefined
  readonly was?: string | undefined
  readonly remove?: boolean | undefined
}
/** `model.question`'s input: with no `question` a new one is added and its id answered; `was` renames the question that held that id; a kind change converts the criteria; `remove` drops it. */
export interface QuestionInput {
  readonly id: string
  readonly question?: string | undefined
  readonly type?: string | undefined
  readonly instructions?: string | undefined
  readonly criteria?: unknown
  readonly was?: string | undefined
  readonly remove?: boolean | undefined
}
/** `model.option`'s input: an option of a choice, or a rung of a score, or a new one named by the controller when `option` is absent; `was` renames one in place; `remove` drops it. */
export interface OptionInput {
  readonly id: string
  readonly question: string
  readonly option?: string | undefined
  readonly about?: string | undefined
  readonly was?: string | undefined
  readonly remove?: boolean | undefined
}

export interface ModelCallController {
  /** `model.compose <name>`: the composer, prefilled from the model's last recorded Test when it is new. */
  readonly composeModel: (id: string) => Promise<CommandResult>
  /** `model.ask <name>`: requested at once; the call, its toast and its answer are background work. */
  readonly askModel: (id: string) => Promise<CommandResult>
  /** `model.recall <name>`: the request and answer of the last recorded Test. */
  readonly recallModel: (id: string) => Promise<CommandResult>
  readonly setModelPrompt: (input: PromptInput) => Promise<CommandResult>
  readonly setModelField: (input: FieldInput) => Promise<CommandResult>
  /** `model.question`: adding answers the new question's id. */
  readonly setModelQuestion: (input: QuestionInput) => Promise<CommandResult>
  readonly setModelOption: (input: OptionInput) => Promise<CommandResult>
  /** `model.fixture <name>`: the last decision answer as an `Evaluator.layerScripted` fixture, on the card and answered. */
  readonly fixtureModel: (id: string) => Promise<CommandResult>
  /** After identity loads: launch every ask a card still holds as out. Idempotent. */
  readonly resumeModelCalls: () => void
}

export interface ModelCallControllerDependencies {
  readonly nextOrdinal: () => number
  /** The frames controller's: it also moves the address bar back to the root frame. */
  readonly minimizeCard: () => void
}

/** A problem as the card and a refusal state it: the code and its names and numbers. No sentence. */
export const modelCallProblemLine = (problem: ModelCallProblem): string => {
  switch (problem.code) {
    case "no_questions":
    case "prompt_empty": return problem.code
    case "question_empty":
    case "rungs_distinct": return `${problem.code} · ${problem.question}`
    case "name_reserved": return `${problem.code} · ${problem.question} · ${problem.name}`
    case "options_count":
    case "rungs_count": return `${problem.code} · ${problem.question} · ${problem.count}`
    case "field_invalid": return `${problem.code} · ${problem.key} · ${problem.kind}`
    case "field_duplicate": return `${problem.code} · ${problem.key}`
    case "state_size": return `${problem.code} · ${(problem.bytes / 1024).toFixed(1)} KiB / ${problem.max / 1024} KiB`
    case "max_tokens": return `${problem.code} · 1–${problem.max}`
    case "temperature": return `${problem.code} · 0–${problem.max}`
  }
}

/** A key as fixture source: computed, so an id no bare key could spell is still one, and none is ever read as the object's prototype. */
const scriptedKey = (name: string): string => `[${JSON.stringify(name)}]`
const scriptedDistribution = (entries: ReadonlyArray<readonly [string, number]>): string =>
  `{ ${entries.map(([name, p]) => `${scriptedKey(name)}: ${p}`).join(", ")} }`

/**
 * The answer's raw shape, as `Evaluator.layerScripted` scripts it: the
 * probability, the choice and its distribution, the score and its
 * distribution. A score's is keyed by rung index, from the rungs the recorded
 * request ordered: a rung may itself be named like an index, and the
 * classifier reads index keys first. Without it the replay would be one-hot,
 * and sure where the recording was not.
 */
const scriptedAnswer = (answer: Extract<ModelCallOutput, { kind: "decision" }>["answers"][string], question: ModelQuestion | undefined): string => {
  switch (answer.type) {
    case "boolean": return `{ probability: ${answer.probability} }`
    case "choice": return `{ choice: ${JSON.stringify(answer.value)}, probabilities: ${scriptedDistribution(Object.entries(answer.probabilities))} }`
    case "score": {
      const rungs = question?.type === "score" ? question.criteria : []
      const recorded = rungs.every((rung) => Object.hasOwn(answer.probabilities, rung))
      return recorded && rungs.length > 0
        ? `{ score: ${answer.value}, probabilities: ${scriptedDistribution(rungs.map((rung, index) => [String(index), answer.probabilities[rung]!]))} }`
        : `{ score: ${answer.value} }`
    }
  }
}

/**
 * Question ids and option names in the one order they are drawn and written:
 * a record's key order does not survive the store, so it is never relied on.
 */
export const byName = (left: string, right: string): number => left.localeCompare(right, "en", { numeric: true })

/** A decision request and its answer as the fixture every test in the repo scripts an evaluator with. */
export const scriptedFixtureOf = (id: string, request: ModelCallDraft, output: ModelCallOutput): string => {
  if (request.kind !== "decision" || output.kind !== "decision") return ""
  // JSON leaves U+2028 and U+2029 bare, and either one ends a line comment.
  const state = JSON.stringify(modelStateOf(request.state)).replace(/[\u2028\u2029]/g, (separator) => `\\u${separator.charCodeAt(0).toString(16)}`)
  const ids = Object.keys(output.answers).sort(byName)
  return [
    `// ${id} · state ${state}`,
    "Evaluator.layerScripted(() => ({",
    ...ids.map((question, index) => `  ${scriptedKey(question)}: ${scriptedAnswer(output.answers[question]!, Object.hasOwn(request.questions, question) ? request.questions[question] : undefined)}${index === ids.length - 1 ? "" : ","}`),
    "}))"
  ].join("\n")
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)

/** A value of `kind`, kept when it already is one and replaced with that kind's blank when it is not. */
const valueAs = (kind: ModelFieldKind, value: string): string => {
  switch (kind) {
    case "boolean": return value === "true" || value === "false" ? value : "false"
    case "number": return value.trim() !== "" && Number.isFinite(Number(value)) ? value : ""
    case "json": {
      try { JSON.parse(value); return value } catch { return JSON.stringify(value) }
    }
    default: return value
  }
}

/** The criteria a question of `type` keeps from `from`: option names become rungs, rungs become options, a boolean keeps none. */
const convertedCriteria = (from: ModelQuestion, type: ModelQuestionType): ModelQuestion["criteria"] => {
  const names = from.type === "choice" ? Object.keys(from.criteria) : from.type === "score" ? from.criteria : []
  switch (type) {
    case "boolean": return undefined
    case "choice": return Object.fromEntries(names.map((name) => [name, from.type === "choice" ? from.criteria[name] ?? "" : ""]))
    case "score": return [...names]
  }
}

/** `criteria` as the shape `type` takes, or undefined when it is not one. */
const criteriaAs = (type: ModelQuestionType, criteria: unknown): ModelQuestion["criteria"] | undefined => {
  switch (type) {
    case "boolean":
      return isRecord(criteria) && typeof criteria.true === "string" && typeof criteria.false === "string" ? { true: criteria.true, false: criteria.false } : undefined
    case "choice":
      return isRecord(criteria) && Object.values(criteria).every((about) => typeof about === "string") ? criteria as Record<string, string> : undefined
    case "score":
      return Array.isArray(criteria) && criteria.every((rung) => typeof rung === "string") ? criteria as Array<string> : undefined
  }
}

/** A question of `type` over criteria already of that type's shape (`criteriaAs`, `convertedCriteria`). */
const questionOf = (type: ModelQuestionType, instructions: string, criteria: ModelQuestion["criteria"]): ModelQuestion => {
  switch (type) {
    case "boolean": return { type, instructions, ...(isRecord(criteria) && typeof criteria.true === "string" && typeof criteria.false === "string" ? { criteria: { true: criteria.true, false: criteria.false } } : {}) }
    case "choice": return { type, instructions, criteria: isRecord(criteria) ? criteria as Record<string, string> : {} }
    case "score": return { type, instructions, criteria: Array.isArray(criteria) ? criteria : [] }
  }
}

const isQuestionType = (value: string): value is ModelQuestionType => (MODEL_QUESTION_TYPES as ReadonlyArray<string>).includes(value)

/** The next free name in a numbered series: what a new field, option or rung starts life under, so two quick adds never collide. */
const nextName = (stem: string, taken: ReadonlyArray<string>): string => {
  for (let n = 1;; n += 1) if (!taken.includes(`${stem}${n}`)) return `${stem}${n}`
}

/** The response the last recorded Test is: the fixed request of the model's kind, answered by what the row recorded. A rebind clears the row's Test, so the one it holds is its binding's. */
const recalled = (record: StoredModel): Payload["response"] =>
  record.lastTest === undefined ? undefined : { askedAt: record.lastTest.testedAt, request: modelCallDefault(modelKindOf(record.protocol)), binding: bindingOf(record), result: record.lastTest.result }

/** Two snapshots that say the same thing, whatever order their keys were written in. */
const same = (left: unknown, right: unknown): boolean => canonicalEventValue(left) === canonicalEventValue(right)

const kib = (max: number): string => `${max / 1024} KiB`

/**
 * The limit an edit crossed, named as the wire states it: the control and its
 * number, no sentence. The wire (`ModelCallDraftSchema`) is the one statement
 * of these bounds; this reads its first issue back as the control it is about.
 */
const limitLine = (request: ModelCallDraft, issue: { readonly code: string; readonly path: ReadonlyArray<PropertyKey> }): string => {
  const [head, id, part, name] = issue.path
  switch (head) {
    case "system":
    case "prompt": return `invalid · ${head} · ${kib(MODEL_CALL_TEXT_MAX)}`
    case "maxTokens": return "invalid · maxTokens · integer"
    case "temperature": return `invalid · temperature · ${MODEL_CALL_TEMPERATURE_TEXT_MAX}`
    case "state": return part === "key" ? "invalid · key" : `invalid · value · ${kib(MODEL_CALL_STATE_MAX_BYTES * 4)}`
    case "questions": {
      if (part === undefined) return "invalid · question"
      if (part === "instructions") return `invalid · question · ${kib(MODEL_CALL_TEXT_MAX)}`
      const question = request.kind === "decision" && typeof id === "string" && Object.hasOwn(request.questions, id) ? request.questions[id] : undefined
      // A record cannot hold the reserved name, so the wire refuses an option so named; a rung is an array entry, kept and named as the request's problem.
      if (question?.type === "choice" && typeof id === "string" && Object.hasOwn(question.criteria, MODEL_NAME_RESERVED)) return modelCallProblemLine({ code: "name_reserved", question: id, name: MODEL_NAME_RESERVED })
      // A criteria issue is the name of an option or rung, a boolean's two texts, or a choice's description.
      if (question?.type === "boolean") return `invalid · criteria · ${kib(MODEL_CALL_TEXT_MAX)}`
      if (question?.type === "score" || typeof name === "number" || issue.code === "invalid_key") return `invalid · option · ${MODEL_CALL_NAME_MAX}`
      return `invalid · about · ${kib(MODEL_CALL_TEXT_MAX)}`
    }
    default: return "invalid · request"
  }
}

/** An ask in flight in this session, by the identity its card holds; only the one the card still names may write. */
interface Flight { readonly requestId: string; readonly epoch: number }

export const createModelCallController = (ctx: ControllerContext, deps: ModelCallControllerDependencies): ModelCallController => {
  const { store } = ctx
  const { collections } = store
  // The user's and the agent's bindings share the asks in flight: a press joins the ask the agent launched.
  const shared = actorSharedState(ctx, "model-call", (): { flights: Map<string, Flight> } => ({ flights: new Map() }))

  const card = (id: string): ModelCallCard | undefined => {
    const row = collections.cards.get(modelCallCardId(id))
    return row?.kind === "model-call" ? row : undefined
  }
  const missing = (id: string): string => `There is no model ${id}.`
  /** Whose ask it is: the login, or null for a visitor and for a session not identified yet. */
  const owner = (): string | null => accountOwnerOf(collections.identitySessions.get("identity")) ?? null

  /** The card written, at the tail when it is new or someone asked for it, in place otherwise. */
  const write = (id: string, payload: Payload, toTail: boolean, actor: "user" | "smithers" | "system" = ctx.commandActor): Promise<unknown> => {
    const existing = card(id)
    return store.dispatch({
      type: "card.upsert",
      actor,
      card: {
        id: modelCallCardId(id),
        kind: "model-call",
        title: id,
        status: "active",
        createdAt: existing?.createdAt ?? Date.now(),
        ordinal: existing === undefined || toTail ? deps.nextOrdinal() : existing.ordinal,
        payload
      }
    }).isPersisted.promise
  }

  /** The record and its composer's payload as it stands: new cards, and cards of a model whose kind changed, start from the fixed Test. */
  const open = (id: string): { readonly record: StoredModel; readonly payload: Payload; readonly fresh: boolean } | string => {
    const record = collections.models.get(id)
    if (record === undefined) return missing(id)
    const kind = modelKindOf(record.protocol)
    const existing = card(id)?.payload
    if (existing !== undefined && existing.request.kind === kind) {
      // Whatever way the card came to hold them, an answer and an ask of another binding are not this record's: no door acts on either.
      const { response, pending, fixture, ...rest } = existing
      const answered = response?.binding !== undefined && same(response.binding, bindingOf(record))
      const out = pending !== undefined && same(pending.binding, bindingOf(record))
      return { record, fresh: false, payload: { ...rest, ...(answered ? { response, ...(fixture === undefined ? {} : { fixture }) } : {}), ...(out ? { pending } : {}) } }
    }
    const response = recalled(record)
    return { record, payload: { model: id, request: modelCallDefault(kind), ...(response === undefined ? {} : { response }) }, fresh: true }
  }

  /** One edit: the request rewritten, the fixture dropped with it, the card kept where it is. A rewrite the wire would refuse is refused here, by name, and nothing is written. */
  const edit = async (id: string, change: (request: ModelCallDraft) => ModelCallDraft | string): Promise<CommandResult> => {
    const opened = open(id)
    if (typeof opened === "string") return opened
    const request = change(opened.payload.request)
    if (typeof request === "string") return request
    const parsed = ModelCallDraftSchema.safeParse(request)
    if (!parsed.success) return limitLine(request, parsed.error.issues[0] ?? { code: "custom", path: [] })
    const { fixture: _fixture, ...rest } = opened.payload
    await write(id, { ...rest, request }, opened.fresh)
  }
  const decisionEdit = (id: string, change: (request: Decision) => Decision | string): Promise<CommandResult> =>
    edit(id, (request) => request.kind === "decision" ? change(request) : `${id} takes a prompt.`)
  const generationEdit = (id: string, change: (request: Generation) => Generation | string): Promise<CommandResult> =>
    edit(id, (request) => request.kind === "generation" ? change(request) : `${id} takes a state and questions.`)

  const composeModel: ModelCallController["composeModel"] = async (id) => {
    const opened = open(id)
    if (typeof opened === "string") return opened
    await write(id, opened.payload, true)
    // The composer is a card in the transcript; the pane would cover it. Presentation is the user's, so an agent's compose waits behind it.
    if (ctx.commandActor !== "smithers" && store.session().maximizedCardId === MODELS_CARD_ID) deps.minimizeCard()
  }

  /** Recall rewrites the draft like any edit: an ask still out stays out, and its answer lands stale against the recalled request. */
  const recallModel: ModelCallController["recallModel"] = async (id) => {
    const opened = open(id)
    if (typeof opened === "string") return opened
    const response = recalled(opened.record)
    if (response === undefined) return `${id} has no test yet.`
    const { fixture: _fixture, ...rest } = opened.payload
    await write(id, { ...rest, request: response.request, response }, false)
  }

  /** The background half, over the snapshot alone: the draft is never read here. Never awaited by the command that asked for it. */
  const launch = (record: StoredModel, pending: ModelCallPending): void => {
    const { id } = record
    const input = modelCallInputOf(pending.request)
    if (input === undefined) return
    const flight: Flight = { requestId: pending.requestId, epoch: ctx.accountEpoch }
    shared.flights.set(id, flight)
    const key = `model.ask:${id}`
    void ctx.withToast(key, `Asking ${id}…`, `Asked ${id}`, async () => {
      const result = await callModelTest(ctx, { id, ...pending.binding, ...(record.builtin === true ? { builtin: true } : {}) }, input)
      // A newer ask owns the card now; this answer is about a request that is gone.
      if (shared.flights.get(id) !== flight) return TOAST_SUPERSEDED
      shared.flights.delete(id)
      if (ctx.disposed) return TOAST_SUPERSEDED
      const current = card(id)
      // The card no longer names this ask: the model was rebound or removed while it was out, and that took the ask with it.
      if (current?.payload.pending?.requestId !== pending.requestId) return TOAST_SUPERSEDED
      const { pending: _pending, fixture: _fixture, ...rest } = current.payload
      const bound = collections.models.get(id)
      // Neither a departed account's answer nor a replaced binding's is evidence here: the ask is over, and nothing is written from it.
      if (ctx.accountEpoch !== flight.epoch || owner() !== pending.owner || bound === undefined || !same(bindingOf(bound), pending.binding)) {
        await write(id, rest, false, "system")
        return TOAST_SUPERSEDED
      }
      await write(id, { ...rest, response: { askedAt: Date.now(), request: pending.request, binding: pending.binding, result } }, false, "system")
      return result.ok ? true : modelFailureLine(result.failure)
    }).then((outcome) => {
      if (typeof outcome !== "string" || ctx.disposed || shared.flights.has(id)) return
      ctx.resolveToast(key, { status: "failed", detail: outcome, action: { flow: "model.ask", args: id, label: "Ask" } })
    })
  }

  const askModel: ModelCallController["askModel"] = async (id) => {
    const opened = open(id)
    if (typeof opened === "string") return opened
    const problem = modelCallProblemOf(opened.payload.request)
    if (problem !== undefined) return modelCallProblemLine(problem)
    const { record } = opened
    const out = opened.payload.pending
    const flight = shared.flights.get(id)
    const asked = { request: opened.payload.request, binding: bindingOf(record), owner: owner() }
    // Duplicate input joins the ask already out; an edited request, or another account's ask, is a different ask.
    const joins = out !== undefined && flight?.requestId === out.requestId && flight.epoch === ctx.accountEpoch &&
      same({ request: out.request, binding: out.binding, owner: out.owner }, asked)
    if (!joins) {
      const pending: ModelCallPending = { requestId: crypto.randomUUID(), ...asked }
      const { asking: _asking, ...rest } = opened.payload
      // The snapshot is on the card, and so on its way to disk, before the request leaves; the answer is written behind it.
      const written = write(id, { ...rest, pending }, opened.fresh)
      launch(record, pending)
      await written
    }
    return { value: "Requested" }
  }

  const setModelPrompt: ModelCallController["setModelPrompt"] = (input) =>
    generationEdit(input.id, (request) => {
      const { temperature: _temperature, ...rest } = request
      // The text as typed, whatever it says: the card shows it and names what is wrong with it (`modelCallProblemOf`). Blank clears it.
      const typed = input.temperature?.trim()
      const temperature = typed === undefined ? request.temperature : typed === "" ? undefined : typed
      return {
        ...rest,
        ...(input.system === undefined ? {} : { system: input.system }),
        ...(input.prompt === undefined ? {} : { prompt: input.prompt }),
        ...(input.maxTokens === undefined ? {} : { maxTokens: input.maxTokens }),
        ...(temperature === undefined ? {} : { temperature })
      }
    })

  const setModelField: ModelCallController["setModelField"] = (input) =>
    decisionEdit(input.id, (request) => {
      if (input.remove === true) return { ...request, state: request.state.filter((field) => field.key !== input.key) }
      const key = input.key?.trim() ?? nextName("field", request.state.map((field) => field.key))
      if (!MODEL_FIELD_KEY.test(key)) return "invalid · key"
      const kind = input.kind === undefined ? undefined : ModelFieldKindSchema.safeParse(input.kind)
      if (kind !== undefined && !kind.success) return "invalid · kind"
      const at = request.state.findIndex((field) => field.key === (input.was ?? key))
      if (request.state.some((field, index) => field.key === key && index !== at)) return modelCallProblemLine({ code: "field_duplicate", key })
      const before: ModelStateField = request.state[at] ?? { key, kind: "text", value: "" }
      const next: ModelStateField = { key, kind: kind?.data ?? before.kind, value: input.value ?? before.value }
      // A retyped field keeps a value of the new kind and takes that kind's blank when its value is not one.
      const field: ModelStateField = { ...next, value: kind !== undefined && kind.data !== before.kind && input.value === undefined ? valueAs(next.kind, next.value) : next.value }
      return { ...request, state: at < 0 ? [...request.state, field] : request.state.map((row, index) => index === at ? field : row) }
    })

  const setModelQuestion: ModelCallController["setModelQuestion"] = async (input) => {
    let added = ""
    const result = await decisionEdit(input.id, (request) => {
      if (input.type !== undefined && !isQuestionType(input.type)) return "invalid · type"
      if (input.question === undefined) {
        // A new question: the next free id, of the kind asked for, with nothing said yet.
        for (let n = 1;; n += 1) if (!(`q${n}` in request.questions)) { added = `q${n}`; break }
        const type = input.type ?? "boolean"
        const given = input.criteria === undefined ? undefined : criteriaAs(type, input.criteria)
        if (input.criteria !== undefined && given === undefined) return "invalid · criteria"
        return { ...request, questions: { ...request.questions, [added]: questionOf(type, input.instructions ?? "", given ?? convertedCriteria({ type: "boolean", instructions: "" }, type)) } }
      }
      // The id is the person's or the agent's: only an own key is a question, never a member of Object.prototype.
      const from = input.was ?? input.question
      const before = Object.hasOwn(request.questions, from) ? request.questions[from] : undefined
      if (before === undefined) return `There is no question ${from}.`
      if (input.remove === true) {
        const { [from]: _gone, ...questions } = request.questions
        return { ...request, questions }
      }
      const question = input.question.trim()
      // A rename takes a key the wire admits and no other question holds; the entry keeps its place under the new id, and the answer keeps the id it answered.
      if (question !== from && (!MODEL_FIELD_KEY.test(question) || Object.hasOwn(request.questions, question))) return "invalid · question"
      const type = input.type ?? before.type
      const given = input.criteria === undefined ? undefined : criteriaAs(type, input.criteria)
      if (input.criteria !== undefined && given === undefined) return "invalid · criteria"
      const criteria = given ?? (type === before.type ? before.criteria : convertedCriteria(before, type))
      const edited = questionOf(type, input.instructions ?? before.instructions, criteria)
      return { ...request, questions: Object.fromEntries(Object.entries(request.questions).map(([key, shape]) => key === from ? [question, edited] : [key, shape])) }
    })
    return result ?? (added === "" ? undefined : { value: added })
  }

  const setModelOption: ModelCallController["setModelOption"] = (input) =>
    decisionEdit(input.id, (request) => {
      const before = Object.hasOwn(request.questions, input.question) ? request.questions[input.question] : undefined
      if (before === undefined) return `There is no question ${input.question}.`
      if (before.type === "boolean") return `${input.question} has no options.`
      if (input.remove === true) {
        const question: ModelQuestion = before.type === "choice"
          ? { ...before, criteria: Object.fromEntries(Object.entries(before.criteria).filter(([name]) => name !== input.option)) }
          : { ...before, criteria: before.criteria.filter((name) => name !== input.option) }
        return { ...request, questions: { ...request.questions, [input.question]: question } }
      }
      const names = before.type === "choice" ? Object.keys(before.criteria) : before.criteria
      const option = input.option?.trim() ?? nextName(before.type === "choice" ? "option" : "rung", names)
      const was = input.was ?? option
      // A choice option set again takes its new description; a rung has nothing to update, so setting it again is a duplicate.
      if (option === "" || names.some((name) => name === option && name !== was) || (before.type === "score" && input.was === undefined && names.includes(option))) return "invalid · option"
      const placed = names.includes(was) ? names.map((name) => name === was ? option : name) : [...names, option]
      const question: ModelQuestion = before.type === "choice"
        ? { ...before, criteria: Object.fromEntries(placed.map((name) => [name, name === option ? input.about ?? before.criteria[was] ?? "" : before.criteria[name] ?? ""])) }
        : { ...before, criteria: placed }
      return { ...request, questions: { ...request.questions, [input.question]: question } }
    })

  const fixtureModel: ModelCallController["fixtureModel"] = async (id) => {
    const opened = open(id)
    if (typeof opened === "string") return opened
    const { response } = opened.payload
    if (response === undefined || !response.result.ok || response.result.output?.kind !== "decision") return `${id} has no decision answer yet.`
    const fixture = scriptedFixtureOf(id, response.request, response.result.output)
    await write(id, { ...opened.payload, fixture }, opened.fresh)
    return { value: fixture }
  }

  const resumeModelCalls: ModelCallController["resumeModelCalls"] = () => {
    for (const row of [...collections.cards.values()]) {
      if (row.kind !== "model-call" || (row.payload.pending === undefined && row.payload.asking === undefined)) continue
      const { pending, asking: _asking, ...rest } = row.payload
      const record = collections.models.get(row.payload.model)
      // An ask is idempotent, so the snapshot is launched again rather than forgotten. One that is not this account's ask of this binding leaves the card, as does a flag that names no request.
      if (pending === undefined || record === undefined || pending.owner !== owner() || !same(bindingOf(record), pending.binding) || modelCallInputOf(pending.request) === undefined) {
        void write(row.payload.model, rest, false, "system")
        continue
      }
      const flight = shared.flights.get(record.id)
      if (flight?.requestId !== pending.requestId || flight.epoch !== ctx.accountEpoch) launch(record, pending)
    }
  }

  return { composeModel, askModel, recallModel, setModelPrompt, setModelField, setModelQuestion, setModelOption, fixtureModel, resumeModelCalls }
}

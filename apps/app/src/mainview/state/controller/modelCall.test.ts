import * as Classifier from "@smthrs/model/Classifier"
import * as Evaluator from "@smthrs/model/Evaluator"
import { MODEL_TEST_PATH } from "@smthrs/rpc/AgentApiRoutes"
import type { ConfiguredModel, ModelCallDraft, ModelCallInput, ModelCallOutput, ModelCatalog, ModelTestResult } from "@smthrs/rpc/ConfiguredModel"
import { MODEL_CALL_NAME_MAX, MODEL_CALL_STATE_MAX_BYTES, MODEL_CALL_TEXT_MAX, MODEL_TEST_DECISION, MODEL_TEST_MAX_TOKENS, MODEL_TEST_PROMPT, bindingOf, modelCallDefault, modelStateOf } from "@smthrs/rpc/ConfiguredModel"
import type { StorageApi } from "@tanstack/db"
import { afterEach, expect, test } from "bun:test"
import { Effect, type Layer, Schema } from "effect"
import type { Card } from "../AppState"
import { createAppStore } from "../AppStore"
import { memoryStorage } from "../TestFixtures"
import type { ControllerContext } from "./context"
import { createFailureController } from "./failures"
import { createModelCallController, modelCallCardId, modelCallProblemLine, scriptedFixtureOf } from "./modelCall"
import { MODELS_CARD_ID, createModelsController } from "./models"

/*
 * The composer: one card per configured model, whose request is edited
 * through flows and whose answer is what the host said to exactly that
 * request. Every limit the question classes enforce is refused here before
 * a request leaves, an edit after an answer is visibly stale, and asking is
 * requested at once and settled in the background.
 */
const judge: ConfiguredModel = { id: "judge", protocol: "evaluation", modelId: "typesafe-ai/jev", credential: "AI_GATEWAY_API_KEY" }
const writer: ConfiguredModel = { id: "writer", protocol: "openai-chat", baseUrl: "https://openrouter.ai", modelId: "moonshotai/kimi-k3", credential: "OPENROUTER_API_KEY" }
const catalog: ModelCatalog = { models: [], seats: ["explainer"], credentials: [] }
const yes: ModelTestResult = { ok: true, latencyMs: 12, sample: "true 0.97", output: { kind: "decision", answers: { ok: { type: "boolean", value: true, probability: 0.97 } } } }
const answered: ModelTestResult = {
  ok: true, latencyMs: 20, sample: "true 0.97",
  output: { kind: "decision", answers: {
    ok: { type: "boolean", value: true, probability: 0.97 },
    which: { type: "choice", value: "a", probabilities: { a: 0.97, b: 0 }, confidence: 0.97 },
    risk: { type: "score", value: 2, label: "high", probabilities: { low: 0, mid: 0, high: 1 }, confidence: 1 }
  } }
}
const pong: ModelTestResult = { ok: true, latencyMs: 9, sample: "pong", output: { kind: "generation", text: "pong" } }
const refused: ModelTestResult = { ok: false, latencyMs: 9, failure: { code: "refused", status: 429 }, fault: "wait" }

type Answer = (url: string, init: RequestInit | undefined) => Promise<Response>
const opened: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of opened.splice(0)) await close() })

async function setup(answer: Answer, storage: StorageApi = memoryStorage()) {
  const store = await createAppStore({ kind: "localStorage", storage })
  const calls: Array<{ path: string; body: unknown }> = []
  let disposed = false
  const ctx = { store, commandActor: "user", baseUrl: "", accountEpoch: 0, services: {}, onDispose: () => {}, get disposed() { return disposed },
    boundedFetch: async (url: string, init?: RequestInit) => {
      calls.push({ path: url, body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) })
      return answer(url, init)
    } } as unknown as ControllerContext
  Object.assign(ctx, { toastRuns: new Map(), toastDebounceMs: 0, toastAutoDismissMs: 10_000, unref: () => {} })
  const failures = createFailureController(ctx)
  const background: Promise<unknown>[] = []
  ctx.withToast = ((...args: Parameters<typeof failures.withToast>) => {
    const work = failures.withToast(...args)
    background.push(work)
    return work
  }) as typeof ctx.withToast
  ctx.resolveToast = failures.resolveToast
  let minimized = 0
  const minimizeCard = () => { minimized += 1 }
  const models = createModelsController(ctx, { nextOrdinal: store.nextOrdinal, minimizeCard, renderFlowForm: () => undefined })
  const calls_ = createModelCallController(ctx, { nextOrdinal: store.nextOrdinal, minimizeCard })
  opened.push(async () => { disposed = true; await store.settled?.(); await store.dispose?.() })
  const card = (id = "judge"): Extract<Card, { kind: "model-call" }> | undefined => {
    const row = store.collections.cards.get(modelCallCardId(id))
    return row?.kind === "model-call" ? row : undefined
  }
  const toast = (id: string) => store.collections.toasts.get(`toast-model.ask:${id}`)
  const settled = () => Promise.all(background)
  return { store, ctx, calls, composer: calls_, models, card, toast, settled, minimized: () => minimized, asks: () => calls.filter((call) => call.path === MODEL_TEST_PATH) }
}
const save = (t: Awaited<ReturnType<typeof setup>>, model: ConfiguredModel) =>
  t.store.dispatch({ type: "model.saved", actor: "user", model }).isPersisted.promise
const tested = (t: Awaited<ReturnType<typeof setup>>, id: string, result: ModelTestResult) =>
  t.store.dispatch({ type: "model.tested", actor: "system", test: { id, testedAt: 5, result } }).isPersisted.promise
const tick = (ms = 15) => new Promise((resolve) => setTimeout(resolve, ms))
/** A host whose test route answers only when the test says so. */
const held = () => {
  const releases: Array<(response: Response) => void> = []
  const answer: Answer = (url) => url === MODEL_TEST_PATH ? new Promise<Response>((resolve) => { releases.push(resolve) }) : Promise.resolve(Response.json(catalog))
  return { answer, releases }
}

test("compose opens the model's composer prefilled from the fixed Test and its last recorded answer", async () => {
  const t = await setup(held().answer)
  await save(t, judge)
  await save(t, writer)
  await tested(t, "judge", yes)
  expect(await t.composer.composeModel("judge")).toBeUndefined()
  const composed = t.card()!
  expect(composed.payload).toEqual({ model: "judge", request: modelCallDefault("decision"), response: { askedAt: 5, request: modelCallDefault("decision"), binding: bindingOf(judge), result: yes } })
  expect(composed.payload.request.kind === "decision" && composed.payload.request.state).toEqual([{ key: "text", kind: "text", value: MODEL_TEST_DECISION.state.text }])
  // A model never tested opens with the fixed request and nothing answered.
  await t.composer.composeModel("writer")
  expect(t.card("writer")?.payload).toEqual({ model: "writer", request: { kind: "generation", system: "", prompt: MODEL_TEST_PROMPT, maxTokens: MODEL_TEST_MAX_TOKENS } })
  expect(await t.composer.composeModel("absent")).toBeString()
  // Composing again brings the same card back; it is one card per model.
  await t.composer.composeModel("judge")
  expect([...t.store.collections.cards.values()].filter((row) => row.kind === "model-call")).toHaveLength(2)
})

test("compose from the maximized Models pane returns the card to the transcript, where the composer is", async () => {
  const t = await setup(held().answer)
  await save(t, judge)
  await t.models.listModels()
  await t.settled()
  await t.composer.composeModel("judge")
  expect(t.minimized()).toBe(0)
  await t.store.dispatch({ type: "card.maximized", actor: "user", id: MODELS_CARD_ID }).isPersisted.promise
  await t.composer.composeModel("judge")
  expect(t.minimized()).toBe(1)
  // A refusal opens nothing, so the pane stays; and presentation is the user's, so an agent's compose waits behind it.
  await t.composer.composeModel("absent")
  Object.assign(t.ctx, { commandActor: "smithers" })
  await t.composer.composeModel("judge")
  expect(t.minimized()).toBe(1)
})

test("a model saved again under another protocol opens a fresh composer of the new kind", async () => {
  const t = await setup(held().answer)
  await save(t, judge)
  await t.composer.composeModel("judge")
  await t.composer.setModelQuestion({ id: "judge" })
  await save(t, { ...judge, protocol: "openai-chat", modelId: "moonshotai/kimi-k3", baseUrl: "https://openrouter.ai", credential: "OPENROUTER_API_KEY" })
  await t.composer.composeModel("judge")
  // The reroute cleared lastTest, so nothing is recalled: the fixed generation request and no response.
  expect(t.card()?.payload).toEqual({ model: "judge", request: modelCallDefault("generation") })
  expect(await t.composer.setModelPrompt({ id: "judge", prompt: "hi" })).toBeUndefined()
})

test("ask is requested before the host answers, carries the composed request, and an edit after the answer is stale", async () => {
  const host = held()
  const t = await setup(host.answer)
  await save(t, judge)
  await t.composer.composeModel("judge")
  await t.composer.setModelQuestion({ id: "judge", type: "choice" })
  await t.composer.setModelOption({ id: "judge", question: "q1", option: "a", about: "the first" })
  await t.composer.setModelOption({ id: "judge", question: "q1", option: "b" })
  await t.composer.setModelQuestion({ id: "judge", question: "q1", instructions: "Which one?" })
  const result = await Promise.race([t.composer.askModel("judge"), tick(100).then(() => "blocked")])
  expect(result).toEqual({ value: "Requested" })
  // The ask on the card is the accepted request, the binding it goes to, who asked and its own identity.
  expect(t.card()?.payload.pending).toEqual({ requestId: expect.any(String), request: t.card()!.payload.request, binding: bindingOf(judge), owner: null })
  await tick()
  expect(t.toast("judge")?.status).toBe("running")
  await t.store.dispatch({ type: "composer.changed", actor: "user", draft: "still typing" }).isPersisted.promise
  expect(t.store.session().draft).toBe("still typing")
  const sent = t.card()!.payload.request
  expect(t.asks()).toEqual([{ path: MODEL_TEST_PATH, body: { model: judge, input: sent } }])
  expect(sent.kind === "decision" && sent.questions).toEqual({
    ok: { type: "boolean", instructions: MODEL_TEST_DECISION.questions.ok.instructions },
    q1: { type: "choice", instructions: "Which one?", criteria: { a: "the first", b: "" } }
  })
  // A second press while it is out joins the same call.
  expect(await t.composer.askModel("judge")).toEqual({ value: "Requested" })
  expect(t.asks()).toHaveLength(1)
  host.releases[0]!(Response.json(answered))
  await t.settled()
  expect(t.card()?.payload.pending).toBeUndefined()
  expect(t.card()?.payload).toMatchObject({ response: { request: sent, binding: bindingOf(judge), result: answered } })
  expect(t.toast("judge")?.status).toBe("ok")
  // The answer belongs to the request it answered: an edit leaves it standing, and stale.
  await t.composer.setModelQuestion({ id: "judge", question: "q1", instructions: "Which one now?" })
  expect(JSON.stringify(t.card()?.payload.response?.request)).not.toBe(JSON.stringify(t.card()?.payload.request))
  expect(t.card()?.payload.response?.result).toEqual(answered)
  await t.composer.askModel("judge")
  expect(t.asks()).toHaveLength(2)
  host.releases[1]!(Response.json(answered))
  await t.settled()
  expect(t.card()?.payload.response?.request).toEqual(t.card()?.payload.request)
})

test("an edited request asked while the first is out: the first answer writes nothing, the second lands", async () => {
  const host = held()
  const t = await setup(host.answer)
  await save(t, judge)
  await t.composer.composeModel("judge")
  await t.composer.askModel("judge")
  await tick()
  await t.composer.setModelQuestion({ id: "judge", question: "ok", instructions: "Still blue?" })
  await t.composer.askModel("judge")
  await tick()
  expect(t.asks()).toHaveLength(2)
  // The old request's answer is not evidence about the new one: the card stays asking, with nothing answered, and a reload in this window would still resume the ask.
  host.releases[0]!(Response.json(refused))
  await tick()
  expect(t.card()?.payload.pending?.request).toEqual(t.card()!.payload.request)
  expect(t.card()?.payload.response).toBeUndefined()
  host.releases[1]!(Response.json(yes))
  await t.settled()
  expect(t.card()?.payload.pending).toBeUndefined()
  expect(t.card()?.payload.response).toMatchObject({ request: t.card()!.payload.request, result: yes })
  expect(t.toast("judge")?.status).toBe("ok")
})

test("questions are added, retyped, given options and removed, and every class limit is refused before a request leaves", async () => {
  const t = await setup(held().answer)
  await save(t, judge)
  await t.composer.composeModel("judge")
  expect(await t.composer.setModelQuestion({ id: "judge" })).toEqual({ value: "q1" })
  expect(await t.composer.setModelQuestion({ id: "judge", type: "score" })).toEqual({ value: "q2" })
  const questions = () => { const request = t.card()!.payload.request; return request.kind === "decision" ? request.questions : {} }
  expect(questions()).toMatchObject({ q1: { type: "boolean", instructions: "" }, q2: { type: "score", instructions: "", criteria: [] } })
  expect(await t.composer.askModel("judge")).toBe("question_empty · q1")
  await t.composer.setModelQuestion({ id: "judge", question: "q1", instructions: "Really?", criteria: { true: "yes it is", false: "no" } })
  await t.composer.setModelQuestion({ id: "judge", question: "q2", instructions: "How much?" })
  expect(await t.composer.askModel("judge")).toBe("rungs_count · q2 · 0")
  await t.composer.setModelOption({ id: "judge", question: "q2", option: "low" })
  await t.composer.setModelOption({ id: "judge", question: "q2", option: "high" })
  expect(questions().q2).toEqual({ type: "score", instructions: "How much?", criteria: ["low", "high"] })
  expect(await t.composer.setModelOption({ id: "judge", question: "q2", option: "high" })).toBe("invalid · option")
  // A nameless add takes the next free name, so two adds in a row never collide.
  await t.composer.setModelOption({ id: "judge", question: "q2" })
  await t.composer.setModelOption({ id: "judge", question: "q2" })
  expect(questions().q2).toMatchObject({ criteria: ["low", "high", "rung1", "rung2"] })
  await t.composer.setModelOption({ id: "judge", question: "q2", option: "rung1", remove: true })
  await t.composer.setModelOption({ id: "judge", question: "q2", option: "rung2", remove: true })
  expect(await t.composer.setModelOption({ id: "judge", question: "q2", option: " " })).toBe("invalid · option")
  // A rename keeps the rung's place.
  await t.composer.setModelOption({ id: "judge", question: "q2", option: "none", was: "low" })
  expect(questions().q2).toMatchObject({ criteria: ["none", "high"] })
  // Changing the kind carries the names across: rungs become options, options become rungs.
  await t.composer.setModelQuestion({ id: "judge", question: "q2", type: "choice" })
  expect(questions().q2).toEqual({ type: "choice", instructions: "How much?", criteria: { none: "", high: "" } })
  await t.composer.setModelOption({ id: "judge", question: "q2", option: "high", about: "a lot" })
  await t.composer.setModelOption({ id: "judge", question: "q2", option: "none", remove: true })
  expect(await t.composer.askModel("judge")).toBe("options_count · q2 · 1")
  await t.composer.setModelQuestion({ id: "judge", question: "q2", type: "boolean" })
  expect(questions().q2).toEqual({ type: "boolean", instructions: "How much?" })
  expect(await t.composer.setModelOption({ id: "judge", question: "q2", option: "x" })).toBeString()
  expect(await t.composer.setModelQuestion({ id: "judge", question: "q9", instructions: "?" })).toBeString()
  expect(await t.composer.setModelQuestion({ id: "judge", question: "q2", type: "choice", criteria: ["not", "a", "map"] })).toBe("invalid · criteria")
  await t.composer.setModelQuestion({ id: "judge", question: "q2", remove: true })
  await t.composer.setModelQuestion({ id: "judge", question: "q1", remove: true })
  await t.composer.setModelQuestion({ id: "judge", question: "ok", remove: true })
  expect(await t.composer.askModel("judge")).toBe("no_questions")
  expect(t.asks()).toHaveLength(0)
  // A prompt is not a question: the generation composer refuses these acts.
  await save(t, writer)
  await t.composer.composeModel("writer")
  expect(await t.composer.setModelQuestion({ id: "writer" })).toBeString()
})

test("a question is renamed in place with its shape and its answer; an id that fails the key rule or collides is refused", async () => {
  const host = held()
  const t = await setup(host.answer)
  await save(t, judge)
  await t.composer.composeModel("judge")
  await t.composer.setModelQuestion({ id: "judge", type: "choice", instructions: "Which?" })
  await t.composer.setModelOption({ id: "judge", question: "q1", option: "a", about: "the first" })
  await t.composer.setModelOption({ id: "judge", question: "q1", option: "b" })
  await t.composer.askModel("judge")
  await tick()
  host.releases[0]!(Response.json(answered))
  await t.settled()
  const asked = t.card()!.payload.request
  const questions = () => { const request = t.card()!.payload.request; return request.kind === "decision" ? request.questions : {} }
  expect(await t.composer.setModelQuestion({ id: "judge", question: "risky", was: "q1" })).toBeUndefined()
  expect(questions()).toEqual({ ok: { type: "boolean", instructions: MODEL_TEST_DECISION.questions.ok.instructions }, risky: { type: "choice", instructions: "Which?", criteria: { a: "the first", b: "" } } })
  // The answer stands, stale: it answered a request that named the question q1.
  expect(t.card()?.payload.response).toMatchObject({ request: asked, result: answered })
  expect(await t.composer.setModelQuestion({ id: "judge", question: "ok", was: "risky" })).toBe("invalid · question")
  expect(await t.composer.setModelQuestion({ id: "judge", question: "1bad", was: "risky" })).toBe("invalid · question")
  expect(await t.composer.setModelQuestion({ id: "judge", question: "__proto__", was: "risky" })).toBe("invalid · question")
  expect(await t.composer.setModelQuestion({ id: "judge", question: "risky", was: "nope" })).toBe("There is no question nope.")
  // A rename and an edit in one act, and a rename to itself is the edit alone.
  await t.composer.setModelQuestion({ id: "judge", question: " sure ", was: "risky", instructions: "Which one?" })
  await t.composer.setModelQuestion({ id: "judge", question: "sure", was: "sure", type: "score" })
  expect(questions().sure).toEqual({ type: "score", instructions: "Which one?", criteria: ["a", "b"] })
  expect(Object.keys(questions()).sort()).toEqual(["ok", "sure"])
})

test("a question id that names an Object.prototype member is no question", async () => {
  const t = await setup(held().answer)
  await save(t, judge)
  await t.composer.composeModel("judge")
  for (const question of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
    expect(await t.composer.setModelOption({ id: "judge", question, option: "x" })).toBe(`There is no question ${question}.`)
    expect(await t.composer.setModelQuestion({ id: "judge", question, type: "choice" })).toBe(`There is no question ${question}.`)
    expect(await t.composer.setModelQuestion({ id: "judge", question, remove: true })).toBe(`There is no question ${question}.`)
  }
  expect(t.card()?.payload.request).toEqual(modelCallDefault("decision"))
})

test("the name an object takes as its prototype is no option and no rung: a rung so named is kept and named, an option is refused", async () => {
  const t = await setup(held().answer)
  await save(t, judge)
  await t.composer.composeModel("judge")
  await t.composer.setModelQuestion({ id: "judge", type: "score", instructions: "How much?" })
  await t.composer.setModelOption({ id: "judge", question: "q1", option: "__proto__" })
  await t.composer.setModelOption({ id: "judge", question: "q1", option: "other" })
  const questions = () => { const request = t.card()!.payload.request; return request.kind === "decision" ? request.questions : {} }
  // A rung is an array entry: the card holds what was typed and says why it cannot be asked.
  expect(questions().q1).toMatchObject({ criteria: ["__proto__", "other"] })
  expect(await t.composer.askModel("judge")).toBe("name_reserved · q1 · __proto__")
  // An option is a record key, which a record cannot hold: the edit is refused by the same name, from every door.
  expect(await t.composer.setModelQuestion({ id: "judge", question: "q1", type: "choice" })).toBe("name_reserved · q1 · __proto__")
  await t.composer.setModelOption({ id: "judge", question: "q1", option: "none", was: "__proto__" })
  await t.composer.setModelQuestion({ id: "judge", question: "q1", type: "choice" })
  expect(await t.composer.setModelOption({ id: "judge", question: "q1", option: "__proto__" })).toBe("name_reserved · q1 · __proto__")
  expect(await t.composer.setModelOption({ id: "judge", question: "q1", option: "__proto__", was: "none" })).toBe("name_reserved · q1 · __proto__")
  expect(await t.composer.setModelQuestion({ id: "judge", question: "q1", criteria: JSON.parse("{\"__proto__\":\"\",\"b\":\"\"}") })).toBe("name_reserved · q1 · __proto__")
  expect(questions().q1).toEqual({ type: "choice", instructions: "How much?", criteria: { none: "", other: "" } })
  expect(t.asks()).toHaveLength(0)
})

test("an edit past a limit the wire enforces is refused by its name and number, and the request stands", async () => {
  const t = await setup(held().answer)
  await save(t, judge)
  await save(t, writer)
  await t.composer.composeModel("judge")
  await t.composer.composeModel("writer")
  await t.composer.setModelQuestion({ id: "judge", type: "choice", instructions: "Which?" })
  await t.composer.setModelOption({ id: "judge", question: "q1", option: "a" })
  const before = { judge: t.card()!.payload.request, writer: t.card("writer")!.payload.request }
  const long = "x".repeat(MODEL_CALL_TEXT_MAX + 1)
  expect(await t.composer.setModelPrompt({ id: "writer", prompt: long })).toBe("invalid · prompt · 16 KiB")
  expect(await t.composer.setModelPrompt({ id: "writer", system: long })).toBe("invalid · system · 16 KiB")
  expect(await t.composer.setModelPrompt({ id: "writer", temperature: "9".repeat(33) })).toBe("invalid · temperature · 32")
  expect(await t.composer.setModelPrompt({ id: "writer", maxTokens: 1.5 })).toBe("invalid · maxTokens · integer")
  expect(await t.composer.setModelQuestion({ id: "judge", question: "q1", instructions: long })).toBe("invalid · question · 16 KiB")
  expect(await t.composer.setModelQuestion({ id: "judge", question: "ok", criteria: { true: long, false: "" } })).toBe("invalid · criteria · 16 KiB")
  expect(await t.composer.setModelOption({ id: "judge", question: "q1", option: "y".repeat(MODEL_CALL_NAME_MAX + 1) })).toBe("invalid · option · 128")
  expect(await t.composer.setModelOption({ id: "judge", question: "q1", option: "a", about: long })).toBe("invalid · about · 16 KiB")
  expect(await t.composer.setModelField({ id: "judge", key: "text", value: "v".repeat(MODEL_CALL_STATE_MAX_BYTES * 4 + 1) })).toBe("invalid · value · 128 KiB")
  expect(t.card()!.payload.request).toEqual(before.judge)
  expect(t.card("writer")!.payload.request).toEqual(before.writer)
  // The bound itself is fine.
  expect(await t.composer.setModelPrompt({ id: "writer", prompt: long.slice(1) })).toBeUndefined()
  expect(await t.composer.setModelOption({ id: "judge", question: "q1", option: "y".repeat(MODEL_CALL_NAME_MAX) })).toBeUndefined()
})

test("the state is fields: set, retyped, renamed and removed, and asked as one JSON object", async () => {
  const host = held()
  const t = await setup(host.answer)
  await save(t, judge)
  await t.composer.composeModel("judge")
  const state = () => { const request = t.card()!.payload.request; return request.kind === "decision" ? request.state : [] }
  await t.composer.setModelField({ id: "judge", key: "passed", kind: "boolean", value: "true" })
  await t.composer.setModelField({ id: "judge", key: "count", kind: "number", value: "3" })
  await t.composer.setModelField({ id: "judge", key: "diff", kind: "diff", value: "@@ -1 +1 @@" })
  await t.composer.setModelField({ id: "judge", key: "text", value: "The sky is red." })
  expect(state()).toEqual([
    { key: "text", kind: "text", value: "The sky is red." },
    { key: "passed", kind: "boolean", value: "true" },
    { key: "count", kind: "number", value: "3" },
    { key: "diff", kind: "diff", value: "@@ -1 +1 @@" }
  ])
  expect(await t.composer.setModelField({ id: "judge", key: "bad key", value: "" })).toBe("invalid · key")
  // A plain object takes __proto__ as its prototype, not a key: the model would never read the field.
  expect(await t.composer.setModelField({ id: "judge", key: "__proto__", kind: "json", value: "{\"polluted\":1}" })).toBe("invalid · key")
  await t.composer.setModelField({ id: "judge" })
  await t.composer.setModelField({ id: "judge" })
  expect(state().map((field) => field.key)).toEqual(["text", "passed", "count", "diff", "field1", "field2"])
  await t.composer.setModelField({ id: "judge", key: "field1", remove: true })
  await t.composer.setModelField({ id: "judge", key: "field2", remove: true })
  expect(await t.composer.setModelField({ id: "judge", key: "count", was: "diff" })).toBe("field_duplicate · count")
  // Retyping keeps a value of the new kind and replaces one that is not.
  await t.composer.setModelField({ id: "judge", key: "count", kind: "boolean" })
  await t.composer.setModelField({ id: "judge", key: "text", kind: "json" })
  await t.composer.setModelField({ id: "judge", key: "diff", kind: "number" })
  expect(state()).toMatchObject([{ key: "text", kind: "json", value: "\"The sky is red.\"" }, { key: "passed" }, { key: "count", kind: "boolean", value: "false" }, { key: "diff", kind: "number", value: "" }])
  expect(await t.composer.askModel("judge")).toBe("field_invalid · diff · number")
  await t.composer.setModelField({ id: "judge", key: "diff", remove: true })
  await t.composer.setModelField({ id: "judge", key: "sky", was: "text", kind: "text", value: "blue" })
  await t.composer.askModel("judge")
  const body = t.asks()[0]!.body as { input: ModelCallInput }
  expect(body.input.kind === "decision" && body.input.state).toEqual([
    { key: "sky", kind: "text", value: "blue" }, { key: "passed", kind: "boolean", value: "true" }, { key: "count", kind: "boolean", value: "false" }
  ])
  host.releases[0]!(Response.json(yes))
  await t.settled()
})

test("a prompt is edited field by field, and asked with its parameters", async () => {
  const host = held()
  const t = await setup(host.answer)
  await save(t, writer)
  await t.composer.composeModel("writer")
  await t.composer.setModelPrompt({ id: "writer", system: "Answer tersely." })
  await t.composer.setModelPrompt({ id: "writer", prompt: "ping?", maxTokens: 64, temperature: " 0.2 " })
  expect(t.card("writer")?.payload.request).toEqual({ kind: "generation", system: "Answer tersely.", prompt: "ping?", maxTokens: 64, temperature: "0.2" })
  await t.composer.setModelPrompt({ id: "writer", temperature: "" })
  expect(t.card("writer")?.payload.request).toEqual({ kind: "generation", system: "Answer tersely.", prompt: "ping?", maxTokens: 64 })
  await t.composer.setModelPrompt({ id: "writer", maxTokens: 0 })
  expect(await t.composer.askModel("writer")).toBe("max_tokens · 1–4096")
  await t.composer.setModelPrompt({ id: "writer", maxTokens: 64, prompt: " " })
  expect(await t.composer.askModel("writer")).toBe("prompt_empty")
  await t.composer.setModelPrompt({ id: "writer", prompt: "ping?" })
  expect(await t.composer.setModelPrompt({ id: "judge", prompt: "x" })).toBeString()
  await t.composer.askModel("writer")
  expect(t.asks()).toEqual([{ path: MODEL_TEST_PATH, body: { model: writer, input: { kind: "generation", system: "Answer tersely.", prompt: "ping?", maxTokens: 64 } } }])
  host.releases[0]!(Response.json(pong))
  await t.settled()
  expect(t.card("writer")?.payload.response?.result).toEqual(pong)
})

test("a temperature is kept as typed: one that is no number from 0 to 2 stays on the card and is never asked, and one that is goes out as that number", async () => {
  const host = held()
  const t = await setup(host.answer)
  await save(t, writer)
  await t.composer.composeModel("writer")
  await t.composer.setModelPrompt({ id: "writer", temperature: "0.2" })
  for (const typed of ["3", "warm", "-"]) {
    // The edit is kept, so the card shows what was typed beside why it cannot be asked; the old 0.2 is gone, not sent in its place.
    expect(await t.composer.setModelPrompt({ id: "writer", temperature: typed })).toBeUndefined()
    expect(t.card("writer")?.payload.request).toMatchObject({ temperature: typed })
    expect(await t.composer.askModel("writer")).toBe("temperature · 0–2")
  }
  expect(t.asks()).toHaveLength(0)
  await t.composer.setModelPrompt({ id: "writer", temperature: "1.5" })
  await t.composer.askModel("writer")
  const asked = t.card("writer")!.payload.request
  expect(asked).toMatchObject({ temperature: "1.5" })
  expect(t.asks()).toEqual([{ path: MODEL_TEST_PATH, body: { model: writer, input: { ...asked, temperature: 1.5 } } }])
  host.releases[0]!(Response.json(pong))
  await t.settled()
  // The answer is kept with the draft it answered, so it is not stale against the text still on screen.
  expect(t.card("writer")?.payload.response?.request).toEqual(asked)
})

test("recall returns the composer to the last recorded Test, and the fixture scripts the last decision answer", async () => {
  const t = await setup(held().answer)
  await save(t, judge)
  await t.composer.composeModel("judge")
  expect(await t.composer.recallModel("judge")).toBeString()
  await tested(t, "judge", answered)
  await t.composer.setModelQuestion({ id: "judge" })
  await t.composer.setModelField({ id: "judge", key: "extra", value: "x" })
  expect(await t.composer.recallModel("judge")).toBeUndefined()
  expect(t.card()?.payload).toEqual({ model: "judge", request: modelCallDefault("decision"), response: { askedAt: 5, request: modelCallDefault("decision"), binding: bindingOf(judge), result: answered } })
  const written = await t.composer.fixtureModel("judge")
  const fixture = t.card()?.payload.fixture
  const output = answered.ok ? answered.output : undefined
  if (fixture === undefined || output === undefined) throw new Error("the fixture was not written")
  expect(written).toEqual({ value: fixture })
  expect(fixture).toBe(scriptedFixtureOf("judge", modelCallDefault("decision"), output))
  // Answers in name order: a record's key order does not survive the store, so the fixture never depends on it.
  expect(t.card()?.payload.fixture).toBe([
    "// judge · state {\"text\":\"The sky is blue.\"}",
    "Evaluator.layerScripted(() => ({",
    "  [\"ok\"]: { probability: 0.97 },",
    "  [\"risk\"]: { score: 2 },",
    "  [\"which\"]: { choice: \"a\", probabilities: { [\"a\"]: 0.97, [\"b\"]: 0 } }",
    "}))"
  ].join("\n"))
  // An edit stales the fixture with the answer.
  await t.composer.setModelQuestion({ id: "judge" })
  expect(t.card()?.payload.fixture).toBeUndefined()
  await save(t, writer)
  await t.composer.composeModel("writer")
  expect(await t.composer.fixtureModel("writer")).toBeString()
})

test("recall while an ask is out keeps the ask: the pill stays running, and the answer lands stale against the recalled request", async () => {
  const host = held()
  const t = await setup(host.answer)
  await save(t, judge)
  await tested(t, "judge", yes)
  await t.composer.composeModel("judge")
  await t.composer.setModelQuestion({ id: "judge", type: "boolean", instructions: "Really?" })
  await t.composer.askModel("judge")
  await tick()
  const asked = t.card()!.payload.request
  expect(await t.composer.recallModel("judge")).toBeUndefined()
  // Last test rewrote the draft alone: the ask that is out is still the request that was asked.
  expect(t.card()?.payload.pending?.request).toEqual(asked)
  expect(t.toast("judge")?.status).toBe("running")
  host.releases[0]!(Response.json(answered))
  await t.settled()
  expect(t.card()?.payload.pending).toBeUndefined()
  expect(t.card()?.payload).toMatchObject({ request: modelCallDefault("decision"), response: { request: asked, result: answered } })
})

test("a failed answer is typed on the card and the toast offers Ask; a departed account's answer writes nothing", async () => {
  const host = held()
  const t = await setup(host.answer)
  await save(t, judge)
  await t.composer.composeModel("judge")
  await t.composer.askModel("judge")
  await tick()
  host.releases[0]!(Response.json(refused))
  await t.settled()
  expect(t.card()?.payload.pending).toBeUndefined()
  expect(t.card()?.payload).toMatchObject({ response: { result: refused } })
  expect(t.toast("judge")).toMatchObject({ status: "failed", detail: "refused · 429", action: { flow: "model.ask", args: "judge", label: "Ask" } })
  await t.composer.askModel("judge")
  await tick()
  t.ctx.accountEpoch += 1
  host.releases[1]!(Response.json(yes))
  await t.settled()
  expect(t.card()?.payload.response?.result).toEqual(refused)
  expect(t.card()?.payload.pending).toBeUndefined()
})

test("an ask requested before a reload is launched again, once", async () => {
  const storage = memoryStorage()
  const before = await setup(held().answer, storage)
  await save(before, judge)
  await before.composer.composeModel("judge")
  // The persisted request is composed, not the fixed Test, so the relaunch is told apart from one.
  await before.composer.setModelQuestion({ id: "judge", type: "boolean", instructions: "Really?" })
  await before.composer.askModel("judge")
  await tick()
  await opened.pop()!()

  const host = held()
  const after = await setup(host.answer, storage)
  const kept = after.card()!.payload.request
  expect(after.card()?.payload.pending?.request).toEqual(kept)
  expect(kept).not.toEqual(modelCallDefault("decision"))
  after.composer.resumeModelCalls()
  after.composer.resumeModelCalls()
  await tick()
  expect(after.asks()).toEqual([{ path: MODEL_TEST_PATH, body: { model: judge, input: kept } }])
  host.releases[0]!(Response.json(yes))
  await after.settled()
  expect(after.card()?.payload.pending).toBeUndefined()
  // The answer is kept with the request it answered.
  expect(after.card()?.payload).toMatchObject({ response: { request: kept, result: yes } })
})

test("a reload resumes the request that was asked, never the draft edited while it was out", async () => {
  const storage = memoryStorage()
  const before = await setup(held().answer, storage)
  await save(before, writer)
  await tested(before, "writer", pong)
  await before.composer.composeModel("writer")
  await before.composer.setModelPrompt({ id: "writer", prompt: "A" })
  await before.composer.askModel("writer")
  await tick()
  const asked = before.card("writer")!.payload.pending!
  expect(before.asks()).toHaveLength(1)
  // Nobody asked B, and nobody asked the fixed Test that Last test brings back.
  await before.composer.setModelPrompt({ id: "writer", prompt: "B" })
  expect(before.card("writer")?.payload).toMatchObject({ request: { prompt: "B" }, pending: asked })
  await opened.pop()!()

  const host = held()
  const after = await setup(host.answer, storage)
  after.composer.resumeModelCalls()
  after.composer.resumeModelCalls()
  await tick()
  expect(after.asks()).toEqual([{ path: MODEL_TEST_PATH, body: { model: writer, input: { kind: "generation", system: "", prompt: "A", maxTokens: MODEL_TEST_MAX_TOKENS } } }])
  await after.composer.recallModel("writer")
  expect(after.card("writer")?.payload).toMatchObject({ request: modelCallDefault("generation"), pending: asked })
  await after.composer.setModelPrompt({ id: "writer", prompt: "B" })
  // A press on the ask that is out joins it; B is a different ask only once someone asks it.
  host.releases[0]!(Response.json(pong))
  await after.settled()
  expect(after.asks()).toHaveLength(1)
  expect(after.card("writer")?.payload.pending).toBeUndefined()
  expect(after.card("writer")?.payload).toMatchObject({ request: { prompt: "B" }, response: { request: asked.request, binding: bindingOf(writer), result: pong } })
})

test("a resumed ask belongs to the account and the binding that asked: another account, a rebound model and a bare flag resume nothing", async () => {
  const storage = memoryStorage()
  const before = await setup(held().answer, storage)
  await save(before, judge)
  await save(before, writer)
  await before.composer.composeModel("judge")
  await before.composer.composeModel("writer")
  await before.composer.askModel("judge")
  await before.composer.askModel("writer")
  await tick()
  const judgeCard = before.card("judge")!
  const writerCard = before.card("writer")!
  // The ask was somebody else's; and a card written before the snapshot says only that something was out.
  await before.store.dispatch({ type: "card.upsert", actor: "system", card: { ...judgeCard, payload: { ...judgeCard.payload, pending: { ...judgeCard.payload.pending!, owner: "someone-else" } } } }).isPersisted.promise
  const { pending: _pending, ...bare } = writerCard.payload
  await before.store.dispatch({ type: "card.upsert", actor: "system", card: { ...writerCard, payload: { ...bare, asking: true } } }).isPersisted.promise
  await opened.pop()!()

  const after = await setup(held().answer, storage)
  after.composer.resumeModelCalls()
  await tick()
  await after.store.settled?.()
  expect(after.asks()).toHaveLength(0)
  expect(after.card("judge")?.payload).toEqual({ model: "judge", request: modelCallDefault("decision") })
  expect(after.card("writer")?.payload).toEqual({ model: "writer", request: modelCallDefault("generation") })
})

test("an answer is evidence about the binding that gave it: a model edited or removed and recreated during an ask keeps none of it", async () => {
  const host = held()
  const t = await setup(host.answer)
  await save(t, writer)
  await t.composer.composeModel("writer")
  await t.composer.askModel("writer")
  await tick()
  host.releases[0]!(Response.json(pong))
  await t.settled()
  expect(t.card("writer")?.payload.response).toMatchObject({ binding: bindingOf(writer), result: pong })
  // Asked of alpha; the record is rebound to beta while alpha is still thinking.
  await t.composer.askModel("writer")
  await tick()
  const beta = { ...writer, modelId: "beta" }
  await save(t, beta)
  // The rebind takes alpha's standing answer, its fixture and its ask off the card at once.
  expect(t.card("writer")?.payload).toEqual({ model: "writer", request: modelCallDefault("generation") })
  host.releases[1]!(Response.json(pong))
  await t.settled()
  expect(t.card("writer")?.payload).toEqual({ model: "writer", request: modelCallDefault("generation") })
  expect(t.toast("writer")?.status).not.toBe("ok")
  // A save that leaves the binding where it was keeps the evidence.
  await t.composer.askModel("writer")
  await tick()
  expect(t.asks()[2]).toEqual({ path: MODEL_TEST_PATH, body: { model: beta, input: modelCallDefault("generation") } })
  host.releases[2]!(Response.json(pong))
  await t.settled()
  await save(t, beta)
  expect(t.card("writer")?.payload.response).toMatchObject({ binding: bindingOf(beta), result: pong })
  // Removed and recreated under the same name and even the same binding: the ask was the removed record's.
  await t.composer.askModel("writer")
  await tick()
  await t.store.dispatch({ type: "model.removed", actor: "user", id: "writer" }).isPersisted.promise
  expect(t.card("writer")?.payload).toEqual({ model: "writer", request: modelCallDefault("generation") })
  await save(t, beta)
  host.releases[3]!(Response.json(pong))
  await t.settled()
  expect(t.card("writer")?.payload).toEqual({ model: "writer", request: modelCallDefault("generation") })
})

/** New conversation, and the archive notice's link back to the one that left. */
const archive = (t: Awaited<ReturnType<typeof setup>>) =>
  t.store.dispatch({ type: "conversation.cleared", actor: "user", branchId: `branch-${crypto.randomUUID()}`, notes: [] }).isPersisted.promise
const back = (t: Awaited<ReturnType<typeof setup>>, location: { workspaceId: string; branchId: string; frameId: string }) =>
  t.store.dispatch({ type: "frame.navigated", actor: "system", ...location }).isPersisted.promise
const here = (t: Awaited<ReturnType<typeof setup>>) => {
  const { activeWorkspaceId, activeBranchId, activeFrameId } = t.store.session()
  return { workspaceId: activeWorkspaceId!, branchId: activeBranchId!, frameId: activeFrameId! }
}

test("a composer that comes back from an archived conversation keeps no answer and no ask of a binding the model has left", async () => {
  const host = held()
  const t = await setup(host.answer)
  const beta = { ...writer, modelId: "beta" }
  await save(t, writer)
  await t.composer.composeModel("writer")
  await t.composer.askModel("writer")
  await tick()
  host.releases[0]!(Response.json(pong))
  await t.settled()
  await t.composer.fixtureModel("writer")
  expect(t.card("writer")?.payload.response).toMatchObject({ binding: bindingOf(writer), result: pong })
  const first = here(t)
  await archive(t)
  expect(t.card("writer")).toBeUndefined()
  await save(t, beta)
  await back(t, first)
  // Alpha answered; the record is beta's now, and the card that returns says nothing beta did not say.
  expect(t.card("writer")?.payload).toEqual({ model: "writer", request: modelCallDefault("generation") })
  expect(await t.composer.fixtureModel("writer")).toBe("writer has no decision answer yet.")

  // An ask that was out when the conversation left: rebound and answered while away, it is over on return and Ask is free.
  await save(t, writer)
  await t.composer.askModel("writer")
  await tick()
  expect(t.card("writer")?.payload.pending).toBeDefined()
  const second = here(t)
  await archive(t)
  await save(t, beta)
  host.releases[1]!(Response.json(pong))
  await t.settled()
  await back(t, second)
  expect(t.card("writer")?.payload).toEqual({ model: "writer", request: modelCallDefault("generation") })

  // Removed and recreated under the same binding while archived: the answer was the removed record's.
  await t.composer.askModel("writer")
  await tick()
  host.releases[2]!(Response.json(pong))
  await t.settled()
  expect(t.card("writer")?.payload.response).toMatchObject({ binding: bindingOf(beta) })
  const third = here(t)
  await archive(t)
  await t.store.dispatch({ type: "model.removed", actor: "user", id: "writer" }).isPersisted.promise
  await save(t, beta)
  await back(t, third)
  expect(t.card("writer")?.payload).toEqual({ model: "writer", request: modelCallDefault("generation") })
})

test("an ask still out when its conversation is archived is over when the conversation returns, so Ask is never held by an answer that has nowhere to land", async () => {
  const host = held()
  const t = await setup(host.answer)
  await save(t, writer)
  await t.composer.composeModel("writer")
  await t.composer.askModel("writer")
  await tick()
  const first = here(t)
  await archive(t)
  host.releases[0]!(Response.json(pong))
  await t.settled()
  await back(t, first)
  expect(t.card("writer")?.payload).toEqual({ model: "writer", request: modelCallDefault("generation") })
  expect(await t.composer.askModel("writer")).toEqual({ value: "Requested" })
  await tick()
  expect(t.asks()).toHaveLength(2)
  host.releases[1]!(Response.json(pong))
  await t.settled()
  expect(t.card("writer")?.payload.response).toMatchObject({ result: pong })
})

test("a recovered composer keeps its binding's answer and its ask, and none of a binding the model has left", async () => {
  const t = await setup(held().answer)
  await save(t, writer)
  const request = modelCallDefault("generation")
  const { workspaceId, branchId } = here(t)
  const recovered = (binding: ReturnType<typeof bindingOf>) => t.store.dispatch({ type: "card.recovered", actor: "user", workspaceId, branchId, id: modelCallCardId("writer"), card: {
    id: modelCallCardId("writer"), kind: "model-call", title: "writer", status: "active", createdAt: 1, ordinal: 1,
    payload: { model: "writer", request, response: { askedAt: 1, request, binding, result: pong }, pending: { requestId: "11111111-1111-4111-8111-111111111111", request, binding, owner: null } }
  } }).isPersisted.promise
  await recovered(bindingOf({ ...writer, modelId: "alpha" }))
  expect(t.card("writer")?.payload).toEqual({ model: "writer", request })
  await recovered(bindingOf(writer))
  expect(t.card("writer")?.payload).toMatchObject({ response: { result: pong }, pending: { binding: bindingOf(writer) } })
})

test("a card that reaches the composer holding another binding's answer or ask is acted on as if it held none", async () => {
  const t = await setup(held().answer)
  await save(t, judge)
  const other = bindingOf({ ...judge, modelId: "typesafe-ai/other" })
  const request = modelCallDefault("decision")
  await t.store.dispatch({ type: "card.upsert", actor: "system", card: {
    id: modelCallCardId("judge"), kind: "model-call", title: "judge", status: "active", createdAt: 1, ordinal: t.store.nextOrdinal(),
    payload: { model: "judge", request, response: { askedAt: 1, request, binding: other, result: yes }, pending: { requestId: crypto.randomUUID(), request, binding: other, owner: null }, fixture: "stale" }
  } }).isPersisted.promise
  expect(await t.composer.fixtureModel("judge")).toBe("judge has no decision answer yet.")
  // The next write is the card's as the composer reads it: the draft, and nothing of the other binding.
  await t.composer.setModelField({ id: "judge", key: "text", value: "again" })
  expect(t.card()?.payload as unknown).toEqual({ model: "judge", request: { ...request, state: [{ key: "text", kind: "text", value: "again" }] } })
})

const decodeQuestion = Schema.decodeUnknownSync(Evaluator.Question)
/** A generated fixture, executed as the JavaScript it is and replayed through the real scripted evaluator and the real classifier. */
const replay = async (request: Extract<ModelCallDraft, { kind: "decision" }>, output: ModelCallOutput) => {
  const fixture = scriptedFixtureOf("judge", request, output)
  const layer = new Function("Evaluator", `return (\n${fixture}\n)`)(Evaluator) as Layer.Layer<Evaluator.Evaluator>
  const questions = Object.fromEntries(Object.entries(request.questions).map(([id, question]) => [id, decodeQuestion(question)]))
  return Effect.runPromise(Effect.gen(function*() {
    const evaluator = yield* Evaluator.Evaluator
    const raw = yield* evaluator.evaluate({ state: modelStateOf(request.state), questions })
    return yield* Classifier.decodeAnswers(questions, raw.answers)
  }).pipe(Effect.provide(layer)))
}

test("a fixture replays the recorded decision exactly: every value, every distribution and every confidence, under ids no bare key could spell", async () => {
  const request: Extract<ModelCallDraft, { kind: "decision" }> = {
    kind: "decision",
    state: [{ key: "text", kind: "text", value: "line\u2028break */ ` ${x}" }],
    questions: {
      "is-safe": { type: "boolean", instructions: "Safe?" },
      "a.b": { type: "choice", instructions: "Which?", criteria: { "src/a.ts": "", "it's": "" } },
      risk: { type: "score", instructions: "How risky?", criteria: ["low", "mid", "high"] },
      digits: { type: "score", instructions: "Numeric labels", criteria: ["1", "0"] }
    }
  }
  const output: ModelCallOutput = { kind: "decision", answers: {
    "is-safe": { type: "boolean", value: false, probability: 0.2 },
    "a.b": { type: "choice", value: "it's", probabilities: { "src/a.ts": 0.25, "it's": 0.75 }, confidence: 0.75 },
    risk: { type: "score", value: 1.4, label: "mid", probabilities: { low: 0.1, mid: 0.6, high: 0.3 }, confidence: 0.6 },
    digits: { type: "score", value: 1, label: "0", probabilities: { "1": 0.3, "0": 0.7 }, confidence: 0.7 }
  } }
  const replayed = await replay(request, output)
  expect(Object.keys(replayed).sort()).toEqual(Object.keys(output.answers).sort())
  for (const [id, recorded] of Object.entries(output.answers)) {
    const { type: _type, ...answer } = recorded
    expect({ ...replayed[id] }).toEqual({ ...answer, ...("probabilities" in answer ? { probabilities: { ...answer.probabilities } } : {}) })
    expect(Classifier.confidence(replayed[id]!)).toBe(recorded.type === "boolean" ? Math.abs(recorded.probability - 0.5) * 2 : recorded.confidence)
  }
  // A gate at 0.65 takes the branch the recording took: the score is not sure, where a one-hot replay would have been.
  expect(Classifier.confidence(replayed.risk!)).toBe(0.6)
})

test("a problem reads as its code and its numbers, never a sentence", () => {
  expect([
    modelCallProblemLine({ code: "no_questions" }),
    modelCallProblemLine({ code: "question_empty", question: "q1" }),
    modelCallProblemLine({ code: "options_count", question: "which", count: 256 }),
    modelCallProblemLine({ code: "rungs_count", question: "risk", count: 1 }),
    modelCallProblemLine({ code: "rungs_distinct", question: "risk" }),
    modelCallProblemLine({ code: "field_invalid", key: "n", kind: "number" }),
    modelCallProblemLine({ code: "field_duplicate", key: "text" }),
    modelCallProblemLine({ code: "state_size", bytes: 34_304, max: 32_768 }),
    modelCallProblemLine({ code: "prompt_empty" }),
    modelCallProblemLine({ code: "max_tokens", max: 4096 }),
    modelCallProblemLine({ code: "temperature", max: 2 }),
    modelCallProblemLine({ code: "name_reserved", question: "risk", name: "__proto__" })
  ]).toEqual(["no_questions", "question_empty · q1", "options_count · which · 256", "rungs_count · risk · 1", "rungs_distinct · risk",
    "field_invalid · n · number", "field_duplicate · text", "state_size · 33.5 KiB / 32 KiB", "prompt_empty", "max_tokens · 1–4096", "temperature · 0–2", "name_reserved · risk · __proto__"])
})

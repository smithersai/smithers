import { MODEL_TEST_PATH } from "@smthrs/rpc/AgentApiRoutes"
import type { ConfiguredModel, ModelCallInput, ModelCatalog, ModelTestResult } from "@smthrs/rpc/ConfiguredModel"
import { MODEL_CALL_NAME_MAX, MODEL_CALL_STATE_MAX_BYTES, MODEL_CALL_TEXT_MAX, MODEL_TEST_DECISION, MODEL_TEST_MAX_TOKENS, MODEL_TEST_PROMPT, modelCallDefault } from "@smthrs/rpc/ConfiguredModel"
import type { StorageApi } from "@tanstack/db"
import { afterEach, expect, test } from "bun:test"
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
  expect(composed.payload).toEqual({ model: "judge", request: modelCallDefault("decision"), response: { askedAt: 5, request: modelCallDefault("decision"), result: yes } })
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
  expect(t.card()?.payload.asking).toBe(true)
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
  expect(t.card()?.payload.asking).toBeUndefined()
  expect(t.card()?.payload).toMatchObject({ response: { request: sent, result: answered } })
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
  expect(t.card()?.payload.asking).toBe(true)
  expect(t.card()?.payload.response).toBeUndefined()
  host.releases[1]!(Response.json(yes))
  await t.settled()
  expect(t.card()?.payload.asking).toBeUndefined()
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
  expect(await t.composer.setModelPrompt({ id: "writer", temperature: "3" })).toBe("invalid · temperature · 0–2")
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
  await t.composer.setModelPrompt({ id: "writer", prompt: "ping?", maxTokens: 64, temperature: "0.2" })
  expect(t.card("writer")?.payload.request).toEqual({ kind: "generation", system: "Answer tersely.", prompt: "ping?", maxTokens: 64, temperature: 0.2 })
  await t.composer.setModelPrompt({ id: "writer", temperature: "" })
  expect(t.card("writer")?.payload.request).toEqual({ kind: "generation", system: "Answer tersely.", prompt: "ping?", maxTokens: 64 })
  await t.composer.setModelPrompt({ id: "writer", maxTokens: 0 })
  expect(await t.composer.askModel("writer")).toBe("max_tokens · 1–4096")
  await t.composer.setModelPrompt({ id: "writer", maxTokens: 64, prompt: " " })
  expect(await t.composer.askModel("writer")).toBe("prompt_empty")
  await t.composer.setModelPrompt({ id: "writer", prompt: "ping?" })
  expect(await t.composer.setModelPrompt({ id: "judge", prompt: "x" })).toBeString()
  expect(await t.composer.setModelPrompt({ id: "writer", temperature: "warm" })).toBe("invalid · temperature")
  await t.composer.askModel("writer")
  expect(t.asks()).toEqual([{ path: MODEL_TEST_PATH, body: { model: writer, input: { kind: "generation", system: "Answer tersely.", prompt: "ping?", maxTokens: 64 } } }])
  host.releases[0]!(Response.json(pong))
  await t.settled()
  expect(t.card("writer")?.payload.response?.result).toEqual(pong)
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
  expect(t.card()?.payload).toEqual({ model: "judge", request: modelCallDefault("decision"), response: { askedAt: 5, request: modelCallDefault("decision"), result: answered } })
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
    "  ok: { probability: 0.97 },",
    "  risk: { score: 2 },",
    "  which: { choice: \"a\", probabilities: { \"a\": 0.97, \"b\": 0 } }",
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
  expect(t.card()?.payload.asking).toBe(true)
  expect(t.toast("judge")?.status).toBe("running")
  host.releases[0]!(Response.json(answered))
  await t.settled()
  expect(t.card()?.payload.asking).toBeUndefined()
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
  expect(t.card()?.payload.asking).toBeUndefined()
  expect(t.card()?.payload).toMatchObject({ response: { result: refused } })
  expect(t.toast("judge")).toMatchObject({ status: "failed", detail: "refused · 429", action: { flow: "model.ask", args: "judge", label: "Ask" } })
  await t.composer.askModel("judge")
  await tick()
  t.ctx.accountEpoch += 1
  host.releases[1]!(Response.json(yes))
  await t.settled()
  expect(t.card()?.payload.response?.result).toEqual(refused)
  expect(t.card()?.payload.asking).toBeUndefined()
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
  expect(after.card()?.payload.asking).toBe(true)
  const kept = after.card()!.payload.request
  expect(kept).not.toEqual(modelCallDefault("decision"))
  after.composer.resumeModelCalls()
  after.composer.resumeModelCalls()
  await tick()
  expect(after.asks()).toEqual([{ path: MODEL_TEST_PATH, body: { model: judge, input: kept } }])
  host.releases[0]!(Response.json(yes))
  await after.settled()
  expect(after.card()?.payload.asking).toBeUndefined()
  // The answer is kept with the request it answered.
  expect(after.card()?.payload).toMatchObject({ response: { request: kept, result: yes } })
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
    modelCallProblemLine({ code: "max_tokens", max: 4096 })
  ]).toEqual(["no_questions", "question_empty · q1", "options_count · which · 256", "rungs_count · risk · 1", "rungs_distinct · risk",
    "field_invalid · n · number", "field_duplicate · text", "state_size · 33.5 KiB / 32 KiB", "prompt_empty", "max_tokens · 1–4096"])
})

// Jev in the agent's hands (docs/features/jev.md): `app/jev/classify` and `app/jev/evaluate` on the Node host's engine
// (worker/test/flowHost.ts), judging through ChatApi's real model endpoint, role `judge`, on this file's schema of the
// compose Postgres (`pnpm db:up`), with a scripted model as the deployment's default model: the only scripted seam. Then
// the agent's call from a cell (src/test/agent.ts), and the payload's bounds.
import { Action, FlowRuntime } from "@smthrs/flow"
import { Cause, Context, Effect, Exit, Layer, Logger, Metric, Schema, Scope, Stream, Tracer } from "effect"
import { FetchHttpClient } from "effect/http"
import { SqlClient } from "effect/sql"
import { afterEach, describe, expect, test } from "vitest"
import type { Actor } from "../../../worker/Actor.vibe"
import { build } from "../../../worker/test/flowHost.ts"
import { contents, harness, stop, testFile, usage } from "../../../worker/test/harness.ts"
import { jev } from "../../flows/registrations"
import { BROWSER_TELEMETRY } from "../../telemetry"
import { answerRow, cell, type Engine, member, openAgent } from "../../test/agent"
import { debugRunOf } from "../chat/view"
import { JOURNAL_PAGE, runPath } from "../runs/contract"
import { graphOf } from "../runs/graph"
import type { Inspection, RunPage } from "../runs/schema"
import { JEV_TELEMETRY, MAX_CRITERIA, MAX_ITEMS, MAX_LABELS } from "./contract"
import { Classify, Evaluate, JudgeFailed, type Verdicts } from "./flows"
import { judgments, verdicts } from "./metrics"

/** A failed call's error. The engine annotates an action's failed cause with its FailureSite, which the outcome doesn't depend on. */
const failureOf = (exit: Exit.Exit<unknown, unknown>) => Exit.isFailure(exit) ? Cause.squash(exit.cause) : exit

const runtime = testFile("jev")

/** ChatApi's origin as the steps reach it: the harness's in-process handler. */
const ORIGIN = "http://chat.test"

/** The words every judge request opens its instructions with (`Evaluator.layerFromSeat` in `@smthrs/model`). */
const JUDGE = "Judge the supplied evidence"

const isJudge = (request: Parameters<Parameters<typeof harness>[1]>[0]) =>
  request.system.some((part) => part.text.startsWith(JUDGE))

/** What a judge request asks: the state and the questions, as the seat reads them. */
const asked = (request: Parameters<Parameters<typeof harness>[1]>[0]) =>
  JSON.parse(contents(request).at(-1)!) as {
    readonly state: Record<string, unknown>
    readonly questions: Record<string, { readonly type: string; readonly instructions: string }>
  }

/** A judge that answers each question id with `answer(id)`, as the seat's JSON. */
const judged = (answer: (id: string, request: ReturnType<typeof asked>) => unknown) =>
  (request: Parameters<Parameters<typeof harness>[1]>[0]) => {
    const question = asked(request)
    const answers = Object.fromEntries(Object.keys(question.questions).map((id) => [id, answer(id, question)]))
    return Stream.make({ type: "text-delta" as const, id: "t", text: JSON.stringify({ answers }) }, usage, stop)
  }

/** The probability of yes each item's text earns. */
const bugs = (id: string, request: ReturnType<typeof asked>) => {
  const items = request.state["items"] as Record<string, string> | undefined
  const item = items?.[id] ?? String(request.state["text"])
  return { type: "boolean", probability: item.includes("crash") ? 0.97 : item.includes("slow") ? 0.6 : 0.02 }
}

const scopes: Array<Scope.Closeable> = []
afterEach(async () => {
  for (const scope of scopes.splice(0)) await Effect.runPromise(Scope.close(scope, Exit.void))
})

/** Calls the model endpoint served for `role`, from this file's ledger. */
const served = (role: string) =>
  runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) =>
    sql<{ readonly n: number }>`SELECT count(*)::int AS n FROM model_usage WHERE role = ${role}`)).then(([row]) => row!.n)

/**
 * Jev's flows on the Node host's engine, judging through ChatApi's real model endpoint as `actor` (a Member unless
 * `null`), with `script` as the deployment's model. Every log line, span and count the steps record is kept.
 */
const openJudge = async (
  script: Parameters<typeof harness>[1],
  options: { readonly actor?: Actor | null } = {},
) => {
  const h = await harness(runtime, script, options.actor === null ? {} : { actor: options.actor ?? member })
  const fetch: typeof globalThis.fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    return h.fetch(`${url.pathname}${url.search}`, input instanceof Request ? input : init)
  }
  const logs: Array<ReturnType<typeof Logger.formatStructured.log>> = []
  const spans: Array<Tracer.NativeSpan> = []
  const registry: Metric.MetricRegistry = new Map()
  const observed = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(Logger.CurrentLoggers, new Set([Logger.make((o) => void logs.push(Logger.formatStructured.log(o)))])),
      Effect.provideService(Tracer.Tracer, Tracer.make({
        span: (o) => {
          const span = new Tracer.NativeSpan(o)
          spans.push(span)
          return span
        },
      })),
      Effect.provideService(Metric.MetricRegistry, registry),
    )
  const scope = Effect.runSync(Scope.make())
  scopes.push(scope)
  const { context } = await Effect.runPromise(
    observed(Scope.provide(scope)(build(
      jev(ORIGIN).pipe(
        Layer.provideMerge(Action.layerImplementations),
        Layer.provide(FetchHttpClient.layer),
        Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch)),
      ),
    ))),
  )
  const flows = Context.get(context, FlowRuntime.FlowRuntime)
  return {
    h,
    classify: (executionId: string, payload: typeof Classify.payloadSchema.Type) =>
      Effect.runPromise(observed(Effect.exit(flows.execute(Classify, { executionId, payload })))),
    evaluate: (executionId: string, payload: typeof Evaluate.payloadSchema.Type) =>
      Effect.runPromise(observed(Effect.exit(flows.execute(Evaluate, { executionId, payload })))),
    count: (metric: typeof judgments, attributes: Record<string, string>) =>
      Effect.runSync(
        Metric.value(Metric.withAttributes(metric, attributes)).pipe(Effect.provideService(Metric.MetricRegistry, registry)),
      ).count,
    lines: () => logs.filter((log) => log.message === "jev.judge"),
    spans: () => spans.filter((span) => span.name === "jev.judge"),
  }
}

describe("app/jev/classify", () => {
  test("asks one question per item in one judge call, and answers a verdict per item in order", async () => {
    const judge = await openJudge(judged(bugs))
    const before = await served("judge")

    const exit = await judge.classify("classify-1", {
      question: "Is this a bug report?",
      items: ["The app crashes on save", "Please add dark mode", "Search feels slow sometimes"],
    })

    expect(exit).toEqual(Exit.succeed({
      verdicts: [
        { verdict: "yes", confidence: expect.closeTo(0.94, 5) },
        { verdict: "no", confidence: expect.closeTo(0.96, 5) },
        { verdict: "unsure", confidence: expect.closeTo(0.2, 5) },
      ],
    }))
    // One call, through the `judge` role, asking each item by its id.
    expect(await served("judge")).toBe(before + 1)
    expect(judge.h.requests).toHaveLength(1)
    const request = asked(judge.h.requests[0]!)
    expect(request.state).toEqual({
      question: "Is this a bug report?",
      items: { item1: "The app crashes on save", item2: "Please add dark mode", item3: "Search feels slow sometimes" },
    })
    expect(request.questions["item2"]).toEqual({ type: "boolean", instructions: "item2: Is this a bug report?" })
  })

  test("picks one of the labels for each item, or unsure below the floor", async () => {
    const judge = await openJudge(judged((id) =>
      id === "item1"
        ? { type: "choice", choice: "bug", probabilities: { bug: 0.9, feature: 0.05, question: 0.05 } }
        : { type: "choice", choice: "question", probabilities: { bug: 0.3, feature: 0.3, question: 0.4 } }
    ))

    const exit = await judge.classify("classify-labels", {
      question: "What kind of issue is this?",
      items: ["It crashes", "How do I sign in?"],
      labels: ["bug", "feature", "question"],
    })

    expect(exit).toEqual(Exit.succeed({
      verdicts: [{ verdict: "bug", confidence: 0.9 }, { verdict: "unsure", confidence: 0.4 }],
    }))
    const request = asked(judge.h.requests[0]!)
    expect(request.state["labels"]).toEqual(["bug", "feature", "question"])
    expect(request.questions["item1"]).toMatchObject({ type: "choice", instructions: "item1: What kind of issue is this?" })
    expect(judge.count(verdicts, { flow: "app/jev/classify", verdict: "label" })).toBe(1)
    expect(judge.count(verdicts, { flow: "app/jev/classify", verdict: "unsure" })).toBe(1)
  })

  test("a settled judgment is read back, never asked again", async () => {
    const judge = await openJudge(judged(bugs))
    const payload = { question: "Is this a bug report?", items: ["It crashes"] }

    const first = await judge.classify("classify-replay", payload)
    const again = await judge.classify("classify-replay", payload)

    expect(again).toEqual(first)
    expect(judge.h.requests).toHaveLength(1)
  })

  test("a judge answer it can't read, and a caller the endpoint refuses, fail JudgeFailed by code", async () => {
    const garbled = await openJudge(() =>
      Stream.make({ type: "text-delta" as const, id: "t", text: "Yes to all." }, usage, stop)
    )
    expect(failureOf(await garbled.classify("classify-garbled", { question: "Bug?", items: ["It crashes"] }))).toEqual(
      new JudgeFailed({ code: "invalid_answer" }),
    )
    expect(garbled.count(judgments, { flow: "app/jev/classify", outcome: "invalid_answer" })).toBe(1)
    expect(garbled.lines()).toEqual([
      expect.objectContaining({ level: "WARN", annotations: expect.objectContaining({ outcome: "invalid_answer", items: 1 }) }),
    ])

    // Signed out: the endpoint refuses before any model runs (401), and the step says the judge was unavailable.
    const signedOut = await openJudge(judged(bugs), { actor: null })
    expect(failureOf(await signedOut.classify("classify-signed-out", { question: "Bug?", items: ["It crashes"] }))).toEqual(
      new JudgeFailed({ code: "unreachable" }),
    )
    expect(signedOut.h.requests).toEqual([])
  })
})

describe("app/jev/evaluate", () => {
  test("applies each criterion of the rubric to the text, one verdict per criterion", async () => {
    const judge = await openJudge(judged((id) => ({ type: "boolean", probability: id === "criterion1" ? 0.95 : 0.04 })))

    const exit = await judge.evaluate("evaluate-1", {
      text: "Fixes the save crash. Closes #12.",
      criteria: ["Links an issue", "Includes screenshots"],
    })

    expect(exit).toEqual(Exit.succeed({
      verdicts: [
        { verdict: "yes", confidence: expect.closeTo(0.9, 5) },
        { verdict: "no", confidence: expect.closeTo(0.92, 5) },
      ],
    }))
    const request = asked(judge.h.requests[0]!)
    expect(request.state).toEqual({ text: "Fixes the save crash. Closes #12." })
    expect(request.questions["criterion1"]).toEqual({
      type: "boolean",
      instructions: "criterion1: Does the text meet this criterion? Links an issue",
    })
    expect(judge.count(judgments, { flow: "app/jev/evaluate", outcome: "judged" })).toBe(1)
    expect(judge.count(verdicts, { flow: "app/jev/evaluate", verdict: "yes" })).toBe(1)
    expect(judge.count(verdicts, { flow: "app/jev/evaluate", verdict: "no" })).toBe(1)
  })
})

describe("observability", () => {
  test("records carry counts and verdict codes, never an item, a question, a label, a text or a criterion", async () => {
    const judge = await openJudge(judged(bugs))
    const sentinel = "sentinel-7c1d"

    await judge.classify("classify-sentinel", {
      question: `Bug ${sentinel}?`,
      items: [`crash ${sentinel}`, `idea ${sentinel}`],
      labels: [`yes-${sentinel}`, `no-${sentinel}`],
    })
    await judge.classify("classify-sentinel-2", { question: `Bug ${sentinel}?`, items: [`crash ${sentinel}`] })
    await judge.evaluate("evaluate-sentinel", { text: `text ${sentinel}`, criteria: [`criterion ${sentinel}`] })

    const records = JSON.stringify({
      logs: judge.lines(),
      spans: judge.spans().map((span) => Object.fromEntries(span.attributes)),
    })
    expect(records).not.toContain(sentinel)
    expect(judge.lines().at(1)).toMatchObject({
      level: "INFO",
      annotations: { flow: "app/jev/classify", outcome: "judged", items: 1, yes: 1, no: 0, labeled: 0, unsure: 0 },
    })
    expect(Object.fromEntries(judge.spans().at(-1)!.attributes)).toMatchObject({
      "smithers.jev.flow": "app/jev/evaluate",
      "smithers.jev.items": 1,
      "smithers.jev.outcome": "judged",
    })
    for (const log of judge.lines()) {
      for (const field of Object.keys(log.annotations)) expect(BROWSER_TELEMETRY.fields).toContain(field)
    }
    expect(BROWSER_TELEMETRY.records).toEqual(expect.arrayContaining([...JEV_TELEMETRY.records]))
  })
})

describe("the payload", () => {
  const decodes = (flow: typeof Classify | typeof Evaluate, value: unknown) =>
    Exit.isSuccess(Schema.decodeUnknownExit(flow.payloadSchema)(value))

  test("classify takes 1 to 50 items, and 2 to 10 distinct labels when it takes labels", () => {
    const items = (n: number) => Array.from({ length: n }, (_, index) => `item ${index}`)
    expect(decodes(Classify, { question: "Bug?", items: items(1) })).toBe(true)
    expect(decodes(Classify, { question: "Bug?", items: items(MAX_ITEMS) })).toBe(true)
    expect(decodes(Classify, { question: "Bug?", items: [] })).toBe(false)
    expect(decodes(Classify, { question: "Bug?", items: items(MAX_ITEMS + 1) })).toBe(false)
    expect(decodes(Classify, { question: "", items: items(1) })).toBe(false)
    expect(decodes(Classify, { question: "Bug?", items: [""] })).toBe(false)
    expect(decodes(Classify, { question: "Kind?", items: items(1), labels: ["bug", "idea"] })).toBe(true)
    expect(decodes(Classify, { question: "Kind?", items: items(1), labels: ["bug"] })).toBe(false)
    expect(decodes(Classify, { question: "Kind?", items: items(1), labels: ["bug", "bug"] })).toBe(false)
    expect(decodes(Classify, { question: "Kind?", items: items(1), labels: items(MAX_LABELS + 1) })).toBe(false)
  })

  test("evaluate takes one text and 1 to 20 criteria", () => {
    const criteria = (n: number) => Array.from({ length: n }, (_, index) => `criterion ${index}`)
    expect(decodes(Evaluate, { text: "A change.", criteria: criteria(MAX_CRITERIA) })).toBe(true)
    expect(decodes(Evaluate, { text: "A change.", criteria: [] })).toBe(false)
    expect(decodes(Evaluate, { text: "A change.", criteria: criteria(MAX_CRITERIA + 1) })).toBe(false)
    expect(decodes(Evaluate, { text: "", criteria: criteria(1) })).toBe(false)
  })
})

describe("the agent", () => {
  /** An answer takes several sealed model steps and a judgment; under a loaded machine one test may take minutes. */
  const SLOW = 240_000
  const engines: Array<Engine> = []
  afterEach(async () => {
    for (const engine of engines.splice(0)) await engine.kill()
  })

  /** The cell's call: three items, one question, no labels. */
  const ITEMS = ["The app crashes on save", "Please add dark mode", "Search feels slow sometimes"]

  /** The agent answers "Which of these are bugs?" by classifying `ITEMS` in its first cell, then answers. */
  const classified = async () => {
    const cells = [
      `const r = await ctx.call("app/jev/classify", { question: "Is this a bug report?", ` +
      `items: ${JSON.stringify(ITEMS)} })\n` +
      `console.log(JSON.stringify(r.verdicts.map((v) => v.verdict)))`,
      `ctx.done("Bug: the crash. Not a bug: dark mode. Unsure: slow search.")`,
    ]
    let calls = 0
    const agent = await openAgent(runtime, (request) =>
      isJudge(request)
        ? judged(bugs)(request)
        : Stream.make({ type: "text-delta" as const, id: "t", text: cell(cells[Math.min(calls++, 1)]!) }, usage, stop))
    const engine = await agent.engine()
    engines.push(engine)
    const before = await served("judge")
    const answerId = await agent.ask("Which of these are bugs?")
    expect(await agent.answer(engine, answerId)).toEqual(Exit.succeed({ status: "done" }))
    return { agent, engine, answerId, before }
  }

  /**
   * The page `/app/runs/<runId>` shows, read as the browser's engine reads it for the run screen
   * (src/features/runs/store.ts `readRun`): the run, and every run under it.
   */
  const runPage = async (engine: Engine, runId: string): Promise<RunPage> => {
    const read = (id: string) => Effect.runPromise(engine.inspection.inspect(id, { limit: JOURNAL_PAGE }))
    const inspection = await read(runId)
    const descendants: Array<Awaited<ReturnType<typeof read>>> = []
    const pending = inspection.children.map((child) => child.runId)
    for (const id of pending) {
      const child = await read(id)
      descendants.push(child)
      pending.push(...child.children.map((grandchild) => grandchild.runId))
    }
    return { id: runId, state: "read", inspection, more: [], hasMore: inspection.journal.hasMore, descendants }
  }

  test("a cell's ctx.call classifies items as a journaled step, its judgment through the judge role", async () => {
    const { agent, answerId, before } = await classified()

    const answer = await answerRow(runtime, answerId)
    expect(answer).toMatchObject({ status: "done", text: "Bug: the crash. Not a bug: dark mode. Unsure: slow search." })
    expect(answer.parts).toEqual([{ id: "0.0", kind: "step", flow: "app/jev/classify", status: "done" }])
    expect(await served("judge")).toBe(before + 1)
    // The agent's next frame read the verdicts the cell printed.
    const second = agent.h.requests.filter((request) => !isJudge(request))[1]!
    expect(contents(second).join("\n")).toContain(`["yes","no","unsure"]`)
  }, SLOW)

  test("the answer's debug info opens the run that answered it, whose flow view shows the Jev step's input and output", async () => {
    const { engine, answerId } = await classified()

    // Debug info on the answer opens its own run; a question has none (src/features/chat/view.ts).
    const runId = debugRunOf({ id: answerId, role: "assistant" })!
    expect(runId).toBe(answerId)
    expect(debugRunOf({ id: answerId, role: "user" })).toBeUndefined()

    const page = await runPage(engine, runId)
    expect((page.inspection as Inspection).run).toMatchObject({ flowName: "chat/Answer", status: "completed" })
    // The cell's call is a run of its own under the answer's: Jev's input and its verdicts.
    const call = (page.descendants as ReadonlyArray<Inspection>).find((read) => read.run.flowName === "app/jev/classify")!
    expect(JSON.parse(call.run.input.text)).toEqual({ question: "Is this a bug report?", items: ITEMS })
    const verdictsOf = (text: string) => (JSON.parse(text) as Verdicts).verdicts.map((verdict) => verdict.verdict)
    expect(verdictsOf(call.run.result!.text)).toEqual(["yes", "no", "unsure"])

    // The flow view: the answer's own steps, its opening memory among them, and the Jev step its call ran, done, with the
    // verdicts as its output and a link to the call's own run, whose page holds the input.
    const graph = graphOf(page, null, Date.now())
    const nodes = graph.nodes.map((node) => [node.label, node.state])
    // chat/ForgetProgress releases the answer's progress after Settle, so the page can be read before or after it ran.
    expect(nodes.map(([label]) => label)).toContain("chat/ForgetProgress")
    expect(nodes.filter(([label]) => label !== "chat/ForgetProgress")).toEqual([
      ["chat/LoadTurn", "done"],
      ["chat/RecallOpening", "done"],
      ["chat/Opening", "done"],
      ["chat/Respond", "done"],
      ["chat/Settle", "done"],
      ["app/jev/classify/judge", "done"],
    ])
    const judge = graph.steps.find((step) => step.row.label === "app/jev/classify/judge")!
    expect(judge.row.state).toBe("completed")
    expect(verdictsOf(judge.output!.text)).toEqual(["yes", "no", "unsure"])
    expect(judge.href).toBe(runPath(call.run.runId))
  }, SLOW)
})

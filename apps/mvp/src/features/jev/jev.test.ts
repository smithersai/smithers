// Jev's flows driven through the durable engine with an explicitly supplied model seat.
import { Model } from "@smthrs/model"
import { Action, FlowRuntime } from "@smthrs/flow"
import { Cause, Context, Effect, Exit, Layer, Logger, Metric, Schema, Scope, Stream, Tracer } from "effect"
import { afterEach, describe, expect, test } from "vitest"
import { build } from "../../../worker/test/flowHost.ts"
import { contents, harness, stop, usage } from "../../../worker/test/harness.ts"
import { clientSeat } from "../model/clientSeat.vibe"
import { JudgeSeat, registration } from "./steps.vibe"
import { BROWSER_TELEMETRY } from "../../telemetry"
import { JEV_TELEMETRY, MAX_CRITERIA, MAX_ITEMS, MAX_LABELS } from "./contract"
import { Classify, Evaluate, JudgeFailed } from "./flows"
import { judgments, verdicts } from "./metrics.vibe"

/** A failed call's error. The engine annotates an action's failed cause with its FailureSite, which the outcome doesn't depend on. */
const failureOf = (exit: Exit.Exit<unknown, unknown>) => Exit.isFailure(exit) ? Cause.squash(exit.cause) : exit

const ORIGIN = "http://chat.test"

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

const openJudge = async (script?: Parameters<typeof harness>[1]) => {
  const requests: Array<Parameters<Parameters<typeof harness>[1]>[0]> = []
  const model = script === undefined ? undefined : Model.make({
    stream: (request) => {
      requests.push(request)
      return script(request)
    },
  })
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
      registration.pipe(
        Layer.provideMerge(Action.layerImplementations),
        Layer.provide(Layer.succeed(JudgeSeat, {
          ...clientSeat(ORIGIN, "judge", model),
          ...(model === undefined ? { unconfigured: true as const } : {}),
        })),
      ),
    ))),
  )
  const flows = Context.get(context, FlowRuntime.FlowRuntime)
  return {
    requests,
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
    expect(judge.requests).toHaveLength(1)
    const request = asked(judge.requests[0]!)
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
    const request = asked(judge.requests[0]!)
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
    expect(judge.requests).toHaveLength(1)
  })

  test("an invalid judge answer and a missing judge seat, fail JudgeFailed by code", async () => {
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

    const unconfigured = await openJudge()
    expect(failureOf(await unconfigured.classify("classify-no-seat", { question: "Bug?", items: ["It crashes"] }))).toEqual(
      new JudgeFailed({ code: "unconfigured" }),
    )
    expect(unconfigured.requests).toEqual([])
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
    const request = asked(judge.requests[0]!)
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

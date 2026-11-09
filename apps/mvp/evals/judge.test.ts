// The agent evals' judge with a scripted judge in place of Jev or the subscription: the model is the only seam
// (docs/features/agent-evals.md#the-judge). It proves what the judge is asked, what it is shown, and how its readings
// become a score; the live run proves the judge itself.
import { Evaluator } from "@smthrs/model"
import { Effect, Layer } from "effect"
import { describe, expect, test } from "vitest"
import { caseNamed, inputOf } from "./cases"
import { call, trial } from "./fixtures"
import { PERSONS_OWN } from "../src/features/agent/instructions"
import { ACTS_CRITERIA, CRITERIA, evidence, HONEST_CRITERIA, judgeScorer, questionsFor, read, SEAT_NOTE } from "./judge.ts"

/** A judge that answers each question with the probability `answer` gives it, and records what it was asked. */
const scripted = (
  answer: (id: string, request: Evaluator.Request) => number | undefined,
  usage?: Evaluator.Usage,
) => {
  const requests: Array<Evaluator.Request> = []
  const layer = Layer.succeed(Evaluator.Evaluator)(Evaluator.Evaluator.of({
    evaluate: (request) =>
      Effect.sync(() => {
        requests.push(request)
        const answers: Record<string, Evaluator.RawAnswer> = {}
        for (const id of Object.keys(request.questions)) {
          const probability = answer(id, request)
          if (probability !== undefined) answers[id] = { type: "boolean", probability }
        }
        return { answers, latencyMs: 5, ...(usage === undefined ? {} : { usage }) }
      }),
  }))
  return { layer, requests }
}

const score = (layer: Layer.Layer<Evaluator.Evaluator>, name: string, trials = [trial()]) =>
  Effect.runPromise(judgeScorer(layer).score({ input: inputOf(caseNamed(name)), output: { trials } }))

describe("the questions", () => {
  test("every answer is asked the product's questions, then its case's own", () => {
    expect(Object.keys(questionsFor("greeting"))).toEqual(["acts", "honest", "words", "brief"])
    expect(questionsFor("jev-bugs")).toEqual({ ...CRITERIA, verdicts: caseNamed("jev-bugs").judge!.verdicts })
  })

  test("the judge sees the question, the answer, and what the agent did, what it answered and asked, never its usage", () => {
    const t = trial({
      text: "Asked; set dark.",
      calls: [{ ...call("app/theme/set", { mode: "dark" }), result: { mode: "dark" } }],
      asked: [{ kind: "question", prompt: "Light or dark?", value: "dark" }],
      views: [],
    })
    expect(evidence(inputOf(caseNamed("greeting")), t)).toEqual({
      question: "hi",
      personOnly: PERSONS_OWN,
      callCount: 1,
      answer: "Asked; set dark.",
      status: "done",
      calls: [{ flow: "app/theme/set", input: { mode: "dark" }, status: "completed", result: { mode: "dark" } }],
      asked: [{ kind: "question", prompt: "Light or dark?", value: "dark" }],
      views: [],
      drafts: [],
      draft: { completedCalls: 0, readyDrafts: 0, ready: false },
      ui: {
        form: { completedCalls: 0, shownViews: 0, ready: false },
        board: { completedCalls: 0, shownViews: 0, ready: false },
      },
    })
  })

  test("a call without a result remains valid JSON evidence", () => {
    expect(evidence(inputOf(caseNamed("board")), trial({ calls: [call("ui/render", {}, "failed")] })).calls)
      .toEqual([{ flow: "ui/render", input: {}, status: "failed", result: null }])
  })

  test("draft readiness requires both a completed creation and a persisted ready draft", () => {
    for (const completed of [false, true]) {
      for (const ready of [false, true]) {
        const t = trial({ calls: [call("flow/new", {}, completed ? "completed" : "failed")],
          drafts: [{ name: "effect-docs", status: ready ? "ready" : "failed", checks: [], source: "" }] })
        const state = evidence(inputOf(caseNamed("flow-new")), t)
        expect(state.drafts).toEqual([{ name: "effect-docs", status: ready ? "ready" : "failed" }])
        expect(state.draft).toEqual({ completedCalls: Number(completed), readyDrafts: Number(ready), ready: completed && ready })
      }
    }
  })

  test("UI readiness requires both a completed matching call and its shown view", () => {
    for (const [flow, template, key] of [["ui/form", "form", "form"], ["ui/render", "generated", "board"]] as const) {
      for (const completed of [false, true]) {
        for (const shown of [false, true]) {
          const t = trial({ calls: [call(flow, {}, completed ? "completed" : "failed")],
            views: shown ? [{ template, url: null }] : [] })
          expect(evidence(inputOf(caseNamed("greeting")), t).ui[key])
            .toEqual({ completedCalls: Number(completed), shownViews: Number(shown), ready: completed && shown })
        }
      }
    }
  })
})

describe("a case with no answer to judge", () => {
  test("a refused provider's trial isn't read: it scores 1 and asks the judge nothing", async () => {
    const judge = scripted(() => 0)
    const result = await score(judge.layer, "provider-refuses", [trial({ status: "failed", failure: "model_error", text: "" })])
    expect(result).toEqual({ score: 1, reason: "no answer to judge", meta: { readings: [] } })
    expect(judge.requests).toEqual([])
  })
})

describe("read", () => {
  test("a question holds at a probability of yes of one half or more; a missing or other answer doesn't", () => {
    expect(read({ a: { type: "boolean", probability: 0.5 }, b: { type: "boolean", probability: 0.49 } }, ["a", "b", "c"]))
      .toEqual({ pass: false, failed: ["b", "c"], probabilities: { a: 0.5, b: 0.49, c: null } })
    expect(read({ a: { type: "choice", choice: "yes" } }, ["a"])).toEqual({
      pass: false,
      failed: ["a"],
      probabilities: { a: null },
    })
    expect(read({ a: { type: "boolean", probability: 1 } }, ["a"]).pass).toBe(true)
  })
})

describe("judgeScorer", () => {
  test("asks one reading per trial, with the seat note, and scores the share of trials whose every question holds", async () => {
    const judge = scripted((id, request) =>
      id === "acts" && (request.state as { answer: string }).answer.includes("you can") ? 0.1 : 0.9
    )
    const result = await score(judge.layer, "slash-how-do-i", [trial({ text: "Done." }), trial({ text: "First, you can…" })])

    expect(result.score).toBe(0.5)
    expect(result.reason).toBe("no: acts")
    expect(judge.requests).toHaveLength(2)
    expect(judge.requests[0]!.seatNote).toBe(SEAT_NOTE)
    expect(Object.keys(judge.requests[0]!.questions)).toEqual(Object.keys(CRITERIA))
    for (const request of judge.requests) {
      for (const [id, question] of Object.entries(request.questions)) {
        expect(question).toMatchObject({ type: "boolean", instructions: `${SEAT_NOTE}\n\n${CRITERIA[id]}` })
      }
      expect(request.questions.honest).toMatchObject({ criteria: HONEST_CRITERIA })
      expect(request.questions.acts).toMatchObject({ criteria: ACTS_CRITERIA })
    }
    expect((result.meta as { readings: Array<{ usage: unknown }> }).readings.map((reading) => reading.usage))
      .toEqual([null, null])
  })

  test("every question holding scores 1, and each reading keeps the usage its judge reported", async () => {
    const usage = { inputTokens: 500, outputTokens: 70, modelId: "typesafe-ai/jev" }
    const result = await score(scripted(() => 0.95, usage).layer, "jev-bugs")

    expect(result).toMatchObject({ score: 1, reason: "every question holds" })
    expect((result.meta as { readings: Array<{ usage: unknown }> }).readings).toEqual([
      expect.objectContaining({ pass: true, failed: [], usage }),
    ])
  })

  test("a judge that can't judge fails the score, which the run reads as inconclusive", async () => {
    const down = Layer.succeed(Evaluator.Evaluator)(Evaluator.Evaluator.of({
      evaluate: () => Effect.fail(new Evaluator.EvaluatorError({ code: "unconfigured", message: "no judge" })),
    }))

    await expect(score(down, "greeting")).rejects.toMatchObject({ code: "unconfigured" })
  })
})

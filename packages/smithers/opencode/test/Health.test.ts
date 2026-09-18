import * as Evaluator from "@smthrs/model/Evaluator"
import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import * as Health from "../src/Health.ts"

const facts = (extra: Partial<Health.Facts> = {}): Health.Facts => ({
  task: "Fix the flaky test",
  frame: 3,
  maxFrames: 100,
  framesSinceEdit: 1,
  demands: [],
  lastCalls: [{ flow: "read", ok: true, summary: "a.ts" }],
  lastPrints: "read a.ts",
  parked: "none",
  lastTransition: "continue",
  demandThisFrame: false,
  capEnded: undefined,
  ...extra
})

const answers = (extra: Partial<Health.Answers> = {}): Health.Answers => ({
  progress: {
    value: 2,
    label: "progressing",
    probabilities: { stuck: 0.05, exploring: 0.1, progressing: 0.7, verifying: 0.1, done: 0.05 },
    confidence: 0.7
  },
  stuck: { value: false, probability: 0.1 },
  needsHuman: { value: false, probability: 0.1 },
  ...extra
})

const script = (reply: Record<string, Evaluator.ScriptedAnswer>): Evaluator.Script => () => reply

const healthy = {
  progress: { score: 2, probabilities: { stuck: 0.05, exploring: 0.1, progressing: 0.7, verifying: 0.1, done: 0.05 } },
  stuck: { probability: 0.1 },
  needsHuman: { probability: 0.1 }
}

describe("Health", () => {
  it("decides the color from the facts and the answers, first match wins", () => {
    const table: Array<[string, Health.Facts, Health.Answers | undefined, Health.Color, string]> = [
      ["no answers", facts(), undefined, "gray", "health unavailable"],
      [
        "every answer under the floor",
        facts(),
        answers({
          progress: { value: 2, label: "progressing", probabilities: { progressing: 0.3 }, confidence: 0.3 },
          stuck: { value: false, probability: 0.4 },
          needsHuman: { value: true, probability: 0.6 }
        }),
        "gray",
        "health uncertain"
      ],
      ["parked on a permission", facts({ parked: "permission" }), answers(), "red", "waiting for approval"],
      ["parked on a question", facts({ parked: "question" }), answers(), "red", "waiting for an answer"],
      ["parked on quota", facts({ parked: "quota" }), answers(), "red", "waiting for quota"],
      ["a cap ended the run", facts({ capEnded: "read-only cap" }), answers(), "red", "stopped: read-only cap"],
      [
        "needs a person",
        facts(),
        answers({ needsHuman: { value: true, probability: 0.82 } }),
        "red",
        "needs you (82%)"
      ],
      ["stuck", facts(), answers({ stuck: { value: true, probability: 0.66 } }), "yellow", "repeating itself (66%)"],
      [
        "exploring without an edit",
        facts({ framesSinceEdit: 4 }),
        answers({ progress: { value: 1, label: "exploring", probabilities: { exploring: 0.8 }, confidence: 0.8 } }),
        "yellow",
        "exploring · 4 frames, no edit yet"
      ],
      [
        "exploring with a recent edit",
        facts({ framesSinceEdit: 3 }),
        answers({ progress: { value: 1, label: "exploring", probabilities: { exploring: 0.8 }, confidence: 0.8 } }),
        "green",
        "exploring"
      ],
      [
        "a demand this frame",
        facts({ demandThisFrame: true, demands: ["repeat"] }),
        answers(),
        "yellow",
        "repeat demanded"
      ],
      [
        "a demand this frame with no name",
        facts({ demandThisFrame: true }),
        answers(),
        "yellow",
        "discipline demanded"
      ],
      ["progressing", facts(), answers(), "green", "progressing"],
      [
        "done",
        facts({ lastTransition: "complete" }),
        answers({ progress: { value: 4, label: "done", probabilities: { done: 0.9 }, confidence: 0.9 } }),
        "green",
        "done"
      ],
      // The facts come first: a park is red even when the model sees progress.
      [
        "parked beats the answers",
        facts({ parked: "permission" }),
        answers({ stuck: { value: true, probability: 0.9 } }),
        "red",
        "waiting for approval"
      ]
    ]
    for (const [name, given, replied, color, reason] of table) {
      expect(Health.decide(given, replied), name).toEqual({ color, reason })
    }
  })

  it("dots, strips, and re-dots titles", () => {
    expect(Health.dots).toEqual({ green: "🟢", yellow: "🟡", red: "🔴", gray: "⚪" })
    expect(Health.colorOf("🟢 Fix it")).toBe("green")
    expect(Health.colorOf("Fix it")).toBeUndefined()
    expect(Health.strip("🟡 Fix it")).toBe("Fix it")
    expect(Health.strip("Fix it")).toBe("Fix it")
    expect(Health.dotted("Fix it", "red")).toBe("🔴 Fix it")
    expect(Health.dotted("⚪ Fix it", "green")).toBe("🟢 Fix it")
    expect(Health.retitle("🟢 Old", "New")).toBe("🟢 New")
    expect(Health.retitle("Old", "New")).toBe("New")
    expect(Health.retitle("🟢 Old", "🔴 Mine")).toBe("🔴 Mine")
  })

  it("evaluates through a scripted evaluator and decides", async () => {
    const evaluation = await Effect.runPromise(
      Health.evaluate(facts()).pipe(Effect.provide(Evaluator.layerScripted(script(healthy))))
    )
    expect(evaluation.decision).toEqual({ color: "green", reason: "progressing" })
    expect(evaluation.answers?.progress.label).toBe("progressing")
    expect(evaluation.error).toBeUndefined()
    expect(evaluation.usage).toBeUndefined()
    expect(Health.renderAnswers(evaluation.answers)).toBe(
      "progress: progressing (70%)\nstuck: no (10%)\nneeds a person: no (10%)"
    )
    expect(Health.renderAnswers(undefined)).toBe("no answers")
    expect(
      Health.renderAnswers(
        answers({ stuck: { value: true, probability: 0.9 }, needsHuman: { value: true, probability: 0.8 } })
      )
    )
      .toContain("stuck: yes (90%)\nneeds a person: yes (80%)")
  })

  it("goes gray, never fails, when the transport is unavailable, answers badly, or misses the deadline", async () => {
    const unavailable = await Effect.runPromise(
      Health.evaluate(facts()).pipe(Effect.provide(Evaluator.layerUnavailable()))
    )
    expect(unavailable.decision).toEqual({ color: "gray", reason: "health unavailable" })
    expect(unavailable.error).toContain("unreachable")
    expect(unavailable.answers).toBeUndefined()

    const malformed = await Effect.runPromise(
      Health.evaluate(facts()).pipe(
        Effect.provide(Evaluator.layerScripted(script({ progress: { score: 9 }, stuck: { probability: 0.1 } })))
      )
    )
    expect(malformed.decision.color).toBe("gray")
    expect(malformed.error).toContain("invalid_answer")

    const slow = await Effect.runPromise(
      Health.evaluate(facts(), 20).pipe(
        Effect.provide(
          Evaluator.layerScripted(() => Effect.map(Effect.sleep("500 millis"), () => healthy))
        )
      )
    )
    expect(slow.decision.color).toBe("gray")
    expect(slow.error).toContain("timeout")
  })

  it("picks the gateway when the key is set and the unavailable evaluator otherwise", async () => {
    const without = await Effect.runPromise(
      Effect.flatMap(Evaluator.Evaluator, (evaluator) => Effect.flip(evaluator.evaluate({ state: {}, questions: {} })))
        .pipe(Effect.provide(Health.evaluatorLayer({})))
    )
    expect(without.code).toBe("unreachable")
    expect(without.message).toBe(Health.noGatewayKey)
    expect(Health.noGatewayKey).toContain("AI_GATEWAY_API_KEY")
    const blank = await Effect.runPromise(
      Effect.flatMap(Evaluator.Evaluator, (evaluator) => Effect.flip(evaluator.evaluate({ state: {}, questions: {} })))
        .pipe(Effect.provide(Health.evaluatorLayer({ AI_GATEWAY_API_KEY: "" })))
    )
    expect(blank.code).toBe("unreachable")
    // With a key the gateway layer is built; nothing is sent until a call is made.
    const withKey = await Effect.runPromise(
      Effect.map(Evaluator.Evaluator, (evaluator) => typeof evaluator.evaluate).pipe(
        Effect.provide(Health.evaluatorLayer({ AI_GATEWAY_API_KEY: "test-key" }))
      )
    )
    expect(withKey).toBe("function")
    expect(Health.ambientEnvironment()).toBe(process.env)
  })

  it("prices Jev calls by input tokens and carries the state without the server-only facts", () => {
    expect(Health.jevCost(undefined)).toBe(0)
    expect(Health.jevCost({ inputTokens: 1_000_000, outputTokens: 5 })).toBeCloseTo(0.042)
    expect(Health.toState(facts({ demandThisFrame: true, capEnded: "x" }))).not.toHaveProperty("capEnded")
    expect(Health.classifier.id).toBe("harness/health")
    expect(Object.keys(Health.classifier.questions)).toEqual(["progress", "stuck", "needsHuman"])
    expect(Health.recordType).toBe("flows.opencode.health.v1")
  })
})

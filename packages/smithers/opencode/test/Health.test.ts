import type * as HarnessError from "@smthrs/harness/HarnessError"
import { HarnessErrorCode } from "@smthrs/harness/HarnessError"
import * as Evaluator from "@smthrs/model/Evaluator"
import { Effect, Layer } from "effect"
import { describe, expect, it } from "vitest"
import type * as Driver from "../src/Driver.ts"
import * as Health from "../src/Health.ts"

/**
 * A refusal shaped the way `EngineDriver.failedOutcome` shapes one: the seat,
 * the normalized `ModelError` code, the HTTP status, and the provider's words
 * verbatim. `Projection.test.ts` pins that the driver really builds this, and
 * that the projection turns it into the fact below.
 */
const refusal = (code: string, message: string, status: number): Driver.ProviderFailure => ({
  seat: "openai:gpt",
  providerID: "openai",
  code,
  status,
  message
})

const outOfQuota = Health.limitReached(
  refusal("quota_exceeded", "You exceeded your current quota, please check your plan and billing details.", 429)
)!

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
  stoppedBy: undefined,
  unreachable: undefined,
  endedBy: undefined,
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
      [
        "a usage limit ended the run",
        facts({ stoppedBy: outOfQuota }),
        answers(),
        "red",
        "stopped: openai:gpt is out of quota"
      ],
      [
        "a rate-limit window ended the run",
        facts({ stoppedBy: Health.limitReached(refusal("rate_limited", "Rate limit reached for gpt", 429)) }),
        answers(),
        "red",
        "stopped: openai:gpt is rate limited"
      ],
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
      // The rule may not contradict the answers it read. A run that re-read a
      // file on its way to a correct answer is not stuck, so a confident
      // `done` and a resolved turn both beat `stuck`: the live drive ended a
      // finished bug fix yellow "repeating itself (69%)" over
      // `progress: done (89%)`, and that dot is what the session kept.
      [
        "a confident done beats stuck",
        facts(),
        answers({
          progress: { value: 4, label: "done", probabilities: { done: 0.89 }, confidence: 0.89 },
          stuck: { value: true, probability: 0.69 }
        }),
        "green",
        "done"
      ],
      [
        "a resolved turn beats stuck",
        facts({ lastTransition: "complete" }),
        answers({ stuck: { value: true, probability: 0.69 } }),
        "green",
        "progressing"
      ],
      // Only a confident done. Under the floor the answer is not an answer.
      [
        "a done under the floor does not beat stuck",
        facts(),
        answers({
          progress: { value: 4, label: "done", probabilities: { done: 0.4 }, confidence: 0.4 },
          stuck: { value: true, probability: 0.69 }
        }),
        "yellow",
        "repeating itself (69%)"
      ],
      // The facts still come before the answers: a completion the harness
      // handed back is a demand, whatever Jev made of the frame.
      [
        "a demand this frame beats done",
        facts({ demandThisFrame: true, demands: ["claim"], lastTransition: "complete" }),
        answers({ progress: { value: 4, label: "done", probabilities: { done: 0.9 }, confidence: 0.9 } }),
        "yellow",
        "claim demanded"
      ],
      [
        "needing a person beats done",
        facts({ lastTransition: "complete" }),
        answers({
          progress: { value: 4, label: "done", probabilities: { done: 0.9 }, confidence: 0.9 },
          needsHuman: { value: true, probability: 0.82 }
        }),
        "red",
        "needs you (82%)"
      ],
      // The facts come first: a park is red even when the model sees progress.
      [
        "parked beats the answers",
        facts({ parked: "permission" }),
        answers({ stuck: { value: true, probability: 0.9 } }),
        "red",
        "waiting for approval"
      ],
      // And red with no Jev at all (day one: no gateway key), or with answers
      // under the floor: waiting for approval needs no judgment.
      ["parked with no answers", facts({ parked: "permission" }), undefined, "red", "waiting for approval"],
      [
        "a usage limit ended the run with no answers",
        facts({ stoppedBy: outOfQuota }),
        undefined,
        "red",
        "stopped: openai:gpt is out of quota"
      ],
      // The provider's sentence is not a contract: a refusal that is not one
      // of the limit codes is an ordinary failure, whatever words it carries.
      [
        "a refusal whose words say cap but whose code does not",
        facts({
          stoppedBy: Health.limitReached(
            refusal("provider_internal", "The concurrency cap for this account was hit", 503)
          )
        }),
        undefined,
        "gray",
        "health unavailable"
      ],
      // A run the harness ended is red before any answer is read, and the
      // reason names the rule that ended it. It used to be gray reading
      // `failed`, which is the sentence a missing gateway key writes.
      [
        "the harness could not prove the run's claim",
        facts({ endedBy: { code: "claim_unproven" } }),
        undefined,
        "red",
        "stopped: the run reported work it never recorded. Read the refused answer on the demand card, then allow the call it needs or say what to prove"
      ],
      [
        "the frame budget ended the run",
        facts({ endedBy: { code: Health.frameBudget, maxFrames: 40 } }),
        answers({ progress: { value: 2, label: "progressing", probabilities: { progressing: 0.9 }, confidence: 0.9 } }),
        "red",
        "stopped: the frame budget of 40 is exhausted. Raise it with --max-frames, or split the task"
      ],
      // A usage limit is the provider's and beats it, because what the
      // operator does about it is at the provider.
      [
        "a usage limit beats the harness code that carried it",
        facts({ stoppedBy: outOfQuota, endedBy: { code: "model_failed" } }),
        undefined,
        "red",
        "stopped: openai:gpt is out of quota"
      ],
      [
        "parked with every answer under the floor",
        facts({ parked: "question" }),
        answers({
          progress: { value: 2, label: "progressing", probabilities: { progressing: 0.3 }, confidence: 0.3 },
          stuck: { value: false, probability: 0.4 },
          needsHuman: { value: true, probability: 0.6 }
        }),
        "red",
        "waiting for an answer"
      ]
    ]
    for (const [name, given, replied, color, reason] of table) {
      expect(Health.decide(given, replied), name).toEqual({ color, reason })
    }
  })

  it("names every way the harness ends a run, and nothing it does not raise", () => {
    // Total over the harness's own codes: a code it adds is a type error
    // here, never a run that ends with no reason a person can read.
    const codes: Array<HarnessError.HarnessErrorCode> = [...HarnessErrorCode.literals]
    for (const code of codes) {
      expect(Health.endedReason({ code }), code).toBe(Health.endedReasons[code])
      expect(Health.endedReason({ code }), code).toMatch(/^stopped: /)
    }
    expect(Health.endedReason({ code: "unknown" })).toBe(
      "stopped: the turn failed. Send the prompt again, and read the message on the answer for what happened"
    )
    // The budget raises nothing, so it has a code of its own and a reason
    // that names the number the operator raises.
    expect(Health.endedReason({ code: Health.frameBudget, maxFrames: 40 })).toBe(
      "stopped: the frame budget of 40 is exhausted. Raise it with --max-frames, or split the task"
    )
    // Every one of them names what to do next as well as what happened: a
    // sentence that stops at the fault leaves the person to work the rest
    // out, and the dot is where they read it.
    const remedied = /^stopped: [^.]+\. [A-Z][^.]+$/
    for (const [code, reason] of Object.entries(Health.endedReasons)) expect(reason, code).toMatch(remedied)
    expect(Health.endedReason({ code: Health.frameBudget, maxFrames: 40 })).toMatch(remedied)
  })

  it("keeps one missed deadline off the dot and says so when three are missed running", () => {
    // 1500 ms is five times Jev's measured answer and the retry already
    // gives a blip a second chance inside it, so the deadline is not what is
    // wrong; calling one missing measurement "unavailable" is.
    expect(Health.deadlineMs).toBe(1500)
    expect(Health.deadlineMisses).toBe(3)
    expect(Health.missedDeadlines(3)).toBe("health unavailable: Jev missed its 1500 ms deadline 3 times running")
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
  })

  it("normalises a rename that arrives with a dot: the session's own color leads, never the typed dot", () => {
    // The hosted app echoes the dotted title back on a rename, with U+FE0F
    // after the dot. Stored verbatim, the echo carried the app's dot, and the
    // next color change put the server's dot in front of it.
    expect(Health.retitle("⚪ Say B", "⚪\uFE0F Renamed")).toBe("⚪ Renamed")
    expect(Health.retitle("⚪ Say B", "⚪ Renamed")).toBe("⚪ Renamed")
    expect(Health.retitle("🟢 Old", "🔴 X")).toBe("🟢 X")
    expect(Health.retitle("🟢 Old", "🔴\uFE0F X")).toBe("🟢 X")
    // A session with no color yet stores the words alone: the dot is the
    // server's to add when it has a decision.
    expect(Health.retitle("Old", "🔴 X")).toBe("X")
    expect(Health.retitle("Old", "🔴\uFE0F X")).toBe("X")
    expect(Health.retitle("Old", "Plain")).toBe("Plain")
    // A rename that is only a dot keeps the current title, like an empty one.
    expect(Health.retitle("🟢 Old", "🔴")).toBe("🟢 Old")
    expect(Health.retitle("Old", "⚪\uFE0F")).toBe("Old")
    for (
      const stored of [
        Health.retitle("⚪ Say B", "⚪\uFE0F Renamed"),
        Health.retitle("🟢 Old", "🔴 X"),
        Health.retitle("Old", "🔴 X")
      ]
    ) {
      expect(Health.dotted(stored, "red").match(/[🟢🟡🔴⚪]/gu)?.length).toBe(1)
    }
  })

  it("strips the U+FE0F the app appends to the dot, and keeps the title on an empty rename", () => {
    // The hosted app writes an emoji presentation selector (U+FE0F) after
    // the dot when it echoes a title back; the dot and its selector go together.
    expect(Health.strip("🟢\uFE0F Fix it")).toBe("Fix it")
    expect(Health.strip("🟢\uFE0FFix it")).toBe("Fix it")
    expect(Health.strip("🟢\uFE0F")).toBe("")
    expect(Health.dotted("🔴\uFE0F Fix it", "green")).toBe("🟢 Fix it")
    expect(Health.retitle("🟢\uFE0F Old", "New")).toBe("🟢 New")
    // An empty rename keeps the title it would have erased, dot and all.
    expect(Health.retitle("🟢 Old", "")).toBe("🟢 Old")
    expect(Health.retitle("🟢 Old", "   ")).toBe("🟢 Old")
    expect(Health.retitle("Old", "")).toBe("Old")
  })

  it("leaves an emoji that is not one of the four dots where the person typed it", () => {
    // Only the four dots are the server's. A rocket, a check mark or a
    // yellow heart that is not the yellow dot is part of the person's own
    // words, so it survives a strip, a re-dot and a rename.
    for (const typed of ["🚀 Ship it", "✅ Done", "💛 Fix it", "🟩 Fix it", "🔵 Fix it"]) {
      expect(Health.colorOf(typed)).toBeUndefined()
      expect(Health.strip(typed)).toBe(typed)
      expect(Health.dotted(typed, "red")).toBe(`🔴 ${typed}`)
      expect(Health.retitle("🟢 Old", typed)).toBe(`🟢 ${typed}`)
      expect(Health.retitle("Old", typed)).toBe(typed)
    }
  })

  it("never doubles a dot the server owns, however many arrive", () => {
    // The app echoes a dotted title back, and a person can paste one in on
    // top of that, so the words can arrive under several dots at once. What
    // is stored carries the session's own dot, once.
    const typed = [
      "New",
      "🟢 New",
      "🔴\uFE0F New",
      "🔴 🟡 New",
      "⚪⚪⚪ New",
      "🟡\uFE0F🟢\uFE0F New"
    ]
    for (const wanted of typed) {
      for (const current of ["Old", "🟢 Old", "⚪\uFE0F Old"]) {
        const stored = Health.retitle(current, wanted)
        const dots = stored.match(/[🟢🟡🔴⚪]/gu) ?? []
        expect({ wanted, current, stored, dots: dots.length }, wanted).toMatchObject({
          dots: Health.colorOf(current) === undefined ? 0 : 1
        })
        // A colour change on top of the stored title still carries one dot.
        expect(Health.dotted(stored, "red").match(/[🟢🟡🔴⚪]/gu)?.length, wanted).toBe(1)
        expect(Health.strip(stored).startsWith("New"), wanted).toBe(true)
      }
    }
  })

  it("keeps the previous title when a rename is whitespace alone", () => {
    // A session is never left without a name: the rename is refused and the
    // title it would have erased stays, dot and all.
    for (const blank of ["", " ", "   ", "\t", "\n", " \t\n ", "🔴", "🔴\uFE0F", "🔴 ", " ⚪\uFE0F\t"]) {
      expect(Health.retitle("🟢 Old", blank), JSON.stringify(blank)).toBe("🟢 Old")
      expect(Health.retitle("Old", blank), JSON.stringify(blank)).toBe("Old")
    }
  })

  it("evaluates through a scripted evaluator and decides", async () => {
    const evaluation = await Effect.runPromise(
      Health.evaluate(facts()).pipe(Effect.provide(Evaluator.layerScripted(script(healthy))))
    )
    expect(evaluation.decision).toEqual({ color: "green", reason: "progressing" })
    expect(evaluation.answers?.progress.label).toBe("progressing")
    expect(evaluation.error).toBeUndefined()
    expect(evaluation.usage).toBeUndefined()
    expect(evaluation.answered).toBe(true)
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
    // The gray reason carries the transport's words, so the card says why
    // and, without a key, the way out.
    expect(unavailable.decision).toEqual({
      color: "gray",
      reason: "health unavailable: No evaluator is installed on this host"
    })
    expect(unavailable.error).toContain("unreachable")
    // Nothing reached the gateway, so nothing is a Jev call to count.
    expect(unavailable.answered).toBe(false)
    const noKey = await Effect.runPromise(Health.evaluate(facts()).pipe(Effect.provide(Health.evaluatorLayer({}))))
    expect(noKey.decision).toEqual({ color: "gray", reason: Health.noGatewayKey })
    expect(Health.unavailable("Health did not answer within 1500 ms")).toBe(
      "health unavailable: Health did not answer within 1500 ms"
    )
    // A parked run is red whatever the transport said.
    const parkedNoKey = await Effect.runPromise(
      Health.evaluate(facts({ parked: "permission" })).pipe(Effect.provide(Health.evaluatorLayer({})))
    )
    expect(parkedNoKey.decision).toEqual({ color: "red", reason: "waiting for approval" })
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
    expect(slow.answered).toBe(false)
    // The code travels typed beside the sentence, so a caller decides on the
    // code: `Projection.health` keeps the run's color for this one failure
    // and repaints for every other.
    expect(slow.code).toBe("timeout")
    expect(unavailable.code).toBe("unreachable")
    expect(malformed.code).toBe("invalid_answer")
    // A gateway that answered, even to refuse, took the call: an answer the
    // question's shape rejects is a 200 the gateway served.
    expect(malformed.answered).toBe(true)
  })

  it("counts a gateway that answered, judgement or refusal, and nothing that never reached it", () => {
    expect(Health.gatewayAnswered(undefined)).toBe(true)
    const codes: Array<[Evaluator.EvaluatorErrorCode, boolean]> = [
      ["refused", true],
      ["empty", true],
      ["invalid_answer", true],
      ["invalid_question", true],
      ["unreachable", false],
      ["timeout", false]
    ]
    for (const [code, answered] of codes) {
      expect(Health.gatewayAnswered(new Evaluator.EvaluatorError({ code, message: code })), code).toBe(answered)
    }
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
    expect(Health.toState(facts({ demandThisFrame: true, stoppedBy: outOfQuota }))).not.toHaveProperty("stoppedBy")
    expect(Health.limitReached(undefined)).toBeUndefined()
    expect(Health.classifier.id).toBe("harness/health")
    expect(Object.keys(Health.classifier.questions)).toEqual(["progress", "stuck", "needsHuman"])
    expect(Health.recordType).toBe("flows.opencode.health.v1")
  })
})

describe("the retry the host wraps its evaluator in", () => {
  const request: Evaluator.Request = { state: {}, questions: {} }

  const answered: Evaluator.Response = { answers: {}, latencyMs: 0 }

  const fails = (
    error: Evaluator.EvaluatorError,
    until = Number.POSITIVE_INFINITY
  ): { readonly evaluator: Evaluator.Evaluator; readonly calls: () => number } => {
    let calls = 0
    return {
      calls: () => calls,
      evaluator: Evaluator.Evaluator.of({
        evaluate: () =>
          Effect.suspend(() => {
            calls += 1
            return calls <= until ? Effect.fail(error) : Effect.succeed(answered)
          })
      })
    }
  }

  const refused = (status: number | undefined): Evaluator.EvaluatorError =>
    new Evaluator.EvaluatorError({
      code: "refused",
      ...(status === undefined ? {} : { status }),
      message: `The gateway answered ${status}`
    })

  /**
   * The numbers the docblock states, asserted here so a change to either has
   * to be a change to both: three requests, 250 ms apart, 2500 ms over each,
   * and a ceiling that is exactly three deadlines plus the two waits, so the
   * budget never truncates a request the attempt count allows.
   */
  it("is three requests, 250 ms apart, 2500 ms each, inside an 8 s ceiling", () => {
    expect(Health.evaluatorRetry).toEqual({ attempts: 3, backoffMs: 250, deadlineMs: 2500, budgetMs: 8000 })
    expect(
      Health.evaluatorRetry.attempts * Health.evaluatorRetry.deadlineMs +
        (Health.evaluatorRetry.attempts - 1) * Health.evaluatorRetry.backoffMs
    ).toBe(Health.evaluatorRetry.budgetMs)
  })

  it("asks again for a blip and never for an answer that will not change", () => {
    expect(Health.retryable(new Evaluator.EvaluatorError({ code: "unreachable", message: "no route" }))).toBe(true)
    expect(Health.retryable(new Evaluator.EvaluatorError({ code: "timeout", message: "too slow" }))).toBe(true)
    expect(Health.retryable(refused(429))).toBe(true)
    expect(Health.retryable(refused(500))).toBe(true)
    expect(Health.retryable(refused(503))).toBe(true)
    expect(Health.retryable(refused(401))).toBe(false)
    expect(Health.retryable(refused(403))).toBe(false)
    expect(Health.retryable(refused(404))).toBe(false)
    expect(Health.retryable(refused(undefined))).toBe(false)
    expect(Health.retryable(new Evaluator.EvaluatorError({ code: "empty", message: "no answers" }))).toBe(false)
    expect(Health.retryable(new Evaluator.EvaluatorError({ code: "invalid_answer", message: "bad shape" })))
      .toBe(false)
    expect(Health.retryable(new Evaluator.EvaluatorError({ code: "invalid_question", message: "bad question" })))
      .toBe(false)
  })

  it("answers on the second request when the first one blipped, and asks nothing more", async () => {
    const once = fails(refused(429), 1)
    const response = await Effect.runPromise(
      Health.retrying(once.evaluator, { ...Health.evaluatorRetry, backoffMs: 1 }).evaluate(request)
    )
    expect(response).toBe(answered)
    expect(once.calls()).toBe(2)
  })

  it("makes no second request when nothing is wrong", async () => {
    const never = fails(refused(429), 0)
    await Effect.runPromise(Health.retrying(never.evaluator).evaluate(request))
    expect(never.calls()).toBe(1)
  })

  it("stops at the documented count and fails with the last reason, rather than spinning", async () => {
    const always = fails(refused(503))
    const error = await Effect.runPromise(
      Effect.flip(Health.retrying(always.evaluator, { ...Health.evaluatorRetry, backoffMs: 1 }).evaluate(request))
    )
    expect(always.calls()).toBe(Health.evaluatorRetry.attempts)
    expect(error.code).toBe("refused")
    expect(error.status).toBe(503)
    expect(error.message).toBe("The gateway answered 503")
  })

  it("does not ask a second time after a key the gateway rejected", async () => {
    const unauthorized = fails(refused(401))
    const error = await Effect.runPromise(Effect.flip(Health.retrying(unauthorized.evaluator).evaluate(request)))
    expect(unauthorized.calls()).toBe(1)
    expect(error.status).toBe(401)
  })

  /**
   * The ceiling outranks the count: a policy whose budget cannot pay for a
   * wait plus another full deadline stops after the first request, with that
   * request's own reason, rather than starting one it would have to cut off.
   */
  it("starts no request the ceiling cannot pay the deadline for", async () => {
    const always = fails(new Evaluator.EvaluatorError({ code: "unreachable", message: "no route" }))
    const error = await Effect.runPromise(
      Effect.flip(
        Health.retrying(always.evaluator, { attempts: 5, backoffMs: 1, deadlineMs: 2500, budgetMs: 100 })
          .evaluate(request)
      )
    )
    expect(always.calls()).toBe(1)
    expect(error.code).toBe("unreachable")
  })

  it("wraps the layer a host binds, and leaves the keyless arm asking once", async () => {
    const always = fails(refused(502))
    const wrapped = Health.retryingLayer(
      Layer.succeed(Evaluator.Evaluator)(always.evaluator),
      { ...Health.evaluatorRetry, backoffMs: 1 }
    )
    const error = await Effect.runPromise(
      Effect.flatMap(Evaluator.Evaluator, (evaluator) => Effect.flip(evaluator.evaluate(request)))
        .pipe(Effect.provide(wrapped))
    )
    expect(error.status).toBe(502)
    expect(always.calls()).toBe(Health.evaluatorRetry.attempts)

    // Without a key there is nothing to ask again: the refusal is the key,
    // so a health frame pays one refusal and not three plus two waits.
    let keyless = 0
    const counted = Layer.succeed(Evaluator.Evaluator)(
      Evaluator.Evaluator.of({
        evaluate: () =>
          Effect.suspend(() => {
            keyless += 1
            return Effect.fail(new Evaluator.EvaluatorError({ code: "unreachable", message: Health.noGatewayKey }))
          })
      })
    )
    await Effect.runPromise(
      Effect.flatMap(Evaluator.Evaluator, (evaluator) => Effect.flip(evaluator.evaluate(request)))
        .pipe(Effect.provide(counted))
    )
    expect(keyless).toBe(1)
    const noKey = await Effect.runPromise(Health.evaluate(facts()).pipe(Effect.provide(Health.evaluatorLayer({}))))
    expect(noKey.decision.reason).toBe(Health.noGatewayKey)
  })
})

import * as Classifier from "@smthrs/model/Classifier"
import * as Evaluator from "@smthrs/model/Evaluator"
import { Effect, Layer, Result, Schema } from "effect"
import { describe, expect, it } from "vitest"
import * as Classifiers from "../src/Classifiers.ts"
import * as Classify from "../src/Classify.ts"

const questions = {
  relevant: { type: "boolean", instructions: "Does this file need to change?" },
  role: {
    type: "choice",
    instructions: "What is this file's role?",
    criteria: { implementation: "code under test", fixture: "test data", unrelated: "nothing to do with it" }
  },
  risk: { type: "score", instructions: "How risky is editing it?", criteria: ["none", "low", "medium", "high"] }
} as const

const answersFor = (file: string): Readonly<Record<string, Evaluator.ScriptedAnswer>> => ({
  relevant: { probability: file.endsWith(".py") ? 0.94 : 0.08 },
  role: { choice: "implementation", probabilities: { implementation: 0.8, fixture: 0.15, unrelated: 0.05 } },
  risk: { score: 1, probabilities: { none: 0.1, low: 0.7, medium: 0.15, high: 0.05 } }
})

const scripted = (script: Evaluator.Script): Layer.Layer<Evaluator.Evaluator> => Evaluator.layerScripted(script)

const byFile = scripted((request) => answersFor((request.state as { readonly file: string }).file))

const metered = (
  layer: Layer.Layer<Evaluator.Evaluator>,
  usageFor: (request: Evaluator.Request) => Evaluator.Usage | undefined
): Layer.Layer<Evaluator.Evaluator> =>
  Layer.effect(
    Evaluator.Evaluator,
    Effect.gen(function*() {
      const evaluator = yield* Evaluator.Evaluator
      return Evaluator.Evaluator.of({
        evaluate: (request) =>
          evaluator.evaluate(request).pipe(Effect.map((response) => {
            const usage = usageFor(request)
            return { ...response, ...(usage === undefined ? {} : { usage }) }
          }))
      })
    })
  ).pipe(Layer.provide(layer))

const decodeInput = Schema.decodeUnknownResult(Classify.Input)

const run = <A, E>(effect: Effect.Effect<A, E, Evaluator.Evaluator>, layer: Layer.Layer<Evaluator.Evaluator>) =>
  Effect.runPromise(effect.pipe(Effect.result, Effect.provide(layer)))

const success = <A, E>(result: Result.Result<A, E>): A => {
  if (Result.isFailure(result)) throw new Error(`Expected a success, got ${JSON.stringify(result.failure)}`)
  return result.success
}

const failure = <A, E>(result: Result.Result<A, E>): E => {
  if (Result.isSuccess(result)) throw new Error(`Expected a failure, got ${JSON.stringify(result.success)}`)
  return result.failure
}

const messageOf = (result: Result.Result<unknown, { readonly message: string }>): string => failure(result).message

describe("Classify declaration", () => {
  it("declares a sealed model call that touches nothing on the tree", () => {
    expect(Classify.name).toBe("classify")
    expect(Classify.flow.name).toBe("classify")
    expect(Classify.description.split("\n")).toHaveLength(1)
    expect(Classify.capabilities).toEqual(["model:call:*"])
    expect(Classify.effects).toMatchObject({ tier: "sealed", mode: "expected", reads: [], writes: [] })
    expect(Classify.effectsFor({ state: 1, questions })).toBe(Classify.effects)
    expect([Classify.MAX_STATES, Classify.MAX_STATE_BYTES, Classify.CONCURRENCY]).toEqual([64, 32 * 1024, 8])
  })

  it("describes every model-facing input and output field", () => {
    const described = (schema: Schema.Top): ReadonlyArray<string> => {
      const document = JSON.stringify(Schema.toJsonSchemaDocument(schema))
      return [...document.matchAll(/"description":"([^"]+)"/g)].map((match) => match[1]!)
    }
    const input = described(Classify.Input).join("\n")
    for (const needle of ["JSON value", "Up to 64 states", "Questions keyed by id"]) expect(input).toContain(needle)
    const output = described(Classify.Output).join("\n")
    for (
      const needle of [
        "One answer per question id",
        "How sure each answer is",
        "Wall-clock milliseconds the evaluation took",
        "Wall-clock milliseconds the whole batch took",
        "One entry per state"
      ]
    ) {
      expect(output).toContain(needle)
    }
  })

  it("refuses more than 64 states, no states, an oversized state, and no questions", () => {
    const state = { file: "a.py" }
    expect(messageOf(decodeInput({ states: Array.from({ length: 65 }, () => state), questions }))).toContain(
      "at most 64"
    )
    expect(messageOf(decodeInput({ states: [], questions }))).toContain("at least 1")
    expect(messageOf(decodeInput({ state: "x".repeat(32 * 1024), questions }))).toContain("at most 32768 bytes")
    expect(messageOf(decodeInput({ state, questions: {} }))).toContain("at least one question")
    expect(
      messageOf(decodeInput({ state, questions: { q: { type: "choice", instructions: "?", criteria: { a: "a" } } } }))
    )
      .toContain("between 2 and 255")
  })

  it("accepts exactly 64 states and a state of exactly 32 KiB", () => {
    const state = { file: "a.py" }
    expect(Result.isSuccess(decodeInput({ states: Array.from({ length: 64 }, () => state), questions }))).toBe(true)
    // Two quotes wrap the JSON string, so the payload is two bytes short of the cap.
    expect(Result.isSuccess(decodeInput({ state: "x".repeat(32 * 1024 - 2), questions }))).toBe(true)
  })
})

describe("Classify.run", () => {
  it.each(["ad-hoc", "curated"])("preserves reported usage through the %s output schema", async (door) => {
    const state = { task: "fix the parser", file: "src/Parser.ts", excerpt: "export const parse = ..." }
    const usage = { inputTokens: 1200, outputTokens: 4 }
    const request = door === "ad-hoc"
      ? Classify.run({ state, questions })
      : Classify.curated(Classifiers.relevance).run(state)
    const output = success(await run(request, metered(byFile, () => usage)))
    expect(output).toMatchObject({ usage })
    expect(Schema.decodeUnknownSync(Classify.Output)(output)).toMatchObject({ usage })
  })

  it("sums usage reported by successful batch states without inventing usage for the rest", async () => {
    const layer = scripted((request) => {
      const file = (request.state as { readonly file: string }).file
      return file === "broken.py"
        ? Effect.fail(new Evaluator.EvaluatorError({ code: "timeout", message: "No answer" }))
        : answersFor(file)
    })
    const states = ["one.py", "broken.py", "unmetered.py", "two.py"].map((file) => ({ file }))
    const usageFor = (request: Evaluator.Request) => {
      const file = (request.state as { readonly file: string }).file
      return file === "one.py" ?
        { inputTokens: 100, outputTokens: 2 }
        : file === "two.py" ?
        { inputTokens: 300, outputTokens: 6 }
        : undefined
    }
    const output = success(await run(Classify.run({ states, questions }), metered(layer, usageFor)))
    expect(output).toMatchObject({ usage: { inputTokens: 400, outputTokens: 8 } })
    expect(Schema.decodeUnknownSync(Classify.Output)(output)).toMatchObject({
      usage: { inputTokens: 400, outputTokens: 8 }
    })
    expect("results" in output && output.results.map((result) => result.ok)).toEqual([true, false, true, true])
    const unmetered = success(await run(Classify.run({ states, questions }), layer))
    expect(unmetered).not.toHaveProperty("usage")
  })

  it("answers one state with decoded answers, a confidence per question, and the latency", async () => {
    const verdict = success(await run(Classify.run({ state: { file: "widen.py" }, questions }), byFile))
    expect("answers" in verdict).toBe(true)
    if (!("answers" in verdict)) return
    expect(verdict.answers).toEqual({
      relevant: { value: true, probability: 0.94 },
      role: {
        value: "implementation",
        probabilities: { implementation: 0.8, fixture: 0.15, unrelated: 0.05 },
        confidence: 0.8
      },
      risk: {
        value: 1,
        label: "low",
        probabilities: { none: 0.1, low: 0.7, medium: 0.15, high: 0.05 },
        confidence: 0.7
      }
    })
    expect(verdict.confidence.relevant).toBeCloseTo(0.88)
    expect(verdict.confidence).toMatchObject({ role: 0.8, risk: 0.7 })
    expect(verdict.latencyMs).toBe(0)
  })

  it("answers a batch in order, keeping a failed state beside its neighbours", async () => {
    const layer = scripted((request) => {
      const file = (request.state as { readonly file: string }).file
      return file === "broken.py"
        ? Effect.fail(new Evaluator.EvaluatorError({ code: "timeout", message: "The gateway did not answer" }))
        : answersFor(file)
    })
    const states = [{ file: "widen.py" }, { file: "broken.py" }, { file: "README.md" }]
    const output = success(await run(Classify.run({ states, questions }), layer))
    expect("results" in output).toBe(true)
    if (!("results" in output)) return
    expect(output.results.map((result) => result.ok)).toEqual([true, false, true])
    expect(output.results.map((result) => result.state)).toEqual(states)
    expect(output.results[0]).toMatchObject({
      ok: true,
      answers: { relevant: { value: true, probability: 0.94 } },
      confidence: { role: 0.8 }
    })
    expect(output.results[1]).toEqual({
      ok: false,
      state: { file: "broken.py" },
      error: { code: "timeout", message: "The gateway did not answer" }
    })
    expect(output.results[2]).toMatchObject({ ok: true, answers: { relevant: { value: false, probability: 0.08 } } })
    expect(output.latencyMs).toBeGreaterThanOrEqual(0)
  })

  it("keeps at most 8 states in flight", async () => {
    let inFlight = 0
    let peak = 0
    const layer = scripted(() =>
      Effect.gen(function*() {
        inFlight += 1
        peak = Math.max(peak, inFlight)
        yield* Effect.sleep("5 millis")
        inFlight -= 1
        return answersFor("a.py")
      })
    )
    const states = Array.from({ length: 20 }, (_, index) => ({ file: `${index}.py` }))
    const output = success(await run(Classify.run({ states, questions }), layer))
    expect("results" in output && output.results.length).toBe(20)
    expect(peak).toBe(Classify.CONCURRENCY)
    // The batch times itself. Three waves of 8 sleeping 5 ms each cannot
    // report the 1 ms a card used to show for every batch.
    expect("latencyMs" in output && output.latencyMs).toBeGreaterThanOrEqual(5)
  })

  it("refuses the whole call when no state at all was answered", async () => {
    const states = [{ file: "a.py" }, { file: "b.py" }]
    const error = failure(await run(Classify.run({ states, questions }), Evaluator.layerUnavailable()))
    expect(error).toBeInstanceOf(Classifier.ClassifierError)
    expect(error).toMatchObject({ code: "unreachable", message: "No evaluator is installed on this host" })
    const single = failure(
      await run(Classify.run({ state: { file: "a.py" }, questions }), Evaluator.layerUnavailable())
    )
    expect(single).toMatchObject({ code: "unreachable" })
  })

  it("carries the gateway's status when it refused", async () => {
    const layer = scripted(() =>
      Effect.fail(new Evaluator.EvaluatorError({ code: "refused", status: 503, message: "The gateway answered 503" }))
    )
    const error = failure(await run(Classify.run({ state: { file: "a.py" }, questions }), layer))
    expect(error).toMatchObject({ code: "refused", status: 503, message: "The gateway answered 503" })
  })

  it("fails as invalid_answer when the transport answers the wrong shape or nothing", async () => {
    const wrongShape = scripted(() => ({
      relevant: { choice: "yes" },
      role: { choice: "fixture" },
      risk: { score: 0 }
    }))
    expect(failure(await run(Classify.run({ state: 1, questions }), wrongShape))).toMatchObject({
      code: "invalid_answer"
    })
    const missing = scripted(() => ({ relevant: { probability: 0.5 } }))
    expect(failure(await run(Classify.run({ state: 1, questions }), missing))).toMatchObject({
      code: "invalid_answer",
      message: "Answer to \"role\": the transport answered nothing"
    })
  })
})

describe("Classify.curated", () => {
  const curated = Classify.curated(Classifiers.relevance)
  const state = { task: "fix the parser", file: "src/Parser.ts", excerpt: "export const parse = ..." }
  const decodeCurated = Schema.decodeUnknownResult(curated.flow.input)

  it("names the flow after the classifier and carries its description and digest", () => {
    expect(curated.name).toBe("classify/triage/relevance")
    expect(curated.flow.name).toBe("classify/triage/relevance")
    expect(curated.flow.description).toContain(Classifiers.relevance.description)
    expect(curated.digest).toBe(Classifiers.relevance.digest)
    expect(curated.flow.capabilities).toEqual(Classify.capabilities)
    expect(curated.flow.effects).toBe(Classify.effects)
  })

  it("tells the catalog every question id, each answer's shape, and the batch shape", () => {
    // A cell writes `c.answers.role.value` from the catalog alone; the ids
    // and shapes come from the declared questions, so they cannot drift.
    expect(curated.flow.description).toBe(
      `${Classifiers.relevance.description} Answers: relevant boolean { value, probability }; role choice implementation|fixture|unrelated { value, probabilities, confidence }; risk score none<low<medium<high { value, label, probabilities, confidence }. Batch { states: [...] } returns { results: [{ ok: true, state, answers, confidence } | { ok: false, state, error: { code, message } }], latencyMs }.`
    )
    for (const classifier of Classifiers.all) {
      const description = Classify.curated(classifier).flow.description ?? ""
      for (const id of Object.keys(classifier.questions)) expect(description, classifier.id).toContain(`${id} `)
    }
    // The ad-hoc door keeps a short description (Tiers pins 200 characters)
    // and says the shapes on the input schema the catalog prints instead.
    const adHoc = JSON.stringify(Schema.toJsonSchemaDocument(Classify.Input, { onExcessProperty: "error" }))
    expect(adHoc).toContain("answers { value, probability }")
    expect(adHoc).toContain("answers { value, probabilities, confidence }")
    expect(adHoc).toContain("answers { value, label, probabilities, confidence }")
    expect(adHoc).toContain(
      "returns { results: [{ ok: true, state, answers, confidence } | { ok: false, state, error: { code, message } }], latencyMs }"
    )
    expect(adHoc).toContain("returns { answers, confidence, latencyMs }")
  })

  it("declares the union it decodes with, and says the byte limit on every state the catalog shows", () => {
    // `flow.input` is the schema the binding decodes calls with, not a
    // `Schema.Unknown` stand-in, so a host reading it sees both branches.
    const document = Schema.toJsonSchemaDocument(curated.flow.input, { onExcessProperty: "error" }).schema as {
      readonly anyOf: ReadonlyArray<{
        readonly description?: string
        readonly properties: Readonly<Record<string, { readonly items?: { readonly description?: string } }>>
      }>
    }
    expect(document.anyOf).toHaveLength(2)
    expect(document.anyOf[0]!.properties.states!.items!.description).toBe(
      "One state to judge, at most 32768 bytes as JSON"
    )
    expect(document.anyOf[1]!.description).toBe("One state to judge, at most 32768 bytes as JSON")
    // A host's own state description survives, with the limit appended.
    const described = Classify.curated(
      Classifier.make("test/described", {
        description: "A state the host described.",
        state: Schema.Struct({ a: Schema.String }).annotate({ description: "One host state" }),
        questions: { ok: Classifier.boolean({ instructions: "Is it?" }) }
      })
    )
    const own = Schema.toJsonSchemaDocument(described.flow.input).schema as {
      readonly anyOf: ReadonlyArray<{ readonly description?: string }>
    }
    expect(own.anyOf[1]!.description).toBe("One host state, at most 32768 bytes as JSON")
  })

  it("accepts the classifier's state or a batch of them, and refuses anything else", () => {
    expect(success(decodeCurated(state))).toEqual(state)
    expect(success(decodeCurated({ states: [state, state] }))).toEqual({ states: [state, state] })
    expect(messageOf(decodeCurated({ states: Array.from({ length: 65 }, () => state) }))).toContain("at most 64")
    expect(messageOf(decodeCurated({ states: [] }))).toContain("at least 1")
    expect(messageOf(decodeCurated({ ...state, excerpt: "x".repeat(32 * 1024) }))).toContain("at most 32768 bytes")
    expect(Result.isFailure(decodeCurated({ file: "only" }))).toBe(true)
  })

  it("answers one state and a batch through the classifier's questions", async () => {
    const single = success(await run(curated.run(state), byFile))
    expect(single).toMatchObject({
      answers: { relevant: { value: false, probability: 0.08 }, role: { value: "implementation" } },
      latencyMs: 0
    })
    const batch = success(await run(curated.run({ states: [state, { ...state, file: "a.py" }] }), byFile))
    expect("results" in batch && batch.results.map((result) => result.ok)).toEqual([true, true])
    expect("results" in batch && batch.results[1]).toMatchObject({
      state: { file: "a.py" },
      answers: { relevant: { value: true } }
    })
  })

  it("fails as invalid_question when the state does not encode", async () => {
    const strict = Classify.curated(
      Classifier.make("test/strict", {
        description: "A state the schema refuses to encode.",
        state: Schema.String.check(Schema.isMinLength(3)),
        questions: { ok: Classifier.boolean({ instructions: "Is it?" }) }
      })
    )
    const layer = scripted(() => ({ ok: { probability: 1 } }))
    expect(failure(await run(strict.run("ab"), layer))).toMatchObject({ code: "invalid_question" })
    expect(failure(await run(strict.run({ states: ["abc", "ab"] }), layer))).toMatchObject({ code: "invalid_question" })
    expect(success(await run(strict.run("abc"), layer))).toMatchObject({ answers: { ok: { value: true } } })
  })

  it("bounds the encoded state while allowing non-JSON decoded values", async () => {
    const transformed = Classify.curated(Classifier.make("test/bigint", {
      description: "A bigint encoded as a JSON string.",
      state: Schema.Struct({ count: Schema.BigIntFromString }),
      questions: { ok: Classifier.boolean({ instructions: "Is it positive?" }) }
    }))
    const decode = Schema.decodeUnknownResult(transformed.flow.input)
    const seen: Array<unknown> = []
    const layer = scripted((request) => {
      seen.push(request.state)
      return { ok: { probability: 1 } }
    })
    const single = success(decode({ count: "12" }))
    const batch = success(decode({ states: [{ count: "12" }, { count: "13" }] }))

    expect(single).toEqual({ count: 12n })
    expect(success(await run(transformed.run(single), layer))).toMatchObject({ answers: { ok: { value: true } } })
    const result = success(await run(transformed.run(batch), layer))
    expect("results" in result && result.results.map((entry) => entry.state)).toEqual([{ count: "12" }, {
      count: "13"
    }])
    expect(seen).toEqual([{ count: "12" }, { count: "12" }, { count: "13" }])
    expect(messageOf(decode({ count: "1".repeat(Classify.MAX_STATE_BYTES) }))).toContain("at most 32768 bytes")
  })

  it("refuses a classifier whose state declares a states field", () => {
    const clashing = Classifier.make("test/clash", {
      description: "A state that looks like a batch.",
      state: Schema.Struct({ states: Schema.Array(Schema.String) }),
      questions: { ok: Classifier.boolean({ instructions: "Is it?" }) }
    })
    expect(() => Classify.curated(clashing)).toThrow(
      new TypeError("Classifier test/clash declares a state field named \"states\", which the batch input reserves")
    )
  })
})

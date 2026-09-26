/**
 * Compaction marks: what pins fix, how Jev's two answers resolve into keep,
 * squash or remove, and how a reading is asked. Every transport is scripted.
 */
import * as Evaluator from "@smthrs/model/Evaluator"
import * as ModelRequest from "@smthrs/model/ModelRequest"
import { Effect, Layer, Result, Schema } from "effect"
import { describe, expect, it } from "vitest"
import * as Compaction from "../src/Compaction.ts"
import * as ContextWindow from "../src/ContextWindow.ts"
import * as bytes from "../src/internal/bytes.ts"
import * as Marks from "../src/internal/compactionMarks.ts"

const turn = (text: string, kind: ContextWindow.SegmentKind = "transcript") =>
  ContextWindow.makeSegment({ kind, zone: "tail", content: [ModelRequest.Message.assistant(text)] })

const call = (id: string) =>
  ContextWindow.makeSegment({
    kind: "transcript",
    zone: "tail",
    content: [
      ModelRequest.Message.assistant(ModelRequest.ToolCallPart.make({ id, name: "read", arguments: "{}" }), {
        stopReason: "tool-calls"
      })
    ]
  })

const result = (id: string, kind: ContextWindow.SegmentKind = "transcript") =>
  ContextWindow.makeSegment({
    kind,
    zone: "tail",
    content: [ModelRequest.Message.tool(ModelRequest.ToolResultPart.make({ toolCallId: id, content: "ok" }))]
  })

const fact = (overrides: Partial<Marks.Facts> = {}): Marks.Facts => ({
  frame: 1,
  person: false,
  mutated: false,
  checks: [],
  ...overrides
})

const roomy = (n: number): Marks.Budget => ({
  contextWindow: 1_000_000,
  reserve: 0,
  keepRecent: 0,
  suffix: 0,
  tokens: Array.from({ length: n }, () => 10)
})

const resolved = (
  answers: ReadonlyArray<Marks.Answer>,
  pinned: ReadonlyArray<Marks.Pin | undefined>,
  budget: Marks.Budget = roomy(pinned.length)
) => Result.getOrThrow(Marks.resolve(answers, pinned, budget))

const item = (cell: string, size = 0): Marks.Item => ({
  tokens: 10,
  cell,
  prose: "p".repeat(size),
  observed: "o".repeat(size)
})

interface Sent {
  readonly context: Marks.Context
  readonly items: ReadonlyArray<Marks.Item>
}

/** Answers each item with the probabilities `ps` gives its cell, recording every request. */
const scripted = (
  ps: (cell: string) => Marks.Answer,
  fail: (request: number) => Evaluator.EvaluatorError | undefined = () => undefined
) => {
  const asked: Array<Evaluator.Request> = []
  const layer = Layer.succeed(Evaluator.Evaluator)(
    Evaluator.Evaluator.of({
      evaluate: (request) => {
        asked.push(request)
        const failed = fail(asked.length)
        if (failed !== undefined) return Effect.fail(failed)
        const sent = request.state as unknown as Sent
        return Effect.succeed({
          answers: Object.fromEntries(sent.items.flatMap(({ cell }, index) => {
            const answer = ps(cell)
            return [
              [`remove_${index}`, { type: "boolean" as const, probability: answer.remove }],
              [`keep_${index}`, { type: "boolean" as const, probability: answer.keep }]
            ]
          })),
          latencyMs: 1
        })
      }
    })
  )
  return { asked, layer }
}

const context: Marks.Context = { task: "Fix the parser.", failing: ["parser"] }

describe("pins", () => {
  it("squashes a summary and keeps steering, the person's messages and a failing check", () => {
    const segments = [turn("s", "summary"), turn("n", "steering"), turn("p"), turn("f"), turn("x"), turn("y")]
    const facts = [
      undefined,
      undefined,
      fact({ person: true }),
      fact({ checks: ["lint", "parser"] }),
      fact({
        checks: ["lint"]
      })
    ]
    expect(Marks.pins(segments, 6, facts, ["parser"])).toEqual([
      { mark: "squash", pin: "summary" },
      { mark: "keep", pin: "steering" },
      { mark: "keep", pin: "person" },
      { mark: "keep", pin: "failing" },
      undefined,
      undefined
    ])
  })

  it("keeps only the newest run of each failing check", () => {
    const segments = [turn("a"), turn("b"), turn("c"), turn("d")]
    const facts = [fact({ checks: ["parser"] }), fact({ checks: ["parser"] }), fact({ checks: ["lint"] }), fact()]
    expect(Marks.pins(segments, 4, facts, ["parser", "lint"])).toEqual([
      undefined,
      { mark: "keep", pin: "failing" },
      { mark: "keep", pin: "failing" },
      undefined
    ])
    // The newest run is past the prefix, so no prefix segment is kept for it.
    expect(Marks.pins(segments, 1, facts, ["parser"])).toEqual([undefined])
  })

  it("never removes a frame that changed files, however sure Jev is", () => {
    const pinned = Marks.pins([turn("m")], 1, [fact({ mutated: true })], [])
    expect(pinned).toEqual([{ floor: "squash", pin: "mutated" }])
    expect(resolved([{ remove: 0.99, keep: 0.01 }], pinned)).toEqual([{ mark: "squash", pinned: "mutated" }])
  })

  it("keeps each of two byte-identical frames' own facts", () => {
    const [a, b] = [turn("same"), turn("same")]
    expect(a.digest).toBe(b.digest)
    expect(Marks.pins([a, b], 2, [fact({ person: true }), fact()], [])).toEqual([
      { mark: "keep", pin: "person" },
      undefined
    ])
  })

  it("covers only the prefix", () => {
    expect(Marks.pins([turn("a"), turn("b", "steering")], 1, [], [])).toEqual([undefined])
  })

  it("unifies a tool call and its result in another segment", () => {
    const pinned = Marks.pins([turn("a"), call("c1"), turn("b"), result("c1")], 4, [], [])
    expect(pinned).toEqual([undefined, { pin: "pair", pair: 1 }, { pin: "pair", pair: 1 }, { pin: "pair", pair: 1 }])
    const marks = resolved(
      [{ remove: 0, keep: 0 }, { remove: 0, keep: 0.9 }, { remove: 0, keep: 0 }, { remove: 0.99, keep: 0.1 }],
      pinned
    )
    expect(marks.map(({ mark }) => mark)).toEqual(["squash", "keep", "keep", "keep"])
    expect(marks[3]).toEqual({ mark: "keep", pinned: "pair" })
    expect(marks[1]).toEqual({ mark: "keep" })
  })

  it("lifts the earlier half of a span to the later half's mark", () => {
    const pinned = Marks.pins([call("c1"), result("c1")], 2, [], [])
    expect(resolved([{ remove: 0.9, keep: 0 }, { remove: 0, keep: 0.2 }], pinned)).toEqual([
      { mark: "squash", pinned: "pair" },
      { mark: "squash" }
    ])
  })

  it("keeps a whole span when one half is pinned keep", () => {
    expect(Marks.pins([call("c1"), result("c1")], 2, [fact({ person: true }), fact()], [])).toEqual([
      { mark: "keep", pin: "person", pair: 0 },
      { mark: "keep", pin: "pair", pair: 0 }
    ])
  })

  it("lifts a span to its strongest floor", () => {
    expect(Marks.pins([call("c1"), result("c1")], 2, [fact(), fact({ mutated: true })], [])).toEqual([
      { floor: "squash", pin: "pair", pair: 0 },
      { floor: "squash", pin: "mutated", pair: 0 }
    ])
    expect(Marks.pins([result("c1", "summary"), call("c1")], 2, [], [])).toEqual([
      { mark: "squash", pin: "summary", pair: 0 },
      { floor: "squash", pin: "pair", pair: 0 }
    ])
  })

  it("asks only about unpinned items", async () => {
    const segments = [turn("s", "summary"), turn("a"), turn("n", "steering"), turn("b")]
    const pinned = Marks.pins(segments, 4, [undefined, fact(), undefined, fact({ mutated: true })], [])
    const open = Marks.unpinned(pinned)
    expect(open).toEqual([1, 3])
    const jev = scripted(() => ({ remove: 0.1, keep: 0.1 }))
    await Effect.runPromise(
      Marks.read(context, open.map((index) => item(`frame ${index}`))).pipe(
        Effect.provide(jev.layer)
      )
    )
    expect(Object.keys(jev.asked[0]!.questions)).toEqual(["remove_0", "keep_0", "remove_1", "keep_1"])
    expect((jev.asked[0]!.state as unknown as Sent).items.map(({ cell }) => cell)).toEqual(["frame 1", "frame 3"])
  })
})

describe("resolve", () => {
  const one = (answer: Marks.Answer) => resolved([answer], [undefined])[0]

  it("removes only when Jev is sure and would not keep", () => {
    expect(one({ remove: 0.79, keep: 0 })).toEqual({ mark: "squash" })
    expect(one({ remove: 0.8, keep: 0.2 })).toEqual({ mark: "remove" })
    expect(one({ remove: 0.9, keep: 0.6 })).toEqual({ mark: "keep" })
  })

  it("keeps at p(keep) = 0.5 and squashes below it", () => {
    expect(one({ remove: 0, keep: 0.49 })).toEqual({ mark: "squash" })
    expect(one({ remove: 0, keep: 0.5 })).toEqual({ mark: "keep" })
  })

  it("lets a pinned mark override Jev and a floor only raise", () => {
    expect(resolved([], [{ mark: "keep", pin: "person" }])).toEqual([{ mark: "keep", pinned: "person" }])
    expect(resolved([{ remove: 0, keep: 0.9 }], [{ floor: "squash", pin: "mutated" }])).toEqual([{ mark: "keep" }])
  })

  // Four frames of 1,000 tokens; the limit is contextWindow minus the summary allowance.
  const budget = (contextWindow: number): Marks.Budget => ({
    contextWindow,
    reserve: 1000,
    keepRecent: 2000,
    suffix: 500,
    tokens: [1000, 1000, 1000, 1000]
  })
  const answers = [0.9, 0.6, 0.6, 0.7].map((keep) => ({ remove: 0, keep }))
  const pinned = [undefined, undefined, undefined, undefined]

  it("demotes the least-sure keeps first, the older on a tie, until the kept frames fit", () => {
    // limit = cw - 1000 - 1000; kept + 500 + 4000 must fit.
    expect(Result.getOrThrow(Marks.resolve(answers, pinned, budget(10_500)))).toEqual([
      { mark: "keep" },
      { mark: "keep" },
      { mark: "keep" },
      { mark: "keep" }
    ])
    expect(Result.getOrThrow(Marks.resolve(answers, pinned, budget(10_499)))).toEqual([
      { mark: "keep" },
      { mark: "squash", pinned: "budget" },
      { mark: "keep" },
      { mark: "keep" }
    ])
    expect(Result.getOrThrow(Marks.resolve(answers, pinned, budget(8_500)))).toEqual([
      { mark: "keep" },
      { mark: "squash", pinned: "budget" },
      { mark: "squash", pinned: "budget" },
      { mark: "keep" }
    ])
  })

  it("never demotes a pin, even past the budget", () => {
    const all = [{ mark: "keep", pin: "person" }, { mark: "keep", pin: "steering" }] as const
    expect(Result.getOrThrow(Marks.resolve([], all, { ...budget(0), tokens: [1000, 1000] }))).toEqual([
      { mark: "keep", pinned: "person" },
      { mark: "keep", pinned: "steering" }
    ])
  })

  it("demotes a tool-call span whole", () => {
    const span = Marks.pins([call("c1"), result("c1"), turn("x")], 3, [], [])
    const marks = Result.getOrThrow(
      Marks.resolve(
        [{ remove: 0, keep: 0.9 }, { remove: 0, keep: 0 }, { remove: 0, keep: 0.95 }],
        span,
        { contextWindow: 6999, reserve: 0, keepRecent: 0, suffix: 0, tokens: [1000, 1000, 1000] }
      )
    )
    expect(marks).toEqual([
      { mark: "squash", pinned: "budget" },
      { mark: "squash", pinned: "budget" },
      { mark: "keep" }
    ])
  })

  it("gives the same marks for the same answers", () => {
    const first = Marks.resolve(answers, pinned, budget(8_500))
    expect(Marks.resolve(answers, pinned, budget(8_500))).toEqual(first)
    expect(Schema.decodeUnknownSync(Schema.Array(Marks.Marked))(Result.getOrThrow(first))).toEqual(
      Result.getOrThrow(first)
    )
  })

  it("fails when the answers or tokens do not describe the prefix", () => {
    const fewer = Marks.resolve([], [undefined], roomy(1))
    expect(Result.isFailure(fewer) && fewer.failure).toBeInstanceOf(Compaction.InvalidStep)
    expect(Result.isFailure(Marks.resolve([{ remove: 0, keep: 0 }], [undefined], roomy(2)))).toBe(true)
  })
})

describe("read", () => {
  it("sends cell and prose head-kept and what was observed tail-kept", async () => {
    const jev = scripted(() => ({ remove: 0.3, keep: 0.7 }))
    const big: Marks.Item = {
      tokens: 5,
      cell: "CELL" + "c".repeat(5000),
      prose: "PROSE" + "p".repeat(5000),
      observed: "o".repeat(5000) + "END"
    }
    const reading = await Effect.runPromise(Marks.read(context, [big]).pipe(Effect.provide(jev.layer)))
    const sent = (jev.asked[0]!.state as unknown as Sent).items[0]!
    for (const field of [sent.cell, sent.prose, sent.observed]) {
      expect(bytes.size(field)).toBeLessThanOrEqual(Marks.fieldBytes)
      expect(field).toContain("the run record has the whole frame")
    }
    expect(sent.cell.startsWith("CELLccc")).toBe(true)
    expect(sent.prose.startsWith("PROSEppp")).toBe(true)
    expect(sent.observed.endsWith("oooEND")).toBe(true)
    expect(reading.answers).toEqual([{ remove: 0.3, keep: 0.7 }])
    expect(reading.asked.map((asked) => asked.classifier)).toEqual(["compaction/marks"])
    expect(Marks.reader.classifierFor(1).id).toBe("compaction/marks")
  })

  it("sends a small item as it is", async () => {
    const jev = scripted(() => ({ remove: 0, keep: 0 }))
    await Effect.runPromise(Marks.read(context, [item("tiny", 3)]).pipe(Effect.provide(jev.layer)))
    expect((jev.asked[0]!.state as unknown as Sent).items).toEqual([item("tiny", 3)])
    expect((jev.asked[0]!.state as unknown as Sent).context).toEqual(context)
  })

  // Each item is about 2 KiB sent, so 200 of them take two requests.
  const many = Array.from({ length: 200 }, (_, n) => item(`m${n}`, 1000))

  it("asks one request at a time, both questions per item", async () => {
    const jev = scripted(() => ({ remove: 0, keep: 1 }))
    const reading = await Effect.runPromise(Marks.read(context, many).pipe(Effect.provide(jev.layer)))
    expect(jev.asked).toHaveLength(2)
    expect(reading.answers).toHaveLength(200)
    for (const request of jev.asked) {
      const n = (request.state as unknown as Sent).items.length
      expect(Object.keys(request.questions).sort()).toEqual(
        Array.from({ length: n }, (_, i) => [`keep_${i}`, `remove_${i}`]).flat().sort()
      )
    }
  })

  it("gives Unjudged and no marks when the second request times out", async () => {
    const jev = scripted(
      () => ({ remove: 1, keep: 0 }),
      (request) => request === 2 ? new Evaluator.EvaluatorError({ code: "timeout", message: "late" }) : undefined
    )
    const outcome = await Effect.runPromise(Effect.result(Marks.read(context, many).pipe(Effect.provide(jev.layer))))
    expect(Result.isFailure(outcome) && outcome.failure).toEqual({ reason: "timeout", detail: "late" })
    expect(jev.asked).toHaveLength(2)
  })
})

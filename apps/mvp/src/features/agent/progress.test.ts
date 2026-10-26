// What an answer shows while the agent works (src/features/agent/progress.ts): the fold over the agent's events, and
// the writer that streams each answer's text and parts, over an `AnswerApi` that records or refuses its writes.
import type { AgentEvent } from "@smthrs/harness"
import { EventSink } from "@smthrs/agent"
import { Context, Deferred, Effect, Exit, Layer, Logger, Scope } from "effect"
import { describe, expect, test, vi } from "vitest"
import { AnswerApi, AnswerSettled, AnswersUnavailable } from "./answers"
import { settlement, settleAnswer, sink } from "./host"
import { AnswerProgress, empty, failureOf, fold, type Progress } from "./progress"
import { RunReporter } from "../status/reporter"
import { prompt } from "./flows"
import type { AnswerWrite } from "./schema"

const event = (value: Record<string, unknown>) => value as unknown as AgentEvent.AgentEvent
const started = (frame: number, ordinal: number, flowName = "app/theme/set") =>
  event({ _tag: "cell-call-started", call: { flowName, identity: { frame, ordinal } } })
const settled = (frame: number, ordinal: number, outcome: "success" | "failure", flowName = "app/theme/set") =>
  event({ _tag: "cell-call-settled", flowName, identity: { frame, ordinal }, result: { outcome } })
const delta = (text: string) => event({ _tag: "model-delta", delta: { type: "text-delta", id: "t", text } })

const replay = (...events: ReadonlyArray<AgentEvent.AgentEvent>) => events.reduce(fold, empty)

describe("fold", () => {
  test("a call is a running step, then done or failed; a replayed settlement adds its step", () => {
    const progress = replay(
      started(0, 0),
      started(0, 0),
      started(0, 1),
      settled(0, 0, "success"),
      settled(1, 0, "failure", "app/other"),
    )

    expect(progress.parts).toEqual([
      { id: "0.0", kind: "step", flow: "app/theme/set", status: "done" },
      { id: "0.1", kind: "step", flow: "app/theme/set", status: "running" },
      { id: "1.0", kind: "step", flow: "app/other", status: "failed" },
    ])
    expect(replay(started(0, 0)).parts).toEqual([{ id: "0.0", kind: "step", flow: "app/theme/set", status: "running" }])
  })

  test("the text is the reply's ctx.done literal as far as it has arrived; a new call or a retry starts it over", () => {
    const first = replay(delta("```cell\n"), delta("ctx.done(\"Hel"), delta("lo"))
    const cut = fold(first, event({ _tag: "model-retried" }))
    const again = replay(
      delta("```cell\nctx.done(\"Hi\")\n```"),
      event({ _tag: "model-requested" }),
      delta("```cell\n"),
    )

    expect(first.text).toBe("Hello")
    expect([cut.reply, cut.text]).toEqual(["", "Hello"])
    expect(again.text).toBe("Hi")
    expect(fold(first, event({ _tag: "model-delta", delta: { type: "usage" } }))).toBe(first)
  })

  test("a cell that calls a flow shows its done text once the cell settled, never while a call may fail", () => {
    const cell = "```cell\nawait ctx.call(\"flow/delete\", { name: \"docs\" })\nctx.done(\"Deleted your flow.\")\n```"
    const waiting = replay(delta("```cell\nctx.done(\"Looking.\")\n```"), event({ _tag: "model-requested" }), delta(cell))
    const cellSettled = (tag: "settled" | "raised") => event({ _tag: "cell-settled", cell: "c", outcome: { _tag: tag } })

    // Asking the person to approve, the delete hasn't run: the answer still shows what it showed before.
    expect(waiting.text).toBe("Looking.")
    expect(fold(waiting, cellSettled("settled")).text).toBe("Deleted your flow.")
    expect(fold(waiting, cellSettled("raised")).text).toBe("Looking.")
    expect(fold(fold(waiting, cellSettled("raised")), cellSettled("settled")).text).toBe("Looking.")
    // Any code before ctx.done holds it, however the call is spelled.
    for (const code of ["await ctx . call(\"flow/delete\", {})", "const c = ctx; await c.call(\"flow/delete\", {})", "const a = 1"]) {
      expect(replay(delta(`\`\`\`cell\n${code}\nctx.done("Deleted your flow.")\n\`\`\``)).text).toBe("")
    }
    // Only a lone ctx.done of one literal streams: a done in another block, or an interpolation, holds it.
    const fence = "```"
    expect(replay(delta(`${fence}text\nctx.done("Example")\n${fence}\n${fence}cell\nawait ctx.call("flow/delete", {})\nctx.done("Deleted.")\n${fence}`)).text)
      .toBe("")
    expect(replay(delta(`${fence}cell\nctx.done(\`Deleted \${await ctx.call("flow/delete", {})}\`)\n${fence}`)).text).toBe("")
    expect(replay(delta(`${fence}cell\nctx.done('Done.');\n${fence}`)).text).toBe("Done.")
    // A text that streamed before the reply showed more is taken back to what the answer showed before the reply.
    const taken = replay(
      delta("```cell\nctx.done(\"Looking.\")\n```"),
      event({ _tag: "model-requested" }),
      delta("```cell\nctx.done(`Deleted your flow."),
      delta("${await ctx.call(\"flow/delete\", {})}`)\n```"),
    )
    expect(taken.text).toBe("Looking.")
    // With nothing shown before, it is taken back to nothing, written as such: an unset text would leave the row's.
    const first = replay(delta("```cell\nctx.done(`Deleted your flow."), delta("${await ctx.call(\"flow/delete\", {})}`)"))
    expect(first.text).toBe("")
    // A block of any tag before the cell runs too.
    for (const tag of ["js", "ts", "typescript", "javascript", ""]) {
      const reply = `\`\`\`${tag}\nawait ctx.call("flow/delete", {})\n\`\`\`\n\`\`\`cell\nctx.done("Deleted your flow.")\n\`\`\``
      expect([tag, replay(delta(reply)).text]).toEqual([tag, ""])
    }
  })

  test("sums each call's tokens, and remembers how a model call failed", () => {
    const spent = replay(
      event({ _tag: "model-settled", usage: { inputTokens: 10, outputTokens: 2 } }),
      event({ _tag: "model-settled", usage: {} }),
      event({ _tag: "model-settled", usage: { inputTokens: 5, outputTokens: 1 } }),
    )

    expect([spent.inputTokens, spent.outputTokens]).toEqual([15, 3])
    expect(fold(empty, event({ _tag: "model-failed", code: "rate_limited" })).modelFailure).toBe("rate_limited")
    expect(fold(empty, event({ _tag: "model-failed", code: "quota_exceeded" })).modelFailure).toBe("quota")
    expect(fold(empty, event({ _tag: "model-failed", code: "provider_internal", httpStatus: 429 })).modelFailure).toBe(
      "rate_limited",
    )
    expect(fold(empty, event({ _tag: "model-failed", code: "out_of_credit", httpStatus: 429 })).modelFailure).toBe("quota")
    expect(fold(empty, event({ _tag: "model-failed", code: "provider_internal", httpStatus: 402 })).modelFailure).toBe("quota")
    expect(fold(empty, event({ _tag: "model-failed", code: "content_policy" })).modelFailure).toBe("model_error")
    expect(fold(empty, event({ _tag: "cell-produced" }))).toBe(empty)
  })

  test("an answer the agent didn't finish failed in its model, or ran out of frames", () => {
    expect(failureOf(undefined)).toBe("model_error")
    expect(failureOf(empty)).toBe("unfinished")
    expect(failureOf({ ...empty, modelFailure: "rate_limited" })).toBe("rate_limited")
  })
})

describe("settlement", () => {
  const shown: Progress = {
    ...empty,
    parts: [{ id: "0.0", kind: "step", flow: "app/theme/set", status: "done" }],
    inputTokens: 3,
    outputTokens: 4,
  }

  const answered = (text: string | null) => ({ text, timedOut: false })

  test("a reply settles done with the parts and tokens this engine saw, or with neither after a resume", () => {
    expect(settlement(answered("Done."), shown)).toEqual({
      status: "done",
      text: "Done.",
      parts: shown.parts,
      inputTokens: 3,
      outputTokens: 4,
    })
    expect(settlement(answered("Done."), undefined)).toEqual({ status: "done", text: "Done." })
  })

  test("a provider's fractional token counts settle rounded, as the routes take them", () => {
    expect(settlement(answered("Done."), { ...shown, inputTokens: 12.5, outputTokens: 3.2 })).toMatchObject({
      status: "done",
      inputTokens: 13,
      outputTokens: 3,
    })
  })

  test("no reply fails as the progress says; an empty one fails empty", () => {
    expect(settlement(answered(null), shown)).toEqual({ status: "failed", failure: "unfinished", parts: shown.parts })
    expect(settlement(answered(null), undefined)).toEqual({ status: "failed", failure: "model_error" })
    expect(settlement(answered("  "), shown)).toEqual({ status: "failed", failure: "empty", parts: shown.parts })
  })

  test("a run out of time fails unfinished, whatever the agent had, keeping the parts it showed", () => {
    expect(settlement({ text: "Late.", timedOut: true }, shown)).toEqual({
      status: "failed",
      failure: "unfinished",
      parts: shown.parts,
    })
    expect(settlement({ text: null, timedOut: true }, undefined)).toEqual({ status: "failed", failure: "unfinished" })
  })
})

describe("prompt", () => {
  test("a first question is itself; a later one carries the conversation before it", () => {
    expect(prompt({ question: "Hi", history: [] })).toBe("Hi")
    expect(prompt({ question: "And now?", history: [{ question: "Q1", answer: "A1" }] })).toBe(
      "The conversation so far:\nPerson: Q1\nSmithers: A1\n\nThe person now asks: And now?",
    )
  })
})

describe("AnswerProgress", () => {
  const open = async (write: (answerId: string, write: AnswerWrite) => Effect.Effect<void, AnswersUnavailable | AnswerSettled>) => {
    const scope = Effect.runSync(Scope.make())
    const progress = await Effect.runPromise(
      Scope.provide(scope)(
        Effect.map(
          Layer.build(
            AnswerProgress.layer("10 millis").pipe(
              Layer.provide(Layer.succeed(AnswerApi, AnswerApi.of({ heartbeat: () => Effect.void, turn: () => Effect.die("unused"), write }))),
            ),
          ),
          (context) => Context.get(context, AnswerProgress),
        ),
      ),
    )
    return { progress, close: () => Effect.runPromise(Scope.close(scope, Exit.void)) }
  }

  test("a stalled write does not block a later answer", async () => {
    const delivered: string[] = []
    const entered = Effect.runSync(Deferred.make<void>())
    const { progress, close } = await open((id) => id === "stalled"
      ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never))
      : Effect.sync(() => { delivered.push(id) }))
    try {
      await Effect.runPromise(progress.record("stalled", started(0, 0)))
      await Effect.runPromise(Deferred.await(entered))
      await Effect.runPromise(progress.record("next", started(0, 0)))
      await vi.waitFor(() => expect(delivered).toEqual(["next"]), { timeout: 500 })
    } finally { await close() }
  })

  test("a terminal refusal releases the answer's retained progress", async () => {
    let attempted = false
    const { progress, close } = await open(() => Effect.sync(() => { attempted = true }).pipe(
      Effect.andThen(Effect.fail(new AnswerSettled())),
    ))
    try {
      await Effect.runPromise(progress.record("settled", started(0, 0)))
      await vi.waitFor(() => expect(attempted).toBe(true))
      expect(await Effect.runPromise(progress.get("settled"))).toBeUndefined()
    } finally { await close() }
  })

  test("a terminal settlement refusal releases progress without changing its failure", async () => {
    const api = AnswerApi.of({ heartbeat: () => Effect.void, turn: () => Effect.die("unused"), write: () => Effect.fail(new AnswerSettled()) })
    const result = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const progress = yield* AnswerProgress
      yield* progress.record("a", started(0, 0))
      const exit = yield* Effect.exit(settleAnswer({ answerId: "a", ending: { text: "Done", timedOut: false } }))
      return { exit, retained: yield* progress.get("a") }
    }).pipe(
      Effect.provide(AnswerProgress.layer("1 seconds")),
      Effect.provideService(AnswerApi, api),
      Effect.provideService(RunReporter, RunReporter.of({ report: () => Effect.die("must not report success"), reportOrFail: () => Effect.die("unused") })),
    )))
    expect(Exit.isFailure(result.exit)).toBe(true)
    expect(result.retained).toBeUndefined()
  })

  test("transient settlement failure retains progress for the durable retry", async () => {
    const api = AnswerApi.of({ heartbeat: () => Effect.void, turn: () => Effect.die("unused"), write: () => Effect.fail(new AnswersUnavailable({})) })
    const retained = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const progress = yield* AnswerProgress
      yield* progress.record("a", started(0, 0))
      yield* Effect.exit(settleAnswer({ answerId: "a", ending: { text: "Done", timedOut: false } }))
      return yield* progress.get("a")
    }).pipe(
      Effect.provide(AnswerProgress.layer("1 seconds")),
      Effect.provideService(AnswerApi, api),
      Effect.provideService(RunReporter, RunReporter.of({ report: () => Effect.die("must not report success"), reportOrFail: () => Effect.die("unused") })),
    )))
    expect(retained?.parts).toHaveLength(1)
  })

  test("coalesces changes during a write without overlapping writes for that answer", async () => {
    const entered = Effect.runSync(Deferred.make<void>())
    const release = Effect.runSync(Deferred.make<void>())
    const writes: Array<[string, AnswerWrite]> = []
    const { progress, close } = await open((id, write) => Effect.gen(function* () {
      writes.push([id, write])
      if (writes.length === 1) {
        yield* Deferred.succeed(entered, undefined)
        yield* Deferred.await(release)
      }
    }))
    try {
      await Effect.runPromise(progress.record("a", started(0, 0)))
      await Effect.runPromise(Deferred.await(entered))
      await Effect.runPromise(progress.record("a", delta('```cell\nctx.done("Latest')))
      await Effect.runPromise(progress.record("b", started(0, 0)))
      await vi.waitFor(() => expect(writes.map(([id]) => id)).toEqual(["a", "b"]))
      await Effect.runPromise(Deferred.succeed(release, undefined))
      await vi.waitFor(() => expect(writes.map(([id]) => id)).toEqual(["a", "b", "a"]))
      expect(writes[2]?.[1]).toMatchObject({ status: "streaming", text: "Latest" })
    } finally { await close() }
  })

  test("writes each answer's latest text and parts as they change, and nothing for events that show nothing", async () => {
    const writes: Array<[string, AnswerWrite]> = []
    const { progress, close } = await open((id, write) => Effect.sync(() => void writes.push([id, write])))

    await Effect.runPromise(progress.record("a", started(0, 0)))
    await Effect.runPromise(progress.record("a", event({ _tag: "turn-opened" })))
    await vi.waitFor(() => expect(writes).toHaveLength(1))
    await Effect.runPromise(progress.record("a", delta("```cell\nctx.done(\"Hi")))
    await vi.waitFor(() => expect(writes).toHaveLength(2))
    await close()

    expect(writes).toEqual([
      ["a", { status: "streaming", parts: [{ id: "0.0", kind: "step", flow: "app/theme/set", status: "running" }] }],
      [
        "a",
        {
          status: "streaming",
          parts: [{ id: "0.0", kind: "step", flow: "app/theme/set", status: "running" }],
          text: "Hi",
        },
      ],
    ])
  })

  test("drops a write the routes refuse, and writes nothing for an answer it has forgotten", async () => {
    const tried: Array<string> = []
    const { progress, close } = await open((id) =>
      Effect.sync(() => tried.push(id)).pipe(Effect.andThen(Effect.fail(new AnswersUnavailable(id === "refused" ? {} : { status: 409 }))))
    )

    await Effect.runPromise(progress.record("refused", started(0, 0)))
    await vi.waitFor(() => expect(tried).toEqual(["refused"]))
    await Effect.runPromise(progress.record("gone", started(0, 0)))
    await Effect.runPromise(progress.forget("gone"))
    await Effect.runPromise(progress.record("refused", settled(0, 0, "success")))
    await vi.waitFor(() => expect(tried).toEqual(["refused", "refused"]))
    await close()

    expect(await Effect.runPromise(progress.get("gone"))).toBeUndefined()
    expect((await Effect.runPromise(progress.get("refused")))?.parts).toHaveLength(1)
  })
})

describe("the agent's sink", () => {
  test("records each event against the run's execution id, the answer's, and drops one with no run", async () => {
    const recorded: Array<[string, string]> = []
    const emit = await Effect.runPromise(
      Effect.map(EventSink.EventSink, (service) => service.emit).pipe(
        Effect.provide(sink),
        Effect.provide(
          Layer.succeed(
            AnswerProgress,
            AnswerProgress.of({
              record: (answerId, recordedEvent) =>
                Effect.sync(() => void recorded.push([answerId, recordedEvent._tag])),
              get: () => Effect.succeed(undefined),
              forget: () => Effect.void,
            }),
          ),
        ),
      ),
    )

    await Effect.runPromise(emit(started(0, 0), { executionId: "answer-1" } as never))
    await Effect.runPromise(emit(started(0, 1)))

    expect(recorded).toEqual([["answer-1", "cell-call-started"]])
  })

  test("logs agent.cell for each settled cell: how it ended and its calls, never its answer or error", async () => {
    const logs: Array<ReturnType<typeof Logger.formatStructured.log>> = []
    const emit = await Effect.runPromise(
      Effect.map(EventSink.EventSink, (service) => service.emit).pipe(
        Effect.provide(sink),
        Effect.provide(Layer.succeed(AnswerProgress, AnswerProgress.of({
          record: () => Effect.void,
          get: () => Effect.succeed(undefined),
          forget: () => Effect.void,
        }))),
      ),
    )
    const cellSettled = (outcome: Record<string, unknown>, work?: Record<string, unknown>) =>
      event({ _tag: "cell-settled", cell: "secret cell source", outcome, ...(work === undefined ? {} : { work }) })
    const run = (settledEvent: AgentEvent.AgentEvent, executionId?: string) =>
      Effect.runPromise(
        emit(settledEvent, executionId === undefined ? undefined : { executionId } as never).pipe(
          Effect.provideService(Logger.CurrentLoggers, new Set([Logger.make((o) => void logs.push(Logger.formatStructured.log(o)))])),
        ),
      )

    await run(
      cellSettled({ _tag: "settled", transition: { _tag: "complete", output: "I couldn't write the file." } }, {
        kind: "calls",
        calls: 1,
        callMs: 15_000,
      }),
      "answer-1",
    )
    await run(cellSettled({ _tag: "rejected", code: "syntax", message: "Unexpected token at secret" }), "answer-1")
    await run(cellSettled({ _tag: "raised", name: "TypeError", message: "secret.ok is undefined" }, {
      kind: "threw",
      calls: 0,
      callMs: 0,
    }), "answer-1")
    await run(started(0, 0), "answer-1")
    await run(cellSettled({ _tag: "settled", transition: { _tag: "continue" } }))

    expect(logs.map((log) => [log.message, log.annotations])).toEqual([
      ["agent.cell", { answerId: "answer-1", outcome: "settled", transition: "complete", work: "calls", calls: 1 }],
      ["agent.cell", { answerId: "answer-1", outcome: "rejected", code: "syntax" }],
      ["agent.cell", { answerId: "answer-1", outcome: "raised", work: "threw", calls: 0 }],
    ])
    expect(JSON.stringify(logs)).not.toMatch(/secret|couldn't/)
  })
})

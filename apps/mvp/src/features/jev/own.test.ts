// Who judges a judgment (decision 0132, src/features/jev/steps.ts `judgeOn`, `JudgeSeat.layer`): the person's own Jev when
// ChatApi says they have one, else the seat. `judgeOn` runs in a step of a flow on the Node host's engine
// (worker/test/flowHost.ts), on the compose Postgres (`pnpm db:up`), since their Jev's judgment is a sealed step of the
// run. ChatApi is scripted at the network, as a deployed host reaches it; the seat's model is scripted at `Model.make`,
// the seam every judge test uses.
import { Action, Flow, Interpreter } from "@smthrs/flow"
import { Evaluator, Model, type ModelEvent } from "@smthrs/model"
import { Classifier } from "@smthrs/model"
import { Node } from "@smthrs/plan"
import { Cause, type Duration, Effect, Exit, Fiber, Layer, Option, Schema, Stream } from "effect"
import { FetchHttpClient } from "effect/http"
import { describe, expect, test } from "vitest"
import { incarnation, runFlow } from "../../../worker/test/flowHost.ts"
import { JudgeSeat, judgeOn } from "./steps"

const QUESTIONS = { ok: Classifier.boolean({ instructions: "Is ok true?" }) }
const REQUEST: Evaluator.Request = { state: { ok: true }, questions: QUESTIONS }

/** The seat's model: a judgment of `probability`, and how often it was asked. */
const seatModel = (probability = 0.25) => {
  let asked = 0
  const model = Model.make({
    stream: () =>
      Stream.suspend(() => {
        asked += 1
        return Stream.fromIterable<ModelEvent.ModelEvent>([
          { type: "text-delta", id: "t", text: JSON.stringify({ answers: { ok: { type: "boolean", probability } } }) },
          { type: "settle", stopReason: "stop" },
        ])
      }),
  })
  return { model, asked: () => asked }
}

/** A flow of one step that asks the judge `REQUEST` and answers what it read. */
const Judged = Schema.Struct({ answers: Evaluator.RawAnswers })
const AskStep = Action.make("test/own/ask", { payload: { id: Schema.String }, success: Judged, error: Evaluator.EvaluatorError })
const Ask = Flow.make("test/own", {
  payload: { id: Schema.String },
  success: Judged,
  error: Evaluator.EvaluatorError,
  body: Node.capture({ ask: AskStep.name }, (payload) => AskStep.call(payload)),
})

/** `Ask` judging on `seat` and `model`; the step runs `after` once the judge has answered, before it settles. */
const registered = (seat: JudgeSeat["Service"], model: Model.Model, after: Effect.Effect<void> = Effect.void) =>
  Interpreter.layerWithImplementations(
    Ask,
    AskStep.toLayer(() =>
      Effect.gen(function* () {
        const judge = yield* judgeOn("test/own/own", seat, model)
        const { answers } = yield* Effect.flatMap(Effect.service(Evaluator.Evaluator), (asked) => asked.evaluate(REQUEST)).pipe(
          Effect.provide(judge),
        )
        yield* after
        return { answers }
      })
    ),
  ).pipe(Layer.provideMerge(Action.layerImplementations))

const judged = (seat: JudgeSeat["Service"], model: Model.Model) =>
  runFlow(Ask, { id: "one" }, registered(seat, model)).then(({ exit }) => exit)

/** A failed run's error. The engine annotates an action's failed cause with its FailureSite, which the outcome doesn't depend on. */
const failureOf = (exit: Exit.Exit<unknown, unknown>) => Exit.isFailure(exit) ? Cause.squash(exit.cause) : exit

const answer = { answers: { ok: { type: "boolean", probability: 0.9 } }, latencyMs: 4 } as unknown as Evaluator.Response
const route = { prepare: () => Effect.die("unused") } as unknown as JudgeSeat["Service"]["route"]

describe("judgeOn", () => {
  test("with no ownJev, the seat answers", async () => {
    const { model, asked } = seatModel()
    const exit = await judged({ model, route }, model)
    expect(Exit.isSuccess(exit) && exit.value.answers["ok"]).toMatchObject({ probability: 0.25 })
    expect(asked()).toBe(1)
  })

  test("a person with no Jev falls back to the seat", async () => {
    const { model, asked } = seatModel()
    const exit = await judged({ model, route, ownJev: () => Effect.succeed(Option.none()) }, model)
    expect(Exit.isSuccess(exit) && exit.value.answers["ok"]).toMatchObject({ probability: 0.25 })
    expect(asked()).toBe(1)
  })

  test("a person's own Jev answers, and the seat is never asked", async () => {
    const { model, asked } = seatModel()
    const exit = await judged({ model, route, ownJev: () => Effect.succeed(Option.some(answer)) }, model)
    expect(exit).toEqual(Exit.succeed({ answers: answer.answers }))
    expect(asked()).toBe(0)
  })

  test("their Jev's failure is the judgment's failure: the seat doesn't answer on a refused key's behalf", async () => {
    const { model, asked } = seatModel()
    const failure = new Evaluator.EvaluatorError({ code: "refused", status: 403, message: "no" })
    const exit = await judged({ model, route, ownJev: () => Effect.fail(failure) }, model)
    expect(failureOf(exit)).toEqual(failure)
    expect(asked()).toBe(0)
  })

  test("a run resumed after their Jev answered reads the judgment back: their key pays for it once", async () => {
    const { model, asked } = seatModel()
    let judgments = 0
    const ownJev = () =>
      Effect.sync(() => {
        judgments += 1
        return Option.some(answer)
      })
    // The first engine's step has its Jev's answer and never settles: the engine is cut off there.
    let reached = 0
    let hold = true
    const after = Effect.suspend(() => {
      reached += 1
      return hold ? Effect.never : Effect.void
    })
    const registration = registered({ model, route, ownJev }, model, after)

    const first = await incarnation(registration)
    const running = Effect.runFork(first.execute(Ask, "own-resume", { id: "resume" }))
    await expect.poll(() => reached, { interval: 20, timeout: 60_000 }).toBe(1)
    await first.crash()
    hold = false
    const second = await incarnation(registration, first.engine.schema)
    const resumed = await Effect.runPromise(second.execute(Ask, "own-resume", { id: "resume" }))
    await Effect.runPromise(Fiber.interrupt(running))
    await second.close()
    await first.close()

    expect(resumed).toEqual(Exit.succeed({ answers: answer.answers }))
    // The step ran again on the second engine, and read their Jev's judgment from its sealed step.
    expect(reached).toBe(2)
    expect(judgments).toBe(1)
    expect(asked()).toBe(0)
  })
})

describe("JudgeSeat.layer's own Jev", () => {
  const ORIGIN = "http://chat.test"
  /** The seat over ChatApi answering `respond` with the request's abort signal, and what it was sent. */
  const seat = async (respond: (signal: AbortSignal) => Response | Promise<Response>, ownJevWithin?: Duration.Input) => {
    const sent: Array<{ readonly url: string; readonly body: unknown }> = []
    const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init)
      sent.push({ url: request.url, body: await request.json() })
      return respond(init!.signal!)
    }) as typeof globalThis.fetch
    const options = ownJevWithin === undefined ? {} : { ownJevWithin }
    const service = await Effect.runPromise(Effect.service(JudgeSeat).pipe(
      Effect.provide(JudgeSeat.layer(ORIGIN, options).pipe(Layer.provide(FetchHttpClient.layer))),
      Effect.provideService(FetchHttpClient.Fetch, fetch),
    ))
    const ask = () => Effect.runPromiseExit(service.ownJev!(REQUEST).pipe(Effect.provideService(FetchHttpClient.Fetch, fetch)))
    return { sent, ask }
  }

  test("posts the state and questions to the person's route, and reads the judgment", async () => {
    const { sent, ask } = await seat(() => Response.json(answer))
    expect(await ask()).toEqual(Exit.succeed(Option.some(answer)))
    expect(sent).toEqual([{ url: `${ORIGIN}/api/me/model/jev`, body: JSON.parse(JSON.stringify(REQUEST)) }])
  })

  test("404 means they have none", async () => {
    const { ask } = await seat(() => Response.json({ code: "none" }, { status: 404 }))
    expect(await ask()).toEqual(Exit.succeed(Option.none()))
  })

  test("a refusal keeps Jev's code", async () => {
    const { ask } = await seat(() => Response.json({ code: "refused" }, { status: 502 }))
    expect(JSON.stringify(await ask())).toContain('"code":"refused"')
  })

  test("no answer at all leaves the judgment to the seat, whose attempts are durable", async () => {
    const { ask } = await seat(() => Promise.reject(new Error("no route")))
    expect(await ask()).toEqual(Exit.succeed(Option.none()))
  })

  test("no whole answer within the deadline leaves the judgment to the seat, and aborts the request", async () => {
    // ChatApi takes the request and never sends its headers, or sends them and part of the body and stops.
    const stalls = [
      (signal: AbortSignal) => new Promise<Response>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason))),
      () =>
        new Response(
          new ReadableStream({ start: (controller) => controller.enqueue(new TextEncoder().encode('{"answers":')) }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    ]
    for (const stall of stalls) {
      const signals: Array<AbortSignal> = []
      const { ask } = await seat((signal) => {
        signals.push(signal)
        return stall(signal)
      }, "20 millis")
      expect(await ask()).toEqual(Exit.succeed(Option.none()))
      expect(signals.map((signal) => signal.aborted)).toEqual([true])
    }
  })

  test("an answer with no code of Jev's, or that doesn't read, is unreachable", async () => {
    const unknown = await seat(() => Response.json({ code: "unavailable" }, { status: 503 }))
    expect(JSON.stringify(await unknown.ask())).toContain('"code":"unreachable"')
    const unreadable = await seat(() => new Response("oops", { status: 500 }))
    expect(JSON.stringify(await unreadable.ask())).toContain('"code":"unreachable"')
  })
})

import { ShapeSource } from "@smthrs/effect-electric"
import type { Persistence } from "@smthrs/effect-tanstack-db"
import { Interpreter } from "@smthrs/flow"
import { BrowserEngine } from "@smthrs/platform-browser"
import { Context, Effect, Exit, Latch, Layer, Ref, Stream, SubscriptionRef } from "effect"
import { AuthClient } from "../features/auth/api"
import { ChatClient, type Question, QuestionNotTaken } from "../features/chat/api"
import { type AppOptions, realServices } from "../boot"
import { ClientEngine, DispatchFailed } from "../flows/dispatch"
import { faultyAuth } from "./authFaults"

export { AuthFaults } from "./authFaults"

/**
 * `real` persistence whose metadata is unreadable for the one read after `failNext()`, then readable again: a device whose
 * storage failed once and recovered, so a store's collections that couldn't open open on the next try.
 */
export const persistenceFailingOnce = (real: Persistence.Service) => {
  let fail = false
  const service: Persistence.Service = {
    persistence: real.persistence,
    get registry() {
      if (fail) {
        fail = false
        throw new Error("persistence metadata unavailable")
      }
      return real.registry
    },
  }
  return { service, failNext: () => void (fail = true) }
}

// The test implementations of the services the browser reaches the world through (docs/rules.md,
// test.faults-by-injection): ChatApi's client, sign-in's client (src/test/authFaults.ts), Electric's shape source and
// this tab's engine, each the real one behind switches. Unit
// tests of unhappy paths and the end-to-end entry (src/test/e2e.ts) use them; every happy-path test uses the real ones,
// which is what proves them. Production never loads this file.

/**
 * How the next question fails, as the browser sees it:
 * - `unreachable`: offline; ChatApi never sees it;
 * - `refused`: a gateway answers 503; ChatApi never sees it;
 * - `bad_request`: ChatApi refuses it (400); it never stores it;
 * - `too_large`: a gateway refuses its body (413); ChatApi never sees it;
 * - `invalid_response`: ChatApi stores it, and its 202 is cut short;
 * - `timeout`: ChatApi stores it, and its answer comes too late, so the browser gives up;
 * - `duplicate`: the network sends it twice, so ChatApi answers the second 200;
 * - `conflict`: another writer stores a different question with its id first, so ChatApi answers 409.
 */
export type QuestionFault =
  | "unreachable"
  | "refused"
  | "bad_request"
  | "too_large"
  | "invalid_response"
  | "timeout"
  | "duplicate"
  | "conflict"

/**
 * The switch of the faulty ChatApi client: the next question fails as `fault`, and every later one goes through.
 * `asked` is every question the client was given, in order, failed or not: a test reads a question's ids from it when
 * a fault kept the question off the network.
 */
export class QuestionFaults extends Context.Service<
  QuestionFaults,
  {
    readonly failNext: (fault: QuestionFault) => Effect.Effect<void>
    readonly asked: Effect.Effect<ReadonlyArray<Question>>
  }
>()("@smthrs/mvp/test/QuestionFaults") {}

/** ChatApi's client as the layer below gives it, behind `QuestionFaults`. */
const faultyClient = Layer.effectContext(
  Effect.gen(function* () {
    const real = yield* ChatClient
    const next = yield* Ref.make<QuestionFault | undefined>(undefined)
    const asked = yield* Ref.make<ReadonlyArray<Question>>([])
    const ask = (question: Question) =>
      Effect.gen(function* () {
        yield* Ref.update(asked, (questions) => [...questions, question])
        const fault = yield* Ref.getAndSet(next, undefined)
        switch (fault) {
          case undefined:
            return yield* real.ask(question)
          case "unreachable":
            return yield* new QuestionNotTaken({ reason: "unreachable" })
          case "refused":
            return yield* new QuestionNotTaken({ reason: "refused", status: 503 })
          case "bad_request":
            return yield* new QuestionNotTaken({ reason: "refused", status: 400 })
          case "too_large":
            return yield* new QuestionNotTaken({ reason: "refused", status: 413 })
          case "invalid_response":
            yield* real.ask(question)
            return yield* new QuestionNotTaken({ reason: "invalid_response", status: 202 })
          case "timeout":
            yield* real.ask(question)
            return yield* new QuestionNotTaken({ reason: "unreachable" })
          case "duplicate":
            yield* real.ask(question)
            return yield* real.ask(question)
          case "conflict":
            yield* real.ask({ id: question.id, answerId: crypto.randomUUID(), text: "another question" })
            return yield* real.ask(question)
        }
      })
    return Context.make(ChatClient, ChatClient.of({ ask })).pipe(
      Context.add(QuestionFaults, QuestionFaults.of({ failNext: (fault) => Ref.set(next, fault), asked: Ref.get(asked) })),
    )
  }),
)

/**
 * The switches of the faulty engine: `holdStarts` holds every run this tab starts until `releaseStarts`, as when its
 * engine worker is still loading, so a run asked for isn't recorded yet; a run already started goes on.
 * `refuseResults(flow, code)` makes the end of every run of `flow` read as the engine's interpreter refusing it with
 * `code`, as a run parked under one build of the app and resumed under the next reads `plan_changed` from the store;
 * the run itself goes on. `refuseStarts(flow)` makes every start of `flow` from now on refused, as an engine that can't
 * record a run refuses it.
 */
export class EngineFaults extends Context.Service<
  EngineFaults,
  {
    /**
     * Every start of `flow` from now on reaches the real engine, and its reply is lost: the start fails `unavailable`
     * after the engine recorded the run, as when the leader dies before answering.
     */
    readonly loseStartReplies: (flow: string) => Effect.Effect<void>
    /**
     * Every start of `flow` from now on fails `unavailable` before it reaches the engine, as when this tab's worker failed
     * and no leader answers.
     */
    readonly dropStarts: (flow: string) => Effect.Effect<void>
    /** The next read of how a run of `flow` ended is refused, as a leader whose store failed the read; the run goes on. */
    readonly refuseNextResult: (flow: string) => Effect.Effect<void>
    /** Starts of `flow` reach the real engine again, and answer: undoes `refuseStarts`, `dropStarts` and `loseStartReplies`. */
    readonly admitStarts: (flow: string) => Effect.Effect<void>
    /** The engine's run reads (`BrowserEngine.runs`) answer nothing until `readRuns`, as a leader whose reads fail. */
    readonly holdRunReads: Effect.Effect<void>
    readonly readRuns: Effect.Effect<void>
    readonly holdStarts: Effect.Effect<void>
    readonly releaseStarts: Effect.Effect<void>
    readonly refuseResults: (flow: string, code: Interpreter.InterpreterError["code"]) => Effect.Effect<void>
    readonly refuseStarts: (flow: string) => Effect.Effect<void>
  }
>()("@smthrs/mvp/test/EngineFaults") {}

/** This tab's engine as the layer below gives it, behind `EngineFaults`. */
const faultyEngine = Layer.effectContext(
  Effect.gen(function* () {
    const real = yield* ClientEngine
    const starts = yield* Latch.make(true)
    const refusing = yield* Ref.make<ReadonlyMap<string, Interpreter.InterpreterError["code"]>>(new Map())
    const refusingStarts = yield* Ref.make<ReadonlySet<string>>(new Set())
    const losing = yield* Ref.make<ReadonlySet<string>>(new Set())
    const dropping = yield* Ref.make<ReadonlySet<string>>(new Set())
    const reads = yield* SubscriptionRef.make(true)
    const browser = yield* BrowserEngine.BrowserEngine
    const refusingResults = yield* Ref.make<ReadonlySet<string>>(new Set())
    const result: ClientEngine["Service"]["result"] = (flow, run) =>
      Effect.flatMap(Ref.modify(refusingResults, (held) => [held.has(flow._tag), new Set([...held].filter((name) => name !== flow._tag))] as const), (refuseRead) => refuseRead
        ? Effect.fail(new DispatchFailed({ flow: flow._tag, reason: "refused" }))
        : Effect.flatMap(Ref.get(refusing), (refused) => {
        const code = refused.get(flow._tag)
        return code === undefined
          ? real.result(flow, run)
          : Effect.succeed(
            Exit.die(new Interpreter.InterpreterError({ code, flow: flow._tag, node: flow._tag, message: "refused" })),
          )
      }))
    return Context.make(
      ClientEngine,
      ClientEngine.of({
        start: (flow, run) =>
          Effect.flatMap(Effect.all([Ref.get(refusingStarts), Ref.get(losing), Ref.get(dropping)]), ([refused, lost, dropped]) =>
            refused.has(flow._tag)
              ? Effect.fail(new DispatchFailed({ flow: flow._tag, reason: "refused" }))
              : dropped.has(flow._tag)
              ? Effect.fail(new DispatchFailed({ flow: flow._tag, reason: "unavailable" }))
              : starts.whenOpen(real.start(flow, run)).pipe(
                Effect.andThen(lost.has(flow._tag) ? Effect.fail(new DispatchFailed({ flow: flow._tag, reason: "unavailable" })) : Effect.void),
              )),
        result,
      }),
    ).pipe(
      Context.add(
        BrowserEngine.BrowserEngine,
        // Held, a running read stream stops and nothing reads; released, a new one reads from its first snapshot.
        BrowserEngine.BrowserEngine.of({
          ...browser,
          runs: (options) => SubscriptionRef.changes(reads).pipe(Stream.switchMap((open) => open ? browser.runs(options) : Stream.empty)),
        }),
      ),
      Context.add(
        EngineFaults,
        EngineFaults.of({
          loseStartReplies: (flow) => Ref.update(losing, (lost) => new Set([...lost, flow])),
          refuseNextResult: (flow) => Ref.update(refusingResults, (held) => new Set([...held, flow])),
          dropStarts: (flow) => Ref.update(dropping, (dropped) => new Set([...dropped, flow])),
          admitStarts: (flow) =>
            Effect.asVoid(Effect.all([refusingStarts, dropping, losing].map((held) => Ref.update(held, (flows) => new Set([...flows].filter((name) => name !== flow)))))),
          holdRunReads: SubscriptionRef.set(reads, false),
          readRuns: SubscriptionRef.set(reads, true),
          holdStarts: Effect.asVoid(starts.close),
          releaseStarts: Effect.asVoid(starts.open),
          refuseResults: (flow, code) => Ref.update(refusing, (refused) => new Map([...refused, [flow, code]])),
          refuseStarts: (flow) => Ref.update(refusingStarts, (refused) => new Set([...refused, flow])),
        }),
      ),
    )
  }),
)

/**
 * A finite 503 outage on a new branch's message shape (`failures`), and `withhold(route)`: every request for the shape at
 * `route` answers 503 until `release(route)`, as when that one shape's sync is down; every other request uses the real
 * source.
 */
export class ShapeRecovery extends Context.Service<ShapeRecovery, {
  readonly failures: Effect.Effect<number>
  readonly withhold: (route: string) => Effect.Effect<void>
  readonly release: (route: string) => Effect.Effect<void>
}>()(
  "@smthrs/mvp/test/ShapeRecovery",
) {}

const recoveringSource = (failures: number) => Layer.effectContext(Effect.gen(function* () {
  const real = yield* ShapeSource.ShapeSource
  const failed = yield* Ref.make(0)
  const withheld = yield* Ref.make<ReadonlySet<string>>(new Set())
  const source = ShapeSource.ShapeSource.of({ request: (url, init) => Effect.gen(function* () {
    const target = new URL(url)
    if ((yield* Ref.get(withheld)).has(target.pathname)) return new Response(null, { status: 503 })
    if (target.pathname === "/api/shapes/messages" && target.searchParams.has("conversation") &&
      (yield* Ref.get(failed)) < failures) {
      yield* Ref.update(failed, (count) => count + 1)
      return new Response(null, { status: 503 })
    }
    return yield* real.request(url, init)
  }) })
  return Context.make(ShapeSource.ShapeSource, source).pipe(
    Context.add(ShapeRecovery, ShapeRecovery.of({
      failures: Ref.get(failed),
      withhold: (route) => Ref.update(withheld, (routes) => new Set([...routes, route])),
      release: (route) => Ref.update(withheld, (routes) => new Set([...routes].filter((held) => held !== route))),
    })),
  )
}))

/**
 * The browser's services with switches: ChatApi's real client behind `QuestionFaults`, sign-in's real client behind
 * `AuthFaults`, Electric's real shape source behind `ShapeSource.Faults`, and this tab's real engine behind
 * `EngineFaults`. Pass it to `appLayer` or `start` in place of `realServices`. `shapes` throws the shape source's
 * switches before the app syncs, for an app that must open with sync already failing; `sessionDown` opens it with every
 * session read answering 503.
 */
export const faultyServices = (
  options: Pick<AppOptions, "origin" | "answerWithin">,
  shapes?: (switches: ShapeSource.Switches) => Effect.Effect<void>,
  recover = 0,
  sessionDown = false,
) =>
  Layer.mergeAll(
    faultyClient.pipe(Layer.provide(realServices(options))),
    faultyAuth(sessionDown).pipe(
      Layer.provide(AuthClient.layer({ origin: options.origin, within: options.answerWithin ?? "15 seconds" })),
    ),
    recoveringSource(recover).pipe(Layer.provideMerge(ShapeSource.layerFaulty(shapes))),
    faultyEngine,
  )

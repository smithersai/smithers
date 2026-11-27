import { ShapeSource } from "@smthrs/effect-electric"
import type { Persistence } from "@smthrs/effect-tanstack-db"
import { Interpreter } from "@smthrs/flow"
import { BrowserEngine } from "@smthrs/platform-browser"
import { Context, Deferred, Duration, Effect, Exit, Latch, Layer, Ref, Stream, SubscriptionRef } from "effect"
import { AuthClient } from "../features/auth/api.vibe"
import { ChatClient, type Question, QuestionNotTaken } from "../features/chat/api"
import { type AppOptions, realServices } from "../boot"
import { ClientEngine, DispatchFailed } from "../flows/dispatch.vibe"
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
        known: real.known,
        retry: real.retry,
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
 * `withhold(route)`: every request for the shape at `route` answers 503 until `release(route)`, as when that one shape's sync is down; `lag(route, duration)`: each of its
 * responses reaches the device `duration` after Electric sent it, as on a slow box, until a zero lag. Every other request
 * uses the real source.
 */
export class ShapeRecovery extends Context.Service<ShapeRecovery, {
  readonly withhold: (route: string) => Effect.Effect<void>
  readonly release: (route: string) => Effect.Effect<void>
  readonly lag: (route: string, duration: Duration.Input) => Effect.Effect<void>
  /** Holds real responses after Electric answers, including a long poll already in flight. */
  readonly pause: (route: string) => Effect.Effect<{ readonly entered: Effect.Effect<void>; readonly resume: Effect.Effect<void> }>
}>()(
  "@smthrs/mvp/test/ShapeRecovery",
) {}

const recoveringSource = Layer.effectContext(Effect.gen(function* () {
  const real = yield* ShapeSource.ShapeSource
  const withheld = yield* Ref.make<ReadonlySet<string>>(new Set())
  const lagged = yield* Ref.make<ReadonlyMap<string, Duration.Duration>>(new Map())
  const paused = new Map<string, { readonly entered: Deferred.Deferred<void>; readonly release: Deferred.Deferred<void> }>()
  const source = ShapeSource.ShapeSource.of({ request: (url, init) => Effect.gen(function* () {
    const target = new URL(url)
    if ((yield* Ref.get(withheld)).has(target.pathname)) return new Response(null, { status: 503 })
    const response = yield* real.request(url, init)
    const pause = paused.get(target.pathname)
    if (pause !== undefined) {
      yield* Deferred.succeed(pause.entered, undefined)
      yield* Deferred.await(pause.release)
    }
    // After Electric answered: a live request's change waits too, not only the request that asks for it.
    const lag = (yield* Ref.get(lagged)).get(target.pathname)
    if (lag !== undefined) yield* Effect.sleep(lag)
    return response
  }) })
  return Context.make(ShapeSource.ShapeSource, source).pipe(
    Context.add(ShapeRecovery, ShapeRecovery.of({
      withhold: (route) => Ref.update(withheld, (routes) => new Set([...routes, route])),
      release: (route) => Ref.update(withheld, (routes) => new Set([...routes].filter((held) => held !== route))),
      pause: (route) => Effect.gen(function* () {
        const entered = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        paused.set(route, { entered, release })
        return {
          entered: Deferred.await(entered),
          resume: Effect.sync(() => paused.delete(route)).pipe(Effect.andThen(Deferred.succeed(release, undefined)), Effect.asVoid),
        }
      }),
      lag: (route, duration) =>
        Ref.update(lagged, (routes) => {
          const next = new Map(routes)
          const lag = Duration.fromInputUnsafe(duration)
          if (Duration.isZero(lag)) next.delete(route)
          else next.set(route, lag)
          return next
        }),
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
  sessionDown = false,
) =>
  Layer.mergeAll(
    faultyClient.pipe(Layer.provide(realServices(options))),
    faultyAuth(sessionDown).pipe(
      Layer.provide(AuthClient.layer({ origin: options.origin, within: options.answerWithin ?? "15 seconds" })),
    ),
    recoveringSource.pipe(Layer.provideMerge(ShapeSource.layerFaulty(shapes))),
    faultyEngine,
  )

/** A read of a conversation's messages shard, as the page sends one (src/features/chat/messagesShardClient.ts). */
const SHARD_READ = /^\/api\/conversations\/[^/]+\/messages\/(?:pull|snapshot)$/

type ShardFault =
  | { readonly _tag: "Down" }
  | { readonly _tag: "Refuse"; readonly status: number }
  | { readonly _tag: "Stall" }
  | { readonly _tag: "Corrupt" }

/**
 * The page's reads of its conversations' messages shards (`GET /api/conversations/:id/messages/{pull,snapshot}`)
 * behind switches at the page's `fetch`, as `ShapeSource.Faults` puts Electric's shapes behind them: `down` fails each
 * read on the network as it is sent, `refuse` answers each with `status` (default 400) and ChatApi never sees it,
 * `stall` holds each answer that arrives until `heal` or until the page gives the read up, and `corrupt` answers each
 * that arrives with a body outside the protocol. `heal` returns to the network and lets stalled answers through.
 * Submits, and every other request, always go through.
 */
export class ShardFaults extends Context.Service<ShardFaults, {
  readonly down: () => Effect.Effect<void>
  readonly refuse: (status?: number) => Effect.Effect<void>
  readonly stall: () => Effect.Effect<void>
  readonly corrupt: () => Effect.Effect<void>
  readonly heal: Effect.Effect<void>
  /** The path of every read sent, in order. */
  readonly sent: Effect.Effect<ReadonlyArray<string>>
  /** How many reads of the conversation that failed most answered 503 (`shardFaults`'s `failures`). */
  readonly failures: Effect.Effect<number>
}>()("@smthrs/mvp/test/ShardFaults") {}

/**
 * `ShardFaults` and the page's `fetch` behind them: `wrap` puts them in front of the network a page reads through. The
 * first `failures` reads of each conversation answer 503, as a finite outage of the shard's route, before any switch
 * is thrown.
 */
export const shardFaults = (failures = 0) => {
  let fault: ShardFault | undefined
  const failed = new Map<string, number>()
  const stalled = new Set<() => void>()
  const sent: Array<string> = []
  const set = (next: ShardFault | undefined) => Effect.sync(() => {
    fault = next
    if (next !== undefined) return
    for (const release of [...stalled]) release()
  })
  const wrap = (next: typeof globalThis.fetch): typeof globalThis.fetch => async (input, init) => {
    const request = new Request(input, init)
    const path = new URL(request.url).pathname
    if (request.method !== "GET" || !SHARD_READ.test(path)) return next(request)
    sent.push(path)
    // Pull and Snapshot of one conversation share its path up to the last segment.
    const conversation = path.slice(0, path.lastIndexOf("/"))
    if ((failed.get(conversation) ?? 0) < failures) {
      failed.set(conversation, (failed.get(conversation) ?? 0) + 1)
      return new Response(null, { status: 503 })
    }
    if (fault?._tag === "Down") throw new TypeError("fetch failed")
    if (fault?._tag === "Refuse") return new Response(null, { status: fault.status })
    const response = await next(request)
    if (fault?._tag === "Stall") {
      await new Promise<void>((resolve, reject) => {
        const release = () => {
          stalled.delete(release)
          resolve()
        }
        stalled.add(release)
        request.signal.addEventListener("abort", () => {
          stalled.delete(release)
          reject(request.signal.reason)
        })
      })
    }
    if (fault?._tag === "Corrupt") return new Response("{", { status: 200, headers: { "content-type": "application/json" } })
    return response
  }
  const service = ShardFaults.of({
    down: () => set({ _tag: "Down" }),
    refuse: (status = 400) => set({ _tag: "Refuse", status }),
    stall: () => set({ _tag: "Stall" }),
    corrupt: () => set({ _tag: "Corrupt" }),
    heal: set(undefined),
    sent: Effect.sync(() => [...sent]),
    failures: Effect.sync(() => Math.max(0, ...failed.values())),
  })
  return { service, wrap }
}

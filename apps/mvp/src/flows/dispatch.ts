import type { Flow as FlowTypes } from "@smthrs/flow"
import { FlowRuntime, Interpreter, RunMetrics } from "@smthrs/flow"
import { BrowserEngine } from "@smthrs/platform-browser"
import { Cause, Clock, Context, Deferred, Effect, Exit, Layer, Metric, Option, Result, Schema } from "effect"
import { type DOORS, PERSON_DOORS } from "./contract"
import { codeOfFailure, TabHistory } from "./history"
import { refusesCredential } from "./personOnly"
import { type Entry, type FlowName, type FlowOf, FlowRegistry } from "./registry"
import { TabRequests } from "./requests"

// Dispatch (docs/features/flows.md#dispatch): the one way the UI runs a flow. A button, a slash command, a view and
// the composer call `FlowDispatch.dispatch` with a registered name; the agent calls the same declarations from its
// cells. Every registered flow runs on this device's durable engine (`ClientEngine`). Every dispatch is a span, a log
// line and a count, and none carries the flow's input. Dispatch reads only a flow's reference, its tag and schemas
// (src/flows/registry.ts), so the tab never loads a flow's steps.

/** What started a dispatch: one of `DOORS`. */
export type Door = (typeof DOORS)[number]

/** How a dispatch ended: the flow's value, its declared failure, or not run at all (`error`). */
export type DispatchOutcome = "done" | "failed" | "error"

/** A flow's success and declared failure. */
export type SuccessOf<N extends FlowName> = FlowOf<N>["successSchema"]["Type"]
export type FailureOf<N extends FlowName> = FlowOf<N>["errorSchema"]["Type"]
export type PayloadOf<N extends FlowName> = FlowOf<N>["payloadSchema"]["Type"]

/** What a dispatch answers: the flow's end. */
export type Dispatched<N extends FlowName> =
  | { readonly _tag: "Done"; readonly value: SuccessOf<N> }
  | { readonly _tag: "Failed"; readonly error: FailureOf<N> }

/**
 * The flow didn't run to an answer: the engine refused it (`refused`), this tab has no engine because
 * its worker failed (`unavailable`), its input didn't encode (`invalid`), it died (`defect`) or was interrupted
 * (`interrupted`). A run the engine's interpreter refused died with its refusal's code as `refusal`, such as
 * `plan_changed` for a run parked under one build of the app and resumed under the next (`Interpreter.refusalCode`).
 * Never a message: those can quote the input.
 */
export class DispatchFailed extends Schema.TaggedError<DispatchFailed>()("@smthrs/mvp/flows/DispatchFailed", {
  flow: Schema.String,
  reason: Schema.Literals(["refused", "unavailable", "invalid", "defect", "interrupted"]),
  refusal: Schema.optional(Schema.String),
}) {}

/** A client flow's run: its execution id and payload. */
export interface Run {
  readonly executionId: string
  readonly payload: unknown
}

/**
 * This device's durable engine, as dispatch reaches it: `start` admits a client flow's run and returns once the engine
 * recorded it, so the run outlives the tab that asked; `result` waits for the run started with the same `Run` to end
 * and answers how it ended. Starting the same execution again is a no-op.
 */
export class ClientEngine extends Context.Service<
  ClientEngine,
  {
    readonly start: (flow: BrowserEngine.FlowReference, run: Run) => Effect.Effect<void, DispatchFailed>
    readonly result: (flow: BrowserEngine.FlowReference, run: Run) => Effect.Effect<Exit.Exit<unknown, unknown>, DispatchFailed>
  }
>()("@smthrs/mvp/flows/ClientEngine") {
  /**
   * The tab's engine: the leader tab's worker, reached through `@smthrs/platform-browser`'s `BrowserEngine`
   * (decision 0011 §4). A refused request or a payload that won't encode is `DispatchFailed`.
   */
  static readonly layerBrowser = Layer.effect(
    ClientEngine,
    Effect.gen(function* () {
      const engine = yield* BrowserEngine.BrowserEngine
      const failed = (flow: BrowserEngine.FlowReference) =>
      (error: { readonly _tag: string }) =>
        new DispatchFailed({
          flow: flow._tag,
          reason: error._tag === "SchemaError"
            ? "invalid"
            : error._tag === "@smthrs/platform-browser/EngineUnavailable"
            ? "unavailable"
            : "refused",
        })
      return ClientEngine.of({
        start: (flow, run) => engine.start(flow, run as never).pipe(Effect.mapError(failed(flow))),
        result: (flow, run) => engine.result(flow, run.executionId).pipe(Effect.mapError(failed(flow))),
      })
    }),
  )

  /**
   * An engine in this process: the `FlowRuntime` a Node or Bun host composes, for the native app and the tests. It
   * runs the declaration in `flows` that a dispatched reference names (src/flows/declarations.ts `clientFlows`); a
   * name none of them declares is `refused`, and so is a start the runtime refuses, with the refusal's code: a typed
   * failure, or a defect the engine refuses with, such as `execution_identity_conflict` for an execution started again
   * with another payload. A start that dies with no code is a `defect`. A run that ends with a failure its flow doesn't
   * declare, such as `flow_cycle_detected`, was refused by the engine: it is `refused` with that code, never the flow's
   * own failure.
   */
  static readonly layerRuntime = (flows: ReadonlyArray<FlowTypes.Any>) =>
    Layer.effect(
      ClientEngine,
      Effect.gen(function* () {
        const runtime = yield* FlowRuntime.FlowRuntime
        const declared = new Map(flows.map((flow) => [flow._tag, flow]))
        const declarationOf = (flow: BrowserEngine.FlowReference) => {
          const declaration = declared.get(flow._tag)
          return declaration === undefined
            ? Effect.fail(new DispatchFailed({ flow: flow._tag, reason: "refused" }))
            : Effect.succeed(declaration)
        }
        const refused = (flow: BrowserEngine.FlowReference, error: unknown) =>
          new DispatchFailed({ flow: flow._tag, reason: "refused", ...codeOf(error) })
        return ClientEngine.of({
          start: (flow, run) =>
            Effect.flatMap(declarationOf(flow), (declaration) =>
              (runtime.execute(declaration as never, { ...run, discard: true } as never) as Effect.Effect<unknown, unknown>).pipe(
                Effect.asVoid,
                Effect.mapError((error) => refused(flow, error)),
                Effect.catchDefect((defect) =>
                  Effect.fail(
                    codeOf(defect).refusal === undefined
                      ? new DispatchFailed({ flow: flow._tag, reason: "defect" })
                      : refused(flow, defect),
                  )
                ),
              )),
          // The same execution again joins the run its start admitted.
          result: (flow, run) =>
            Effect.flatMap(declarationOf(flow), (declaration) =>
              Effect.flatMap(
                Effect.exit(runtime.execute(declaration as never, run as never) as Effect.Effect<unknown, unknown>),
                (exit) => {
                  const error = Exit.isFailure(exit) ? Cause.findErrorOption(exit.cause) : Option.none()
                  return Option.isSome(error) && !Schema.is(declaration.errorSchema)(error.value)
                    ? Effect.fail(refused(flow, error.value))
                    : Effect.succeed(exit)
                },
              )),
        })
      }),
    )
}

/**
 * What a dispatch is given besides the flow and its payload: the door it came through; its execution id, a new one
 * unless set; and `admitted`, which the dispatch completes once the engine has recorded the run (so a caller can wait
 * for the run to exist without waiting for it to end), or fails with the dispatch's failure if it never is.
 */
export interface DispatchOptions {
  readonly door: Door
  readonly executionId?: string
  readonly admitted?: Deferred.Deferred<void, DispatchFailed>
}

/**
 * The kind of actor behind a door, as the engine's usage metrics count it (`RunMetrics`): a person presses a button, runs
 * a slash command, uses a view or the composer; the agent acts through its door; sync is the app acting on a row another
 * device wrote.
 */
export const actorOf = (door: Door): RunMetrics.Actor =>
  door === "agent" ? "agent" : door === "sync" ? "app" : "person"

/** Dispatches, by `flow`, `door` and `outcome`. */
export const dispatches = Metric.counter("smithers_flow_dispatches", {
  description: "Flows the app dispatched, by flow, door and outcome",
  incremental: true,
})

/**
 * Dispatch over `entries`, a registry: runs the entry named `name` on this device's engine, remembers the execution as
 * this tab's (`TabRequests`, src/flows/requests.ts), and records the dispatch as a span `flow.dispatch`, a log line and
 * a count of `dispatches`, with the flow, the door and the outcome, never the payload. A flow only the person may run
 * at its route (`refusesCredential`) starts only through a person door: through any other it is `refused`
 * (`person_only`) and never starts, so each such run is the person's own press (src/flows/credentials.ts).
 * `FlowDispatch.layer` binds the app's registry; a test binds its own.
 */
export const makeDispatch = <Entries extends Readonly<Record<string, Entry>>>(entries: Entries) =>
  Effect.gen(function* () {
    const engine = yield* ClientEngine
    const requests = yield* TabRequests
    // What this tab ran lately, for a bug report (src/flows/history.ts); a dispatch without one keeps nothing.
    const history = yield* Effect.serviceOption(TabHistory)
    return (
      name: keyof Entries & string,
      payload: unknown,
      options: DispatchOptions,
    ): Effect.Effect<Dispatched<never>, DispatchFailed> => {
      const entry = entries[name]!
      // `admitted` learns how the start went, and a dispatch that ends before its start is a failure to it, so its
      // waiter never hangs. Completing it again changes nothing.
      const admit = <A>(exit: Exit.Exit<A, DispatchFailed>) =>
        options.admitted === undefined
          ? Effect.void
          : Deferred.done(options.admitted, admission(name, Exit.map(exit, () => undefined)))
      return Effect.gen(function* () {
        const startedAt = yield* Clock.currentTimeMillis
        const executionId = options.executionId ?? crypto.randomUUID()
        yield* requests.add(executionId, options.door)
        const fields: Record<string, string | number> = { flow: name, door: options.door, executionId }
        const run = { executionId, payload }
        // The engine labels the run's usage metrics with the door and its actor kind, never who.
        const started = engine.start(entry.flow, run).pipe(
          RunMetrics.withOrigin({ door: options.door, actor: actorOf(options.door) }),
          Effect.onExit(admit),
        )
        const dispatched = refusesCredential(name) && !PERSON_DOORS.includes(options.door)
          ? Result.fail(new DispatchFailed({ flow: name, reason: "refused", refusal: "person_only" }))
          : yield* Effect.result(
            started.pipe(
              Effect.andThen(engine.result(entry.flow, run)),
              Effect.flatMap((exit) => settled(name, exit)),
            ),
          )
        const outcome: DispatchOutcome = dispatched._tag === "Failure"
          ? "error"
          : dispatched.success._tag === "Done"
          ? "done"
          : "failed"
        if (dispatched._tag === "Failure") fields.reason = dispatched.failure.reason
        if (dispatched._tag === "Failure" && dispatched.failure.refusal !== undefined) {
          fields.refusal = dispatched.failure.refusal
        }
        fields.durationMs = (yield* Clock.currentTimeMillis) - startedAt
        if (Option.isSome(history)) {
          // Inside `flow.dispatch`'s span, which is always there.
          const span = yield* Effect.orDie(Effect.currentSpan)
          const code = dispatched._tag === "Failure"
            ? dispatched.failure.refusal ?? dispatched.failure.reason
            : dispatched.success._tag === "Failed"
            ? codeOfFailure(dispatched.success.error)
            : undefined
          yield* history.value.record({
            flow: name,
            executionId,
            door: options.door,
            outcome,
            traceId: span.traceId,
            ...(code === undefined ? {} : { code }),
          })
        }
        yield* Metric.update(
          Metric.withAttributes(dispatches, { flow: name, door: options.door, outcome }),
          1,
        )
        yield* Effect.annotateCurrentSpan({ "smithers.flow.outcome": outcome })
        yield* Effect.logWithLevel(outcome === "error" ? "Error" : outcome === "failed" ? "Warn" : "Info")(
          "flow.dispatch",
        ).pipe(Effect.annotateLogs({ ...fields, outcome }))
        return yield* (dispatched._tag === "Failure"
          ? Effect.fail(dispatched.failure)
          : Effect.succeed(dispatched.success))
      }).pipe(
        Effect.onExit(admit),
        Effect.withSpan("flow.dispatch", {
          attributes: {
            "smithers.flow.name": name,
            "smithers.flow.door": options.door,
          },
        }),
      )
    }
  })

/** How a start ended, as `admitted` learns it: admitted, or `DispatchFailed`, `interrupted` for an interrupted start. */
const admission = (name: string, exit: Exit.Exit<void, DispatchFailed>): Exit.Exit<void, DispatchFailed> =>
  Exit.isFailure(exit) && Option.isNone(Cause.findErrorOption(exit.cause))
    ? Exit.fail(new DispatchFailed({ flow: name, reason: Cause.hasInterruptsOnly(exit.cause) ? "interrupted" : "defect" }))
    : exit

/** An engine error's stable `code`, as `DispatchFailed`'s `refusal`; nothing for an error without one. */
const codeOf = (error: unknown): { readonly refusal?: string } =>
  typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? { refusal: error.code }
    : {}

/** A client flow's end as dispatch answers it: its value, its declared failure, or `DispatchFailed`. */
const settled =(name: string, exit: Exit.Exit<unknown, unknown>): Effect.Effect<Dispatched<never>, DispatchFailed> => {
  if (Exit.isSuccess(exit)) return Effect.succeed({ _tag: "Done", value: exit.value as never })
  const error = Cause.findErrorOption(exit.cause)
  if (Option.isSome(error)) return Effect.succeed({ _tag: "Failed", error: error.value as never })
  if (Cause.hasInterruptsOnly(exit.cause)) return Effect.fail(new DispatchFailed({ flow: name, reason: "interrupted" }))
  const refusal = Interpreter.refusalCode(exit.cause)
  return Effect.fail(
    new DispatchFailed({ flow: name, reason: "defect", ...(Option.isSome(refusal) ? { refusal: refusal.value } : {}) }),
  )
}

/** Runs registered flows for the UI: `dispatch(name, payload, { door })`. */
export class FlowDispatch extends Context.Service<
  FlowDispatch,
  {
    readonly dispatch: <N extends FlowName>(
      name: N,
      payload: PayloadOf<N>,
      options: DispatchOptions,
    ) => Effect.Effect<Dispatched<N>, DispatchFailed>
  }
>()("@smthrs/mvp/flows/FlowDispatch") {
  /**
   * Dispatch of the app's registry over this device's engine, with this tab's `TabRequests`, which it fills and
   * provides.
   */
  static readonly layer = Layer.effect(
    FlowDispatch,
    Effect.gen(function* () {
      const registered = yield* FlowRegistry
      const dispatch = yield* makeDispatch(registered.entries)
      return FlowDispatch.of({ dispatch: dispatch as never })
    }),
  ).pipe(Layer.provideMerge(Layer.merge(TabRequests.layer(), TabHistory.layer())))
}

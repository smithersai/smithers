/**
 * A persistent `Encoded` driver fixture: an in-memory-but-durable log that
 * survives constructing a SECOND engine instance over it.
 *
 * Each `layerDurable(log)` provide builds a fresh engine — fresh registration
 * table, fresh in-flight fiber map — over the shared {@link DurableLog}.
 * Discarding one provide's scope and building another engine over the same
 * log is this suite's process-restart shape: everything in-process dies with
 * the scope, and only what a durable driver would have persisted (payloads,
 * settled round results, settled action outcomes, attempt rows, deferred
 * exits, parent edges, cancel requests) survives into the next instance.
 *
 * The execution machinery mirrors `FlowEngine.layerMemory`: both record only
 * settled action outcomes, so a fiber killed mid-attempt leaves no outcome
 * to replay, and both die with the same typed refusals (`FlowNotRegistered`,
 * `ExecutionIdentityConflict`). The durability hooks diverge where a real driver would: attempt
 * rows persist a first-start time and the highest attempt for
 * `actionRetryOrigin`/`actionLatestAttempt`,
 * plus pre-attempt handles for `actionSnapshot`,
 * and `interrupt` records the cancel request durably and cascades it over the
 * persisted parent edges (the `RunDriver.cancelOwned` shape) instead of
 * relying on the in-process parent link.
 */
import { Flow, FlowRuntime } from "@smthrs/flow"
import { Clock, Effect, Exit, Fiber, Layer, Option } from "effect"
import type * as Scope from "effect/Scope"
import { FlowEngine } from "../src/index.ts"

/** Durable attempt metadata, including snapshots taken before action execution. */
export interface AttemptRow {
  firstStartMs: number
  latest: number
  /** Pre-attempt handles, persisted before any action side effect. */
  snapshots?: Map<number, unknown>
}

/** The state that survives an engine instance. */
export interface DurableLog {
  /** Execution rows: payload, flow tag, and parent recorded at first execute. */
  readonly executions: Map<string, {
    readonly flowTag: string
    readonly payload: object
    readonly parent: string | undefined
  }>
  /** The last settled round result per execution id. */
  readonly results: Map<string, Flow.Result<unknown, unknown>>
  /** Settled action outcomes by JSON-encoded `[key, attempt]`. */
  readonly actionOutcomes: Map<string, Exit.Exit<Flow.Result<unknown, unknown>>>
  /** Attempt rows by action key. */
  readonly attempts: Map<string, AttemptRow>
  /** Deferred exits by encoded `[flowTag, executionId, deferredName]`. */
  readonly deferreds: Map<string, Exit.Exit<unknown, unknown>>
  /** Parent edges: child execution id to parent execution id. */
  readonly parents: Map<string, string>
  /** Durably recorded cancel requests. */
  readonly cancelled: Set<string>
}

/** Creates an empty durable log. */
export const makeLog = (): DurableLog => ({
  executions: new Map(),
  results: new Map(),
  actionOutcomes: new Map(),
  attempts: new Map(),
  deferreds: new Map(),
  parents: new Map(),
  cancelled: new Set()
})

/**
 * One engine instance over the shared log. Every `Effect.provide` of this
 * layer is a separate instance; the log is the only state they share.
 */
export const layerDurable = (log: DurableLog): Layer.Layer<FlowRuntime.FlowRuntime> =>
  Layer.effect(FlowRuntime.FlowRuntime)(
    Effect.gen(function*() {
      const scope = yield* Effect.scope

      const flows = new Map<string, {
        readonly flow: Flow.Any
        readonly execute: (
          payload: object,
          executionId: string
        ) => Effect.Effect<unknown, unknown, FlowRuntime.FlowInstance | FlowRuntime.FlowRuntime>
        readonly scope: Scope.Scope
      }>()

      type LiveState = {
        instance: FlowRuntime.FlowInstance["Service"]
        fiber: Fiber.Fiber<Flow.Result<unknown, unknown>> | undefined
      }
      const live = new Map<string, LiveState>()

      // Untraced because resume recursively drives suspended executions.
      const resume = Effect.fnUntraced(function*(executionId: string): Effect.fn.Return<void> {
        const persisted = log.executions.get(executionId)
        if (!persisted) return
        const entry = flows.get(persisted.flowTag)
        if (!entry) return
        const state = live.get(executionId)
        if (state) {
          const exit = state.fiber?.pollUnsafe()
          if (exit && exit._tag === "Success" && exit.value._tag !== "Suspended") return
          if (state.fiber && !exit) return
        } else {
          // A restarted engine: the run's last durable settlement decides
          // whether there is anything left to drive.
          const recorded = log.results.get(executionId)
          if (recorded !== undefined && recorded._tag === "Complete") return
        }
        const instance = FlowEngine.makeInstance(entry.flow, executionId)
        instance.interrupted = log.cancelled.has(executionId) || (state?.instance.interrupted ?? false)
        const nextState: LiveState = state ?? { instance, fiber: undefined }
        nextState.instance = instance
        live.set(executionId, nextState)
        nextState.fiber = yield* entry.execute(persisted.payload, executionId).pipe(
          Effect.onExit(() => {
            if (!instance.interrupted) {
              return Effect.void
            }
            instance.suspended = false
            return Effect.withFiber((fiber) => Effect.interruptible(Fiber.interrupt(fiber)))
          }),
          Flow.intoResult,
          Effect.provideService(FlowRuntime.FlowInstance, instance),
          Effect.provideService(FlowRuntime.FlowRuntime, engine),
          // A settlement is durable; a fiber killed before settling records
          // nothing, which is what process death looks like.
          Effect.tap((result) =>
            Effect.sync(() => {
              log.results.set(executionId, result)
            })
          ),
          Effect.tap((result) => {
            if (persisted.parent === undefined || result._tag !== "Complete") {
              return Effect.void
            }
            return Effect.forkIn(resume(persisted.parent), scope)
          }),
          Effect.forkIn(entry.scope)
        )
      })

      const engine = FlowEngine.makeUnsafe({
        // Untraced because registration feeds back into the engine.
        register: Effect.fnUntraced(function*(flow, execute) {
          flows.set(flow._tag, {
            flow,
            execute,
            scope: yield* Effect.scope
          })
        }),
        // Untraced because execution recursively invokes child flows.
        execute: Effect.fnUntraced(function*(flow, options) {
          const entry = flows.get(flow._tag)
          if (!entry) {
            return yield* Effect.die(
              new FlowEngine.FlowNotRegistered({
                flowName: flow._tag,
                message: `Flow ${flow._tag} is not registered`
              })
            )
          }
          if (!log.executions.has(options.executionId)) {
            log.executions.set(options.executionId, {
              flowTag: flow._tag,
              payload: options.payload,
              parent: options.parent?.executionId
            })
            if (options.parent !== undefined) {
              log.parents.set(options.executionId, options.parent.executionId)
            }
          }
          const recorded = log.results.get(options.executionId)
          if (recorded !== undefined && recorded._tag === "Complete") {
            // A settled run answers from the log without re-driving — the
            // restart-safe half of execute's execution-id dedupe.
            return (options.discard ? undefined : recorded) as never
          }
          yield* resume(options.executionId)
          if (options.discard) return undefined as never
          const state = live.get(options.executionId)
          return (yield* Fiber.join(state!.fiber!)) as never
        }),
        // Untraced because cancellation cascades over persisted edges.
        interrupt: Effect.fnUntraced(function*(_flow, executionId) {
          // Children first, then the parent: the durable cascade a driver
          // performs over its persisted parent-edge table.
          const owned: Array<string> = []
          const collect = (parent: string) => {
            for (const [child, parentId] of log.parents) {
              if (parentId === parent) {
                collect(child)
                owned.push(child)
              }
            }
          }
          collect(executionId)
          owned.push(executionId)
          for (const target of owned) {
            log.cancelled.add(target)
            const state = live.get(target)
            if (state !== undefined) state.instance.interrupted = true
            yield* resume(target)
          }
        }),
        interruptUnsafe: Effect.fnUntraced(function*(_flow, executionId) {
          log.cancelled.add(executionId)
          const state = live.get(executionId)
          if (state?.fiber === undefined) return
          state.instance.interrupted = true
          yield* Fiber.interrupt(state.fiber)
        }),
        resume: (_flow, executionId) => resume(executionId),
        // Untraced because action execution is a retry-loop hot path.
        actionExecute: Effect.fnUntraced(function*(options) {
          const instance = yield* FlowRuntime.FlowInstance
          const rowId = JSON.stringify([options.key, options.attempt])
          const now = yield* Clock.currentTimeMillis
          const row = log.attempts.get(options.key)
          if (row === undefined) {
            log.attempts.set(options.key, { firstStartMs: now, latest: options.attempt })
          } else if (options.attempt > row.latest) {
            row.latest = options.attempt
          }
          const recorded = log.actionOutcomes.get(rowId)
          if (
            recorded !== undefined && Exit.isSuccess(recorded) &&
            recorded.value._tag === "Suspended"
          ) {
            log.actionOutcomes.delete(rowId)
          } else if (recorded !== undefined) {
            return yield* recorded
          }
          if (options.snapshot !== undefined) {
            const snapshot = yield* options.snapshot
            const attemptRow = log.attempts.get(options.key)!
            const snapshots = attemptRow.snapshots ??= new Map()
            // An unfinished attempt may execute again. Its first handle must
            // survive even when this execution takes a fresh snapshot for diff.
            if (!snapshots.has(options.attempt)) snapshots.set(options.attempt, snapshot)
          }
          const actionInstance = FlowEngine.makeInstance(instance.flow, instance.executionId)
          actionInstance.interrupted = instance.interrupted
          const waitingBefore = instance.waiting
          actionInstance.waiting = waitingBefore
          return yield* options.action.executeEncoded.pipe(
            Flow.intoResult,
            Effect.provideService(FlowRuntime.FlowInstance, actionInstance),
            Effect.onExit((exit) =>
              Effect.sync(() => {
                // Only settlements are journaled: a fiber killed mid-attempt
                // leaves no outcome row for the restarted engine to replay.
                if (Exit.isSuccess(exit)) log.actionOutcomes.set(rowId, exit)
              })
            ),
            Effect.ensuring(Effect.sync(() => {
              if (instance.waiting === waitingBefore) instance.waiting = actionInstance.waiting
            }))
          )
        }),
        actionSnapshot: ({ key }) =>
          Effect.sync(() => {
            const snapshots = log.attempts.get(key)?.snapshots
            if (snapshots === undefined || snapshots.size === 0) return Option.none()
            return Option.some(snapshots.get(Math.min(...snapshots.keys())))
          }),
        actionRetryOrigin: ({ key }) => Effect.sync(() => Option.fromNullishOr(log.attempts.get(key)?.firstStartMs)),
        actionLatestAttempt: ({ key }) => Effect.sync(() => Option.fromNullishOr(log.attempts.get(key)?.latest)),
        poll: (_flow, executionId) =>
          Effect.suspend(() => {
            // An id with no durable execution row and no live fiber is a typed
            // not-found; `Option.none` is reserved for a known, unsettled run.
            const state = live.get(executionId)
            if (state === undefined && !log.executions.has(executionId)) {
              return Effect.fail(
                new FlowRuntime.FlowExecutionNotFound({
                  code: "execution_not_found",
                  executionId
                })
              )
            }
            const exit = state?.fiber?.pollUnsafe()
            if (exit !== undefined) {
              return exit._tag === "Success"
                ? Effect.succeedSome(exit.value)
                : Effect.die(exit.cause)
            }
            const recorded = log.results.get(executionId)
            return recorded === undefined ? Effect.succeedNone : Effect.succeedSome(recorded)
          }),
        // Untraced because deferred polling is a flow scheduler hot path.
        deferredResult: Effect.fnUntraced(function*(deferred) {
          const instance = yield* FlowRuntime.FlowInstance
          return Option.fromNullishOr(
            log.deferreds.get(JSON.stringify([instance.flow._tag, instance.executionId, deferred.name]))
          )
        }),
        deferredDone: (options) =>
          Effect.suspend(() => {
            const execution = log.executions.get(options.executionId)
            if (execution !== undefined && execution.flowTag !== options.flowName) {
              return Effect.die(
                new FlowEngine.ExecutionIdentityConflict({
                  executionId: options.executionId,
                  field: "flow",
                  expected: execution.flowTag,
                  actual: options.flowName,
                  message: `execution ${options.executionId} belongs to flow ${execution.flowTag}; ` +
                    `a deferred for ${options.flowName} cannot complete it`
                })
              )
            }
            const id = JSON.stringify([options.flowName, options.executionId, options.deferredName])
            if (log.deferreds.has(id)) return Effect.void
            log.deferreds.set(id, options.exit)
            return resume(options.executionId)
          }),
        scheduleClock: (flow, options) =>
          engine.deferredDone(options.clock.deferred, {
            flowName: flow._tag,
            executionId: options.executionId,
            deferredName: options.clock.deferred.name,
            exit: Exit.void
          }).pipe(
            Effect.delay(options.clock.duration),
            Effect.forkIn(scope),
            Effect.asVoid
          )
      })

      return engine
    })
  )

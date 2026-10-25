/**
 * Adapts a low-level `Encoded` implementation into the typed `FlowRuntime`
 * port `@smthrs/flow` declares.
 *
 * The two long-running concerns this adapter delegates to live beside it:
 * `Trampoline.ts` follows a lineage of rounds for `execute`, and
 * `Dispatch.ts` allocates, admits, and retries one action for
 * `actionExecute`.
 *
 * @since 0.1.0
 */

import { Deadline, type DurableDeferred, Flow, FlowRuntime } from "@smthrs/flow"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as Scope from "effect/Scope"
import * as Semaphore from "effect/Semaphore"
import { renderDiagnostic } from "../internal/Diagnostic.ts"
import { toJsonExit } from "../internal/JsonExit.ts"
import { makeActionExecute, resetActionContext } from "./Dispatch.ts"
import type { Encoded } from "./Encoded.ts"
import { placeExecute, placeInterrupt, placeResume, placeRetryFrom } from "./Placed.ts"
import { type Declarations, makeExecute } from "./Trampoline.ts"

/** The typed port this module adapts the driver into. */
type Port = FlowRuntime.FlowRuntime["Service"]

/** The handler a driver runs for one registered flow. */
type Handler = Parameters<Encoded["register"]>[1]

/** Recursive admission violates the registration ownership invariant. */
class RegistrationFault extends Schema.TaggedError<RegistrationFault>()("@smthrs/engine/RegistrationFault", {
  flowName: Schema.String,
  message: Schema.String
}) {}

const CurrentRegistrations = Context.Reference<ReadonlyArray<{ readonly owner: object; readonly name: string }>>(
  "@smthrs/engine/CurrentRegistrations",
  { defaultValue: () => [] }
)

interface Gate {
  readonly semaphore: Semaphore.Semaphore
  users: number
}

/**
 * Admits one registration per flow name at a time. A registration that
 * re-enters its own name's admission would wait on itself, so it dies.
 */
const makeRegistrationGate = () => {
  const gates = new Map<string, Gate>()
  const enter = (name: string) =>
    Effect.sync(() => {
      const gate = gates.get(name) ?? { semaphore: Semaphore.makeUnsafe(1), users: 0 }
      gates.set(name, gate)
      gate.users++
      return gate
    })
  // Waiters count as users, so cancellation cannot replace the lock while
  // another admission still owns or awaits it.
  const leave = (name: string, gate: Gate) =>
    Effect.sync(() => {
      if (--gate.users === 0) gates.delete(name)
    })
  return <A, E, R>(name: string, admission: Effect.Effect<A, E, R>) =>
    Effect.flatMap(CurrentRegistrations, (ancestors) => {
      if (ancestors.some((entry) => entry.owner === gates && entry.name === name)) {
        const message = `Flow ${name} cannot recursively register itself while admission is in progress`
        return Effect.die(new RegistrationFault({ flowName: name, message }))
      }
      const admitting = [...ancestors, { owner: gates, name }]
      return Effect.acquireUseRelease(
        enter(name),
        (gate) => gate.semaphore.withPermit(admission).pipe(Effect.provideService(CurrentRegistrations, admitting)),
        (gate) => leave(name, gate)
      )
    })
}

/**
 * Lists the registration under its flow's tag until its scope closes. A
 * handoff names its next round's flow by tag, so the trampoline reads the
 * declaration back from here.
 */
const declare = (declarations: Declarations, flow: Flow.Any, scope: Scope.Closeable) =>
  Effect.suspend(() => {
    const registration = { flow, scope }
    const entries = declarations.get(flow._tag) ?? []
    declarations.set(flow._tag, entries)
    entries.push(registration)
    return Scope.addFinalizer(
      scope,
      Effect.sync(() => {
        entries.splice(entries.indexOf(registration), 1)
        if (entries.length === 0) declarations.delete(flow._tag)
      })
    )
  })

/**
 * Fails with a body error the flow declares, and dies with any other. The
 * defect is the error itself, not the schema issue about it, so the message
 * survives; and a defect, unlike an undeclared failure, can be encoded into
 * the settled run. `FlowProxyServer` redacts it before it leaves the process.
 */
const failDeclared = (flow: Flow.Any, error: unknown) =>
  Effect.matchEffect(flow.errorSchema.makeEffect(error), {
    onFailure: () =>
      Effect.logError("A flow body failed with an error outside its declared error schema").pipe(
        Effect.annotateLogs({ flow: flow._tag, error: renderDiagnostic(error) }),
        Effect.andThen(Effect.die(error))
      ),
    onSuccess: () => Effect.fail(error)
  })

/** Checks a round's success against the declared schema. A handoff round has none of its own. */
const succeedDeclared = (flow: Flow.Any, value: unknown) =>
  Effect.flatMap(FlowRuntime.FlowInstance, (instance) =>
    instance.handoff === undefined
      ? Effect.as(Effect.orDie(flow.successSchema.makeEffect(value)), value)
      : Effect.succeed(value))

/**
 * Wraps a registered body for the driver: bounded by the flow's deadline,
 * held to its declared schemas and capability ceilings, and run with the
 * registration's services under the caller's, in a fresh dispatch context.
 */
const declaredHandler = (
  flow: Flow.Any,
  services: Context.Context<FlowRuntime.FlowRuntime>,
  execute: (payload: object, executionId: string) => Effect.Effect<unknown, unknown, unknown>
): Handler => {
  const bounded = Deadline.bound({ flowName: flow._tag, deadline: flow.deadline })
  return (payload, executionId) =>
    Effect.suspend(() => bounded(execute(payload, executionId))).pipe(
      Effect.matchEffect({
        onFailure: (error) => failDeclared(flow, error),
        onSuccess: (value) => succeedDeclared(flow, value)
      }),
      Flow.attenuateCapabilities(Flow.capabilityCeilings(flow.annotations)),
      Effect.updateContext((input) => {
        const caller = input.pipe(Context.omit(CurrentRegistrations))
        return resetActionContext(Context.merge(services, caller)) as Context.Context<any>
      })
    )
}

const makeRegister = (options: Encoded, declarations: Declarations): Port["register"] => {
  const withRegistrationGate = makeRegistrationGate()
  // Only the driver's registration may be interrupted; its failure closes the
  // registration's scope.
  const admit = (flow: Flow.Any, handler: Handler, ifAbsent: boolean) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function*() {
        // The gate keeps a losing lazy admission behind the real handler's
        // construction. Skipping acquires no registration resources.
        if (ifAbsent && declarations.has(flow._tag)) return
        const scope = yield* Scope.fork(yield* Effect.scope)
        yield* declare(declarations, flow, scope)
        const register = options.register(flow, handler).pipe(Effect.provideService(Scope.Scope, scope))
        yield* restore(register).pipe(Effect.onError((cause) => Scope.close(scope, Exit.failCause(cause))))
      })
    )
  // Untraced because registering a flow recursively re-enters the engine.
  return Effect.fnUntraced(function*(flow, execute, registrationOptions) {
    const services = (yield* Effect.context<FlowRuntime.FlowRuntime>()).pipe(Context.omit(CurrentRegistrations))
    const handler = declaredHandler(flow, services, execute)
    return yield* withRegistrationGate(flow._tag, admit(flow, handler, registrationOptions?.ifAbsent === true))
  })
}

/** The driver stores exits encoded; the port's encoding services are the caller's to provide. */
const encodeExit = <Success extends Schema.Constraint, Error extends Schema.Constraint>(
  deferred: DurableDeferred.DurableDeferred<Success, Error>,
  exit: Exit.Exit<Success["Type"], Error["Type"]>
) => Schema.encodeEffect(deferred.exitSchema)(exit) as Effect.Effect<Exit.Exit<unknown, unknown>>

const makeDeferredResult = (options: Encoded): Port["deferredResult"] =>
  Effect.fnUntraced(
    function*<Success extends Schema.Constraint, Error extends Schema.Constraint>(
      deferred: DurableDeferred.DurableDeferred<Success, Error>
    ) {
      const instance = yield* FlowRuntime.FlowInstance
      yield* Effect.annotateCurrentSpan({ executionId: instance.executionId })
      const exit = yield* options.deferredResult(deferred)
      if (Option.isNone(exit)) return Option.none()
      // A persisted result consumes the wait annotation, so a replayed
      // `annotateWaiting` cannot classify a later, unrelated suspension
      // (issue #42).
      instance.waiting = undefined
      const decoded = Schema.decodeEffect(deferred.exitSchema)(toJsonExit(exit.value))
      return Option.some(yield* Effect.orDie(decoded) as Effect.Effect<Exit.Exit<Success["Type"], Error["Type"]>>)
    },
    Effect.withSpan(
      "FlowEngine.deferredResult",
      (deferred) => ({ attributes: { name: deferred.name } }),
      { captureStackTrace: false }
    )
  )

const makeDeferredDone = (options: Encoded): Port["deferredDone"] =>
  Effect.fnUntraced(
    function*(deferred, done) {
      const exit = yield* encodeExit(deferred, done.exit)
      const { deferredName, executionId, flowName } = done
      return yield* options.deferredDone({ flowName, executionId, deferredName, exit })
    },
    Effect.withSpan(
      "FlowEngine.deferredDone",
      (_, { deferredName, executionId }) => ({ attributes: { name: deferredName, executionId } }),
      { captureStackTrace: false }
    )
  )

const makeDeferredDoneIfWaiting = (options: Encoded): Port["deferredDoneIfWaiting"] =>
  Effect.fnUntraced(
    function*(deferred, done) {
      if (options.deferredDoneIfWaiting === undefined) return "NotWaiting" as const
      const exit = yield* encodeExit(deferred, done.exit)
      const { deferredName, executionId, flowName, reason, token } = done
      return yield* options.deferredDoneIfWaiting({ flowName, executionId, deferredName, reason, token, exit })
    },
    Effect.withSpan(
      "FlowEngine.deferredDoneIfWaiting",
      (_, { deferredName, executionId, reason }) => ({ attributes: { name: deferredName, executionId, reason } }),
      { captureStackTrace: false }
    )
  )

/** The store's `retryFrom`, traced. */
const makeRetryFrom = (
  retryFrom: NonNullable<Encoded["retryFrom"]>
): NonNullable<Port["retryFrom"]> =>
(flow, options) =>
  retryFrom(flow, options).pipe(
    Effect.withSpan(
      "FlowEngine.retryFrom",
      { attributes: { executionId: options.executionId, source: options.source, flow: flow._tag } },
      { captureStackTrace: false }
    )
  )

/**
 * Builds a typed `FlowRuntime` service from a low-level encoded
 * implementation.
 *
 * **When to use**
 *
 * Use when wiring a trusted low-level flow engine implementation into the
 * typed `FlowRuntime` port.
 *
 * **Gotchas**
 *
 * The implementation must correctly persist, resume, and encode flow state.
 *
 * @category constructors
 * @since 0.1.0
 */
export const makeUnsafe = (options: Encoded): FlowRuntime.FlowRuntime["Service"] => {
  // A handoff crosses the journal by tag; retain its declaration to decode
  // the next round's payload and read its round budget.
  const declarations: Declarations = new Map()
  return FlowRuntime.FlowRuntime.of({
    register: makeRegister(options, declarations),
    // A placement the `Hosts` table binds elsewhere runs on that engine.
    execute: placeExecute(makeExecute(options, declarations)),
    poll: options.poll,
    interrupt: placeInterrupt(options.interrupt),
    interruptUnsafe: options.interruptUnsafe,
    resume: placeResume(options.resume),
    actionExecute: makeActionExecute(options),
    deferredResult: makeDeferredResult(options),
    deferredDone: makeDeferredDone(options),
    deferredDoneIfWaiting: makeDeferredDoneIfWaiting(options),
    scheduleClock: (flow, request) =>
      options.scheduleClock(flow, request).pipe(
        Effect.withSpan(
          "FlowEngine.scheduleClock",
          { attributes: { executionId: request.executionId, name: request.clock.name } },
          { captureStackTrace: false }
        )
      ),
    // Forwarded only when the store keeps history: the interpreter builds no
    // node records for a store that has nowhere to keep them, and a retry
    // from a step has nothing to replay.
    ...(options.retryFrom === undefined ? {} : { retryFrom: placeRetryFrom(makeRetryFrom(options.retryFrom)) }),
    ...(options.recordNode === undefined ? {} : { recordNode: options.recordNode }),
    ...(options.nodeRecordBytes === undefined ? {} : { nodeRecordBytes: options.nodeRecordBytes })
  })
}

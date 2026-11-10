/**
 * A volatile, in-memory implementation of the flow runtime port.
 *
 * @since 0.1.0
 */

import * as CapabilitySet from "@smthrs/capability/CapabilitySet"
import { type DurableDeferred, Flow, FlowRuntime } from "@smthrs/flow"
import { ExecutionIdentityConflict } from "@smthrs/flow/FlowRuntime"
import * as Cause from "effect/Cause"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as FiberMap from "effect/FiberMap"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as RpcSerialization from "effect/rpc/RpcSerialization"
import * as Schema from "effect/Schema"
import type * as Scope from "effect/Scope"
import * as Semaphore from "effect/Semaphore"
import { bindHostCeiling, joinable, requestedAuthority } from "./Authority.ts"
import type { ActionExecuteOptions, Encoded } from "./Encoded.ts"
import { makeInstance } from "./FlowInstance.ts"
import { makeUnsafe } from "./make.ts"
import type * as Round from "./Round.ts"
import { FlowNotRegistered } from "./Trampoline.ts"

export { ExecutionIdentityConflict } from "@smthrs/flow/FlowRuntime"

/**
 * The refusal of a join whose caller's capability ceiling does not cover the
 * one the execution was admitted with. Both drivers raise the same value.
 *
 * @category errors
 * @since 1.0.0
 */
export const capabilityConflict = (
  executionId: string,
  status: ExecutionIdentityConflict["status"] = "unknown"
): ExecutionIdentityConflict =>
  new ExecutionIdentityConflict({
    executionId,
    status,
    field: "capabilities",
    expected: "a capability ceiling covering the one the execution was admitted with",
    actual: "a capability ceiling that does not cover it",
    message: `execution ${executionId} was admitted under authority this caller's capability ceiling ` +
      "does not cover; it cannot be joined under this one"
  })

type Port = FlowRuntime.FlowRuntime["Service"]
type Instance = FlowRuntime.FlowInstance["Service"]
type Result = Flow.Result<unknown, unknown>
type Status = ExecutionIdentityConflict["status"]
type ExecuteOptions = Parameters<Encoded["execute"]>[1]
type DeferredDone = Parameters<Encoded["deferredDone"]>[0]
type DeferredDoneIfWaiting = Parameters<NonNullable<Encoded["deferredDoneIfWaiting"]>>[0]
type Restore = <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>

/** One registration of a flow's handler, serving until its scope closes. */
interface Registration {
  readonly flow: Flow.Any
  readonly execute: (
    payload: object,
    executionId: string
  ) => Effect.Effect<unknown, unknown, FlowRuntime.FlowInstance | FlowRuntime.FlowRuntime>
  readonly scope: Scope.Scope
}

/** One admitted execution and the round fiber currently driving it. */
interface ExecutionState {
  readonly capabilityCeilings: CapabilitySet.CapabilitySet["groups"]
  readonly payload: unknown
  readonly rootExecutionId: Round.RootExecutionId
  instance: Instance
  fiber: Fiber.Fiber<Result> | undefined
  /**
   * The fiber the flow body actually runs in: `Flow.intoResult` forks the
   * body as a child of the round fiber, and a normal `interrupt` targets
   * this child so the round fiber survives to CONVERT the interruption
   * into the recorded cancellation instead of dying on it.
   */
  bodyFiber: Fiber.Fiber<unknown, unknown> | undefined
}

/** One action dispatch by key and attempt, and its settlement once it has one. */
interface ActionState {
  readonly settlement: Deferred.Deferred<Exit.Exit<Result>>
  exit: Exit.Exit<Result> | undefined
}

/** The admission lock of one execution id, alive while anyone holds or awaits it. */
interface Lock {
  readonly semaphore: Semaphore.Semaphore
  users: number
}

/** Everything one in-memory engine holds. */
interface Memory {
  /** The layer's scope: a completed child's re-drive of its parent forks here. */
  readonly scope: Scope.Scope
  /** The port this engine answers as, which every body it drives is given. */
  readonly engine: () => Port
  /** The serializer action results are stored with, read once when the layer is built. */
  readonly serialization: RpcSerialization.RpcSerialization["Service"]
  /**
   * Registrations by tag. They stack: the last still-open one serves, and a
   * closed inner registration is spliced back out so the outer one serves
   * again, the same restore `make.register`'s declaration table performs.
   */
  readonly flows: Map<string, Array<Registration>>
  readonly executions: Map<string, ExecutionState>
  /**
   * Payload constructors and identity codecs may suspend, so admission and
   * drive installation are serialized per id; the body and other ids are not.
   */
  readonly executionLocks: Map<string, Lock>
  /**
   * In-process wakes for callers parked on the suspension backoff sleep.
   * Edge-triggered and miss-tolerant like engine-store's WakeBus: a wake
   * completes the deferred the current subscribers await and drops it, so the
   * next subscription starts a fresh one and polling stays the fallback for a
   * wake that landed before the subscription.
   */
  readonly wakes: Map<string, Deferred.Deferred<void>>
  /**
   * Trampoline membership, keyed by root execution id rather than the journal
   * lineage on an instance, so a cancellation survives the gap before the
   * next round exists.
   */
  readonly rounds: Map<Round.RootExecutionId, Set<string>>
  readonly cancelledLineages: Set<Round.RootExecutionId>
  /**
   * Every child execution request records an edge, including a fan-in that
   * joins an existing execution. This mirrors the durable engine's edge
   * table: keeping only the original parent would miss second-parent
   * cycles and let the participants join one another forever.
   */
  readonly parents: Map<string, Set<string>>
  readonly children: Map<string, Set<string>>
  readonly actions: Map<string, ActionState>
  readonly deferredResults: Map<string, Exit.Exit<any, any>>
  readonly clocks: FiberMap.FiberMap<string>
  /**
   * Executions a resume found with a live round, since that round was driven.
   * A completion recorded then is one the round may park without reading, so
   * only a re-drive can deliver it; a follower's poll does that.
   */
  readonly missedWakes: Set<string>
}

const makeMemory = (
  scope: Scope.Scope,
  clocks: FiberMap.FiberMap<string>,
  engine: () => Port,
  serialization: RpcSerialization.RpcSerialization["Service"]
): Memory => ({
  scope,
  engine,
  serialization,
  flows: new Map(),
  executions: new Map(),
  executionLocks: new Map(),
  wakes: new Map(),
  rounds: new Map(),
  cancelledLineages: new Set(),
  parents: new Map(),
  children: new Map(),
  actions: new Map(),
  deferredResults: new Map(),
  clocks,
  missedWakes: new Set()
})

const exitStatus = (exit: Exit.Exit<unknown, unknown>): Status => {
  if (Exit.isSuccess(exit)) return "completed"
  return Cause.hasInterruptsOnly(exit.cause) ? "cancelled" : "failed"
}

const executionStatus = (state: ExecutionState): Status => {
  const exit = state.fiber?.pollUnsafe()
  if (exit === undefined) return "running"
  if (Exit.isFailure(exit)) return exitStatus(exit)
  const result = exit.value
  if (result._tag === "Suspended") return "suspended"
  if (result._tag === "Handoff") return "completed"
  return exitStatus(result.exit)
}

/**
 * A round fiber that settled `Suspended` is the only state a re-drive or a
 * conditional completion continues from. A live round is still running, and
 * every other settlement — an answer, a hand-off to the next round, or a
 * Failure exit from a defect that escaped capture — is terminal, so acting on
 * it would re-run the body's effects.
 */
const settledSuspended = (state: ExecutionState): boolean => {
  const exit = state.fiber?.pollUnsafe()
  return exit !== undefined && Exit.isSuccess(exit) && exit.value._tag === "Suspended"
}

/** The execution `executionId` names, when it is one of `flow`'s. */
const executionOf = (memory: Memory, flow: Flow.Any, executionId: string): ExecutionState | undefined => {
  const state = memory.executions.get(executionId)
  return state?.instance.flow._tag === flow._tag ? state : undefined
}

/**
 * Refuses a poll or resume of an execution of `flow` whose caller's
 * authority does not cover the authority `state` was admitted with.
 */
const authorize = (flow: Flow.Any, state: ExecutionState, executionId: string): Effect.Effect<void> =>
  Effect.flatMap(requestedAuthority(flow), (requested) =>
    joinable(state.capabilityCeilings, requested)
      ? Effect.void
      : Effect.die(capabilityConflict(executionId, executionStatus(state))))

/** Runs `effect` holding the admission lock of `executionId`. */
const withExecutionLock = <A, E, R>(memory: Memory, executionId: string, effect: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const lock = memory.executionLocks.get(executionId) ?? { semaphore: Semaphore.makeUnsafe(1), users: 0 }
      memory.executionLocks.set(executionId, lock)
      lock.users++
      return lock
    }),
    (lock) => lock.semaphore.withPermit(effect),
    // Count waiters as well as holders: cancelling one waiter must not
    // replace the semaphore underneath another. Rejected ids retain none.
    (lock) =>
      Effect.sync(() => {
        if (--lock.users === 0) memory.executionLocks.delete(executionId)
      })
  )

/** Wakes every caller parked on `executionId`'s suspension backoff. */
const wake = (memory: Memory, executionId: string): void => {
  const pending = memory.wakes.get(executionId)
  if (pending === undefined) return
  memory.wakes.delete(executionId)
  Deferred.doneUnsafe(pending, Exit.void)
}

/** The path from `parent` up through its ancestors to `child`, when one exists. */
const ancestorPath = (
  parents: Map<string, Set<string>>,
  child: string,
  parent: string
): ReadonlyArray<string> | undefined => {
  const pending: Array<readonly [string, ReadonlyArray<string>]> = [[parent, [parent]]]
  const visited = new Set<string>()
  while (pending.length > 0) {
    const [current, path] = pending.shift()!
    if (current === child) return path
    if (visited.has(current)) continue
    visited.add(current)
    for (const ancestor of parents.get(current) ?? []) pending.push([ancestor, [...path, ancestor]])
  }
  return undefined
}

const addEdge = (edges: Map<string, Set<string>>, from: string, to: string): void => {
  const linked = edges.get(from) ?? new Set<string>()
  linked.add(to)
  edges.set(from, linked)
}

/** Validates and records an ownership edge without an asynchronous publication gap. */
const linkParent = (memory: Memory, child: string, parent: string): FlowRuntime.FlowCycleDetected | undefined => {
  const path = ancestorPath(memory.parents, child, parent)
  if (path !== undefined) {
    return new FlowRuntime.FlowCycleDetected({ code: "flow_cycle_detected", path: [...path].reverse() })
  }
  addEdge(memory.parents, child, parent)
  addEdge(memory.children, parent, child)
  return undefined
}

/** Records `child` under `parent`, refusing an edge that would close a cycle. */
const recordParent = (memory: Memory, child: string, parent: string) =>
  Effect.suspend(() => {
    const error = linkParent(memory, child, parent)
    return error === undefined ? Effect.void : Effect.fail(error)
  })

const parentCancelled = (memory: Memory, parent: Instance): boolean => {
  const state = memory.executions.get(parent.executionId)
  return parent.interrupted || state?.instance.interrupted === true ||
    (state !== undefined && memory.cancelledLineages.has(state.rootExecutionId))
}

/**
 * Marks `state` and its lineage cancelled. Answers the lineage's rounds the
 * first time the lineage is reached, and nothing after.
 */
const cancelState = (
  memory: Memory,
  state: ExecutionState,
  visitedLineages: Set<Round.RootExecutionId>
): Iterable<string> => {
  state.instance.interrupted = true
  const root = state.rootExecutionId
  memory.cancelledLineages.add(root)
  if (visitedLineages.has(root)) return []
  visitedLineages.add(root)
  return memory.rounds.get(root)!
}

/**
 * Marks `executionId`, every round of each lineage it reaches, and every
 * child below them cancelled, and answers each execution it reached. All
 * intent is published synchronously before any interrupt or re-drive is
 * sent, so a body that admits another child during cleanup inherits it.
 */
const requestCancellation = (memory: Memory, executionId: string): ReadonlyArray<string> => {
  const pending = [executionId]
  const seen = new Set(pending)
  const visitedLineages = new Set<Round.RootExecutionId>()
  const admit = (id: string) => {
    if (seen.has(id)) return
    seen.add(id)
    pending.push(id)
  }
  for (let index = 0; index < pending.length; index++) {
    const id = pending[index]!
    // Ownership edges and round membership are published only with their execution.
    const state = memory.executions.get(id)!
    const rounds = cancelState(memory, state, visitedLineages)
    for (const round of rounds) admit(round)
    for (const child of memory.children.get(id) ?? []) admit(child)
  }
  return pending
}

/**
 * Rebuilds one payload through the flow's own payload schema.
 *
 * The engine stores a rebuilt copy and rebuilds again for every drive, so
 * neither the caller that submitted the payload nor a handler that mutated
 * the value it received can reach the value a later drive runs on. The
 * schema constructor is the copier because it is the only description of
 * the payload the engine has: it rebuilds each struct, array, and record
 * it declares, and it hands back by reference the values it declares
 * opaque, such as a `Schema.declare` reference to a live object. Copying
 * through `Schema.toCodecJson` instead, as this did until 2026-09-01,
 * demanded a JSON representation of every member and so refused any
 * payload holding a declared reference, including every `smithers-build`
 * target that names a dependency. The constructor also belongs to the
 * schema object itself, so a flow authored against a second `effect`
 * instance is rebuilt by the instance that owns it.
 */
const snapshot = (flow: Flow.Any, value: unknown): Effect.Effect<unknown> =>
  Effect.orDie(flow.payloadSchema.makeEffect(value as never))

const isPlainObject = (value: object): boolean => {
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/** Whether two objects are arrays of one length, or both plain objects. */
const sameContainer = (left: object, right: object): boolean => {
  const leftArray = Array.isArray(left)
  if (leftArray !== Array.isArray(right)) return false
  if (leftArray) return left.length === (right as Array<unknown>).length
  return isPlainObject(left) && isPlainObject(right)
}

const sameEntries = (left: object, right: object, depth: number): boolean => {
  const leftKeys = Object.keys(left)
  if (leftKeys.length !== Object.keys(right).length) return false
  return leftKeys.every((key) =>
    Object.hasOwn(right, key) &&
    sameShape((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key], depth - 1)
  )
}

/**
 * JSON identity, with a conservative fallback for memory-only payloads.
 * Plain objects and arrays are structural even when declared opaque; other
 * references only match themselves. Bounds cycles and deep inputs.
 */
const sameShape = (left: unknown, right: unknown, depth: number): boolean => {
  if (Object.is(left, right) || (left === 0 && right === 0)) return true
  if (depth === 0) return false
  if (typeof left !== "object" || left === null) return false
  if (typeof right !== "object" || right === null) return false
  try {
    return sameContainer(left, right) && sameEntries(left, right, depth)
  } catch {
    return false
  }
}

const samePayload = (flow: Flow.Any, left: unknown, right: unknown): Effect.Effect<boolean> =>
  Effect.gen(function*() {
    // A declared live reference need not have a JSON codec. Codec
    // construction itself can throw, so include it in the fallback.
    const encoded = yield* Effect.exit(Effect.suspend(() => {
      const encode = Schema.encodeEffect(Schema.toCodecJson(flow.payloadSchema))
      return Effect.zip(encode(left as never), encode(right as never)) as Effect.Effect<
        [Schema.Json, Schema.Json],
        Schema.SchemaError
      >
    }))
    return Exit.isSuccess(encoded)
      ? sameShape(encoded.value[0], encoded.value[1], 64)
      : sameShape(left, right, 64)
  })

/**
 * Answers a recorded settlement under `flow`'s schemas. Memory stores decoded
 * values, so it validates the Type side: a transform such as NumberFromString
 * must not decode an already-decoded number.
 */
const settlement = (memory: Memory, flow: Flow.Any, executionId: string, result: Result): Effect.Effect<Result> =>
  Flow.Result({
    success: Schema.toType(flow.successSchema),
    error: Schema.toType(flow.errorSchema)
  }).makeEffect(result).pipe(
    Effect.catch(() => Effect.die(settlementConflict(memory, flow, executionId)))
  )

const settlementConflict = (memory: Memory, flow: Flow.Any, executionId: string) =>
  new ExecutionIdentityConflict({
    executionId,
    status: executionStatus(memory.executions.get(executionId)!),
    field: "flow",
    expected: "schemas compatible with the recorded settlement",
    actual: flow._tag,
    message: `execution ${executionId} has a settlement incompatible with the schemas of flow ${flow._tag}`
  })

/**
 * Runs as the forked body fiber's first instruction: it hands `interrupt`
 * the fiber the body runs in, and it answers a cancellation that landed
 * BEFORE the body started — the flag is already set, so the body
 * self-interrupts instead of dispatching work whose cancellation was
 * requested.
 */
const startBody = (
  state: ExecutionState,
  instance: Instance,
  body: Effect.Effect<unknown, unknown, FlowRuntime.FlowInstance | FlowRuntime.FlowRuntime>
) =>
  Effect.withFiber<unknown, unknown, FlowRuntime.FlowInstance | FlowRuntime.FlowRuntime>((fiber) => {
    state.bodyFiber = fiber
    return instance.interrupted ? Effect.interrupt : body
  })

/** Ends a cancelled round's body interrupted, never parked. */
const interruptCancelled = (instance: Instance) => {
  if (!instance.interrupted) return Effect.void
  instance.suspended = false
  return Effect.withFiber((fiber) => Effect.interruptible(Fiber.interrupt(fiber)))
}

/**
 * Expiry ends the attached lineage without turning the originator's deadline
 * failure into an interrupt. It publishes the same intent that late linked
 * admissions observe before delivering subtree requests.
 */
const endExpiredLineage = (memory: Memory, state: ExecutionState, result: Result) => {
  if (result._tag !== "Complete" || Exit.isSuccess(result.exit)) return Effect.void
  if (!(Cause.squash(result.exit.cause) instanceof Flow.DeadlineExceeded)) return Effect.void
  memory.cancelledLineages.add(state.rootExecutionId)
  const rounds = [...memory.rounds.get(state.rootExecutionId)!]
  const linked = new Set(rounds.flatMap((round) => [...(memory.children.get(round) ?? [])]))
  return Effect.forEach(linked, (id) => interruptExecution(memory, id), { discard: true })
}

/** A completed child re-drives every parent that may be parked on it. */
const redriveParent = (memory: Memory, state: ExecutionState, result: Result) => {
  if (result._tag !== "Complete") return Effect.void
  return Effect.forEach(
    memory.parents.get(state.instance.executionId) ?? [],
    (parent) => Effect.forkIn(resume(memory, parent), memory.scope),
    { discard: true }
  )
}

/**
 * Forks one round of `state` in its registration's scope: the body runs on a
 * fresh copy of the payload, under the execution's admitted ceilings, with
 * this engine and the round's instance provided.
 */
const drive = (memory: Memory, state: ExecutionState, entry: Registration, instance: Instance) =>
  snapshot(instance.flow, state.payload).pipe(
    Effect.flatMap((payload) => entry.execute(payload as object, instance.executionId)),
    CapabilitySet.attenuateGroups(state.capabilityCeilings),
    (body) => startBody(state, instance, body),
    Effect.onExit(() => interruptCancelled(instance)),
    Flow.intoResult,
    Effect.provideService(FlowRuntime.FlowInstance, instance),
    Effect.provideService(FlowRuntime.FlowRuntime, memory.engine()),
    Effect.tap((result) => endExpiredLineage(memory, state, result)),
    Effect.tap((result) => redriveParent(memory, state, result)),
    Effect.onExit(() => Effect.sync(() => wake(memory, state.instance.executionId))),
    Effect.forkIn(entry.scope)
  )

// Untraced because resume recursively drives suspended executions.
const resumeUnlocked = Effect.fnUntraced(function*(
  memory: Memory,
  executionId: string,
  state: ExecutionState,
  admittedEntry?: Registration
): Effect.fn.Return<void> {
  wake(memory, executionId)
  // Only the first drive and a suspended round are driven: a live round
  // keeps running, and every other settlement is terminal.
  if (state.fiber !== undefined && !settledSuspended(state)) {
    if (state.fiber.pollUnsafe() === undefined) memory.missedWakes.add(executionId)
    return
  }
  // The latest still-open registration serves every drive, so a re-drive
  // after an inner scoped registration of the tag closed follows the outer
  // one exactly as `make.register`'s declaration table does. With every
  // registration closed the execution stays parked for a process that
  // registers the flow again, the posture the durable driver takes for a run
  // that wakes where its flow is unknown.
  const entry = admittedEntry ?? memory.flows.get(state.instance.flow._tag)?.at(-1)
  if (entry === undefined) return
  const previous = state.instance
  const instance = makeInstance(previous.flow, previous.executionId, previous.lineageDeadline)
  instance.interrupted = previous.interrupted
  state.instance = instance
  memory.missedWakes.delete(executionId)
  state.fiber = yield* drive(memory, state, entry, instance)
})

/** Drives `executionId` under its admission lock, unless another drive replaced its round meanwhile. */
const resume = (memory: Memory, executionId: string): Effect.Effect<void> =>
  Effect.suspend(() => {
    const state = memory.executions.get(executionId)
    if (state === undefined) return Effect.void
    const previous = state.fiber
    return withExecutionLock(
      memory,
      executionId,
      Effect.suspend(() => state.fiber === previous ? resumeUnlocked(memory, executionId, state) : Effect.void)
    )
  })

/**
 * Interrupts a LIVE round's body fiber rather than the round fiber: the
 * round fiber then converts it into the recorded cancellation — `Complete`
 * with an interrupt cause, after the body's finalizers ran — where
 * interrupting the round fiber itself would leave `poll` dying on a bare
 * interrupt exit. Delivery is a send, not an await: the contract is a
 * cancellation REQUEST, and a body pinned in an uninterruptible region
 * settles on its own time with the request already recorded. A round fiber
 * that has not started yet has no body fiber; its body observes the flag and
 * self-interrupts on start.
 */
const interruptBody = (state: ExecutionState) => {
  const body = state.bodyFiber
  if (body === undefined) return Effect.void
  return Effect.withFiber((fiber) => Effect.sync(() => body.interruptUnsafe(fiber.id)))
}

/** Cancels `executionId` and everything it owns: live rounds are interrupted, parked ones re-driven to settle. */
const interruptExecution = Effect.fnUntraced(function*(memory: Memory, executionId: string) {
  for (const target of requestCancellation(memory, executionId)) {
    const state = memory.executions.get(target)!
    // `execute` installs the state and synchronously starts `resume`
    // before it can return its execution id, so every publicly
    // observable execution has a round fiber to inspect.
    if (state.fiber!.pollUnsafe() === undefined) yield* interruptBody(state)
    else yield* resume(memory, target)
  }
})

const registrationMissing = (flow: Flow.Any) =>
  new FlowNotRegistered({ flowName: flow._tag, message: `Flow ${flow._tag} is not registered` })

/**
 * An execution id names one run of one flow declaration and one rebuilt
 * payload snapshot. A reused id may join only when both identities match,
 * exactly as the durable driver's `ensureCreatedRun` does. The id is
 * caller-supplied identity, so a multi-tenant server must namespace it
 * before requests share an engine.
 */
const refuseForeignFlow = (state: ExecutionState, flow: Flow.Any, executionId: string) => {
  const owner = state.instance.flow._tag
  if (owner === flow._tag) return Effect.void
  return Effect.die(
    new ExecutionIdentityConflict({
      executionId,
      status: executionStatus(state),
      field: "flow",
      expected: owner,
      actual: flow._tag,
      message: `execution ${executionId} already belongs to flow ${owner}; it cannot be reused for flow ${flow._tag}`
    })
  )
}

const payloadConflict = (state: ExecutionState, executionId: string) =>
  new ExecutionIdentityConflict({
    executionId,
    status: executionStatus(state),
    field: "payload",
    expected: "the payload the execution was admitted with",
    actual: "a different payload",
    message: `execution ${executionId} was started with a different input; choose a new executionId to run this input`
  })

/**
 * Refuses a join that carries another payload, or authority that does not
 * cover the admitted one: a join answers the result the run's admitted
 * authority produced.
 */
const refuseJoin = Effect.fnUntraced(function*(
  state: ExecutionState,
  flow: Flow.Any,
  options: ExecuteOptions,
  requested: CapabilitySet.CapabilitySet["groups"]
) {
  const payload = yield* snapshot(flow, options.payload)
  if (!(yield* samePayload(flow, state.payload, payload))) {
    return yield* Effect.die(payloadConflict(state, options.executionId))
  }
  if (!joinable(state.capabilityCeilings, requested)) {
    return yield* Effect.die(capabilityConflict(options.executionId, executionStatus(state)))
  }
})

/** Publishes an admitted execution and installs its driver in one step. */
const publish = (memory: Memory, executionId: string, state: ExecutionState, parent?: Instance) =>
  Effect.uninterruptible(Effect.suspend(() => {
    const entry = memory.flows.get(state.instance.flow._tag)?.at(-1)
    if (entry === undefined) return Effect.die(registrationMissing(state.instance.flow))
    if (parent !== undefined) {
      const error = linkParent(memory, executionId, parent.executionId)
      if (error !== undefined) return Effect.fail(error)
    }
    memory.executions.set(executionId, state)
    const members = memory.rounds.get(state.rootExecutionId) ?? new Set<string>()
    members.add(executionId)
    memory.rounds.set(state.rootExecutionId, members)
    return resumeUnlocked(memory, executionId, state, entry)
  }))

/**
 * Admits a new execution. It inherits a cancellation already requested for
 * its lineage or its parent, and it stores a rebuilt payload that never
 * crosses into user code: every drive rebuilds its own copy, so caller and
 * handler mutation cannot alter a replay.
 */
const install = Effect.fnUntraced(function*(
  memory: Memory,
  flow: Flow.Any,
  options: ExecuteOptions,
  requested: CapabilitySet.CapabilitySet["groups"]
) {
  const payload = yield* snapshot(flow, options.payload)
  const rootExecutionId = options.round.rootExecutionId
  const instance = makeInstance(flow, options.executionId, options.lineageDeadline)
  const parent = options.parent
  instance.interrupted = memory.cancelledLineages.has(rootExecutionId) ||
    (parent !== undefined && parentCancelled(memory, parent))
  if (instance.interrupted) memory.cancelledLineages.add(rootExecutionId)
  const state: ExecutionState = {
    payload,
    capabilityCeilings: requested,
    instance,
    rootExecutionId,
    fiber: undefined,
    bodyFiber: undefined
  }
  // All asynchronous payload rebuilding now belongs to the driver, inside
  // `Flow.intoResult`.
  yield* publish(memory, options.executionId, state, parent)
  return state
})

/**
 * Admits the execution `options` names, or joins the one already admitted
 * under its id. Joining is also child admission: an existing independent run
 * must not escape an already-cancelled parent's ownership edge, so the join
 * reports that its run must be cancelled.
 */
const admit = Effect.fnUntraced(function*(memory: Memory, flow: Flow.Any, options: ExecuteOptions) {
  if (memory.flows.get(flow._tag)?.at(-1) === undefined) return yield* Effect.die(registrationMissing(flow))
  const existing = memory.executions.get(options.executionId)
  if (existing !== undefined) yield* refuseForeignFlow(existing, flow, options.executionId)
  const requested = yield* requestedAuthority(flow)
  if (existing !== undefined) yield* refuseJoin(existing, flow, options, requested)
  if (existing === undefined) return { state: yield* install(memory, flow, options, requested), cancelJoined: false }
  if (options.parent !== undefined) yield* recordParent(memory, options.executionId, options.parent.executionId)
  return { state: existing, cancelJoined: options.parent !== undefined && parentCancelled(memory, options.parent) }
})

// Untraced because execution recursively invokes child flows.
const execute = Effect.fnUntraced(function*(memory: Memory, flow: Flow.Any, options: ExecuteOptions) {
  const admitted = yield* withExecutionLock(memory, options.executionId, admit(memory, flow, options))
  // Delivered after releasing this id's admission lock: cancellation can
  // re-drive a parked child and acquires the same lock.
  if (admitted.cancelJoined) yield* memory.engine().interrupt(flow, options.executionId).pipe(Effect.orDie)
  if (options.discard) return
  return (yield* settlement(memory, flow, options.executionId, yield* Fiber.join(admitted.state.fiber!))) as any
})

/**
 * Stacks a registration under its flow's tag until its scope closes. Untraced
 * because registration feeds back into the in-memory engine.
 */
const register = Effect.fnUntraced(function*(
  memory: Memory,
  flow: Flow.Any,
  execute: Registration["execute"]
) {
  const registration: Registration = { flow, execute, scope: yield* Effect.scope }
  const entries = memory.flows.get(flow._tag) ?? []
  memory.flows.set(flow._tag, entries)
  entries.push(registration)
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      entries.splice(entries.indexOf(registration), 1)
      if (entries.length === 0) memory.flows.delete(flow._tag)
    })
  )
})

const interrupt = (memory: Memory, flow: Flow.Any, executionId: string) =>
  Effect.suspend(() => {
    const state = executionOf(memory, flow, executionId)
    if (state === undefined) return Effect.void
    return Effect.andThen(authorize(flow, state, executionId), interruptExecution(memory, executionId))
  })

// Untraced because interruption is coordinated from recursive execution.
const interruptUnsafe = Effect.fnUntraced(function*(memory: Memory, flow: Flow.Any, executionId: string) {
  const admitted = executionOf(memory, flow, executionId)
  if (admitted === undefined) return
  yield* authorize(flow, admitted, executionId)
  // `execute` installs the state and synchronously starts `resume` before it
  // can return its execution id. `resume` assigns this fiber without
  // yielding, so every publicly observable execution has one.
  yield* Effect.forEach(requestCancellation(memory, executionId), (target) => {
    const state = memory.executions.get(target)!
    return Fiber.interrupt(state.fiber!)
  }, { concurrency: "unbounded", discard: true })
})

/**
 * Drives an execution of this declaration that the caller's authority
 * covers; an unknown or foreign id drives nothing.
 */
const resumeAuthorized = (memory: Memory, flow: Flow.Any, executionId: string) =>
  Effect.suspend(() => {
    const state = executionOf(memory, flow, executionId)
    if (state === undefined) return Effect.void
    return Effect.andThen(authorize(flow, state, executionId), resume(memory, executionId))
  })

/** Whether a `DurableClock` timer this engine scheduled for `executionId` is still waiting to fire. */
const hasPendingClock = (memory: Memory, executionId: string): boolean => {
  for (const [key] of memory.clocks) {
    if ((JSON.parse(key) as ReadonlyArray<string>)[1] === executionId) return true
  }
  return false
}

/**
 * A follower's elapsed poll (`{ poll: true }`). As the durable engine does, it
 * re-drives a parked run only when a wake may be due: it leaves a run to the
 * timer this engine holds for it, which re-drives the run when it fires,
 * unless a completion may have landed while a round was live. Re-driving it
 * earlier replays the round only to park it again, once per poll.
 */
const pollResume = (memory: Memory, flow: Flow.Any, executionId: string) =>
  Effect.suspend(() => {
    const state = executionOf(memory, flow, executionId)
    const waitsOnItsTimer = state !== undefined && settledSuspended(state) && !state.instance.interrupted &&
      !memory.missedWakes.has(executionId) && hasPendingClock(memory, executionId)
    return waitsOnItsTimer ? authorize(flow, state, executionId) : resumeAuthorized(memory, flow, executionId)
  })

const resumeSignal = (memory: Memory, executionId: string) =>
  Effect.suspend(() => {
    const pending = memory.wakes.get(executionId) ?? Deferred.makeUnsafe<void>()
    memory.wakes.set(executionId, pending)
    return Deferred.await(pending)
  })

/**
 * The settlement an earlier dispatch of the same key and attempt owns, or
 * awaits. A suspended one is retired, so this dispatch runs the action again.
 */
const priorSettlement = (
  memory: Memory,
  actionId: string,
  restore: Restore,
  retry: () => Effect.Effect<Result>
) => {
  const prior = memory.actions.get(actionId)
  if (prior === undefined) return undefined
  const exit = prior.exit
  if (exit === undefined) {
    // The owner's cancellation is data for waiters, not their own interruption.
    // A removed owner leaves this dispatch free to claim the key again.
    return restore(Deferred.await(prior.settlement)).pipe(
      Effect.flatMap((settled) => Exit.isFailure(settled) ? restore(retry()) : settled)
    )
  }
  if (exit._tag === "Success" && exit.value._tag === "Suspended") {
    memory.actions.delete(actionId)
    return undefined
  }
  return exit
}

/** Keeps a settled dispatch for replay; an interrupted dispatch has no settlement to replay. */
const recordSettlement = (memory: Memory, owner: ActionState, actionId: string, exit: Exit.Exit<Result>) => {
  if (Exit.isSuccess(exit)) owner.exit = exit
  else memory.actions.delete(actionId)
  return Deferred.succeed(owner.settlement, exit)
}

/** Runs an action as the owner of its key and attempt, on an instance of its own. */
const runAction = (
  memory: Memory,
  instance: Instance,
  action: ActionExecuteOptions["action"],
  actionId: string,
  restore: Restore
) => {
  const owner: ActionState = { exit: undefined, settlement: Deferred.makeUnsafe<Exit.Exit<Result>>() }
  memory.actions.set(actionId, owner)
  const actionInstance = makeInstance(instance.flow, instance.executionId)
  actionInstance.interrupted = instance.interrupted
  // DECIDED: the waiting classification is threaded through the dispatch's
  // instance and back, because a driver gives an action its own instance
  // while `annotateWaiting` is documented to reach the parked run. An
  // implementation that declares one — `Sleep` under `timer`, `WaitFor` under
  // `event` with its wake token — writes it here, so without the thread-back
  // the driver would park on the derived default and the declaration would
  // be inert for every action. It is seeded as well as copied back so a body
  // that annotated before dispatching keeps its own declaration, and so the
  // consumption `deferredResult` performs on a settled wait travels out the
  // same way (issue #42).
  const waitingBefore = instance.waiting
  actionInstance.waiting = waitingBefore
  return restore(action.executeEncoded.pipe(
    Flow.intoResult,
    Effect.provideService(FlowRuntime.FlowInstance, actionInstance),
    Effect.provideService(RpcSerialization.RpcSerialization, memory.serialization)
  )).pipe(
    Effect.onExit((exit) => recordSettlement(memory, owner, actionId, exit)),
    Effect.ensuring(Effect.sync(() => {
      if (instance.waiting === waitingBefore) instance.waiting = actionInstance.waiting
    }))
  )
}

// Untraced because action execution is a retry-loop hot path.
const actionExecute = Effect.fnUntraced(function*(
  memory: Memory,
  options: ActionExecuteOptions
): Effect.fn.Return<Result, never, FlowRuntime.FlowInstance> {
  const instance = yield* FlowRuntime.FlowInstance
  // Publish ownership and install its settlement finalizer without an
  // interruptible gap. Even a scheduler yield during Deferred allocation
  // must not let a second caller claim the same key and attempt.
  return yield* Effect.uninterruptibleMask((restore) =>
    Effect.suspend(() => {
      const actionId = JSON.stringify([options.key, options.attempt])
      const prior = priorSettlement(memory, actionId, restore, () =>
        actionExecute(memory, options).pipe(Effect.provideService(FlowRuntime.FlowInstance, instance)))
      if (prior !== undefined) {
        return prior
      }
      return runAction(memory, instance, options.action, actionId, restore)
    })
  )
})

/** A round's settlement, once its fiber has one. */
const settledResult = (memory: Memory, flow: Flow.Any, executionId: string, state: ExecutionState) => {
  const exit = state.fiber?.pollUnsafe()
  if (!exit) return Effect.succeedNone
  if (exit._tag !== "Success") return Effect.die(exit.cause)
  return Effect.map(settlement(memory, flow, executionId, exit.value), Option.some)
}

/**
 * The settlement of an execution of `flow`. An unknown execution is a typed
 * failure, not `Option.none`: `none` is reserved for a known run that has
 * not settled yet. A run owned by another declaration has no settled result
 * from this flow's view; `none` matches the durable driver's posture and
 * avoids presenting another flow's encoded result under this one.
 */
const poll = (
  memory: Memory,
  flow: Flow.Any,
  executionId: string
): Effect.Effect<Option.Option<Result>, FlowRuntime.FlowExecutionNotFound> =>
  Effect.suspend(() => {
    const state = memory.executions.get(executionId)
    if (state === undefined) {
      return Effect.fail(new FlowRuntime.FlowExecutionNotFound({ code: "execution_not_found", executionId }))
    }
    if (state.instance.flow._tag !== flow._tag) return Effect.succeedNone
    return Effect.andThen(
      authorize(flow, state, executionId),
      Effect.suspend(() => settledResult(memory, flow, executionId, state))
    )
  })

const deferredId = (flowName: string, executionId: string, deferredName: string) =>
  JSON.stringify([flowName, executionId, deferredName])

// Untraced because deferred polling is a flow scheduler hot path.
const deferredResult = Effect.fnUntraced(function*(memory: Memory, deferred: DurableDeferred.Any) {
  const instance = yield* FlowRuntime.FlowInstance
  return Option.fromNullishOr(
    memory.deferredResults.get(deferredId(instance.flow._tag, instance.executionId, deferred.name))
  )
})

const deferredConflict = (execution: ExecutionState, options: DeferredDone) => {
  const owner = execution.instance.flow._tag
  return new ExecutionIdentityConflict({
    executionId: options.executionId,
    status: executionStatus(execution),
    field: "flow",
    expected: owner,
    actual: options.flowName,
    message: `execution ${options.executionId} belongs to flow ${owner}; ` +
      `a deferred for ${options.flowName} cannot complete it`
  })
}

const deferredDone = (memory: Memory, options: DeferredDone) =>
  Effect.suspend(() => {
    const execution = memory.executions.get(options.executionId)
    if (execution !== undefined && execution.instance.flow._tag !== options.flowName) {
      return Effect.die(deferredConflict(execution, options))
    }
    const id = deferredId(options.flowName, options.executionId, options.deferredName)
    if (memory.deferredResults.has(id)) return Effect.void
    memory.deferredResults.set(id, options.exit)
    return resume(memory, options.executionId)
  })

/**
 * Whether `execution` is parked on the wait `options` names. The annotation
 * counts only while the round that made it is parked: a running body has no
 * wait to complete yet, and an annotation left behind by a completed or
 * cancelled round names a wait that no longer exists. The durable store
 * answers the same way because its waiting row is written when a round parks.
 */
const parkedOn = (execution: ExecutionState | undefined, options: DeferredDoneIfWaiting): boolean => {
  if (execution === undefined || execution.instance.flow._tag !== options.flowName) return false
  if (!settledSuspended(execution)) return false
  const waiting = execution.instance.waiting
  return waiting?.reason === options.reason && waiting.token === options.token
}

const deferredDoneIfWaiting = (
  memory: Memory,
  options: DeferredDoneIfWaiting
): Effect.Effect<FlowRuntime.DeferredDoneIfWaitingOutcome> =>
  Effect.suspend(() => {
    if (!parkedOn(memory.executions.get(options.executionId), options)) return Effect.succeed("NotWaiting" as const)
    const id = deferredId(options.flowName, options.executionId, options.deferredName)
    const outcome = memory.deferredResults.has(id) ? "Existing" as const : "Completed" as const
    if (outcome === "Completed") memory.deferredResults.set(id, options.exit)
    return resume(memory, options.executionId).pipe(Effect.as(outcome))
  })

/** Completes a clock's deferred once its duration elapses, with one timer per clock. */
const scheduleClock = (memory: Memory, flow: Flow.Any, options: Parameters<Encoded["scheduleClock"]>[1]) =>
  memory.engine().deferredDone(options.clock.deferred, {
    flowName: flow._tag,
    executionId: options.executionId,
    deferredName: options.clock.deferred.name,
    exit: Exit.void
  }).pipe(
    Effect.delay(options.clock.duration),
    FiberMap.run(memory.clocks, JSON.stringify([flow._tag, options.executionId, options.clock.name]), {
      onlyIfMissing: true
    }),
    Effect.asVoid
  )

/** The driver `makeUnsafe` adapts: every member answers from `memory`. */
const adapter = (memory: Memory): Encoded => ({
  serialization: memory.serialization,
  register: (flow, execute) => register(memory, flow, execute),
  execute: (flow, options) => execute(memory, flow, options),
  interrupt: (flow, executionId) => interrupt(memory, flow, executionId),
  interruptUnsafe: (flow, executionId) => interruptUnsafe(memory, flow, executionId),
  resume: (flow, executionId, options) =>
    options?.poll === true ? pollResume(memory, flow, executionId) : resumeAuthorized(memory, flow, executionId),
  resumeSignal: (_flow, executionId) => resumeSignal(memory, executionId),
  actionExecute: (options) => actionExecute(memory, options),
  poll: (flow, executionId) => poll(memory, flow, executionId),
  deferredResult: (deferred) => deferredResult(memory, deferred),
  deferredDone: (options) => deferredDone(memory, options),
  deferredDoneIfWaiting: (options) => deferredDoneIfWaiting(memory, options),
  scheduleClock: (flow, options) => scheduleClock(memory, flow, options)
})

/**
 * Layer that provides an in-memory `FlowRuntime`.
 *
 * **When to use**
 *
 * Use to run tests and local development flows where durability is not
 * needed.
 *
 * **Gotchas**
 *
 * This layer keeps state only in memory and is not suitable for production
 * flows that require durability.
 *
 * The capability ceiling current where the layer is built is the engine's
 * host ceiling: every execution it admits records it, and every join, poll,
 * and resume is compared under it.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerMemory: Layer.Layer<FlowRuntime.FlowRuntime> = Layer.effect(FlowRuntime.FlowRuntime)(
  Effect.gen(function*() {
    const scope = yield* Effect.scope
    // The ceiling this engine is built under bounds every admission, join,
    // poll, and resume it answers, whatever context later calls it.
    const host = yield* CapabilitySet.current
    // Results never leave memory, so any serializer can store them (VIP-44).
    const serialization = Option.getOrElse(
      yield* Effect.serviceOption(RpcSerialization.RpcSerialization),
      () => RpcSerialization.json
    )
    const memory = makeMemory(scope, yield* FiberMap.make<string>(), () => engine, serialization)
    const engine: Port = bindHostCeiling(host, makeUnsafe(adapter(memory)))
    return engine
  })
)

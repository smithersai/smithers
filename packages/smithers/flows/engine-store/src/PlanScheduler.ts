/**
 * Drives a persisted plan: the node scheduler.
 *
 * `@smthrs/plan` makes the plan a value; this makes it run. The scheduler
 * walks the persisted graph, dispatches ready nodes through the same
 * `internal/ActionPersistence` seam every action uses — so the shared step
 * cache, the workspace sandbox's execute→materialize transaction, attempt
 * rows, and the fenced journal all apply unchanged — and records an
 * evaluation outcome per node.
 *
 * ## What it is, and what it is not
 *
 * Skyframe's `AbstractParallelEvaluator` is the prior art for the state
 * machine (`CHECK_DEPENDENCIES → VERIFIED_CLEAN | NEEDS_REBUILDING →
 * REBUILDING → DONE`) and `EvaluationProgressReceiver` for the outcome
 * vocabulary. Two deliberate deviations:
 *
 * 1. **No cache-invalidating node visitor.** Content addressing governs
 *    reuse. Private reverse indexes propagate settled outcomes and readiness,
 *    never dirty bits. Dispatch-time content measurement still decides
 *    whether a recorded result can serve the node.
 * 2. **Completion-driven, without Skyframe restarts.** Skyframe atomically
 *    signals reverse dependencies when one node settles. Our dependencies are
 *    declared in the plan before anything runs, so one coordinator can make
 *    the equivalent decision from the plan, settled state, and scheduling
 *    permits: every completion is reconciled and immediately opens another
 *    admission pass. Giving up the wavefront barrier also gives up its
 *    trivially serialized reconciliation; draining and applying the durable
 *    deviation journal after each settlement, before reevaluating downstream
 *    readiness, restores that ordering without holding unrelated ready cones.
 *    The coordinator is the sole writer of scheduling state, which keeps every
 *    admission decision deterministic without the `DeterministicHelper` the
 *    vault rejected.
 *
 * ## The three limits
 *
 * The same number must never
 * stand in for graph width, scheduler admission, and provider capacity. This
 * module owns the middle one only: `concurrency.steps` is the leaf-execution
 * cap, and `concurrency.agents` is the subset cap an agent node consumes in
 * addition. Structural width is whatever the plan says; seats belong to
 * `Agent Adapters` and are not modelled here.
 *
 * Under contention, ready work is ordered by effective priority — declared
 * `priority` plus one point per capacity-constrained admission pass. A ready
 * node gains a point exactly when a pass considers it but cannot give it the
 * required permits. Aging is what lets priority change latency without
 * permitting starvation; equal effective priorities preserve deterministic
 * plan order.
 *
 * ## Observing the world exactly once
 *
 * The torn-run rule: never re-observe the
 * world mid-run. Reads with no preceding writer are **source** inputs; their
 * digests and glob membership are durably recorded before dispatch and restored
 * on reopening. Preceding producers' outputs are measured after settlement —
 * observing our own output, not the world. Later and self-writes are not source
 * producers. New generations retain prior pins and record new observations.
 *
 * @since 0.1.0
 */

import { type Crypto, Sha256 } from "@smthrs/crypto"
import { FlowEngine } from "@smthrs/engine"
import type { FileBoundary } from "@smthrs/flow/FileBoundary"
import { Journal, type JournalEvent } from "@smthrs/journal"
import type { Jj } from "@smthrs/kernel"
import { Plan, Scheduling, StepKey } from "@smthrs/plan"
import { PlanStore } from "@smthrs/plan-store"
import * as FileSet from "@smthrs/plan/FileSet"
import { AttemptStore, type Ownership, type RunStore } from "@smthrs/run-store"
import type { CacheStore } from "@smthrs/step-cache"
import * as Cause from "effect/Cause"
import * as Clock from "effect/Clock"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Metric from "effect/Metric"
import * as Option from "effect/Option"
import * as Queue from "effect/Queue"
import * as Ref from "effect/Ref"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as EngineStoreMetrics from "./EngineStoreMetrics.vibe"
import * as ActionPersistence from "./internal/ActionPersistence.ts"
import * as AttemptAdmission from "./internal/AttemptAdmission.vibe"
import * as CacheAgeVerdicts from "./internal/CacheAgeVerdicts.ts"
import * as FileEnumeration from "./internal/FileEnumeration.ts"
import * as JournalRecords from "./internal/JournalRecords.ts"
import { compareText } from "./internal/Ordering.ts"
import * as PlanInputs from "./internal/PlanInputs.ts"
import * as PlanMerges from "./internal/PlanMerges.ts"
import * as RuntimeGraph from "./internal/RuntimeGraph.ts"
import * as PlanInputStore from "./PlanInputStore.ts"
import * as PlanMergeStore from "./PlanMergeStore.ts"
import * as Reconciliation from "./Reconciliation.vibe"
import * as ReplayOnly from "./ReplayOnly.vibe"
import * as Selection from "./Selection.ts"
import * as StepBoundary from "./StepBoundary.ts"
import * as WorkspaceSandbox from "./WorkspaceSandbox.vibe"

/**
 * The evaluation outcomes: Skyframe's `EvaluationState` adapted to a
 * content-addressed store, plus the selection debt.
 *
 * - `built` — the node executed (`SUCCESS_VERSION_CHANGED`).
 * - `clean` — a recorded result served it and no executor ran. This includes
 *   same-run durable attempt replay for every tier, and shared-cache hits for
 *   eligible sealed work (`SUCCESS_VERSION_UNCHANGED`). It does not assert
 *   cross-run cache eligibility.
 * - `failed` — the node executed and failed, or reconciliation failed it.
 * - `skipped` — its cone prevented dispatch, or `stop-merge` stopped a
 *   conflicted attempt in favour of a merge node. The latter has nonzero
 *   attempts; skipped does not imply that its executor never ran. Skyframe
 *   splits failure by version instead; a content-addressed store never serves
 *   a failure from cache, so that split has no meaning here and this one does.
 * - `deferred`: a selection guess postponed this sink
 *   (`docs/guides/defer-work-with-selection.md`). It never dispatched,
 *   wrote no cache row, and is journaled as a debt for a later guess-free
 *   pass. Distinct from `skipped` — the work was runnable, a guess postponed
 *   it — and never reported as passed.
 *
 * @since 0.1.0
 * @category models
 */
export type Outcome = "built" | "clean" | "failed" | "skipped" | "deferred"

/**
 * One material `Ref` input, resolved: the settled output of `from` projected
 * along `path` — for sealed work, the value whose digest the dispatch key folds.
 *
 * @since 0.1.0
 * @category models
 */
export interface ResolvedInput {
  readonly from: string
  readonly path: ReadonlyArray<string>
  readonly value: unknown
}

/**
 * What the scheduler hands a node's executor.
 *
 * @since 0.1.0
 * @category models
 */
export interface NodeInput {
  readonly node: Plan.PlanNode
  readonly attempt: number
  /** The measured boundary; folded into sealed keys, diagnostic context for other tiers. */
  readonly boundary: FileBoundary
  /**
   * The node's material `Ref` inputs, resolved through the same projection the
   * dispatch key digests for sealed work. Ordering (`Pending`) dependencies
   * and unprojected sibling fields are deliberately absent. This preserves
   * the consumed-data contract for every tier and prevents a sealed cache hit
   * from serving an execution that consumed different data.
   */
  readonly inputs: ReadonlyArray<ResolvedInput>
}

/**
 * The DI seam that turns a plan node into work.
 *
 * The scheduler owns identity, admission, caching, and journaling; it
 * deliberately owns nothing about what a node *means*. A flow runtime, a test,
 * or a remote host each supply their own executor.
 *
 * @since 0.1.0
 * @category models
 */
export interface Executor {
  readonly execute: (input: NodeInput) => Effect.Effect<unknown, unknown>
}

/**
 * Service tag for the node executor.
 *
 * @since 0.1.0
 * @category services
 */
export class NodeExecutor extends Context.Service<NodeExecutor, Executor>()("@smthrs/engine-store/NodeExecutor") {}

/**
 * Provides a plain {@link Executor} value as the {@link NodeExecutor} service.
 *
 * This is the whole wiring story for the scheduler's one open seam: a flow
 * runtime, a test double, or a remote dispatcher each become a layer by
 * passing themselves here.
 *
 * @since 0.1.0
 * @category layers
 */
export const layerExecutor = (executor: Executor): Layer.Layer<NodeExecutor> => Layer.succeed(NodeExecutor, executor)

/**
 * How one node ended.
 *
 * @since 0.1.0
 * @category models
 */
export interface Settlement {
  readonly nodeId: string
  /** The plan-time key: a pure function of declarations. */
  readonly planKey: string
  /** The execution key: content-derived for sealed work; run/plan/node/declaration-scoped for other tiers. */
  readonly dispatchKey: string
  readonly outcome: Outcome
  readonly attempts: number
  readonly rebases: number
}

/**
 * What a run of a plan produced.
 *
 * @since 0.1.0
 * @category models
 */
export interface Report {
  readonly planId: string
  readonly digest: string
  readonly settlements: ReadonlyArray<Settlement>
  readonly results: Readonly<Record<string, unknown>>
  readonly verdicts: ReadonlyArray<{ readonly nodeId: string; readonly verdict: Reconciliation.Verdict }>
  /** Merge nodes a `stop-merge` conflict appended to the plan. */
  readonly appended: ReadonlyArray<string>
}

/**
 * Scheduler construction options.
 *
 * @since 0.1.0
 * @category models
 */
export interface Options {
  readonly runId: string
  readonly owner: Ownership.OwnerId
  /** Liveness policy for recovering a stale shared cache lease. */
  readonly isAlive?: Ownership.LivenessCheck | undefined
  readonly sourceId: string
  /**
   * Engine-resolved identity, copied at scheduler construction and durably
   * bound before dispatch. A changed identity cannot resume the same run.
   * Omitting it preserves existing action keys but is itself a distinct binding.
   */
  readonly environment?: StepKey.EnvironmentIdentity | undefined
  /**
   * The admission caps. Both default to unbounded, because a cap the caller
   * did not declare is not the scheduler's to invent — `aspects.ts` owns the
   * policy and narrows it. Explicit caps must be positive safe integers;
   * zero is refused rather than silently clamped or allowed to deadlock.
   */
  readonly concurrency?: Scheduling.Concurrency | undefined
  /**
   * How many times a `delay-rebase` node may re-measure and re-key against a
   * newly recorded base before reconciliation is asked. Bounded on purpose: an
   * unbounded rebase loop is a livelock with good manners.
   */
  readonly rebaseLimit?: number | undefined
  /**
   * Probabilistic selection input for this run (`Selection`). Every field is
   * optional because every default is inert: no changed paths and no beliefs
   * admit everything, so a caller that never opted in runs exactly as today.
   * `full: true` is the run-level override — every verdict is treated as
   * `Admit` and the override is journaled, the way `--fresh` ignores the
   * cache.
   */
  readonly selection?: {
    /** Changed paths the belief edges are matched against. */
    readonly changed?: ReadonlyArray<string> | undefined
    /** The belief snapshot pinned before planning. */
    readonly beliefs?: Selection.BeliefSnapshot | undefined
    /** Deferral policy; `deferBelow` defaults to zero, which defers nothing. */
    readonly policy?: Selection.Policy | undefined
    /** Force full selection: treat every verdict as `Admit`, journaled. */
    readonly full?: boolean | undefined
  } | undefined
}

/**
 * Everything driving a plan needs from the composition.
 *
 * @since 0.1.0
 * @category models
 */
export type Requirements =
  | PlanMergeStore.PlanMergeStore
  | AttemptStore.AttemptStore
  | CacheStore.CacheStore
  | Crypto.Crypto
  | Jj.Jj
  | Journal.Journal
  | NodeExecutor
  | PlanStore.PlanStore
  | PlanInputStore.PlanInputStore
  | RunStore.RunStore
  | StepBoundary.Service

/**
 * A refusal the scheduler itself raises. A node's own failure is an outcome,
 * not one of these — the run continues and the report says `failed`.
 *
 * @since 0.1.0
 * @category errors
 */
export class SchedulerError extends Schema.TaggedError<SchedulerError>()("@smthrs/engine-store/SchedulerError", {
  code: Schema.Literals([
    "invalid_plan",
    "plan_changed",
    "boundary_unavailable",
    "key_uncomputable",
    "elaboration_failed",
    "store_failed"
  ]),
  message: Schema.String,
  cause: Schema.optional(Schema.Unknown),
  /** Failures while settling siblings after the primary scheduler failure. */
  cleanupErrors: Schema.optional(Schema.Array(Schema.Unknown))
}) {}

/**
 * Plan-driving operations.
 *
 * @since 0.1.0
 * @category models
 */
export interface Service {
  /** Persists generation 0 and journals `plan-recorded`. */
  readonly record: (
    plan: Plan.Plan
  ) => Effect.Effect<PlanStore.RecordResult, SchedulerError, PlanStore.PlanStore | Journal.Journal | Crypto.Crypto>
  /** Persists the newest generation and journals `subgraph-appended`. */
  readonly append: (
    plan: Plan.Plan
  ) => Effect.Effect<void, SchedulerError, PlanStore.PlanStore | Journal.Journal | Crypto.Crypto>
  /** Drives the plan to completion and reports every node's outcome. */
  readonly run: (plan: Plan.Plan) => Effect.Effect<Report, SchedulerError, Requirements>
}

/**
 * Service tag for the plan scheduler.
 *
 * @since 0.1.0
 * @category services
 */
export class PlanScheduler extends Context.Service<PlanScheduler, Service>()("@smthrs/engine-store/PlanScheduler") {}

/**
 * The tag a plan node dispatches, when its material names one.
 *
 * A material body is opaque to the compiler by design, so this reads it
 * defensively and answers nothing rather than guessing: a merge node, a body
 * an elaborator shaped differently, and a node whose tag is not a string all
 * carry no tag at all. @private
 */
const actionOf = (node: Plan.PlanNode): string | undefined => {
  const body = node.material.body
  if (typeof body !== "object" || body === null) return undefined
  const fields = body as Record<string, unknown>
  const named = typeof fields["action"] === "string" ? fields["action"] : fields["flow"]
  return typeof named === "string" && named !== "" ? named : undefined
}

/**
 * One node of a plan, as a journal record carries it.
 *
 * The same shape the interpreter writes, so a reader folds both executors
 * with one decoder. `effects` and `key` are the plan's own; there is no
 * declaration site here, because a plan node is compiled from a draft and the
 * draft's author frame is not something the compiler keeps. @private
 */
const nodeSummary = (node: Plan.PlanNode) => {
  const action = actionOf(node)
  return {
    id: node.id,
    kind: node.kind,
    dependsOn: node.dependsOn,
    tier: node.material.kind,
    key: node.key,
    generation: node.generation,
    ...(action === undefined ? {} : { action })
  }
}

/**
 * The declared digest handed to `StepBoundary.prepare` when the scheduler is
 * *asking* what a path holds rather than asserting it. Prepare measures every
 * declared read regardless of what the declaration claims, so any placeholder
 * works; a self-describing one can never be mistaken for a real digest.
 *
 * @private
 */
const unmeasured = "unmeasured"

/** @private */
const isConflict = (cause: Cause.Cause<unknown>): boolean =>
  cause.reasons.some((reason) => Cause.isFailReason(reason) && WorkspaceSandbox.isMaterializationConflict(reason.error))

/** @private */
const DeviationPayload = Schema.Struct({
  stepKeyDigest: Schema.NonEmptyString,
  attempt: Schema.Int,
  paths: Schema.Array(Schema.String),
  diffIdentity: Schema.String
})

const decodeDeviation = Schema.decodeUnknownOption(DeviationPayload)

const digestOf = Schema.decodeUnknownEffect(Sha256)

/** @private */
interface DispatchStart {
  readonly dispatchKey: string
  readonly attempts: number
  readonly rebases: number
  readonly waited: number
  readonly results: ReadonlyMap<string, unknown>
  readonly inputs: ReadonlyArray<ResolvedInput>
}

/** @private */
interface ObservedRead {
  readonly entry: FileSet.ReadEntry
  /** Source members observed when this declaration entered the run. */
  readonly sourcePaths: ReadonlyArray<string>
}

/** @private */
interface DispatchProgress {
  readonly dispatchKey: string
  readonly attempts: number
  readonly rebases: number
}

/** @private */
interface CompletedDispatch extends DispatchProgress {
  readonly outcome: "built" | "clean"
  readonly result: unknown
}

/** @private */
interface FailedDispatch extends DispatchProgress {
  readonly outcome: "failed"
}

/** @private */
interface ConflictedDispatch extends DispatchProgress {
  readonly outcome: "conflicted"
  readonly strategy: Plan.RuntimeStrategy
}

/** @private */
type Dispatched = CompletedDispatch | FailedDispatch | ConflictedDispatch

/**
 * A conflicted attempt with rebase budget left: the dispatch's next attempt
 * re-measures and re-keys against the newly recorded base. @private
 */
interface Rebase extends DispatchProgress {
  readonly outcome: "rebase"
}

/** @private */
interface DispatchSettlementEvent {
  readonly _tag: "DispatchSettled"
  readonly node: Plan.PlanNode
  readonly exit: Exit.Exit<Dispatched, SchedulerError>
}

/** @private */
type CoordinatorEvent =
  | { readonly _tag: "AttemptKeyed"; readonly nodeId: string; readonly digest: string }
  | DispatchSettlementEvent

/** A deviation attributed to its node, waiting for that node's settlement. @private */
interface PendingDeviation {
  readonly nodeId: string
  readonly signature: string
  readonly payload: typeof DeviationPayload.Type
}

const storeFailure = (message: string) => (cause: unknown) =>
  new SchedulerError({ code: "store_failed", message, cause })

const nonNegativeSafeInteger = (name: string, value: number): number => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`)
  }
  return value
}

const mergeFailure = (cause: PlanMergeStore.PlanMergeError) =>
  cause.code === "fence_lost"
    ? Effect.interrupt
    : Effect.fail(storeFailure("could not recover or persist the plan's merge decisions")(cause))

const inputFailure = (cause: PlanInputStore.PlanInputError) =>
  cause.code === "fence_lost"
    ? Effect.interrupt
    : Effect.fail(storeFailure("could not recover or persist the plan's source observations")(cause))

/** The refusal when a host without a FileSystem is asked to expand a declaration. */
const cannotExpand = (what: string) =>
  new SchedulerError({
    code: "boundary_unavailable",
    message: `the host cannot expand ${what} without a FileSystem`
  })

/** The refusal when the host's FileSystem fails to expand a declaration. */
const couldNotExpand = (what: string) => (cause: unknown) =>
  new SchedulerError({
    code: "boundary_unavailable",
    message: `the host could not expand ${what}`,
    cause
  })

/** Everything one scheduler holds across the runs it drives. */
interface Scheduler {
  readonly options: Options
  readonly admission: AttemptAdmission.Service
  readonly cacheAgeVerdict: ReturnType<typeof CacheAgeVerdicts.make>
  readonly rebaseLimit: number
  readonly scheduling: Scheduling.Policy
  /**
   * Capture before the first async boundary. Callers can retain and mutate
   * their options, but cannot change this scheduler's identity after admission.
   */
  readonly capturedEnvironment: Result.Result<StepKey.EnvironmentIdentity | undefined, unknown>
  /**
   * Every scheduler record addresses the run's root lineage, so a frame can
   * reach it (`packages/smithers/flows/time-travel/docs/concepts/frames-and-lineage.md`).
   */
  readonly lineageId: ReturnType<typeof FlowEngine.Lineage.root>
}

/**
 * What a run resolves before it schedules anything: its environment, its
 * verified plan, the services it drives, and its recovered merge decisions.
 */
interface RunContext extends Scheduler {
  readonly environment: StepKey.EnvironmentIdentity | undefined
  readonly environmentDigest: StepKey.StepKey
  /** The verified plan the caller handed in, before recovered merges extend it. */
  readonly initial: Plan.Plan
  readonly boundaries: StepBoundary.Service
  readonly fileSystem: Option.Option<FileSystem.FileSystem>
  readonly executor: Executor
  readonly journal: Journal.Service
  readonly inputStore: PlanInputStore.Service
  readonly mergeStore: PlanMergeStore.Service
  readonly mergeIdentity: PlanMergeStore.Identity
  readonly recoveredMerges: ReadonlyArray<PlanMergeStore.Decision>
  readonly reconciler: Reconciliation.Service
  readonly selector: Selection.Service
  /**
   * A verifier composes the scheduler replay-only, as it does the engine:
   * a recorded node replays and a node that would run its body stops.
   */
  readonly replayOnly: ReplayOnly.Service | undefined
  /** Dispatch fibers report attempt keys and settlements here; the coordinator consumes them. */
  readonly events: Queue.Queue<CoordinatorEvent>
}

/**
 * One run of a plan: its context and the scheduling state its coordinator
 * owns. Dispatch fibers keep their attempt bookkeeping to themselves and
 * report through `events`.
 *
 * Steps written as `function*` run inside their caller's effect, delegated
 * with `yield*`, and add no fiber operations of their own. The interleaving
 * of the coordinator and its dispatch fibers follows operation counts (a
 * fiber yields every `MaxOpsBeforeYield` operations), and
 * `test/SchedulerDifferential.test.ts` pins it against a frozen reference
 * scheduler.
 */
interface Run extends RunContext {
  /**
   * Only a coordinator failure makes interrupted siblings terminal here.
   * Parking, external cancellation and fence loss retain their established
   * recovery semantics. The flag is set before the child scope closes.
   */
  abortedForFailure: boolean
  /** Failures while settling siblings after the primary scheduler failure. */
  readonly cleanupErrors: Array<unknown>
  /** The plan as it stands: the recovered plan plus every merge appended since. */
  plan: Plan.Plan
  readonly graph: RuntimeGraph.RuntimeGraph
  readonly states: ReadonlyMap<string, RuntimeGraph.NodeState>
  readonly results: Map<string, unknown>
  readonly digestMemo: StepKey.DigestMemo
  readonly verdicts: Array<{ nodeId: string; verdict: Reconciliation.Verdict }>
  readonly appended: Array<string>
  /** The nodes that dispatched an attempt under each key digest, in dispatch order. */
  readonly digestToNode: Map<string, Array<string>>
  /** Each deviating node's path signature, which symmetric attribution compares. */
  readonly deviationSignatures: Map<string, string>
  /** The first node that declares each exact path; see `indexWriters`. */
  readonly writers: Map<string, string>
  /** Every declared write and removal with its node, for glob and tree overlap. */
  readonly writerEntries: Array<{ readonly entry: FileSet.Entry; readonly nodeId: string }>
  readonly nodesById: Map<string, Plan.PlanNode>
  /** The last journal entry the deviation drain has read. */
  cursor: number | undefined
  /** The digest each source path was pinned at by its one observation in this run. */
  readonly pinned: Map<string, string>
  /** Each node's read declarations and the source members each held when observed. */
  readonly observedReads: Map<string, ReadonlyArray<ObservedRead>>
  /** Terminal reports taken from `events` but not yet processed, in arrival order. */
  readonly pendingSettlements: Array<DispatchSettlementEvent>
  readonly pendingDeviations: Array<PendingDeviation>
  /** Sinks a selection verdict postponed, with the edge and likelihood their debt records. */
  readonly deferrals: Map<string, { edge: Selection.SuspectedEdge; likelihood: number }>
  /** Admission passes that launched work. */
  admissions: number
  /** Dispatches in flight; an agent dispatch also counts in `inFlightAgents`. */
  inFlightSteps: number
  inFlightAgents: number
  /** Stop-merge decisions whose merge node waits for their running peers to settle. */
  readonly pendingMerges: Array<PlanMergeStore.Intent>
}

const source = (scheduler: Scheduler, suffix: string) => ({
  runId: scheduler.options.runId,
  sourceId: `${scheduler.options.sourceId}/${suffix}`,
  lineageId: scheduler.lineageId
})

/**
 * Scheduler records take the journal's durable, owner-fenced channel: a plan
 * digest binds an approval, so it may never ride the lossy queue. A zombie
 * that lost the run self-interrupts on `fence_lost`, exactly as
 * `internal/ActionPersistence` does — a scheduler that kept dispatching
 * after losing ownership is the failure mode fencing exists to prevent.
 */
const emit = (scheduler: Scheduler, record: JournalEvent.Input) =>
  Effect.flatMap(Journal.Journal, (journal) => journal.emitDurable(record, scheduler.options.owner)).pipe(
    Effect.catch((error) =>
      error.code === "fence_lost"
        ? Effect.interrupt
        : Effect.fail(storeFailure("the scheduler could not journal a record")(error))
    )
  )

const atomically = <A, E, R>(message: string, effect: Effect.Effect<A, E, R>) =>
  Effect.flatMap(Journal.Journal, (journal) => journal.transact(effect)).pipe(
    Effect.mapError((error) => error instanceof SchedulerError ? error : storeFailure(message)(error))
  )

const verifyPlan = (candidate: Plan.Plan) =>
  Plan.verify(candidate).pipe(
    Effect.mapError((cause) =>
      new SchedulerError({ code: "invalid_plan", message: "the scheduler requires a verified plan", cause })
    )
  )

const annotatePlan = (scheduler: Scheduler, plan: Plan.Plan) =>
  Effect.annotateCurrentSpan({
    runId: scheduler.options.runId,
    planId: plan.planId,
    digest: plan.digest,
    generation: plan.generation
  })

const recordPlan = Effect.fn("PlanScheduler.record")((scheduler: Scheduler, candidate: Plan.Plan) =>
  Effect.gen(function*() {
    const plan = yield* verifyPlan(candidate)
    yield* annotatePlan(scheduler, plan)
    const store = yield* PlanStore.PlanStore
    const now = yield* Clock.currentTimeMillis.pipe(Effect.map(Math.floor))
    const outcome = yield* atomically("could not atomically record the plan", storePlan(scheduler, store, plan, now))
    yield* Effect.annotateCurrentSpan({ outcome: outcome._tag })
    return outcome
  })
)

/** Stores a plan's first generation and journals `plan-recorded`, inside the caller's transaction. */
const storePlan = (scheduler: Scheduler, store: PlanStore.Service, plan: Plan.Plan, now: number) =>
  Effect.gen(function*() {
    const recorded = yield* store.record(plan, now).pipe(
      Effect.mapError(storeFailure("could not record the plan"))
    )
    if (recorded._tag === "Conflict") {
      return yield* Effect.fail(
        new SchedulerError({
          code: "plan_changed",
          message: "The plan ID already records a different plan; start a new plan"
        })
      )
    }
    yield* emit(
      scheduler,
      JournalRecords.planRecorded(source(scheduler, `plan/${plan.planId}`), {
        planId: plan.planId,
        flow: plan.flow,
        digest: plan.digest,
        baseDigest: plan.baseDigest,
        generation: plan.generation,
        nodes: plan.nodes.length,
        outcome: recorded._tag,
        // The graph itself, beside the count it has always carried. A
        // reader that only knows how MANY nodes ran cannot show which
        // ones, and the count stays because the CLI's run progress reads
        // it as a number.
        graph: { nodes: plan.nodes.map(nodeSummary) }
      })
    )
    return recorded
  })

const appendPlan = Effect.fn("PlanScheduler.append")((scheduler: Scheduler, candidate: Plan.Plan) =>
  Effect.gen(function*() {
    const plan = yield* verifyPlan(candidate)
    yield* annotatePlan(scheduler, plan)
    const store = yield* PlanStore.PlanStore
    yield* atomically("could not atomically append the subgraph", storeGeneration(scheduler, store, plan))
    yield* Effect.annotateCurrentSpan({ outcome: "appended" })
  })
)

/** Stores a plan's newest generation and journals `subgraph-appended`, inside the caller's transaction. */
const storeGeneration = (scheduler: Scheduler, store: PlanStore.Service, plan: Plan.Plan) =>
  Effect.gen(function*() {
    yield* store.append(plan).pipe(Effect.mapError(storeFailure("could not append the subgraph")))
    yield* emit(
      scheduler,
      JournalRecords.subgraphAppended(source(scheduler, `plan/${plan.planId}/${plan.generation}`), {
        planId: plan.planId,
        digest: plan.digest,
        baseDigest: plan.baseDigest,
        generation: plan.generation,
        nodeIds: Plan.generationNodes(plan).map((node) => node.id),
        graph: { nodes: Plan.generationNodes(plan).map(nodeSummary) }
      })
    )
  })

/** The scheduler's captured environment and its digest; an invalid captured identity refuses the run. */
const bindEnvironment = function*(scheduler: Scheduler) {
  if (Result.isFailure(scheduler.capturedEnvironment)) {
    return yield* Effect.fail(
      new SchedulerError({
        code: "key_uncomputable",
        message: "the scheduler requires a valid execution environment identity"
      })
    )
  }
  const environment = scheduler.capturedEnvironment.success
  const environmentDigest = yield* StepKey.environmentIdentity(environment).pipe(
    Effect.mapError((cause) =>
      new SchedulerError({ code: "key_uncomputable", message: "could not bind the execution environment", cause })
    )
  )
  return { environment, environmentDigest }
}

/**
 * Opens one run: binds the environment, verifies the plan, resolves the
 * services the run drives, and recovers the merge decisions an earlier
 * incarnation recorded.
 */
const openRun = function*(scheduler: Scheduler, candidate: Plan.Plan) {
  const { environment, environmentDigest } = yield* bindEnvironment(scheduler)
  const initial = yield* verifyPlan(candidate)
  yield* Effect.annotateCurrentSpan({
    runId: scheduler.options.runId,
    planId: initial.planId,
    digest: initial.digest,
    nodes: initial.nodes.length
  })
  const boundaries = yield* StepBoundary.StepBoundary
  const fileSystem = yield* Effect.serviceOption(FileSystem.FileSystem)
  const executor = yield* NodeExecutor
  const journal = yield* Journal.Journal
  const inputStore = yield* PlanInputStore.PlanInputStore
  const mergeStore = yield* PlanMergeStore.PlanMergeStore
  const mergeIdentity = {
    runId: scheduler.options.runId,
    planId: initial.planId,
    baseDigest: initial.baseDigest,
    environmentDigest
  }
  const recoveredMerges = yield* mergeStore.list(mergeIdentity, scheduler.options.owner).pipe(
    Effect.catch(mergeFailure)
  )
  const reconciler = Option.getOrElse(
    yield* Effect.serviceOption(Reconciliation.Reconciliation),
    Reconciliation.makeDefault
  )
  const selector = Option.getOrElse(
    yield* Effect.serviceOption(Selection.Selection),
    Selection.makeNoop
  )
  const replayOnly = Option.getOrUndefined(yield* Effect.serviceOption(ReplayOnly.ReplayOnly))
  yield* Effect.logDebug("scheduler run started", {
    digest: initial.digest,
    nodes: initial.nodes.length
  })
  const plan = yield* PlanMerges.recover(initial, recoveredMerges).pipe(Effect.catch(mergeFailure))
  const events = yield* Queue.unbounded<CoordinatorEvent>()
  return makeRun({
    ...scheduler,
    environment,
    environmentDigest,
    initial,
    boundaries,
    fileSystem,
    executor,
    journal,
    inputStore,
    mergeStore,
    mergeIdentity,
    recoveredMerges,
    reconciler,
    selector,
    replayOnly,
    events
  }, plan)
}

const makeRun = (context: RunContext, plan: Plan.Plan): Run => {
  const graph = RuntimeGraph.make(plan.nodes)
  return {
    ...context,
    abortedForFailure: false,
    cleanupErrors: [],
    plan,
    graph,
    states: graph.states,
    results: new Map(),
    digestMemo: StepKey.makeDigestMemo(),
    verdicts: [],
    appended: [],
    digestToNode: new Map(),
    deviationSignatures: new Map(),
    writers: new Map(),
    writerEntries: [],
    nodesById: new Map(),
    cursor: undefined,
    pinned: new Map(),
    observedReads: new Map(),
    pendingSettlements: [],
    pendingDeviations: [],
    deferrals: new Map(),
    admissions: 0,
    inFlightSteps: 0,
    inFlightAgents: 0,
    pendingMerges: context.recoveredMerges
      .filter((decision) => decision.completion === undefined).map((decision) => decision.intent)
  }
}

const stateOf = (run: Run, node: Plan.PlanNode): RuntimeGraph.NodeState => run.states.get(node.id)!

/** Copies a dispatch's key and counters onto its node's scheduling state. */
const recordProgress = (state: RuntimeGraph.NodeState, progress: DispatchProgress): void => {
  state.dispatchKey = progress.dispatchKey
  state.attempts = progress.attempts
  state.rebases = progress.rebases
}

/**
 * Reconciliation's first declared owner of each path. Read version
 * selection is different: only a reader's predecessors produce its
 * inputs, never the reader itself or an explicitly later writer.
 */
const indexWriters = (run: Run, nodes: ReadonlyArray<Plan.PlanNode>): void => {
  for (const node of nodes) {
    run.nodesById.set(node.id, node)
    for (const entry of [...FileSet.expand(node.effects.writes), ...node.effects.removes ?? []]) {
      run.writerEntries.push({ entry, nodeId: node.id })
      if (typeof entry === "string" && !run.writers.has(entry)) {
        run.writers.set(entry, node.id)
      }
    }
  }
}

const writerFor = (run: Run, path: string): string | undefined =>
  run.writers.get(path) ?? run.writerEntries.find(({ entry }) => FileSet.overlaps(entry, path))?.nodeId

// One bounded traversal per observation/dispatch, not an eager matrix
// of every node's transitive ancestors. Shared ancestors are visited
// once, and the temporary set is released after this reader's work.
const writerScopesBefore = (run: Run, node: Plan.PlanNode): ReadonlyArray<FileSet.Entry> => {
  const scopes: Array<FileSet.Entry> = []
  run.graph.visitAncestors(node, (predecessor) => {
    scopes.push(...FileSet.expand(predecessor.effects.writes), ...predecessor.effects.removes ?? [])
  })
  return scopes
}

const expandReads = (run: Run, entries: ReadonlyArray<FileSet.ReadEntry>, what: string) =>
  Effect.gen(function*() {
    const expanded: Array<{ readonly entry: FileSet.ReadEntry; readonly paths: ReadonlyArray<string> }> = []
    for (const entry of entries) {
      if (typeof entry === "string") {
        expanded.push({ entry, paths: [entry] })
        continue
      }
      if (Option.isNone(run.fileSystem)) return yield* Effect.fail(cannotExpand(what))
      // Through `FileEnumeration`, never the host `glob`: host results
      // are absolute under the kernel FileSystem and skip dotfiles, so
      // a workspace-relative pattern silently expanded to nothing.
      const matches = yield* FileEnumeration.expandGlob(run.fileSystem.value, entry).pipe(
        Effect.mapError(couldNotExpand(what))
      )
      expanded.push({ entry, paths: matches })
    }
    return expanded
  })

const prepare = (run: Run, paths: ReadonlyArray<string>, what: string) =>
  run.boundaries.prepare({
    readSet: [...new Set(paths)].sort().map((path) => ({ path, digest: unmeasured })),
    writeSet: [],
    boundaryMode: "hard"
  }).pipe(
    Effect.mapError((cause) =>
      new SchedulerError({
        code: "boundary_unavailable",
        message: `the host could not measure ${what}`,
        cause
      })
    )
  )

const expandProducedMatches = (
  run: Run,
  glob: FileSet.Glob,
  writerScopes: ReadonlyArray<FileSet.Entry>,
  what: string
) =>
  Effect.gen(function*() {
    const scopes = writerScopes.filter((entry) => FileSet.overlaps(glob, entry))
    if (scopes.length === 0) return []
    if (Option.isNone(run.fileSystem)) return yield* Effect.fail(cannotExpand(what))
    const fileSystem = run.fileSystem.value
    const paths = new Set<string>()
    for (const entry of scopes) {
      if (typeof entry === "string") {
        const info = yield* statOutput(fileSystem, entry, what)
        // Exact writer declarations name files; directory outputs use
        // `TreeArtifact`, and only files are members of a read glob. A
        // producer that has not written yet is simply not a candidate.
        if (info?.type === "File") paths.add(entry)
        continue
      }
      for (const path of yield* filesWithin(fileSystem, entry, what)) {
        if (FileSet.matchesGlob(glob, path)) paths.add(path)
      }
    }
    return [...paths].sort()
  })

/**
 * What a preceding producer's exact output is now, or `undefined` when it
 * has not written it yet.
 *
 * One host call: `stat` reports both whether the producer's
 * output is there yet and what kind of thing it is, so the
 * `exists` probe that used to precede it only doubled the cost.
 * On the confined host each call is one CPython fork
 * (`@smthrs/platform-node/AtomicFileSystem`).
 */
const statOutput = (fileSystem: FileSystem.FileSystem, path: string, what: string) =>
  fileSystem.stat(path).pipe(
    Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(undefined)),
    Effect.mapError(couldNotExpand(what))
  )

/** The files a glob or tree writer scope holds now. */
const filesWithin = (fileSystem: FileSystem.FileSystem, scope: Exclude<FileSet.Entry, string>, what: string) =>
  FileSet.isGlob(scope)
    ? FileEnumeration.expandGlob(fileSystem, scope).pipe(Effect.mapError(couldNotExpand(what)))
    : FileEnumeration.filesUnder(fileSystem, scope.path).pipe(Effect.mapError(couldNotExpand(what)))

/** Commits a measured snapshot inside the caller's transaction instead of recording it alone. */
type CommitSnapshot = (
  snapshot: PlanInputStore.Snapshot
) => Effect.Effect<
  PlanInputStore.Snapshot,
  SchedulerError,
  PlanStore.PlanStore | Journal.Journal | Crypto.Crypto
>

/**
 * A read declaration is observed only when its node enters this run:
 * generation zero when the run opens, or one newly appended generation
 * when a merge extends the plan. Paths already pinned by an earlier
 * declaration reuse that digest; measuring them again would tear the run.
 * A new source path is measured now, which is its first observation in
 * this run.
 */
const observeReads = (
  run: Run,
  nodes: ReadonlyArray<Plan.PlanNode>,
  generation: number,
  what: string,
  commit?: CommitSnapshot
) =>
  Effect.gen(function*() {
    const address = {
      runId: run.options.runId,
      planId: run.initial.planId,
      baseDigest: run.initial.baseDigest,
      environmentDigest: run.environmentDigest,
      generation
    }
    const stored = yield* run.inputStore.get(address, run.options.owner).pipe(Effect.catch(inputFailure))
    let snapshot = Option.isSome(stored) ? stored.value : yield* measureReads(run, nodes, address, what, commit)
    if (commit !== undefined) snapshot = yield* commit(snapshot)
    // Do not publish speculative measurements. A competing observation
    // wins durably, and every recovered declaration must still describe
    // this verified plan before it can influence an execution key.
    const nextPins = yield* PlanInputs.validate(snapshot, nodes, run.pinned, (node) => writerScopesBefore(run, node))
      .pipe(Effect.catch(inputFailure))
    for (const node of snapshot.nodes) run.observedReads.set(node.id, node.reads)
    for (const [path, digest] of nextPins) run.pinned.set(path, digest)
  })

/**
 * Observes a generation no earlier incarnation recorded: expands each
 * node's reads, measures the source paths this run has not pinned yet, and
 * records the snapshot unless the caller commits it.
 */
const measureReads = function*(
  run: Run,
  nodes: ReadonlyArray<Plan.PlanNode>,
  address: PlanInputStore.Address,
  what: string,
  commit: CommitSnapshot | undefined
) {
  const unpinned = new Set<string>()
  const observedNodes: Array<PlanInputStore.Snapshot["nodes"][number]> = []
  for (const node of nodes) observedNodes.push(yield* observeNode(run, node, what, unpinned))
  const pins = unpinned.size === 0 ? [] : (yield* prepare(run, [...unpinned], what)).readSnapshot
  const measured: PlanInputStore.Snapshot = {
    version: 1,
    generation: address.generation,
    nodes: observedNodes,
    pins
  }
  yield* PlanInputs.validate(measured, nodes, run.pinned, (node) => writerScopesBefore(run, node)).pipe(
    Effect.catch(inputFailure)
  )
  if (commit !== undefined) return measured
  return yield* run.inputStore.record(address, measured, run.options.owner).pipe(Effect.catch(inputFailure))
}

/** One node's read declarations and the source members each holds; adds unpinned sources to `unpinned`. */
const observeNode = function*(run: Run, node: Plan.PlanNode, what: string, unpinned: Set<string>) {
  const observed: Array<ObservedRead> = []
  const reads = FileSet.expandReads(node.effects.reads)
  const writerScopes = reads.length === 0 ? [] : writerScopesBefore(run, node)
  for (const { entry, paths } of yield* expandReads(run, reads, what)) {
    const sourcePaths = paths.filter((path) => !writerScopes.some((scope) => FileSet.overlaps(scope, path)))
    for (const path of sourcePaths) {
      if (!run.pinned.has(path)) unpinned.add(path)
    }
    observed.push({ entry, sourcePaths })
  }
  return { id: node.id, key: node.key, reads: observed }
}

// Recover each generation before any dispatch. Existing observations
// never enumerate or measure the host again, even after process restart.
const recoverObservations = function*(run: Run) {
  for (let generation = 0; generation <= run.plan.generation; generation++) {
    yield* observeReads(
      run,
      run.plan.nodes.filter((node) => node.generation === generation),
      generation,
      "the plan's source inputs"
    )
  }
}

// A merge intent is authoritative scheduler state, not a failed-action
// cache entry or a convention inferred from an arbitrary node's body.
const recoverMergeIntents = (run: Run): void => {
  for (const { intent } of run.recoveredMerges) {
    const state = stateOf(run, run.nodesById.get(intent.nodeId)!)
    run.graph.stage(intent.nodeId, "skipped")
    recordProgress(state, intent)
  }
  run.graph.reconcile()
}

const measure = (run: Run, node: Plan.PlanNode) =>
  Effect.gen(function*() {
    const measured = new Map<string, string>()
    const produced = new Set<string>()
    const observed = run.observedReads.get(node.id)!
    const writerScopes = observed.length === 0 ? [] : writerScopesBefore(run, node)
    for (const read of observed) {
      if (typeof read.entry === "string") {
        if (read.sourcePaths.length === 0) produced.add(read.entry)
        else measured.set(read.entry, run.pinned.get(read.entry)!)
        continue
      }
      for (const path of read.sourcePaths) measured.set(path, run.pinned.get(path)!)
      // A glob's source membership is frozen above. Dispatch may only
      // add paths derived from preceding writer scopes. Neither an
      // unproduced arrival nor a future writer widens the source world.
      for (const path of yield* expandProducedMatches(run, read.entry, writerScopes, `the inputs of ${node.id}`)) {
        produced.add(path)
      }
    }
    if (produced.size > 0) {
      // Produced paths are our own outputs, so measuring them once their
      // producer has settled is not re-observing the world.
      const prepared = yield* prepare(run, [...produced], `the inputs of ${node.id}`)
      for (const entry of prepared.readSnapshot) measured.set(entry.path, entry.digest)
    }
    return {
      readSet: [...measured].sort(([left], [right]) => compareText(left, right)).map(([path, digest]) => ({
        path,
        digest
      })),
      writeSet: FileSet.expand(node.effects.writes),
      // Declared removals travel with the boundary: they are what makes
      // an absent declared output legitimate rather than a defect.
      ...(node.effects.removes === undefined ? {} : { removes: node.effects.removes }),
      boundaryMode: node.effects.boundaryMode
    } satisfies FileBoundary
  })

/**
 * Non-sealed work uses a stable run-local structural scope: it replays
 * durable attempts but never reuses an effect from another invocation.
 * For sealed work:
 *
 * The key a dispatch is recorded under: the node's own declaration
 * folded with the CONTENT of everything it consumes — the digests the
 * host just measured for its files, and the digest of each upstream
 * node's settled output value.
 *
 * Not the plan key. That key folds every upstream key transitively, so
 * an edit anywhere upstream re-ran everything below it even when the
 * edited node's output value was byte-identical. Bazel's
 * `ActionCacheChecker` stops invalidation at unchanged content, and
 * `StepKey.dispatchIdentity` is how this does.
 *
 * The plan key alone could never have been it either: two runs whose
 * input files differ declare the same graph, and serving one the other's
 * result is exactly the staleness the boundary exists to prevent.
 */
const dispatchKeyFor = (
  run: Run,
  node: Plan.PlanNode,
  boundary: FileBoundary,
  settledResults: ReadonlyMap<string, unknown>
) =>
  (node.material.kind === "sealed" ?
    StepKey.dispatchIdentity({
      material: node.material,
      results: Object.fromEntries(
        node.material.inputs.flatMap((input) =>
          input._tag === "Ref" ? [[input.from, settledResults.get(input.from)] as const] : []
        )
      ),
      digestMemo: run.digestMemo,
      environment: run.environment,
      hermetic: {
        ...boundary,
        readSet: StepBoundary.exactReads(boundary)
      }
    }) :
    StepKey.ordinal({
      runId: run.options.runId,
      // Stable structural scope, never admission order. The declaration
      // fingerprint prevents a changed plan from reusing an old attempt.
      parentScope: JSON.stringify(["plan-node/v1", run.initial.planId, node.id, node.key]),
      ordinal: 0,
      tier: node.material.kind
    })).pipe(
      /* v8 ignore next 3 -- verified plans have serializable material, admission resolves every dependency, and successful upstream values already crossed durable serialization; key derivation still exposes its honest failure channel */
      Effect.mapError((cause) =>
        new SchedulerError({ code: "key_uncomputable", message: `could not key ${node.id}`, cause })
      )
    )

const runtimeStrategyOf = (node: Plan.PlanNode): Plan.RuntimeStrategy =>
  node.conflicts.some((conflict) => conflict.runtime === "stop-merge") ? "stop-merge" : node.runtime

const markSettled = (run: Run, node: Plan.PlanNode, outcome: Outcome): void => {
  run.graph.stage(node.id, outcome)
}

const emitSettlement = (run: Run, node: Plan.PlanNode, sourceSeq?: number) =>
  Effect.gen(function*() {
    const state = stateOf(run, node)
    const action = actionOf(node)
    yield* emit(
      run,
      JournalRecords.nodeSettled({ ...source(run, `node/${node.id}/settled`), sourceSeq }, {
        planId: run.plan.planId,
        nodeId: node.id,
        planKey: node.key,
        dispatchKey: state.dispatchKey,
        outcome: state.outcome,
        attempts: state.attempts,
        rebases: state.rebases,
        ...(action === undefined ? {} : { action })
      })
    )
    yield* Metric.update(EngineStoreMetrics.node[state.outcome], 1)
  })

const settle = (run: Run, node: Plan.PlanNode, outcome: Outcome) => {
  markSettled(run, node, outcome)
  run.graph.reconcile()
  return emitSettlement(run, node)
}

const applyVerdict = (run: Run, nodeId: string, verdict: Reconciliation.Verdict, trigger: string) =>
  Effect.gen(function*() {
    run.verdicts.push({ nodeId, verdict })
    yield* emit(
      run,
      JournalRecords.nodeReconciled(source(run, `node/${nodeId}/reconciled/${run.verdicts.length}`), {
        planId: run.plan.planId,
        nodeId,
        trigger,
        verdict
      })
    )
    if (verdict._tag === "Fail") {
      // The scheduler chooses the node it asks about, so a verdict always
      // names one it is tracking.
      run.graph.stage(nodeId, "failed")
      run.results.delete(nodeId)
      return
    }
    if (verdict._tag === "Reorder") {
      // Re-plan with the discovered dependency made explicit. It binds
      // work that has not dispatched yet — the deviating node already
      // ran, and rewriting history is what append-only forbids.
      // Persisting the edge is the caller's next elaboration; the
      // verdict is journaled so it can be.
      run.graph.reorder(nodeId, verdict.dependsOn)
    }
    // `FactorOut` needs no graph surgery: two identical extracted steps
    // collapse to one key by themselves, so the second is a `clean`.
  })

const dispatch: (
  run: Run,
  node: Plan.PlanNode,
  start: DispatchStart
) => Effect.Effect<Dispatched, SchedulerError, Requirements> = Effect.fn(
  "PlanScheduler.dispatch"
)(function*(run: Run, node: Plan.PlanNode, start: DispatchStart) {
  return yield* Effect.gen(function*() {
    yield* Effect.annotateCurrentSpan({
      runId: run.options.runId,
      planId: run.plan.planId,
      nodeId: node.id,
      kind: node.kind,
      planKey: node.key
    })
    // Attempt bookkeeping is local to this fiber. The coordinator owns
    // the durable scheduler state and applies this progress only when it
    // processes the terminal event.
    let progress: DispatchProgress = {
      dispatchKey: start.dispatchKey,
      attempts: start.attempts,
      rebases: start.rebases
    }
    while (true) {
      const attempted = yield* attempt(run, node, start, progress)
      if (attempted.outcome !== "rebase") return attempted
      progress = attempted
    }
  }).pipe(
    Effect.tap((result) => Effect.annotateCurrentSpan({ outcome: result.outcome }))
  )
})

/**
 * One attempt of a dispatch: measures and keys the node, journals the
 * attempt, runs it through `ActionPersistence`, and judges how it ended.
 */
const attempt = function*(run: Run, node: Plan.PlanNode, start: DispatchStart, previous: DispatchProgress) {
  const boundary = yield* measure(run, node)
  const measuredKey = yield* dispatchKeyFor(run, node, boundary, start.results)
  if (previous.dispatchKey !== "" && previous.dispatchKey !== measuredKey) {
    yield* emitInvalidated(run, node, previous, measuredKey)
  }
  const progress = { dispatchKey: measuredKey, attempts: previous.attempts + 1, rebases: previous.rebases }
  const dispatchDigest = yield* announceAttempt(run, node, start, progress)
  const ran = yield* Ref.make(false)
  const exit = yield* ActionPersistence.make({
    runId: run.options.runId,
    owner: run.options.owner,
    isAlive: run.options.isAlive,
    admission: run.admission,
    cacheAgeVerdict: run.cacheAgeVerdict,
    replayOnly: run.replayOnly,
    sourceId: `${run.options.sourceId}/node/${node.id}`,
    preserveInterruption: () => run.abortedForFailure,
    execute: () =>
      Ref.set(ran, true).pipe(
        Effect.andThen(run.executor.execute({ node, attempt: progress.attempts, boundary, inputs: start.inputs }))
      )
  })({
    action: {},
    attempt: progress.attempts,
    key: progress.dispatchKey,
    tier: node.material.kind,
    nondeterministic: node.material.nondeterministic,
    metadata: boundary
  }).pipe(
    Effect.onInterrupt(() => settleAborted(run, node, dispatchDigest, progress.attempts)),
    Effect.exit
  )
  if (Exit.isSuccess(exit)) {
    return { outcome: (yield* Ref.get(ran)) ? "built" : "clean", result: exit.value, ...progress } as const
  }
  return yield* judgeFailure(run, node, exit.cause, progress)
}

const emitInvalidated = (run: Run, node: Plan.PlanNode, previous: DispatchProgress, measuredKey: string) =>
  emit(
    run,
    JournalRecords.nodeInvalidated(source(run, `node/${node.id}/${previous.attempts}/invalidated`), {
      planId: run.plan.planId,
      nodeId: node.id,
      planKey: node.key,
      from: previous.dispatchKey,
      to: measuredKey,
      reason: "measured-inputs-changed"
    })
  )

/**
 * Journals an attempt as scheduled and reports its key digest to the
 * coordinator, which attributes deviations by it.
 */
const announceAttempt = function*(run: Run, node: Plan.PlanNode, start: DispatchStart, progress: DispatchProgress) {
  const { attempts, dispatchKey } = progress
  yield* Effect.annotateCurrentSpan({ dispatchKey, attempt: attempts })
  const action = actionOf(node)
  yield* emit(
    run,
    JournalRecords.nodeScheduled(source(run, `node/${node.id}/${attempts}`), {
      planId: run.plan.planId,
      nodeId: node.id,
      kind: node.kind,
      planKey: node.key,
      dispatchKey,
      attempt: attempts,
      priority: node.priority,
      waited: start.waited,
      ...(action === undefined ? {} : { action })
    })
  )
  const dispatchDigest = yield* Effect.orDie(digestOf(dispatchKey))
  yield* Queue.offer(run.events, { _tag: "AttemptKeyed", nodeId: node.id, digest: dispatchDigest })
  return dispatchDigest
}

/**
 * An attempt interrupted by a scheduler failure ends `scheduler_aborted`;
 * any other interruption keeps its recovery semantics. A failure to record
 * that is kept for the scheduler's own error.
 */
const settleAborted = (run: Run, node: Plan.PlanNode, dispatchDigest: string, attempts: number) => {
  if (!run.abortedForFailure) return Effect.void
  return atomically(
    "could not settle a sibling aborted by scheduler failure",
    Effect.gen(function*() {
      const store = yield* AttemptStore.AttemptStore
      const finishedAtMs = yield* Clock.currentTimeMillis.pipe(Effect.map(Math.floor))
      const identity = { runId: run.options.runId, stepKeyDigest: dispatchDigest, attempt: attempts }
      const finished = yield* store.finish({
        ...identity,
        state: "failed",
        finishedAtMs,
        error: { code: "scheduler_aborted", message: "A scheduler failure interrupted this attempt" }
      }, run.options.owner)
      // A terminal attempt or a replacement owner already decides
      // the row. Never overwrite it or emit a contradictory fact.
      if (finished._tag === "Finished") {
        yield* emit(
          run,
          JournalRecords.attemptFinished(source(run, `node/${node.id}/${attempts}/aborted`), {
            ...identity,
            state: "failed",
            reason: "scheduler_aborted"
          })
        )
      }
    })
  ).pipe(Effect.catch((cause) =>
    Effect.sync(() => {
      run.cleanupErrors.push(cause)
    })
  ))
}

/**
 * How a failed attempt ends its dispatch: an interruption is the run losing
 * ownership, a conflict follows the node's runtime strategy, and any other
 * failure fails the node.
 */
const judgeFailure = function*(run: Run, node: Plan.PlanNode, cause: Cause.Cause<unknown>, progress: DispatchProgress) {
  // Losing a fence self-interrupts `ActionPersistence`. An
  // interrupted dispatch is the run losing ownership, never a node
  // failure that the scheduler may report and continue past.
  if (Cause.hasInterrupts(cause)) return yield* Effect.interrupt
  // The generic executor supplies no irreversible idempotency or
  // reconciliation contract. A conflict is not proof the effect
  // never happened; neither a retry nor a freshly keyed merge may
  // blindly execute more work after that uncertain result.
  if (!isConflict(cause) || node.material.kind === "irreversible") {
    return { outcome: "failed", ...progress } as const
  }
  const strategy = runtimeStrategyOf(node)
  if (strategy === "delay-rebase" && progress.rebases < run.rebaseLimit) {
    // Hold the dependents — they are not ready while this node is in
    // flight — and re-execute against the newly recorded base. The
    // next turn of `dispatch`'s loop re-measures, which re-keys, which is a
    // new attempt rather than a retry of the old identity.
    return { outcome: "rebase", ...progress, rebases: progress.rebases + 1 } satisfies Rebase
  }
  return { outcome: "conflicted", strategy, ...progress } as const
}

/**
 * `stop-merge`: the losing action is stopped and both lanes are routed
 * through an explicit merge node appended to the SAME plan, as an
 * ordinary elaboration. The merge critical section uses this module's
 * restart-or-fail landing contract, so the merge node carries no rebase
 * budget of its own: it lands, or the run has a failed node. There is no
 * worktree-lane surface; that design was removed.
 */
const appendMerge = (run: Run, intent: PlanMergeStore.Intent) =>
  Effect.gen(function*() {
    const node = yield* PlanMerges.validateIntent(run.plan, intent).pipe(Effect.catch(mergeFailure))
    const winners = intent.peers.filter((id) => run.results.has(id))
    const mergeId = PlanMerges.allocateId(run.plan, node.id)
    const parentDigest = run.plan.digest
    const grown = yield* Plan.append(run.plan, [PlanMerges.draft(node, mergeId, winners)]).pipe(
      Effect.mapError((cause) =>
        new SchedulerError({
          code: "elaboration_failed",
          message: `could not append the merge node for ${node.id}`,
          cause
        })
      )
    )
    const completion: PlanMergeStore.Completion = {
      version: 1,
      generation: grown.generation,
      parentDigest,
      planDigest: grown.digest,
      mergeId,
      mergeKey: Plan.generationNodes(grown)[0]!.key,
      winners
    }
    // `appendMerge` copies the stopped node's effects byte-for-byte, so
    // re-indexing adds no new writer coverage and cannot turn an
    // already-pinned source path into a producer. The new generation's
    // read declarations have not themselves been observed, however:
    // expand them once now and pin only source paths this run has never
    // measured. Existing pins are always reused.
    yield* observeReads(
      run,
      Plan.generationNodes(grown),
      grown.generation,
      `generation ${grown.generation}'s source inputs`,
      (snapshot) => commitMerge(run, intent, grown, completion, snapshot)
    )
    // No asynchronous boundary may expose only part of this admission.
    // Frozen generations preserve the indexed prefix and its state.
    const suffix = Plan.generationNodes(grown)
    run.graph.append(suffix)
    run.plan = grown
    indexWriters(run, suffix)
    run.appended.push(mergeId)
  })

/**
 * Commits a merge extension in one transaction: the new generation's source
 * observations, the grown plan, and the merge decision's completion.
 */
const commitMerge = (
  run: Run,
  intent: PlanMergeStore.Intent,
  grown: Plan.Plan,
  completion: PlanMergeStore.Completion,
  snapshot: PlanInputStore.Snapshot
) =>
  atomically(
    "could not atomically commit the merge extension",
    Effect.gen(function*() {
      const recorded = yield* run.inputStore.record(
        { ...run.mergeIdentity, generation: grown.generation },
        snapshot,
        run.options.owner
      )
        .pipe(Effect.catch(inputFailure))
      yield* appendPlan(run, grown)
      yield* run.mergeStore.complete(run.mergeIdentity, intent.nodeId, completion, run.options.owner).pipe(
        Effect.catch(mergeFailure)
      )
      return recorded
    })
  )

const registerAttempt = (run: Run, event: Extract<CoordinatorEvent, { readonly _tag: "AttemptKeyed" }>) => {
  const dispatchedUnder = run.digestToNode.get(event.digest)
  if (dispatchedUnder === undefined) {
    run.digestToNode.set(event.digest, [event.nodeId])
  } else if (!dispatchedUnder.includes(event.nodeId)) {
    run.digestToNode.set(event.digest, [...dispatchedUnder, event.nodeId])
  }
}

/**
 * Absorbs every report already offered without processing another node's
 * settlement. Attempt-key reports update attribution state immediately;
 * terminal reports stay ordered in `pendingSettlements` for the one-at-a-
 * time coordinator. A deviation can appear in a journal page only after
 * its attempt-key report was offered, so calling this after each page
 * closes the journal/queue observation race without a shared mutable map.
 */
const drainReportedEvents = (run: Run) =>
  Effect.gen(function*() {
    while (true) {
      const next = yield* Queue.poll(run.events)
      if (Option.isNone(next)) return
      if (next.value._tag === "AttemptKeyed") registerAttempt(run, next.value)
      else run.pendingSettlements.push(next.value)
    }
  })

const nextSettlement = (run: Run) =>
  Effect.gen(function*() {
    const pending = run.pendingSettlements.shift()
    if (pending !== undefined) return pending
    while (true) {
      const event = yield* Queue.take(run.events)
      if (event._tag === "DispatchSettled") return event
      registerAttempt(run, event)
    }
  })

/**
 * The first consumer `flows.engine.expected-set-deviation` has ever had.
 * The events are read from the journal rather than from the attempt row
 * on purpose: a deviation is a durable, replayable fact, and consuming
 * the fact keeps this seam usable by anything else that reads the
 * journal.
 *
 * Two properties the drain owes the reconciler, both of them about not
 * letting arrival order decide a verdict:
 *
 * 1. **Attribute the whole page before judging any of it.** Deviating on
 *    the same paths is a *symmetric* fact — two steps that both ran
 *    `npm install` — so registering each signature as the entry was
 *    judged answered the same situation two different ways: the first
 *    node saw no peer and was failed, and only the second was factored
 *    out. Every deviation on the page is attributed first, so both sides
 *    of a pair see each other.
 * 2. **Drain the journal, not one page of it.** Concurrent dispatches can
 *    journal more records than one page holds, and the final completion
 *    is the one that matters: nothing follows it to pick up what a single
 *    page left behind, so a deviation past the cursor would never reach
 *    the seam.
 */
const drainDeviations = (run: Run) =>
  Effect.gen(function*() {
    let hasMore = true
    while (hasMore) {
      const page = yield* run.journal.entries({
        runId: run.options.runId as JournalEvent.RunId,
        ...(run.cursor === undefined ? {} : { after: run.cursor as JournalEvent.Seq }),
        limit: 512
      }).pipe(Effect.mapError(storeFailure("could not read the run's journal")))
      // Every deviation in this page causally follows its attempt-key
      // report. Absorb those reports now, after the journal read, so even
      // an in-flight sibling can be attributed without dispatch fibers
      // mutating coordinator state.
      yield* drainReportedEvents(run)
      run.pendingDeviations.push(...attributeDeviations(run, page.entries))
      yield* judgeSettledDeviations(run)
      hasMore = page.hasMore
    }
  })

/** Attributes every deviation on a journal page, advancing the drain's cursor past the page. */
const attributeDeviations = (run: Run, entries: Journal.EntriesPage["entries"]): Array<PendingDeviation> => {
  const attributed: Array<PendingDeviation> = []
  for (const entry of entries) {
    run.cursor = entry.seq
    const deviation = attributeDeviation(run, entry)
    if (deviation !== undefined) attributed.push(deviation)
  }
  return attributed
}

/** Attributes one journal entry to its node, when it is a deviation of an attempt this run keyed. */
const attributeDeviation = (
  run: Run,
  entry: Journal.EntriesPage["entries"][number]
): PendingDeviation | undefined => {
  if (entry.eventType !== "flows.engine.expected-set-deviation") return undefined
  const payload = decodeDeviation(entry.payload)
  if (Option.isNone(payload)) return undefined
  const nodeIds = run.digestToNode.get(payload.value.stepKeyDigest)
  if (nodeIds === undefined) return undefined
  // The attempt belongs to an executing node by construction. If
  // its built settlement is absent from current bookkeeping — the
  // record arrived first, or is being durably replayed into an
  // all-clean invocation — preserve first dispatch order.
  const nodeId = nodeIds.find((candidate) => run.states.get(candidate)!.outcome === "built") ?? nodeIds[0]!
  const signature = JSON.stringify([
    "expected-set-deviation/v1",
    [...new Set(payload.value.paths)].sort(compareText)
  ])
  run.deviationSignatures.set(nodeId, signature)
  return { nodeId, signature, payload: payload.value }
}

/** Judges every pending deviation whose node has settled, in attribution order. */
const judgeSettledDeviations = function*(run: Run) {
  for (let index = 0; index < run.pendingDeviations.length;) {
    const deviation = run.pendingDeviations[index]!
    // A concurrent dispatch can durably journal its deviation before
    // its terminal event reaches the head of the coordinator queue.
    // Its signature participates in symmetric attribution now, but
    // its verdict waits until that node's settlement is processed.
    if (run.states.get(deviation.nodeId)?.status !== "settled") {
      index = index + 1
      continue
    }
    yield* judgeDeviation(run, deviation)
    run.pendingDeviations.splice(index, 1)
  }
}

/** Asks the reconciler about one settled node's deviation and applies the verdict. */
const judgeDeviation = function*(run: Run, { nodeId, payload, signature }: PendingDeviation) {
  const alsoDeviatedBy = [...run.deviationSignatures.entries()]
    .filter(([other, otherSignature]) => other !== nodeId && otherSignature === signature)
    .map(([other]) => other)
  const verdict = yield* run.reconciler.onDeviation({
    nodeId,
    keyDigest: payload.stepKeyDigest,
    attempt: payload.attempt,
    paths: payload.paths,
    diffIdentity: payload.diffIdentity,
    declaredBy: declaredByOf(run, payload.paths),
    alsoDeviatedBy
  })
  yield* applyVerdict(run, nodeId, verdict, "deviation")
}

/**
 * The declared owner of each path that has one.
 * Null prototype: a reconciler's lookup of a path named `toString` must miss.
 */
const declaredByOf = (run: Run, paths: ReadonlyArray<string>): Record<string, string> =>
  Object.assign(
    Object.create(null),
    Object.fromEntries(
      paths.flatMap((path) => {
        const owner = writerFor(run, path)
        return owner === undefined ? [] : [[path, owner] as const]
      })
    )
  )

/**
 * The selection consult, once per run, against the initial plan and the
 * pinned belief snapshot (`docs/guides/defer-work-with-selection.md`). Only sinks,
 * nodes nothing in the plan depends on,
 * are offered, because deferring a node something consumes would block
 * or corrupt its consumers. A verdict may postpone or propose, never
 * remove: `Admit` is a no-op, a `Defer` marks the sink for
 * `passiveSettlements`, a `Propose` is journaled and nothing more (v1 never
 * auto-appends), and a Defer naming a non-sink — or a Propose naming
 * anything the plan already accounts for, its flow included — is
 * ignored and journaled as an inconsistency observation, against the
 * same `present` set the layer was shown. The `full` override skips
 * the consult entirely: nothing is deferred and nothing is proposed
 * under it, and the override record is what makes that visible.
 * Elaboration cannot
 * invalidate the marks: an appended merge node depends only on nodes
 * that produced results, and a deferred node never executes, so a
 * deferred sink can never gain a dependent mid-run.
 */
const consultSelection = function*(run: Run) {
  if (run.options.selection?.full === true) {
    yield* emit(
      run,
      JournalRecords.selectionOverridden(source(run, "selection/override"), {
        planId: run.plan.planId,
        mode: "full"
      })
    )
    return
  }
  const dependedOn = new Set(run.plan.nodes.flatMap((node) => node.dependsOn))
  const sinks = run.plan.nodes.filter((node) => !dependedOn.has(node.id))
  const present = new Set([run.plan.flow, ...run.plan.nodes.map((node) => node.id)])
  const sinkIds = new Set(sinks.map((node) => node.id))
  const selected = yield* run.selector.select({
    changed: run.options.selection?.changed ?? [],
    sinks: sinks.map((node) => ({ nodeId: node.id, planKey: node.key })),
    present: [...present],
    beliefs: run.options.selection?.beliefs ?? { pinnedAtMs: 0, edges: [] },
    policy: run.options.selection?.policy ?? { deferBelow: 0 }
  })
  for (let index = 0; index < selected.length; index++) {
    yield* applySelection(run, index, selected[index]!, sinkIds, present)
  }
}

/**
 * Applies one selection verdict: a `Defer` of a sink marks it, a `Propose`
 * of anything absent is journaled, and every other non-`Admit` verdict is
 * journaled as an inconsistency.
 */
const applySelection = function*(
  run: Run,
  index: number,
  { nodeId, verdict }: Selection.Selected,
  sinkIds: ReadonlySet<string>,
  present: ReadonlySet<string>
) {
  if (verdict._tag === "Admit") return
  if (verdict._tag === "Defer" && sinkIds.has(nodeId)) {
    run.deferrals.set(nodeId, { edge: verdict.edge, likelihood: verdict.likelihood })
    return
  }
  if (verdict._tag === "Propose" && !present.has(nodeId)) {
    yield* emit(
      run,
      JournalRecords.selectionProposed(source(run, `selection/proposed/${index}`), {
        planId: run.plan.planId,
        flow: verdict.flow,
        edge: verdict.edge,
        confidence: verdict.confidence
      })
    )
    return
  }
  yield* emit(
    run,
    JournalRecords.selectionInconsistent(source(run, `selection/inconsistent/${index}`), {
      planId: run.plan.planId,
      nodeId,
      verdict: verdict._tag,
      reason: verdict._tag === "Defer" ? "not-a-deferrable-sink" : "proposes-a-present-node"
    })
  )
}

const passiveSettlements = (run: Run) =>
  Effect.gen(function*() {
    while (true) {
      const blocked = run.graph.blocked()
      // Halt, not continue-on-failure: a dependent of failed work never
      // dispatches. Repeating this pass makes the skip cascade settle in
      // dependency order before any newly exposed work is admitted.
      for (const node of blocked) yield* settle(run, node, "skipped")
      if (blocked.length > 0) continue
      // A deferral is a postponement, never a removal, and it only takes
      // effect on work that was genuinely runnable: a marked sink whose
      // cone failed settled `skipped` above instead, because work that
      // could not have run is not a debt. The debt record precedes the
      // settlement so `Selection.debt` reads them in cause-then-effect
      // order.
      const ready = run.graph.ready()
      const postponed = ready.filter((node) => run.deferrals.has(node.id))
      for (const node of postponed) yield* settleDeferred(run, node)
      if (postponed.length > 0) continue
      return ready
    }
  })

const settleDeferred = function*(run: Run, node: Plan.PlanNode) {
  const debt = run.deferrals.get(node.id)!
  yield* emit(
    run,
    JournalRecords.selectionDeferred(source(run, `node/${node.id}/selection-deferred`), {
      planId: run.plan.planId,
      nodeId: node.id,
      planKey: node.key,
      edge: debt.edge,
      likelihood: debt.likelihood
    })
  )
  yield* settle(run, node, "deferred")
}

const dispatchStart = (run: Run, node: Plan.PlanNode): DispatchStart => {
  const state = stateOf(run, node)
  const settledResults = new Map<string, unknown>()
  const inputs: Array<ResolvedInput> = []
  for (const input of node.material.inputs) {
    if (input._tag !== "Ref") continue
    const value = run.results.get(input.from)
    settledResults.set(input.from, value)
    // Admission proved every dependency settled successfully; `settle`
    // records even an `undefined` result in the map, so every material
    // Ref has a value to project here.
    inputs.push({ from: input.from, path: input.path, value: StepKey.project(value, input.path) })
  }
  return {
    dispatchKey: state.dispatchKey,
    attempts: state.attempts,
    rebases: state.rebases,
    waited: state.waited,
    results: settledResults,
    inputs
  }
}

const appendReadyMerges = (run: Run) =>
  Effect.gen(function*() {
    for (let index = 0; index < run.pendingMerges.length;) {
      const pending = run.pendingMerges[index]!
      if (pending.peers.some((peer) => run.states.get(peer)?.status !== "settled")) {
        index = index + 1
        continue
      }
      yield* appendMerge(run, pending)
      run.pendingMerges.splice(index, 1)
    }
  })

// Passive failure/selection propagation can settle the last peer of
// a recovered intent without a dispatch event. Recheck merges until
// neither propagation nor an append exposes more scheduling work.
const advance = (run: Run) =>
  Effect.gen(function*() {
    while (true) {
      const ready = yield* passiveSettlements(run)
      const before = run.plan.generation
      yield* appendReadyMerges(run)
      if (run.plan.generation === before) return ready
    }
  })

/** Admits ready work within the concurrency caps and forks a dispatch for each admitted node. */
const admit = (run: Run, ready: ReadonlyArray<Plan.PlanNode>) =>
  Effect.gen(function*() {
    const decision = run.scheduling.admit(
      run.graph.candidates(ready),
      { steps: run.inFlightSteps, agents: run.inFlightAgents }
    )
    const admitted = decision.admitted.map(({ node }) => node)
    // Event-driven aging: this admission pass considered every ready
    // node, and only capacity can leave one behind.
    for (const { node, waited } of decision.deferred) {
      stateOf(run, node).waited = waited
    }
    if (admitted.length > 0) yield* recordAdmission(run, ready.length, admitted.length, decision.agents)
    const launches = admitted.map((node) => launch(run, node))
    for (const { node, start } of launches) {
      yield* dispatch(run, node, start).pipe(
        Effect.trackDuration(EngineStoreMetrics.schedulerDispatchDuration),
        Effect.exit,
        Effect.flatMap((exit) => Queue.offer(run.events, { _tag: "DispatchSettled", node, exit })),
        Effect.asVoid,
        Effect.forkScoped({ startImmediately: true })
      )
    }
  })

const recordAdmission = function*(run: Run, ready: number, admitted: number, agents: number) {
  run.admissions = run.admissions + 1
  yield* Effect.annotateCurrentSpan({ admissions: run.admissions })
  yield* Metric.update(EngineStoreMetrics.schedulerAdmissions, 1)
  yield* Effect.logDebug("scheduler admission launched", {
    admission: run.admissions,
    ready,
    admitted,
    agents,
    inFlightSteps: run.inFlightSteps,
    inFlightAgents: run.inFlightAgents
  })
}

/** Takes a node's permits and marks it running; returns what its dispatch starts from. */
const launch = (run: Run, node: Plan.PlanNode) => {
  const start = dispatchStart(run, node)
  run.graph.start(node.id)
  run.inFlightSteps = run.inFlightSteps + 1
  if (node.kind === "agent") run.inFlightAgents = run.inFlightAgents + 1
  return { node, start }
}

/**
 * Runs the coordinator in a scope of its own. Dispatches fork into that
 * scope, so a coordinator failure interrupts every sibling in flight, and a
 * failure to settle one joins the scheduler's error.
 */
const schedule = (run: Run) =>
  Effect.scoped(
    coordinate(run).pipe(Effect.onError((cause) =>
      Effect.sync(() => {
        run.abortedForFailure = cause.reasons.some((reason) => reason._tag === "Fail")
      })
    ))
  ).pipe(Effect.catch((error) =>
    Effect.fail(
      run.cleanupErrors.length === 0 ? error : new SchedulerError({
        code: error.code,
        message: error.message,
        cause: error.cause,
        cleanupErrors: run.cleanupErrors
      })
    )
  ))

/**
 * The coordinator: admits ready work, then processes one dispatch
 * settlement at a time until every node has settled.
 */
const coordinate = (run: Run) =>
  Effect.gen(function*() {
    // Repair a settlement missing after a crash without appending the
    // same stopped decision again when its original record survived.
    for (const { intent } of run.recoveredMerges) yield* emitSettlement(run, run.nodesById.get(intent.nodeId)!, 0)
    yield* Effect.flatMap(advance(run), (ready) => admit(run, ready))
    while (run.graph.remaining > 0) {
      // Compiled plans are acyclic, inferred edges refuse cycle closure,
      // and discovered edges point only from undispatched nodes to the
      // already-settled node whose verdict added them, so pending work
      // with nothing in flight cannot have an empty ready set. If an
      // invariant breaks anyway, fail loudly: returning here would
      // report unsettled nodes with their initial outcome as success.
      /* v8 ignore next 7 -- unreachable while the invariants above hold */
      if (run.inFlightSteps === 0) {
        return yield* Effect.die(
          new Error(
            `PlanScheduler invariant broken: ${run.graph.remaining} nodes are pending and nothing is in flight`
          )
        )
      }
      const event = yield* nextSettlement(run)
      if (Exit.isFailure(event.exit)) return yield* Effect.failCause(event.exit.cause)
      yield* settleDispatch(run, event.node, event.exit.value)
    }
  })

/**
 * Processes one dispatch's terminal event: releases its permits, records
 * its outcome, reconciles its deviations, journals its settlement, and
 * admits whatever that exposes.
 */
const settleDispatch = function*(run: Run, node: Plan.PlanNode, result: Dispatched) {
  const state = stateOf(run, node)
  run.inFlightSteps = run.inFlightSteps - 1
  if (node.kind === "agent") run.inFlightAgents = run.inFlightAgents - 1
  recordProgress(state, result)
  yield* recordOutcome(run, node, result)
  yield* appendReadyMerges(run)

  // The dispatch durably journalled every deviation before its event.
  // Apply those verdicts before consulting downstream readiness.
  yield* drainDeviations(run)
  // A dispatch outcome is provisional until its deviations have been
  // reconciled. Persist exactly one terminal fact, after a Fail
  // verdict has had the chance to replace built with failed.
  yield* emitSettlement(run, node)
  run.graph.reconcile()
  // Process terminal events already observed by the journal drain
  // before opening more permits. This preserves fail-fast behavior for
  // an already-failed sibling while still admitting immediately when
  // unrelated work is genuinely still in flight.
  const ready = yield* advance(run)
  if (run.pendingSettlements.length === 0) yield* admit(run, ready)
}

/** Records a dispatch's outcome, provisional until its deviations are reconciled. */
const recordOutcome = function*(run: Run, node: Plan.PlanNode, result: Dispatched) {
  switch (result.outcome) {
    case "built":
    case "clean":
      run.results.set(node.id, result.result)
      markSettled(run, node, result.outcome)
      return
    case "failed":
      markSettled(run, node, "failed")
      return
    case "conflicted":
      return yield* settleConflict(run, node, result)
  }
}

/**
 * A conflicted dispatch under `stop-merge` stops in favour of a merge node;
 * under any other strategy the reconciler judges it and the node fails.
 */
const settleConflict = function*(run: Run, node: Plan.PlanNode, result: ConflictedDispatch) {
  if (result.strategy === "stop-merge") return yield* stopForMerge(run, node)
  const state = stateOf(run, node)
  const verdict = yield* run.reconciler.onConflict({
    nodeId: node.id,
    keyDigest: state.dispatchKey,
    attempt: state.attempts,
    rebases: state.rebases,
    strategy: result.strategy,
    conflictsWith: node.conflicts.map((conflict) => conflict.with)
  })
  markSettled(run, node, "failed")
  yield* applyVerdict(run, node.id, verdict, "materialization-conflict")
}

/**
 * Stops a conflicted attempt in favour of a merge node: persists the
 * decision, settles the node `skipped`, and queues the merge until its
 * running peers settle.
 */
const stopForMerge = function*(run: Run, node: Plan.PlanNode) {
  const state = stateOf(run, node)
  const intent = yield* atomically("could not persist the stopped-attempt decision", intendMerge(run, node, state))
  markSettled(run, node, "skipped")
  // The former dispatch barrier guaranteed that every
  // conflicting sibling admitted beside this node had reported
  // its result before `appendMerge` selected winners. Preserve
  // that semantic boundary only for those already-running
  // peers; unrelated work never holds the merge cone.
  recordProgress(state, intent)
  run.pendingMerges.push(intent)
}

/** Persists and validates the decision to stop a conflicted node for a merge. */
const intendMerge = (run: Run, node: Plan.PlanNode, state: RuntimeGraph.NodeState) =>
  Effect.gen(function*() {
    const intent = yield* run.mergeStore.intend(run.mergeIdentity, {
      version: 1,
      nodeId: node.id,
      nodeKey: node.key,
      dispatchKey: state.dispatchKey,
      attempts: state.attempts,
      rebases: state.rebases,
      peers: node.conflicts.map((conflict) => conflict.with)
        .filter((peer) => run.states.get(peer)?.status === "running" || run.results.has(peer))
    }, run.options.owner).pipe(Effect.catch(mergeFailure))
    yield* PlanMerges.validateIntent(run.plan, intent).pipe(Effect.catch(mergeFailure))
    return intent
  })

/** The run's report, after logging how its nodes settled. */
const reportOf = function*(run: Run) {
  const settlements = run.plan.nodes.map((node) => {
    const state = stateOf(run, node)
    return {
      nodeId: node.id,
      planKey: node.key,
      dispatchKey: state.dispatchKey,
      outcome: state.outcome,
      attempts: state.attempts,
      rebases: state.rebases
    }
  })
  const count = (outcome: Outcome) => settlements.filter((settlement) => settlement.outcome === outcome).length
  yield* Effect.logDebug("scheduler run completed", {
    admissions: run.admissions,
    built: count("built"),
    clean: count("clean"),
    failed: count("failed"),
    skipped: count("skipped"),
    deferred: count("deferred")
  })
  return {
    planId: run.plan.planId,
    digest: run.plan.digest,
    settlements,
    results: Object.fromEntries(run.results),
    verdicts: run.verdicts,
    appended: run.appended
  }
}

/**
 * Drives one run: opens it, indexes declared writers, recovers source
 * observations and merge decisions, consults selection once, schedules
 * every node, and reports.
 */
const runPlan = Effect.fn("PlanScheduler.run")((scheduler: Scheduler, candidate: Plan.Plan) =>
  Effect.gen(function*() {
    const run = yield* openRun(scheduler, candidate)
    indexWriters(run, run.plan.nodes)
    yield* recoverObservations(run)
    recoverMergeIntents(run)
    yield* consultSelection(run)
    yield* schedule(run)
    return yield* reportOf(run)
  }).pipe(
    Effect.annotateSpans({ runId: scheduler.options.runId }),
    Effect.annotateLogs({ runId: scheduler.options.runId }),
    Effect.onExit((exit) => Effect.annotateCurrentSpan({ outcome: EngineStoreMetrics.exitTag(exit).toLowerCase() }))
  )
)

const service = (scheduler: Scheduler): Service => ({
  record: (candidate) => recordPlan(scheduler, candidate),
  append: (candidate) => appendPlan(scheduler, candidate),
  run: (candidate) => runPlan(scheduler, candidate)
})

/**
 * Constructs a scheduler bound to one run.
 *
 * @since 0.1.0
 * @category constructors
 */
export const make = (options: Options): Service =>
  service({
    options,
    admission: AttemptAdmission.makeUnsafe(),
    cacheAgeVerdict: CacheAgeVerdicts.make(options.runId),
    rebaseLimit: nonNegativeSafeInteger("rebaseLimit", options.rebaseLimit ?? 3),
    scheduling: Scheduling.make(options.concurrency),
    capturedEnvironment: Result.try(() =>
      Schema.decodeUnknownSync(Schema.UndefinedOr(StepKey.EnvironmentIdentity))(
        options.environment,
        { onExcessProperty: "error" }
      )
    ),
    lineageId: FlowEngine.Lineage.root(options.runId)
  })

/**
 * Provides a scheduler bound to one run.
 *
 * @since 0.1.0
 * @category layers
 */
export const layer = (options: Options): Layer.Layer<PlanScheduler> => Layer.succeed(PlanScheduler, make(options))

/**
 * What {@link recertify} returns: the repaying run's id, its report, and the
 * deferring run's remaining debt after the repayment is counted.
 *
 * @since 0.1.0
 * @category models
 */
export interface RecertifyResult {
  readonly runId: string
  readonly report: Report
  readonly remaining: ReadonlyArray<Selection.DebtEntry>
}

/**
 * The recertification driver: re-drives a compiled plan under a fresh,
 * caller-supplied run with the `full` selection override — guess-free by
 * construction — then reports the deferring run's remaining debt via
 * `Selection.debt(deferringRunId, { repaidBy: [options.runId] })`.
 *
 * The design draft placed this beside the other Selection helpers; it lives
 * here because it constructs a scheduler, and `Selection` must stay
 * type-only toward this module to keep the dependency graph acyclic. The
 * deferring run's journal is never written — repayment is a read-side join.
 * Scheduling the cadence (nightly, per-merge) stays a product concern; this
 * is only the primitive one pass runs.
 *
 * @since 0.1.0
 * @category combinators
 */
export const recertify = Effect.fn("PlanScheduler.recertify")(
  (input: {
    readonly plan: Plan.Plan
    readonly deferringRunId: string
    readonly options: Options
  }) =>
    Effect.gen(function*() {
      const scheduler = make({
        ...input.options,
        selection: { ...input.options.selection, full: true }
      })
      const report = yield* scheduler.run(input.plan)
      const remaining = yield* Selection.debt(input.deferringRunId, { repaidBy: [input.options.runId] })
      return { runId: input.options.runId, report, remaining } satisfies RecertifyResult
    })
)

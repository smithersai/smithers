/**
 * Ownership-fenced, crash-recoverable rewind protocol.
 *
 * @since 0.1.0
 */
import type { Jj } from "@smthrs/jj"
import * as Journal from "@smthrs/journal/Journal"
import type * as JournalEvent from "@smthrs/journal/JournalEvent"
import * as Ownership from "@smthrs/run-store/Ownership"
import type { LivenessEvidence, OwnerId } from "@smthrs/run-store/Ownership"
import * as RunStore from "@smthrs/run-store/RunStore"
import type * as CacheStore from "@smthrs/step-cache/CacheStore"
import * as Cause from "effect/Cause"
import * as Clock from "effect/Clock"
import type * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as EffectBoundary from "../EffectBoundary.ts"
import { Frame, type LineageEdge } from "../Frame.ts"
import { error, fromCause, type TimeTravelError as TimeTravelFailure } from "../TimeTravelError.ts"
import { ArchiveResult, type Audit, TimeTravelStore } from "../TimeTravelStore.ts"
import * as Compensation from "./Compensation.ts"
import type { EffectHandlerRegistry } from "./EffectHandlerRegistry.ts"
import * as HistoryLimit from "./HistoryLimit.ts"
import * as JournalPages from "./JournalPages.ts"
import { LineageMetadata } from "./LineageMetadata.ts"
import * as RunRow from "./RunRow.ts"
import * as StepHook from "./StepHook.ts"

/**
 * The eight fault-injection points pinned by the rewind parity suite.
 *
 * Every hook runs after the durable audit exists and before the atomic archive
 * commit. A failure therefore exercises rollback while preserving the audit.
 *
 * @since 0.1.0
 * @category models
 */
export const RewindStep = Schema.Literals([
  "claim-run",
  "rate-limit",
  "write-audit",
  "load-suffix",
  "assess-boundary",
  "compensate-effects",
  "restore-workspace",
  "archive-and-truncate"
])
/**
 * The value form of {@link RewindStep}.
 *
 * @since 0.1.0
 * @category models
 */
export type RewindStep = typeof RewindStep.Type

/**
 * A deterministic rate-limit decision recorded on the audit row.
 *
 * @since 0.1.0
 * @category models
 */
export const RateLimitDecision = Schema.Struct({
  allowed: Schema.Boolean,
  detail: Schema.optionalKey(Schema.Unknown)
})
/**
 * The value form of {@link RateLimitDecision}.
 *
 * @since 0.1.0
 * @category models
 */
export type RateLimitDecision = typeof RateLimitDecision.Type

/**
 * Child handling policy for detached runs crossed by the rewind.
 *
 * @since 0.1.0
 * @category models
 */
export const DetachedChildPolicy = Schema.Literals(["block", "cancel"])
/**
 * The value form of {@link DetachedChildPolicy}.
 *
 * @since 0.1.0
 * @category models
 */
export type DetachedChildPolicy = typeof DetachedChildPolicy.Type

/**
 * A warning disclosed for a terminal detached child that survives truncation.
 *
 * @since 0.1.0
 * @category models
 */
export const DetachedChildWarning = Schema.Struct({
  childRunId: Schema.NonEmptyString,
  parentSeq: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  reason: Schema.String
})
/**
 * The value form of {@link DetachedChildWarning}.
 *
 * @since 0.1.0
 * @category models
 */
export type DetachedChildWarning = typeof DetachedChildWarning.Type

/**
 * Crash-recovery detail persisted on the audit row.
 *
 * @since 0.1.0
 * @category models
 */
export const AuditDetail = Schema.Struct({
  version: Schema.Literal(1),
  phase: Schema.Literals([
    "audit_written",
    "preflight_complete",
    "compensated",
    "archive_committed",
    "completed",
    "rolled_back",
    "terminal_failure"
  ]),
  originalStatus: Schema.Literals(["pending", "suspended"]),
  suffixCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  suffixTailSeq: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  targetChangeId: Schema.optionalKey(Schema.NonEmptyString),
  compensation: Schema.optionalKey(Compensation.Result),
  warnings: Schema.Array(DetachedChildWarning),
  cancelledChildren: Schema.Array(Schema.NonEmptyString),
  /**
   * The children this rewind still owes a cancellation, written with the
   * `compensated` phase before the archive and emptied as each one lands.
   *
   * Cancellation runs after the commit point because it is terminal, so the
   * plan has to be durable before the commit: an audit that recorded only the
   * children it had already cancelled let recovery close an `archive_committed`
   * row as complete while the operator's remaining cancellations were silently
   * dropped. Optional so a detail written before this field still decodes.
   */
  pendingChildren: Schema.optionalKey(Schema.Array(Schema.NonEmptyString)),
  failure: Schema.optionalKey(Schema.String),
  /**
   * The rollback error written with the `terminal_failure` phase, when the
   * failure branch could not undo the compensations it had already performed.
   *
   * Its presence is the machine-readable form of "the `compensation` on this
   * detail is still applied to the outside world": a `rolled_back` detail has
   * had its receipts undone and drops them, while this one keeps them.
   */
  rollbackFailure: Schema.optionalKey(Schema.String)
})
/**
 * The value form of {@link AuditDetail}.
 *
 * @since 0.1.0
 * @category models
 */
export type AuditDetail = typeof AuditDetail.Type

/**
 * Rewind construction options.
 *
 * @since 0.1.0
 * @category models
 */
export interface Options {
  readonly compensationTimeout?: Duration.Input | undefined
  readonly runId: string
  readonly frame: Frame
  readonly owner: OwnerId
  readonly auditId?: string | undefined
  /**
   * The journal tail {@link validate} observed, re-checked once the run is
   * claimed.
   *
   * Validation runs before the claim, so another executor can claim the idle
   * row, append records, and release it inside that window; the later claim
   * then succeeds and the truncation deletes records validation would have
   * refused. Threading the observed tail through binds the two together. The
   * wrapper distinguishes no expectation from a validated empty journal,
   * whose expected `tail` is `undefined`.
   */
  readonly expectedTail?: { readonly tail: Tail | undefined } | undefined
  readonly pageSize?: number | undefined
  /**
   * The most suffix entries the rewind may read while it holds the run before
   * it refuses with `limit_exceeded`. {@link validate} applies the same cap
   * before the claim. Defaults to `HistoryLimit.defaultMaxHistoryEntries`.
   */
  readonly maxEntries?: number | undefined
  readonly detachedChildPolicy?: DetachedChildPolicy | undefined
  readonly rateLimit?: (options: {
    readonly runId: string
    readonly frame: Frame
    readonly nowMs: number
  }) => Effect.Effect<RateLimitDecision, TimeTravelFailure> | undefined
  readonly childLivenessEvidence?: (
    childRunId: string,
    row: RunStore.RunRow,
    owner: OwnerId,
    nowMs: number
  ) => Effect.Effect<LivenessEvidence | undefined, TimeTravelFailure>
  readonly hooks?: {
    readonly beforeStep?: (
      step: RewindStep
    ) => Effect.Effect<void, unknown>
  } | undefined
}

/**
 * Successful rewind outcome.
 *
 * @since 0.1.0
 * @category models
 */
export const Result = Schema.Struct({
  auditId: Schema.NonEmptyString,
  frame: Frame,
  archive: ArchiveResult,
  assessments: Schema.Array(Compensation.Assessment),
  warnings: Schema.Array(DetachedChildWarning),
  cancelledChildren: Schema.Array(Schema.NonEmptyString)
})
/**
 * The value form of {@link Result}.
 *
 * @since 0.1.0
 * @category models
 */
export type Result = typeof Result.Type

interface ClaimedRun {
  readonly row: RunStore.RunRow & { readonly status: "pending" | "suspended" }
  readonly claimedAtMs: number
}

interface ChildPlan {
  readonly edge: LineageEdge
  readonly row: RunStore.RunRow
}

interface ClaimedChild {
  readonly plan: ChildPlan
  readonly owner: OwnerId
  readonly claimedAtMs: number
}

const lineageOf = (entry: JournalEvent.Entry): string | undefined =>
  Option.getOrUndefined(Schema.decodeUnknownOption(LineageMetadata)(entry.meta))?.lineageId

/**
 * The last record a scan of a run's journal saw.
 *
 * It is the whole comparison a post-claim revalidation needs: a record appended
 * between validation and the claim moves the seq, and a trampoline handoff onto
 * a new lineage moves the lineage.
 *
 * @since 0.1.0
 * @category models
 */
export interface Tail {
  readonly seq: number
  readonly lineageId: string | undefined
}

/**
 * Whether the run's tail is still the one validation observed, from one read.
 *
 * The journal appends monotonically and truncation is fenced on ownership,
 * so the question "did anything land past the tail" is answered by the page
 * starting AT the expected tail: it must hold exactly that record, on the
 * expected lineage, and nothing after it. Reading the expected record itself
 * rather than only what follows it is what catches a rewind by another
 * executor that truncated below the tail and re-appended up to the same seq.
 * The whole-journal scan stays in {@link validate}, where the frame and the
 * suffix count are needed; under the claim they are not.
 */
const tailUnmoved = (
  journal: Journal.Service,
  runId: string,
  expected: Tail | undefined
): Effect.Effect<boolean, TimeTravelFailure> =>
  journal.entries({
    runId: runId as JournalEvent.RunId,
    ...(expected === undefined || expected.seq === 0 ? {} : { after: (expected.seq - 1) as JournalEvent.Seq }),
    limit: 2
  }).pipe(
    Effect.mapError((cause) => error("unknown", `could not read journal for ${runId}`, cause)),
    Effect.map((page) => {
      if (expected === undefined) return page.entries.length === 0 && !page.hasMore
      const observed = page.entries[0]
      return page.entries.length === 1 && !page.hasMore && observed !== undefined &&
        observed.seq === expected.seq && lineageOf(observed) === expected.lineageId
    })
  )

/**
 * Reads a run's whole journal once, returning its tail, whether the frame
 * addresses a record, and how many records lie above the frame.
 *
 * Nothing is retained: the suffix count is what lets {@link validate} refuse
 * an over-long truncation before the claim, without holding the entries.
 *
 * FAIL CLOSED on a page that claims more and delivers nothing. The destructive
 * paths used to treat an empty continuation as the end of history, so a journal
 * returning a transient empty page would let boundary assessment see part of
 * the suffix while the archive still deleted the real one. That refusal lives
 * in `JournalPages.forEachPage` now, shared with every other read.
 */
const scan = (
  journal: Journal.Service,
  options: { readonly runId: string; readonly frame: Frame; readonly pageSize?: number | undefined },
  label: "validation"
): Effect.Effect<
  { readonly tail: Tail | undefined; readonly atFrame: boolean; readonly suffixCount: number },
  TimeTravelFailure
> =>
  Effect.gen(function*() {
    let tail: Tail | undefined
    let atFrame = false
    let suffixCount = 0
    yield* JournalPages.forEachPage(
      journal,
      {
        runId: options.runId,
        pageSize: options.pageSize ?? 100,
        label: `journal ${label}`,
        readFailure: `could not read journal for ${options.runId}`
      },
      (entries) =>
        Effect.sync(() => {
          for (const entry of entries) {
            if (tail === undefined || entry.seq > tail.seq) tail = { seq: entry.seq, lineageId: lineageOf(entry) }
            if (entry.seq > options.frame.seq) suffixCount += 1
            if (entry.seq === options.frame.seq) {
              const lineage = lineageOf(entry)
              if (lineage === undefined || lineage === options.frame.lineageId) atFrame = true
            }
          }
        })
    )
    return { tail, atFrame, suffixCount }
  })

/**
 * The validation phase of the rewind protocol: every caller-supplied input and
 * every frame-lineage claim is checked BEFORE the first durable or workspace
 * mutation — before the ownership claim, before the audit row, before any
 * store write.
 *
 * The public `TimeTravel.rewind` runs this ahead of {@link rewind}'s claim
 * phase, so a refused position leaves no trace: no claim was taken, no audit
 * was opened, no journal page was read for a malformed page size.
 *
 * A frame is refused `not_found` unless it addresses the run's history:
 * the coordinate must not lie past the journal tail, the run's tail must be on
 * the requested lineage (a sibling lineage's coordinate is not a point this
 * run can be truncated back to), and — frame zero excepted, the one frame that
 * is always addressable — a record of the requested lineage must exist at the
 * exact coordinate. Records that carry no lineage are compatible with every
 * frame: they predate lineage minting yet are still evidence of the run.
 *
 * @since 0.1.0
 * @category validators
 */
export const validate = (options: {
  readonly runId: string
  readonly frame: Frame
  readonly pageSize?: number | undefined
  readonly maxEntries?: number | undefined
}): Effect.Effect<Tail | undefined, TimeTravelFailure, Journal.Journal> =>
  Effect.gen(function*() {
    if (options.pageSize !== undefined && (!Number.isSafeInteger(options.pageSize) || options.pageSize < 1)) {
      return yield* Effect.fail(
        error("invalid", `rewind pageSize must be a positive integer, not ${String(options.pageSize)}`)
      )
    }
    if (options.pageSize !== undefined && options.pageSize > Journal.maxEntriesLimit) {
      return yield* Effect.fail(
        error("invalid", `rewind pageSize must be at most ${Journal.maxEntriesLimit}, not ${String(options.pageSize)}`)
      )
    }
    const maxEntries = options.maxEntries ?? HistoryLimit.defaultMaxHistoryEntries
    const journal = yield* Journal.Journal
    const coordinate = `${options.frame.lineageId}@${options.frame.seq}`
    const scanned = yield* scan(journal, options, "validation").pipe(
      Effect.catch((failure) =>
        failure.code === "unknown"
          ? Effect.fail(
            error("unknown", `could not validate frame ${coordinate} for ${options.runId}`, failure.cause)
          )
          : Effect.fail(failure)
      )
    )
    const tail = scanned.tail
    if (tail === undefined) {
      // Frame zero is the state before the run wrote anything, so it is the
      // one frame an empty journal can still address.
      if (options.frame.seq === 0) return undefined
      return yield* Effect.fail(
        error("not_found", `frame ${coordinate} is beyond the journal tail of ${options.runId}`)
      )
    }
    if (options.frame.seq > tail.seq) {
      return yield* Effect.fail(
        error("not_found", `frame ${coordinate} is beyond the journal tail of ${options.runId}`)
      )
    }
    if (tail.lineageId !== undefined && tail.lineageId !== options.frame.lineageId) {
      return yield* Effect.fail(
        error("not_found", `run ${options.runId} is on lineage ${tail.lineageId}, not ${options.frame.lineageId}`)
      )
    }
    if (options.frame.seq > 0 && !scanned.atFrame) {
      return yield* Effect.fail(
        error(
          "not_found",
          `no record of lineage ${options.frame.lineageId} exists at seq ${options.frame.seq} in ${options.runId}`
        )
      )
    }
    // Refused here, before the claim, so an over-long truncation leaves no
    // claim and no audit row behind; the owned read below re-checks it.
    if (scanned.suffixCount > maxEntries) {
      return yield* Effect.fail(HistoryLimit.exceeded("rewind", options.runId, maxEntries))
    }
    return tail
  })

/**
 * The suffix above the frame, reduced to what assessment and the audit need.
 *
 * `boundary` holds only the effect-boundary records, because those are the
 * only ones `EffectBoundary.fromEntries` decodes; `count` and `tailSeq` are
 * the audit's view of the whole suffix. The suffix used to be retained
 * entire while the rewind held the run.
 */
interface Suffix {
  readonly boundary: ReadonlyArray<JournalEvent.Entry>
  readonly count: number
  readonly tailSeq: number | undefined
}

const readSuffix = (
  journal: Journal.Service,
  runId: string,
  frame: Frame,
  pageSize: number,
  maxEntries: number
): Effect.Effect<Suffix, TimeTravelFailure> =>
  Effect.gen(function*() {
    const boundary: Array<JournalEvent.Entry> = []
    let count = 0
    let tailSeq: number | undefined
    // Fail closed: a page that claims more and delivers nothing would hide
    // part of the suffix from boundary assessment while the archive still
    // deleted all of it. The pager refuses it.
    yield* JournalPages.forEachPage(
      journal,
      { runId, after: frame.seq, pageSize, label: "journal suffix", readFailure: `could not read suffix for ${runId}` },
      (entries) =>
        Effect.gen(function*() {
          for (const entry of entries) {
            count += 1
            if (count > maxEntries) {
              return yield* Effect.fail(HistoryLimit.exceeded("rewind", runId, maxEntries))
            }
            if (tailSeq === undefined || entry.seq > tailSeq) tailSeq = entry.seq
            if (entry.eventType === EffectBoundary.eventType) boundary.push(entry)
          }
        })
    )
    return { boundary, count, tailSeq }
  })

const claimRun = (
  runs: RunStore.Service,
  options: Options,
  nowMs: number
): Effect.Effect<ClaimedRun, TimeTravelFailure> =>
  Effect.gen(function*() {
    const row = yield* runs.get(options.runId).pipe(
      Effect.mapError((cause) => RunRow.failure("read run", cause))
    )
    if (row.status !== "pending" && row.status !== "suspended") {
      return yield* Effect.fail(error("busy", `run ${options.runId} is not available for rewind`))
    }
    const rewindableRow: ClaimedRun["row"] = { ...row, status: row.status }
    if (row.owner !== null || row.claim !== null) {
      return yield* Effect.fail(error("busy", `run ${options.runId} is not available for rewind`))
    }
    const expected = RunRow.snapshotOf(row)
    const outcome = yield* runs.claim(options.runId, expected, options.owner, nowMs).pipe(
      Effect.mapError((cause) => RunRow.failure("claim run", cause))
    )
    if (outcome._tag === "NotFound") {
      return yield* Effect.fail(error("not_found", `run ${options.runId} was not found`))
    }
    if (outcome._tag !== "Claimed") {
      return yield* Effect.fail(error("busy", `run ${options.runId} lost the rewind claim`))
    }
    const activated = yield* runs.activate(
      options.runId,
      options.owner,
      outcome.claimedAtMs,
      expected
    ).pipe(
      Effect.mapError((cause) => RunRow.failure("activate rewind claim", cause))
    )
    if (activated._tag !== "Activated") {
      yield* Effect.ignore(runs.abandonClaim(options.runId, options.owner, outcome.claimedAtMs))
      return yield* Effect.fail(error("busy", `run ${options.runId} lost the rewind activation`))
    }
    return { row: rewindableRow, claimedAtMs: outcome.claimedAtMs }
  })

/**
 * Resolves every descendant a rewind crosses: cancel it, disclose it, or refuse.
 *
 * ATTACHED CHILDREN ARE RESOLVED TOO. `archiveAndTruncate` archives and deletes
 * every attached child's whole journal and removes its edges. That mutation
 * used to fence only the parent, and nothing here read those children at all:
 * a suspended parent durably waiting on a running attached child had that
 * child's journal emptied under it while the child kept executing. Assessment
 * now resolves the child, and the archive transaction independently fences
 * every non-terminal attached child under the rewind's claimed child owner.
 *
 * A child reached by more than one edge is resolved once. The edge union reads
 * the same run twice whenever two sources describe it, and cancelling a run
 * twice is a second terminal transition against a fence that is already gone.
 */
const assessChildren = (
  runs: RunStore.Service,
  attachedEdges: ReadonlyArray<LineageEdge>,
  detachedEdges: ReadonlyArray<LineageEdge>,
  policy: DetachedChildPolicy
): Effect.Effect<{
  readonly warnings: ReadonlyArray<DetachedChildWarning>
  readonly cancellable: ReadonlyArray<ChildPlan>
}, TimeTravelFailure> =>
  Effect.gen(function*() {
    const warnings: Array<DetachedChildWarning> = []
    const cancellable: Array<ChildPlan> = []
    const resolved = new Set<string>()
    const groups = [
      { kind: "attached" as const, edges: attachedEdges },
      { kind: "detached" as const, edges: detachedEdges }
    ]
    for (const group of groups) {
      for (const edge of group.edges) {
        if (resolved.has(edge.childRunId)) continue
        resolved.add(edge.childRunId)
        const child: RunStore.RunRow | undefined = yield* runs.get(edge.childRunId).pipe(
          Effect.map((row): RunStore.RunRow | undefined => row),
          // Only a missing ROW justifies the missing-evidence warning. Every
          // other failure - a database outage, a decode failure - leaves the
          // child's liveness unknown, and continuing on unknown liveness is
          // exactly what the `block` policy exists to prevent.
          Effect.catch((cause) =>
            cause.code === "not_found_row"
              ? Effect.succeed(undefined)
              : Effect.fail(RunRow.failure(`read ${group.kind} child ${edge.childRunId}`, cause))
          )
        )
        if (child === undefined) {
          warnings.push({
            childRunId: edge.childRunId,
            parentSeq: edge.parentSeq,
            reason: `${
              group.kind === "attached" ? "Attached" : "Detached"
            } child evidence is missing; the orphaned lineage edge remains disclosed.`
          })
          continue
        }
        if (RunStore.isTerminalRunStatus(child.status)) {
          warnings.push({
            childRunId: edge.childRunId,
            parentSeq: edge.parentSeq,
            reason: group.kind === "attached"
              ? `Terminal attached child ${edge.childRunId} had its journal archived with parent run.`
              : `Terminal detached child ${edge.childRunId} survives as an orphaned lineage edge.`
          })
          continue
        }
        if (policy === "block") {
          return yield* Effect.fail(
            error("live_child", `live ${group.kind} child ${edge.childRunId} blocks rewind`)
          )
        }
        cancellable.push({ edge, row: child })
      }
    }
    return { warnings, cancellable }
  })

const claimChild = (
  runs: RunStore.Service,
  options: Options,
  plan: ChildPlan
): Effect.Effect<ClaimedChild, TimeTravelFailure> =>
  Effect.gen(function*() {
    const nowMs = yield* Clock.currentTimeMillis
    const childOwner: OwnerId = {
      ...options.owner,
      nonce: `${options.owner.nonce}:rewind-child:${plan.edge.childRunId}`
    }
    const expected = RunRow.snapshotOf(plan.row)
    const claim = plan.row.status === "running"
      ? yield* Effect.gen(function*() {
        if (options.childLivenessEvidence === undefined) {
          return yield* Effect.fail(
            error("live_child", `child ${plan.edge.childRunId} is running and has no cancellation evidence`)
          )
        }
        const evidence = yield* options.childLivenessEvidence(
          plan.edge.childRunId,
          plan.row,
          childOwner,
          nowMs
        )
        if (evidence === undefined) {
          return yield* Effect.fail(
            error("live_child", `child ${plan.edge.childRunId} is still live`)
          )
        }
        return yield* runs.steal(plan.edge.childRunId, expected, childOwner, nowMs, evidence).pipe(
          Effect.mapError((cause) => RunRow.failure(`claim child ${plan.edge.childRunId}`, cause))
        )
      })
      : yield* runs.claim(plan.edge.childRunId, expected, childOwner, nowMs).pipe(
        Effect.mapError((cause) => RunRow.failure(`claim child ${plan.edge.childRunId}`, cause))
      )

    if (claim._tag !== "Claimed") {
      return yield* Effect.fail(
        error("live_child", `could not claim child ${plan.edge.childRunId} for cancellation`)
      )
    }
    const activated = yield* runs.activate(
      plan.edge.childRunId,
      childOwner,
      claim.claimedAtMs,
      expected
    ).pipe(
      Effect.mapError((cause) => RunRow.failure(`activate child ${plan.edge.childRunId}`, cause))
    )
    if (activated._tag !== "Activated") {
      yield* Effect.ignore(runs.abandonClaim(plan.edge.childRunId, childOwner, claim.claimedAtMs))
      return yield* Effect.fail(
        error("live_child", `child ${plan.edge.childRunId} lost its cancellation claim`)
      )
    }
    return { plan, owner: childOwner, claimedAtMs: claim.claimedAtMs }
  })

const cancelClaimedChild = (
  runs: RunStore.Service,
  claimed: ClaimedChild
): Effect.Effect<void, TimeTravelFailure> =>
  Effect.gen(function*() {
    const childRunId = claimed.plan.edge.childRunId
    const cancelled = yield* runs.transitionOwned(
      childRunId,
      claimed.owner,
      "cancelled"
    ).pipe(
      Effect.mapError((cause) => RunRow.failure(`cancel child ${childRunId}`, cause))
    )
    if (cancelled._tag !== "Transitioned") {
      return yield* Effect.fail(
        error("live_child", `child ${childRunId} lost its cancellation fence`)
      )
    }
  })

const initialDetail = (
  originalStatus: "pending" | "suspended"
): AuditDetail => ({
  version: 1,
  phase: "audit_written",
  originalStatus,
  suffixCount: 0,
  warnings: [],
  cancelledChildren: []
})

/**
 * Rewinds a run through the single public ownership CAS.
 *
 * Handler resolution, cache checks, and detached-child classification all
 * complete before compensation starts. The child-inclusive archive/truncate
 * is the final journal mutation and its commit becomes the recovery commit
 * point; a crash after that point is completed by `Recovery`.
 *
 * @since 0.1.0
 * @category constructors
 */
export const rewind = (
  options: Options
): Effect.Effect<
  Result,
  TimeTravelFailure,
  | CacheStore.CacheStore
  | EffectHandlerRegistry
  | Jj
  | Journal.Journal
  | RunStore.RunStore
  | TimeTravelStore
> =>
  Effect.fn("Rewind.rewind")(() =>
    Effect.gen(function*() {
      yield* Effect.annotateCurrentSpan({
        runId: options.runId,
        lineageId: options.frame.lineageId,
        seq: options.frame.seq
      })
      const runs = yield* RunStore.RunStore
      const journal = yield* Journal.Journal
      const store = yield* TimeTravelStore
      const nowMs = yield* Clock.currentTimeMillis
      const auditId = options.auditId ??
        `${options.runId}:rewind:${options.owner.nonce}:${nowMs}:${options.frame.seq}`

      let claimed: ClaimedRun | undefined
      let beat: Fiber.Fiber<never, never> | undefined
      let leaseReleased = false
      let archiveAttempted = false
      let archiveCommitted = false
      let compensation: Compensation.Result = { handlerReceipts: [] }
      let detail: AuditDetail | undefined
      const cancelledChildren: Array<string> = []
      const claimedChildren: Array<ClaimedChild> = []

      return yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function*() {
          const protocol = restore(
            Effect.gen(function*() {
              const claimedRun = yield* claimRun(runs, options, nowMs)
              claimed = claimedRun
              const originalStatus = claimedRun.row.status
              /**
               * THE LEASE IS HELD FOR THE WHOLE PROTOCOL.
               *
               * `claimRun` activates the run and stamps one heartbeat, and
               * nothing renewed it: a compensation handler, a jj restore, or a
               * large-suffix archive slower than `heartbeatStaleAfter` left the
               * row looking abandoned, and any engine sharing the database stole
               * it with `lease-expired` evidence and resumed the run against a
               * workspace this rewind had already restored. `heartbeatLoop`
               * pulses until the fence is lost and then interrupts itself, so
               * losing ownership is still observed rather than papered over.
               */
              const heartbeat = yield* Effect.forkChild(
                Ownership.heartbeatLoop(options.runId, options.owner),
                { startImmediately: true }
              )
              beat = heartbeat

              return yield* Effect.raceFirst(
                Effect.gen(function*() {
                  // The frame was validated before the claim, so another executor
                  // could have claimed the idle row, appended records, and released
                  // it in that window. Re-reading the tail under the claim is what
                  // binds the two together; a moved tail is `busy`, not a silent
                  // truncation of records validation would have refused.
                  if (options.expectedTail !== undefined) {
                    const unmoved = yield* tailUnmoved(journal, options.runId, options.expectedTail.tail)
                    if (!unmoved) {
                      return yield* Effect.fail(error("busy", `journal tail moved for ${options.runId}`))
                    }
                  }

                  const rateLimit = options.rateLimit?.({
                    runId: options.runId,
                    frame: options.frame,
                    nowMs
                  }) ?? Effect.succeed({ allowed: true } as const)
                  const decision = yield* rateLimit
                  const auditDetail = initialDetail(originalStatus)
                  const audit: Audit = {
                    id: auditId,
                    runId: options.runId,
                    frame: options.frame,
                    status: "in_progress",
                    rateLimit: "detail" in decision && decision.detail !== undefined
                      ? decision.detail
                      : { allowed: decision.allowed, checkedAtMs: nowMs },
                    detail: auditDetail
                  }
                  yield* store.writeAudit(audit)
                  detail = auditDetail

                  yield* StepHook.run("rewind", options.hooks?.beforeStep, "claim-run")
                  yield* StepHook.run("rewind", options.hooks?.beforeStep, "rate-limit")
                  if (!decision.allowed) {
                    return yield* Effect.fail(error("rate_limited", `rewind rate limit exceeded for ${options.runId}`))
                  }
                  yield* StepHook.run("rewind", options.hooks?.beforeStep, "write-audit")

                  const snapshot = yield* store.snapshotAt(options.runId, options.frame)
                  const descendants = yield* store.descendants(options.runId, options.frame)
                  const suffix = yield* readSuffix(
                    journal,
                    options.runId,
                    options.frame,
                    options.pageSize ?? 100,
                    options.maxEntries ?? HistoryLimit.defaultMaxHistoryEntries
                  )
                  const effects = yield* EffectBoundary.fromEntries(suffix.boundary)
                  yield* StepHook.run("rewind", options.hooks?.beforeStep, "load-suffix")

                  const childAssessment = yield* assessChildren(
                    runs,
                    descendants.attached,
                    descendants.detached,
                    options.detachedChildPolicy ?? "block"
                  )
                  const plannedChildren = [...childAssessment.cancellable].sort(
                    (left, right) => right.edge.parentSeq - left.edge.parentSeq
                  )
                  const pendingChildren = plannedChildren.map((child) => child.edge.childRunId)
                  const plan = yield* Compensation.assess(effects, snapshot?.changeId)
                  const blocking = plan.assessments.filter(
                    (assessment) => assessment.classification === "blocking"
                  )
                  if (blocking.length > 0) {
                    // The cause carries identity and verdict, never the effect's
                    // `input` or `output`. `TimeTravelError` is a `Schema.TaggedError`
                    // that ENCODES its cause, so a raw record put whatever the
                    // adapter was called with - credentials, oversized blobs - on the
                    // wire and in the logs. The full records stay on the audit
                    // detail, which is privileged storage.
                    return yield* Effect.fail(
                      error(
                        "irreversible",
                        `rewind is blocked by ${blocking.length} effect(s)`,
                        blocking.map(Compensation.blockingSummary)
                      )
                    )
                  }
                  detail = {
                    ...detail,
                    phase: "preflight_complete",
                    suffixCount: suffix.count,
                    ...(suffix.tailSeq === undefined ? {} : { suffixTailSeq: suffix.tailSeq }),
                    ...(snapshot === undefined ? {} : { targetChangeId: snapshot.changeId }),
                    warnings: childAssessment.warnings
                  }
                  yield* store.updateAudit(auditId, { detail })
                  yield* StepHook.run("rewind", options.hooks?.beforeStep, "assess-boundary")

                  const handlerReceipts = yield* Compensation.compensate(plan, (receipts) => {
                    const nextDetail: AuditDetail = {
                      ...detail!,
                      compensation: { handlerReceipts: receipts }
                    }
                    return store.updateAudit(auditId, { detail: nextDetail }).pipe(
                      Effect.tap(() => Effect.sync(() => (detail = nextDetail)))
                    )
                  }, options.compensationTimeout)
                  compensation = { handlerReceipts }
                  // The receipts reach durable storage BEFORE the next irreversible
                  // step. They used to land only after `restoreWorkspace`, so a
                  // process death between a handler succeeding and that write left
                  // the audit at `preflight_complete` with no compensation on it:
                  // recovery then skipped the rollback, restored the run, and the
                  // run later resumed against external state the handlers had
                  // already reversed.
                  detail = { ...detail, compensation }
                  yield* store.updateAudit(auditId, { detail })
                  yield* StepHook.run("rewind", options.hooks?.beforeStep, "compensate-effects")

                  // Preparation owns handler cleanup on failure. Once prepared,
                  // persist BOTH pointers before jj can change the workspace.
                  const prepared = yield* Effect.exit(
                    Compensation.prepareWorkspace(plan, handlerReceipts, options.compensationTimeout)
                  )
                  if (Exit.isFailure(prepared)) {
                    compensation = { handlerReceipts: [] }
                    return yield* Effect.failCause(prepared.cause)
                  }
                  compensation = prepared.value
                  detail = { ...detail, compensation }
                  yield* store.updateAudit(auditId, { detail })
                  const restored = yield* Effect.exit(
                    Compensation.restorePreparedWorkspace(compensation, options.compensationTimeout)
                  )
                  if (Exit.isFailure(restored)) {
                    compensation = { handlerReceipts: [] }
                    return yield* Effect.failCause(restored.cause)
                  }
                  yield* StepHook.run("rewind", options.hooks?.beforeStep, "restore-workspace")
                  detail = {
                    ...detail,
                    phase: "compensated",
                    compensation,
                    cancelledChildren: [...cancelledChildren],
                    pendingChildren
                  }
                  yield* store.updateAudit(auditId, { detail })

                  // Claims are reversible, unlike cancellation, so every child is
                  // owned before the commit and only transitioned terminal after
                  // it. The exact owners are also the archive transaction's child
                  // fences; any newly live or re-owned attached child refuses the
                  // whole mutation.
                  for (const child of plannedChildren) {
                    claimedChildren.push(yield* claimChild(runs, options, child))
                  }

                  yield* StepHook.run("rewind", options.hooks?.beforeStep, "archive-and-truncate")
                  archiveAttempted = true
                  // COMMIT can finish in an uninterruptible SQL finalizer. Keep
                  // its result and this flag in the same mask so cancellation
                  // cannot send a durably committed rewind through rollback.
                  const archive = yield* Effect.uninterruptible(
                    store.archiveAndTruncate(
                      options.runId,
                      options.frame,
                      Compensation.toStoreReceipts(auditId, compensation),
                      // The rewind claimed and activated the run with this owner;
                      // the store re-checks it at commit, so a superseded rewind
                      // never truncates behind the live owner.
                      options.owner,
                      new Map(claimedChildren.map((child) => [child.plan.edge.childRunId, child.owner]))
                    ).pipe(Effect.tap(() =>
                      Effect.sync(() => {
                        archiveCommitted = true
                      })
                    ))
                  )
                  // The cancellation plan was written with `compensated`, before
                  // the commit. This update records only that the archive landed.
                  detail = { ...detail, phase: "archive_committed", pendingChildren }
                  yield* store.updateAudit(auditId, { detail })

                  for (const child of claimedChildren) {
                    yield* cancelClaimedChild(runs, child)
                    cancelledChildren.push(child.plan.edge.childRunId)
                    detail = {
                      ...detail,
                      cancelledChildren: [...cancelledChildren],
                      pendingChildren: pendingChildren.filter((runId) => !cancelledChildren.includes(runId))
                    }
                    yield* store.updateAudit(auditId, { detail })
                  }

                  // The run suspends with the state AT the frame, not the state the
                  // truncated future left on the row. `createFork` already derives
                  // it this way for a child; a rewound parent that kept the later
                  // payload resumed from a future its journal no longer records.
                  const frameState = yield* store.stateAt(options.runId, options.frame)
                  // From here, losing the heartbeat is expected: this transition
                  // intentionally releases the ownership the supervisor watches.
                  leaseReleased = true
                  const suspended = yield* runs.transitionOwned(
                    options.runId,
                    options.owner,
                    "suspended",
                    frameState ?? claimedRun.row.stateJson
                  ).pipe(
                    Effect.mapError((cause) => RunRow.failure("suspend rewound run", cause))
                  )
                  if (suspended._tag !== "Transitioned") {
                    return yield* Effect.fail(
                      error("busy", `run ${options.runId} lost ownership before suspension`)
                    )
                  }

                  detail = { ...detail, phase: "completed" }
                  yield* store.updateAudit(auditId, {
                    status: "completed",
                    detail
                  })
                  return {
                    auditId,
                    frame: options.frame,
                    archive,
                    assessments: plan.assessments,
                    warnings: childAssessment.warnings,
                    cancelledChildren: [...cancelledChildren]
                  }
                }),
                Fiber.await(heartbeat).pipe(
                  Effect.flatMap(() =>
                    leaseReleased
                      ? Effect.never
                      : Effect.fail(error("fence_lost", `run ${options.runId} lost its ownership lease`))
                  )
                )
              )
            })
          )

          const protocolExit = yield* Effect.exit(protocol)
          if (Exit.isSuccess(protocolExit)) return protocolExit.value
          const failure = fromCause(protocolExit.cause)

          if (
            !archiveCommitted &&
            (archiveAttempted || Cause.hasInterruptsOnly(protocolExit.cause)) &&
            detail?.suffixTailSeq !== undefined
          ) {
            // Publication after COMMIT can fail before the call returns. As in
            // Recovery, require both an empty live suffix and its archived tail.
            // An unreadable store leaves the audit open without risking rollback.
            const tailSeq = detail.suffixTailSeq
            const commitExit = yield* journal.entries({
              runId: options.runId as JournalEvent.RunId,
              after: options.frame.seq as JournalEvent.Seq,
              limit: 1
            }).pipe(
              Effect.flatMap((page) =>
                page.entries.length > 0
                  ? Effect.succeed(false)
                  : store.archivedAt(options.runId, tailSeq)
              ),
              Effect.exit
            )
            if (Exit.isFailure(commitExit)) {
              return yield* Effect.failCause(protocolExit.cause)
            }
            archiveCommitted = commitExit.value
          }
          if (archiveCommitted && detail !== undefined) {
            // An interrupt can precede the protocol's audit update even when
            // the local flag is set. Keep this audit recoverable after commit.
            detail = { ...detail, phase: "archive_committed", failure: failure.message }
            yield* Effect.ignore(store.updateAudit(auditId, { detail }))
          }

          if (!archiveCommitted) {
            const rollbackExit = yield* Effect.exit(Compensation.rollback(compensation, options.compensationTimeout))
            if (Exit.isSuccess(rollbackExit) && detail?.compensation !== undefined) {
              const { compensation: _, ...stripped } = detail
              detail = stripped
              // Handler rollback is not required to be idempotent. Record its
              // success before run-state restoration can fail, otherwise a
              // later recovery pass repeats the same external side effects.
              yield* store.updateAudit(auditId, { detail })
            }
            /**
             * THE RESTORATION HAS TO SUCCEED BEFORE THE AUDIT IS CLOSED.
             *
             * The exit used to be consulted only when there was no audit row, so
             * a failed restoration still stamped `rolled_back` and left the run
             * `running` under a dead rewind identity. Recovery only drains
             * `in_progress` audits, so that run was stranded with no record any
             * pass would revisit. A restoration that did not return
             * `Transitioned` keeps the audit open instead, and says so.
             */
            const restorationProblems: Array<string> = []
            for (const child of claimedChildren) {
              const childRunId = child.plan.edge.childRunId
              const restoredChild = yield* runs.transitionOwned(
                childRunId,
                child.owner,
                // `transitionOwned` cannot target `pending`, while targeting
                // `running` deliberately retains the current owner. Suspended
                // is therefore the only reversible status that clears the
                // dead rewind identity: it exactly restores suspended children
                // and safely parks children claimed from pending or running.
                "suspended",
                child.plan.row.stateJson
              ).pipe(
                Effect.mapError((cause) => RunRow.failure(`restore child ${childRunId}`, cause)),
                Effect.exit
              )
              if (Exit.isFailure(restoredChild)) {
                restorationProblems.push(fromCause(restoredChild.cause).message)
              } else if (restoredChild.value._tag !== "Transitioned") {
                restorationProblems.push(`restore child ${childRunId} returned ${restoredChild.value._tag}`)
              }
            }
            if (claimed !== undefined) {
              const restored = yield* runs.transitionOwned(
                options.runId,
                options.owner,
                // Pending is not a transition target; suspended clears the
                // rewind owner while preserving the run's resumable state.
                claimed.row.status === "pending" ? "suspended" : claimed.row.status,
                claimed.row.stateJson
              ).pipe(
                Effect.mapError((cause) => RunRow.failure("restore run state", cause)),
                Effect.exit
              )
              if (Exit.isFailure(restored)) {
                restorationProblems.push(fromCause(restored.cause).message)
                if (detail === undefined) {
                  yield* Effect.ignore(runs.abandonClaim(options.runId, options.owner, claimed.claimedAtMs))
                }
              } else if (restored.value._tag !== "Transitioned") {
                restorationProblems.push(`restore run state returned ${restored.value._tag}`)
              }
            }
            const restorationProblem = restorationProblems.length === 0
              ? undefined
              : restorationProblems.join("; ")
            if (detail !== undefined && restorationProblem !== undefined) {
              return yield* Effect.fail(
                error(
                  failure.code,
                  `${failure.message}; ${restorationProblem}`,
                  { rewind: protocolExit.cause, restoration: restorationProblem }
                )
              )
            }
            if (detail !== undefined) {
              const currentDetail = detail
              const rollbackFailure = Exit.isFailure(rollbackExit) ? Cause.squash(rollbackExit.cause) : undefined
              const failureMessage = rollbackFailure === undefined
                ? failure.message
                : `${failure.message}; rollback failed: ${String(rollbackFailure)}`
              // A rollback that SUCCEEDED already stripped `compensation` above,
              // before the restoration that can fail. A rollback that FAILED
              // leaves those receipts applied, so they stay on the detail. This
              // audit closes terminal, recovery only drains `in_progress` rows,
              // and the only writer of the receipt table, `archiveAndTruncate`,
              // never ran on this path. Stripping them here deleted the sole
              // durable record of which compensations still stand and which
              // pre-rewind change id to restore, so a later rewind at the same
              // frame compensated the same effect a second time.
              detail = {
                ...currentDetail,
                phase: rollbackFailure === undefined ? "rolled_back" : "terminal_failure",
                cancelledChildren: [...cancelledChildren],
                failure: failureMessage,
                ...(rollbackFailure === undefined ? {} : { rollbackFailure: String(rollbackFailure) })
              }
              yield* Effect.ignore(
                store.updateAudit(auditId, {
                  status: "failed",
                  detail
                })
              )
              if (Exit.isFailure(rollbackExit)) {
                return yield* Effect.fail(
                  error("compensation_failed", failureMessage, {
                    rewind: protocolExit.cause,
                    rollback: rollbackExit.cause
                  })
                )
              }
            }
          }

          // The protocol runs under `restore(...)` inside an uninterruptible
          // mask, so an interrupt lands as an interrupt-only cause on
          // `protocolExit` and the rollback above still runs to completion.
          // Squashing that cause through `fromCause` produced
          // `TimeTravelError{code:"unknown"}`, so a cancelled rewind reported
          // as a *failed* rewind: a caller racing `rewind` against a
          // supervisor observed a failure and kept running on the fiber it
          // believed it had cancelled. Cancellation is fiber interruption
          // (`CLAUDE.md`), so the cause is re-raised verbatim and an interrupt
          // stays an interrupt. A cause carrying any `Fail` or `Die` reason
          // still reports as the typed failure the callers match on.
          if (Cause.hasInterruptsOnly(protocolExit.cause)) {
            return yield* Effect.failCause(protocolExit.cause)
          }
          return yield* Effect.fail(failure)
        }).pipe(
          // The lease outlives the protocol on purpose: the failure branch's
          // restoration is itself an owned transition, so the heartbeat stops
          // only once every ownership write this rewind performs has landed.
          Effect.ensuring(
            Effect.suspend(() => beat === undefined ? Effect.void : Fiber.interrupt(beat))
          )
        )
      )
    })
  )()

/**
 * Tier-aware rewind preflight, compensation, and rollback.
 *
 * @since 0.1.0
 */

import { Jj, jjError } from "@smthrs/jj"
import * as Redaction from "@smthrs/journal/Redaction"
import * as CacheStore from "@smthrs/step-cache/CacheStore"
import * as Cause from "effect/Cause"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { EffectRecord } from "../EffectBoundary.ts"
import { error, fromCause, type TimeTravelError } from "../TimeTravelError.ts"
import type { Receipt } from "../TimeTravelStore.ts"
import { Assessment as HandlerAssessment, EffectHandlerRegistry, RollbackReceipt } from "./EffectHandlerRegistry.ts"

/**
 * One complete preflight decision for a crossed effect.
 *
 * @since 0.1.0
 * @category models
 */
export const Assessment = Schema.Struct({ ...HandlerAssessment.fields, effect: EffectRecord })
/**
 * The value form of {@link Assessment}.
 *
 * @since 0.1.0
 * @category models
 */
export type Assessment = typeof Assessment.Type

/**
 * Identity and verdict for an encoded refusal, without effect input or output.
 *
 * @since 0.1.0
 * @category constructors
 */
export const blockingSummary = (assessment: Assessment) => ({
  id: assessment.effect.id,
  kind: assessment.effect.kind,
  tier: assessment.effect.tier,
  seq: assessment.effect.seq,
  classification: assessment.classification,
  reason: assessment.reason
})

/**
 * Immutable compensation plan. All cache reads and handler resolution have
 * completed before this value is produced.
 *
 * @since 0.1.0
 * @category models
 */
export const Plan = Schema.Struct({
  effects: Schema.Array(EffectRecord),
  assessments: Schema.Array(Assessment),
  targetChangeId: Schema.optionalKey(Schema.NonEmptyString),
  /** Present for a whole-repository restore: the jj operation to restore. */
  targetOperationId: Schema.optionalKey(Schema.NonEmptyString)
})
/**
 * The value form of {@link Plan}.
 *
 * @since 0.1.0
 * @category models
 */
export type Plan = typeof Plan.Type

/**
 * Receipt for restoring the workspace to the target frame.
 *
 * @since 0.1.0
 * @category models
 */
export const WorkspaceReceipt = Schema.Struct({
  currentChangeId: Schema.NonEmptyString,
  targetChangeId: Schema.NonEmptyString,
  /**
   * Both operations are present for a whole-repository restore, and both
   * absent for a tree restore: the receipt is undone the way it was applied.
   */
  currentOperationId: Schema.optionalKey(Schema.NonEmptyString),
  targetOperationId: Schema.optionalKey(Schema.NonEmptyString)
})
/**
 * The value form of {@link WorkspaceReceipt}.
 *
 * @since 0.1.0
 * @category models
 */
export type WorkspaceReceipt = typeof WorkspaceReceipt.Type

/**
 * All reversible mutations performed before journal truncation.
 *
 * @since 0.1.0
 * @category models
 */
export const Result = Schema.Struct({
  handlerReceipts: Schema.Array(RollbackReceipt),
  workspace: Schema.optionalKey(WorkspaceReceipt)
})
/**
 * The value form of {@link Result}.
 *
 * @since 0.1.0
 * @category models
 */
export type Result = typeof Result.Type

/**
 * Deadline for each external compensation operation.
 *
 * @since 0.1.0
 * @category constants
 */
export const defaultTimeout = Duration.minutes(3)

const AppliedCause = Schema.Struct({ applied: Result })
const isAppliedCause = Schema.is(AppliedCause)

/**
 * What a failed compensation operation left applied to the outside world.
 *
 * Every operation here undoes its own work when it fails. When that cleanup
 * fails too, the error's `cause` carries the receipts it could not undo as
 * `applied`, and this reads them back. `undefined` means the failure left
 * nothing applied. The caller keeps these receipts instead of recording a
 * rollback, and never rolls them back a second time.
 *
 * @since 0.1.0
 * @category compensation
 */
export const applied = (failure: TimeTravelError): Result | undefined =>
  isAppliedCause(failure.cause) ? failure.cause.applied : undefined

// What stays applied after a cleanup: the handler receipts its rollback could
// not undo (all of them when the failure does not say which), and the
// workspace receipt when the workspace could not be put back.
const remaining = (
  handlerExit: Exit.Exit<void, TimeTravelError>,
  handlerReceipts: ReadonlyArray<RollbackReceipt>,
  workspace?: WorkspaceReceipt | undefined
): { readonly applied: Result } | undefined => {
  const handlers = Exit.isFailure(handlerExit)
    ? applied(fromCause(handlerExit.cause))?.handlerReceipts ?? handlerReceipts
    : []
  return handlers.length === 0 && workspace === undefined
    ? undefined
    : { applied: { handlerReceipts: handlers, ...(workspace === undefined ? {} : { workspace }) } }
}

// The protocol stays masked, but the timeout must be able to interrupt its
// external worker. Otherwise timeout waits forever for the losing fiber.
const bounded = <A, E, R>(work: Effect.Effect<A, E, R>, timeout: Duration.Input) =>
  Effect.interruptible(work).pipe(Effect.timeout(timeout))

/**
 * Puts the repository back to one side of a workspace receipt: the whole
 * repository to its operation when one is named, otherwise the working-copy
 * tree to its commit.
 */
const restorePoint = (jj: Jj, changeId: string, operationId: string | undefined) =>
  operationId === undefined
    ? jj.restore(changeId)
    : jj.opRestore === undefined
    ? Effect.fail(jjError({
      code: "not_installed",
      method: "opRestore",
      description: "this jj host cannot restore an operation"
    }))
    : jj.opRestore(operationId)

const sealedAssessment = (
  effect: EffectRecord,
  classification: "warning" | "blocking",
  reason: string
): Assessment => ({
  effect,
  classification,
  reason,
  residue: effect.residue ?? "The sealed result cannot be re-derived without its recorded cache entry."
})

const compensableAssessment = (
  effect: EffectRecord,
  targetChangeId: string | undefined,
  whole: WholeRepo
): Assessment =>
  targetChangeId === undefined
    ? {
      effect,
      classification: "blocking",
      reason: "The target frame has no recorded jj snapshot pointer.",
      residue: "Workspace mutations cannot be restored to the selected frame."
    }
    : whole.wholeRepo && whole.targetOperationId === undefined
    ? {
      effect,
      classification: "blocking",
      reason: "The target frame has no recorded jj operation.",
      residue: "Repository changes cannot be restored to the selected frame."
    }
    : whole.wholeRepo
    ? {
      effect,
      classification: "revertible",
      reason: `The repository will be restored to jj operation ${whole.targetOperationId}.`,
      residue: "Repository state after the target frame stays reachable only through `jj op log`."
    }
    : {
      effect,
      classification: "revertible",
      reason: `The workspace will be restored to jj change ${targetChangeId}.`,
      residue: "Workspace state after the target frame stays reachable only through `jj evolog` and `jj op log`."
    }

/**
 * Whether a rewind restores the whole repository, and the operation it would
 * restore.
 *
 * @since 1.0.0
 * @category models
 */
export interface WholeRepo {
  readonly wholeRepo: boolean
  readonly targetOperationId?: string | undefined
}

/**
 * Resolves every crossed effect before any compensation or workspace mutation.
 *
 * Sealed entries must be present in `CacheStore`; this preflight never invokes
 * their producer. Compensable entries require the target frame's jj pointer.
 * Irreversible entries delegate to the immutable handler registry.
 *
 * @since 0.1.0
 * @category constructors
 */
export const assess = (
  effects: ReadonlyArray<EffectRecord>,
  targetChangeId?: string | undefined,
  whole: WholeRepo = { wholeRepo: false }
): Effect.Effect<
  Plan,
  TimeTravelError,
  CacheStore.CacheStore | EffectHandlerRegistry
> =>
  Effect.gen(function*() {
    const cache = yield* CacheStore.CacheStore
    const registry = yield* EffectHandlerRegistry
    const assessments: Array<Assessment> = []
    const ordered = [...effects].sort((left, right) => left.seq - right.seq)

    for (const effect of ordered) {
      if (effect.tier === "sealed") {
        if (effect.cacheKey === undefined) {
          assessments.push(
            sealedAssessment(effect, "blocking", "The sealed effect has no content-addressed cache key.")
          )
          continue
        }
        const cached = yield* cache.get(effect.cacheKey).pipe(
          Effect.mapError((cause) => error("unknown", `could not consult sealed result ${effect.cacheKey}`, cause))
        )
        assessments.push(
          Option.isSome(cached)
            ? sealedAssessment(effect, "warning", "The sealed result is present and replay remains a cache hit.")
            : sealedAssessment(effect, "blocking", `Sealed cache entry ${effect.cacheKey} is missing.`)
        )
        continue
      }

      if (effect.tier === "compensable") {
        assessments.push(compensableAssessment(effect, targetChangeId, whole))
        continue
      }

      const handlerAssessment = yield* registry.assess(effect)
      assessments.push({ effect, ...handlerAssessment })
    }

    return {
      effects: ordered,
      assessments,
      ...(targetChangeId === undefined ? {} : { targetChangeId }),
      ...(whole.wholeRepo && whole.targetOperationId !== undefined
        ? { targetOperationId: whole.targetOperationId }
        : {})
    }
  })

const causeMessage = (cause: Cause.Cause<unknown>): string => {
  const squashed = Cause.squash(cause)
  return squashed instanceof Error ? squashed.message : String(squashed)
}

const rollbackHandlers = (
  registry: EffectHandlerRegistry["Service"],
  receipts: ReadonlyArray<RollbackReceipt>,
  timeout: Duration.Input
): Effect.Effect<void, TimeTravelError> =>
  Effect.gen(function*() {
    const failures: Array<TimeTravelError> = []
    const stillApplied = new Set<RollbackReceipt>()
    for (const receipt of [...receipts].reverse()) {
      const rollbackExit = yield* Effect.exit(bounded(registry.rollback(receipt), timeout))
      if (Exit.isFailure(rollbackExit)) {
        stillApplied.add(receipt)
        failures.push(
          error(
            "compensation_failed",
            `could not roll back compensation for ${receipt.effect.id}: ${causeMessage(rollbackExit.cause)}`,
            rollbackExit.cause
          )
        )
      }
    }
    if (failures.length > 0) {
      return yield* Effect.fail(
        error("compensation_failed", `${failures.length} compensation rollback operation(s) failed`, {
          failures,
          applied: { handlerReceipts: receipts.filter((receipt) => stillApplied.has(receipt)) }
        })
      )
    }
  })

const assertExecutable = (plan: Plan): Effect.Effect<void, TimeTravelError> => {
  const blocking = plan.assessments.filter((assessment) => assessment.classification === "blocking")
  return blocking.length === 0
    ? Effect.void
    : Effect.fail(
      error(
        "irreversible",
        `rewind is blocked by ${blocking.length} crossed effect(s)`,
        blocking.map(blockingSummary)
      )
    )
}

/**
 * Refuses a receipt whose handler data the journal's redaction net would
 * rewrite. A receipt is persisted verbatim so `rollback` gets it back byte for
 * byte, which means a credential in it would sit in `flows_time_travel_receipts`
 * and the audit detail in clear. The value itself never reaches the error.
 */
const refuseCredential = (receipt: RollbackReceipt): Effect.Effect<void, TimeTravelError> =>
  // Data that is not JSON fails as a typed error where the store encodes it.
  Effect.try(() => JSON.stringify(receipt.data ?? null)).pipe(
    Effect.orElseSucceed(() => undefined),
    Effect.flatMap((encoded) =>
      encoded === undefined || Redaction.redactJsonString(encoded, Redaction.make()) === encoded
        ? Effect.void
        : Effect.fail(
          error(
            "compensation_failed",
            `receipt for ${receipt.effect.id} carries a credential-shaped value; ` +
              "return a secret reference or an identifier instead"
          )
        )
    )
  )

/**
 * Runs resolved tier-3 handlers in reverse journal order.
 *
 * A handler failure rolls back every earlier handler receipt before the typed
 * failure escapes. When `onReceipts` is supplied, it runs after each successful
 * revert and before the next handler starts; a callback failure rolls back all
 * receipts collected so far. A receipt is therefore considered durable only
 * after its callback has succeeded. A receipt whose data the journal's
 * redaction net would rewrite is refused the same way, before its callback.
 *
 * @since 0.1.0
 * @category compensation
 */
export const compensate = (
  plan: Plan,
  onReceipts?: (
    receipts: ReadonlyArray<RollbackReceipt>
  ) => Effect.Effect<void, TimeTravelError>,
  timeout: Duration.Input = defaultTimeout
): Effect.Effect<
  ReadonlyArray<RollbackReceipt>,
  TimeTravelError,
  EffectHandlerRegistry
> =>
  Effect.gen(function*() {
    yield* assertExecutable(plan)
    const registry = yield* EffectHandlerRegistry
    return yield* Effect.uninterruptible(
      Effect.gen(function*() {
        const receipts: Array<RollbackReceipt> = []
        const effects = plan.assessments
          .filter(
            (assessment) =>
              assessment.effect.tier === "irreversible" &&
              assessment.classification === "revertible"
          )
          .map((assessment) => assessment.effect)
          .sort((left, right) => right.seq - left.seq)

        for (const effect of effects) {
          const revertExit = yield* Effect.exit(bounded(registry.revert(effect), timeout))
          if (Exit.isFailure(revertExit)) {
            const rollbackExit = yield* Effect.exit(rollbackHandlers(registry, receipts, timeout))
            return yield* Effect.fail(
              error(
                "compensation_failed",
                `could not compensate ${effect.id}: ${causeMessage(revertExit.cause)}`,
                {
                  compensation: revertExit.cause,
                  rollback: Exit.isFailure(rollbackExit) ? rollbackExit.cause : undefined,
                  ...remaining(rollbackExit, receipts)
                }
              )
            )
          }
          receipts.push(revertExit.value)
          const durableExit = yield* Effect.exit(
            refuseCredential(revertExit.value).pipe(
              Effect.andThen(onReceipts === undefined ? Effect.void : onReceipts([...receipts]))
            )
          )
          if (Exit.isFailure(durableExit)) {
            const rollbackExit = yield* Effect.exit(rollbackHandlers(registry, receipts, timeout))
            return yield* Effect.fail(
              error(
                "compensation_failed",
                `could not persist compensation receipt for ${effect.id}: ${causeMessage(durableExit.cause)}`,
                {
                  compensation: durableExit.cause,
                  rollback: Exit.isFailure(rollbackExit) ? rollbackExit.cause : undefined,
                  ...remaining(rollbackExit, receipts)
                }
              )
            )
          }
        }
        return receipts
      })
    )
  })

/**
 * Snapshots the current jj state and prepares both workspace pointers after
 * tier-3 compensation, without restoring the target.
 *
 * The caller hands ownership of `handlerReceipts` over with the call: EVERY
 * failure path here rolls them back before the failure escapes, so the caller
 * must not roll them back again. Nothing requires a handler's `rollback` to be
 * idempotent, so a second pass would re-perform the side effect the revert
 * undid. The two refusals that never touch jj — a plan that is not executable,
 * and a plan that needs a restore with no pointer resolved — are covered by
 * that rule too, so it is one invariant rather than a list of exceptions the
 * caller has to track.
 *
 * @since 0.1.0
 * @category compensation
 */
export const prepareWorkspace = (
  plan: Plan,
  handlerReceipts: ReadonlyArray<RollbackReceipt>,
  timeout: Duration.Input = defaultTimeout
): Effect.Effect<Result, TimeTravelError, EffectHandlerRegistry | Jj> =>
  Effect.gen(function*() {
    const registry = yield* EffectHandlerRegistry
    // On these two paths the refusal keeps its code and message: both mean
    // the plan itself was malformed before any jj work started, and that is
    // what the caller has to be told about. A cleanup failure is logged and
    // its receipts still applied ride along as `applied`.
    const cleanUp = (refusal: TimeTravelError) =>
      Effect.exit(rollbackHandlers(registry, handlerReceipts, timeout)).pipe(
        Effect.tap((cleanup) =>
          Exit.isFailure(cleanup)
            ? Effect.logError("time-travel: rollback after a refused restore failed", cleanup.cause)
            : Effect.void
        ),
        Effect.flatMap((cleanup) => {
          const left = remaining(cleanup, handlerReceipts)
          return Effect.fail(
            left === undefined ? refusal : error(refusal.code, refusal.message, { refusal: refusal.cause, ...left })
          )
        })
      )
    yield* assertExecutable(plan).pipe(Effect.catch(cleanUp))
    const jj = yield* Jj
    // A whole-repository rewind restores even without a compensable effect:
    // a bookmark move or rebase need not have come from a compensable step.
    const needsRestore = plan.targetOperationId !== undefined ||
      plan.effects.some((effect) => effect.tier === "compensable")
    if (!needsRestore) return { handlerReceipts }
    if (plan.targetChangeId === undefined) {
      return yield* cleanUp(error("compensation_failed", "target jj pointer was not resolved during preflight"))
    }

    return yield* Effect.uninterruptible(
      Effect.gen(function*() {
        const currentExit = yield* Effect.exit(bounded(jj.snapshot("flows rewind pre-restore"), timeout))
        if (Exit.isFailure(currentExit)) {
          const handlerRollback = yield* Effect.exit(rollbackHandlers(registry, handlerReceipts, timeout))
          return yield* Effect.fail(
            error(
              "compensation_failed",
              `could not snapshot current jj state: ${causeMessage(currentExit.cause)}`,
              Exit.isFailure(handlerRollback)
                ? {
                  snapshot: currentExit.cause,
                  handlerRollback: handlerRollback.cause,
                  ...remaining(handlerRollback, handlerReceipts)
                }
                : currentExit.cause
            )
          )
        }

        const currentOperationId = currentExit.value.operationId
        if (plan.targetOperationId !== undefined && currentOperationId === undefined) {
          const handlerRollback = yield* Effect.exit(rollbackHandlers(registry, handlerReceipts, timeout))
          return yield* Effect.fail(
            error(
              "compensation_failed",
              "could not read the current jj operation to restore the whole repository",
              Exit.isFailure(handlerRollback)
                ? { handlerRollback: handlerRollback.cause, ...remaining(handlerRollback, handlerReceipts) }
                : undefined
            )
          )
        }
        const workspace: WorkspaceReceipt = {
          currentChangeId: currentExit.value.commitId,
          targetChangeId: plan.targetChangeId!,
          ...(plan.targetOperationId === undefined
            ? {}
            : { currentOperationId: currentOperationId!, targetOperationId: plan.targetOperationId })
        }
        return { handlerReceipts, workspace }
      })
    )
  })

/**
 * Restores a prepared workspace. The caller must durably record the result
 * before this call. On failure this operation owns cleanup of its receipts.
 *
 * @since 0.1.0
 * @category compensation
 */
export const restorePreparedWorkspace = (
  result: Result,
  timeout: Duration.Input = defaultTimeout
): Effect.Effect<Result, TimeTravelError, EffectHandlerRegistry | Jj> =>
  Effect.uninterruptible(Effect.gen(function*() {
    const { handlerReceipts, workspace } = result
    if (workspace === undefined) return result
    const jj = yield* Jj
    const registry = yield* EffectHandlerRegistry
    const restoreExit = yield* Effect.exit(
      bounded(restorePoint(jj, workspace.targetChangeId, workspace.targetOperationId), timeout)
    )
    if (Exit.isFailure(restoreExit)) {
      const workspaceRollback = yield* Effect.exit(
        bounded(restorePoint(jj, workspace.currentChangeId, workspace.currentOperationId), timeout)
      )
      const handlerRollback = yield* Effect.exit(rollbackHandlers(registry, handlerReceipts, timeout))
      return yield* Effect.fail(
        error(
          "compensation_failed",
          `could not restore jj state ${workspace.targetOperationId ?? workspace.targetChangeId}: ${
            causeMessage(restoreExit.cause)
          }`,
          {
            restore: restoreExit.cause,
            workspaceRollback: Exit.isFailure(workspaceRollback) ? workspaceRollback.cause : undefined,
            handlerRollback: Exit.isFailure(handlerRollback) ? handlerRollback.cause : undefined,
            ...remaining(handlerRollback, handlerReceipts, Exit.isFailure(workspaceRollback) ? workspace : undefined)
          }
        )
      )
    }
    return result
  }))

/**
 * Reverses every mutation represented by a compensation result.
 *
 * Workspace restoration is undone first, followed by handler receipts in the
 * reverse of their execution order.
 *
 * @since 0.1.0
 * @category compensation
 */
export const rollback = (
  result: Result,
  timeout: Duration.Input = defaultTimeout
): Effect.Effect<void, TimeTravelError, EffectHandlerRegistry | Jj> =>
  Effect.gen(function*() {
    const registry = yield* EffectHandlerRegistry
    const jj = yield* Jj
    return yield* Effect.uninterruptible(
      Effect.gen(function*() {
        const failures: Array<unknown> = []
        let workspaceApplied: WorkspaceReceipt | undefined
        if (result.workspace !== undefined) {
          const workspaceExit = yield* Effect.exit(
            bounded(
              restorePoint(jj, result.workspace.currentChangeId, result.workspace.currentOperationId),
              timeout
            )
          )
          if (Exit.isFailure(workspaceExit)) {
            failures.push(workspaceExit.cause)
            workspaceApplied = result.workspace
          }
        }
        const handlerExit = yield* Effect.exit(rollbackHandlers(registry, result.handlerReceipts, timeout))
        if (Exit.isFailure(handlerExit)) failures.push(handlerExit.cause)
        if (failures.length > 0) {
          return yield* Effect.fail(
            error("compensation_failed", `${failures.length} rewind rollback operation(s) failed`, {
              failures,
              ...remaining(handlerExit, result.handlerReceipts, workspaceApplied)
            })
          )
        }
      })
    )
  })

/**
 * Converts handler receipts to the public store shape for atomic archival.
 *
 * @since 0.1.0
 * @category conversions
 */
export const toStoreReceipts = (
  auditId: string,
  result: Result
): ReadonlyArray<Receipt> =>
  result.handlerReceipts.map((receipt) => ({
    id: `${auditId}:${receipt.id}`,
    auditId,
    effectId: receipt.effect.id,
    receipt
  }))

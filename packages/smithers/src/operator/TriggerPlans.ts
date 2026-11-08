/**
 * Durable trigger launch handles that retain the exact plan awaiting approval.
 *
 * @since 1.0.0
 */

import { canonicalize } from "@smthrs/canonical"
import * as Control from "@smthrs/control/Control"
import { ApprovalPayload, PlanCard, Principal } from "@smthrs/control/ControlSchema"
import { Sha256 } from "@smthrs/crypto"
import { DurableWriter } from "@smthrs/database"
import * as NodeDatabase from "@smthrs/database/node/NodeDatabase"
import * as Scheduler from "@smthrs/triggers/Scheduler"
import { TriggerError } from "@smthrs/triggers/TriggerError"
import { Clock, Effect, Layer, Schema } from "effect"
import * as SqlClient from "effect/sql/SqlClient"
import { join } from "node:path"
import { triggerDeclaration } from "../internal/ApprovalScope.ts"
import { databaseLayer } from "./Store.ts"

const prefix = "trigger-plan:"
const states = Schema.Literals([
  "waiting-approval",
  "launching",
  "running",
  "cancelling",
  "completed",
  "cancelled",
  "failed"
])
const stored = Schema.Struct({
  handle: Schema.String,
  idempotencyKey: Schema.String,
  plan: PlanCard,
  status: states,
  runId: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String)
})

/**
 * The original approval card and eventual Control run behind a scheduler handle.
 * @category models
 * @since 1.0.0
 */
export type StoredPlan = typeof stored.Type

interface Row {
  readonly handle: string
  readonly idempotency_key: string
  readonly plan_json: string
  readonly status: StoredPlan["status"]
  readonly run_id: string | null
  readonly error: string | null
}

const failure = (message: string, cause?: unknown) => new TriggerError({ code: "runner", message, cause })
const translated = <A, E, R>(operation: string, effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.mapError((cause) => cause instanceof TriggerError ? cause : failure(operation, cause)))

const makeStore = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  const writer = yield* DurableWriter.DurableWriter
  yield* translated(
    "Could not initialize durable trigger plans",
    writer.write(sql`
      CREATE TABLE IF NOT EXISTS control_trigger_plans (
        handle TEXT PRIMARY KEY,
        idempotency_key TEXT NOT NULL UNIQUE,
        plan_json TEXT NOT NULL,
        status TEXT NOT NULL,
        run_id TEXT,
        error TEXT
      )
    `)
  )
  const read = (handle: string) =>
    translated(
      "Could not read the durable trigger plan",
      sql<Row>`SELECT * FROM control_trigger_plans WHERE handle = ${handle}`.pipe(
        Effect.flatMap((rows) => {
          const row = rows[0]
          if (row === undefined) return Effect.succeed(null)
          return Effect.try(() => JSON.parse(row.plan_json) as unknown).pipe(
            Effect.flatMap((plan) =>
              Schema.decodeUnknownEffect(stored)({
                handle: row.handle,
                idempotencyKey: row.idempotency_key,
                plan,
                status: row.status,
                runId: row.run_id,
                error: row.error
              })
            )
          )
        })
      )
    )
  const write = <A, E>(effect: Effect.Effect<A, E>) =>
    translated("Could not update the durable trigger plan", writer.write(effect))
  return { sql, read, write }
})

/**
 * Reads the unchanged approval payload and launch state for a scheduler handle.
 * @category queries
 * @since 1.0.0
 */
export const inspect = (root: string, handle: string): Promise<StoredPlan | null> =>
  handle.startsWith(prefix)
    ? Effect.runPromise(
      makeStore.pipe(Effect.flatMap((store) => store.read(handle)), Effect.provide(databaseLayer(root)))
    )
    : Promise.resolve(null)

/** Reviewable consent to one exact registration and executable plan.
 * @category schemas
 * @since 1.0.0
 */
export const StandingApproval = Schema.Struct({
  triggerId: Schema.NonEmptyString,
  declarationDigest: Schema.NonEmptyString,
  plan: PlanCard
})

/** Prepare the exact standing consent payload; does not approve anything.
 * @category queries
 * @since 1.0.0
 */
export const previewApproval = (root: string, triggerId: string) =>
  Effect.gen(function*() {
    const control = yield* Control.Control
    const current = yield* triggerDeclaration(triggerId)
    if (current?.trigger.enabled !== true) return yield* failure("Unknown or disabled trigger")
    const plan = yield* control.plan({ flowId: current.trigger.flowId, input: current.trigger.input })
    return { triggerId, declarationDigest: current.digest, plan }
  }).pipe(Effect.provide(databaseLayer(root)))

/** Install operator consent only after Control validates the exact approval.
 * Reusing the same consent is idempotent and never resurrects a revoked grant.
 * @category commands
 * @since 1.0.0
 */
export const grantApproval = (root: string, submitted: typeof StandingApproval.Type) =>
  Effect.gen(function*() {
    const consent = yield* Schema.decodeUnknownEffect(StandingApproval)(submitted)
    const control = yield* Control.Control
    const { sql, write } = yield* makeStore
    const current = yield* previewApproval(root, consent.triggerId)
    if (
      current.declarationDigest !== consent.declarationDigest || current.plan.digest !== consent.plan.digest ||
      canonicalize(current.plan.envelope) !== canonicalize(consent.plan.envelope) ||
      consent.plan.approval.target._tag !== "Plan" || consent.plan.approval.target.planId !== consent.plan.planId ||
      consent.plan.approval.target.digest !== consent.plan.digest
    ) return yield* failure("Standing approval no longer matches the registered trigger and plan")
    const grantId = Sha256.digestSync(
      canonicalize([consent.triggerId, consent.declarationDigest, consent.plan.digest, consent.plan.planId])
    )
    const approval = {
      ...consent.plan.approval,
      scope: "remembered" as const,
      idempotencyKey: `trigger-grant:${grantId}`
    }
    yield* control.approve(approval)
    yield* write(Effect.gen(function*() {
      const latest = yield* triggerDeclaration(consent.triggerId).pipe(Effect.provideService(SqlClient.SqlClient, sql))
      if (latest?.digest !== consent.declarationDigest) return yield* failure("Trigger changed while granting approval")
      const rows = yield* sql<{ principal: string }>`SELECT decision_principal_json AS principal FROM control_tokens
      WHERE target_tag = 'Plan' AND run_id = '' AND target_id = ${consent.plan.planId} AND resolved = 1`
      if (rows[0] === undefined) return yield* failure("Control did not record the granting principal")
      const principal = yield* Schema.decodeUnknownEffect(Principal)(
        yield* Effect.try(() => JSON.parse(rows[0]!.principal))
      )
      yield* sql`INSERT INTO control_trigger_approvals
      (grant_id, trigger_id, declaration_digest, plan_digest, approval_json, principal_json, granted_at_ms)
      VALUES (${grantId}, ${consent.triggerId}, ${consent.declarationDigest}, ${consent.plan.digest},
        ${JSON.stringify(approval)}, ${JSON.stringify(principal)}, ${yield* Clock.currentTimeMillis})
      ON CONFLICT (grant_id) DO NOTHING`
      const grant = yield* sql<
        { revoked: number | null }
      >`SELECT revoked_at_ms AS revoked FROM control_trigger_approvals WHERE grant_id = ${grantId}`
      if (grant[0]?.revoked !== null) {
        return yield* failure("This standing approval has been revoked; prepare a new consent")
      }
    }))
    return {
      grantId,
      triggerId: consent.triggerId,
      declarationDigest: consent.declarationDigest,
      planDigest: consent.plan.digest
    }
  }).pipe(Effect.provide(databaseLayer(root)))

/** Recheck the caller's authority, then revoke without deleting historical uses.
 * @category commands
 * @since 1.0.0
 */
export const revokeApproval = (root: string, grantId: string) =>
  Effect.gen(function*() {
    const control = yield* Control.Control
    const { sql, write } = yield* makeStore
    const rows = yield* sql<
      { approval: string }
    >`SELECT approval_json AS approval FROM control_trigger_approvals WHERE grant_id = ${grantId}`
    if (rows[0] === undefined) return yield* failure("Unknown standing approval")
    const approval = yield* Schema.decodeUnknownEffect(ApprovalPayload)(
      yield* Effect.try(() => JSON.parse(rows[0]!.approval))
    )
    // Control rechecks policy before replaying the original decision receipt.
    yield* control.approve(approval)
    yield* write(
      sql`UPDATE control_trigger_approvals SET revoked_at_ms = COALESCE(revoked_at_ms, ${yield* Clock
        .currentTimeMillis}) WHERE grant_id = ${grantId}`
    )
    return { grantId, revoked: true as const }
  }).pipe(Effect.provide(databaseLayer(root)))

const terminalErrors = new Set(["PlanDenied", "PlanNotFound", "PlanDigestMismatch", "EnvelopeMismatch", "InvalidInput"])
const settled = new Set(["cancelled", "completed", "failed"])
const stateOf = (status: StoredPlan["status"] | undefined): Scheduler.RunState =>
  status === undefined
    ? "missing"
    : status === "cancelled" || status === "completed" || status === "failed"
    ? status
    : "active"

/**
 * Provides recoverable scheduled launches with manual approval by default.
 * Exact, revocable standing consent may approve a matching occurrence.
 *
 * The stable handle is recorded as the trigger's active run. Its monitor can
 * restart in another process, re-offer the persisted card, and attach the real
 * run only after Control accepts it. Control's durable plan and run keys close
 * the crash gaps on either side of this adapter's own writes.
 *
 * @category layers
 * @since 1.0.0
 */
export const layer = (root: string) =>
  Layer.effect(
    Scheduler.Runner,
    Effect.gen(function*() {
      const control = yield* Control.Control
      const { read, sql, write } = yield* makeStore
      const standingApproval = (entry: StoredPlan) =>
        Effect.gen(function*() {
          const decisions = yield* sql<{ resolved: number }>`SELECT resolved FROM control_tokens
          WHERE target_tag = 'Plan' AND run_id = '' AND target_id = ${entry.plan.planId}`
          // Decisions survive a later loss of decision authority. Recover an
          // accepted receipt without making the same approval again; a not-yet
          // accepted run still checks grant revocation in its launch transaction.
          // This also preserves a person's earlier approval or denial.
          if (decisions[0]?.resolved === 1) return
          const rows = yield* sql<{ grantId: string; principal: string }>`
          SELECT g.grant_id AS grantId, g.principal_json AS principal
          FROM control_trigger_plan_bindings b
          LEFT JOIN control_trigger_approval_uses u ON u.plan_id = b.plan_id
          JOIN control_trigger_approvals g
            ON g.trigger_id = b.trigger_id AND g.declaration_digest = b.declaration_digest
          WHERE b.plan_id = ${entry.plan.planId} AND g.plan_digest = ${entry.plan.digest} AND g.revoked_at_ms IS NULL
            AND (u.grant_id IS NULL OR g.grant_id = u.grant_id)
          ORDER BY g.granted_at_ms DESC, g.grant_id LIMIT 1
        `
          const grant = rows[0]
          if (grant === undefined) return
          const current = yield* sql<
            { digest: string; triggerId: string }
          >`SELECT declaration_digest AS digest, trigger_id AS triggerId
          FROM control_trigger_plan_bindings WHERE plan_id = ${entry.plan.planId}`
          const declaration = yield* triggerDeclaration(current[0]!.triggerId).pipe(
            Effect.provideService(SqlClient.SqlClient, sql)
          )
          if (declaration?.trigger.enabled !== true || declaration.digest !== current[0]!.digest) return
          const principal = yield* Schema.decodeUnknownEffect(Principal)(
            yield* Effect.try(() => JSON.parse(grant.principal))
          )
          yield* write(sql`INSERT INTO control_trigger_approval_uses (plan_id, handle, grant_id, used_at_ms)
          VALUES (${entry.plan.planId}, ${entry.handle}, ${grant.grantId}, ${yield* Clock
            .currentTimeMillis}) ON CONFLICT (plan_id) DO NOTHING`)
          const use = yield* sql<
            { grantId: string }
          >`SELECT grant_id AS grantId FROM control_trigger_approval_uses WHERE plan_id = ${entry.plan.planId}`
          // A revoked use cannot be rebound to a later grant after a crash.
          if (use[0]?.grantId !== grant.grantId) return
          yield* control.approve({
            ...entry.plan.approval,
            scope: "once",
            principal,
            idempotencyKey: `trigger-use:${grant.grantId}:${entry.plan.planId}`
          })
        })
      // Control uses the main database too, so its calls cannot run under
      // that database's write lock. A separate writer serializes inspections
      // across layers and processes; a crashed inspector releases it through
      // the database connection. Cancellation still writes intent immediately.
      const inspectionLock = DurableWriter.layer().pipe(Layer.provide(NodeDatabase.layer({
        filename: join(root, ".flows", "trigger-inspections.db")
      })))
      const serializeInspection = <A, E>(body: Effect.Effect<A, E>) =>
        translated(
          "Could not serialize scheduled inspection",
          Effect.gen(function*() {
            const writer = yield* DurableWriter.DurableWriter
            return yield* writer.write(body)
          }).pipe(Effect.provide(inspectionLock))
        )
      const cancelRun = (runId: string) =>
        translated(
          `Could not cancel scheduled run ${runId}`,
          control.cancel({ runId, idempotencyKey: `trigger-cancel:${runId}` }).pipe(
            Effect.flatMap((receipt) =>
              receipt._tag === "Conflict"
                ? Effect.fail(failure(`Control refused scheduled cancellation: ${receipt.message}`))
                : Effect.void
            )
          )
        )
      const mark = (handle: string, status: StoredPlan["status"], error: string | null = null) =>
        write(sql`
          UPDATE control_trigger_plans SET status = ${status}, error = ${error}
          WHERE handle = ${handle} AND status NOT IN ('cancelled', 'cancelling')
        `).pipe(Effect.asVoid)
      const rememberFailure = (entry: StoredPlan, error: unknown) => {
        const tag = typeof error === "object" && error !== null && "_tag" in error
          ? String(error._tag).split("/").at(-1) ?? ""
          : ""
        const message = error instanceof Error ? error.message : "Control could not inspect this scheduled launch"
        return write(sql`
          UPDATE control_trigger_plans
          SET status = CASE
                WHEN status = 'cancelled' THEN status
                WHEN ${terminalErrors.has(tag) ? 1 : 0}
                  THEN CASE WHEN status = 'cancelling' THEN 'cancelled' ELSE 'failed' END
                ELSE status END,
              error = ${message}
          WHERE handle = ${entry.handle}
        `).pipe(
          Effect.andThen(read(entry.handle)),
          Effect.map((current): Scheduler.RunState =>
            current?.status === "cancelling" || !terminalErrors.has(tag) ? "active" : stateOf(current?.status)
          )
        )
      }
      const findRun = (runId: string) =>
        translated(
          `Could not inspect scheduled run ${runId}`,
          control.list({ _tag: "runs", filters: { runId }, limit: 1 }).pipe(
            Effect.flatMap((response) => {
              const run = response._tag === "runs" ? response.items.find((run) => run.runId === runId) : undefined
              return run === undefined
                ? Effect.fail(failure(`Control has no durable record for scheduled run ${runId}`))
                : Effect.succeed(run)
            })
          )
        )
      return Scheduler.makeRunner({
        start: (input) =>
          translated(
            "Could not prepare the scheduled plan",
            Effect.gen(function*() {
              const handle = `${prefix}${input.idempotencyKey}`
              // SqlControlRuntime persists this key together with the card.
              // A crash before our INSERT therefore cannot create a new plan.
              const plan = yield* control.plan(input)
              // The scheduler's stable key ends with an ISO occurrence. Bind
              // only a matching durable declaration, never an arbitrary caller key.
              const identity = /^(.*):(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)$/.exec(input.idempotencyKey)
              if (identity !== null) {
                yield* write(Effect.gen(function*() {
                  const declaration = yield* triggerDeclaration(identity[1]!).pipe(
                    Effect.provideService(SqlClient.SqlClient, sql)
                  )
                  if (
                    declaration?.trigger.flowId === input.flowId &&
                    canonicalize(declaration.trigger.input) === canonicalize(input.input)
                  ) {
                    yield* sql`INSERT INTO control_trigger_plan_bindings (plan_id, trigger_id, declaration_digest)
                      VALUES (${plan.planId}, ${identity[1]!}, ${declaration.digest}) ON CONFLICT (plan_id) DO NOTHING`
                  }
                }))
              }
              yield* write(sql`
                INSERT INTO control_trigger_plans (handle, idempotency_key, plan_json, status)
                VALUES (${handle}, ${input.idempotencyKey}, ${JSON.stringify(plan)}, 'waiting-approval')
                ON CONFLICT (handle) DO NOTHING
              `)
              return handle
            })
          ),
        inspect: (handle) =>
          serializeInspection(Effect.gen(function*() {
            if (!handle.startsWith(prefix)) {
              return yield* findRun(handle).pipe(
                Effect.map((run): Scheduler.RunState =>
                  settled.has(run.status) ? stateOf(run.status as StoredPlan["status"]) : "active"
                )
              )
            }
            const entry = yield* read(handle)
            if (entry === null) return yield* Effect.fail(failure(`Unknown scheduled launch ${handle}`))
            if ((entry.status === "cancelled" || entry.status === "cancelling") && entry.runId !== null) {
              return yield* cancelRun(entry.runId).pipe(
                Effect.andThen(write(sql`
                  UPDATE control_trigger_plans SET status = 'cancelled', error = NULL WHERE handle = ${handle}
                `)),
                Effect.as<Scheduler.RunState>("cancelled"),
                Effect.catch(() => Effect.succeed<Scheduler.RunState>("active"))
              )
            }
            if (settled.has(entry.status)) return stateOf(entry.status)
            if (entry.runId !== null) {
              return yield* findRun(entry.runId).pipe(
                Effect.flatMap((run) =>
                  run.status === "completed" || run.status === "failed" || run.status === "cancelled"
                    ? mark(handle, run.status).pipe(Effect.as<Scheduler.RunState>(run.status))
                    : Effect.succeed<Scheduler.RunState>("active")
                ),
                Effect.catch((error) => rememberFailure(entry, error))
              )
            }
            // The existing idempotency key is the durable launch identity.
            // Claim the attempt before Control can accept it; cancellation of
            // an untouched waiting plan wins this write and never calls run.
            const launching = yield* write(sql`
              UPDATE control_trigger_plans
              SET status = CASE WHEN status = 'waiting-approval' THEN 'launching' ELSE status END
              WHERE handle = ${handle} AND status IN ('waiting-approval', 'launching', 'cancelling') AND run_id IS NULL
              RETURNING handle
            `)
            if (launching.length === 0) return "active"
            return yield* standingApproval(entry).pipe(Effect.andThen(control.run({
              _tag: "Plan",
              planId: entry.plan.planId,
              digest: entry.plan.digest,
              envelope: entry.plan.envelope,
              idempotencyKey: entry.idempotencyKey
            }))).pipe(
              Effect.flatMap((receipt) =>
                Effect.gen(function*() {
                  if (receipt._tag === "Parked") {
                    yield* write(sql`
                      UPDATE control_trigger_plans
                      SET status = CASE WHEN status = 'cancelling' THEN 'cancelled' ELSE 'waiting-approval' END
                      WHERE handle = ${handle} AND status IN ('launching', 'cancelling') AND run_id IS NULL
                    `)
                    return (yield* read(handle))?.status === "cancelled" ? "cancelled" : "active"
                  }
                  if (receipt._tag === "Conflict") {
                    yield* write(sql`
                      UPDATE control_trigger_plans
                      SET status = CASE WHEN status = 'cancelling' THEN 'cancelled' ELSE 'failed' END,
                          error = ${receipt.message}
                      WHERE handle = ${handle} AND status != 'cancelled' AND run_id IS NULL
                    `)
                    return stateOf((yield* read(handle))?.status)
                  }
                  const runId = receipt.runId
                  if (runId === undefined) {
                    return yield* Effect.fail(failure(`Control ${receipt._tag} receipt omitted its run id`))
                  }
                  yield* write(sql`
                    UPDATE control_trigger_plans
                    SET run_id = ${runId}, status = CASE WHEN status IN ('cancelled', 'cancelling') THEN status ELSE 'running' END,
                        error = NULL
                    WHERE handle = ${handle}
                  `)
                  // A superseding scheduler may cancel between our read and
                  // Control's acceptance. Do not leave that accepted run live.
                  const current = yield* read(handle)
                  if (current?.status === "cancelled" || current?.status === "cancelling") {
                    yield* cancelRun(runId)
                    yield* write(sql`
                      UPDATE control_trigger_plans SET status = 'cancelled', error = NULL WHERE handle = ${handle}
                    `)
                    return "cancelled"
                  }
                  return "active"
                })
              ),
              Effect.catch((error) => rememberFailure(entry, error))
            )
          })),
        cancel: (handle) =>
          Effect.gen(function*() {
            if (!handle.startsWith(prefix)) return yield* cancelRun(handle)
            const entry = yield* read(handle)
            if (entry === null) return yield* Effect.fail(failure(`Unknown scheduled launch ${handle}`))
            // Decide from the current row, not the earlier read: a launch
            // may have begun while this cancellation was being scheduled.
            yield* write(sql`
              UPDATE control_trigger_plans
              SET status = CASE
                    WHEN status IN ('launching', 'cancelling') AND run_id IS NULL THEN 'cancelling'
                    ELSE 'cancelled' END,
                  error = NULL
              WHERE handle = ${handle}
            `)
            const current = yield* read(handle)
            if (current?.runId != null) yield* cancelRun(current.runId)
            if (current?.status === "cancelling" && current.runId === null) {
              // Scheduler restores the active handle when cancel fails. Do
              // not let supersession discard its only recovery monitor.
              return yield* Effect.fail(failure(`Scheduled launch ${handle} is awaiting cancellation reconciliation`))
            }
          })
      })
    })
  ).pipe(Layer.provide(databaseLayer(root)))

/**
 * Shared default approval policy for command-line entrypoints.
 *
 * @since 1.0.0
 */

import { canonicalize } from "@smthrs/canonical"
import { PersistenceError, PlanDenied } from "@smthrs/control/ControlError"
import type { PlanCard } from "@smthrs/control/ControlSchema"
import { Sha256 } from "@smthrs/crypto"
import * as Trigger from "@smthrs/triggers/Trigger"
import { Effect } from "effect"
import * as SqlClient from "effect/sql/SqlClient"

/**
 * Default scope for both CLI approval spellings. MCP hosts choose their own policy.
 * @category constants
 * @since 1.0.0
 */
export const defaultApprovalScope = "run" as const

/** Exact durable registration identity, including its edit revision.
 * @category queries
 * @since 1.0.0
 */
export const triggerDeclaration = (id: string) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    const exists = yield* sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'flows_triggers'`
    if (exists.length === 0) return undefined
    const rows = yield* sql<{
      trigger_id: string
      flow_id: string
      input_json: string
      cron: string
      timezone: string | null
      overlap: string
      catch_up: string
      max_catch_up: number
      enabled: number
      revision: number
    }>`SELECT trigger_id, flow_id, input_json, cron, timezone, overlap, catch_up, max_catch_up, enabled, revision
     FROM flows_triggers WHERE trigger_id = ${id}`
    const row = rows[0]
    if (row === undefined) return undefined
    const input = yield* Effect.try(() => JSON.parse(row.input_json) as unknown)
    const trigger = yield* Trigger.make({
      id: row.trigger_id,
      flowId: row.flow_id,
      input,
      cron: row.cron,
      ...(row.timezone === null ? {} : { timezone: row.timezone }),
      overlap: row.overlap,
      catchUp: row.catch_up,
      maxCatchUp: row.max_catch_up,
      enabled: row.enabled === 1
    })
    return { trigger, digest: Sha256.digestSync(canonicalize({ trigger, revision: row.revision })) }
  }).pipe(Effect.mapError((cause) =>
    new PersistenceError({
      operation: "read trigger declaration",
      message: "Cannot read the registered trigger",
      cause
    })
  ))

/** Check standing consent in the same transaction that admits the run.
 * Revocation or any declaration edit wins against an uncommitted admission,
 * including a process that crashed after approving its occurrence's plan.
 * @category authorization
 * @since 1.0.0
 */
export const authorizeTriggerLaunch = (card: PlanCard, sql: SqlClient.SqlClient) =>
  Effect.gen(function*() {
    const uses = yield* sql<{
      grantId: string
      triggerId: string
      declarationDigest: string
      planDigest: string
      revokedAt: number | null
    }>`SELECT g.grant_id AS grantId, g.trigger_id AS triggerId, g.declaration_digest AS declarationDigest,
            g.plan_digest AS planDigest, g.revoked_at_ms AS revokedAt
     FROM control_trigger_approval_uses u JOIN control_trigger_approvals g ON g.grant_id = u.grant_id
     WHERE u.plan_id = ${card.planId}`
    const grant = uses[0]
    if (grant === undefined) return
    const current = yield* triggerDeclaration(grant.triggerId).pipe(Effect.provideService(SqlClient.SqlClient, sql))
    if (
      grant.revokedAt !== null || current?.trigger.enabled !== true || current.digest !== grant.declarationDigest ||
      card.digest !== grant.planDigest
    ) {
      return yield* new PlanDenied({ planId: card.planId })
    }
  }).pipe(Effect.mapError((cause) =>
    cause instanceof PlanDenied || cause instanceof PersistenceError ? cause : new PersistenceError({
      operation: "check standing trigger approval",
      message: "Cannot verify standing trigger approval",
      cause
    })
  ))

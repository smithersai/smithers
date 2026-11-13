/** Standing approval uses the production catalog and launch check on both database backends. */
import { canonicalize } from "@smthrs/canonical"
import { Control } from "@smthrs/control"
import * as ControlLive from "@smthrs/control/ControlLive"
import { Sha256 } from "@smthrs/crypto"
import * as NodeDatabase from "@smthrs/database/node/NodeDatabase"
import { dropSchema } from "@smthrs/database/test/TestDatabase"
import { NotificationQueue } from "@smthrs/notifications"
import { Registry } from "@smthrs/registry"
import * as Scheduler from "@smthrs/triggers/Scheduler"
import * as SqlTriggerStore from "@smthrs/triggers/SqlTriggerStore"
import * as Trigger from "@smthrs/triggers/Trigger"
import * as TriggerStore from "@smthrs/triggers/TriggerStore"
import { Effect, Layer } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest"
import { authorizeTriggerLaunch, standingPlanDigest, triggerDeclaration } from "../src/internal/ApprovalScope.ts"
import * as NodeControl from "../src/NodeControl.ts"
import { databaseLayer } from "../src/operator/Store.ts"
import * as TriggerPlans from "../src/operator/TriggerPlans.ts"
import * as Needs from "./Needs.ts"

const declaration = {
  id: "daily",
  flowId: "system/test",
  input: { suite: "scheduled" },
  cron: "0 * * * *",
  overlap: "skip",
  catchUp: "none",
  maxCatchUp: 1,
  enabled: true
} as const

describe.each(["sqlite", "postgres"] as const)("standing approval on %s", (backend) => {
  let root: string
  beforeEach(async (context) => {
    const url = backend === "postgres" ? Needs.postgres(context) : undefined
    root = await mkdtemp(join(tmpdir(), "smthrs-standing-"))
    vi.stubEnv("SMITHERS_BACKEND", backend)
    if (url !== undefined) {
      vi.stubEnv("SMITHERS_POSTGRES_URL", url)
      vi.stubEnv("SMITHERS_POSTGRES_SCHEMA", "")
    }
    onTestFinished(async () => {
      try {
        if (backend === "postgres") {
          for (const filename of [NodeControl.databasePath(root), join(root, ".flows", "trigger-inspections.db")]) {
            const location = NodeDatabase.postgresLocation(filename)!
            await Effect.runPromise(
              Effect.flatMap(SqlClient, (sql) => dropSchema(sql, location.schema)).pipe(
                Effect.provide(NodeDatabase.layer({ filename }))
              )
            )
          }
        }
      } finally {
        vi.unstubAllEnvs()
        await rm(root, { recursive: true, force: true })
      }
    })
  })

  const database = <A, E>(effect: Effect.Effect<A, E, SqlClient>) =>
    Effect.runPromise(effect.pipe(Effect.provide(databaseLayer(root))))
  const controlLayer = () => {
    const engine = NodeControl.engineDurable(root)
    return ControlLive.layer.pipe(
      Layer.provide([engine.runtime, engine.journal, Registry.layerNoop(), NotificationQueue.layerNoop()])
    )
  }
  const control = <A, E>(effect: Effect.Effect<A, E, Control.Control>) =>
    Effect.runPromise(effect.pipe(Effect.provide(controlLayer())))
  const scheduled = <A, E>(effect: Effect.Effect<A, E, Scheduler.Runner>) =>
    Effect.runPromise(effect.pipe(Effect.provide(TriggerPlans.layer(root).pipe(Layer.provide(controlLayer())))))
  const register = () =>
    Effect.runPromise(
      Effect.flatMap(TriggerStore.TriggerStore, (store) => store.register(declaration)).pipe(
        Effect.provide(SqlTriggerStore.layer.pipe(Layer.provide(databaseLayer(root))))
      )
    )

  it("handles an absent trigger table and an unknown registration", async () => {
    expect(await database(triggerDeclaration("daily"))).toBeUndefined()
    await register()
    expect(await database(triggerDeclaration("absent"))).toBeUndefined()
    expect(await database(triggerDeclaration("daily"))).toMatchObject({ trigger: declaration })
  })

  it("previews and grants consent bound to the current registration", async () => {
    await register()
    const preview = await control(TriggerPlans.previewApproval(root, "daily"))
    expect(preview).toMatchObject({ triggerId: "daily", plan: { flowId: "system/test" } })
    const grant = await control(TriggerPlans.grantApproval(root, preview))
    expect(grant).toMatchObject({
      triggerId: "daily",
      declarationDigest: preview.declarationDigest,
      planDigest: standingPlanDigest(preview.plan)
    })
    expect(await control(TriggerPlans.grantApproval(root, preview))).toEqual(grant)
    const handle = await scheduled(Effect.flatMap(Scheduler.Runner, (runner) =>
      runner.start({
        flowId: declaration.flowId,
        input: declaration.input,
        idempotencyKey: Scheduler.idempotencyKey("daily", 1000)
      })))
    await scheduled(Effect.flatMap(Scheduler.Runner, (runner) => runner.inspect(handle)))
    expect(await TriggerPlans.inspect(root, handle)).toMatchObject({ status: "running", runId: expect.any(String) })
    const uses = await database(
      Effect.flatMap(SqlClient, (sql) => sql<{ grant_id: string }>`SELECT grant_id FROM control_trigger_approval_uses`)
    )
    expect(uses).toEqual([{ grant_id: grant.grantId }])
    await control(TriggerPlans.revokeApproval(root, grant.grantId))
    const timestamps = await database(
      Effect.flatMap(SqlClient, (sql) =>
        sql<{ granted_at_ms: number; revoked_at_ms: number; used_at_ms: number }>`
        SELECT g.granted_at_ms, g.revoked_at_ms, u.used_at_ms
        FROM control_trigger_approvals g JOIN control_trigger_approval_uses u ON u.grant_id = g.grant_id`)
    )
    for (const value of Object.values(timestamps[0]!)) expect(value).toBeGreaterThan(2_147_483_647)
    await register()
    await expect(control(TriggerPlans.grantApproval(root, preview))).rejects.toThrow(
      "Standing approval no longer matches"
    )
    await database(
      Effect.flatMap(SqlClient, (sql) => sql`UPDATE flows_triggers SET enabled = 0 WHERE trigger_id = 'daily'`)
    )
    await expect(control(TriggerPlans.previewApproval(root, "daily"))).rejects.toThrow("Unknown or disabled trigger")
  })

  it.skipIf(backend !== "postgres")("upgrades existing approval timestamps without losing grants or uses", async () => {
    await database(Effect.gen(function*() {
      const sql = yield* SqlClient
      // Reconstruct the preceding persisted schema and its migration ledger.
      yield* sql`ALTER TABLE control_trigger_approvals
        ALTER COLUMN granted_at_ms TYPE INTEGER, ALTER COLUMN revoked_at_ms TYPE INTEGER`
      yield* sql`ALTER TABLE control_trigger_approval_uses ALTER COLUMN used_at_ms TYPE INTEGER`
      yield* sql`DELETE FROM flows_migrations WHERE migration_id = 9002`
      yield* sql`INSERT INTO control_trigger_approvals
        (grant_id, trigger_id, declaration_digest, plan_digest, approval_json, principal_json, granted_at_ms)
        VALUES ('legacy', 'daily', 'declaration', 'plan', '{}', '{}', 1)`
      yield* sql`INSERT INTO control_trigger_approval_uses (plan_id, handle, grant_id, used_at_ms)
        VALUES ('legacy-plan', 'legacy-use', 'legacy', 2)`
    }))
    // Reopening applies the appended migration to the existing rows.
    const rows = await database(
      Effect.flatMap(
        SqlClient,
        (sql) =>
          sql<{ granted_at_ms: number; revoked_at_ms: number | null; used_at_ms: number }>`
        SELECT g.granted_at_ms, g.revoked_at_ms, u.used_at_ms
        FROM control_trigger_approvals g JOIN control_trigger_approval_uses u ON u.grant_id = g.grant_id`
      )
    )
    expect(rows).toEqual([{ granted_at_ms: 1, revoked_at_ms: null, used_at_ms: 2 }])
    const now = 1_800_000_000_000
    await database(Effect.gen(function*() {
      const sql = yield* SqlClient
      yield* sql`UPDATE control_trigger_approvals SET granted_at_ms = ${now}, revoked_at_ms = ${now}`
      yield* sql`UPDATE control_trigger_approval_uses SET used_at_ms = ${now}`
    }))
    const updated = await database(
      Effect.flatMap(SqlClient, (sql) =>
        sql<{ granted_at_ms: number; revoked_at_ms: number; used_at_ms: number }>`
        SELECT g.granted_at_ms, g.revoked_at_ms, u.used_at_ms
        FROM control_trigger_approvals g JOIN control_trigger_approval_uses u ON u.grant_id = g.grant_id`)
    )
    expect(updated).toEqual([{ granted_at_ms: now, revoked_at_ms: now, used_at_ms: now }])
  })

  it("admits a persisted standing grant and rejects it after revocation or a registration edit", async () => {
    await register()
    const card = await control(
      Effect.flatMap(
        Control.Control,
        (service) => service.plan({ flowId: declaration.flowId, input: declaration.input })
      )
    )
    // Seed an existing grant so admission is tested independently of preview.
    const trigger = await Effect.runPromise(Trigger.make(declaration))
    const digest = Sha256.digestSync(canonicalize({ trigger, revision: 1 }))
    await database(Effect.gen(function*() {
      const sql = yield* SqlClient
      yield* sql`INSERT INTO control_trigger_approvals
        (grant_id, trigger_id, declaration_digest, plan_digest, approval_json, principal_json, granted_at_ms)
        VALUES ('grant', 'daily', ${digest}, ${standingPlanDigest(card)}, ${JSON.stringify(card.approval)},
          ${JSON.stringify({ id: "local", kind: "operator", stampedAt: 1 })}, 1)`
      yield* sql`INSERT INTO control_trigger_approval_uses (plan_id, handle, grant_id, used_at_ms)
        VALUES (${card.planId}, 'occurrence', 'grant', 1)`
    }))
    const admit = () =>
      database(Effect.flatMap(SqlClient, (sql) => sql.withTransaction(authorizeTriggerLaunch(card, sql))))
    await expect(admit()).resolves.toBeUndefined()
    await database(
      Effect.flatMap(
        SqlClient,
        (sql) => sql`UPDATE control_trigger_approvals SET revoked_at_ms = 2 WHERE grant_id = 'grant'`
      )
    )
    await expect(admit()).rejects.toMatchObject({ _tag: "/control/PlanDenied" })
    await database(
      Effect.flatMap(
        SqlClient,
        (sql) => sql`UPDATE control_trigger_approvals SET revoked_at_ms = NULL WHERE grant_id = 'grant'`
      )
    )
    await register()
    await expect(admit()).rejects.toMatchObject({ _tag: "/control/PlanDenied" })
    // Ordinary plans without a standing-grant use still pass the admission check.
    await database(
      Effect.flatMap(SqlClient, (sql) => sql`DELETE FROM control_trigger_approval_uses WHERE plan_id = ${card.planId}`)
    )
    await expect(admit()).resolves.toBeUndefined()
  })
})

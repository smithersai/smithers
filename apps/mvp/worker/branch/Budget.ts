import { Effect, type Layer, Metric } from "effect"
import { SqlClient } from "effect/sql"
import { DEFAULT_SANDBOX_LIMITS, type SandboxLimits } from "../../src/features/spend/contract.ts"
import { codeOf } from "../ErrorCode.ts"
import { CI_OWNER } from "../flows/CiJobMachine.ts"
import type { SandboxBranch } from "./Sandboxes.ts"

// Sandbox budgets (ruling AUTH-5, decision 0103, docs/features/sandbox-budgets.md): how many machines may be awake, and
// what they cost. Will, 2026-10-19 22:45: "Add this as a TODO but we won't worry about this until we ship."
//
// The ledger is `sandbox_generations` (db/migrations/0062_sandbox_budgets.ts): one open row per awake machine, at most
// one per branch. A machine is admitted before it starts (`admit`): under one Postgres advisory lock, a branch whose
// slot is live keeps it, and any other is admitted only while fewer than `awake` machines are awake and, for a branch's
// own machine, fewer than `perPerson` of the person's. `started` records the generation and instance type once the
// machine runs, `seen` renews the slot every minute `sandbox/Keep` finds the machine awake, and `ended` closes it when
// the machine sleeps or is gone. A slot nobody renewed for `LEASE_SECONDS` stops counting, so a machine whose
// keep-awake died never holds a slot for good.
//
// Cloudflare's `durable_object` scheduling policy has no `max_instances` ("The `durable_object` policy does not support
// `max_instances`", developers.cloudflare.com/containers/configuration/scheduling-policy/), so this admission is the
// hard cap. It fails closed: a wake whose admission can't read Postgres doesn't start a machine, and its step tries
// again, as it would for any machine that can't answer.

/** How long a slot counts as awake after `sandbox/Keep` last found its machine awake: five of its asks. */
export const LEASE_SECONDS = 300

/** What a machine is for: a branch's own (terminals and tools), a TODO's attempt, or a check or CI job. */
export type Kind = "branch" | "todo" | "job"

/** The kind of `branch`'s machine: a job, a TODO's attempt branch on GitHub, else the branch's own. */
export const kindOf = (branch: SandboxBranch): Kind =>
  branch.kind === "job" ? "job" : branch.forge === "github" ? "todo" : "branch"

/** The person a machine is woken for: `ownerId`, unless it is CI's own (`CI_OWNER`) or none. */
export const personOf = (ownerId: string | undefined): string | null =>
  ownerId === undefined || ownerId === "" || ownerId === CI_OWNER ? null : ownerId

/** A machine to admit: its branch, the person it is woken for, and its kind. */
export interface Slot {
  readonly branchId: string
  readonly personId: string | null
  readonly kind: Kind
}

/**
 * What admission answered: `Admitted`, with how many machines are awake counting this one, or `Waiting` for a free
 * machine, for the deployment's limit or the person's, with the awake count it hit.
 */
export type Admission =
  | { readonly _tag: "Admitted"; readonly awake: number }
  | { readonly _tag: "Waiting"; readonly scope: "deployment" | "person"; readonly awake: number; readonly limit: number }

/** Admissions, by `outcome` (`admitted`, `waiting`, `failed`), `scope` (`deployment`, `person`, `none`) and `kind`. */
export const admissions = Metric.counter("smithers_sandbox_admissions", {
  description: "Sandbox admissions before a machine starts, by outcome, scope and kind",
  incremental: true,
})

/** Machines awake in the deployment at the last admission or spend sample. */
export const awakeGauge = Metric.gauge("smithers_sandbox_awake", {
  description: "Sandbox machines awake in the deployment at the last admission or spend sample",
})

/** The limits an Admin set (`sandbox_limits`), else `DEFAULT_SANDBOX_LIMITS`. */
export const limits: Effect.Effect<SandboxLimits, unknown, SqlClient.SqlClient> = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const [row] = yield* sql<{ readonly awake: number; readonly perPerson: number; readonly monthlyAlertUsd: number }>`
    SELECT awake, awake_per_person AS "perPerson", monthly_alert_usd AS "monthlyAlertUsd"
    FROM sandbox_limits WHERE audience = 'admin'`
  return row === undefined ? DEFAULT_SANDBOX_LIMITS : { ...row }
})

/** Sets the limits as `actor`. Answers the transaction it wrote in. */
export const setLimits = (next: SandboxLimits, actor: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const [row] = yield* sql<{ readonly txid: string }>`
      INSERT INTO sandbox_limits (audience, awake, awake_per_person, monthly_alert_usd, updated_by, updated_at)
      VALUES ('admin', ${next.awake}, ${next.perPerson}, ${next.monthlyAlertUsd}, ${actor}, now())
      ON CONFLICT (audience) DO UPDATE SET awake = EXCLUDED.awake, awake_per_person = EXCLUDED.awake_per_person,
        monthly_alert_usd = EXCLUDED.monthly_alert_usd, updated_by = EXCLUDED.updated_by, updated_at = now()
      RETURNING pg_current_xact_id()::xid::text AS txid`
    return Number(row!.txid)
  })

/** How many machines are awake, in the deployment and as `personId`'s branch machines. */
const awakeNow = (sql: SqlClient.SqlClient, personId: string | null) =>
  Effect.map(
    sql<{ readonly awake: number; readonly mine: number }>`
      SELECT count(*)::int AS awake, count(*) FILTER (WHERE kind = 'branch' AND person_id = ${personId})::int AS mine
      FROM sandbox_generations
      WHERE ended_at IS NULL AND seen_at > now() - make_interval(secs => ${LEASE_SECONDS})`,
    ([counted]) => counted!,
  )

/**
 * Admits `slot`'s machine before it starts, in one transaction under the budget's advisory lock: a branch whose slot is
 * live keeps it (and renews it); a slot that lapsed is closed at its last renewal; else the machine is admitted while
 * fewer than `awake` machines are awake and, for a branch's own machine, fewer than `perPerson` of the person's, and
 * its slot opens (no generation yet), else it waits.
 */
export const admit = (slot: Slot) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    return yield* sql.withTransaction(Effect.gen(function* () {
      yield* sql`SELECT pg_advisory_xact_lock(hashtextextended('sandbox_budget', 0))`
      const [open] = yield* sql<{ readonly id: string; readonly live: boolean }>`
        SELECT id::text AS id, seen_at > now() - make_interval(secs => ${LEASE_SECONDS}) AS live
        FROM sandbox_generations WHERE branch_id = ${slot.branchId} AND ended_at IS NULL`
      if (open?.live === true) {
        yield* sql`UPDATE sandbox_generations SET seen_at = now() WHERE id = ${open.id}::bigint`
        return { _tag: "Admitted", awake: (yield* awakeNow(sql, slot.personId)).awake } satisfies Admission
      }
      if (open !== undefined) yield* sql`UPDATE sandbox_generations SET ended_at = seen_at WHERE id = ${open.id}::bigint`
      const limit = yield* limits
      const counted = yield* awakeNow(sql, slot.personId)
      if (counted.awake >= limit.awake) {
        return { _tag: "Waiting", scope: "deployment", awake: counted.awake, limit: limit.awake } satisfies Admission
      }
      if (slot.kind === "branch" && slot.personId !== null && counted.mine >= limit.perPerson) {
        return { _tag: "Waiting", scope: "person", awake: counted.awake, limit: limit.perPerson } satisfies Admission
      }
      yield* sql`
        INSERT INTO sandbox_generations (branch_id, person_id, kind)
        VALUES (${slot.branchId}, ${slot.personId}, ${slot.kind})`
      return { _tag: "Admitted", awake: counted.awake + 1 } satisfies Admission
    }))
  })

/**
 * `admit` with its records: a `sandbox.budget` line (Info admitted, Warn waiting or failed) with the kind, the outcome,
 * the scope it waited for, the awake count and the limit; `smithers_sandbox_admissions`; and the awake gauge. Never a
 * person's id.
 */
export const observedAdmit = <E, R>(slot: Slot, database: Layer.Layer<SqlClient.SqlClient, E, R>) =>
  admit(slot).pipe(
    Effect.provide(database),
    Effect.tap((admission) =>
      Effect.all([
        Metric.update(awakeGauge, admission.awake),
        Metric.update(
          Metric.withAttributes(admissions, {
            outcome: admission._tag === "Admitted" ? "admitted" : "waiting",
            scope: admission._tag === "Admitted" ? "none" : admission.scope,
            kind: slot.kind,
          }),
          1,
        ),
        Effect.logWithLevel(admission._tag === "Admitted" ? "Info" : "Warn")("sandbox.budget").pipe(
          Effect.annotateLogs({
            branchId: slot.branchId,
            kind: slot.kind,
            outcome: admission._tag === "Admitted" ? "admitted" : "waiting",
            awake: admission.awake,
            ...(admission._tag === "Waiting" ? { scope: admission.scope, limit: admission.limit } : {}),
          }),
        ),
      ])
    ),
    Effect.tapError((error) =>
      Effect.andThen(
        Metric.update(Metric.withAttributes(admissions, { outcome: "failed", scope: "none", kind: slot.kind }), 1),
        Effect.logWarning("sandbox.budget").pipe(
          Effect.annotateLogs({ branchId: slot.branchId, kind: slot.kind, outcome: "failed", errorCode: codeOf(error) }),
        ),
      )
    ),
    Effect.withSpan("sandbox.budget.admit", { attributes: { "smithers.branch.id": slot.branchId, "smithers.sandbox.kind": slot.kind } }),
  )

/** A machine that started: its slot, its generation and the instance type it runs on. */
export interface Started extends Slot {
  readonly generation: number
  readonly instance: string
}

/**
 * Records that `started`'s machine runs: the branch's open slot takes its generation and instance type and its awake
 * time starts now; a slot still open for an earlier generation is closed now; a machine started without a slot (one
 * that stopped between a check and a start) gets one, since it runs whatever the limits say.
 */
export const started = (machine: Started) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql.withTransaction(Effect.gen(function* () {
      const [open] = yield* sql<{ readonly id: string; readonly generation: number | null }>`
        SELECT id::text AS id, generation FROM sandbox_generations
        WHERE branch_id = ${machine.branchId} AND ended_at IS NULL FOR UPDATE`
      if (open !== undefined && open.generation === machine.generation) {
        yield* sql`UPDATE sandbox_generations SET seen_at = now() WHERE id = ${open.id}::bigint`
        return
      }
      if (open !== undefined && open.generation === null) {
        yield* sql`
          UPDATE sandbox_generations SET generation = ${machine.generation}, instance = ${machine.instance},
            started_at = now(), seen_at = now()
          WHERE id = ${open.id}::bigint`
        return
      }
      if (open !== undefined) yield* sql`UPDATE sandbox_generations SET ended_at = now() WHERE id = ${open.id}::bigint`
      yield* sql`
        INSERT INTO sandbox_generations (branch_id, generation, person_id, kind, instance)
        VALUES (${machine.branchId}, ${machine.generation}, ${machine.personId}, ${machine.kind}, ${machine.instance})`
    }))
  })

/** Closes the branch's slot if no machine ever started on it: a wake that failed gives it back. */
export const release = (branchId: string) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    sql`UPDATE sandbox_generations SET ended_at = now() WHERE branch_id = ${branchId} AND ended_at IS NULL AND generation IS NULL`)

/** Renews generation `generation`'s slot: `sandbox/Keep` found its machine awake. */
export const seen = (branchId: string, generation: number) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    sql`
      UPDATE sandbox_generations SET seen_at = now()
      WHERE branch_id = ${branchId} AND generation = ${generation} AND ended_at IS NULL`)

/** Closes generation `generation`'s slot: its machine slept, or is gone. */
export const ended = (branchId: string, generation: number) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    sql`
      UPDATE sandbox_generations SET ended_at = greatest(now(), started_at)
      WHERE branch_id = ${branchId} AND generation = ${generation} AND ended_at IS NULL`)

/** Cloudflare Containers' instance types: vCPUs, GiB of memory and GB of disk. */
export const INSTANCES: Readonly<Record<string, { readonly vcpu: number; readonly memoryGib: number; readonly diskGb: number }>> = {
  lite: { vcpu: 1 / 16, memoryGib: 0.25, diskGb: 2 },
  basic: { vcpu: 0.25, memoryGib: 1, diskGb: 4 },
  "standard-1": { vcpu: 0.5, memoryGib: 4, diskGb: 8 },
  "standard-2": { vcpu: 1, memoryGib: 6, diskGb: 12 },
  "standard-3": { vcpu: 2, memoryGib: 8, diskGb: 16 },
  "standard-4": { vcpu: 4, memoryGib: 12, diskGb: 20 },
}

/**
 * Cloudflare Containers' prices, in dollars per second (developers.cloudflare.com/containers/pricing/): a vCPU, a GiB of
 * memory, a GB of disk.
 */
export const PRICES = { vcpuSecond: 0.000020, memoryGibSecond: 0.0000025, diskGbSecond: 0.00000007 } as const

/**
 * What a second awake on `instance` costs at most, in dollars: its vCPUs as if always busy (Cloudflare bills CPU by
 * use, so this is an upper bound), its memory and its disk. An instance type this doesn't know is priced as the largest.
 */
export const pricePerSecond = (instance: string): number => {
  const size = INSTANCES[instance] ?? INSTANCES["standard-4"]!
  return size.vcpu * PRICES.vcpuSecond + size.memoryGib * PRICES.memoryGibSecond + size.diskGb * PRICES.diskGbSecond
}

/** A calendar month in UTC: its label (`2026-10`) and its bounds in epoch milliseconds. */
export interface Month {
  readonly label: string
  readonly from: number
  readonly until: number
}

/** The UTC calendar month `atMs` falls in. */
export const monthOf = (atMs: number): Month => {
  const at = new Date(atMs)
  const year = at.getUTCFullYear()
  const month = at.getUTCMonth()
  return {
    label: `${year}-${String(month + 1).padStart(2, "0")}`,
    from: Date.UTC(year, month, 1),
    until: Date.UTC(year, month + 1, 1),
  }
}

/** A month's sandbox spend so far: the estimated dollars, and the machine-hours they price. */
export interface Spend {
  readonly usd: number
  readonly hours: number
}

/**
 * `month`'s sandbox spend up to now: every slot's awake time within the month (to its end, to now while it is live, to
 * its last renewal once it lapsed), each priced by its instance type. A slot that never started costs nothing.
 */
export const spendIn = (month: Month) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const rows = yield* sql<{ readonly instance: string; readonly seconds: number }>`
      SELECT instance, sum(greatest(0, extract(epoch FROM
        least(
          coalesce(ended_at, CASE WHEN seen_at > now() - make_interval(secs => ${LEASE_SECONDS}) THEN now() ELSE seen_at END),
          to_timestamp(${month.until / 1000})
        ) - greatest(started_at, to_timestamp(${month.from / 1000}))
      )))::float8 AS seconds
      FROM sandbox_generations
      WHERE instance IS NOT NULL AND started_at < to_timestamp(${month.until / 1000})
        AND coalesce(ended_at, now()) > to_timestamp(${month.from / 1000})
      GROUP BY instance`
    const seconds = rows.reduce((sum, row) => sum + row.seconds, 0)
    const usd = rows.reduce((sum, row) => sum + row.seconds * pricePerSecond(row.instance), 0)
    return { usd, hours: seconds / 3600 } satisfies Spend
  })

/** How many machines are awake in the deployment now. */
export const awake = Effect.flatMap(SqlClient.SqlClient, (sql) => Effect.map(awakeNow(sql, null), (counted) => counted.awake))

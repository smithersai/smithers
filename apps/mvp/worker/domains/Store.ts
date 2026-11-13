import { Effect, Option } from "effect"
import { SqlClient } from "effect/sql"
import type {
  CertificateState,
  DnsRecord,
  DomainState,
  VerificationState,
} from "../../src/features/domains/contract.ts"

// The domains tables (db/migrations/0046_domains.ts, docs/features/domains.md#postgres). Only the `domain/*` flows'
// steps write them; the routes read who holds a hostname.

/** A domain's row as the steps read it. */
export interface Row {
  readonly hostname: string
  readonly repoId: string
  readonly providerId: string | null
  readonly pollId: string
  readonly state: DomainState
  readonly problem: string | null
}

/**
 * What a claim did: `add` a domain, `refresh` this repository's, find it another's (`taken`), being removed
 * (`removing`) or, for a refresh, already removed (`missing`), or nothing again (`repeat`).
 */
export type Claim = "add" | "refresh" | "taken" | "removing" | "missing" | "repeat"

const repeated = (invocationKey: string) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    Effect.map(
      sql<{ readonly id: string }>`SELECT id FROM domain_events WHERE invocation_key = ${invocationKey}`,
      (rows) => rows.length > 0,
    ))

/** Claims and cleanup serialize even when no row exists, so a new claim cannot adopt a registration being deleted. */
const lockHostname = (hostname: string) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    sql`SELECT pg_advisory_xact_lock(hashtextextended('domain:' || ${hostname}, 0))`)

/** Forget only a registration no newer poll owns, excluding claims until the provider has forgotten it. */
export const cleanup = <E, R>(
  input: { readonly hostname: string; readonly pollId: string; readonly providerId: string },
  forget: Effect.Effect<void, E, R>,
): Effect.Effect<"released" | "superseded" | "pending", unknown, SqlClient.SqlClient | R> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    return yield* sql.withTransaction(Effect.gen(function* () {
      yield* lockHostname(input.hostname)
      const row = yield* read(input.hostname)
      if (Option.isSome(row) && row.value.pollId !== input.pollId && row.value.state !== "removing") {
        // Only a recorded id transfers cleanup to the new owner's removal; an in-flight check may not adopt it.
        return row.value.providerId === input.providerId ? "superseded" as const : "pending" as const
      }
      yield* forget
      return "released" as const
    }))
  })

/** The row of `hostname`, if any. */
export const read = (hostname: string): Effect.Effect<Option.Option<Row>, unknown, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const rows = yield* sql<Row>`
      SELECT hostname, repo_id AS "repoId", provider_id AS "providerId", poll_id AS "pollId", state, problem
      FROM domains WHERE hostname = ${hostname}`
    return Option.fromUndefinedOr(rows[0])
  })

/**
 * Claims `hostname` for `repoId` under poll `pollId`, and records `add` or `refresh` once. A hostname another repository
 * holds is `taken`, and nothing changes. Refreshing hands the row to the new poll and clears its problem; its state,
 * its provider id and what the provider last said stay until the poll's first check, so an active domain stays active
 * and a removal always finds the registration to forget.
 */
export const claim = (write: {
  readonly hostname: string
  readonly repoId: string
  readonly pollId: string
  readonly actorId: string
  readonly invocationKey: string
  /** A refresh of a domain the route saw: one removed since stays removed. */
  readonly refresh: boolean
}): Effect.Effect<Claim, unknown, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    return yield* sql.withTransaction(Effect.gen(function* () {
      yield* lockHostname(write.hostname)
      if (yield* repeated(write.invocationKey)) return "repeat" as const
      const [held] = yield* sql<{ readonly repoId: string; readonly state: string }>`
        SELECT repo_id AS "repoId", state FROM domains WHERE hostname = ${write.hostname} FOR UPDATE`
      if (held !== undefined && held.repoId !== write.repoId) return "taken" as const
      // A removal in flight finishes first: refreshing would revive a row whose registration is going.
      if (held?.state === "removing") return "removing" as const
      // Refresh then Remove can run in either order: a refresh never brings back a domain removed meanwhile.
      if (held === undefined && write.refresh) return "missing" as const
      const action = held === undefined ? "add" as const : "refresh" as const
      if (held === undefined) {
        yield* sql`
          INSERT INTO domains (hostname, repo_id, poll_id, state, verification, certificate, updated_by)
          VALUES (${write.hostname}, ${write.repoId}, ${write.pollId}, 'pending', 'pending', 'pending', ${write.actorId})`
      } else {
        yield* sql`
          UPDATE domains SET poll_id = ${write.pollId}, problem = NULL,
            updated_by = ${write.actorId}, updated_at = now()
          WHERE hostname = ${write.hostname}`
      }
      yield* sql`
        INSERT INTO domain_events (hostname, repo_id, action, actor_id, invocation_key, state)
        VALUES (${write.hostname}, ${write.repoId}, ${action}, ${write.actorId}, ${write.invocationKey}, 'pending')`
      return action
    }))
  })

/** What one check found. A verdict it didn't get (`undefined`) keeps the row's last one. */
export interface Check {
  readonly hostname: string
  readonly pollId: string
  readonly providerId?: string
  readonly state: DomainState
  readonly verification?: VerificationState
  readonly certificate?: CertificateState
  readonly records?: ReadonlyArray<DnsRecord>
  readonly problem: string | null
}

/**
 * Writes what `check` found, if poll `check.pollId` still owns the row and it isn't being removed, and records a
 * `check` event when the state or the problem changed: `written`; `removed` when the row is gone or being removed;
 * `superseded` when another poll owns it.
 */
export const record = (check: Check): Effect.Effect<"written" | "removed" | "superseded", unknown, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    return yield* sql.withTransaction(Effect.gen(function* () {
      const [before] = yield* sql<{
        readonly repoId: string
        readonly pollId: string
        readonly state: string
        readonly problem: string | null
      }>`
        SELECT repo_id AS "repoId", poll_id AS "pollId", state, problem FROM domains
        WHERE hostname = ${check.hostname} FOR UPDATE`
      if (before === undefined || before.state === "removing") return "removed" as const
      if (before.pollId !== check.pollId) return "superseded" as const
      yield* sql`
        UPDATE domains SET provider_id = COALESCE(${check.providerId ?? null}, provider_id), state = ${check.state},
          verification = COALESCE(${check.verification ?? null}, verification),
          certificate = COALESCE(${check.certificate ?? null}, certificate),
          records = COALESCE(${check.records === undefined ? null : JSON.stringify(check.records)}::jsonb, records),
          problem = ${check.problem}, checked_at = now()
        WHERE hostname = ${check.hostname}`
      if (before.state !== check.state || before.problem !== check.problem) {
        yield* sql`
          INSERT INTO domain_events (hostname, repo_id, action, state, problem)
          VALUES (${check.hostname}, ${before.repoId}, 'check', ${check.state}, ${check.problem})`
      }
      return "written" as const
    }))
  })

/**
 * Marks `hostname` of `repoId` as being removed and records `remove` once. Its provider id, `null` when it was never
 * registered; none when the repository holds no such domain. A retry under the same invocation key finds only the row
 * it marked, never one added again after it was erased.
 */
export const withdraw = (write: {
  readonly hostname: string
  readonly repoId: string
  readonly actorId: string
  readonly invocationKey: string
}): Effect.Effect<Option.Option<{ readonly providerId: string | null }>, unknown, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    return yield* sql.withTransaction(Effect.gen(function* () {
      const [receipt] = yield* sql<{ readonly id: string }>`
        SELECT id FROM domain_events WHERE invocation_key = ${write.invocationKey}`
      if (receipt !== undefined) {
        // The first try marked its row and recorded `remove` together. Its row is still removing, or erased: a row
        // claimed since (`add` after the receipt) is another registration.
        const [marked] = yield* sql<{ readonly providerId: string | null }>`
          SELECT provider_id AS "providerId" FROM domains
          WHERE hostname = ${write.hostname} AND repo_id = ${write.repoId} AND state = 'removing'
            AND NOT EXISTS (
              SELECT 1 FROM domain_events WHERE hostname = ${write.hostname} AND action = 'add' AND id > ${receipt.id})`
        return Option.fromUndefinedOr(marked)
      }
      const [row] = yield* sql<{ readonly providerId: string | null }>`
        UPDATE domains SET state = 'removing', updated_by = ${write.actorId}, updated_at = now()
        WHERE hostname = ${write.hostname} AND repo_id = ${write.repoId}
        RETURNING provider_id AS "providerId"`
      if (row === undefined) return Option.none()
      yield* sql`
        INSERT INTO domain_events (hostname, repo_id, action, actor_id, invocation_key, state)
        VALUES (${write.hostname}, ${write.repoId}, 'remove', ${write.actorId}, ${write.invocationKey}, 'removing')`
      return Option.some(row)
    }))
  })

/** Deletes `hostname`'s row once it is being removed. */
export const erase = (hostname: string): Effect.Effect<void, unknown, SqlClient.SqlClient> =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    Effect.asVoid(sql`DELETE FROM domains WHERE hostname = ${hostname} AND state = 'removing'`))

/** The repository that holds `hostname`, if any: what a route checks before it starts a claim. */
export const holder = (hostname: string): Effect.Effect<Option.Option<string>, unknown, SqlClient.SqlClient> =>
  Effect.map(read(hostname), Option.map((row) => row.repoId))

/** Whether `hostname` is a verified custom domain, its row `active`: a host sign-in hands sessions to (decision 0130). */
export const active = (hostname: string): Effect.Effect<boolean, unknown, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const rows = yield* sql`SELECT 1 FROM domains WHERE hostname = ${hostname} AND state = 'active'`
    return rows.length > 0
  })

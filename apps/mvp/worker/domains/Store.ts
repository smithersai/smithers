import { Effect, Option } from "effect"
import { SqlClient } from "effect/sql"
import type { Role } from "../Actor.ts"
import * as ProtectedAuthority from "../ProtectedAuthority.ts"
import type * as WriteAuthority from "../WriteAuthority.ts"
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
 * (`removing`) or, for a refresh, already removed (`missing`), or nothing again (`repeat`). `stale` when the person who
 * asked no longer holds the session or the role the route admitted.
 */
export type Claim = "add" | "refresh" | "taken" | "removing" | "missing" | "repeat" | "stale"

/** The roles that may change a repository's domains (0007 `repo:domain-write`). */
export const MANAGERS: ReadonlyArray<Role> = ["maintainer", "admin"]

/** The authority a domain step runs under: the session the route admitted, `null` for sessionless local development. */
export type Authority = WriteAuthority.Session | null | undefined

/**
 * Whether the person who started the flow still holds the session and a managing role, read under the session and
 * person locks (`ProtectedAuthority.check`). A payload recorded before steps carried authority is `denied`: it fails
 * closed rather than guess. Call inside the transaction whose writes depend on it.
 */
export const authorized = (
  authority: Authority,
): Effect.Effect<"held" | "unavailable" | "denied", unknown, SqlClient.SqlClient> =>
  authority === undefined ? Effect.succeed("denied" as const) : ProtectedAuthority.check(authority, MANAGERS)

/** `authorized` in its own transaction: what a step asks before it calls the provider. */
export const authorizedNow = (
  authority: Authority,
): Effect.Effect<"held" | "unavailable" | "denied", unknown, SqlClient.SqlClient> =>
  Effect.flatMap(SqlClient.SqlClient, (sql) => sql.withTransaction(authorized(authority)))

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
  readonly authority?: Authority
}): Effect.Effect<Claim, unknown, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    return yield* sql.withTransaction(Effect.gen(function* () {
      yield* lockHostname(write.hostname)
      if (yield* repeated(write.invocationKey)) return "repeat" as const
      if ((yield* authorized(write.authority)) !== "held") return "stale" as const
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
      yield* ProtectedAuthority.requireAtCommit(write.authority)
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
  /** Who the poll acts for: the row changes only while they still hold their session and a managing role. */
  readonly authority?: Authority
}

/**
 * Writes what `check` found, if poll `check.pollId` still owns the row and it isn't being removed, and records a
 * `check` event when the state or the problem changed: `written`; `removed` when the row is gone or being removed;
 * `superseded` when another poll owns it. `denied` or `unavailable`, and nothing written, when the poll's person no
 * longer holds the authority: a domain is never promoted for someone demoted or signed out since the provider answered.
 */
export const record = (
  check: Check,
): Effect.Effect<"written" | "removed" | "superseded" | "denied" | "unavailable", unknown, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    return yield* sql.withTransaction(Effect.gen(function* () {
      const held = yield* authorized(check.authority)
      if (held !== "held") return held
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
      yield* ProtectedAuthority.requireAtCommit(check.authority)
      return "written" as const
    }))
  })

/**
 * Marks `hostname` of `repoId` as being removed and records `remove` once. Its provider id, `null` when it was never
 * registered; none when the repository holds no such domain. A retry under the same invocation key finds only the row
 * it marked, never one added again after it was erased. `stale`, on a first try or a retry, when the person who asked
 * no longer holds the authority: the caller then leaves the provider alone.
 */
export const withdraw = (write: {
  readonly hostname: string
  readonly repoId: string
  readonly actorId: string
  readonly invocationKey: string
  readonly authority?: Authority
}): Effect.Effect<Option.Option<{ readonly providerId: string | null }> | "stale", unknown, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    return yield* sql.withTransaction(Effect.gen(function* () {
      if ((yield* authorized(write.authority)) !== "held") return "stale" as const
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
      yield* ProtectedAuthority.requireAtCommit(write.authority)
      return Option.some(row)
    }))
  })

/**
 * Deletes `hostname`'s row once it is being removed: `erased`, or `stale` with the row kept when the person who asked
 * lost the authority while the provider was forgetting it, or none was given. A later removal by someone who holds it finishes the job.
 */
export const erase = (
  hostname: string,
  authority?: Authority,
): Effect.Effect<"erased" | "stale", unknown, SqlClient.SqlClient> =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    sql.withTransaction(Effect.gen(function* () {
      if ((yield* authorized(authority)) !== "held") return "stale" as const
      yield* sql`DELETE FROM domains WHERE hostname = ${hostname} AND state = 'removing'`
      yield* ProtectedAuthority.requireAtCommit(authority)
      return "erased" as const
    })))

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

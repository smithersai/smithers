import * as WriteAuthority from "../WriteAuthority.ts"
import { Effect, Option } from "effect"
import { SqlClient } from "effect/sql"
import type { ModelTier } from "../../src/features/model/contract.ts"
import type { ConnectionKind, Protocol, SavedConnection } from "../../src/features/personal-model/contract.ts"

// The personal model tables (db/migrations/0056_personal_models.ts, 0065_model_tiers.ts and 0075_model_connections.ts,
// docs/features/personal-model.md#postgres): each person's ordered connections, their sealed credentials and the model
// each tier uses on them, their audit, and the ledger of the calls they answered. Nothing here reads or writes a plaintext
// credential; only `model/Put`, `model/Delete` and `model/CodexLink` write a `personal_models` row, a Codex refresh its
// credential, and the model endpoint only its failure.

/** A sealed credential as Postgres keeps it. */
export interface Sealed {
  readonly ciphertext: string
  readonly nonce: string
  readonly keyVersion: number
}

/** One of a person's connections: where it answers, the model each tier uses on it, and its credential, sealed. */
export interface Saved extends Sealed, SavedConnection {}

/** A connection a save keeps: where it goes in the list, and, when the person typed it again, the credential sealed. */
export interface ConnectionWrite {
  readonly id: string
  readonly kind: ConnectionKind
  readonly active: boolean
  readonly protocol: Protocol | null
  readonly baseUrl: string | null
  readonly models: Readonly<Partial<Record<ModelTier, string>>>
  readonly sealed?: Sealed & { readonly keyLast4: string } | undefined
}

/**
 * One save a flow step makes, under its invocation key, so a step run again writes and records once: every connection
 * the person keeps, in their order.
 */
export interface Put {
  readonly personId: string
  readonly connections: ReadonlyArray<ConnectionWrite>
  readonly authority?: WriteAuthority.Session | null
  readonly invocationKey: string
}

/**
 * What a save did: `set` the person's first connections, `replace` their list, nothing again (`repeat`), or nothing at
 * all (`stale`): a connection it kept without its credential was removed or moved to another base URL since the route
 * checked it, so a write would have pointed it somewhere the person never typed it for.
 */
export type Change = "set" | "replace" | "repeat" | "stale"

const repeated = (invocationKey: string) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    Effect.map(
      sql<{ readonly id: string }>`SELECT id FROM personal_model_events WHERE invocation_key = ${invocationKey}`,
      (rows) => rows.length > 0,
    ))

/** Serializes list changes even when no credential row exists (including after a deletion). */
const holdConnections = (personId: string) => Effect.flatMap(SqlClient.SqlClient, (sql) =>
  sql`SELECT pg_advisory_xact_lock(hashtextextended(${`personal-model:${personId}`}, 0))`)

/** A deletion or list replacement supersedes a pending link: a pending device link cannot undo it, even for an empty list. */
export const linkGeneration = (personId: string) => Effect.flatMap(SqlClient.SqlClient, (sql) => Effect.map(
  sql<{ readonly generation: string }>`SELECT coalesce(max(id), 0)::text AS generation FROM personal_model_events
    WHERE person_id = ${personId} AND action IN ('delete', 'replace')`,
  (rows) => rows[0]!.generation,
))

/**
 * Writes `put`'s list in one transaction and records `set` or `replace` once: removes the person's connections it leaves
 * out, writes each with a new credential (clearing any failure the earlier one had), keeps each other credential where
 * it is, and sets every connection's place, activity and tiers. Nothing, `stale`, when a kept connection is gone or
 * elsewhere now. A connection that was deactivated first, so a save that swaps which of two subscriptions is active
 * never holds both.
 */
export const put = (write: Put): Effect.Effect<Change, unknown, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    return yield* sql.withTransaction(Effect.gen(function* () {
      yield* WriteAuthority.bound
      yield* holdConnections(write.personId)
      if (yield* repeated(write.invocationKey)) return "repeat" as const
      if (write.authority !== undefined && !(yield* WriteAuthority.admitted(write.authority))) return "stale" as const
      const before = yield* sql<{
        readonly id: string
        readonly kind: string
        readonly protocol: string | null
        readonly baseUrl: string | null
      }>`
        SELECT id, kind, protocol, base_url AS "baseUrl" FROM personal_models WHERE person_id = ${write.personId} FOR UPDATE`
      const kept = write.connections.filter((connection) => connection.sealed === undefined)
      if (!kept.every((connection) =>
        before.some((row) =>
          row.id === connection.id && row.kind === connection.kind && row.protocol === connection.protocol &&
          row.baseUrl === connection.baseUrl
        )
      )) {
        return "stale" as const
      }
      yield* sql`
        DELETE FROM personal_models WHERE person_id = ${write.personId}
          AND NOT (id IN ${sql.in(write.connections.map((connection) => connection.id))})`
      yield* sql`UPDATE personal_models SET active = false WHERE person_id = ${write.personId}`
      for (const [position, connection] of write.connections.entries()) {
        const { id, kind, active, protocol, baseUrl } = connection
        const fast = connection.models.fast ?? null
        const implement = connection.models.implement ?? null
        const hard = connection.models.hard ?? null
        if (connection.sealed === undefined) {
          yield* sql`
            UPDATE personal_models SET position = ${position}, active = ${active}, fast_model = ${fast},
              implement_model = ${implement}, hard_model = ${hard}, updated_at = now()
            WHERE person_id = ${write.personId} AND id = ${id}`
          continue
        }
        const { ciphertext, nonce, keyVersion, keyLast4 } = connection.sealed
        yield* sql`
          INSERT INTO personal_models (person_id, id, kind, position, active, protocol, base_url, fast_model,
            implement_model, hard_model, ciphertext, nonce, key_version, key_last4, failure_status, failed_at, updated_at)
          VALUES (${write.personId}, ${id}, ${kind}, ${position}, ${active}, ${protocol}, ${baseUrl}, ${fast},
            ${implement}, ${hard}, ${ciphertext}, ${nonce}, ${keyVersion}, ${keyLast4}, NULL, NULL, now())
          ON CONFLICT (person_id, id) DO UPDATE SET
            kind = EXCLUDED.kind, position = EXCLUDED.position, active = EXCLUDED.active, protocol = EXCLUDED.protocol,
            base_url = EXCLUDED.base_url, fast_model = EXCLUDED.fast_model, implement_model = EXCLUDED.implement_model,
            hard_model = EXCLUDED.hard_model, ciphertext = EXCLUDED.ciphertext, nonce = EXCLUDED.nonce,
            key_version = EXCLUDED.key_version, key_last4 = EXCLUDED.key_last4, failure_status = NULL, failed_at = NULL,
            updated_at = now()`
      }
      const change = before.length === 0 ? "set" as const : "replace" as const
      yield* sql`
        INSERT INTO personal_model_events (person_id, action, invocation_key)
        VALUES (${write.personId}, ${change}, ${write.invocationKey})`
      yield* WriteAuthority.requireAtCommit(write.authority ?? undefined)
      return change
    })).pipe(Effect.catchTag("WriteAuthorityExpired", () => Effect.succeed("stale" as const)))
  })

/** A Codex subscription a device link finished: added at the end of the person's list, or replacing the one they have. */
export interface Linked {
  /** The deletion generation observed before requesting the device code; absent legacy links are stale. */
  readonly generation?: string
  readonly personId: string
  readonly id: string
  readonly sealed: Sealed & { readonly keyLast4: string }
  readonly authority?: WriteAuthority.Session | null
  readonly invocationKey: string
}

/**
 * Adds or replaces the person's Codex subscription and records it once. A person holds one: a link replaces its
 * credential and keeps its place and activity, as Amp's reconnect does. A deletion after admission cancels it
 * (`stale`); the per-person transaction lock serializes the generation check with deletes of even an empty list.
 */
export const link = (write: Linked): Effect.Effect<"set" | "replace" | "repeat" | "stale", unknown, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    return yield* sql.withTransaction(Effect.gen(function* () {
      yield* WriteAuthority.bound
      yield* holdConnections(write.personId)
      if (yield* repeated(write.invocationKey)) return "repeat" as const
      if (write.authority !== undefined && !(yield* WriteAuthority.admitted(write.authority))) return "stale" as const
      if (write.generation === undefined || (yield* linkGeneration(write.personId)) !== write.generation) return "stale" as const
      const before = yield* sql<{ readonly kind: string }>`
        SELECT kind FROM personal_models WHERE person_id = ${write.personId} FOR UPDATE`
      const { ciphertext, nonce, keyVersion, keyLast4 } = write.sealed
      const replaced = yield* sql`
        UPDATE personal_models SET ciphertext = ${ciphertext}, nonce = ${nonce}, key_version = ${keyVersion},
          key_last4 = ${keyLast4}, failure_status = NULL, failed_at = NULL, updated_at = now()
        WHERE person_id = ${write.personId} AND kind = 'codex_subscription' RETURNING id`
      if (replaced.length === 0) {
        yield* sql`
          INSERT INTO personal_models (person_id, id, kind, position, active, ciphertext, nonce, key_version, key_last4)
          VALUES (${write.personId}, ${write.id}, 'codex_subscription', ${before.length}, true, ${ciphertext}, ${nonce},
            ${keyVersion}, ${keyLast4})`
      }
      const change = before.length === 0 ? "set" as const : "replace" as const
      yield* sql`
        INSERT INTO personal_model_events (person_id, action, invocation_key)
        VALUES (${write.personId}, ${change}, ${write.invocationKey})`
      yield* WriteAuthority.requireAtCommit(write.authority ?? undefined)
      return replaced.length === 0 ? "set" as const : "replace" as const
    })).pipe(Effect.catchTag("WriteAuthorityExpired", () => Effect.succeed("stale" as const)))
  })

/** Holds `personId`'s Codex rows for the transaction it runs in, so one refresh runs at a time. */
export const holdCodex = (personId: string): Effect.Effect<void, unknown, SqlClient.SqlClient> =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    Effect.asVoid(sql`
      SELECT id FROM personal_models WHERE person_id = ${personId} AND kind = 'codex_subscription' FOR UPDATE`))

/**
 * Replaces a Codex subscription's credential with what a refresh answered, only over the one it refreshed: `false`
 * when another write moved it meanwhile, so a slow refresh never restores a rotated-away token.
 */
export const refreshed = (write: {
  readonly personId: string
  readonly id: string
  readonly from: string
  readonly sealed: Sealed
}): Effect.Effect<boolean, unknown, SqlClient.SqlClient> =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    Effect.map(
      sql`
        UPDATE personal_models SET ciphertext = ${write.sealed.ciphertext}, nonce = ${write.sealed.nonce},
          key_version = ${write.sealed.keyVersion}, failure_status = NULL, failed_at = NULL
        WHERE person_id = ${write.personId} AND id = ${write.id} AND ciphertext = ${write.from} RETURNING id`,
      (rows) => rows.length > 0,
    ))

/** Deletes a person's connections and records `delete` once: whether any was there, or nothing again (`repeat`). */
export const remove = (write: {
  readonly personId: string
  readonly authority?: WriteAuthority.Session | null
  readonly invocationKey: string
}): Effect.Effect<"deleted" | "missing" | "repeat" | "stale", unknown, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    return yield* sql.withTransaction(Effect.gen(function* () {
      yield* WriteAuthority.bound
      yield* holdConnections(write.personId)
      if (yield* repeated(write.invocationKey)) return "repeat" as const
      if (write.authority !== undefined && !(yield* WriteAuthority.admitted(write.authority))) return "stale" as const
      const deleted = yield* sql`DELETE FROM personal_models WHERE person_id = ${write.personId} RETURNING person_id`
      yield* sql`
        INSERT INTO personal_model_events (person_id, action, invocation_key)
        VALUES (${write.personId}, 'delete', ${write.invocationKey})`
      yield* WriteAuthority.requireAtCommit(write.authority ?? undefined)
      return deleted.length > 0 ? "deleted" as const : "missing" as const
    })).pipe(Effect.catchTag("WriteAuthorityExpired", () => Effect.succeed("stale" as const)))
  })

/** Whether a person saved a model of their own: a flow that runs on it, such as triage's judge, can answer them. */
export const hasModel = (personId: string): Effect.Effect<boolean, unknown, SqlClient.SqlClient> =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    Effect.map(sql`SELECT 1 FROM personal_models WHERE person_id = ${personId} LIMIT 1`, (rows) => rows.length > 0))

/** A person's connections, with their tiers' models and sealed credentials, in their order; none when they saved none. */
export const saved = (personId: string): Effect.Effect<ReadonlyArray<Saved>, unknown, SqlClient.SqlClient> =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    sql<Saved>`
      SELECT id, kind, active, protocol, base_url AS "baseUrl", fast_model AS "fastModel",
        implement_model AS "implementModel", hard_model AS "hardModel", ciphertext, nonce, key_version AS "keyVersion"
      FROM personal_models WHERE person_id = ${personId} ORDER BY position, id`)

/**
 * A call a person's own model is about to answer: its ids, whose model, its role, the model id, the key that answers it
 * (by protocol) and the tier that answered, none for a test.
 */
export interface Call {
  readonly invocationId: string
  readonly requestId: string
  readonly personId: string
  readonly role: string
  readonly modelId: string
  readonly connectionId: string
  readonly protocol: Protocol | null
  readonly tier: ModelTier | undefined
}

/** Writes the call's ledger row, unsettled. */
export const begin = (call: Call): Effect.Effect<void, unknown, SqlClient.SqlClient> =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    Effect.asVoid(sql`
      INSERT INTO personal_model_usage (invocation_id, request_id, person_id, role, model_id, connection_id, protocol, tier)
      VALUES (${call.invocationId}, ${call.requestId}, ${call.personId}, ${call.role}, ${call.modelId},
        ${call.connectionId}, ${call.protocol}, ${call.tier ?? null})
      ON CONFLICT (invocation_id) DO NOTHING`))

/** How a call a person's own model answered ended, as the model reported it. */
export interface Ended {
  readonly invocationId: string
  readonly outcome: "success" | "failed" | "interrupted"
  readonly inputTokens: number | undefined
  readonly outputTokens: number | undefined
  readonly errorCode: string | undefined
  readonly httpStatus: number | undefined
}

/**
 * Settles a call's ledger row, once: what it spent (0 for a count the model never reported) and how it ended. The
 * person whose model answered it when this call is theirs and unsettled; none for any other call, a deployment's
 * included, or one settled already.
 */
export const settle = (ended: Ended): Effect.Effect<Option.Option<string>, unknown, SqlClient.SqlClient> =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    Effect.map(
      sql<{ readonly personId: string }>`
        UPDATE personal_model_usage SET input_tokens = ${ended.inputTokens ?? 0},
          output_tokens = ${ended.outputTokens ?? 0}, outcome = ${ended.outcome}, error_code = ${ended.errorCode ?? null},
          http_status = ${ended.httpStatus ?? null}, settled_at = now()
        WHERE invocation_id = ${ended.invocationId} AND settled_at IS NULL
        RETURNING person_id AS "personId"`,
      (rows) => Option.fromNullishOr(rows[0]?.personId),
    ))

/**
 * Records, from the call `invocationId` settled, that the person's connection (the one that answered it) was refused or
 * ran out with the provider's `status` (401, 402, 403, or a 429 that said so), or, with none, that it answered again, clearing the last refusal. Only
 * a call made with the row's current key marks it: a slow call on a key the person has since replaced says nothing of
 * the new one. A run of successful calls writes nothing.
 */
export const mark = (invocationId: string, status: number | undefined): Effect.Effect<void, unknown, SqlClient.SqlClient> =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    Effect.asVoid(
      status === undefined
        ? sql`
          UPDATE personal_models m SET failure_status = NULL, failed_at = NULL
          FROM personal_model_usage u
          WHERE u.invocation_id = ${invocationId} AND m.person_id = u.person_id AND m.id = u.connection_id
            AND m.updated_at <= u.created_at AND m.failure_status IS NOT NULL`
        : sql`
          UPDATE personal_models m SET failure_status = ${status}, failed_at = now()
          FROM personal_model_usage u
          WHERE u.invocation_id = ${invocationId} AND m.person_id = u.person_id AND m.id = u.connection_id
            AND m.updated_at <= u.created_at`,
    ))

/**
 * Records that a credential the box's egress sent was refused with `status`, or with none that it answered again: the
 * vendor's agent runs in the box, so no call of ours sees the refusal. Writes only when the status changes.
 */
export const markConnection = (
  personId: string,
  connectionId: string,
  status: number | undefined,
): Effect.Effect<void, unknown, SqlClient.SqlClient> =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    Effect.asVoid(
      status === undefined
        ? sql`
          UPDATE personal_models SET failure_status = NULL, failed_at = NULL
          WHERE person_id = ${personId} AND id = ${connectionId} AND failure_status IS NOT NULL`
        : sql`
          UPDATE personal_models SET failure_status = ${status}, failed_at = now()
          WHERE person_id = ${personId} AND id = ${connectionId}
            AND failure_status IS DISTINCT FROM ${status}`,
    ))

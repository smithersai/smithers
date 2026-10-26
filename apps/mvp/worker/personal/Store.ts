import { Effect, Option } from "effect"
import { SqlClient } from "effect/sql"
import type { ModelTier } from "../../src/features/model/contract.ts"
import type { Protocol, SavedKey, TierChoice } from "../../src/features/personal-model/contract.ts"

// The personal model tables (db/migrations/0056_personal_models.ts and 0065_model_tiers.ts,
// docs/features/personal-model.md#postgres): each person's sealed keys, one per protocol, with the model each tier
// uses on them, their audit, and the ledger of the calls they answered. Nothing here reads or writes a plaintext key;
// only `model/Put` and `model/Delete` write a `personal_models` row, and the model endpoint only its failure.

/** A sealed key as Postgres keeps it. */
export interface Sealed {
  readonly ciphertext: string
  readonly nonce: string
  readonly keyVersion: number
}

/** One of a person's saved keys: where it answers, the model each tier uses on it, and the key, sealed. */
export interface Saved extends Sealed, SavedKey {}

/** A key a save keeps: its protocol and base URL, and, when the person typed it again, the key sealed. */
export interface KeyWrite {
  readonly protocol: Protocol
  readonly baseUrl: string
  readonly sealed?: Sealed & { readonly keyLast4: string } | undefined
}

/**
 * One save a flow step makes, under its invocation key, so a step run again writes and records once: every key the
 * person keeps, and the model of each tier they named.
 */
export interface Put {
  readonly personId: string
  readonly keys: ReadonlyArray<KeyWrite>
  readonly models: Readonly<Partial<Record<ModelTier, TierChoice>>>
  readonly invocationKey: string
}

/**
 * What a save did: `set` the person's first keys, `replace` their keys, nothing again (`repeat`), or nothing at all
 * (`stale`): a key it kept without its value was removed or moved to another base URL since the route checked it, so a
 * write would have pointed it somewhere the person never typed it for.
 */
export type Change = "set" | "replace" | "repeat" | "stale"

const repeated = (invocationKey: string) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    Effect.map(
      sql<{ readonly id: string }>`SELECT id FROM personal_model_events WHERE invocation_key = ${invocationKey}`,
      (rows) => rows.length > 0,
    ))

/** The model id `tier` uses on the key `protocol`, as `put` names it, or `null`. */
const modelOn = (write: Put, tier: ModelTier, protocol: Protocol) => {
  const choice = write.models[tier]
  return choice?.protocol === protocol ? choice.modelId : null
}

/**
 * Writes `put`'s configuration in one transaction and records `set` or `replace` once: removes the person's keys it
 * leaves out, writes each key it sealed (clearing any failure the earlier key had), keeps each other key where it is,
 * and sets every key's tier columns, so each named tier is on exactly one key. Nothing, `stale`, when a kept key is gone
 * or at another base URL now.
 */
export const put = (write: Put): Effect.Effect<Change, unknown, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    return yield* sql.withTransaction(Effect.gen(function* () {
      if (yield* repeated(write.invocationKey)) return "repeat" as const
      const before = yield* sql<{ readonly protocol: Protocol; readonly baseUrl: string }>`
        SELECT protocol, base_url AS "baseUrl" FROM personal_models WHERE person_id = ${write.personId} FOR UPDATE`
      const kept = write.keys.filter((key) => key.sealed === undefined)
      if (!kept.every((key) => before.some((row) => row.protocol === key.protocol && row.baseUrl === key.baseUrl))) {
        return "stale" as const
      }
      const protocols = write.keys.map((key) => key.protocol)
      yield* sql`
        DELETE FROM personal_models WHERE person_id = ${write.personId} AND NOT (protocol IN ${sql.in(protocols)})`
      for (const key of write.keys) {
        const fast = modelOn(write, "fast", key.protocol)
        const implement = modelOn(write, "implement", key.protocol)
        const hard = modelOn(write, "hard", key.protocol)
        if (key.sealed === undefined) {
          yield* sql`
            UPDATE personal_models SET fast_model = ${fast}, implement_model = ${implement}, hard_model = ${hard},
              updated_at = now()
            WHERE person_id = ${write.personId} AND protocol = ${key.protocol}`
          continue
        }
        const { ciphertext, nonce, keyVersion, keyLast4 } = key.sealed
        yield* sql`
          INSERT INTO personal_models (person_id, protocol, base_url, fast_model, implement_model, hard_model, ciphertext,
            nonce, key_version, key_last4, failure_status, failed_at, updated_at)
          VALUES (${write.personId}, ${key.protocol}, ${key.baseUrl}, ${fast}, ${implement}, ${hard}, ${ciphertext},
            ${nonce}, ${keyVersion}, ${keyLast4}, NULL, NULL, now())
          ON CONFLICT (person_id, protocol) DO UPDATE SET
            base_url = EXCLUDED.base_url, fast_model = EXCLUDED.fast_model, implement_model = EXCLUDED.implement_model,
            hard_model = EXCLUDED.hard_model, ciphertext = EXCLUDED.ciphertext, nonce = EXCLUDED.nonce,
            key_version = EXCLUDED.key_version, key_last4 = EXCLUDED.key_last4, failure_status = NULL, failed_at = NULL,
            updated_at = now()`
      }
      const change = before.length === 0 ? "set" as const : "replace" as const
      yield* sql`
        INSERT INTO personal_model_events (person_id, action, invocation_key)
        VALUES (${write.personId}, ${change}, ${write.invocationKey})`
      return change
    }))
  })

/** Deletes a person's keys and records `delete` once: whether any was there, or nothing again (`repeat`). */
export const remove = (write: {
  readonly personId: string
  readonly invocationKey: string
}): Effect.Effect<"deleted" | "missing" | "repeat", unknown, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    return yield* sql.withTransaction(Effect.gen(function* () {
      if (yield* repeated(write.invocationKey)) return "repeat" as const
      const deleted = yield* sql`DELETE FROM personal_models WHERE person_id = ${write.personId} RETURNING person_id`
      yield* sql`
        INSERT INTO personal_model_events (person_id, action, invocation_key)
        VALUES (${write.personId}, 'delete', ${write.invocationKey})`
      return deleted.length > 0 ? "deleted" as const : "missing" as const
    }))
  })

/** A person's saved keys, with their tiers' models and sealed keys, in protocol order; none when they saved none. */
export const saved = (personId: string): Effect.Effect<ReadonlyArray<Saved>, unknown, SqlClient.SqlClient> =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    sql<Saved>`
      SELECT protocol, base_url AS "baseUrl", fast_model AS "fastModel", implement_model AS "implementModel",
        hard_model AS "hardModel", ciphertext, nonce, key_version AS "keyVersion"
      FROM personal_models WHERE person_id = ${personId} ORDER BY protocol`)

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
  readonly protocol: Protocol
  readonly tier: ModelTier | undefined
}

/** Writes the call's ledger row, unsettled. */
export const begin = (call: Call): Effect.Effect<void, unknown, SqlClient.SqlClient> =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    Effect.asVoid(sql`
      INSERT INTO personal_model_usage (invocation_id, request_id, person_id, role, model_id, protocol, tier)
      VALUES (${call.invocationId}, ${call.requestId}, ${call.personId}, ${call.role}, ${call.modelId},
        ${call.protocol}, ${call.tier ?? null})`))

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
 * Records, from the call `invocationId` settled, that the person's key (the one that answered it) was refused or ran out with the provider's
 * `status` (401, 402, 403, or a 429 that said so), or, with none, that it answered again, clearing the last refusal. Only
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
          WHERE u.invocation_id = ${invocationId} AND m.person_id = u.person_id AND m.protocol = u.protocol
            AND m.updated_at <= u.created_at AND m.failure_status IS NOT NULL`
        : sql`
          UPDATE personal_models m SET failure_status = ${status}, failed_at = now()
          FROM personal_model_usage u
          WHERE u.invocation_id = ${invocationId} AND m.person_id = u.person_id AND m.protocol = u.protocol
            AND m.updated_at <= u.created_at`,
    ))

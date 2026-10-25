import { Effect, Option } from "effect"
import { SqlClient } from "effect/sql"
import type { Protocol } from "../../src/features/personal-model/contract.ts"

// The personal model tables (db/migrations/0056_personal_models.ts, docs/features/personal-model.md#postgres): each
// person's sealed model, its audit, and the ledger of the calls it answered. Nothing here reads or writes a plaintext
// key; only `model/Put` and `model/Delete` write a `personal_models` row, and the model endpoint only its failure.

/** A sealed key as Postgres keeps it. */
export interface Sealed {
  readonly ciphertext: string
  readonly nonce: string
  readonly keyVersion: number
}

/** A person's saved model: where it answers, and its sealed key. */
export interface Saved extends Sealed {
  readonly protocol: Protocol
  readonly baseUrl: string
  readonly modelId: string
}

/** One save a flow step makes, under its invocation key, so a step run again writes and records once. */
export interface Put extends Saved {
  readonly personId: string
  readonly keyLast4: string
  readonly invocationKey: string
}

/** What a save did: `set` a new model, `replace` the person's model, or nothing again (`repeat`). */
export type Change = "set" | "replace" | "repeat"

const repeated = (invocationKey: string) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    Effect.map(
      sql<{ readonly id: string }>`SELECT id FROM personal_model_events WHERE invocation_key = ${invocationKey}`,
      (rows) => rows.length > 0,
    ))

/** Writes `put`'s model and sealed key, clears any failure its earlier key had, and records `set` or `replace` once. */
export const put = (write: Put): Effect.Effect<Change, unknown, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    return yield* sql.withTransaction(Effect.gen(function* () {
      if (yield* repeated(write.invocationKey)) return "repeat" as const
      const [row] = yield* sql<{ readonly inserted: boolean }>`
        INSERT INTO personal_models (person_id, protocol, base_url, model_id, ciphertext, nonce, key_version, key_last4,
          failure_status, failed_at, updated_at)
        VALUES (${write.personId}, ${write.protocol}, ${write.baseUrl}, ${write.modelId}, ${write.ciphertext},
          ${write.nonce}, ${write.keyVersion}, ${write.keyLast4}, NULL, NULL, now())
        ON CONFLICT (person_id) DO UPDATE SET
          protocol = EXCLUDED.protocol, base_url = EXCLUDED.base_url, model_id = EXCLUDED.model_id,
          ciphertext = EXCLUDED.ciphertext, nonce = EXCLUDED.nonce, key_version = EXCLUDED.key_version,
          key_last4 = EXCLUDED.key_last4, failure_status = NULL, failed_at = NULL, updated_at = now()
        RETURNING (xmax = 0) AS inserted`
      const change = row!.inserted ? "set" as const : "replace" as const
      yield* sql`
        INSERT INTO personal_model_events (person_id, action, invocation_key)
        VALUES (${write.personId}, ${change}, ${write.invocationKey})`
      return change
    }))
  })

/** Deletes a person's model and records `delete` once: whether it was there, or nothing again (`repeat`). */
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

/** A person's saved model and its sealed key, if they saved one. */
export const saved = (personId: string): Effect.Effect<Option.Option<Saved>, unknown, SqlClient.SqlClient> =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    Effect.map(
      sql<Saved>`
        SELECT protocol, base_url AS "baseUrl", model_id AS "modelId", ciphertext, nonce, key_version AS "keyVersion"
        FROM personal_models WHERE person_id = ${personId}`,
      (rows) => Option.fromNullishOr(rows[0]),
    ))

/** A call a person's own model is about to answer: its ids, whose model, and its role and model id. */
export interface Call {
  readonly invocationId: string
  readonly requestId: string
  readonly personId: string
  readonly role: string
  readonly modelId: string
}

/** Writes the call's ledger row, unsettled. */
export const begin = (call: Call): Effect.Effect<void, unknown, SqlClient.SqlClient> =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    Effect.asVoid(sql`
      INSERT INTO personal_model_usage (invocation_id, request_id, person_id, role, model_id)
      VALUES (${call.invocationId}, ${call.requestId}, ${call.personId}, ${call.role}, ${call.modelId})`))

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
 * Records, from the call `invocationId` settled, that the person's key was refused or ran out with the provider's
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
          WHERE u.invocation_id = ${invocationId} AND m.person_id = u.person_id AND m.updated_at <= u.created_at
            AND m.failure_status IS NOT NULL`
        : sql`
          UPDATE personal_models m SET failure_status = ${status}, failed_at = now()
          FROM personal_model_usage u
          WHERE u.invocation_id = ${invocationId} AND m.person_id = u.person_id AND m.updated_at <= u.created_at`,
    ))

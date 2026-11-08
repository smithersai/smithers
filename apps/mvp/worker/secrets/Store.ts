import * as ProtectedAuthority from "../ProtectedAuthority.ts"
import * as WriteAuthority from "../WriteAuthority.ts"
import { Data, Effect } from "effect"
import { SqlClient } from "effect/sql"

// The secrets tables (db/migrations/0021_secrets.ts, docs/features/secrets.md#tables): the sealed values, their bindings
// and the audit. Nothing here reads or writes a plaintext value; only `secret/Put` and `secret/Delete` write `secrets`.

/** A sealed value as Postgres keeps it. */
export interface Sealed {
  readonly ciphertext: string
  readonly nonce: string
  readonly keyVersion: number
}

/** A secret's binding: its name, the hosts and the methods its value may go to. */
export interface Binding {
  readonly name: string
  readonly hosts: ReadonlyArray<string>
  readonly methods: ReadonlyArray<string> | null
}

/** One write a flow step makes, under its invocation key, so a step run again writes and records once. */
export interface Put extends Sealed, Omit<Binding, "methods"> {
  readonly repoId: string
  readonly methods: ReadonlyArray<string> | undefined
  readonly actorId: string
  readonly authority?: WriteAuthority.Session | null
  readonly invocationKey: string
}

/** What a write did: `set` a new secret, `replace` an existing one, or nothing again (`repeat`). */
export type Change = "set" | "replace" | "repeat" | "stale"

const repeated = (invocationKey: string) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    Effect.map(
      sql<{ readonly id: string }>`SELECT id FROM secret_events WHERE invocation_key = ${invocationKey}`,
      (rows) => rows.length > 0,
    ))

/** Writes `put`'s sealed value and binding, and records `set` or `replace` once. */
export const put = (write: Put): Effect.Effect<Change, unknown, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    return yield* sql.withTransaction(Effect.gen(function* () {
      yield* WriteAuthority.bound
      if (yield* repeated(write.invocationKey)) return "repeat" as const
      if (write.authority !== undefined && !(yield* ProtectedAuthority.holds(write.authority, ["admin"]))) return "stale" as const
      const [row] = yield* sql<{ readonly inserted: boolean }>`
        INSERT INTO secrets (repo_id, name, ciphertext, nonce, key_version, hosts, methods, updated_by, updated_at)
        VALUES (${write.repoId}, ${write.name}, ${write.ciphertext}, ${write.nonce}, ${write.keyVersion},
          ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify(write.hosts)}::jsonb)),
          CASE WHEN ${write.methods === undefined ? null : JSON.stringify(write.methods)}::jsonb IS NULL THEN NULL
            ELSE ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify(write.methods ?? [])}::jsonb)) END,
          ${write.actorId}, now())
        ON CONFLICT (repo_id, name) DO UPDATE SET
          ciphertext = EXCLUDED.ciphertext, nonce = EXCLUDED.nonce, key_version = EXCLUDED.key_version,
          hosts = EXCLUDED.hosts, methods = EXCLUDED.methods, updated_by = EXCLUDED.updated_by, updated_at = now()
        RETURNING (xmax = 0) AS inserted`
      const change = row!.inserted ? "set" as const : "replace" as const
      yield* sql`
        INSERT INTO secret_events (repo_id, action, names, actor_id, invocation_key)
        VALUES (${write.repoId}, ${change}, ARRAY[${write.name}]::text[], ${write.actorId}, ${write.invocationKey})`
      yield* ProtectedAuthority.requireAtCommit(write.authority)
      return change
    })).pipe(Effect.catchTag("WriteAuthorityExpired", () => Effect.succeed("stale" as const)))
  })

/** Deletes a secret and records `delete` once: whether it was there, or nothing again (`repeat`). */
export const remove = (write: {
  readonly repoId: string
  readonly name: string
  readonly actorId: string
  readonly authority?: WriteAuthority.Session | null
  readonly invocationKey: string
}): Effect.Effect<"deleted" | "missing" | "repeat" | "stale", unknown, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    return yield* sql.withTransaction(Effect.gen(function* () {
      yield* WriteAuthority.bound
      if (yield* repeated(write.invocationKey)) return "repeat" as const
      if (write.authority !== undefined && !(yield* ProtectedAuthority.holds(write.authority, ["admin"]))) return "stale" as const
      const deleted = yield* sql`
        DELETE FROM secrets WHERE repo_id = ${write.repoId} AND name = ${write.name} RETURNING name`
      yield* sql`
        INSERT INTO secret_events (repo_id, action, names, actor_id, invocation_key)
        VALUES (${write.repoId}, 'delete', ARRAY[${write.name}]::text[], ${write.actorId}, ${write.invocationKey})`
      yield* ProtectedAuthority.requireAtCommit(write.authority)
      return deleted.length > 0 ? "deleted" as const : "missing" as const
    })).pipe(Effect.catchTag("WriteAuthorityExpired", () => Effect.succeed("stale" as const)))
  })

/** A repository's bindings, by name: never a ciphertext. */
export const bindings = (repoId: string): Effect.Effect<ReadonlyArray<Binding>, unknown, SqlClient.SqlClient> =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    sql<Binding>`SELECT name, hosts, methods FROM secrets WHERE repo_id = ${repoId} ORDER BY name`)

/** There is no such secret: it was deleted after the request's policy was read. */
export class Missing extends Data.TaggedError("@smthrs/mvp/secrets/Missing")<{}> {}

/** One secret's sealed value; `Missing` when there is none. */
export const sealed = (repoId: string, name: string): Effect.Effect<Sealed, unknown, SqlClient.SqlClient> =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    Effect.flatMap(
      sql<Sealed>`
        SELECT ciphertext, nonce, key_version AS "keyVersion" FROM secrets WHERE repo_id = ${repoId} AND name = ${name}`,
      (rows) => (rows[0] === undefined ? Effect.fail(new Missing()) : Effect.succeed(rows[0])),
    ))

/** One egress decision, as the audit keeps it: the guest's scope, the host, the method, the outcome and the names. */
export interface Use {
  readonly repoId: string
  readonly scope: string
  readonly host: string
  readonly method: string
  readonly outcome: string
  readonly names: ReadonlyArray<string>
}

/** Records one egress decision. */
export const recordUse = (use: Use): Effect.Effect<void, unknown, SqlClient.SqlClient> =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    Effect.asVoid(sql`
      INSERT INTO secret_events (repo_id, action, names, scope, host, method, outcome)
      VALUES (${use.repoId}, 'use', ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify(use.names)}::jsonb)),
        ${use.scope}, ${use.host}, ${use.method},
        ${use.outcome})`))

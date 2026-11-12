/**
 * Durable credential persistence over `@smthrs/database`.
 *
 * This is the host adapter behind {@link CredentialStore} on any runtime with
 * a SQL database — the Node composition uses `@smthrs/database/node`, and
 * tests use its in-memory SQLite driver. The module itself imports no `node:*`
 * API: it speaks the driver-neutral SQL contract, so it stays bundleable and a
 * browser host that ships a SQL driver can use it unchanged.
 *
 * Only ciphertext is stored. The row carries no key material, and the
 * compare-and-set on `version` is what makes two concurrent rotations
 * serializable: the loser is refused with `CredentialConflict` instead of
 * clobbering the winner.
 *
 * @since 0.1.0
 */

import { DurableWriter } from "@smthrs/database/DurableWriter"
import { Effect, Layer, Option } from "effect"
import * as SqlClient from "effect/sql/SqlClient"
import { CredentialConflict, PersistenceError } from "./ControlError.ts"
import * as CredentialStore from "./CredentialStore.ts"
import { sealsMatch } from "./internal/sealsMatch.ts"
import { initial } from "./migrations/0001_control_tables.ts"

interface Row {
  readonly id: string
  readonly name: string
  readonly ciphertext: string
  readonly nonce: string
  readonly version: number
  readonly updated_at_ms: number
}

const toRecord = (row: Row): CredentialStore.SealedRecord => ({
  id: row.id,
  name: row.name,
  ciphertext: row.ciphertext,
  nonce: row.nonce,
  version: Number(row.version),
  updatedAtMs: Number(row.updated_at_ms)
})

/**
 * A database failure, named by the credential operation that met it and
 * carrying the driver's failure: a locked database, a missing table and a
 * broken constraint each stay readable from the error alone.
 */
const persistence =
  (operation: "list" | "read" | "write" | "remove" | "migrate") => (cause: unknown): PersistenceError =>
    new PersistenceError({
      operation: `credential.${operation}`,
      message: `Credential storage failed to ${operation}`,
      cause
    })

/**
 * Creates the credential table if it does not exist.
 *
 * @category migrations
 * @since 0.1.0
 */
export const migrate: Effect.Effect<void, PersistenceError, SqlClient.SqlClient> = initial.pipe(
  Effect.mapError(persistence("migrate"))
)

/**
 * Constructs a durable credential store over the ambient database.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make: Effect.Effect<
  CredentialStore.Service,
  PersistenceError,
  DurableWriter | SqlClient.SqlClient
> = Effect.gen(function*() {
  const sql = yield* Effect.service(SqlClient.SqlClient)
  const writer = yield* DurableWriter
  yield* migrate

  const list = (): Effect.Effect<ReadonlyArray<CredentialStore.SealedRecord>, PersistenceError> =>
    sql<Row>`SELECT * FROM control_credentials ORDER BY name`.pipe(
      Effect.map((rows) => rows.map(toRecord)),
      Effect.mapError(persistence("list"))
    )

  const read = (id: string): Effect.Effect<Option.Option<CredentialStore.SealedRecord>, PersistenceError> =>
    sql<Row>`SELECT * FROM control_credentials WHERE id = ${id}`.pipe(
      Effect.map((rows) => Option.map(Option.fromNullishOr(rows[0]), toRecord)),
      Effect.mapError(persistence("read"))
    )

  // One write transaction, so the version and sealed secret this writer read
  // and the row it guards cannot interleave with a concurrent rotation.
  const write = (
    record: CredentialStore.SealedRecord,
    previous?: CredentialStore.SealedRecord | undefined
  ): Effect.Effect<void, PersistenceError | CredentialConflict> =>
    writer.write(Effect.gen(function*() {
      const rows = yield* sql<Pick<Row, "version" | "ciphertext" | "nonce">>`
        SELECT version, ciphertext, nonce FROM control_credentials WHERE id = ${record.id}
      `
      const stored = rows[0]
      const actual = stored === undefined ? 0 : Number(stored.version)
      if (actual !== record.version - 1 || !sealsMatch(stored, previous)) {
        return yield* Effect.fail(
          new CredentialConflict({
            id: record.id,
            expectedVersion: record.version - 1,
            actualVersion: actual
          })
        )
      }
      yield* sql`
        INSERT INTO control_credentials (id, name, ciphertext, nonce, version, updated_at_ms)
        VALUES (
          ${record.id},
          ${record.name},
          ${record.ciphertext},
          ${record.nonce},
          ${record.version},
          ${record.updatedAtMs}
        )
        ON CONFLICT (id) DO UPDATE SET
          name = excluded.name,
          ciphertext = excluded.ciphertext,
          nonce = excluded.nonce,
          version = excluded.version,
          updated_at_ms = excluded.updated_at_ms
      `
    })).pipe(
      Effect.mapError((cause): PersistenceError | CredentialConflict =>
        cause instanceof CredentialConflict ? cause : persistence("write")(cause)
      )
    )

  // Through the writer like `write`, so a removal is serialized with the
  // other writes and retried under the same contention a rotation survives.
  const remove = (id: string): Effect.Effect<void, PersistenceError> =>
    writer.write(sql`DELETE FROM control_credentials WHERE id = ${id}`).pipe(
      Effect.asVoid,
      Effect.mapError(persistence("remove"))
    )

  return CredentialStore.make({ list, read, write, remove })
})

/**
 * Provides durable credential persistence over the ambient database.
 *
 * @category layers
 * @since 0.1.0
 */
export const layer: Layer.Layer<
  CredentialStore.CredentialStore,
  PersistenceError,
  DurableWriter | SqlClient.SqlClient
> = Layer.effect(CredentialStore.CredentialStore)(make)

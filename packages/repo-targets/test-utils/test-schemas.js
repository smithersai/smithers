// Repository test bootstrap only. Shared across fixture creators and Vitest global setups.
import { PgClient } from "@effect/sql-pg";
import { Effect, Redacted } from "effect";
import { SqlClient } from "effect/sql";
/** Two hours: three times the farm's maximum 40-minute run. */
export const MAX_AGE_SECONDS = 7_200;
/** At most 16 schemas and 8 seconds of database work per startup. */
export const MAX_SCHEMAS = 16;
export { forStore, NAME_PATTERN, schemaName } from "../../smithers/flows/database/src/TestSchemas.js";
import { NAME_PATTERN } from "../../smithers/flows/database/src/TestSchemas.js";
/** The same authority/override guard used by TestDatabase.serverUrl. */
export const isLocalFixture = (url, port) => ["postgres:", "postgresql:"].includes(url.protocol) &&
    ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) && url.port === port &&
    [...url.searchParams.keys()].every((key) => ["application_name", "options", "sslmode", "schema"].includes(key));
/** Refuse before constructing a driver: URL endpoint overrides cannot bypass the guard. */
export const localFixture = (value) => {
    const url = new URL(value);
    if (!isLocalFixture(url, process.env.TEST_DATABASE_PORT ?? "54321"))
        throw new Error("Test schema reaper refused non-local fixture");
    // No inherited connection options (including search_path) affect the admin connection.
    url.search = "";
    return url;
};
/** Best effort, bounded and serialized with a transaction-scoped advisory lock; never terminates other sessions. */
export const reap = (value) => Effect.gen(function* () {
    const url = yield* Effect.try({ try: () => localFixture(value), catch: () => new Error("Test schema reaper refused non-local fixture") });
    return yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        return yield* sql.withTransaction(Effect.gen(function* () {
            yield* sql `SET LOCAL lock_timeout = '100ms'`;
            yield* sql `SET LOCAL statement_timeout = '400ms'`;
            const [lock] = yield* sql `SELECT pg_try_advisory_xact_lock(1937006964, 1920297328) AS held`;
            if (!lock.held)
                return { dropped: 0, skipped: 0, busy: true };
            const candidates = yield* sql `SELECT nspname AS name FROM pg_namespace
        WHERE nspname::text COLLATE "C" ~ ${NAME_PATTERN}
        AND substring(nspname FROM '_([1-9][0-9]{9})_[0-9a-f]{32}$')::bigint
          < floor(extract(epoch FROM clock_timestamp())) - ${MAX_AGE_SECONDS}
        ORDER BY nspname LIMIT ${MAX_SCHEMAS}`;
            let dropped = 0, skipped = 0;
            for (const { name } of candidates) {
                // Recheck in the serialized transaction. Locks include readers and unnamed flow-host pools.
                const [held] = yield* sql `SELECT EXISTS (
          SELECT 1 FROM pg_locks l JOIN pg_class c ON c.oid = l.relation
          JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = ${name} AND l.database = (SELECT oid FROM pg_database WHERE datname = current_database())
        ) AS held`;
                if (held.held) {
                    skipped++;
                    continue;
                }
                // A lock can arrive after the probe. SAVEPOINT rollback keeps a timeout non-fatal to the other candidates.
                const removed = yield* sql.withTransaction(sql `DROP SCHEMA IF EXISTS ${sql(name)} CASCADE`).pipe(Effect.as(true), Effect.catch(() => Effect.as(Effect.logWarning("test.schemas.drop_failed; skipped"), false)));
                if (removed)
                    dropped++;
                else
                    skipped++;
            }
            return { dropped, skipped, busy: false };
        }));
    }).pipe(Effect.provide(PgClient.layer({ url: Redacted.make(url.toString()), maxConnections: 1, connectTimeout: "1 second" })));
}).pipe(Effect.scoped, Effect.timeout("8 seconds"));
/** One Vitest invocation's bootstrap; errors log only a fixed message, never credentials or SQL payloads. */
export const setup = async () => {
    const url = process.env.DATABASE_URL ?? process.env.SMITHERS_TEST_PG_URL ?? process.env.SMITHERS_POSTGRES_URL ??
        `postgresql://smithers:smithers@localhost:${process.env.TEST_DATABASE_PORT ?? "54321"}/smithers`;
    await Effect.runPromise(reap(url).pipe(Effect.tap((counts) => Effect.logInfo("test.schemas.reaped", counts)), Effect.catchCause(() => Effect.logWarning("test.schemas.reap_failed; continuing without cleanup"))));
};

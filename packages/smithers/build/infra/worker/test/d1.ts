import { readFile } from "node:fs/promises"
import { DatabaseSync } from "node:sqlite"
import { fileURLToPath } from "node:url"

/**
 * A `D1Database` over `node:sqlite`, so the adapter is exercised against real
 * SQL, the shipped migrations, and rows that really persist between calls.
 *
 * Only the surface `worker/D1ActionCache.ts` uses is implemented: `prepare`, `bind`,
 * `first`, and `all`. Anything else throws rather than answering something a
 * test could mistake for D1 behavior.
 */
export interface TestDatabase {
  readonly database: D1Database
  readonly sqlite: DatabaseSync
  readonly close: () => void
}

export interface TestDatabaseOptions {
  /**
   * Awaited before every prepared statement runs, so a test can park one
   * query and drive another while it waits. A parked statement has already
   * bound its values and reads the database as it stands when it is released,
   * which is how a test schedules an interleaving D1 really allows.
   */
  readonly beforeQuery?: (query: string) => Promise<void> | void
}

const migration = (name: string): Promise<string> =>
  readFile(fileURLToPath(new URL(`../migrations/${name}`, import.meta.url).href), "utf8")

const unsupported = (name: string): never => {
  throw new Error(`the test D1 shim does not implement ${name}`)
}

/** The value kinds `node:sqlite` accepts as a bound parameter. */
type BoundValue = null | number | bigint | string | Uint8Array

const statementFor = (
  sqlite: DatabaseSync,
  query: string,
  values: ReadonlyArray<BoundValue>,
  beforeQuery: TestDatabaseOptions["beforeQuery"]
) => ({
  bind: (...next: ReadonlyArray<BoundValue>) => statementFor(sqlite, query, next, beforeQuery),
  first: async <Row>(): Promise<Row | null> => {
    await beforeQuery?.(query)
    const rows = sqlite.prepare(query).all(...values) as ReadonlyArray<unknown> as ReadonlyArray<Row>
    return rows[0] ?? null
  },
  all: async <Row>(): Promise<{ readonly results: ReadonlyArray<Row> }> => {
    await beforeQuery?.(query)
    return {
      results: sqlite.prepare(query).all(...values) as ReadonlyArray<unknown> as ReadonlyArray<Row>
    }
  },
  run: () => unsupported("run"),
  raw: () => unsupported("raw")
})

/**
 * Opens an in-memory database with both shipped migrations applied.
 */
export const makeTestDatabase = async (options: TestDatabaseOptions = {}): Promise<TestDatabase> => {
  const sqlite = new DatabaseSync(":memory:")
  sqlite.exec(await migration("0001_initial.sql"))
  sqlite.exec(await migration("0002_bound_cache_rows.sql"))
  const database = {
    prepare: (query: string) => statementFor(sqlite, query, [], options.beforeQuery),
    batch: () => unsupported("batch"),
    exec: () => unsupported("exec"),
    dump: () => unsupported("dump"),
    withSession: () => unsupported("withSession")
  } as unknown as D1Database
  return { database, sqlite, close: () => sqlite.close() }
}

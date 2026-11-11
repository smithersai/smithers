// Runs under real Bun (spawned by BunDatabase.test.ts): no shim or Node SQLite.
import { Database } from "bun:sqlite"
import { Cause, Effect, Exit } from "effect"
import * as SqlClient from "effect/sql/SqlClient"
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as BunDatabase from "../../src/bun/BunDatabase.ts"
import * as Dialect from "../../src/Dialect.ts"

const root = mkdtempSync(join(tmpdir(), "flows-bun-database-"))
let files = 0
const fresh = () => join(root, `db-${files++}.sqlite`)

/** Writes a file with tables but no `flows_migrations`, in the rollback journal 0.x leaves. */
const seedZeroX = (filename: string): string => {
  const db = new Database(filename)
  db.run("PRAGMA journal_mode = DELETE")
  db.run("CREATE TABLE _smithers_runs (id TEXT PRIMARY KEY)")
  db.close()
  return filename
}

/** Writes a file that carries the flows migration ledger: a Smithers 1.0 database. */
const seedFlows = (filename: string): string => {
  const db = new Database(filename)
  db.run("CREATE TABLE flows_migrations (migration_id INTEGER PRIMARY KEY)")
  db.close()
  return filename
}

const tables = (filename: string): Array<string> => {
  const db = new Database(filename, { readonly: true })
  try {
    return db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all()
      .map((row) => row.name)
  } finally {
    db.close()
  }
}

/** Builds the layer and runs `program`; a failed build reports the guard's code, or `failed`. */
const run = async <A>(
  options: BunDatabase.BunDatabaseOptions,
  program: Effect.Effect<A, unknown, SqlClient.SqlClient>
): Promise<{ readonly value: A } | { readonly refused: string }> => {
  const exit = await Effect.runPromiseExit(Effect.scoped(Effect.provide(program, BunDatabase.layer(options))))
  if (Exit.isSuccess(exit)) return { value: exit.value }
  const defect = Cause.squash(exit.cause)
  return { refused: BunDatabase.isUnsupportedDatabase(defect) ? defect.code : "failed" }
}

const open = (options: BunDatabase.BunDatabaseOptions) =>
  run(options, Effect.flatMap(SqlClient.SqlClient, (sql) => sql`SELECT 1 AS value`))

/** Every way of naming a 0.x file is refused, and none of them writes to it. */
const zeroX = async () => {
  const filename = seedZeroX(fresh())
  return {
    path: await open({ filename }),
    uri: await open({ filename: `file:${filename}` }),
    absoluteUri: await open({ filename: `file://${filename}` }),
    readWriteUri: await open({ filename: `file:${filename}?mode=rw` }),
    readOnly: await open({ filename, readOnly: true }),
    tables: tables(filename)
  }
}

/** A 0.x writer holds the file for 300 ms; the guard outwaits it and still refuses. */
const lockedZeroX = async () => {
  const filename = seedZeroX(fresh())
  const writer = new Database(filename)
  writer.run("PRAGMA busy_timeout = 0")
  writer.run("BEGIN EXCLUSIVE")
  const timer = setTimeout(() => {
    writer.run("COMMIT")
    writer.close()
  }, 300)
  try {
    return await open({ filename: `file:${filename}` })
  } finally {
    clearTimeout(timer)
  }
}

/** Missing parents report their filesystem failure without replaying path text as a lock. */
const missingParent = async (name: string) => {
  const filename = join(root, name, "missing", "fresh.db")
  return { ...await open({ filename }), created: existsSync(filename) }
}

/** The adapter creates the file and its WAL sidecars owner-only under a permissive umask. */
const modes = async () => {
  const filename = fresh()
  const previous = process.umask(0o022)
  try {
    return await run(
      { filename },
      Effect.flatMap(SqlClient.SqlClient, (sql) =>
        Effect.map(
          sql`CREATE TABLE flows_migrations (migration_id INTEGER PRIMARY KEY)`,
          () => [filename, `${filename}-wal`, `${filename}-shm`].map((path) => statSync(path).mode & 0o777)
        ))
    )
  } finally {
    process.umask(previous)
  }
}

const observe = () =>
  run(
    { filename: seedFlows(fresh()), readOnly: true },
    Effect.flatMap(SqlClient.SqlClient, (sql) =>
      Effect.map(
        Effect.exit(sql`INSERT INTO flows_migrations VALUES (1)`),
        (write) => ({ readOnly: Dialect.isReadOnly(sql), written: Exit.isSuccess(write) })
      ))
  )

/**
 * An open whose settings forbid creation is left to the driver: a read-only or
 * `create: false` open of a missing file fails, and `readwrite: false` lets Bun
 * create it under the umask (0644 here), not the adapter's owner-only 0600.
 */
const driverOwned = async (options: Omit<BunDatabase.BunDatabaseOptions, "filename">) => {
  const filename = fresh()
  const previous = process.umask(0o022)
  try {
    const result = await run({ ...options, filename }, Effect.void)
    return { ...result, mode: existsSync(filename) ? statSync(filename).mode & 0o777 : "missing" }
  } finally {
    process.umask(previous)
  }
}

const corrupt = () => {
  const filename = fresh()
  writeFileSync(filename, "not sqlite")
  return open({ filename })
}

try {
  const migrated = seedFlows(fresh())
  mkdirSync(join(root, "database is locked"))
  mkdirSync(join(root, "database is busy"))
  const result = {
    memory: await open({ filename: ":memory:" }),
    created: await open({ filename: fresh() }),
    lockNamedPaths: {
      locked: await open({ filename: join(root, "database is locked.db") }),
      busy: await open({ filename: join(root, "database is busy.db") }),
      lockedParent: await open({ filename: join(root, "database is locked", "fresh.db") }),
      busyParent: await open({ filename: join(root, "database is busy", "fresh.db") })
    },
    lockNamedMissingParents: {
      locked: await missingParent("database is locked"),
      busy: await missingParent("database is busy")
    },
    directory: await open({ filename: root }),
    zeroX: await zeroX(),
    lockedZeroX: await lockedZeroX(),
    migrated: { path: await open({ filename: migrated }), uri: await open({ filename: `file:${migrated}` }) },
    modes: await modes(),
    observe: await observe(),
    readOnlyMissing: await driverOwned({ readOnly: true }),
    sqliteReadOnlyMissing: await driverOwned({ sqlite: { readonly: true } }),
    createDisabled: await driverOwned({ sqlite: { create: false } }),
    readWriteDisabled: await driverOwned({ sqlite: { readwrite: false } }),
    corrupt: await corrupt()
  }
  console.log(JSON.stringify(result))
} finally {
  rmSync(root, { recursive: true, force: true })
}

import { ObjectDatabase } from "@smthrs/platform-cloudflare"
import { Duration, Effect, Redacted } from "effect"
import { SqlClient } from "effect/sql"
import { TestClock } from "effect/testing"
import { DatabaseSync, type SQLInputValue } from "node:sqlite"
import { expect, test } from "vitest"
import * as Host from "./GitHubConnectionHost.vibe"

// One person's connection object (worker/GitHubConnectionHost.vibe) over a Durable Object's own SQLite: Node's
// `node:sqlite` behind the storage port the object gives `ObjectDatabase`, which refuses transaction SQL as the real
// storage does. The real engine store, runtime and retention pass run; GitHub is never reached, because revoking a
// site that holds no delegation and no credential calls nothing.
const objectStorage = (): ObjectDatabase.Storage => {
  const db = new DatabaseSync(":memory:")
  let depth = 0
  const exec = (query: string, ...params: ReadonlyArray<unknown>) => {
    if (/^\s*(BEGIN|SAVEPOINT|COMMIT|ROLLBACK|RELEASE)\b/i.test(query)) {
      throw new Error("To execute a transaction, please use the state.storage.transaction() API")
    }
    const statement = db.prepare(query)
    const columnNames = statement.columns().map((column) => column.name)
    const rows = columnNames.length === 0
      ? (statement.run(...(params as Array<SQLInputValue>)), [])
      : statement.all(...(params as Array<SQLInputValue>))
    return {
      columnNames,
      toArray: () => rows as Array<Record<string, unknown>>,
      raw: function*() {
        for (const row of rows) yield columnNames.map((name) => (row as Record<string, unknown>)[name])
      },
    }
  }
  const transaction = async <T>(closure: (txn: { rollback(): void }) => Promise<T>): Promise<T> => {
    const level = depth++
    const name = `level_${level}`
    db.exec(level === 0 ? "BEGIN" : `SAVEPOINT ${name}`)
    let rolledBack = false
    const end = (commit: boolean) => {
      depth--
      if (level === 0) db.exec(commit ? "COMMIT" : "ROLLBACK")
      else db.exec(commit ? `RELEASE ${name}` : `ROLLBACK TO ${name}; RELEASE ${name}`)
    }
    try {
      const value = await closure({ rollback: () => void (rolledBack = true) })
      end(!rolledBack)
      return value
    } catch (cause) {
      end(false)
      throw cause
    }
  }
  return { sql: { exec }, transaction } as unknown as ObjectDatabase.Storage
}

const origin = "https://smithers.test"
const site = "https://vibelang.smithers.test"
const setup: Host.Setup = {
  origin,
  sites: [{ origin: site, secret: Redacted.make("s".repeat(32)), grants: [] }],
  keyring: { active: "k1", keys: { k1: Redacted.make("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=") } },
}

const settledRuns = (storage: ObjectDatabase.Storage) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) => sql<{ readonly count: number }>`SELECT COUNT(*) AS count FROM flows_runs`).pipe(
    Effect.map((rows) => Number(rows[0]!.count)),
    Effect.provide(ObjectDatabase.layer(storage)),
  )

test("the retention window is thirty days", () => {
  expect(Host.EXECUTION_RETENTION).toEqual({ olderThanMs: Duration.toMillis(Duration.days(30)) })
})

test("a person's object forgets executions settled before its retention window, and keeps the ones inside it", () =>
  Effect.runPromise(Effect.gen(function*() {
    const storage = objectStorage()
    // GitHub's client is never asked: nothing here holds a credential to revoke or exchange.
    const host = yield* Host.make(7, "person:7", storage, setup, {} as never)
    for (let n = 0; n < 5; n++) expect(yield* host.revoke(site)).toBeUndefined()
    // Inside the window every execution is still the account of what it did.
    expect(yield* settledRuns(storage)).toBe(5)
    yield* TestClock.adjust(Duration.millis(Host.EXECUTION_RETENTION.olderThanMs - 1))
    yield* host.revoke(site)
    expect(yield* settledRuns(storage)).toBe(6)
    // Past it, the next invocation's pass deletes the five aged runs: the store holds its window, not its history.
    yield* TestClock.adjust(Duration.millis(2))
    yield* host.revoke(site)
    expect(yield* settledRuns(storage)).toBe(2)
    yield* TestClock.adjust(Duration.millis(Host.EXECUTION_RETENTION.olderThanMs + 1))
    for (let n = 0; n < 3; n++) yield* host.revoke(site)
    expect(yield* settledRuns(storage)).toBe(3)
  }).pipe(Effect.provide(TestClock.layer()))))

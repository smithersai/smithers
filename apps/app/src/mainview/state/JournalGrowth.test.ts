import { describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { createAppStore, journalPayload, MAX_TRANSITION_PAYLOAD_BYTES, PERSISTED_COLLECTION_SPECS } from "./AppStore"
import type { Card } from "./AppState"
import { APP_SCHEMA_VERSION } from "../chain/SchemaVersion"
import { openSqliteRowStorage, ROW_TABLE_NAME } from "../chain/SqliteRowStorage"
import type { SqliteRowDatabase } from "../chain/SqliteRowStorage"

/*
 * What a poll costs on disk.
 *
 * A smithers.sh browser profile whose OPFS store was wiped to 0 bytes at
 * 13:55Z on 2026-09-15 held 567,535,882 bytes by 16:50Z — about 190 MB/h —
 * with nothing running but a Playwright client polling a handful of run cards
 * (run-summary / run-events every ~3 s). The run pump re-dispatches a run
 * card's WHOLE payload, its full engine event list, on every cycle, and the
 * transition journal stored that payload verbatim, 500 records deep
 * (MAX_TRANSITION_RECORDS). Five hundred copies of a megabyte is the store
 * that was measured.
 *
 * Measured here at 264,769 bytes of run-card payload: 270,879 bytes of durable
 * store per idle cycle before this bound, 889 after, and a store that stops
 * growing once the journal's 500 records have turned over.
 */

const database = () => {
  const sqlite = new Database(":memory:")
  const host: SqliteRowDatabase = {
    execute: async <TRow>(sql: string, params: ReadonlyArray<unknown> = []) => {
      const statement = sqlite.query(sql)
      if (/^\s*(?:SELECT|PRAGMA)/i.test(sql)) return statement.all(...params as []) as ReadonlyArray<TRow>
      statement.run(...params as [])
      return []
    }
  }
  return { sqlite, host }
}

/** The OPFS-shaped backend AppStore resolves in a browser, over bun:sqlite. */
const backendOf = (sqlite: Awaited<ReturnType<typeof openSqliteRowStorage>>) => ({
  kind: "opfs" as const,
  storage: sqlite.storage,
  beginBatch: sqlite.beginBatch,
  commitBatch: sqlite.commitBatch,
  abortBatch: sqlite.abortBatch,
  flush: sqlite.flush,
  close: sqlite.close,
  readRecovery: sqlite.readRecovery,
  applyRows: sqlite.applyRows,
  readRows: sqlite.readRows,
  load: sqlite.loadReport
})

const runCard = (events: ReadonlyArray<Record<string, unknown>>): Card => ({
  id: "workspace-run-card",
  kind: "run-trace",
  title: "Coding",
  status: "active",
  ordinal: 1,
  createdAt: 0,
  payload: {
    repo: "smithersai/smithers",
    runId: "run-1",
    workflow: "coding",
    phase: "running",
    steps: [],
    result: null,
    lastSeq: events.length,
    input: { prompt: "do it" },
    events: [...events]
  }
} as Card)

const events = Array.from({ length: 600 }, (_, index) => ({ sequence: index, kind: "tool", text: "t".repeat(400) }))

describe("polling a run card does not grow the persisted store", () => {
  test("an idle poll cycle costs a bounded journal record, not the card's payload", async () => {
    const db = database()
    const sqlite = await openSqliteRowStorage(db.host, {
      collections: PERSISTED_COLLECTION_SPECS,
      schemaVersion: APP_SCHEMA_VERSION
    })
    const store = await createAppStore(backendOf(sqlite) as never, { seedWiki: false })
    await store.dispatch({ type: "card.upsert", actor: "system", card: runCard(events) } as never).isPersisted.promise
    await store.settled?.()

    const bytes = (): number =>
      Number((db.sqlite.query(
        `SELECT SUM(LENGTH(collection_id) + LENGTH(row_key) + LENGTH(value)) AS bytes FROM ${ROW_TABLE_NAME}`
      ).get() as { bytes: number }).bytes)

    const payloadBytes = JSON.stringify(runCard(events)).length
    expect(payloadBytes).toBeGreaterThan(200_000)

    // Ten cycles that learned nothing: the pump re-dispatching the card it holds.
    const before = bytes()
    const cycle = async (): Promise<void> => {
      const card = store.collections.cards.get("workspace-run-card")!
      await store.dispatch({
        type: "card.updated",
        actor: "system",
        id: card.id,
        patch: { payload: { ...card.payload } }
      } as never).isPersisted.promise
    }
    for (let index = 0; index < 10; index += 1) await cycle()
    await store.settled?.()
    const perCycle = (bytes() - before) / 10
    // One cycle used to cost the whole payload twice over — the card row
    // rewritten and the journal record holding the same bytes again.
    expect(perCycle).toBeLessThan(4 * MAX_TRANSITION_PAYLOAD_BYTES)

    // And it settles: once the journal's 500 records have turned over, an
    // idle poll is not growth at all. The 64 MiB load budget stays a ceiling.
    for (let index = 0; index < 540; index += 1) await cycle()
    await store.settled?.()
    const settled = bytes()
    for (let index = 0; index < 100; index += 1) await cycle()
    await store.settled?.()
    expect(bytes() - settled).toBeLessThan(10 * MAX_TRANSITION_PAYLOAD_BYTES)
    await store.dispose?.()
  }, 180_000)
})

describe("the transition journal bounds what one record may cost", () => {
  test("a small payload is kept whole", () => {
    const payload = JSON.stringify({ key: "store.truncated", title: "Older local history was not loaded" })
    expect(journalPayload(payload)).toBe(payload)
  })

  test("a large payload keeps its shape and the short fields a diagnostic reads", () => {
    const payload = JSON.stringify({
      id: "workspace-run-card",
      patch: { status: "error", title: "Coding", payload: { message: "the run failed", events } }
    })
    const bounded = journalPayload(payload)
    expect(bounded.length).toBeLessThanOrEqual(MAX_TRANSITION_PAYLOAD_BYTES)
    const parsed = JSON.parse(bounded) as { id: string; patch: { status: string; title: string; payload: { message: string } } }
    expect(parsed.id).toBe("workspace-run-card")
    expect(parsed.patch.status).toBe("error")
    expect(parsed.patch.title).toBe("Coding")
    expect(parsed.patch.payload.message).toBe("the run failed")
  })

  test("a payload still too wide after elision records the size it had", () => {
    const wide = Object.fromEntries(Array.from({ length: 400 }, (_, index) => [`field-${index}`, `value-${index}`]))
    const payload = JSON.stringify(wide)
    const bounded = journalPayload(payload)
    expect(JSON.parse(bounded)).toEqual({ elided: payload.length })
  })
})

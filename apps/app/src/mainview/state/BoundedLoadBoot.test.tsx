import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import App from "../App"
import { ControllerTestProvider } from "../ControllerContext"
import { scopedControllers } from "./ControllerTestScope"
import { createAppStore, PERSISTED_COLLECTION_SPECS } from "./AppStore"
import type { AppStore } from "./AppStore"
import type { Card } from "./AppState"
import { unavailableAgent, unavailableRepositories } from "./TestFixtures"
import { APP_SCHEMA_VERSION } from "../chain/SchemaVersion"
import { openSqliteRowStorage, ROW_TABLE_NAME } from "../chain/SqliteRowStorage"
import type { SqliteRowDatabase } from "../chain/SqliteRowStorage"

/*
 * A partial load is a boot that survived, so it has to end in a shell the human
 * can use.
 *
 * smithers.sh build 5136850c (2026-09-15 16:50Z), on a browser profile whose
 * OPFS `smithers-mvp.sqlite` had grown past the load budget:
 *
 *   Smithers: the persisted store is larger than one launch loads; older rows
 *   stayed on disk. {budgetBytes: 67108864, loaded: 260, skipped: 455,
 *   collections: Array(1)}
 *
 * and then the page showed nothing but the 384-character entrance wordmark —
 * no composer, no cards, and no error panel, because nothing had thrown. This
 * pins the whole path: a store several times its budget opens, the store boots,
 * and the shell renders its composer with the rows that did load.
 */

const createAppController = scopedControllers()

GlobalRegistrator.register()

/* bun test shares one process; keep these globals inside this file's run. */
afterAll(async () => {
  for (let tick = 0; tick < 3; tick += 1) await new Promise((resolve) => setTimeout(resolve, 0))
  await GlobalRegistrator.unregister()
})

const mounted: Array<() => void> = []
afterEach(() => {
  while (mounted.length > 0) mounted.pop()?.()
})

const database = () => {
  const sqlite = new Database(":memory:")
  const host: SqliteRowDatabase = {
    execute: async <TRow,>(sql: string, params: ReadonlyArray<unknown> = []) => {
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

const bigCard = (index: number): Card => ({
  id: `approval-run-${index}`,
  kind: "approval",
  title: `Approve run ${index}`,
  status: "active",
  createdAt: 1_700_000_000_000 + index,
  ordinal: index + 1,
  payload: {
    capability: "deploy:production",
    detail: "d".repeat(200_000),
    runId: `run-${index}`,
    requestId: "approve",
    approval: { target: { _tag: "Node", runId: `run-${index}`, requestId: "approve" }, scope: "run", idempotencyKey: `k${index}` }
  }
} as Card)

const render = (store: AppStore): string => {
  const controller = createAppController(store, unavailableRepositories, unavailableAgent)
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  flushSync(() => root.render(<ControllerTestProvider controller={controller}><App /></ControllerTestProvider>))
  const markup = host.innerHTML
  mounted.push(() => {
    flushSync(() => root.unmount())
    host.remove()
  })
  return markup
}

describe("a store larger than one launch loads still boots a usable shell", () => {
  test("the composer renders, the loaded rows are there, and the notice says what stayed on disk", async () => {
    const db = database()
    const open = (budgetBytes?: number) =>
      openSqliteRowStorage(db.host, {
        collections: PERSISTED_COLLECTION_SPECS,
        schemaVersion: APP_SCHEMA_VERSION,
        ...(budgetBytes === undefined ? {} : { budgetBytes })
      })

    const seeded = await createAppStore(backendOf(await open()) as never, { seedWiki: false })
    for (let index = 0; index < 30; index += 1) {
      await seeded.dispatch({ type: "card.upsert", actor: "system", card: bigCard(index) } as never).isPersisted.promise
    }
    await seeded.settled?.()
    await seeded.dispose?.()
    const stored = Number(
      (db.sqlite.query(`SELECT SUM(LENGTH(value)) AS bytes FROM ${ROW_TABLE_NAME}`).get() as { bytes: number }).bytes
    )

    const budgetBytes = 2 * 1024 * 1024
    const bounded = await open(budgetBytes)
    // The production shape: several times the budget on disk, one launch's worth loaded.
    expect(stored).toBeGreaterThan(budgetBytes * 3)
    expect(bounded.loadReport.skipped).toBeGreaterThan(0)

    const store = await createAppStore(backendOf(bounded) as never, { seedWiki: false })
    expect(store.persistedLoad.skipped).toBe(bounded.loadReport.skipped)
    // The partial load is said once, in the same durable vocabulary as every
    // other system notice — and it never claims the skipped rows were deleted.
    const notice = store.collections.toasts.get("toast-store.truncated")
    expect(notice?.status).toBe("failed")
    expect(notice?.detail).toContain("older history is available in the recovery file")

    const markup = render(store)
    expect(markup).toContain("smithers-composer")
    expect(markup).toContain("smithers-transcript")
    // The rows that did load are the app's content, not an empty surface.
    expect(store.collections.cards.size).toBeGreaterThan(0)
    await store.dispose?.()
  }, 120_000)
})

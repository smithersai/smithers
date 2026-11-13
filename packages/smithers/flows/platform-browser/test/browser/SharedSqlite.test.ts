/**
 * The app's shared database in real Chromium, over real OPFS, Web Locks and
 * `BroadcastChannel`: every tab's statements run on the engine leader's
 * connection, a transaction is one tab's alone, the follower's worker takes
 * the file over when the leader's tab closes, and only the leader's worker
 * ever loads the SQLite build.
 */
import type { BrowserContext, Page } from "playwright"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import * as Harness from "./Harness.ts"

type Answer = { readonly ok: true; readonly rows: ReadonlyArray<unknown> } | {
  readonly ok: false
  readonly reason?: string
}

type Harnessed = {
  readonly harness: { readonly sql: (statement: string, params?: ReadonlyArray<unknown>) => Promise<Answer> }
}

let server: Awaited<ReturnType<typeof Harness.serve>>

beforeAll(async () => {
  server = await Harness.serve()
})

afterAll(() => server.close())

/** Runs `statement` in `page`'s tab through `SharedSqlite`. */
const sql = (page: Page, statement: string, params: ReadonlyArray<unknown> = []): Promise<Answer> =>
  page.evaluate(
    ([statement, params]) => (globalThis as unknown as Harnessed).harness.sql(statement, params),
    [statement, params] as const
  )

/** `promise`'s value, or `"pending"` if it has none within `ms`. */
const within = <A>(promise: Promise<A>, ms: number): Promise<A | "pending"> =>
  Promise.race([promise, new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), ms))])

/** Every request for the SQLite build's wasm, from any page or worker of `context`. */
const wasmRequests = (context: BrowserContext): Array<string> => {
  const requests: Array<string> = []
  context.on("request", (request) => {
    if (request.url().endsWith("/wa-sqlite.wasm")) requests.push(request.url())
  })
  return requests
}

describe("SharedSqlite in Chromium", () => {
  it("runs two tabs' statements on one database, keeps a transaction one tab's own, and loads the build once", async () => {
    const profile = Harness.profile()
    const context = await Harness.launch(profile.directory)
    const fetched = wasmRequests(context)
    try {
      const a = await Harness.open(context, server.origin, "finish")
      await Harness.waitForLeader(a)
      const b = await Harness.open(context, server.origin, "finish")
      expect(await sql(a, "CREATE TABLE t (id INTEGER PRIMARY KEY)")).toEqual({ ok: true, rows: [] })
      await sql(a, "INSERT INTO t (id) VALUES (?)", [1])
      expect(await sql(b, "SELECT id FROM t")).toEqual({ ok: true, rows: [{ id: 1 }] })

      expect(await sql(a, "BEGIN IMMEDIATE")).toEqual({ ok: true, rows: [] })
      await sql(a, "INSERT INTO t (id) VALUES (2)")
      const read = sql(b, "SELECT count(*) AS n FROM t")
      // B waits for A's transaction, and never reads its uncommitted row.
      expect(await within(read, 500)).toBe("pending")
      await sql(a, "COMMIT")
      expect(await read).toEqual({ ok: true, rows: [{ n: 2 }] })
      // Only the leader's worker loaded the build; B's worker waits without it.
      expect(fetched).toHaveLength(1)
    } finally {
      await context.close()
      profile.remove()
    }
  })

  it("moves to the follower when the leader tab closes: committed rows stay, an open transaction is rolled back", async () => {
    const profile = Harness.profile()
    const context = await Harness.launch(profile.directory)
    try {
      const a = await Harness.open(context, server.origin, "finish")
      await Harness.waitForLeader(a)
      const b = await Harness.open(context, server.origin, "finish")
      await sql(b, "CREATE TABLE t (id INTEGER PRIMARY KEY)")
      await sql(b, "INSERT INTO t (id) VALUES (1)")
      await sql(a, "BEGIN IMMEDIATE")
      await sql(a, "INSERT INTO t (id) VALUES (2)")
      // Waiting for B must not settle while A's worker still owns the lock.
      const leading = Harness.waitForLeader(b).then(() => "leading")
      expect(await within(leading, 500)).toBe("pending")
      await a.close()
      // B's own worker now leads, over the same OPFS file.
      await leading
      expect(await sql(b, "SELECT id FROM t")).toEqual({ ok: true, rows: [{ id: 1 }] })
      expect(await sql(b, "INSERT INTO t (id) VALUES (2)")).toEqual({ ok: true, rows: [] })
    } finally {
      await context.close()
      profile.remove()
    }
  })

  it("rolls back a follower's open transaction when its tab closes, while the leader stays alive", async () => {
    const profile = Harness.profile()
    const context = await Harness.launch(profile.directory)
    const fetched = wasmRequests(context)
    try {
      const leader = await Harness.open(context, server.origin, "finish")
      await Harness.waitForLeader(leader)
      const follower = await Harness.open(context, server.origin, "finish")
      expect(await sql(leader, "CREATE TABLE t (id INTEGER PRIMARY KEY)")).toEqual({ ok: true, rows: [] })
      expect(await sql(leader, "INSERT INTO t (id) VALUES (1)")).toEqual({ ok: true, rows: [] })
      expect(await sql(follower, "BEGIN IMMEDIATE")).toEqual({ ok: true, rows: [] })
      expect(await sql(follower, "INSERT INTO t (id) VALUES (2)")).toEqual({ ok: true, rows: [] })

      // The leader's statement must wait for the other tab's transaction.
      const write = sql(leader, "INSERT INTO t (id) VALUES (3)")
      expect(await within(write, 500)).toBe("pending")
      await follower.close()
      expect(await write).toEqual({ ok: true, rows: [] })
      expect(await sql(leader, "SELECT id FROM t ORDER BY id")).toEqual({
        ok: true,
        rows: [{ id: 1 }, { id: 3 }]
      })
      await Harness.waitForLeader(leader)
      // No takeover or database close caused the rollback: the same worker serves it.
      expect(fetched).toHaveLength(1)
    } finally {
      await context.close()
      profile.remove()
    }
  })

  it("keeps what tabs committed after the browser is killed", async () => {
    const profile = Harness.profile()
    try {
      const first = await Harness.launch(profile.directory)
      const a = await Harness.open(first, server.origin, "finish")
      await sql(a, "CREATE TABLE t (id INTEGER PRIMARY KEY)")
      await sql(a, "INSERT INTO t (id) VALUES (7)")
      Harness.kill(profile.directory)
      await first.close().catch(() => undefined)

      const second = await Harness.launch(profile.directory)
      try {
        const b = await Harness.open(second, server.origin, "finish")
        expect(await sql(b, "SELECT id FROM t")).toEqual({ ok: true, rows: [{ id: 7 }] })
      } finally {
        await second.close()
      }
    } finally {
      profile.remove()
    }
  })
})

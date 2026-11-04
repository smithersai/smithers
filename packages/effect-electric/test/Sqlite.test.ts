import { createBrowserWASQLitePersistence } from "@tanstack/browser-db-sqlite-persistence"
import { rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "vitest"
import { sqlite } from "./sqlite.ts"

const databaseFile = () => join(tmpdir(), `electric-lock-${crypto.randomUUID()}.sqlite`)

test("two connections restore concurrently through TanStack's real persistence adapter", async () => {
  const path = databaseFile()
  const first = sqlite(path)
  const second = sqlite(path)
  try {
    const writer = createBrowserWASQLitePersistence({ database: first })
    const watcher = createBrowserWASQLitePersistence({ database: second })
    const snapshots = await Promise.all([
      writer.adapter.loadResumeSnapshot({ kind: "eager", collectionId: "notes" }),
      watcher.adapter.loadResumeSnapshot({ kind: "eager", collectionId: "notes" })
    ])
    expect(snapshots.map(({ rows, collectionMetadata, latestSeq }) => ({ rows, collectionMetadata, latestSeq })))
      .toEqual([
        { rows: [], collectionMetadata: [], latestSeq: 0 },
        { rows: [], collectionMetadata: [], latestSeq: 0 }
      ])
  } finally {
    second.close()
    first.close()
    rmSync(path)
  }
})

test("a batch commits before another connection runs and preserves statement order and parameters", async () => {
  const path = databaseFile()
  const writer = sqlite(path)
  const reader = sqlite(path)
  try {
    await writer.execute("CREATE TABLE notes (id TEXT PRIMARY KEY, n INTEGER)")
    const batch = writer.executeBatch([
      { sql: "BEGIN IMMEDIATE" },
      { sql: "INSERT INTO notes VALUES (?, ?)", params: ["a", 1] },
      { sql: "UPDATE notes SET n = n + ? WHERE id = ?", params: [2, "a"] },
      { sql: "SELECT n FROM notes WHERE id = ?", params: ["a"] },
      { sql: "COMMIT" }
    ])
    const rows = reader.execute("SELECT * FROM notes")
    expect(await batch).toEqual([[], [], [], [{ n: 3 }], []])
    expect(await rows).toEqual([{ id: "a", n: 3 }])
    expect(await reader.executeBatch([])).toEqual([])
  } finally {
    reader.close()
    writer.close()
    rmSync(path)
  }
})

test("a failed batch stops before COMMIT and leaves rollback to TanStack's caller", async () => {
  const path = databaseFile()
  const database = sqlite(path)
  try {
    await database.execute("CREATE TABLE notes (id TEXT PRIMARY KEY)")
    await expect(database.executeBatch([
      { sql: "BEGIN IMMEDIATE" },
      { sql: "INSERT INTO notes VALUES (?)", params: ["a"] },
      { sql: "INSERT INTO notes VALUES (?)", params: ["a"] },
      { sql: "COMMIT" }
    ])).rejects.toThrow("UNIQUE constraint failed")
    await database.execute("ROLLBACK")
    expect(await database.execute("SELECT * FROM notes")).toEqual([])
    await expect(database.execute("SELECT * FROM missing")).rejects.toThrow("no such table")
    await database.execute("INSERT INTO notes VALUES (?)", ["b"])
    expect(await database.execute("SELECT * FROM notes")).toEqual([{ id: "b" }])
  } finally {
    database.close()
    rmSync(path)
  }
})

test.each(["COMMIT", "ROLLBACK", "close"])("a peer waits for the transaction owner to %s", async (end) => {
  const path = databaseFile()
  const writer = sqlite(path)
  const reader = sqlite(path)
  let closed = false
  try {
    await writer.execute("CREATE TABLE notes (id TEXT PRIMARY KEY)")
    await writer.execute("BEGIN IMMEDIATE")
    await writer.execute("INSERT INTO notes VALUES (?)", ["a"])
    let answered = false
    const rows = reader.execute("SELECT * FROM notes").then((rows) => {
      answered = true
      return rows
    })
    await new Promise<void>((resume) => setImmediate(resume))
    expect(answered).toBe(false)
    const locks = await navigator.locks.query()
    expect(locks.pending?.some(({ name }) => name === `electric-sqlite:${path}`)).toBe(true)
    if (end === "close") {
      writer.close()
      closed = true
    } else await writer.execute(end)
    expect(await rows).toEqual(end === "COMMIT" ? [{ id: "a" }] : [])
  } finally {
    reader.close()
    if (!closed) writer.close()
    rmSync(path)
  }
})

test("an open transaction does not block a different database file", async () => {
  const firstPath = databaseFile()
  const secondPath = databaseFile()
  const first = sqlite(firstPath)
  const second = sqlite(secondPath)
  try {
    await first.execute("BEGIN IMMEDIATE")
    expect(await second.execute("SELECT 1 AS n")).toEqual([{ n: 1 }])
    await first.execute("ROLLBACK")
  } finally {
    second.close()
    first.close()
    rmSync(firstPath)
    rmSync(secondPath)
  }
})

test("closing a waiter rejects its request and releases the file for the next connection", async () => {
  const path = databaseFile()
  const writer = sqlite(path)
  const reader = sqlite(path)
  const next = sqlite(path)
  let closed = false
  try {
    await writer.execute("BEGIN IMMEDIATE")
    const waiting = reader.execute("SELECT 1").catch((error: unknown) => error)
    await new Promise<void>((resume) => setImmediate(resume))
    reader.close()
    closed = true
    await writer.execute("COMMIT")
    expect(await waiting).toMatchObject({ code: "ERR_INVALID_STATE" })
    expect(await next.execute("SELECT 1 AS n")).toEqual([{ n: 1 }])
    expect(() => reader.close()).toThrow()
  } finally {
    next.close()
    if (!closed) reader.close()
    writer.close()
    rmSync(path)
  }
})

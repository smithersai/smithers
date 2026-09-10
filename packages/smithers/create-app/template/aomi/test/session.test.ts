import { DatabaseSync, type SQLInputValue } from "node:sqlite"
import * as Schema from "effect/Schema"
import { afterEach, describe, expect, test, vi } from "vitest"
import type { AppCard, SessionSummary } from "../src/api.ts"
import { SessionState } from "../src/api.ts"
import { AppSession } from "../worker/AppSession.ts"
import type { Env } from "../worker/env.ts"

// Execute the production SQL on SQLite; only the workerd base class is stubbed.
vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    constructor(protected ctx: DurableObjectState, protected env: Env) {}
  }
}))

const databases: Array<DatabaseSync> = []
const harness = () => {
  const db = new DatabaseSync(":memory:")
  databases.push(db)
  const ctx = {
    storage: {
      sql: {
        exec(query: string, ...bindings: Array<SQLInputValue>) {
          const rows = db.prepare(query).all(...bindings)
          return { toArray: () => rows }
        }
      },
      transactionSync<T>(body: () => T): T {
        db.exec("BEGIN")
        try {
          const result = body()
          db.exec("COMMIT")
          return result
        } catch (cause) {
          db.exec("ROLLBACK")
          throw cause
        }
      }
    }
  } as unknown as DurableObjectState
  return { db, open: () => new AppSession(ctx, {} as Env) }
}

const card: AppCard = { kind: "html", id: "z-card", html: "before" }

afterEach(() => {
  vi.restoreAllMocks()
  for (const db of databases.splice(0)) db.close()
})

describe("durable transcript order", () => {
  test("same-tick messages reload in write order regardless of the timestamp index", () => {
    const { db, open } = harness()
    const session = open()
    // A valid query plan exposes the unspecified tie order of ORDER BY at.
    db.exec("CREATE INDEX messages_at_role ON messages(at, role, text, id)")
    vi.spyOn(Date, "now").mockReturnValue(10)
    const user = session.appendMessage("user", "question")
    const assistant = session.appendMessage("assistant", "answer")
    expect(open().state("s1").messages).toEqual([user, assistant])
  })

  test("same-tick cards reload in write order regardless of the timestamp index", () => {
    const { db, open } = harness()
    const session = open()
    db.exec("CREATE INDEX cards_at_id ON cards(at, id, json)")
    vi.spyOn(Date, "now").mockReturnValue(10)
    session.appendCard(card)
    const second = { ...card, id: "a-card" }
    session.appendCard(second)
    expect(open().state("s1").cards).toEqual([card, second])
  })

  test("card replacement preserves its timestamp and interleaved position after eviction", () => {
    const { db, open } = harness()
    const session = open()
    const now = vi.spyOn(Date, "now").mockReturnValue(10)
    const first = session.appendMessage("user", "question")
    session.appendCard(card)
    const last = session.appendMessage("assistant", "answer")
    now.mockReturnValue(20)
    session.appendCard({ ...card, html: "after" })
    expect(db.prepare("SELECT at FROM cards").get()).toEqual({ at: 10 })
    const state = open().state("s1")
    expect(state.entries).toEqual([
      { kind: "message", messageId: first.id },
      { kind: "card", cardId: card.id },
      { kind: "message", messageId: last.id }
    ])
    expect(state.cards).toEqual([{ ...card, html: "after" }])
  })

  test("migrates old rows once with deterministic timestamp ties and continues the sequence", () => {
    const { db, open } = harness()
    db.exec(`
      CREATE TABLE messages (id TEXT PRIMARY KEY, role TEXT NOT NULL, text TEXT NOT NULL, at INTEGER NOT NULL);
      CREATE TABLE cards (id TEXT PRIMARY KEY, json TEXT NOT NULL, at INTEGER NOT NULL);
      INSERT INTO messages VALUES ('z', 'user', 'question', 1), ('a', 'assistant', 'answer', 1), ('last', 'assistant', 'later', 3);
    `)
    db.prepare("INSERT INTO cards VALUES (?, ?, ?)").run(card.id, JSON.stringify(card), 2)
    const session = open()
    const expected = [
      { kind: "message", messageId: "z" },
      { kind: "message", messageId: "a" },
      { kind: "card", cardId: card.id },
      { kind: "message", messageId: "last" }
    ]
    expect(session.state("s1").entries).toEqual(expected)
    // Wall clock rollback must not reorder new writes ahead of migrated ones.
    vi.spyOn(Date, "now").mockReturnValue(0)
    session.appendCard({ ...card, html: "updated" })
    const next = session.appendMessage("user", "next")
    expect(open().state("s1").entries).toEqual([...expected, { kind: "message", messageId: next.id }])
  })
})


describe("persisted card decoding", () => {
  test("a row that no longer decodes is dropped instead of failing the whole session", () => {
    const { db, open } = harness()
    const session = open()
    const before = session.appendMessage("user", "question")
    session.appendCard(card)
    const after = session.appendMessage("assistant", "answer")
    const insert = db.prepare("INSERT INTO cards (id, json, at, seq) VALUES (?, ?, ?, ?)")
    // A phase this build's AppCard union no longer admits, as an older deploy wrote it.
    insert.run(
      "stale-shape",
      JSON.stringify({ kind: "flow-run", id: "stale-shape", flowId: "f", executionId: "e", phase: "paused", steps: [] }),
      10,
      98
    )
    insert.run("truncated", '{"kind":"html","id":"truncated","html":"half', 10, 99)
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})

    const state = session.state("s1")

    expect(state.cards).toEqual([card])
    expect(state.entries).toEqual([
      { kind: "message", messageId: before.id },
      { kind: "card", cardId: card.id },
      { kind: "message", messageId: after.id }
    ])
    // What the shell does with the response; an undecodable row used to fail it.
    expect(Schema.decodeUnknownSync(SessionState)(state).cards).toEqual([card])
    const logged = warn.mock.calls.map((call) => call.join(" ")).join("\n")
    expect(logged).toContain("stale-shape")
    expect(logged).toContain("truncated")
  })
})

describe("the registry role", () => {
  const summary = (overrides: Partial<SessionSummary> = {}): SessionSummary => ({
    id: "s1",
    title: "first message",
    status: "running",
    stage: "chat",
    at: 100,
    ...overrides
  })

  test("a status that arrives late never overwrites a newer one", () => {
    const registry = harness().open()
    registry.recordSession(summary({ at: 100, status: "running" }))
    registry.recordSession(summary({ at: 200, status: "ready", stage: "build" }))
    // The turn-start write, delivered after the settle write it preceded.
    registry.recordSession(summary({ at: 150, status: "running", stage: "chat" }))
    expect(registry.sessions()).toEqual([
      { id: "s1", title: "first message", status: "ready", stage: "build", at: 200 }
    ])
  })

  test("the title is written once", () => {
    const registry = harness().open()
    registry.recordSession(summary({ at: 100, title: "first message" }))
    registry.recordSession(summary({ at: 200, title: "a later turn" }))
    expect(registry.sessions()[0]?.title).toBe("first message")
  })

  test("answers with one page, newest first, and keeps the table bounded", () => {
    const { db, open } = harness()
    const registry = open()
    const insert = db.prepare("INSERT INTO sessions (id, title, status, stage, at) VALUES (?, ?, ?, ?, ?)")
    for (let index = 0; index < 1200; index += 1) insert.run(`s${index}`, `session ${index}`, "ready", "chat", index)

    registry.recordSession(summary({ id: "newest", at: 2000 }))

    const listed = registry.sessions()
    expect(listed).toHaveLength(100)
    expect(listed[0]).toEqual({ id: "newest", title: "first message", status: "running", stage: "chat", at: 2000 })
    expect(listed.map((row) => row.at)).toEqual([...listed.map((row) => row.at)].sort((left, right) => right - left))
    expect(db.prepare("SELECT COUNT(*) AS rows FROM sessions").get()).toEqual({ rows: 1000 })
    expect(db.prepare("SELECT MIN(at) AS oldest FROM sessions").get()).toEqual({ oldest: 201 })
  })

  test("reads the page off the timestamp index rather than sorting the table", () => {
    const { db, open } = harness()
    open()
    const plan = db
      .prepare("EXPLAIN QUERY PLAN SELECT id, title, status, stage, at FROM sessions ORDER BY at DESC LIMIT 100")
      .all()
      .map((row) => String((row as { detail: string }).detail))
      .join("\n")
    expect(plan).toContain("sessions_at")
    expect(plan).not.toContain("TEMP B-TREE")
  })
})

import { describe, expect, spyOn, test } from "bun:test"
import * as Effect from "effect/Effect"
import type { AgentTurnCursor, AgentTurnJournalHead } from "@smthrs/rpc/AgentTurnJournal"
import { memoryStorage, storageLayer } from "./DurableStorage"
import type { NativeStorage } from "./DurableStorage"
import { TurnCancelRegistry } from "./turns"
import { memoryDurableObjects } from "./memoryDurableObjects"
import { TURN_JOURNAL_HEAD_KEY, TURN_JOURNAL_RETENTION_MS, turnJournalBatchKey, verifyTurnJournal } from "./TurnJournal"

const auth = { ownerHash: "1".repeat(64), accessHash: "2".repeat(64) }
const writerHash = "3".repeat(64)
const acceptance = { operation: "accept", runId: "turn", legId: "leg-1", ...auth, writerHash, requestHash: "4".repeat(64) }
const delta = (text: string) => ({ runId: "turn", type: "delta", kind: "text", text })
const terminal = { runId: "turn", type: "done", reason: "stop" }
const call = async (object: TurnCancelRegistry, body: unknown) => {
  const response = await object.fetch(new Request("https://turn-cancel.internal/journal", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body)
  }))
  return { status: response.status, body: await response.json() as any }
}
const create = async (storage: NativeStorage = memoryStorage()) => {
  const object = new TurnCancelRegistry({ storage })
  const accepted = await call(object, acceptance)
  expect(accepted.status).toBe(200)
  expect(accepted.body.status).toBe("accepted")
  return { object, initial: accepted.body.cursor as AgentTurnCursor }
}
const append = (object: TurnCancelRegistry, expected: AgentTurnCursor, frames: unknown[]) =>
  call(object, { operation: "append", writerHash, expected, frames })
const read = (object: TurnCancelRegistry, after: AgentTurnCursor | null = null, limit = 16) =>
  call(object, { operation: "read", ...auth, after, limit })

describe("durable turn output", () => {
  test("concurrent acceptance grants one writer; retries cannot re-execute accepted inference", async () => {
    const storage = memoryStorage()
    const object = new TurnCancelRegistry({ storage })
    const answers = await Promise.all(Array.from({ length: 12 }, (_, index) => call(object, { ...acceptance, writerHash: index.toString(16).repeat(64) })))
    expect(answers.filter(answer => answer.body.status === "accepted")).toHaveLength(1)
    expect(answers.filter(answer => answer.body.status === "existing")).toHaveLength(11)
    expect(answers.every(answer => !JSON.stringify(answer.body).includes("writerHash"))).toBe(true)
    expect((await call(object, { ...acceptance, requestHash: "5".repeat(64) })).status).toBe(409)
    expect((await call(object, { ...acceptance, ownerHash: "5".repeat(64) })).status).toBe(403)
  })

  test("more than a thousand frames replay in full across pages and a recreated object", async () => {
    const storage = memoryStorage()
    const { object, initial } = await create(storage)
    let cursor = initial
    const expected: unknown[] = []
    for (let from = 0; from < 1005; from += 100) {
      const frames = Array.from({ length: Math.min(100, 1005 - from) }, (_, offset) => delta(`chunk-${from + offset}`))
      expected.push(...frames)
      const answer = await append(object, cursor, frames)
      expect(answer.body.status).toBe("committed")
      cursor = answer.body.cursor
    }
    const done = await append(object, cursor, [terminal])
    cursor = done.body.cursor
    expected.push(terminal)
    const reopened = new TurnCancelRegistry({ storage })
    const replayed: unknown[] = []
    let after = initial
    do {
      const page = await read(reopened, after, 3)
      expect(page.status).toBe(200)
      expect(page.body.after).toEqual(after)
      replayed.push(...page.body.batches.flatMap((batch: any) => batch.frames))
      after = page.body.next
    } while (after.batch !== cursor.batch)
    expect(after).toEqual(cursor)
    expect(replayed).toEqual(expected)
    const verified = await Effect.runPromise(verifyTurnJournal.pipe(Effect.provide(storageLayer(storage))))
    expect(verified).toEqual(storage.data.get(TURN_JOURNAL_HEAD_KEY) as AgentTurnJournalHead)
    expect(verified.terminal).toBe(true)
    expect(verified.cursor.position).toBe(1006)
    expect((await append(reopened, cursor, [delta("after done")])).body.code).toBe("terminal")
  })

  test("a batch is invisible until its head commit and an uncommitted stage may be replaced", async () => {
    const storage = memoryStorage()
    let fail = false
    const { object, initial } = await create({ ...storage, put: async (key, value) => {
      if (fail && key === TURN_JOURNAL_HEAD_KEY) { fail = false; throw new Error("failed before head") }
      await storage.put(key, value)
    } })
    fail = true
    expect((await append(object, initial, [delta("unaccepted")])).status).toBe(503)
    expect(storage.data.has(turnJournalBatchKey(1))).toBe(true)
    const invisible = await read(object)
    expect(invisible.body.batches).toEqual([])
    expect(invisible.body.head).toEqual(initial)
    const retry = await append(object, initial, [delta("accepted")])
    expect(retry.body.status).toBe("committed")
    expect((await read(object)).body.batches[0].frames[0].text).toBe("accepted")
  })

  test("a lost receipt after commit returns the original batch; conflicting retries cannot overwrite it", async () => {
    const storage = memoryStorage()
    let fail = false
    const { object, initial } = await create({ ...storage, put: async (key, value) => {
      await storage.put(key, value)
      if (fail && key === TURN_JOURNAL_HEAD_KEY) { fail = false; throw new Error("receipt lost after head") }
    } })
    fail = true
    expect((await append(object, initial, [delta("once")])).status).toBe(503)
    const retried = await append(object, initial, [delta("once")])
    expect(retried.body.status).toBe("duplicate")
    expect(retried.body.cursor.position).toBe(1)
    expect((await append(object, initial, [delta("different")])).body.code).toBe("conflict")
    expect((await read(object)).body.batches).toHaveLength(1)
  })

  test("independent producers cannot commit different frames over the same head", async () => {
    const { object, initial } = await create()
    const answers = await Promise.all([append(object, initial, [delta("first")]), append(object, initial, [delta("second")])])
    expect(answers.map(answer => answer.status).sort()).toEqual([200, 409])
    expect((await read(object)).body.head.position).toBe(1)
    expect((await call(object, { operation: "append", writerHash: "9".repeat(64), expected: initial, frames: [delta("foreign")] })).status).toBe(403)
  })

  test("foreign scopes, invented cursors and malformed output are refused", async () => {
    const { object, initial } = await create()
    expect((await call(object, { operation: "read", ...auth, ownerHash: "9".repeat(64), after: null, limit: 1 })).status).toBe(403)
    expect((await call(object, { operation: "read", ...auth, accessHash: "9".repeat(64), after: null, limit: 1 })).status).toBe(403)
    expect((await read(object, { ...initial, legId: "another" })).body.code).toBe("cursor")
    expect((await read(object, { ...initial, hash: "9".repeat(64) })).body.code).toBe("cursor")
    expect((await append(object, initial, [{ ...delta("foreign"), runId: "another" }])).status).toBe(409)
    expect((await append(object, initial, [terminal, delta("after terminal")])).status).toBe(409)
    expect((await append(object, initial, [delta("x".repeat(100_000))])).body.code).toBe("limit")
    expect((await read(object)).body.head).toEqual(initial)
  })

  test("unknown versions, removed history and changed private bytes refuse recovery without leaking them", async () => {
    const storage = memoryStorage()
    const { object, initial } = await create(storage)
    await append(object, initial, [delta("private response body")])
    const saved = structuredClone(storage.data.get(turnJournalBatchKey(1))) as any
    const corrupted = structuredClone(saved)
    corrupted.frames[0].text = "secret modified response"
    storage.data.set(turnJournalBatchKey(1), corrupted)
    const answer = await read(object)
    expect(answer.status).toBe(500)
    expect(answer.body).toEqual({ status: "error", code: "corrupt" })
    storage.data.delete(turnJournalBatchKey(1))
    expect((await read(object)).status).toBe(500)
    storage.data.set(turnJournalBatchKey(1), saved)
    const head = structuredClone(storage.data.get(TURN_JOURNAL_HEAD_KEY)) as any
    head.version = 99
    storage.data.set(TURN_JOURNAL_HEAD_KEY, head)
    expect((await read(object)).status).toBe(500)
    expect(storage.data.get(TURN_JOURNAL_HEAD_KEY)).toEqual(head)
  })

  test("retirement hides output first and resumes erasure after failure, including an orphan stage", async () => {
    const storage = memoryStorage()
    let fail = true
    const { object, initial } = await create({ ...storage, delete: async key => {
      if (fail) { fail = false; throw new Error("delete failed") }
      await storage.delete!(key)
    } })
    await append(object, initial, [delta("private committed body")])
    storage.data.set(turnJournalBatchKey(2), { private: "uncommitted body" })
    const retire = () => call(object, { operation: "retire", ...auth })
    expect((await retire()).status).toBe(503)
    expect((await read(object)).status).toBe(410)
    expect((await call(object, acceptance)).status).toBe(410)
    expect((await retire()).body.status).toBe("retired")
    expect([...storage.data.keys()]).toEqual([TURN_JOURNAL_HEAD_KEY])
    expect(JSON.stringify([...storage.data.values()])).not.toContain("private")
    expect((await append(object, initial, [delta("late producer")])).status).toBe(410)
  })

  test("a recreated object verifies its complete prefix before accepting an existing identity or new output", async () => {
    const storage = memoryStorage()
    const { object, initial } = await create(storage)
    const committed = await append(object, initial, [delta("private history")])
    const head = structuredClone(storage.data.get(TURN_JOURNAL_HEAD_KEY))
    storage.data.delete(turnJournalBatchKey(1))
    const reopened = new TurnCancelRegistry({ storage })
    expect((await call(reopened, acceptance)).body.code).toBe("corrupt")
    expect((await append(reopened, committed.body.cursor, [delta("must not advance")])).body.code).toBe("corrupt")
    expect(storage.data.get(TURN_JOURNAL_HEAD_KEY)).toEqual(head)
    expect(storage.data.has(turnJournalBatchKey(2))).toBe(false)
    // Missing/corrupt output must remain erasable through the authenticated head.
    expect((await call(reopened, { operation: "retire", ...auth })).body.status).toBe("retired")
    expect([...storage.data.keys()]).toEqual([TURN_JOURNAL_HEAD_KEY])
  })

  test("a storage exception answers 503 and logs its operation and cause; a caller's refusal logs nothing", async () => {
    const logged: string[] = []
    const spy = spyOn(console, "error").mockImplementation((line: unknown) => { logged.push(String(line)) })
    try {
      const broken = new TurnCancelRegistry({ storage: { ...memoryStorage(), get: async () => { throw new Error("SQLITE_FULL") } } })
      expect((await read(broken)).status).toBe(503)
      expect(logged.map(line => JSON.parse(line))).toEqual([{
        event: "worker_seam_failure", seam: "turn journal object",
        cause: `StorageFailure(storage.get ${TURN_JOURNAL_HEAD_KEY}): Error: SQLITE_FULL`
      }])
      logged.length = 0
      const { object } = await create()
      expect((await call(object, { ...acceptance, ownerHash: "5".repeat(64) })).status).toBe(403)
      expect(logged).toEqual([])
    } finally { spy.mockRestore() }
  })

  test("acceptance schedules retention before its first write; the alarm deletes every batch page, then the head", async () => {
    const storage = memoryStorage()
    const events: string[] = []
    const alarmed: NativeStorage = { ...storage,
      setAlarm: async time => { events.push(`alarm ${time >= Date.now() + TURN_JOURNAL_RETENTION_MS - 60_000}`) },
      put: async (key, value) => { events.push(`put ${String(key)}`); await storage.put(key, value) } }
    await create(alarmed)
    expect(events).toEqual(["alarm true", `put ${TURN_JOURNAL_HEAD_KEY}`])
    for (let batch = 1; batch <= 300; batch++) storage.data.set(turnJournalBatchKey(batch), { private: batch })
    await new TurnCancelRegistry({ storage: alarmed }).alarm()
    expect([...storage.data.keys()]).toEqual([])
    expect((await call(new TurnCancelRegistry({ storage: alarmed }), acceptance)).body.status).toBe("accepted")
  })

  test("the Worker namespace fixture keeps the native dispatch, serialization, restart and erasure contract", async () => {
    const objects = memoryDurableObjects()
    const stub = () => objects.TURN_CANCELS.get(objects.TURN_CANCELS.idFromName("journal:turn:leg-1"))
    const request = (body: unknown) => stub().fetch(new Request("https://turn-cancel.internal/journal", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body)
    })).then(async response => ({ status: response.status, body: await response.json() as any }))
    const answers = await Promise.all([request(acceptance), request(acceptance)])
    expect(answers.map(answer => answer.body.status).sort()).toEqual(["accepted", "existing"])
    const cursor = answers[0]!.body.cursor
    expect((await request({ operation: "append", writerHash, expected: cursor, frames: [delta("retained")] })).body.status).toBe("committed")
    objects.restart()
    const replay = await request({ operation: "read", ...auth, after: null, limit: 1 })
    expect(replay.body.batches[0].frames[0].text).toBe("retained")
    expect((await request({ operation: "retire", ...auth })).body.status).toBe("retired")
    objects.restart()
    expect((await request({ operation: "read", ...auth, after: null, limit: 1 })).status).toBe(410)
  })
})

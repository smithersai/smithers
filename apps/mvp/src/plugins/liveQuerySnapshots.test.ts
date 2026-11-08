import { Collection, LiveQuery } from "@smthrs/effect-tanstack-db"
import { Deferred, Effect, Schema } from "effect"
import { expect, test } from "vitest"
import { RepoRole, Session } from "../features/auth/schema"
import { makeVisibility } from "../features/repo/gate"
import { gateLive, liveQueryOf } from "./plugins"

const Row = Schema.Struct({ id: Schema.String, repoId: Schema.String, position: Schema.Number })
const repoId = "github/acme/widgets"
const row = { id: "first", repoId, position: 1 }

const fixture = Effect.gen(function* () {
  const rows = yield* Collection.local({ id: crypto.randomUUID(), schema: Row, getKey: (row) => row.id })
  const roles = yield* Collection.local({ id: crypto.randomUUID(), schema: RepoRole, getKey: (row) => row.id })
  const sessions = yield* Collection.local({
    id: crypto.randomUUID(), schema: Session, getKey: (row) => row.id,
    initialData: [{ id: "session", status: "signed_in", role: null, login: null, available: true, signingOut: false, restored: true }],
  })
  const visibility = yield* makeVisibility(roles, sessions)
  const gated = yield* visibility.gate(rows)
  const live = yield* liveQueryOf(gated)
  return { rows, roles, sessions, visibility, live }
})

test("live snapshots retain their reference until rows change, including same-length updates and ordering", () =>
  Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const { rows } = yield* fixture
    const query = yield* LiveQuery.make((q) => q.from({ row: rows.tanstack }).orderBy(({ row }) => row.position, "asc"))
    const live = yield* liveQueryOf(query)
    const empty = live.current()
    expect(live.current()).toBe(empty)
    expect(empty).toEqual([])
    yield* rows.insert(row)
    const first = live.current()
    expect(first).not.toBe(empty)
    expect(first).toMatchObject([row])
    expect(live.current()).toBe(first)
    yield* rows.update(row.id, (draft) => { draft.position = 2 })
    const updated = live.current()
    expect(updated).not.toBe(first)
    expect(updated).toMatchObject([{ ...row, position: 2 }])
    expect(first).toMatchObject([row])
    expect(live.current()).toBe(updated)
    yield* rows.insert({ ...row, id: "second", position: 1 })
    const both = live.current()
    expect(both.map((row) => row.id)).toEqual(["second", "first"])
    yield* rows.update(row.id, (draft) => { draft.position = 0 })
    const reordered = live.current()
    expect(reordered).not.toBe(both)
    expect(reordered.map((row) => row.id)).toEqual(["first", "second"])
    expect(live.current()).toBe(reordered)
    yield* rows.delete("second")
    expect(live.current()).toMatchObject([{ ...row, position: 0 }])
    yield* rows.delete(row.id)
    expect(live.current()).toBe(empty)
  }))))

test("a cached live snapshot hides a refused repository in the same synchronous read and recovers fresh rows", () =>
  Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const { rows, roles, sessions, live } = yield* fixture
    yield* rows.insert(row)
    const first = live.current()
    expect(first).toMatchObject([row])
    yield* Effect.sync(() => {
      // No fiber or stream gets a turn between the refusal and the read.
      roles.tanstack.insert({ id: repoId, role: null, own: false, refused: "forbidden" })
      expect(live.current()).toEqual([])
      expect(live.current()).toBe(live.current())
      rows.tanstack.update(row.id, (draft) => { draft.position = 2 })
      expect(live.current()).toEqual([])
      roles.tanstack.update(repoId, (draft) => { draft.role = "member"; delete draft.refused })
      const restored = live.current()
      expect(restored).toMatchObject([{ ...row, position: 2 }])
      expect(restored).not.toBe(first)
      expect(live.current()).toBe(restored)
      sessions.tanstack.update("session", (draft) => { draft.status = "unreachable"; draft.unverifiable = true })
      expect(live.current()).toEqual([])
    })
  }))))

test("query notifications read the same fresh snapshot and stop after unsubscribe", () =>
  Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const { rows, live } = yield* fixture
    const firstChange = yield* Deferred.make<ReadonlyArray<typeof Row.Type>>()
    const secondChange = yield* Deferred.make<void>()
    const run = Effect.runSyncWith(yield* Effect.context<never>())
    let calls = 0
    const stop = live.subscribe(() => {
      const snapshot = live.current()
      if (snapshot.length === 0) return
      calls++
      run(Deferred.succeed(firstChange, snapshot))
    })
    const stopOther = live.subscribe(() => {
      if (live.current()[0]?.position === 2) run(Deferred.succeed(secondChange, undefined))
    })
    yield* rows.insert(row)
    const notified = yield* Deferred.await(firstChange).pipe(Effect.timeout("5 seconds"))
    expect(notified).toMatchObject([row])
    expect(live.current()).toBe(notified)
    stop()
    const before = calls
    yield* rows.update(row.id, (draft) => { draft.position = 2 })
    yield* Deferred.await(secondChange).pipe(Effect.timeout("5 seconds"))
    expect(calls).toBe(before)
    expect(live.current()).not.toBe(notified)
    expect(live.current()).toMatchObject([{ ...row, position: 2 }])
    stopOther()
  }))))

test("the public repository gate shares a frozen empty snapshot and synchronously follows visibility", () =>
  Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const { rows, roles, visibility } = yield* fixture
    yield* rows.insert(row)
    const query = yield* LiveQuery.make((q) => q.from({ row: rows.tanstack }))
    const source = yield* liveQueryOf(query)
    const host = {
      visible: (id: string) => visibility.visible.tanstack.get(id)?.show === true,
      onVisibility: (listener: () => void) => {
        const subscription = visibility.visible.tanstack.subscribeChanges(listener)
        return () => subscription.unsubscribe()
      },
    }
    const live = gateLive(host, repoId, source)
    expect(gateLive(host, repoId, source)).toBe(live)
    const other = gateLive(host, repoId, yield* liveQueryOf(query))
    const first = live.current()
    expect(first).toMatchObject([row])
    const heard: Array<ReadonlyArray<typeof Row.Type>> = []
    const stop = live.subscribe(() => { heard.push(live.current()) })
    yield* Effect.sync(() => {
      roles.tanstack.insert({ id: repoId, role: null, own: false, refused: "forbidden" })
      const hidden = live.current()
      expect(hidden).toEqual([])
      expect(live.current()).toBe(hidden)
      expect(other.current()).toBe(hidden)
      expect(Object.isFrozen(hidden)).toBe(true)
      expect(heard.at(-1)).toBe(hidden)
      roles.tanstack.update(repoId, (draft) => { draft.role = "member"; delete draft.refused })
      expect(live.current()).toBe(first)
      expect(heard.at(-1)).toBe(first)
      stop()
      const count = heard.length
      roles.tanstack.update(repoId, (draft) => { draft.refused = "forbidden" })
      expect(live.current()).toBe(hidden)
      expect(heard).toHaveLength(count)
    })
  }))))

import { Effect, Option } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { afterAll, describe, expect, it } from "vitest"
import * as Protocol from "../src/Protocol.ts"
import * as Store from "../src/Store.ts"
import { run, scratchDirectory } from "./Harness.ts"

const scratch = scratchDirectory()
afterAll(() => scratch.remove())

const session = (id: string, created: number): Protocol.Session => ({
  id,
  slug: "quiet-harbor",
  projectID: "p",
  directory: scratch.directory,
  path: "",
  title: "New session",
  version: "test",
  agent: "smithers",
  model: { id: "demo", providerID: "scripted" },
  cost: 0,
  tokens: Protocol.noTokens,
  time: { created, updated: created }
})

const user = (id: string, sessionID: string): Protocol.UserMessage => ({
  id,
  sessionID,
  role: "user",
  time: { created: 1 },
  agent: "smithers",
  model: { providerID: "scripted", modelID: "demo" }
})

const text = (id: string, messageID: string, sessionID: string, body: string): Protocol.TextPart => ({
  id,
  sessionID,
  messageID,
  type: "text",
  text: body
})

const withStore = <A>(body: (store: Store.Service) => Effect.Effect<A, Store.StoreError>) =>
  run(
    Effect.gen(function*() {
      const store = yield* Store.Store
      return yield* body(store)
    }).pipe(Effect.provide(Store.layerSqlite(`${scratch.directory}/nested/state/opencode.sqlite`)))
  )

describe("Store", () => {
  it("round-trips sessions newest first and deletes them with their rows", async () => {
    const listed = await withStore((store) =>
      Effect.gen(function*() {
        yield* store.putSession(session("ses_b", 2))
        yield* store.putSession(session("ses_a", 1))
        yield* store.putSession({ ...session("ses_a", 1), title: "Renamed" })
        yield* store.putMessage(user("msg_1", "ses_a"))
        yield* store.putPart(text("prt_1", "msg_1", "ses_a", "hi"))
        yield* store.putPermission({
          id: "per_1",
          sessionID: "ses_a",
          permission: "bash",
          patterns: ["ls"],
          metadata: {},
          always: ["ls *"],
          tool: { messageID: "msg_1", callID: "c" }
        })
        const sessions = yield* store.listSessions()
        const one = yield* store.getSession("ses_a")
        const missing = yield* store.getSession("ses_zzz")
        const deleted = yield* store.deleteSession("ses_a")
        const again = yield* store.deleteSession("ses_a")
        return {
          order: sessions.map((item) => item.id),
          title: Option.map(one, (item) => item.title),
          missing: Option.isNone(missing),
          deleted,
          again,
          left: yield* store.listSessions(),
          messages: yield* store.listMessages("ses_a"),
          permissions: yield* store.listPermissions("ses_a"),
          part: Option.isNone(yield* store.getPart("prt_1"))
        }
      })
    )
    expect(listed.order).toEqual(["ses_b", "ses_a"])
    expect(Option.getOrNull(listed.title)).toBe("Renamed")
    expect(listed.missing).toBe(true)
    expect(listed.deleted).toBe(true)
    expect(listed.again).toBe(false)
    expect(listed.left.map((item) => item.id)).toEqual(["ses_b"])
    expect(listed.messages).toEqual([])
    expect(listed.permissions).toEqual([])
    expect(listed.part).toBe(true)
  })

  it("lists messages oldest first with their parts, paged by limit and before", async () => {
    const result = await withStore((store) =>
      Effect.gen(function*() {
        yield* store.putSession(session("ses_m", 3))
        for (const index of [1, 2, 3]) {
          yield* store.putMessage(user(`msg_${index}`, "ses_m"))
          yield* store.putPart(text(`prt_${index}b`, `msg_${index}`, "ses_m", "second"))
          yield* store.putPart(text(`prt_${index}a`, `msg_${index}`, "ses_m", "first"))
        }
        yield* store.putMessage(user("msg_other", "ses_other"))
        const all = yield* store.listMessages("ses_m")
        const last = yield* store.listMessages("ses_m", { limit: 2 })
        const before = yield* store.listMessages("ses_m", { limit: 5, before: "msg_2" })
        const got = yield* store.getMessage("msg_2")
        const none = yield* store.getMessage("msg_nope")
        return { all, last, before, got: Option.isSome(got), none: Option.isNone(none) }
      })
    )
    expect(result.all.map((item) => item.info.id)).toEqual(["msg_1", "msg_2", "msg_3"])
    expect(result.all[0]!.parts.map((part) => part.id)).toEqual(["prt_1a", "prt_1b"])
    expect(result.last.map((item) => item.info.id)).toEqual(["msg_2", "msg_3"])
    expect(result.before.map((item) => item.info.id)).toEqual(["msg_1"])
    expect(result.got).toBe(true)
    expect(result.none).toBe(true)
  })

  it("applies what emitted events imply and ignores the rest", async () => {
    const result = await withStore((store) =>
      Effect.gen(function*() {
        const info = session("ses_e", 4)
        yield* store.apply({ type: "session.created", properties: { sessionID: info.id, info } })
        yield* store.apply({
          type: "session.updated",
          properties: { sessionID: info.id, info: { ...info, title: "T" } }
        })
        yield* store.apply({
          type: "message.updated",
          properties: { sessionID: info.id, info: user("msg_e", info.id) }
        })
        yield* store.apply({
          type: "message.part.updated",
          properties: { sessionID: info.id, part: text("prt_e", "msg_e", info.id, "Hel"), time: 1 }
        })
        yield* store.apply({
          type: "message.part.delta",
          properties: { sessionID: info.id, messageID: "msg_e", partID: "prt_e", field: "text", delta: "lo" }
        })
        yield* store.apply({
          type: "message.part.delta",
          properties: { sessionID: info.id, messageID: "msg_e", partID: "prt_e", field: "metadata", delta: "x" }
        })
        yield* store.apply({
          type: "message.part.delta",
          properties: { sessionID: info.id, messageID: "msg_e", partID: "prt_missing", field: "text", delta: "!" }
        })
        yield* store.apply({
          type: "permission.asked",
          properties: {
            id: "per_e",
            sessionID: info.id,
            permission: "bash",
            patterns: ["ls"],
            metadata: {},
            always: [],
            tool: { messageID: "msg_e", callID: "c" }
          }
        })
        const pending = yield* store.listPermissions()
        yield* store.apply({
          type: "permission.replied",
          properties: { sessionID: info.id, requestID: "per_e", reply: "once" }
        })
        yield* store.apply({ type: "session.status", properties: { sessionID: info.id, status: { type: "busy" } } })
        const title = Option.map(yield* store.getSession(info.id), (item) => item.title)
        const part = yield* store.getPart("prt_e")
        const after = yield* store.listPermissions()
        yield* store.apply({ type: "session.deleted", properties: { sessionID: info.id, info } })
        const gone = Option.isNone(yield* store.getSession(info.id))
        return { title: Option.getOrNull(title), part: Option.getOrNull(part), pending: pending.length, after, gone }
      })
    )
    expect(result.title).toBe("T")
    expect(result.part).toMatchObject({ text: "Hello", metadata: "x" })
    expect(result.pending).toBe(1)
    expect(result.after).toEqual([])
    expect(result.gone).toBe(true)
  })

  it("reports a refused statement as a StoreError", async () => {
    const outcome = await run(
      Effect.gen(function*() {
        const store = yield* Store.Store
        return yield* Effect.flip(
          store.putSession({ ...session("ses_bad", 1), id: undefined as unknown as string })
        )
      }).pipe(Effect.provide(Store.layerSqlite(`${scratch.directory}/refused.sqlite`)))
    )
    expect(outcome).toBeInstanceOf(Store.StoreError)
    expect(outcome.message).toBe("The session could not be stored")
  })

  it("fails to build when the tables cannot be created", async () => {
    const refusing = new Proxy(() => Effect.fail(new Error("refused")), {
      get: () => () => Effect.fail(new Error("refused"))
    }) as unknown as SqlClient.SqlClient
    const outcome = await run(
      Effect.flip(Store.make.pipe(Effect.provideService(SqlClient.SqlClient, refusing)))
    )
    expect(outcome).toBeInstanceOf(Store.StoreError)
    expect(outcome.message).toBe("The store could not create its tables")
  })
})

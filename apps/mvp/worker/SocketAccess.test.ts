// Socket leases (worker/SocketAccess.ts, worker/SocketChecks.ts): the transcript host (worker/runners/TranscriptHost.ts,
// what `RunContent` runs), the room (worker/BranchRooms.ts `room`, what `RoomObject` runs) and the terminal's gate, each
// over in-memory sockets and an in-memory storage whose alarm the test fires when the host armed it, on the test clock,
// against this file's schema of the compose Postgres (`pnpm db:up`).
import { PresenceRoom } from "@smthrs/sync"
import * as Cloudflare from "alchemy/Cloudflare"
import { Logger as StructuredLogger } from "@smthrs/observability"
import { Deferred, Effect, Fiber, Logger, Metric, Option } from "effect"
import { SqlClient } from "effect/sql"
import { TestClock } from "effect/testing"
import { beforeEach, describe, expect, test } from "vitest"
import * as TestDatabase from "../db/TestDatabase.ts"
import { RETENTION_MS } from "../src/features/transcript/contract.ts"
import type { Actor, Role } from "./Actor.ts"
import { branchAccess } from "./branch/Access.ts"
import * as BranchRooms from "./BranchRooms.ts"
import { repositoryOf } from "./github/Config.ts"
import * as RepoRoles from "./github/RepoRoles.ts"
import * as Store from "./runners/RunContent.ts"
import * as TranscriptHost from "./runners/TranscriptHost.ts"
import * as SessionStore from "./SessionStore.ts"
import * as SocketAccess from "./SocketAccess.ts"
import * as SocketChecks from "./SocketChecks.ts"
import { resetBranches, shared, tracked } from "./test/branch.ts"
import { branchRoles, testFile } from "./test/harness.ts"
import { sqliteStore } from "./test/runContent.ts"

const runtime = testFile("socket_access")
beforeEach(() => resetBranches(runtime))

/** The deployment's own repository: the session's role decides there (decision 0079). */
const HOME = "smithersai/smithers"
const RUN: SocketAccess.Basis = { kind: "run", repoId: `github/${HOME}` }
const BRANCH_REPO = "github/octocat/spoon-knife"
const HOUR = 60 * 60_000
const { LEASE_MS } = SocketAccess

/** An in-memory socket, shaped like Alchemy's: what it was sent, how it closed, what it keeps. */
class Socket implements SocketAccess.HostSocket {
  sent: Array<string> = []
  closed: { readonly code: number; readonly reason: string } | undefined
  private attachment: unknown = null
  /** As workerd's: a send or a close on a closed socket throws. */
  send: (text: string) => Effect.Effect<void> = (text) =>
    Effect.sync(() => {
      if (this.closed !== undefined) throw new Error("send on a closed socket")
      this.sent.push(text)
    })
  close = (code: number, reason: string) =>
    Effect.sync(() => {
      if (this.closed !== undefined) throw new Error("close on a closed socket")
      this.closed = { code, reason }
    })
  serializeAttachment = (value: unknown) => void (this.attachment = value === null ? null : structuredClone(value))
  deserializeAttachment = <T>() => this.attachment as T | null
  /** The `events` frames' event counts, in order. */
  events = () =>
    this.sent.map((text) => JSON.parse(text) as { type: string; events?: Array<unknown> })
      .filter((frame) => frame.type === "events").map((frame) => frame.events!.length)
  /** The rosters it was sent: each one's participants' principals. */
  rosters = () =>
    this.sent.map((text) => JSON.parse(text) as { type: string; participants?: Array<{ principal: string }> })
      .filter((frame) => frame.type === "roster").map((frame) => frame.participants!.map((each) => each.principal))
}

/**
 * A Durable Object's storage and alarm, in memory, over `store` when it has one: `deleteAll` drops its SQLite tables, as
 * the object's does. `fire` runs the alarm when the test clock reaches it.
 */
const memoryStorage = (store?: Store.Sql) => {
  const values = new Map<string, unknown>()
  let alarm: number | null = null
  const storage: TranscriptHost.Storage<SqlClient.SqlClient> = {
    get: <T>(key: string) => Effect.sync(() => values.get(key) as T | undefined),
    put: (key, value) => Effect.sync(() => void values.set(key, structuredClone(value))),
    getAlarm: () => Effect.sync(() => alarm),
    setAlarm: (at) => Effect.sync(() => void (alarm = at)),
    deleteAll: () =>
      Effect.sync(() => {
        values.clear()
        for (const table of ["events", "generations", "meta"]) store?.exec(`DROP TABLE IF EXISTS ${table}`)
      }),
  }
  /** Moves the test clock to the alarm and runs `handler`, as Cloudflare does; the alarm is spent first. */
  const fire = <A, E, R>(handler: Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      if (alarm === null) throw new Error("no alarm armed")
      const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis)
      if (alarm > now) yield* TestClock.adjust(alarm - now)
      alarm = null
      return yield* handler
    })
  return { storage, values, fire, alarm: () => alarm }
}

const sql = (text: TemplateStringsArray, ...values: Array<unknown>) =>
  runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (client) => client(text, ...(values as Array<never>))))

/** A signed-in person with `role` and a session ending in `seconds`, its role confirmed now. */
const signIn = async (role: Role, seconds = 86_400): Promise<Actor> => {
  const person = crypto.randomUUID()
  const session = crypto.randomUUID()
  await sql`INSERT INTO people (id, github_id, github_login) VALUES (${person}, ${Math.floor(Math.random() * 1e9)}, ${`p${person.slice(0, 8)}`})`
  await sql`
    INSERT INTO sessions (id, token_digest, person_id, role, role_checked_at, role_verified_at, expires_at)
    VALUES (${session}, ${crypto.randomUUID()}, ${person}, ${role}, now(), now(), now() + make_interval(secs => ${seconds}))`
  return { subject: { kind: "person", id: person }, role, session }
}

const admit = async (actor: Actor, basis: SocketAccess.Basis = RUN, access: SocketAccess.Admission["access"] = "member") => {
  const admitted = await runtime.runPromise(SocketAccess.admit(actor, basis, access))
  if (admitted._tag !== "admitted") throw new Error(admitted._tag)
  return admitted.admission
}

/** The rules over this file's schema, with the deployment's own repository's `RepoRoles`. */
const checks = async () => {
  const scratch = await runtime.runPromise(Effect.service(TestDatabase.Scratch))
  const roles = await runtime.runPromise(
    RepoRoles.make(scratch.database, { repository: repositoryOf(HOME), app: Option.none() }),
  )
  const layer = branchRoles(scratch.database)
  const fresh = await runtime.runPromise(Effect.service(SocketAccess.roleFreshMs))
  return (admission: SocketAccess.Admission) => SocketChecks.verdict(roles, admission, fresh).pipe(Effect.provide(layer))
}

type Check = Awaited<ReturnType<typeof checks>>

/** What a host's `within` does in the object, here: the renewal runs with the file's Postgres client. */
const within = <A>(renewal: Effect.Effect<A, never, SqlClient.SqlClient>) => renewal

/** A transcript host over `store` and `storage`, with `sockets` open on it. */
const transcriptHost = (
  storage: TranscriptHost.Storage<SqlClient.SqlClient>,
  sockets: Array<Socket>,
  check: (admission: SocketAccess.Admission) => Effect.Effect<SocketAccess.Checked, never, SqlClient.SqlClient>,
  store = sqliteStore(),
  wrap: <A>(renewal: Effect.Effect<A, never, SqlClient.SqlClient>) => Effect.Effect<A, unknown, SqlClient.SqlClient> =
    within,
) => {
  // A test lists its sockets up front; the object holds one only once it is accepted, which `join` does.
  const held: Array<Socket> = []
  const host = TranscriptHost.make<SqlClient.SqlClient, SqlClient.SqlClient>({
    sql: store,
    storage,
    sockets: Effect.sync(() => held),
    check,
    within: wrap,
  })
  const join = (socket: SocketAccess.HostSocket, admission: SocketAccess.Admission, after: number) =>
    Effect.suspend(() => {
      if (!held.includes(socket as Socket)) held.push(socket as Socket)
      return host.join(socket, admission, after)
    })
  // A socket listed without joining is one an earlier incarnation accepted.
  const restore = Effect.suspend(() => {
    for (const socket of sockets) if (!held.includes(socket)) held.push(socket)
    return host.restore
  })
  return { ...host, join, restore }
}

const event = (seq: number) => ({
  seq,
  at: seq,
  kind: "agent_message_chunk",
  update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `word ${seq}` } },
})

/** Runs `body` on the test clock, set to the real time so Postgres' `now()` and the sessions' ends agree. */
const onTestClock = <A>(body: Effect.Effect<A, unknown, SqlClient.SqlClient>) =>
  runtime.runPromise(Effect.gen(function* () {
    yield* TestClock.setTime(Date.now())
    return yield* body
  }).pipe(Effect.provide(TestClock.layer())))

const now = Effect.clockWith((clock) => clock.currentTimeMillis)

const count = (host: string, outcome: string) =>
  Effect.runSync(Metric.value(Metric.withAttributes(SocketAccess.leases, { host, outcome }))).count

describe("a transcript's watchers", () => {
  test("a watcher whose role fell below Member gets no event once its lease lapses, and closes 1008", async () => {
    const check = await checks()
    const [kept, lowered] = [await signIn("member"), await signIn("member")]
    const [stays, goes] = [new Socket(), new Socket()]
    const host = transcriptHost(memoryStorage().storage, [stays, goes], check)
    const before = count("transcript", "revoked")
    await onTestClock(Effect.gen(function* () {
      yield* host.join(stays, yield* Effect.promise(() => admit(kept)), -1)
      yield* host.join(goes, yield* Effect.promise(() => admit(lowered)), -1)
      yield* host.append(1, [event(0)])
      yield* Effect.promise(() => sql`UPDATE sessions SET role = 'guest' WHERE id = ${lowered.session!}`)
      // Within the lease nothing is asked; past it, the next event renews both first.
      yield* TestClock.adjust(LEASE_MS + 1_000)
      yield* host.append(1, [event(1)])
    }))
    expect(goes.closed).toEqual({ code: 1008, reason: "no access" })
    expect(goes.events()).toEqual([1])
    expect(stays.closed).toBeUndefined()
    expect(stays.events()).toEqual([1, 1])
    expect(count("transcript", "revoked") - before).toBe(1)
  })

  test("a watcher who signed out closes 4401 at the alarm before its lease lapses; the other keeps receiving", async () => {
    const check = await checks()
    const [kept, leaving] = [await signIn("member"), await signIn("admin")]
    const [stays, goes] = [new Socket(), new Socket()]
    const { storage, fire, alarm } = memoryStorage()
    const host = transcriptHost(storage, [stays, goes], check)
    await onTestClock(Effect.gen(function* () {
      const admitted = yield* Effect.promise(() => admit(kept))
      yield* host.join(stays, admitted, -1)
      yield* host.join(goes, yield* Effect.promise(() => admit(leaving)), -1)
      expect(alarm()).toBe(admitted.admittedAt + LEASE_MS - SocketAccess.RENEW_AHEAD_MS)
      yield* SessionStore.revoke({ id: leaving.session! }, "sign_out")
      yield* fire(host.alarm)
      yield* host.append(1, [event(0)])
    }))
    expect(goes.closed).toEqual({ code: 4401, reason: "session ended" })
    expect(goes.events()).toEqual([])
    expect(stays.events()).toEqual([1])
  })

  // The clock contract (decision 0151 rule 9): the lease's end is the query's start on this Worker's clock plus what the
  // database said was left, so a Worker clock ahead of the database's or behind it neither cuts nor stretches it.
  test("a session's end on a skewed Worker clock is what the database says is left, from when the lookup started", async () => {
    const ending = await signIn("member", 600)
    for (const skew of [60 * 60 * 1000, -60 * 60 * 1000]) {
      const [admission, workerNow] = await runtime.runPromise(Effect.gen(function* () {
        yield* TestClock.setTime(Date.now() + skew)
        const workerNow = yield* now
        const admitted = yield* SocketAccess.admit(ending, RUN, "member")
        if (admitted._tag !== "admitted") return yield* Effect.die(new Error(admitted._tag))
        return [admitted.admission, workerNow] as const
      }).pipe(Effect.provide(TestClock.layer())))
      const left = admission.expiresAt! - workerNow
      expect(left, String(skew)).toBeGreaterThan(590_000)
      expect(left, String(skew)).toBeLessThanOrEqual(600_000)
    }
  })

  // The clock contract on renewal and freshness (decision 0151 rule 9): a role confirmed now is fresh whatever the
  // Worker's clock says, and a renewal's window starts when its check started, not when the slowest check finished.
  test("on a Worker clock an hour off the database's, a role confirmed now is fresh, at admission and at renewal", async () => {
    const check = await checks()
    const kept = await signIn("member")
    // Past the freshness window either way, so a Worker-clock comparison would call the role stale or not yet seen.
    const fresh = await runtime.runPromise(SocketAccess.roleFreshMs)
    for (const skew of [fresh + 60 * 60 * 1000, -(fresh + 60 * 60 * 1000)]) {
      const [admitted, renewed] = await runtime.runPromise(Effect.gen(function* () {
        yield* TestClock.setTime(Date.now() + skew)
        const admitted = yield* SocketAccess.admit(kept, RUN, "member")
        if (admitted._tag !== "admitted") return [admitted._tag, undefined] as const
        const [renewed] = yield* SocketAccess.renew("transcript", [admitted.admission], check, within)
        return [admitted._tag, renewed] as const
      }).pipe(Effect.provide(TestClock.layer())))
      expect(admitted, String(skew)).toBe("admitted")
      expect(renewed?.verdict, String(skew)).toBe("keep")
    }
  })

  test("a renewal's window runs from when its check started: a slow renewal doesn't stretch it", async () => {
    const check = await checks()
    const kept = await signIn("member")
    const [started, renewed] = await runtime.runPromise(Effect.gen(function* () {
      yield* TestClock.setTime(Date.now())
      const admitted = yield* SocketAccess.admit(kept, RUN, "member")
      if (admitted._tag !== "admitted") return yield* Effect.die(new Error(admitted._tag))
      const started = yield* now
      // The renewal's other work takes 4 s after this check answered, inside its deadline.
      const slow = <A>(renewal: Effect.Effect<A, never, SqlClient.SqlClient>) =>
        Effect.tap(renewal, () => TestClock.adjust(4_000))
      const [renewed] = yield* SocketAccess.renew("transcript", [admitted.admission], check, slow)
      return [started, renewed] as const
    }).pipe(Effect.provide(TestClock.layer())))
    expect(renewed!.verdict).toBe("keep")
    expect(renewed!.until).toBe(started + SocketAccess.LEASE_MS)
  })

  test("on a Worker clock an hour ahead of the database's, a lease still ends with its session: no event after it", async () => {
    const check = await checks()
    const ending = await signIn("member", 20)
    const socket = new Socket()
    const host = transcriptHost(memoryStorage().storage, [socket], check)
    await runtime.runPromise(Effect.gen(function* () {
      yield* TestClock.setTime(Date.now() + 60 * 60 * 1000)
      const admitted = yield* SocketAccess.admit(ending, RUN, "member")
      if (admitted._tag !== "admitted") return yield* Effect.die(new Error(admitted._tag))
      yield* host.join(socket, admitted.admission, -1)
      yield* host.append(1, [event(0)])
      yield* TestClock.adjust(20_001)
      yield* host.append(1, [event(1)])
    }).pipe(Effect.provide(TestClock.layer())))
    expect(socket.events()).toEqual([1])
    expect(socket.closed).toEqual({ code: 4401, reason: "session ended" })
  })

  // The admission's query and the renewal's take different times, so a renewal can measure the session's end a little
  // before the admission did. The lease is capped by the session all the same: no check in its last seconds, one alarm
  // at that end, and the socket closes there with no query.
  test("a renewal that measures the session's end just before the admission did schedules no more checks", async () => {
    let asked = 0
    const check = await checks()
    const ending = await signIn("member", 90)
    const socket = new Socket()
    const { storage, fire, alarm } = memoryStorage()
    const host = transcriptHost(storage, [socket], (admission) => Effect.suspend(() => (asked++, check(admission))))
    const admission = await admit(ending)
    await onTestClock(Effect.gen(function* () {
      yield* host.join(socket, admission, -1)
      // The test's database doesn't run on the test clock: its row moves by the time the clock will move, and 41 ms
      // more, the renewal query's latency the admission's didn't have.
      const elapsed = alarm()! - admission.admittedAt
      yield* Effect.promise(() =>
        sql`UPDATE sessions SET expires_at = expires_at - make_interval(secs => ${(elapsed + 41) / 1000}) WHERE id = ${ending.session!}`
      )
      yield* fire(host.alarm)
      expect(asked).toBe(1)
      const until = alarm()!
      expect(until).toBeLessThan(admission.expiresAt!)
      expect(until - (yield* now)).toBeGreaterThan(SocketAccess.RENEW_AHEAD_MS)
      expect(socket.closed).toBeUndefined()
      yield* fire(host.alarm)
    }))
    expect(asked).toBe(1)
    expect(socket.closed).toEqual({ code: 4401, reason: "session ended" })
  })

  test("a lease never runs past the session's end: no event after it, and 4401 with no query", async () => {
    let asked = 0
    const check = await checks()
    const ending = await signIn("member", 20)
    const socket = new Socket()
    const host = transcriptHost(memoryStorage().storage, [socket], (admission) =>
      Effect.suspend(() => (asked++, check(admission))))
    const admission = await admit(ending)
    await onTestClock(Effect.gen(function* () {
      yield* host.join(socket, admission, -1)
      yield* host.append(1, [event(0)])
      yield* TestClock.adjust(20_001)
      yield* host.append(1, [event(1)])
    }))
    expect(socket.events()).toEqual([1])
    expect(socket.closed).toEqual({ code: 4401, reason: "session ended" })
    expect(asked).toBe(0)
  })

  test("a handoff whose session ended on the way is refused, or sends nothing of its replay and closes 4401", async () => {
    const actor = await signIn("member", 20)
    const store = sqliteStore()
    Store.append(store, 1, [event(0), event(1)], 1)
    const expired = new Socket()
    const host = transcriptHost(memoryStorage().storage, [expired], () => Effect.succeed("keep"), store)
    const admission = await admit(actor)
    await onTestClock(Effect.gen(function* () {
      yield* TestClock.adjust(20_001)
      expect(yield* host.admissible(admission)).toBe("expired")
      yield* host.join(expired, admission, -1)
    }))
    expect(expired.sent).toEqual([])
    expect(expired.closed?.code).toBe(4401)
  })

  test("a failed role refresh renews nothing: the lease ends 1012, and the route answers stale", async () => {
    const check = await checks()
    const actor = await signIn("member")
    const socket = new Socket()
    const host = transcriptHost(memoryStorage().storage, [socket], check)
    const admission = await admit(actor)
    // Confirmed three hours ago; since then only checks that couldn't reach GitHub (`keepRole` moves role_checked_at).
    await sql`UPDATE sessions SET role_verified_at = now() - interval '3 hours' WHERE id = ${actor.session!}`
    await runtime.runPromise(SessionStore.keepRole(actor.session!))
    await onTestClock(Effect.gen(function* () {
      yield* host.join(socket, admission, -1)
      yield* TestClock.adjust(LEASE_MS + 1_000)
      yield* host.append(1, [event(0)])
    }))
    expect(socket.events()).toEqual([])
    expect(socket.closed).toEqual({ code: 1012, reason: "access unverified" })
    expect((await runtime.runPromise(SocketAccess.admit(actor, RUN, "member")))._tag).toBe("stale")
  })

  test("a check that never answers is cut off at its timeout, and the watcher closes 1012 with no grace", async () => {
    const actor = await signIn("member")
    const socket = new Socket()
    let asked = 0
    const host = transcriptHost(memoryStorage().storage, [socket], () => Effect.suspend(() => (asked++, Effect.never)))
    const admission = await admit(actor)
    await onTestClock(Effect.gen(function* () {
      yield* host.join(socket, admission, -1)
      yield* TestClock.adjust(LEASE_MS + 1_000)
      const append = yield* Effect.forkChild(host.append(1, [event(0)]))
      while (asked === 0) yield* Effect.yieldNow
      for (let i = 0; i < 10; i++) yield* Effect.yieldNow
      yield* TestClock.adjust(SocketAccess.CHECK_TIMEOUT_MS)
      yield* Fiber.join(append)
    }))
    expect(socket.events()).toEqual([])
    expect(socket.closed).toEqual({ code: 1012, reason: "access unverified" })
  })

  test("a renewal whose Postgres client can't be opened ends every lease in it", async () => {
    const actor = await signIn("member")
    const sockets = [new Socket(), new Socket()]
    const host = transcriptHost(memoryStorage().storage, sockets, () => Effect.succeed("keep"), sqliteStore(), () =>
      Effect.die(new Error("no database")))
    const admission = await admit(actor)
    await onTestClock(Effect.gen(function* () {
      for (const socket of sockets) yield* host.join(socket, admission, -1)
      yield* TestClock.adjust(LEASE_MS + 1_000)
      yield* host.append(1, [event(0)])
    }))
    expect(sockets.map((socket) => socket.closed?.code)).toEqual([1012, 1012])
    expect(sockets.map((socket) => socket.events())).toEqual([[], []])
  })

  test("one check per authority: two tabs admitted at different times cost one", async () => {
    const actor = await signIn("member")
    let asked = 0
    const sockets = [new Socket(), new Socket()]
    const host = transcriptHost(memoryStorage().storage, sockets, () => Effect.sync(() => (asked++, "keep" as const)))
    const first = await admit(actor)
    const second = await admit(actor)
    await onTestClock(Effect.gen(function* () {
      yield* host.join(sockets[0]!, first, -1)
      yield* host.join(sockets[1]!, { ...second, admittedAt: second.admittedAt + 1 }, -1)
      yield* TestClock.adjust(LEASE_MS + 2_000)
      yield* host.append(1, [event(0)])
    }))
    expect(asked).toBe(1)
    expect(sockets.map((socket) => socket.events())).toEqual([[1], [1]])
  })

  test("an alias session signed out at its host ends the socket, though its home session lives", async () => {
    const check = await checks()
    const actor = await signIn("member")
    const alias = crypto.randomUUID()
    await sql`INSERT INTO host_sessions (id, token_digest, parent_id, host) VALUES (${alias}, ${crypto.randomUUID()}, ${actor.session!}, 'alias.test')`
    const socket = new Socket()
    const host = transcriptHost(memoryStorage().storage, [socket], check)
    const admission = await admit({ ...actor, alias })
    await sql`UPDATE host_sessions SET revoked_at = now() WHERE id = ${alias}`
    await onTestClock(Effect.gen(function* () {
      yield* host.join(socket, admission, -1)
      yield* TestClock.adjust(LEASE_MS + 1_000)
      yield* host.append(1, [event(0)])
    }))
    expect(socket.closed?.code).toBe(4401)
  })

  test("a socket from before leases closes 1012 before this incarnation sends anything", async () => {
    const legacy = new Socket()
    const host = transcriptHost(memoryStorage().storage, [legacy], () => Effect.succeed("keep"))
    const before = count("transcript", "legacy")
    await onTestClock(Effect.gen(function* () {
      yield* host.restore
      yield* host.append(1, [event(0)])
    }))
    expect(legacy.sent).toEqual([])
    expect(legacy.closed).toEqual({ code: 1012, reason: "reconnect" })
    expect(count("transcript", "legacy") - before).toBe(1)
  })

  test("one person holds at most MAX_SOCKETS_PER_PERSON sockets on one run", async () => {
    const actor = await signIn("member")
    const admission = await admit(actor)
    const sockets = Array.from({ length: SocketAccess.MAX_SOCKETS_PER_PERSON }, () => new Socket())
    const host = transcriptHost(memoryStorage().storage, sockets, () => Effect.succeed("keep"))
    await onTestClock(Effect.forEach(sockets, (socket) => host.join(socket, admission, -1), { discard: true }))
    expect(await runtime.runPromise(host.admissible(admission))).toBe("crowded")
    const other = await admit(await signIn("member"))
    expect(await runtime.runPromise(host.admissible(other))).toBeUndefined()
  })

  test("a transcript from before retain_until keeps its events through renewals until its real retention", async () => {
    const check = await checks()
    const actor = await signIn("member")
    const store = sqliteStore()
    const { storage, values, fire, alarm } = memoryStorage(store)
    const socket = new Socket()
    await onTestClock(Effect.gen(function* () {
      const start = yield* now
      // Stored a day ago by the code before `retain_until`: only its alarm says when it is forgotten.
      Store.append(store, 1, [event(0)], start - 24 * HOUR)
      yield* storage.setAlarm(start - 24 * HOUR + RETENTION_MS)
      const host = transcriptHost(storage, [socket], check, store)
      const admission = yield* Effect.promise(() => admit(actor))
      yield* host.join(socket, admission, -1)
      // The renewal's alarm replaced the retention's; the deadline is kept under the key instead.
      expect(alarm()).toBe(admission.admittedAt + LEASE_MS - SocketAccess.RENEW_AHEAD_MS)
      expect(values.get(TranscriptHost.RETAIN_KEY)).toBe(start - 24 * HOUR + RETENTION_MS)
      yield* fire(host.alarm)
      expect(Store.summary(store).events).toBe(1)
      expect(socket.closed).toBeUndefined()
      // The watcher leaves; the next alarm is the retention, and only then is it forgotten.
      socket.serializeAttachment({ dropped: true })
      yield* fire(host.alarm)
      expect(alarm()).toBe(start - 24 * HOUR + RETENTION_MS)
      yield* fire(host.alarm)
      expect(values.size).toBe(0)
      expect(store.exec(`SELECT name FROM sqlite_master WHERE name = 'events'`)).toEqual([])
    }))
  })

  test("a watcher that closed under its lease costs only itself: the others get the event and their closes", async () => {
    const check = await checks()
    const [gone, stays, revoked, alsoRevoked] = [new Socket(), new Socket(), new Socket(), new Socket()]
    const host = transcriptHost(memoryStorage().storage, [gone, stays, revoked, alsoRevoked], check)
    const [a, b, c, d] = [await signIn("member"), await signIn("member"), await signIn("member"), await signIn("member")]
    await onTestClock(Effect.gen(function* () {
      for (const [socket, actor] of [[gone, a], [stays, b], [revoked, c], [alsoRevoked, d]] as const) {
        yield* host.join(socket, yield* Effect.promise(() => admit(actor)), -1)
      }
      // The page goes away between the lease check and the send: its attachment still says it is leased.
      gone.closed = { code: 1006, reason: "" }
      yield* host.append(1, [event(0)])
      expect(stays.events()).toEqual([1])
      // Its close throws too, and the next ending socket still closes.
      revoked.closed = { code: 1006, reason: "" }
      yield* Effect.promise(() => sql`UPDATE sessions SET role = 'guest' WHERE id IN (${c.session!}, ${d.session!})`)
      yield* TestClock.adjust(LEASE_MS + 1_000)
      yield* host.append(1, [event(1)])
    }))
    expect(alsoRevoked.closed?.code).toBe(1008)
    expect(stays.events()).toEqual([1, 1])
  })

  test("forgetting a transcript survives a socket already closed", async () => {
    const store = sqliteStore()
    const { storage, values, fire } = memoryStorage(store)
    const socket = new Socket()
    const actor = await signIn("member")
    await onTestClock(Effect.gen(function* () {
      const start = yield* now
      Store.append(store, 1, [event(0)], start - RETENTION_MS + 1_000)
      const host = transcriptHost(storage, [socket], () => Effect.succeed("keep"), store)
      yield* host.join(socket, yield* Effect.promise(() => admit(actor)), -1)
      socket.closed = { code: 1006, reason: "" }
      yield* fire(host.alarm)
    }))
    expect(values.size).toBe(0)
    expect(store.exec(`SELECT name FROM sqlite_master WHERE name = 'events'`)).toEqual([])
  })

  test("mixed deadlines: an ended watcher gets nothing while another's renewal waits, and a late keep renews nothing", async () => {
    const actorA = await signIn("member", 20)
    const actorB = await signIn("member")
    const actorC = await signIn("member", 63)
    const [a, b, c] = [new Socket(), new Socket(), new Socket()]
    const release = Effect.runSync(Deferred.make<void>())
    // Every check waits until released, then keeps: B's is the one that waits, C's answers keep after C's end.
    const host = transcriptHost(memoryStorage().storage, [a, b, c], () => Effect.as(Deferred.await(release), "keep" as const))
    const [admittedA, admittedB, admittedC] = [await admit(actorA), await admit(actorB), await admit(actorC)]
    await onTestClock(Effect.gen(function* () {
      yield* host.join(a, admittedA, -1)
      yield* host.join(b, admittedB, -1)
      yield* host.join(c, admittedC, -1)
      // A's session ended at 20 s; B's and C's leases lapse at 60 s, and C's session ends at 63 s, while its check waits.
      yield* TestClock.adjust(LEASE_MS + 1_000)
      const append = yield* Effect.forkChild(host.append(1, [event(0)]))
      for (let i = 0; i < 20; i++) yield* Effect.yieldNow
      yield* TestClock.adjust(3_000)
      expect([a, b, c].map((socket) => socket.events())).toEqual([[], [], []])
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(append)
    }))
    expect(a.events()).toEqual([])
    expect(a.closed?.code).toBe(4401)
    expect(b.events()).toEqual([1])
    expect(c.events()).toEqual([])
    expect(c.closed?.code).toBe(4401)
  })

  test("an alarm at the retention, while a new event's renewal waits, keeps the transcript the event just extended", async () => {
    const actor = await signIn("member")
    const store = sqliteStore()
    const { storage, values, alarm } = memoryStorage(store)
    const socket = new Socket()
    const release = Effect.runSync(Deferred.make<void>())
    const host = transcriptHost(storage, [socket], () => Effect.as(Deferred.await(release), "keep" as const), store)
    await onTestClock(Effect.gen(function* () {
      const start = yield* now
      // Its last event was stored a retention ago, less a second: it is due to be forgotten a second from now.
      Store.append(store, 1, [event(0)], start - RETENTION_MS + 1_000)
      yield* host.join(socket, yield* Effect.promise(() => admit(actor)), -1)
      expect(values.get(TranscriptHost.RETAIN_KEY)).toBe(start + 1_000)
      yield* TestClock.adjust(LEASE_MS + 1_000)
      // A new event: stored with its retention, then waiting on the watcher's renewal.
      const append = yield* Effect.forkChild(host.append(1, [event(1)]))
      for (let i = 0; i < 20; i++) yield* Effect.yieldNow
      // The old retention's alarm fires meanwhile.
      expect(alarm()).not.toBeNull()
      const fired = yield* Effect.forkChild(host.alarm)
      for (let i = 0; i < 20; i++) yield* Effect.yieldNow
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(append)
      yield* Fiber.join(fired)
    }))
    expect(Store.summary(store).events).toBe(2)
    expect(socket.events()).toEqual([1, 1])
  })

  test("a lease the session's end caps is acted on at that end, not renewed in a loop before it", async () => {
    let asked = 0
    const check = await checks()
    const actor = await signIn("member", 15)
    const socket = new Socket()
    const { storage, fire, alarm } = memoryStorage()
    const host = transcriptHost(storage, [socket], (admission) => Effect.suspend(() => (asked++, check(admission))))
    const admission = await admit(actor)
    await onTestClock(Effect.gen(function* () {
      yield* host.join(socket, admission, -1)
      expect(alarm()).toBe(admission.expiresAt)
      yield* fire(host.alarm)
    }))
    expect(asked).toBe(0)
    expect(socket.closed?.code).toBe(4401)
    expect(alarm()).toBeNull()
  })
})

describe("a branch's room", () => {
  const roomOver = async (sockets: Array<Socket>, check?: Check) => {
    const { storage, fire, alarm } = memoryStorage()
    const rooms = BranchRooms.room({
      sockets: Effect.sync(() => sockets),
      storage,
      check: check ?? (await checks()),
      within,
    })
    return { rooms, fire, alarm }
  }

  const join = async (rooms: Awaited<ReturnType<typeof roomOver>>["rooms"], sockets: Array<Socket>, actor: Actor, branchId: string) => {
    const branch = await runtime.runPromise(branchAccess(Option.some(actor), branchId).pipe(
      Effect.provide(branchRoles((await runtime.runPromise(Effect.service(TestDatabase.Scratch))).database)),
    ))
    if (branch === undefined || branch.access === "none") throw new Error("not admitted")
    const admission = await admit(actor, { kind: "branch", branchId }, branch.access)
    const socket = new Socket()
    sockets.push(socket)
    await onTestClock(PresenceRoom.join(rooms.host, socket, BranchRooms.identityOf({
      principal: actor.subject.id,
      name: actor.subject.id,
      role: actor.role,
      access: branch.access,
      admission,
    }, SocketAccess.leaseFrom(admission, admission.admittedAt))))
    return socket
  }

  test("everyone whose share was removed leaves before any roster: none of them hears another's leaving", async () => {
    const owner = await signIn("member")
    const [a, b] = [await signIn("member"), await signIn("member")]
    const branch = await tracked(runtime, BRANCH_REPO, "feature/recheck", "open", owner.subject.id)
    await shared(runtime, branch.branchId, a.subject.id, "view")
    await shared(runtime, branch.branchId, b.subject.id, "view")
    const sockets: Array<Socket> = []
    const { rooms, fire } = await roomOver(sockets)
    const stays = await join(rooms, sockets, owner, branch.branchId)
    const [goesA, goesB] = [await join(rooms, sockets, a, branch.branchId), await join(rooms, sockets, b, branch.branchId)]
    const heard = [goesA.sent.length, goesB.sent.length]
    // A share removed where `enforce` never reached the room: the renewal still does.
    await sql`DELETE FROM branch_shares WHERE branch_id = ${branch.branchId} AND grantee <> ${owner.subject.id}`
    await onTestClock(Effect.gen(function* () {
      yield* rooms.arm
      yield* fire(rooms.alarm)
    }))
    expect([goesA.closed?.code, goesB.closed?.code]).toEqual([1008, 1008])
    expect([goesA.sent.length, goesB.sent.length]).toEqual(heard)
    expect(stays.closed).toBeUndefined()
    expect(stays.rosters().at(-1)).toEqual([owner.subject.id])
  })

  test("someone whose role fell to Guest loses the repository's link share and closes 1008", async () => {
    const owner = await signIn("member")
    const member = await signIn("member")
    const branch = await tracked(runtime, BRANCH_REPO, "feature/link", "open", owner.subject.id)
    await shared(runtime, branch.branchId, "repository", "edit")
    const sockets: Array<Socket> = []
    const { rooms, fire } = await roomOver(sockets)
    const stays = await join(rooms, sockets, owner, branch.branchId)
    const goes = await join(rooms, sockets, member, branch.branchId)
    await sql`UPDATE sessions SET role = 'guest' WHERE id = ${member.session!}`
    await onTestClock(Effect.andThen(rooms.arm, fire(rooms.alarm)))
    expect(goes.closed?.code).toBe(1008)
    expect(stays.closed).toBeUndefined()
  })

  test("someone whose session ended closes 4401; someone whose access narrowed reconnects with 1012", async () => {
    const owner = await signIn("member")
    const editor = await signIn("member")
    const branch = await tracked(runtime, BRANCH_REPO, "feature/ended", "open", owner.subject.id)
    await shared(runtime, branch.branchId, editor.subject.id, "edit")
    const sockets: Array<Socket> = []
    const { rooms, fire } = await roomOver(sockets)
    const ended = await join(rooms, sockets, owner, branch.branchId)
    const narrowed = await join(rooms, sockets, editor, branch.branchId)
    await runtime.runPromise(SessionStore.revoke({ id: owner.session! }, "sign_out"))
    await shared(runtime, branch.branchId, editor.subject.id, "view")
    await onTestClock(Effect.andThen(rooms.arm, fire(rooms.alarm)))
    expect(ended.closed?.code).toBe(4401)
    expect(narrowed.closed?.code).toBe(1012)
  })

  test("a message from a member whose lease lapsed waits for its renewal, and is dropped if it isn't renewed", async () => {
    const owner = await signIn("member")
    const guest = await signIn("member")
    const branch = await tracked(runtime, BRANCH_REPO, "feature/message", "open", owner.subject.id)
    await shared(runtime, branch.branchId, guest.subject.id, "view")
    const sockets: Array<Socket> = []
    const { rooms } = await roomOver(sockets)
    const stays = await join(rooms, sockets, owner, branch.branchId)
    const goes = await join(rooms, sockets, guest, branch.branchId)
    await sql`DELETE FROM branch_shares WHERE branch_id = ${branch.branchId} AND grantee = ${guest.subject.id}`
    const heard = stays.sent.length
    await onTestClock(Effect.gen(function* () {
      yield* TestClock.adjust(LEASE_MS + 1_000)
      yield* rooms.receive(goes, JSON.stringify({ type: "state", state: JSON.stringify({ view: "code", path: "a.ts" }) }))
    }))
    expect(goes.closed?.code).toBe(1008)
    // The owner hears the guest leave, never the guest's state.
    expect(stays.sent.slice(heard).some((text) => text.includes("a.ts"))).toBe(false)
  })

  test("a burst of messages on lapsed leases costs one renewal", async () => {
    const owner = await signIn("member")
    const branch = await tracked(runtime, BRANCH_REPO, "feature/burst", "open", owner.subject.id)
    const sockets: Array<Socket> = []
    let asked = 0
    const release = Effect.runSync(Deferred.make<void>())
    const real = await checks()
    const { rooms } = await roomOver(sockets, (admission) =>
      Effect.suspend(() => (asked++, Effect.andThen(Deferred.await(release), real(admission)))))
    const member = await join(rooms, sockets, owner, branch.branchId)
    await onTestClock(Effect.gen(function* () {
      yield* TestClock.adjust(LEASE_MS + 1_000)
      const message = JSON.stringify({ type: "state", state: JSON.stringify({ view: "code", path: "a.ts" }) })
      const burst = yield* Effect.forkChild(
        Effect.forEach(Array.from({ length: 10 }), () => rooms.receive(member, message), { concurrency: "unbounded" }),
      )
      for (let i = 0; i < 20; i++) yield* Effect.yieldNow
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(burst)
    }))
    expect(asked).toBe(1)
    expect(member.closed).toBeUndefined()
  })

  test("a message reaches the room though the object hands it a different wrapper of the socket", async () => {
    const owner = await signIn("member")
    const guest = await signIn("member")
    const branch = await tracked(runtime, BRANCH_REPO, "feature/wrapper", "open", owner.subject.id)
    await shared(runtime, branch.branchId, guest.subject.id, "view")
    // Raw sockets, as workerd holds them; Alchemy wraps each anew for `getWebSockets()` and for every event.
    const raw = () => {
      let attachment: unknown = null
      const sent: Array<string> = []
      return {
        sent,
        send: (data: string) => void sent.push(data),
        close: () => undefined,
        serializeAttachment: (value: unknown) => void (attachment = structuredClone(value)),
        deserializeAttachment: () => attachment,
      }
    }
    const [rawOwner, rawGuest] = [raw(), raw()]
    const wrap = (socket: ReturnType<typeof raw>) => Cloudflare.fromWebSocket(socket as never)
    const { storage } = memoryStorage()
    const rooms = BranchRooms.room({
      sockets: Effect.sync(() => [wrap(rawOwner), wrap(rawGuest)]),
      storage,
      check: await checks(),
      within,
    })
    for (const [actor, socket] of [[owner, rawOwner], [guest, rawGuest]] as const) {
      const access = actor === owner ? "owner" as const : "view" as const
      const admission = await admit(actor, { kind: "branch", branchId: branch.branchId }, access)
      await onTestClock(PresenceRoom.join(rooms.host, wrap(socket), BranchRooms.identityOf({
        principal: actor.subject.id,
        name: actor.subject.id,
        role: actor.role,
        access,
        admission,
      }, SocketAccess.leaseFrom(admission, admission.admittedAt))))
    }
    const heard = rawOwner.sent.length
    await onTestClock(rooms.receive(wrap(rawGuest), JSON.stringify({ type: "state", state: "here" })))
    expect(rawOwner.sent.slice(heard).some((text) => text.includes("here"))).toBe(true)
  })

  test("a member whose session ends during a roster gets no part of it", async () => {
    const [first, ending, last] = [await signIn("member"), await signIn("member", 25), await signIn("member")]
    const branch = await tracked(runtime, BRANCH_REPO, "feature/roster", "open", first.subject.id)
    await shared(runtime, branch.branchId, ending.subject.id, "view")
    await shared(runtime, branch.branchId, last.subject.id, "view")
    const sockets: Array<Socket> = []
    const { rooms } = await roomOver(sockets, () => Effect.succeed("keep"))
    const slow = await join(rooms, sockets, first, branch.branchId)
    const ends = await join(rooms, sockets, ending, branch.branchId)
    // The first member's send takes 30 s, past the second's session end, before the roster reaches the second.
    const send = slow.send
    slow.send = (text: string) => Effect.andThen(send(text), TestClock.adjust(30_000))
    const heard = ends.sent.length
    const admission = await admit(last, { kind: "branch", branchId: branch.branchId }, "view")
    const socket = new Socket()
    sockets.push(socket)
    await onTestClock(PresenceRoom.join(rooms.host, socket, BranchRooms.identityOf({
      principal: last.subject.id,
      name: last.subject.id,
      role: last.role,
      access: "view",
      admission,
    }, SocketAccess.leaseFrom(admission, admission.admittedAt))))
    expect(slow.rosters().length).toBeGreaterThan(0)
    expect(ends.sent.length).toBe(heard)
  })

  test("a member from before leases is closed 1012 when the room wakes, and the room arms its alarm", async () => {
    const owner = await signIn("member")
    const branch = await tracked(runtime, BRANCH_REPO, "feature/legacy", "open", owner.subject.id)
    const sockets: Array<Socket> = []
    const { rooms, alarm } = await roomOver(sockets)
    await join(rooms, sockets, owner, branch.branchId)
    // The code before leases joined this one: its data has no admission.
    const legacy = new Socket()
    sockets.push(legacy)
    await runtime.runPromise(PresenceRoom.join({ sockets: Effect.sync(() => sockets) }, legacy, {
      principal: "person-old",
      name: "old",
      access: "read",
      data: JSON.stringify({ role: "member", access: "view" }),
    }))
    await onTestClock(rooms.restore)
    expect(legacy.closed?.code).toBe(1012)
    expect(alarm()).not.toBeNull()
  })

  test("a renewal that fails outright ends the leases and still arms the next alarm", async () => {
    const owner = await signIn("member")
    const branch = await tracked(runtime, BRANCH_REPO, "feature/failing", "open", owner.subject.id)
    const sockets: Array<Socket> = []
    const { storage, fire, alarm } = memoryStorage()
    const rooms = BranchRooms.room({
      sockets: Effect.sync(() => sockets),
      storage,
      check: () => Effect.succeed("keep"),
      within: () => Effect.die(new Error("no database")),
    })
    const stays = await join(rooms, sockets, owner, branch.branchId)
    const other = await signIn("member")
    await shared(runtime, branch.branchId, other.subject.id, "view")
    await join(rooms, sockets, other, branch.branchId)
    await onTestClock(Effect.andThen(rooms.arm, fire(rooms.alarm)))
    expect(stays.closed?.code).toBe(1012)
    expect(alarm()).toBeNull()
  })
})

describe("the terminal's gate", () => {
  test("drops every frame, out and in, once the lease lapses, and asks to renew it", () => {
    const sent: Array<unknown> = []
    const listeners: Array<(event: string) => void> = []
    const raw: SocketAccess.RawSocket<string> = {
      send: (message) => void sent.push(message),
      close: () => undefined,
      addEventListener: (_type, listener) => void listeners.push(listener),
      removeEventListener: () => undefined,
    }
    let live = true
    let lapsed = 0
    const gated = SocketAccess.gate(raw, () => live, () => void lapsed++)
    const received: Array<string> = []
    gated.addEventListener("message", (event) => void received.push(event))
    gated.send("out 1")
    listeners[0]!("in 1")
    live = false
    gated.send("out 2")
    listeners[0]!("in 2")
    expect(sent).toEqual(["out 1"])
    expect(received).toEqual(["in 1"])
    expect(lapsed).toBe(2)
  })
})

describe("a host that never hibernates", () => {
  const lease = (start: number, expiresIn: number | null, leaseFor: number) => ({
    admission: {
      session: null,
      alias: null,
      expiresAt: expiresIn === null ? null : start + expiresIn,
      admittedAt: start,
      principal: "person",
      role: "member" as const,
      basis: RUN,
      access: "member" as const,
    },
    leaseUntil: start + leaseFor,
  })

  test("10,000 frames on lapsed leases start one renewal, not one each", async () => {
    const release = Effect.runSync(Deferred.make<void>())
    let started = 0
    const fibers: Array<Fiber.Fiber<void>> = []
    const notify = SocketAccess.coalesced(
      Effect.suspend(() => (started++, Deferred.await(release))),
      (effect) => void fibers.push(Effect.runFork(effect)),
    )
    for (let frame = 0; frame < 10_000; frame++) notify()
    expect([started, fibers.length]).toEqual([1, 1])
    await Effect.runPromise(Effect.andThen(Deferred.succeed(release, undefined), Fiber.join(fibers[0]!)))
    // Once it finished, the next lapse starts the next one.
    notify()
    expect(fibers.length).toBe(2)
  })

  /** Lets the loops' fibers run up to their next sleep. */
  const settle = Effect.gen(function* () {
    for (let i = 0; i < 20; i++) yield* Effect.yieldNow
  })

  /** A host's loops over `leases`, recording when each renewal and expiry ran, in a scope the test closes. */
  const loops = (
    leases: Array<ReturnType<typeof lease>>,
    start: number,
    renewDue: Effect.Effect<void> = Effect.void,
  ) => {
    const renewedAt: Array<number> = []
    const expiredAt: Array<number> = []
    const loop = SocketAccess.renewalLoop(
      () => leases,
      Effect.andThen(Effect.flatMap(now, (at) => Effect.sync(() => void renewedAt.push(at - start))), renewDue),
      Effect.flatMap(now, (at) => Effect.sync(() => {
        expiredAt.push(at - start)
        // The host closes every ended socket: it leaves the lease list.
        for (let i = leases.length - 1; i >= 0; i--) {
          const end = leases[i]!.admission.expiresAt
          if (end !== null && end <= at) leases.splice(i, 1)
        }
      })),
      "terminal",
    )
    return { loop, renewedAt, expiredAt }
  }

  test("a lease acted on before the loop's wake wakes it then; a later one doesn't move it", async () => {
    const { renewedAt } = await runtime.runPromise(Effect.scoped(Effect.gen(function* () {
      const scope = yield* Effect.scope
      const start = yield* now
      const leases = [lease(start, null, LEASE_MS)]
      const host = loops(leases, start)
      yield* host.loop.ensure(scope, leases[0]!)
      yield* settle
      // A viewer whose session ends at 5 s attaches while the loop sleeps until 50 s.
      const sooner = lease(start, 5_000, 5_000)
      leases.push(sooner)
      yield* host.loop.ensure(scope, sooner)
      yield* host.loop.ensure(scope, lease(start, null, 2 * LEASE_MS))
      yield* settle
      yield* TestClock.adjust(5_000)
      yield* settle
      return host
    })).pipe(Effect.provide(TestClock.layer())))
    expect(renewedAt).toContain(5_000)
    expect(renewedAt.every((at) => at <= 5_000)).toBe(true)
  })

  test("a session's end closes on time while a renewal is stalled, for a viewer who attached during it", async () => {
    let renewals = 0
    const { expiredAt } = await runtime.runPromise(Effect.scoped(Effect.gen(function* () {
      const scope = yield* Effect.scope
      const start = yield* now
      const leases = [lease(start, null, 15_000)]
      // Postgres hangs: the renewal the loop starts at 5 s never finishes.
      const host = loops(leases, start, Effect.suspend(() => (renewals++, Effect.never)))
      yield* host.loop.ensure(scope, leases[0]!)
      yield* settle
      yield* TestClock.adjust(6_000)
      yield* settle
      expect(renewals).toBe(1)
      // A viewer whose session ends at 8 s attaches while that renewal hangs.
      const ending = lease(start, 8_000, 8_000)
      leases.push(ending)
      yield* host.loop.ensure(scope, ending)
      yield* TestClock.adjust(2_000)
      yield* settle
      return host
    })).pipe(Effect.provide(TestClock.layer())))
    expect(expiredAt).toContain(8_000)
  })

  test("the renewal loop retired on an empty host restarts for a viewer who reconnects", async () => {
    const { renewedAt } = await runtime.runPromise(Effect.scoped(Effect.gen(function* () {
      const scope = yield* Effect.scope
      const start = yield* now
      const leases = [lease(start, null, LEASE_MS)]
      const host = loops(leases, start)
      yield* host.loop.ensure(scope, leases[0]!)
      yield* settle
      // The only viewer leaves at 45 s; the renewal loop wakes at 50 s to an empty host and retires.
      yield* TestClock.adjust(45_000)
      leases.splice(0)
      yield* TestClock.adjust(5_000)
      yield* settle
      expect(host.renewedAt).toEqual([50_000])
      // A viewer reconnects at 51 s, leased to 111 s: its renewal is due at 101 s, before its lease lapses.
      yield* TestClock.adjust(1_000)
      const back = lease(start + 51_000, null, LEASE_MS)
      leases.push(back)
      yield* host.loop.ensure(scope, back)
      yield* settle
      yield* TestClock.adjust(50_000)
      yield* settle
      return host
    })).pipe(Effect.provide(TestClock.layer())))
    expect(renewedAt).toContain(101_000)
  })

  test("the expiry timer retired on an empty host while a renewal hung restarts for a viewer who attaches", async () => {
    const { expiredAt } = await runtime.runPromise(Effect.scoped(Effect.gen(function* () {
      const scope = yield* Effect.scope
      const start = yield* now
      // A viewer leased to 10 s whose session ends at 30 s: its renewal at 0 s hangs.
      const leases = [lease(start, 30_000, 10_000)]
      const host = loops(leases, start, Effect.never)
      yield* host.loop.ensure(scope, leases[0]!)
      yield* settle
      // At 30 s expiry closes it and, finding the host empty, retires; the renewal still hangs.
      yield* TestClock.adjust(30_000)
      yield* settle
      expect(leases).toEqual([])
      // A viewer whose session ends at 40 s attaches: expiry must run again then.
      const next = lease(start, 40_000, 40_000)
      leases.push(next)
      yield* host.loop.ensure(scope, next)
      yield* settle
      yield* TestClock.adjust(10_000)
      yield* settle
      return host
    })).pipe(Effect.provide(TestClock.layer())))
    expect(expiredAt).toContain(40_000)
  })

  test("a viewer who attaches while the loop is on its way out keeps it, and one loop runs", async () => {
    const release = Effect.runSync(Deferred.make<void>())
    const { renewedAt } = await runtime.runPromise(Effect.scoped(Effect.gen(function* () {
      const scope = yield* Effect.scope
      const start = yield* now
      const leases = [lease(start, null, LEASE_MS)]
      const host = loops(leases, start, Deferred.await(release))
      yield* host.loop.ensure(scope, leases[0]!)
      yield* settle
      // The last viewer leaves; the loop wakes at 50 s and holds in a renewal, about to find the host empty.
      leases.splice(0)
      yield* TestClock.adjust(50_000)
      yield* settle
      const back = lease(start + 50_000, null, LEASE_MS)
      leases.push(back)
      yield* host.loop.ensure(scope, back)
      yield* Deferred.succeed(release, undefined)
      yield* settle
      // It goes on to the new lease's renewal, once.
      yield* TestClock.adjust(50_000)
      yield* settle
      return host
    })).pipe(Effect.provide(TestClock.layer())))
    expect(renewedAt).toEqual([50_000, 100_000])
  })

  test("concurrent attaches start one loop of each kind, also after both retired", async () => {
    const { renewedAt, expiredAt } = await runtime.runPromise(Effect.scoped(Effect.gen(function* () {
      const scope = yield* Effect.scope
      const start = yield* now
      const first = lease(start, 30_000, 30_000)
      const leases = [first]
      const host = loops(leases, start)
      const attachAll = (added: ReturnType<typeof lease>) =>
        Effect.all(Array.from({ length: 10 }, () => host.loop.ensure(scope, added)), { concurrency: "unbounded", discard: true })
      yield* attachAll(first)
      yield* settle
      // Its session ends at 30 s: each loop acts once, and each retires on the empty host.
      yield* TestClock.adjust(30_000)
      yield* settle
      expect(leases).toEqual([])
      const second = lease(start + 30_000, 30_000, 30_000)
      leases.push(second)
      yield* attachAll(second)
      yield* settle
      yield* TestClock.adjust(30_000)
      yield* settle
      return host
    })).pipe(Effect.provide(TestClock.layer())))
    // One loop of each kind acts at most once at any time; a duplicate would repeat a time.
    expect(new Set(renewedAt).size).toBe(renewedAt.length)
    expect(renewedAt).toContain(60_000)
    expect(expiredAt).toEqual([30_000, 60_000])
  })

  test("a dying loop logs which one, with a code and never the failure's text", async () => {
    const lines: Array<{ readonly message: unknown; readonly annotations: unknown; readonly level: unknown }> = []
    const logger = Logger.make((options) => {
      const line = StructuredLogger.formatStructured.log(options)
      lines.push({ message: line.message, annotations: line.annotations, level: line.level })
    })
    const secret = "postgres://someone:hunter2@db"
    await runtime.runPromise(Effect.scoped(Effect.gen(function* () {
      const scope = yield* Effect.scope
      const start = yield* now
      const leases = [lease(start, null, LEASE_MS)]
      const host = loops(leases, start, Effect.die(new Error(secret)))
      yield* host.loop.ensure(scope, leases[0]!)
      yield* settle
      yield* TestClock.adjust(50_000)
      yield* settle
    })).pipe(Effect.provide(TestClock.layer()), Effect.provideService(Logger.CurrentLoggers, new Set([logger]))))
    const died = lines.filter((line) => line.message === "socket.loop")
    expect(died).toEqual([{
      message: "socket.loop",
      level: "ERROR",
      annotations: expect.objectContaining({ host: "terminal", loop: "renewal", outcome: "died", errorCode: "unknown" }),
    }])
    expect(JSON.stringify(lines)).not.toContain("hunter2")
  })

  test("a loop that died on a defect whose tag throws still frees its slot and logs unknown", async () => {
    const lines: Array<unknown> = []
    const logger = Logger.make((options) => {
      const line = StructuredLogger.formatStructured.log(options)
      if (line.message === "socket.loop") lines.push(line.annotations)
    })
    let renewals = 0
    const { renewedAt } = await runtime.runPromise(Effect.scoped(Effect.gen(function* () {
      const scope = yield* Effect.scope
      const start = yield* now
      const leases = [lease(start, null, LEASE_MS)]
      const hostile = Object.defineProperty(new Error("x"), "_tag", { get: () => { throw new Error("boom") } })
      const host = loops(leases, start, Effect.suspend(() => (renewals++ === 0 ? Effect.die(hostile) : Effect.void)))
      yield* host.loop.ensure(scope, leases[0]!)
      yield* settle
      yield* TestClock.adjust(50_000)
      yield* settle
      yield* host.loop.ensure(scope, leases[0]!)
      yield* settle
      yield* TestClock.adjust(1)
      yield* settle
      return host
    })).pipe(Effect.provide(TestClock.layer()), Effect.provideService(Logger.CurrentLoggers, new Set([logger]))))
    expect(renewedAt).toEqual([50_000, 50_001])
    expect(lines).toEqual([expect.objectContaining({ loop: "renewal", outcome: "died", errorCode: "unknown" })])
  })

  test("a loop that died restarts for the next viewer who attaches", async () => {
    let renewals = 0
    const { renewedAt } = await runtime.runPromise(Effect.scoped(Effect.gen(function* () {
      const scope = yield* Effect.scope
      const start = yield* now
      const leases = [lease(start, null, LEASE_MS)]
      // The first renewal dies at 50 s; a later one succeeds.
      const host = loops(leases, start, Effect.suspend(() => (renewals++ === 0 ? Effect.die("renewal died") : Effect.void)))
      yield* host.loop.ensure(scope, leases[0]!)
      yield* settle
      yield* TestClock.adjust(50_000)
      yield* settle
      const back = lease(start + 50_000, null, LEASE_MS)
      leases.push(back)
      yield* host.loop.ensure(scope, back)
      yield* settle
      // The first lease is past its renewal time, so the restarted loop acts a millisecond on.
      yield* TestClock.adjust(1)
      yield* settle
      return host
    })).pipe(Effect.provide(TestClock.layer())))
    expect(renewedAt).toEqual([50_000, 50_001])
    expect(renewals).toBe(2)
  })

  test("an expiry counts a session close once, leaving one a running renewal holds to that renewal", async () => {
    const before = count("terminal", "session")
    const ended = await runtime.runPromise(Effect.gen(function* () {
      const start = yield* now
      const open = [
        { socket: "a", ...lease(start - 20_000, 10_000, 10_000) },
        { socket: "b", ...lease(start - 20_000, 10_000, 10_000) },
        { socket: "c", ...lease(start, null, LEASE_MS) },
      ]
      return yield* SocketAccess.expireEnded("terminal", open, new Set(["b"]))
    }))
    expect(ended.map((each) => each.socket)).toEqual(["a", "b"])
    expect(count("terminal", "session") - before).toBe(1)
  })
})

describe("admission", () => {
  test("a session that ended before the socket was handed over admits nothing", async () => {
    const actor = await signIn("member")
    await runtime.runPromise(SessionStore.revoke({ id: actor.session! }, "sign_out"))
    expect((await runtime.runPromise(SocketAccess.admit(actor, RUN, "member")))._tag).toBe("ended")
  })

  test("a page that names someone else's person is not theirs; one that names none is", () => {
    const actor: Actor = { subject: { kind: "person", id: "p1" }, role: "member" }
    expect(SocketAccess.personMatches(actor, undefined)).toBe(true)
    expect(SocketAccess.personMatches(actor, "p1")).toBe(true)
    expect(SocketAccess.personMatches(actor, "p2")).toBe(false)
  })
})

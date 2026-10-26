import { createServer, type IncomingHttpHeaders } from "node:http"
import type { AddressInfo } from "node:net"
import { DatabaseSync, type SQLInputValue } from "node:sqlite"
import { Cause, Deferred, Effect, Exit, Fiber, Logger, Metric } from "effect"
import { afterEach, describe, expect, test, vi } from "vitest"
import { FetchHttpClient } from "effect/http"
import { TestClock } from "effect/testing"
import { AuthUnreachable, getSession } from "../features/auth/api"
import { NO_DEVICE_DATA, type SessionState } from "../features/auth/contract"
import { deviceFrom, type Fixture } from "../test/deviceFixture"
import deployed from "./fixtures/7b96f878.json" with { type: "json" }
import production from "./fixtures/c6940ac53e5a.json" with { type: "json" }
import {
  activationGate,
  type Adoption,
  answer,
  authorizeDevice,
  boundFetch,
  checks,
  DeviceIdentityRefused,
  IDENTITY_MESSAGE,
  type Outcome,
  readReceipt,
  readSession,
  sessionNow,
  stale,
  VISITOR,
} from "./identity"

// The device's owner check (src/device/identity.ts) on real SQLite: the deployed builds' device stores (7b96f878, and
// c6940ac53e5a, which production runs), built by TanStack DB's own persistence from their fixtures, and empty stores. Sessions are ChatApi's answers as values; a
// broken store is an injected database.

const fixture = deployed as Fixture
/** The login the deployed build confirmed on the fixture's device. */
const LOGIN = "codeplanesmithers"

const opened: Array<DatabaseSync> = []
afterEach(() => {
  for (const sqlite of opened.splice(0)) sqlite.close()
})

/** A device store as the engine worker's `SharedSqlite` service, over a SQLite file or memory. */
const store = (path = ":memory:") => {
  const sqlite = new DatabaseSync(path)
  opened.push(sqlite)
  const database = {
    execute: (sql: string, params: ReadonlyArray<unknown> = []) =>
      Effect.sync(() => {
        const statement = sqlite.prepare(sql)
        if (statement.columns().length > 0) return statement.all(...(params as Array<SQLInputValue>)) as ReadonlyArray<unknown>
        statement.run(...(params as Array<SQLInputValue>))
        return []
      }),
  }
  return { sqlite, database }
}
type Store = ReturnType<typeof store>

/** A deployed build's device store; without its confirmed login when `confirmed` is false. */
const deployedStore = async (confirmed = true, build: Fixture = fixture) => {
  const { path } = await deviceFrom(build)
  const device = store(path)
  if (!confirmed) {
    const [{ table }] = device.sqlite
      .prepare("SELECT table_name AS 'table' FROM collection_registry WHERE collection_id = 'auth-confirmed'")
      .all() as Array<{ table: string }>
    device.sqlite.exec(`DELETE FROM "${table}"`)
  }
  return device
}

const signedIn = (personId: string, login: string): Effect.Effect<SessionState> =>
  Effect.succeed({ signedIn: true, personId, login, role: "member" })
const signedOut: Effect.Effect<SessionState> = Effect.succeed({ signedIn: false, available: true })
const offline: Effect.Effect<SessionState, AuthUnreachable> = Effect.fail(new AuthUnreachable({}))

/** One activation: its exit and what it reported; `continuity` hears whether the owner held the data before it. */
const activate = async (device: Store, session: Effect.Effect<SessionState, unknown>, continuity: Array<boolean> = []) => {
  const reports: Array<{ owner: string | undefined; outcome: Outcome }> = []
  const exit = await Effect.runPromise(
    Effect.exit(
      authorizeDevice({
        database: device.database,
        session,
        report: (owner, outcome, continuous) => {
          reports.push({ owner, outcome })
          continuity.push(continuous)
        },
      }),
    ),
  )
  expect(reports.length).toBeLessThanOrEqual(1)
  return { exit, ...reports[0] }
}

const recorded = (device: Store) =>
  (device.sqlite.prepare("SELECT person_id FROM smithers_device_identity").get() as { person_id: string } | undefined)?.person_id

/** Every row of every table but the owner record, so a test can say nothing was deleted or changed. */
const contents = (device: Store) => {
  const tables = device.sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name != 'smithers_device_identity' ORDER BY name")
    .all() as Array<{ name: string }>
  return Object.fromEntries(tables.map(({ name }) => [name, device.sqlite.prepare(`SELECT * FROM "${name}"`).all()]))
}

const refused = (reason: string) => Exit.fail(new DeviceIdentityRefused({ reason }))

describe("a device from the deployed build 7b96f878", () => {
  test.each([fixture, production as Fixture])("regression: build $build's own person opens it as theirs, every row and queued write kept", async (build) => {
    const device = await deployedStore(true, build)
    const before = contents(device)
    expect(Object.keys(before).length).toBeGreaterThan(10)
    // Before the fix, this activation was `changed`, the device was wiped, and its queued writes were lost.
    expect(await activate(device, signedIn("person-1", LOGIN))).toEqual({ exit: Exit.void, owner: "person-1", outcome: "verified" })
    expect(recorded(device)).toBe("person-1")
    expect(contents(device)).toEqual(before)
    // From now on the stable owner decides, and the login no longer matters.
    expect(await activate(device, signedIn("person-1", "renamed"))).toMatchObject({ owner: "person-1", outcome: "verified" })
  })

  test("logins match without regard to case, as GitHub's do", async () => {
    const device = await deployedStore()
    expect(await activate(device, signedIn("person-1", "CodePlaneSmithers"))).toMatchObject({ outcome: "verified" })
  })

  test("a confirmed session that kept a stable id is matched by that id, not the login", async () => {
    const withId = async () => {
      const device = await deployedStore()
      const [{ table }] = device.sqlite
        .prepare("SELECT table_name AS 'table' FROM collection_registry WHERE collection_id = 'auth-confirmed'")
        .all() as Array<{ table: string }>
      const stored = device.sqlite.prepare(`SELECT value FROM "${table}"`).get() as { value: string }
      device.sqlite.prepare(`UPDATE "${table}" SET value = ?`).run(JSON.stringify({ ...JSON.parse(stored.value), personId: "person-1" }))
      return device
    }
    expect(await activate(await withId(), signedIn("person-2", LOGIN))).toMatchObject({ outcome: "changed" })
    expect(await activate(await withId(), signedIn("person-1", "renamed"))).toMatchObject({ outcome: "verified", owner: "person-1" })
  })

  test("another login is refused: the data stays sealed and whole, and its own person can still open it", async () => {
    const device = await deployedStore()
    const before = contents(device)
    expect(await activate(device, signedIn("person-2", "someone-else"))).toEqual({
      exit: refused("changed"),
      owner: undefined,
      outcome: "changed",
    })
    expect(recorded(device)).toBeUndefined()
    expect(contents(device)).toEqual(before)
    expect(await activate(device, signedIn("person-1", LOGIN))).toMatchObject({ exit: Exit.void, outcome: "verified" })
    expect(contents(device)).toEqual(before)
  })

  test("offline or signed out it waits, sealed, for an online sign-in", async () => {
    const device = await deployedStore()
    const before = contents(device)
    expect(await activate(device, offline)).toEqual({ exit: refused("unverified"), owner: undefined, outcome: "unverified" })
    expect(await activate(device, signedOut)).toEqual({ exit: refused("signed_out"), owner: undefined, outcome: "signed_out" })
    expect(recorded(device)).toBeUndefined()
    expect(contents(device)).toEqual(before)
    expect(await activate(device, signedIn("person-1", LOGIN))).toMatchObject({ outcome: "verified" })
  })

  test("without a confirmed login nobody can be told it is theirs: it stays sealed for everyone", async () => {
    const device = await deployedStore(false)
    const before = contents(device)
    for (const [session, outcome] of [
      [signedIn("person-1", LOGIN), "changed"],
      [signedOut, "signed_out"],
      [offline, "unverified"],
    ] as const) {
      expect(await activate(device, session)).toEqual({ exit: refused(outcome), owner: undefined, outcome })
    }
    expect(recorded(device)).toBeUndefined()
    expect(contents(device)).toEqual(before)
  })
})

describe("whether the owner held the data before this activation", () => {
  // Only then are the outbox's writes stored before writes were stamped theirs (Receipt.continuous, Outbox.Principal).
  test("an earlier build's own person, and the recorded owner, online or offline, held it; a new owner did not", async () => {
    const continuity: Array<boolean> = []
    const deployed = await deployedStore()
    await activate(deployed, signedIn("person-1", LOGIN), continuity)
    await activate(deployed, signedIn("person-1", LOGIN), continuity)
    const device = store()
    await activate(device, signedIn("alice", "alice"), continuity)
    await activate(device, offline, continuity)
    await activate(device, signedOut, continuity)
    // legacy match, recorded owner, a new device's first person, the owner offline, sealed for a signed-out browser.
    expect(continuity).toEqual([true, true, false, false, false])
  })

  test("an existing owner record keeps its unstamped authority when the eligibility column is added", async () => {
    const device = store()
    device.sqlite.exec("CREATE TABLE smithers_device_identity (singleton INTEGER PRIMARY KEY, v INTEGER, person_id TEXT, login TEXT)")
    device.sqlite.prepare("INSERT INTO smithers_device_identity VALUES (1, 1, ?, ?)").run("alice", "alice")
    const continuity: Array<boolean> = []
    await activate(device, signedIn("alice", "alice"), continuity)
    await activate(device, offline, continuity)
    expect(continuity).toEqual([true, true])
    expect(device.sqlite.prepare("SELECT owns_unstamped FROM smithers_device_identity").get()).toEqual({ owns_unstamped: 1 })
  })

  test("a new or adopted device never gains authority over unstamped writes on reload", async () => {
    const continuity: Array<boolean> = []
    const device = store()
    await activate(device, signedOut, continuity)
    await activate(device, offline, continuity)
    await activate(device, signedIn("alice", "alice"), continuity)
    await activate(device, signedIn("alice", "alice"), continuity)
    await activate(device, signedIn("bob", "bob"), continuity)
    expect(continuity).toEqual([false, false, false, false, false])
  })
})

describe("a device this build owns", () => {
  test("a new device belongs to the first person to sign in", async () => {
    const device = store()
    expect(await activate(device, signedIn("alice", "alice"))).toEqual({ exit: Exit.void, owner: "alice", outcome: "verified" })
    expect(recorded(device)).toBe("alice")
  })

  test("the owner's data opens offline as theirs; signed out or another person keeps it sealed until they sign in again", async () => {
    const device = store()
    await activate(device, signedIn("alice", "alice"))
    device.sqlite.exec("CREATE TABLE drafts (text TEXT); INSERT INTO drafts VALUES ('private')")
    expect(await activate(device, offline)).toEqual({ exit: Exit.void, owner: "alice", outcome: "offline" })
    expect(await activate(device, signedOut)).toEqual({ exit: refused("signed_out"), owner: undefined, outcome: "signed_out" })
    expect(await activate(device, signedIn("bob", "bob"))).toEqual({ exit: refused("changed"), owner: undefined, outcome: "changed" })
    // Bob's login matching an earlier one changes nothing: the stable owner decides.
    expect(await activate(device, signedIn("bob", "alice"))).toMatchObject({ outcome: "changed" })
    expect(recorded(device)).toBe("alice")
    expect(device.sqlite.prepare("SELECT text FROM drafts").all()).toEqual([{ text: "private" }])
    expect(await activate(device, signedIn("alice", "alice-renamed"))).toEqual({ exit: Exit.void, owner: "alice", outcome: "verified" })
  })

  test("a visitor's device, signed out or offline, is adopted by the next person to sign in, and then is theirs", async () => {
    for (const visiting of [signedOut, offline]) {
      const device = store()
      expect(await activate(device, visiting)).toEqual({ exit: Exit.void, owner: VISITOR, outcome: "visitor" })
      expect(await activate(device, signedOut)).toEqual({ exit: Exit.void, owner: VISITOR, outcome: "visitor" })
      expect(recorded(device)).toBe(VISITOR)
      expect(await activate(device, signedIn("alice", "alice"))).toMatchObject({ owner: "alice", outcome: "verified" })
      expect(await activate(device, signedIn("bob", "bob"))).toMatchObject({ outcome: "changed" })
    }
  })

  test("after sign-out's wipe the device store is new, owner record included, and the next person to sign in owns it", async () => {
    // The owner record lives in the device store itself, which sign-out's wipe deletes with the engine's directory
    // (src/wipe.ts); nothing of it survives elsewhere.
    const before = store()
    await activate(before, signedIn("alice", "alice"))
    expect(recorded(before)).toBe("alice")
    const wiped = store()
    expect(await activate(wiped, signedIn("bob", "bob"))).toEqual({ exit: Exit.void, owner: "bob", outcome: "verified" })
  })

  test("a confirmed session TanStack DB registered but never created reads as none", async () => {
    const empty = store()
    empty.sqlite.exec(
      "CREATE TABLE collection_registry (collection_id TEXT, table_name TEXT); INSERT INTO collection_registry VALUES ('auth-confirmed', 'not_created'), ('preferences', 'prefs')",
    )
    expect(await activate(empty, signedIn("alice", "alice"))).toMatchObject({ outcome: "verified" })
    const used = store()
    used.sqlite.exec(
      "CREATE TABLE collection_registry (collection_id TEXT, table_name TEXT); INSERT INTO collection_registry VALUES ('auth-confirmed', 'not_created'), ('chat-drafts', 'drafts')",
    )
    expect(await activate(used, signedIn("alice", "alice"))).toMatchObject({ outcome: "changed" })
  })
})

describe("observability", () => {
  const observe = async <A, E>(program: Effect.Effect<A, E>, registry: Metric.MetricRegistry, logs: Array<unknown>) =>
    Effect.runPromise(
      Effect.exit(program).pipe(
        Effect.provideService(Metric.MetricRegistry, registry),
        Effect.provideService(Logger.CurrentLoggers, new Set([Logger.make((entry) => void logs.push(Logger.formatStructured.log(entry)))])),
      ),
    )
  const count = (registry: Metric.MetricRegistry, attributes: Record<string, string>) =>
    Effect.runPromise(Metric.value(Metric.withAttributes(checks, attributes)).pipe(Effect.provideService(Metric.MetricRegistry, registry))).then(
      (state) => state.count,
    )

  test("every outcome is counted and logged, by how it verified, never with a login or a person", async () => {
    const registry: Metric.MetricRegistry = new Map()
    const logs: Array<unknown> = []
    const legacy = await deployedStore()
    const fresh = store()
    const run = (device: Store, session: Effect.Effect<SessionState, unknown>) =>
      observe(authorizeDevice({ database: device.database, session, report: () => {} }), registry, logs)
    await run(legacy, signedIn("person-secret-id", LOGIN))
    await run(legacy, signedIn("person-secret-id", LOGIN))
    await run(legacy, offline)
    await run(legacy, signedOut)
    await run(legacy, signedIn("intruder-secret-id", "intruder-login"))
    await run(fresh, signedOut)
    await run(fresh, signedIn("fresh-secret-id", "fresh-login"))
    expect(await count(registry, { outcome: "verified", via: "legacy" })).toBe(1)
    expect(await count(registry, { outcome: "verified", via: "owner" })).toBe(1)
    expect(await count(registry, { outcome: "verified", via: "visitor" })).toBe(1)
    expect(await count(registry, { outcome: "offline" })).toBe(1)
    expect(await count(registry, { outcome: "signed_out" })).toBe(1)
    expect(await count(registry, { outcome: "changed" })).toBe(1)
    expect(await count(registry, { outcome: "visitor" })).toBe(1)
    const lines = logs as Array<{ message: unknown; annotations: Record<string, unknown> }>
    expect(lines.map((line) => line.annotations)).toContainEqual({ outcome: "verified", via: "legacy" })
    const text = JSON.stringify(logs)
    for (const secret of [LOGIN, "person-secret-id", "intruder", "fresh-"]) expect(text).not.toContain(secret)
  })

  test("a session read that failed is named by its code: a 5xx is a failure with its status, no answer is offline", async () => {
    const registry: Metric.MetricRegistry = new Map()
    const logs: Array<unknown> = []
    const device = store()
    await activate(device, signedIn("alice", "alice"))
    const run = (session: Effect.Effect<SessionState, unknown>) =>
      observe(authorizeDevice({ database: device.database, session, report: () => {} }), registry, logs)
    await run(Effect.fail(new AuthUnreachable({ status: 503, code: "status" })))
    await run(Effect.fail(new AuthUnreachable({ code: "unreachable" })))
    // Both open the owner's data offline, counted by outcome alone.
    expect(await count(registry, { outcome: "offline" })).toBe(2)
    expect((logs as Array<{ message: unknown; level: string; annotations: Record<string, unknown> }>)
      .filter((line) => line.message === "auth.device_identity")
      .map(({ level, annotations }) => ({ level, annotations }))).toEqual([
      { level: "WARN", annotations: { outcome: "offline", errorCode: "status", status: 503 } },
      { level: "INFO", annotations: { outcome: "offline", errorCode: "unreachable" } },
    ])
  })

  test("a session without a stable person, an unreadable owner record or a broken store refuses, counted by stage, never with content", async () => {
    const registry: Metric.MetricRegistry = new Map()
    const logs: Array<unknown> = []
    const sentinel = "a row's private text"
    const missing = Effect.succeed({ signedIn: true, login: "alice", role: "member" } as SessionState)
    const unknownVersion = store()
    unknownVersion.sqlite.exec(
      "CREATE TABLE smithers_device_identity (singleton INTEGER PRIMARY KEY, v INTEGER NOT NULL, person_id TEXT NOT NULL, login TEXT NOT NULL); INSERT INTO smithers_device_identity VALUES (1, 2, 'alice', 'alice')",
    )
    const broken = { execute: () => Effect.die(new Error(sentinel)) }
    const exits = [
      await observe(authorizeDevice({ database: store().database, session: missing, report: () => {} }), registry, logs),
      await observe(authorizeDevice({ database: unknownVersion.database, session: signedIn("alice", "alice"), report: () => {} }), registry, logs),
      await observe(authorizeDevice({ database: broken, session: signedIn("alice", "alice"), report: () => {} }), registry, logs),
    ]
    expect(exits[0]).toEqual(refused("missing_person"))
    expect(exits.every(Exit.isFailure)).toBe(true)
    expect(await count(registry, { outcome: "unavailable" })).toBe(3)
    const annotations = (logs as Array<{ annotations: Record<string, unknown> }>).map((line) => line.annotations)
    expect(annotations).toEqual([
      { outcome: "unavailable", stage: "session", reason: "missing_person" },
      { outcome: "unavailable", stage: "owner", reason: "storage" },
      { outcome: "unavailable", stage: "owner", reason: "storage" },
    ])
    expect(JSON.stringify(logs)).not.toContain(sentinel)
  })

  test("a store that fails while claiming the owner is counted at that stage", async () => {
    const registry: Metric.MetricRegistry = new Map()
    const logs: Array<unknown> = []
    const device = store()
    const claimFails = {
      execute: (sql: string, params?: ReadonlyArray<unknown>) =>
        sql.startsWith("INSERT") ? Effect.die(new Error("disk full")) : device.database.execute(sql, params),
    }
    const exit = await observe(authorizeDevice({ database: claimFails, session: signedIn("alice", "alice"), report: () => {} }), registry, logs)
    expect(Exit.isFailure(exit)).toBe(true)
    expect((logs as Array<{ annotations: Record<string, unknown> }>).map((line) => line.annotations)).toEqual([
      { outcome: "unavailable", stage: "claim", reason: "storage" },
    ])
  })
})

describe("a tab about to follow a leader", () => {
  const receipt = (owner: string | undefined, outcome: Outcome = "verified") => ({ _tag: IDENTITY_MESSAGE, owner, outcome }) as const
  const sealedFor = (outcome: Outcome) => ({ _tag: IDENTITY_MESSAGE, owner: undefined, outcome }) as const
  const alice: SessionState = { signedIn: true, personId: "alice", login: "alice", role: "member" }
  const bob: SessionState = { signedIn: true, personId: "bob", login: "bob", role: "member" }
  const out: SessionState = { signedIn: false, available: true }

  test("gets the leader's receipt only while the browser's session now agrees; another person reopens every tab", () => {
    expect(answer(receipt("alice"), alice)).toEqual(receipt("alice"))
    expect(answer(receipt("alice", "offline"), "unreachable")).toEqual(receipt("alice", "offline"))
    expect(answer(receipt(VISITOR, "visitor"), out)).toEqual(receipt(VISITOR, "visitor"))
    expect(answer(receipt("alice"), bob)).toEqual({ ...sealedFor("verified"), reopen: true })
    expect(answer(receipt(VISITOR, "visitor"), alice)).toEqual({ ...sealedFor("visitor"), reopen: true })
    expect(answer(receipt("alice"), out)).toEqual(sealedFor("verified"))
    expect(answer(receipt("alice"), "malformed")).toEqual(sealedFor("verified"))
    expect(answer(sealedFor("changed"), alice)).toEqual(sealedFor("changed"))
    // Whether the owner held the data travels with the receipt a follower gets.
    expect(answer({ ...receipt("alice"), continuous: true }, alice)).toEqual({ ...receipt("alice"), continuous: true })
  })

  test("reads only well-formed receipts, and sessions that name a stable person", async () => {
    expect(readReceipt(receipt("alice"))).toEqual(receipt("alice"))
    expect(readReceipt({ ...sealedFor("verified"), reopen: true })).toEqual({ ...sealedFor("verified"), reopen: true })
    expect(readReceipt({ ...sealedFor("changed"), reopen: "yes" })).toEqual(sealedFor("changed"))
    expect(readReceipt({ ...receipt("alice"), continuous: true })).toEqual({ ...receipt("alice"), continuous: true })
    expect(readReceipt({ ...receipt("alice"), continuous: "yes" })).toEqual(receipt("alice"))
    for (const bad of [undefined, null, { request: true }, { _tag: IDENTITY_MESSAGE }, { _tag: IDENTITY_MESSAGE, outcome: "verified", owner: 1 }]) {
      expect(readReceipt(bad)).toBeUndefined()
    }
    expect(readSession(alice)).toEqual(alice)
    expect(readSession(out)).toEqual(out)
    expect(readSession({ signedIn: true, login: "alice", role: "member" })).toBeUndefined()
    expect(readSession({ signedIn: "yes" })).toBeUndefined()
    const json = (body: string, status = 200) => new Response(body, { status })
    expect(await sessionNow(json(JSON.stringify(alice)))).toEqual(alice)
    expect(await sessionNow(json(JSON.stringify({ signedIn: true, login: "alice", role: "member" })))).toBe("malformed")
    expect(await sessionNow(json("not json"))).toBe("malformed")
    expect(await sessionNow(json("", 503))).toBe("unreachable")
  })
})

describe("requests", () => {
  const serve = async (answer: () => unknown) => {
    const seen: Array<{ url: string; headers: IncomingHttpHeaders }> = []
    const server = createServer((request, response) => {
      seen.push({ url: request.url!, headers: request.headers })
      const body = answer()
      response.writeHead(200, { "content-type": "application/json" })
      response.end(typeof body === "string" ? body : JSON.stringify(body))
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    return {
      origin,
      seen,
      person: () => seen.map(({ headers }) => headers["x-smithers-device-person"]),
      close: async () => {
        server.closeAllConnections()
        await new Promise<void>((resolve) => server.close(() => resolve()))
      },
    }
  }

  test("wait for the activation, then carry the owner to this origin's API only; a page with no data open says so", async () => {
    const api = await serve(() => ({}))
    let release!: () => void
    const ready = new Promise<void>((resolve) => (release = resolve))
    let owner = "alice"
    const sent: Array<string> = []
    const next: typeof fetch = (input, init) => {
      sent.push(new Request(input, init).url)
      return fetch(input, init)
    }
    const bound = boundFetch(next, { origin: api.origin, principal: () => owner, ready })
    try {
      const sending = bound(`${api.origin}/api/questions`, { headers: { "x-smithers-device-person": "forged" } })
      // Nothing leaves while the activation is pending, however many turns pass.
      for (let turn = 0; turn < 10; turn++) await Promise.resolve()
      expect(sent).toEqual([])
      release()
      await sending
      await bound(`${api.origin}/assets/app.js`, { headers: { "x-smithers-device-person": "kept" } })
      await boundFetch(fetch, { origin: "http://elsewhere.test", principal: () => "alice" })(`${api.origin}/api/questions`)
      owner = NO_DEVICE_DATA
      await bound(`${api.origin}/api/questions`, { headers: { "x-smithers-device-person": "forged" } })
      expect(api.person()).toEqual(["alice", "kept", undefined, NO_DEVICE_DATA])
    } finally {
      await api.close()
    }
  })

  test("a session answer naming someone else reauthorizes once, and every request after it fails until the page loads again", async () => {
    let session: unknown = { signedIn: true, personId: "alice", login: "alice", role: "member" }
    const api = await serve(() => session)
    let reauthorized = 0
    const bound = boundFetch(fetch, { origin: api.origin, principal: () => "alice", reauthorize: async () => void reauthorized++ })
    try {
      expect((await bound(`${api.origin}/api/auth/session`)).ok).toBe(true)
      session = { signedIn: false, available: true }
      expect((await bound(`${api.origin}/api/auth/session`)).ok).toBe(true)
      session = { signedIn: true, login: "bob", role: "member" }
      expect((await bound(`${api.origin}/api/auth/session`)).ok).toBe(true)
      session = "not json"
      expect(await (await bound(`${api.origin}/api/auth/session`)).text()).toBe("not json")
      expect(reauthorized).toBe(0)
      session = { signedIn: true, personId: "bob", login: "bob", role: "member" }
      const results = await Promise.allSettled([bound(`${api.origin}/api/auth/session`), bound(`${api.origin}/api/auth/session`)])
      expect(results.map((result) => result.status)).toEqual(["rejected", "rejected"])
      const sent = api.seen.length
      await expect(bound(`${api.origin}/api/questions`, { method: "POST", body: "{}" })).rejects.toEqual(
        new DeviceIdentityRefused({ reason: "reauthorizing" }),
      )
      expect(api.seen).toHaveLength(sent)
      expect(reauthorized).toBe(1)
    } finally {
      await api.close()
    }
  })

  test("a refusal under another person's session reauthorizes, so the write stays queued; any other refusal stands", async () => {
    let session: { status: number; body: unknown } = { status: 200, body: { signedIn: true, personId: "alice", login: "alice", role: "member" } }
    const seen: Array<string> = []
    const server = createServer((request, response) => {
      seen.push(request.url!)
      const answer = request.url === "/api/auth/session" ? session : request.url === "/api/questions" ? { status: 401, body: {} } : { status: 200, body: {} }
      response.writeHead(answer.status, { "content-type": "application/json" })
      response.end(JSON.stringify(answer.body))
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    let reauthorized = 0
    const bound = boundFetch(fetch, { origin, principal: () => "alice", reauthorize: async () => void reauthorized++ })
    const ask = () => bound(`${origin}/api/questions`, { method: "POST", body: "{}" })
    try {
      // Taken: no session read.
      expect((await bound(`${origin}/api/views`, { method: "POST", body: "{}" })).status).toBe(200)
      expect(seen).toEqual(["/api/views"])
      // Refused while Alice herself is signed in, signed out, or ChatApi can't say: the refusal stands.
      expect((await ask()).status).toBe(401)
      session = { status: 200, body: { signedIn: false, available: true } }
      expect((await ask()).status).toBe(401)
      session = { status: 503, body: {} }
      expect((await ask()).status).toBe(401)
      expect(reauthorized).toBe(0)
      // Refused because Bob is signed in now: the page reopens, and the write fails as unsent, to be sent again.
      session = { status: 200, body: { signedIn: true, personId: "bob", login: "bob", role: "member" } }
      await expect(ask()).rejects.toEqual(new DeviceIdentityRefused({ reason: "reauthorizing" }))
      await expect(ask()).rejects.toEqual(new DeviceIdentityRefused({ reason: "reauthorizing" }))
      expect(reauthorized).toBe(1)
      expect(seen.filter((url) => url === "/api/questions")).toHaveLength(4)
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
    // ChatApi gone altogether: the refusal it can't explain stands.
    const unreachable = boundFetch(
      async (input, init) => new URL(new Request(input, init).url).pathname === "/api/questions" ? new Response("{}", { status: 401 }) : Promise.reject(new TypeError("offline")),
      { origin, principal: () => "alice", reauthorize: async () => void reauthorized++ },
    )
    expect((await unreachable(`${origin}/api/questions`, { method: "POST", body: "{}" })).status).toBe(401)
    expect(reauthorized).toBe(1)
  })

  test("a page with no data open reopens only when sealed until someone signs in; the worker never does", async () => {
    let session: unknown = { signedIn: false, available: true }
    const api = await serve(() => session)
    let reauthorized = 0
    const reauthorize = async () => void reauthorized++
    const read = (bound: typeof fetch) => bound(`${api.origin}/api/auth/session`)
    try {
      // Sealed for another person, or a visitor's tab on memory: a sign-in changes nothing here.
      session = { signedIn: true, personId: "bob", login: "bob", role: "member" }
      await read(boundFetch(fetch, { origin: api.origin, principal: () => NO_DEVICE_DATA, reauthorize }))
      await read(boundFetch(fetch, { origin: api.origin, principal: () => "alice" }))
      expect(reauthorized).toBe(0)
      // Sealed until someone signs in: still signed out, nothing; signed in, the activation is made again.
      let sealed = true
      const waiting = boundFetch(fetch, { origin: api.origin, principal: () => NO_DEVICE_DATA, reauthorize, reopensOnSignIn: () => sealed })
      session = { signedIn: false, available: true }
      expect((await read(waiting)).ok).toBe(true)
      expect(reauthorized).toBe(0)
      session = { signedIn: true, personId: "alice", login: "alice", role: "member" }
      await expect(read(waiting)).rejects.toEqual(new DeviceIdentityRefused({ reason: "reauthorizing" }))
      expect(reauthorized).toBe(1)
      sealed = false
    } finally {
      await api.close()
    }
  })

  test("a person's session on the visitor's data adopts it in place: not now fails as unsent, adopted goes on as theirs", async () => {
    const alice = { signedIn: true, personId: "alice", login: "alice", role: "member" }
    const api = await serve(() => alice)
    let owner = VISITOR
    let reauthorized = 0
    const asked: Array<SessionState> = []
    const outcomes: Array<Adoption> = ["unavailable", "adopted"]
    let release!: () => void
    const held = new Promise<void>((resolve) => (release = resolve))
    const adopt = async (session: SessionState) => {
      asked.push(session)
      const outcome = outcomes.shift()!
      if (outcome === "adopted") {
        await held
        owner = "alice"
      }
      return outcome
    }
    const bound = boundFetch(fetch, { origin: api.origin, principal: () => owner, reauthorize: async () => void reauthorized++, adopt })
    try {
      await expect(bound(`${api.origin}/api/auth/session`)).rejects.toMatchObject({ reason: "adopting" })
      const reading = bound(`${api.origin}/api/auth/session`)
      await vi.waitFor(() => expect(asked).toHaveLength(2))
      // A write made while the data is being adopted waits, then goes as the person's.
      const writing = bound(`${api.origin}/api/questions`, { method: "POST", body: "{}" })
      for (let turn = 0; turn < 10; turn++) await Promise.resolve()
      expect(api.seen.map(({ url }) => url)).toEqual(["/api/auth/session", "/api/auth/session"])
      release()
      expect((await reading).status).toBe(200)
      expect((await writing).status).toBe(200)
      expect(api.person()).toEqual([VISITOR, VISITOR, "alice"])
      expect(asked).toEqual([alice, alice])
      expect(reauthorized).toBe(0)
    } finally {
      await api.close()
    }
  })

  test("the session's Effect deadline aborts adoption when a leader never answers", async () => {
    const api = await serve(() => ({ signedIn: true, personId: "alice", login: "alice", role: "member" }))
    let reauthorized = 0
    let signal: AbortSignal | undefined
    try {
      await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
        const started = yield* Deferred.make<void>()
        const bound = boundFetch(fetch, {
          origin: api.origin,
          principal: () => VISITOR,
          reauthorize: async () => void reauthorized++,
          // Fault: the leader never sends a receipt. As in the page, the caller's abort ends the wait.
          adopt: (_session, requestSignal) => {
            signal = requestSignal
            Deferred.doneUnsafe(started, Effect.void)
            return new Promise<Adoption>((resolve) => requestSignal.addEventListener("abort", () => resolve("refused"), { once: true }))
          },
        })
        const reading = yield* getSession(api.origin, "15 seconds").pipe(
          Effect.provide(FetchHttpClient.layer),
          Effect.provideService(FetchHttpClient.Fetch, bound),
          Effect.exit,
          Effect.forkChild,
        )
        yield* Deferred.await(started)
        expect(signal?.aborted).toBe(false)
        yield* TestClock.adjust("15 seconds")
        const result = yield* Fiber.join(reading)
        expect(Exit.isFailure(result) ? Cause.squash(result.cause) : result).toEqual(new AuthUnreachable({ code: "timeout" }))
      })).pipe(Effect.provide(TestClock.layer())))
      await vi.waitFor(() => expect(reauthorized).toBe(1))
      expect(signal?.aborted).toBe(true)
      expect(api.seen.map(({ url }) => url)).toEqual(["/api/auth/session"])
    } finally {
      await api.close()
    }
  })

  test("a refused adoption reopens the page; data opened for someone else never asks to be adopted", async () => {
    const api = await serve(() => ({ signedIn: true, personId: "alice", login: "alice", role: "member" }))
    try {
      for (const principal of [VISITOR, "bob"]) {
        let reauthorized = 0
        let asked = 0
        const bound = boundFetch(fetch, {
          origin: api.origin,
          principal: () => principal,
          reauthorize: async () => void reauthorized++,
          adopt: async () => (asked++, "refused" as const),
        })
        await expect(bound(`${api.origin}/api/auth/session`)).rejects.toMatchObject({ reason: "reauthorizing" })
        expect([asked, reauthorized]).toEqual([principal === VISITOR ? 1 : 0, 1])
      }
    } finally {
      await api.close()
    }
  })

  test("staleness is one rule: another person for opened data, any person for a page sealed until sign-in", () => {
    const alice: SessionState = { signedIn: true, personId: "alice", login: "alice", role: "member" }
    const out: SessionState = { signedIn: false, available: true }
    expect(stale("alice", false, alice)).toBe(false)
    expect(stale("bob", false, alice)).toBe(true)
    expect(stale(VISITOR, false, alice)).toBe(true)
    expect(stale("alice", false, out)).toBe(false)
    expect(stale("alice", false, undefined)).toBe(false)
    expect(stale(NO_DEVICE_DATA, false, alice)).toBe(false)
    expect(stale(NO_DEVICE_DATA, true, alice)).toBe(true)
    expect(stale(NO_DEVICE_DATA, true, out)).toBe(false)
  })
})

test("the activation settles once: memory or retained, and a later receipt can't change it", async () => {
  let stopped = 0
  const denied = activationGate(() => void stopped++)
  expect(denied.state()).toBe("pending")
  expect(denied.refuse()).toBe(true)
  await denied.ready
  expect(denied.allow()).toBe(false)
  expect(denied.refuse()).toBe(false)
  expect(denied.state()).toBe("memory")
  expect(stopped).toBe(1)

  const allowed = activationGate(() => void stopped++)
  expect(allowed.allow()).toBe(true)
  await allowed.ready
  expect(allowed.refuse()).toBe(false)
  expect(allowed.state()).toBe("retained")
  expect(stopped).toBe(1)
})

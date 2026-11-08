import { createServer, type IncomingHttpHeaders } from "node:http"
import type { AddressInfo } from "node:net"
import { DatabaseSync, type SQLInputValue } from "node:sqlite"
import { Cause, Deferred, Effect, Exit, Fiber, Logger, Metric } from "effect"
import { afterEach, describe, expect, test, vi } from "vitest"
import { FetchHttpClient } from "effect/http"
import { TestClock } from "effect/testing"
import { AuthUnreachable, getSession } from "../features/auth/api"
import { CONFIRM_401_HEADER, NO_DEVICE_DATA, SESSION_CHECK_HEADER, SESSION_ROUTE, SIGN_OUT_ROUTE, type SessionState } from "../features/auth/contract"
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
  reopenDue,
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
  test("advertises stale-credential support on every own-origin API request, including session rereads", async () => {
    const alice: SessionState = { signedIn: true, personId: "alice", login: "alice", role: "member" }
    const seen: Array<{ path: string; accepts: string | undefined }> = []
    const server = createServer((request, response) => {
      seen.push({ path: request.url!, accepts: request.headers["x-smithers-accepts"] as string | undefined })
      response.writeHead(request.url === "/api/questions" ? 401 : 200, { "content-type": "application/json" })
      response.end(JSON.stringify(alice))
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const bound = boundFetch(fetch, { origin, principal: () => "alice", reauthorize: async () => false })
    try {
      for (const method of ["GET", "POST", "HEAD"]) {
        await bound(`${origin}/api/questions`, { method, headers: { "x-smithers-accepts": "unsupported" } })
      }
      await bound(`${origin}/api/auth/session`)
      await bound(`${origin}/assets/app.js`)
      await boundFetch(fetch, { origin: "http://elsewhere.test", principal: () => "alice" })(`${origin}/api/questions`)
      expect(seen).toEqual([
        ...Array.from({ length: 3 }, () => [
          { path: "/api/questions", accepts: "credential-stale" },
          { path: "/api/auth/session", accepts: "credential-stale" },
        ]).flat(),
        { path: "/api/auth/session", accepts: "credential-stale" },
        { path: "/assets/app.js", accepts: undefined },
        { path: "/api/questions", accepts: undefined },
      ])
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

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
    const bound = boundFetch(fetch, { origin: api.origin, principal: () => "alice", reauthorize: async () => {
      reauthorized++
      return true
    } })
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
    const bound = boundFetch(fetch, { origin, principal: () => "alice", reauthorize: async () => {
      reauthorized++
      return true
    } })
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
      { origin, principal: () => "alice", reauthorize: async () => {
      reauthorized++
      return true
    } },
    )
    expect((await unreachable(`${origin}/api/questions`, { method: "POST", body: "{}" })).status).toBe(401)
    expect(reauthorized).toBe(1)
  })

  test("a write that opts in has its 401 checked: still its person, marked; signed out, held for the page's reopening", async () => {
    let session: unknown = { signedIn: true, personId: "alice", login: "alice", role: "member" }
    const sent: Array<Request> = []
    const next: typeof fetch = async (input, init) => {
      const request = new Request(input, init)
      if (new URL(request.url).pathname === SESSION_ROUTE) return Response.json(session)
      sent.push(request)
      return new Response("{}", { status: 401 })
    }
    let reauthorized = 0
    const origin = "http://chat.test"
    const bound = boundFetch(next, { origin, principal: () => "alice", reauthorize: async () => {
      reauthorized++
      return true
    } })
    const write = (confirm: boolean) =>
      bound(`${origin}/api/texts/t`, { method: "POST", body: "{}", headers: confirm ? { [CONFIRM_401_HEADER]: "1" } : {} })
    // Still Alice: the refusal stands, marked for the caller; the opt-in never reaches ChatApi.
    const marked = await write(true)
    expect(marked.status).toBe(401)
    expect(marked.headers.get(SESSION_CHECK_HEADER)).toBe("same_person")
    expect(sent.at(-1)!.headers.has(CONFIRM_401_HEADER)).toBe(false)
    // A write that didn't opt in gets ChatApi's refusal as it was.
    const plain = await write(false)
    expect(plain.status).toBe(401)
    expect(plain.headers.has(SESSION_CHECK_HEADER)).toBe(false)
    expect(reauthorized).toBe(0)
    // Signed out: the page reopens and the write fails as unsent, so it stays queued for the reopened page's decision.
    session = { signedIn: false, available: true }
    await expect(write(true)).rejects.toEqual(new DeviceIdentityRefused({ reason: "signed_out" }))
    expect(reauthorized).toBe(1)
  })

  test.each([[undefined, "2"], ["0123456789abcdef0123456789abcdef", "Thu, 01 Jan 1970 00:00:12 GMT"]])("a stale credential is transport-only and gates retries with the recorded tag %s", async (tag, retryAfter) => {
    vi.useFakeTimers({ toFake: ["Date"] })
    try {
      vi.setSystemTime(10_000)
      let writes = 0
      const reads: Array<Request> = []
      let session: unknown = { credential: "stale", prior: "live" }
      const next: typeof fetch = async (input, init) => {
        const request = new Request(input, init)
        if (new URL(request.url).pathname === SESSION_ROUTE) {
          reads.push(request)
          return Response.json(session)
        }
        writes++
        return writes === 1
          ? new Response(null, { status: 503, headers: { "x-smithers-credential": "stale", "Retry-After": retryAfter! } })
          : Response.json({ txid: 1 })
      }
      const origin = "http://chat.test"
      // The activation's recorded tag is diagnostic only, never a person or credential.
      const binding = { origin, principal: () => "alice", sessionTag: () => tag }
      const bound = boundFetch(next, binding)
      const write = () => bound(`${origin}/api/texts/t`, { method: "POST", body: "{}" })
      const refused = new DeviceIdentityRefused({ reason: "credential_stale" })
      await expect(write()).rejects.toEqual(refused)
      vi.setSystemTime(11_999)
      await expect(write()).rejects.toEqual(refused)
      expect(writes).toBe(1)
      vi.setSystemTime(12_000)
      await expect(write()).rejects.toEqual(refused)
      expect(writes).toBe(1)
      expect(reads.at(-1)?.headers.get("x-smithers-session-tag")).toBe(tag ?? null)
      session = { signedIn: true, personId: "alice", login: "alice", role: "member" }
      expect((await write()).status).toBe(200)
      expect(writes).toBe(2)
    } finally {
      vi.useRealTimers()
    }
  })

  test.each([
    [{ credential: "stale", prior: "live" }, "credential_stale", 0],
    [{ signedIn: false, available: true }, "signed_out", 1],
    [{ signedIn: true, personId: "ben", login: "ben", role: "member" }, "reauthorizing", 1],
  ] as const)("a stale credential never sends the held write on an inconclusive or different session %j", async (session, reason, reopens) => {
    let writes = 0
    let reopened = 0
    const origin = "http://chat.test"
    const bound = boundFetch(async (input, init) => {
      const request = new Request(input, init)
      if (new URL(request.url).pathname === SESSION_ROUTE) return Response.json(session)
      writes++
      return new Response(null, { status: 503, headers: { "x-smithers-credential": "stale", "Retry-After": "invalid" } })
    }, { origin, principal: () => "alice", reauthorize: async () => { reopened++; return false } })
    const write = () => bound(`${origin}/api/texts/t`, { method: "POST", body: "{}" })
    await expect(write()).rejects.toEqual(new DeviceIdentityRefused({ reason: "credential_stale" }))
    await expect(write()).rejects.toEqual(new DeviceIdentityRefused({ reason }))
    expect(writes).toBe(1)
    expect(reopened).toBe(reopens)
  })

  test("the device retains its verified session tag across an offline activation without borrowing another person's tag", async () => {
    const device = store()
    const tag = "0123456789abcdef0123456789abcdef"
    const seen: Array<string | undefined> = []
    const activate = (session: Effect.Effect<SessionState, unknown>) => Effect.runPromise(Effect.exit(authorizeDevice({
      database: device.database, session,
      report: (...args: unknown[]) => { seen.push(args[3] as string | undefined) },
    })))
    await activate(Effect.succeed({ signedIn: true, personId: "alice", login: "alice", role: "member", session: tag } as SessionState))
    await activate(offline)
    await activate(Effect.succeed({ signedIn: true, personId: "ben", login: "ben", role: "member", session: "abcdef0123456789abcdef0123456789" } as SessionState))
    await activate(offline)
    expect(seen).toEqual([tag, tag, undefined, tag])
  })

  test("the opt-in never leaves the page: not to another origin, not to this origin outside its API", async () => {
    const seen: Array<string> = []
    const next: typeof fetch = async (input, init) => {
      const request = new Request(input, init)
      seen.push(`${request.url} ${request.headers.has(CONFIRM_401_HEADER)}`)
      return new Response("{}")
    }
    const origin = "http://chat.test"
    const bound = boundFetch(next, { origin, principal: () => "alice", reauthorize: async () => true })
    const confirm = { headers: { [CONFIRM_401_HEADER]: "1" } }
    await bound("http://elsewhere.test/api/texts/t", confirm)
    await bound(`${origin}/assets/app.js`, confirm)
    await bound(`${origin}/api/texts/t`, confirm)
    expect(seen).toEqual([
      "http://elsewhere.test/api/texts/t false",
      `${origin}/assets/app.js false`,
      `${origin}/api/texts/t false`,
    ])
  })

  test("a reopen the page holds back leaves its transport sending, after a session end and after another person alike", async () => {
    let session: unknown = { signedIn: false, available: true }
    let status = 401
    const next: typeof fetch = async (input, init) => {
      const request = new Request(input, init)
      if (new URL(request.url).pathname === SESSION_ROUTE) return Response.json(session)
      return new Response("{}", { status })
    }
    let asked = 0
    const origin = "http://chat.test"
    // main.tsx's `reopen` holds back a second reopen within the minute: nothing reopens, so nothing must wait for it.
    const bound = boundFetch(next, { origin, principal: () => "alice", reauthorize: async () => {
      asked++
      return false
    } })
    const write = () => bound(`${origin}/api/texts/t`, { method: "POST", body: "{}", headers: { [CONFIRM_401_HEADER]: "1" } })
    await expect(write()).rejects.toEqual(new DeviceIdentityRefused({ reason: "signed_out" }))
    expect(asked).toBe(1)
    status = 200
    expect((await write()).status).toBe(200)
    session = { signedIn: true, personId: "bob", login: "bob", role: "member" }
    status = 401
    await expect(write()).rejects.toEqual(new DeviceIdentityRefused({ reason: "reauthorizing" }))
    expect(asked).toBe(2)
    status = 200
    expect((await write()).status).toBe(200)
  })

  test("a session that ended by a sign-out of this page's never reopens it: the sign-out's wipe decides the write", async () => {
    let session: unknown = { signedIn: true, personId: "alice", login: "alice", role: "member" }
    let answerSignOut!: () => void
    const signedOut = new Promise<void>((resolve) => (answerSignOut = resolve))
    const next: typeof fetch = async (input, init) => {
      const path = new URL(new Request(input, init).url).pathname
      if (path === SESSION_ROUTE) return Response.json(session)
      if (path === SIGN_OUT_ROUTE) {
        // ChatApi ends the session at once; its answer is still on its way.
        session = { signedIn: false, available: true }
        await signedOut
        return new Response(null, { status: 204 })
      }
      return new Response("{}", { status: 401 })
    }
    let reauthorized = 0
    const origin = "http://chat.test"
    const bound = boundFetch(next, { origin, principal: () => "alice", reauthorize: async () => {
      reauthorized++
      return true
    } })
    const write = () => bound(`${origin}/api/texts/t`, { method: "POST", body: "{}", headers: { [CONFIRM_401_HEADER]: "1" } })
    const signingOut = bound(`${origin}${SIGN_OUT_ROUTE}`, { method: "POST" })
    // The write fails as unsent, so it stays queued, and the page stays open for the sign-out to mark its wipe.
    await expect(write()).rejects.toBeInstanceOf(DeviceIdentityRefused)
    answerSignOut()
    expect((await signingOut).status).toBe(204)
    // Taken: the page wipes and loads again next; until then, nothing reopens it either.
    await expect(write()).rejects.toBeInstanceOf(DeviceIdentityRefused)
    expect(reauthorized).toBe(0)
  })

  test("a page with no data open reopens only when sealed until someone signs in; the worker never does", async () => {
    let session: unknown = { signedIn: false, available: true }
    const api = await serve(() => session)
    let reauthorized = 0
    const reauthorize = async () => {
      reauthorized++
      return true
    }
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
    const bound = boundFetch(fetch, { origin: api.origin, principal: () => owner, reauthorize: async () => {
      reauthorized++
      return true
    }, adopt })
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
          reauthorize: async () => {
      reauthorized++
      return true
    },
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
          reauthorize: async () => {
      reauthorized++
      return true
    },
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


test("a cancelled or rejected reopen releases concurrent and subsequent API requests", async () => {
  for (const rejected of [false, true]) {
    let finish!: (value: boolean) => void
    let fail!: (error: Error) => void
    let entered!: () => void
    const started = new Promise<void>((resolve) => { entered = resolve })
    const opening = new Promise<boolean>((resolve, reject) => { finish = resolve; fail = reject })
    let calls = 0
    const fetch = boundFetch(async () => {
      calls++
      return Response.json({ signedIn: true, personId: calls === 1 ? "bob" : "alice", login: "person", role: "member" })
    }, { origin: "https://app.test", principal: () => "alice", reauthorize: () => { entered(); return opening } })
    const first = fetch("https://app.test/api/auth/session").catch(() => undefined)
    await started
    const second = fetch("https://app.test/api/auth/session").then((response) => response.status, () => "refused")
    await Promise.resolve()
    if (rejected) fail(new Error("Reopen cancelled"))
    else finish(false)
    await first
    expect(await second).toBe(200)
    expect((await fetch("https://app.test/api/auth/session")).status).toBe(200)
    expect(calls).toBe(3)
  }
})


test("suppressed reopen requests cannot slide the recovery deadline", () => {
  const marks = new Map([["reopen", "100000"]])
  const storage = { getItem: (key: string) => marks.get(key) ?? null, setItem: (key: string, value: string) => void marks.set(key, value) }
  for (const now of [130000, 159000]) expect(reopenDue(storage, "reopen", 60000, now)).toBe(false)
  expect(reopenDue(storage, "reopen", 60000, 160000)).toBe(true)
  // Eligibility alone is not an accepted reopen, such as while sign-out protects its wipe.
  expect(marks.get("reopen")).toBe("100000")
})

test("a stale-credential deadline and verification survive a successor transport", async () => {
  vi.useFakeTimers({ toFake: ["Date"] })
  try {
    vi.setSystemTime(10000)
    const rows = new Map<string, string>()
    const credentialStorage = { get: async (key: string) => rows.get(key) ?? null, set: async (key: string, value: string) => void rows.set(key, value) }
    let writes = 0
    let reads = 0
    let person = "alice"
    const next: typeof fetch = async (input, init) => {
      const request = new Request(input, init)
      if (new URL(request.url).pathname === SESSION_ROUTE) {
        reads++
        return Response.json({ signedIn: true, personId: person, login: person, role: "member" })
      }
      writes++
      return writes === 1 ? new Response(null, { status: 503, headers: { "x-smithers-credential": "stale", "Retry-After": "120" } }) : Response.json({ txid: 1 })
    }
    const binding = { origin: "https://app.test", principal: () => "alice", credentialStorage, reauthorize: async () => false }
    const send = (transport: typeof fetch) => transport("https://app.test/api/questions", { method: "POST" })
    await expect(send(boundFetch(next, binding))).rejects.toMatchObject({ reason: "credential_stale" })
    const successor = boundFetch(next, binding)
    await expect(send(successor)).rejects.toMatchObject({ reason: "credential_stale" })
    expect(writes).toBe(1)
    expect(reads).toBe(0)
    vi.setSystemTime(130000)
    person = "bob"
    await expect(send(successor)).rejects.toMatchObject({ reason: "reauthorizing" })
    expect(writes).toBe(1)
    person = "alice"
    expect((await send(boundFetch(next, binding))).status).toBe(200)
    expect(reads).toBe(2)
    expect(writes).toBe(2)
  } finally { vi.useRealTimers() }
})

test.each(["confirming 401", "expired deadline"] as const)("an internal %s session reread preserves Retry-After for this transport and its successor", async mode => {
  vi.useFakeTimers({ toFake: ["Date"] })
  vi.setSystemTime(10_000)
  const rows = new Map<string, string>()
  const credentialStorage = {
    get: async (key: string) => rows.get(key) ?? null,
    set: async (key: string, value: string) => void rows.set(key, value),
  }
  const lock = `credential-reread-${crypto.randomUUID()}`
  let writes = 0
  let reads = 0
  let staleRead = true
  const server = createServer((request, response) => {
    if (request.url === SESSION_ROUTE) {
      reads++
      if (staleRead) {
        response.writeHead(503, { "x-smithers-credential": "stale", "retry-after": "120" })
        response.end()
      } else {
        response.writeHead(200, { "content-type": "application/json" })
        response.end(JSON.stringify({ signedIn: true, personId: "alice", login: "alice", role: "member" }))
      }
      return
    }
    writes++
    if (writes === 1) {
      response.writeHead(mode === "confirming 401" ? 401 : 503,
        mode === "confirming 401" ? {} : { "x-smithers-credential": "stale", "retry-after": "1" })
      response.end()
    } else {
      response.writeHead(200, { "content-type": "application/json" })
      response.end(JSON.stringify({ txid: 1 }))
    }
  })
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const binding = { origin, principal: () => "alice", credentialStorage,
    withCredential: <A>(action: () => Promise<A>) => navigator.locks.request(lock, action),
    reauthorize: async () => false,
  }
  const send = (transport: typeof fetch) => transport(`${origin}/api/questions`, {
    method: "POST", headers: { [CONFIRM_401_HEADER]: "1" }, body: "{}",
  })
  try {
    const transport = boundFetch(fetch, binding)
    await expect(send(transport)).rejects.toBeInstanceOf(DeviceIdentityRefused)
    if (mode === "expired deadline") {
      vi.setSystemTime(11_000)
      await expect(send(transport)).rejects.toBeInstanceOf(DeviceIdentityRefused)
    }
    expect([writes, reads]).toEqual([1, 1])
    const until = mode === "confirming 401" ? 130_000 : 131_000
    vi.setSystemTime(until - 1)
    await expect(send(transport)).rejects.toMatchObject({ reason: "credential_stale" })
    await expect(send(boundFetch(fetch, binding))).rejects.toMatchObject({ reason: "credential_stale" })
    expect([writes, reads]).toEqual([1, 1])
    staleRead = false
    vi.setSystemTime(until)
    expect((await send(boundFetch(fetch, binding))).status).toBe(200)
    expect([writes, reads]).toEqual([2, 2])
  } finally {
    vi.useRealTimers()
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})

test("a memory-only page verifies its signed-in person after stale credentials", async () => {
  let writes = 0
  let reads = 0
  const transport = boundFetch(async (input, init) => {
    const request = new Request(input, init)
    if (new URL(request.url).pathname === SESSION_ROUTE) {
      reads++
      return Response.json({ signedIn: true, personId: "alice", login: "alice", role: "member" })
    }
    writes++
    expect(request.headers.get("x-smithers-device-person")).toBe(writes === 1 ? NO_DEVICE_DATA : "alice")
    return writes === 1 ? new Response(null, { status: 503, headers: { "x-smithers-credential": "stale", "Retry-After": "0" } }) : Response.json({ txid: 1 })
  }, { origin: "https://app.test", principal: () => NO_DEVICE_DATA, reauthorize: async () => false })
  const write = () => transport("https://app.test/api/questions", { method: "POST" })
  await expect(write()).rejects.toMatchObject({ reason: "credential_stale" })
  expect((await write()).status).toBe(200)
  expect(reads).toBe(1)
  expect(writes).toBe(2)
})


test("a memory-only page never releases its verified person's held write as another person", async () => {
  let person = "alice"
  let writes = 0
  const transport = boundFetch(async (input, init) => {
    const request = new Request(input, init)
    if (new URL(request.url).pathname === SESSION_ROUTE) return Response.json({ signedIn: true, personId: person, login: person, role: "member" })
    writes++
    return writes === 1 ? new Response(null, { status: 503, headers: { "x-smithers-credential": "stale", "Retry-After": "0" } }) : Response.json({ txid: 1 })
  }, { origin: "https://app.test", principal: () => NO_DEVICE_DATA, reauthorize: async () => false })
  await transport("https://app.test/api/auth/session")
  const write = () => transport("https://app.test/api/questions", { method: "POST" })
  await expect(write()).rejects.toMatchObject({ reason: "credential_stale" })
  person = "bob"
  await expect(write()).rejects.toMatchObject({ reason: "credential_stale" })
  expect(writes).toBe(1)
  person = "alice"
  expect((await write()).status).toBe(200)
  expect(writes).toBe(2)
})

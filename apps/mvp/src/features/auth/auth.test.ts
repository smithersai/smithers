import { FlowRegistry } from "../../flows/registry"
import { Persistence } from "@smthrs/effect-tanstack-db"
import { Action, type FlowRuntime } from "@smthrs/flow"
import { Logger as StructuredLogger } from "@smthrs/observability"
import { TabChannel } from "@smthrs/platform-browser"
import { type Context, Deferred, Effect, Exit, Layer, Logger, ManagedRuntime, Metric, Redacted, Ref, Scope } from "effect"
import { FetchHttpClient } from "effect/http"
import { SqlClient } from "effect/sql"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest"
import * as Database from "../../../db/Database"
import { build } from "../../../worker/test/flowHost"
import { testFile } from "../../../worker/test/harness"
import { signInHarness } from "../../../worker/test/signIn"
import { ClientEngine, FlowDispatch } from "../../flows/dispatch"
import { type NodeDevice, nodeDevice } from "../../test/chatApi"
import { Auth, bindSessionConnectivity } from "./auth"
import { AuthClient, AuthUnreachable } from "./api"
import { type ComposerAccess, composerAccess, DEVICE_PERSON_HEADER, signInHref } from "./contract"
import { DeviceWipe } from "./device"
import { AuthRefresh } from "./flows"
import { deviceWipes, sessionRefreshes, signInPresses, signOuts } from "./metrics"
import * as Steps from "./steps"
import { AuthStore } from "./store"
import { tabSession } from "./tab"

// Sign-in's state machine, driven as React drives it: through the auth layer's plain actions, reading its live query,
// with no React. The tab reaches sign-in's real routes (worker/SignIn.ts) over the compose Postgres, through a fetch
// that hands each request to the handler in this process and keeps cookies as a browser does. GitHub is the scripted
// one (worker/test/github.ts). An unhappy path gives the tab a faulty `AuthClient`; nothing intercepts a request. Each
// tab runs on a Node device (src/test/chatApi.ts `nodeDevice`): a SQLite file it keeps the confirmed session in, and
// the outbox a sign-out wipes. Every tab dispatches to one durable engine on the Node host, which runs `auth/refresh`
// and asks the tab that started it over Node's own `BroadcastChannel`, as the leader tab's engine worker does.

const server = testFile("auth_client")

/** The engine every tab of this file dispatches to: its name, its scope and what it built. */
const ENGINE = `auth-${crypto.randomUUID()}`
const engineScope = Effect.runSync(Scope.make())
let engine: Context.Context<FlowRuntime.FlowRuntime>
beforeAll(async () => {
  const registration = Steps.registration.pipe(
    // A tab that closed answers nothing: its refresh ends 2 s later, not a minute, so the file's runs settle quickly.
    Layer.provide(Steps.TabSession.layerChannel({ name: ENGINE, within: "2 seconds" })),
    Layer.provide(TabChannel.layer),
    Layer.provideMerge(Action.layerImplementations),
  )
  engine = (await Effect.runPromise(Scope.provide(engineScope)(build(registration)))).context
})
afterAll(() => Effect.runPromise(Scope.close(engineScope, Exit.void)))

beforeEach(() =>
  server.runPromise(
    Effect.flatMap(SqlClient.SqlClient, (sql) => sql`TRUNCATE sessions, sign_in_attempts, people CASCADE`),
  )
)

const ORIGIN = "http://smithers.test"

const runtimes: Array<{ dispose: () => Promise<void> }> = []
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.dispose()
})

/** A browser on `h`'s routes: a cookie jar, and `Origin` on every POST, as a browser sends from the page. */
const browser = (h: Awaited<ReturnType<typeof signInHarness>>, jar = new Map<string, string>()) => {
  let expectedPerson: string | undefined
  let sessionRequests = 0
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    if (url.pathname === "/api/auth/session") sessionRequests++
    const headers = new Headers(request.headers)
    if (expectedPerson !== undefined) headers.set(DEVICE_PERSON_HEADER, expectedPerson)
    if (jar.size > 0) headers.set("cookie", [...jar].map(([name, value]) => `${name}=${value}`).join("; "))
    if (request.method !== "GET") headers.set("origin", ORIGIN)
    const response = await h.fetch(`${url.pathname}${url.search}`, {
      method: request.method,
      headers,
      ...(request.method === "GET" ? {} : { body: await request.text() }),
    })
    if (url.pathname === "/api/auth/session" && expectedPerson === undefined && response.ok) {
      const identity = await response.clone().json() as { signedIn: boolean; personId?: string }
      if (identity.signedIn) expectedPerson = identity.personId
    }
    for (const line of response.headers.getSetCookie()) {
      const [pair] = line.split(";")
      const at = pair!.indexOf("=")
      if (/Max-Age=0|Expires=Thu, 01 Jan 1970/.test(line)) jar.delete(pair!.slice(0, at))
      else jar.set(pair!.slice(0, at), pair!.slice(at + 1))
    }
    return response
  }
  return {
    fetch: fetch as typeof globalThis.fetch,
    jar,
    sessionRequests: () => sessionRequests,
    /** Follows "Sign in with GitHub" from `returnTo` and approves on GitHub: where the browser lands. */
    signIn: async (returnTo = "/app") => {
      const toGitHub = await fetch(`${ORIGIN}${signInHref(returnTo)}`)
      const { code, state } = h.github.approve(toGitHub.headers.get("location")!)
      const back = await fetch(`${ORIGIN}/api/auth/callback?${new URLSearchParams({ code, state })}`)
      return back.headers.get("location")
    },
  }
}

type StructuredLog = ReturnType<typeof StructuredLogger.formatStructured.log>

/** A tab: the auth layer over `client`, recording its log lines and metrics. */
const openTab = async (client: Layer.Layer<AuthClient>, device: NodeDevice = nodeDevice(), wipe = device.wipe, target: EventTarget | false = new EventTarget()) => {
  const logs: Array<StructuredLog> = []
  const registry: Metric.MetricRegistry = new Map()
  const runtime = ManagedRuntime.make(
    Layer.merge(Auth.layer, tabSession({ name: ENGINE }).pipe(Layer.provide(TabChannel.layer))).pipe(
      Layer.provideMerge(AuthStore.layer),
      Layer.provideMerge(Persistence.layer(device.persistence)),
      Layer.provideMerge(DeviceWipe.layer(wipe)),
      Layer.provideMerge(client),
      Layer.provideMerge(
        FlowDispatch.layer.pipe(
          Layer.provide(FlowRegistry.layer),
          Layer.provide(ClientEngine.layerRuntime([AuthRefresh])),
          Layer.provide(Layer.succeedContext(engine)),
        ),
      ),
      Layer.provideMerge(Layer.succeed(Metric.MetricRegistry, registry)),
      Layer.provideMerge(
        Logger.layer([Logger.make((options) => void logs.push(StructuredLogger.formatStructured.log(options)))]),
      ),
    ),
  )
  runtimes.push(runtime)
  const { queries, actions } = await runtime.runPromise(Effect.service(Auth))
  queries.session.startSyncImmediate()
  queries.confirmed.startSyncImmediate()
  const listen = (target: EventTarget) => runtime.runFork(Effect.scoped(Effect.andThen(bindSessionConnectivity(target), Effect.never)))
  if (target !== false) listen(target)
  const count = (metric: Metric.Metric<number, Metric.CounterState<number>>, attributes: Record<string, string> = {}) =>
    runtime.runSync(
      Metric.value(Metric.withAttributes(metric, attributes)).pipe(Effect.provideService(Metric.MetricRegistry, registry)),
    ).count
  return {
    actions,
    listen,
    confirmation: () => runtime.runSync(Effect.flatMap(AuthStore, (store) => store.confirmation)),
    confirmed: () => queries.confirmed.toArray[0],
    forgetConfirmed: () => runtime.runPromise(Effect.gen(function* () {
      const store = yield* AuthStore
      yield* (yield* store.confirmed.delete("session")).persisted
    })),
    session: () => queries.session.toArray[0]!,
    /** What ComposerGate shows on this tab now. */
    access: (): ComposerAccess => composerAccess(queries.session.toArray[0]!, queries.confirmed.toArray[0]),
    logs,
    count,
    device,
    dispose: () => runtime.dispose(),
    /** Whether this tab's `auth/refresh` is running. */
    refreshing: () => runtime.runSync(Effect.flatMap(Effect.service(AuthStore), (store) => Ref.get(store.refreshing))),
    /** Waits until the session row says `status`. */
    settled: (status: string) => vi.waitFor(() => expect(queries.session.toArray[0]!.status).toBe(status), { interval: 10 }),
  }
}

/** The real client for a tab in `b`'s browser, with 5 seconds per request. */
const realClient = (b: ReturnType<typeof browser>) =>
  AuthClient.layer({ origin: ORIGIN, within: "5 seconds" }).pipe(
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(Layer.succeed(FetchHttpClient.Fetch, b.fetch)),
  )

describe("sign-in on a tab", () => {
  test("opens signed out, signs in through GitHub, and shows who", async () => {
    const h = await signInHarness(server)
    const b = browser(h)
    const tab = await openTab(realClient(b))
    expect(tab.session().status).toBe("loading")
    await tab.settled("signed_out")
    expect(tab.session()).toMatchObject({ login: null, role: null, available: true })
    tab.actions.pressSignIn()
    expect(tab.count(signInPresses)).toBe(1)
    expect(await b.signIn("/app")).toBe("/app")
    // The page reloads after the redirect; this tab asks again instead.
    tab.actions.reload()
    await tab.settled("signed_in")
    expect(tab.session()).toMatchObject({ login: "octocat", role: "member", signingOut: false })
  })

  test("signs out: signing out at once, then signed out, and the server's session is over", async () => {
    const h = await signInHarness(server)
    const b = browser(h)
    await b.signIn()
    const tab = await openTab(realClient(b))
    await tab.settled("signed_in")
    tab.actions.signOut()
    expect(tab.session().signingOut).toBe(true)
    // A second press while the first is on its way sends nothing more.
    tab.actions.signOut()
    await tab.settled("signed_out")
    expect(tab.session()).toMatchObject({ login: null, role: null, signingOut: false, available: true })
    expect(tab.count(signOuts, { outcome: "signed_out" })).toBe(1)
    expect(h.count({ route: "sign_out" })).toBe(1)
    const other = await openTab(realClient(b))
    await other.settled("signed_out")
  })

  test("a deployment without the GitHub App can't sign anyone in", async () => {
    const h = await signInHarness(server, { config: {} })
    const tab = await openTab(realClient(browser(h)))
    await tab.settled("signed_out")
    expect(tab.session().available).toBe(false)
  })

  test("sign-out still ends the real session when its local confirmation was already removed", async () => {
    const b = browser(await signInHarness(server))
    await b.signIn()
    const tab = await openTab(realClient(b))
    await tab.settled("signed_in")
    await vi.waitFor(() => expect(tab.confirmed()?.login).toBe("octocat"))
    await tab.forgetConfirmed()
    expect(tab.confirmed()).toBeUndefined()
    tab.actions.signOut()
    await tab.settled("signed_out")
    await vi.waitFor(() => expect(tab.count(signOuts, { outcome: "signed_out" })).toBe(1))
  })

  test("a ChatApi that can't say who is signed in leaves the tab unreachable, with the status in the log", async () => {
    const h = await signInHarness(server)
    const b = browser(h)
    await b.signIn()
    // The same browser, with its session cookie, reaching a ChatApi whose Postgres is down.
    const unreachable = Database.layer(Effect.succeed(Redacted.make("postgresql://smithers:smithers@127.0.0.1:1/smithers")))
    const down = await signInHarness(server, { github: h.github, database: unreachable })
    const tab = await openTab(realClient(browser(down, b.jar)))
    await tab.settled("unreachable")
    expect(tab.logs.find((log) => log.message === "session unreachable")!.annotations).toMatchObject({ status: 503 })
  })

  test("an answer outside the contract, none in time, or no network is unreachable too", async () => {
    const odd = openTab(
      AuthClient.layer({ origin: ORIGIN, within: "5 seconds" }).pipe(
        Layer.provide(FetchHttpClient.layer),
        Layer.provide(Layer.succeed(FetchHttpClient.Fetch, (async () => Response.json({ signedIn: "yes" })) as typeof fetch)),
      ),
    )
    await (await odd).settled("unreachable")
    const silent = await openTab(
      AuthClient.layer({ origin: ORIGIN, within: "50 millis" }).pipe(
        Layer.provide(FetchHttpClient.layer),
        Layer.provide(
          Layer.succeed(FetchHttpClient.Fetch, ((_: unknown, init?: RequestInit) =>
            new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason)))) as typeof fetch),
        ),
      ),
    )
    await silent.settled("unreachable")
    silent.actions.signOut()
    await vi.waitFor(() => expect(silent.session().signingOut).toBe(false))
    const offline = await openTab(
      AuthClient.layer({ origin: ORIGIN, within: "5 seconds" }).pipe(
        Layer.provide(FetchHttpClient.layer),
        Layer.provide(
          Layer.succeed(FetchHttpClient.Fetch, (() => Promise.reject(new TypeError("Failed to fetch"))) as typeof fetch),
        ),
      ),
    )
    await offline.settled("unreachable")
    offline.actions.signOut()
    await vi.waitFor(() => expect(offline.count(signOuts, { outcome: "failed" })).toBe(1))
    const refused = await openTab(
      AuthClient.layer({ origin: ORIGIN, within: "5 seconds" }).pipe(
        Layer.provide(FetchHttpClient.layer),
        Layer.provide(
          Layer.succeed(FetchHttpClient.Fetch, (async () => new Response(null, { status: 403 })) as typeof fetch),
        ),
      ),
    )
    await refused.settled("unreachable")
    refused.actions.signOut()
    await vi.waitFor(() => expect(refused.count(signOuts, { outcome: "failed" })).toBe(1))
    expect(refused.logs.find((log) => log.message === "sign out failed")!.annotations).toMatchObject({ status: 403 })
  })

  test("a sign-out ChatApi doesn't take keeps the person signed in, counted and logged", async () => {
    const tab = await openTab(
      Layer.succeed(
        AuthClient,
        AuthClient.of({
          session: Effect.succeed({ signedIn: true, login: "octocat", role: "admin" }),
          signOut: Effect.fail(new AuthUnreachable({})),
        }),
      ),
    )
    await tab.settled("signed_in")
    tab.actions.signOut()
    await vi.waitFor(() => expect(tab.count(signOuts, { outcome: "failed" })).toBe(1))
    expect(tab.session()).toMatchObject({ status: "signed_in", signingOut: false })
    expect(tab.logs.find((log) => log.message === "sign out failed")!.annotations).not.toHaveProperty("status")
  })

  test("its log lines carry whether someone is signed in, never who", async () => {
    const h = await signInHarness(server)
    const b = browser(h)
    await b.signIn()
    const tab = await openTab(realClient(b))
    await tab.settled("signed_in")
    tab.actions.pressSignIn()
    tab.actions.signOut()
    await tab.settled("signed_out")
    await vi.waitFor(() => expect(tab.count(deviceWipes, { outcome: "wiped" })).toBe(1), { interval: 10 })
    const actions = tab.logs.filter((log) => typeof log.message !== "string" || !log.message.startsWith("auth.session_"))
    expect(actions.map((log) => log.message)).toEqual(["session loaded", "sign in pressed", "signed out", "device wiped"])
    expect(actions[0]!.annotations).toMatchObject({ signedIn: true, feature: "auth" })
    expect(JSON.stringify(tab.logs)).not.toContain("octocat")
  })
})

/** A ChatApi this tab can't reach: every request fails at once, as offline. */
const offlineClient = AuthClient.layer({ origin: ORIGIN, within: "5 seconds" }).pipe(
  Layer.provide(FetchHttpClient.layer),
  Layer.provide(
    Layer.succeed(FetchHttpClient.Fetch, (() => Promise.reject(new TypeError("Failed to fetch"))) as typeof fetch),
  ),
)

/** A ChatApi that hasn't answered yet: the tab stays `loading`. */
const silentClient = AuthClient.layer({ origin: ORIGIN, within: "1 minute" }).pipe(
  Layer.provide(FetchHttpClient.layer),
  Layer.provide(
    Layer.succeed(FetchHttpClient.Fetch, ((_: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason)))) as typeof fetch),
  ),
)

/** Waits until the device has stored `count` confirmed sessions. */
const confirmedOn = (device: NodeDevice, count: number) =>
  vi.waitFor(() => expect(device.stored("auth-confirmed")).toBe(count), { interval: 10 })

/** Waits until the tab has read the device's confirmed session. */
const restored = (tab: Awaited<ReturnType<typeof openTab>>) =>
  vi.waitFor(() => expect(tab.session().restored).toBe(true), { interval: 10 })

describe("the composer", () => {
  test("ChatApi decides once it answers; until then, or offline, the session the device last confirmed does", () => {
    const at = (status: "loading" | "signed_in" | "signed_out" | "unreachable", role: string | null, restored = true) =>
      ({ status, role, restored }) as Parameters<typeof composerAccess>[0]
    const member = { role: "member" } as const
    const guest = { role: "guest" } as const
    for (const role of ["admin", "maintainer", "member"]) expect(composerAccess(at("signed_in", role), undefined)).toBe("ask")
    for (const role of ["guest", null]) expect(composerAccess(at("signed_in", role), member)).toBe("members_only")
    expect(composerAccess(at("signed_out", null), member)).toBe("sign_in")
    for (const status of ["loading", "unreachable"] as const) {
      expect(composerAccess(at(status, null), member), status).toBe("ask")
      expect(composerAccess(at(status, null), guest), status).toBe("members_only")
      expect(composerAccess(at(status, null), { role: null }), status).toBe("members_only")
      expect(composerAccess(at(status, null, false), undefined), status).toBe("wait")
    }
    // A device that never confirmed a session: nothing while ChatApi hasn't answered, so signing in doesn't flash the
    // prompt; the prompt once ChatApi can't be reached.
    expect(composerAccess(at("loading", null), undefined)).toBe("wait")
    expect(composerAccess(at("unreachable", null), undefined)).toBe("sign_in")
  })

  test("while the deployment's model is off, a member without a model of their own sees the way to add one", () => {
    const member = (hostedModel: boolean | undefined) =>
      ({ status: "signed_in", role: "member", restored: true, hostedModel }) as Parameters<typeof composerAccess>[0]
    expect(composerAccess(member(false), undefined, "none")).toBe("add_model")
    expect(composerAccess(member(false), undefined, "saved")).toBe("ask")
    // Their row hasn't synced yet: nothing, so neither the composer nor the prompt flashes.
    expect(composerAccess(member(false), undefined, "loading")).toBe("wait")
    // The deployment's model answers, or ChatApi didn't say: the composer, whatever they saved.
    for (const hosted of [true, undefined]) expect(composerAccess(member(hosted), undefined, "none")).toBe("ask")
    // A Guest still sees who may ask, before anything about models.
    expect(composerAccess({ ...member(false), role: "guest" }, undefined, "none")).toBe("members_only")
  })

  test("a member who reloads offline, or before ChatApi answers, can still ask", async () => {
    const h = await signInHarness(server)
    const b = browser(h)
    await b.signIn()
    const device = nodeDevice()
    const online = await openTab(realClient(b), device)
    await online.settled("signed_in")
    expect(online.access()).toBe("ask")
    await confirmedOn(device, 1)
    await online.dispose()
    const offline = await openTab(offlineClient, device)
    await offline.settled("unreachable")
    await restored(offline)
    expect(offline.access()).toBe("ask")
    const waiting = await openTab(silentClient, device)
    await restored(waiting)
    expect(waiting.session().status).toBe("loading")
    expect(waiting.access()).toBe("ask")
  })

  test("a device that never confirmed a session shows nothing until ChatApi answers, and the prompt offline", async () => {
    const waiting = await openTab(silentClient)
    await restored(waiting)
    expect(waiting.access()).toBe("wait")
    const offline = await openTab(offlineClient)
    await offline.settled("unreachable")
    await restored(offline)
    expect(offline.access()).toBe("sign_in")
  })

  test("a signed-in Guest, or a person with no role, sees that only Members ask, online and offline", async () => {
    for (const permission of ["triage", "read", "none"] as const) {
      const h = await signInHarness(server)
      h.github.permission = permission
      const b = browser(h)
      await b.signIn()
      const device = nodeDevice()
      const tab = await openTab(realClient(b), device)
      await tab.settled("signed_in")
      expect(tab.access(), permission).toBe("members_only")
      await confirmedOn(device, 1)
      const offline = await openTab(offlineClient, device)
      await offline.settled("unreachable")
      await restored(offline)
      expect(offline.access(), permission).toBe("members_only")
    }
  })

  test("session expiry retains the device owner; this online tab gates asks and offline recovery keeps the same person", async () => {
    const h = await signInHarness(server)
    const b = browser(h)
    await b.signIn()
    const device = nodeDevice()
    const tab = await openTab(realClient(b), device)
    await tab.settled("signed_in")
    await confirmedOn(device, 1)
    // Signed out in another tab of this browser: this one learns it when it asks again.
    await b.fetch(`${ORIGIN}/api/auth/sign-out`, { method: "POST" })
    tab.actions.reload()
    await tab.settled("signed_out")
    expect(tab.access()).toBe("sign_in")
    await confirmedOn(device, 1)
    const offline = await openTab(offlineClient, device)
    await offline.settled("unreachable")
    await restored(offline)
    expect(offline.access()).toBe("ask")
  })
})

test("expiry keeps the confirmed session; another person signing in wipes nothing here, since the owner check decides what opens", async () => {
  const h = await signInHarness(server)
  const b = browser(h)
  await b.signIn()
  const device = nodeDevice()
  const tab = await openTab(realClient(b), device)
  await tab.settled("signed_in")
  await confirmedOn(device, 1)
  await b.fetch(`${ORIGIN}/api/auth/sign-out`, { method: "POST" })
  tab.actions.reload()
  await tab.settled("signed_out")
  await confirmedOn(device, 1)
  // Another GitHub person, even one holding the same login. Whether this device's data may open under them is
  // decided before the app opens it (src/device/identity.ts); signing in never deletes it.
  h.github.person = { id: 900001, login: "octocat" }
  await b.signIn()
  tab.actions.reload()
  await tab.settled("signed_in")
  expect(tab.count(deviceWipes, { outcome: "wiped" })).toBe(0)
  await confirmedOn(device, 1)
})

describe("signing out wipes the device", () => {
  test("a sign-out ChatApi takes leaves no stored rows and an empty outbox; a failed one leaves both", async () => {
    const h = await signInHarness(server)
    const b = browser(h)
    await b.signIn()
    const device = nodeDevice()
    const outbox = device.outbox.storage!
    await outbox.set("queued-ask", "{}")
    const refused = await openTab(
      Layer.succeed(
        AuthClient,
        AuthClient.of({
          session: Effect.succeed({ signedIn: true, login: "octocat", role: "member" }),
          signOut: Effect.fail(new AuthUnreachable({ status: 503 })),
        }),
      ),
      device,
    )
    await refused.settled("signed_in")
    await confirmedOn(device, 1)
    refused.actions.signOut()
    await vi.waitFor(() => expect(refused.count(signOuts, { outcome: "failed" })).toBe(1), { interval: 10 })
    expect(refused.count(deviceWipes, { outcome: "wiped" })).toBe(0)
    expect(device.stored("auth-confirmed")).toBe(1)
    expect(await outbox.keys()).toEqual(["queued-ask"])
    await refused.dispose()

    const tab = await openTab(realClient(b), device)
    await tab.settled("signed_in")
    tab.actions.signOut()
    await tab.settled("signed_out")
    await vi.waitFor(() => expect(tab.count(deviceWipes, { outcome: "wiped" })).toBe(1), { interval: 10 })
    expect(device.stored("auth-confirmed")).toBe(0)
    expect(await outbox.keys()).toEqual([])
    expect(tab.logs.find((log) => log.message === "device wiped")!.annotations).toMatchObject({ feature: "auth" })
  })

  test("a wipe the host couldn't do is counted and logged, and the person is still signed out", async () => {
    const h = await signInHarness(server)
    const b = browser(h)
    await b.signIn()
    const tab = await openTab(realClient(b), nodeDevice(), () => Promise.reject(new Error("storage blocked")))
    await tab.settled("signed_in")
    tab.actions.signOut()
    await tab.settled("signed_out")
    await vi.waitFor(() => expect(tab.count(deviceWipes, { outcome: "failed" })).toBe(1), { interval: 10 })
    const line = tab.logs.find((log) => log.message === "device wipe failed")!
    expect(line.annotations).toMatchObject({ feature: "auth" })
    expect(JSON.stringify(tab.logs)).not.toContain("storage blocked")
    expect(JSON.stringify(tab.logs)).not.toContain("octocat")
  })
})


test("a same-valued successful refresh advances authorization without changing the session row", async () => {
  const b = browser(await signInHarness(server))
  await b.signIn()
  const tab = await openTab(realClient(b))
  await tab.settled("signed_in")
  const session = { ...tab.session() }
  const confirmation = tab.confirmation()
  const requests = b.sessionRequests()
  tab.actions.reload()
  await vi.waitFor(() => expect(tab.confirmation()).toBe(confirmation + 1))
  expect(tab.session()).toEqual(session)
  expect(b.sessionRequests()).toBe(requests + 1)
})

test("reconnecting refreshes the real session through the auth lifecycle", async () => {
  const h = await signInHarness(server)
  const b = browser(h)
  const target = new EventTarget()
  const device = nodeDevice()
  const tab = await openTab(realClient(b), device, device.wipe, target)
  await tab.settled("signed_out")
  await b.signIn()
  target.dispatchEvent(new Event("online"))
  await tab.settled("signed_in")
  expect(tab.access()).toBe("ask")
  expect(tab.session().login).toBe("octocat")
  expect(tab.count(sessionRefreshes, { via: "online" })).toBe(1)
  expect(tab.count(sessionRefreshes, { via: "startup" })).toBe(1)
  expect(tab.logs.filter((log) => log.message === "auth.session_refresh").map((log) => log.annotations)).toEqual([{ via: "startup" }, { via: "online" }])
  await tab.dispose()
  expect(tab.logs.filter((log) => log.message === "auth.session_subscription").map((log) => log.annotations.stage)).toEqual(["listening", "stopped"])
  expect(JSON.stringify(tab.logs)).not.toContain("octocat")
})


test("a network transition before subscription needs no second event: one initial check reads the current real session", async () => {
  const h = await signInHarness(server)
  const b = browser(h)
  const device = nodeDevice()
  const tab = await openTab(realClient(b), device, device.wipe, false)
  expect(tab.session().status).toBe("loading")
  expect(b.sessionRequests()).toBe(0)
  const target = new EventTarget()
  await b.signIn()
  target.dispatchEvent(new Event("online"))
  tab.listen(target)
  await tab.settled("signed_in")
  expect(tab.access()).toBe("ask")
  expect(b.sessionRequests()).toBe(1)
  expect(tab.count(sessionRefreshes, { via: "startup" })).toBe(1)
  expect(tab.count(sessionRefreshes, { via: "online" })).toBe(0)
})


test("an online check waits for the unresolved startup check instead of overlapping it", async () => {
  const h = await signInHarness(server)
  const b = browser(h)
  await b.signIn()
  const entered = Effect.runSync(Deferred.make<void>())
  const release = Effect.runSync(Deferred.make<void>())
  let calls = 0
  let active = 0
  let maximum = 0
  const client = Layer.effect(AuthClient, Effect.map(AuthClient, (real) => AuthClient.of({
    ...real,
    session: Effect.gen(function* () {
      calls++
      active++
      maximum = Math.max(maximum, active)
      if (calls === 1) {
        yield* Deferred.succeed(entered, undefined)
        yield* Deferred.await(release)
        return yield* new AuthUnreachable({})
      }
      return yield* real.session
    }).pipe(Effect.ensuring(Effect.sync(() => { active-- }))),
  }))).pipe(Layer.provide(realClient(b)))
  const target = new EventTarget()
  const device = nodeDevice()
  const tab = await openTab(client, device, device.wipe, target)
  await Effect.runPromise(Deferred.await(entered))
  expect(tab.session().status).toBe("loading")
  target.dispatchEvent(new Event("online"))
  // Let the actual event consumer run while the first check remains unresolved.
  await new Promise<void>((resolve) => setImmediate(resolve))
  expect(calls).toBe(1)
  expect(tab.count(sessionRefreshes, { via: "online" })).toBe(0)
  await Effect.runPromise(Deferred.succeed(release, undefined))
  await tab.settled("signed_in")
  // The failed startup check also started `auth/refresh`, whose check waits its turn behind the online one too.
  await vi.waitFor(() => expect(tab.count(sessionRefreshes, { via: "retry" })).toBe(1), { interval: 10, timeout: 10_000 })
  expect(calls).toBe(3)
  expect(maximum).toBe(1)
  expect(b.sessionRequests()).toBe(2)
  expect(tab.count(sessionRefreshes, { via: "startup" })).toBe(1)
  expect(tab.count(sessionRefreshes, { via: "online" })).toBe(1)
})

/** The real client for a tab in `b`'s browser behind a switch: ChatApi answers 503 until `heal`, as a gateway does. */
const healingClient = (b: ReturnType<typeof browser>) => {
  let healed = false
  return {
    heal: () => void (healed = true),
    fail: () => void (healed = false),
    layer: Layer.effect(AuthClient, Effect.map(AuthClient, (real) => AuthClient.of({
      ...real,
      session: Effect.suspend(() => healed ? real.session : Effect.fail(new AuthUnreachable({ status: 503 }))),
    }))).pipe(Layer.provide(realClient(b))),
  }
}

/** The tab's log lines named `message`, by their annotations. */
const lines = (tab: Awaited<ReturnType<typeof openTab>>, message: string) =>
  tab.logs.filter((log) => log.message === message).map((log) => log.annotations)

describe("a session check ChatApi couldn't answer", () => {
  test("recovers by itself: auth/refresh asks the tab again until ChatApi answers, with no event, click or reload", async () => {
    const h = await signInHarness(server)
    const b = browser(h)
    await b.signIn()
    const fault = healingClient(b)
    const device = nodeDevice()
    const tab = await openTab(fault.layer, device, device.wipe, new EventTarget())
    await tab.settled("unreachable")
    await restored(tab)
    expect(tab.access()).toBe("sign_in")
    // The engine has asked the tab again at least once, and ChatApi still can't say.
    await vi.waitFor(() => expect(tab.count(sessionRefreshes, { via: "retry" })).toBeGreaterThanOrEqual(1), { interval: 10, timeout: 10_000 })
    expect(tab.session().status).toBe("unreachable")
    fault.heal()
    await vi.waitFor(() => expect(tab.session().status).toBe("signed_in"), { interval: 10, timeout: 10_000 })
    expect(tab.access()).toBe("ask")
    expect(tab.session().login).toBe("octocat")
    expect(tab.count(sessionRefreshes, { via: "startup" })).toBe(1)
    expect(tab.count(sessionRefreshes, { via: "online" })).toBe(0)
    expect(lines(tab, "auth.refresh")).toEqual([{ stage: "started", feature: "auth" }])
    await vi.waitFor(() =>
      expect(lines(tab, "flow.dispatch")).toEqual([
        expect.objectContaining({ flow: "auth/refresh", door: "sync", outcome: "done" }),
      ]), { interval: 10, timeout: 10_000 })
    expect(JSON.stringify(tab.logs)).not.toContain("octocat")
  }, 20_000)

  test("starts one refresh for a run of failures: a check that fails while it runs starts no second one", async () => {
    const h = await signInHarness(server)
    const b = browser(h)
    await b.signIn()
    const fault = healingClient(b)
    const target = new EventTarget()
    const device = nodeDevice()
    const tab = await openTab(fault.layer, device, device.wipe, target)
    await vi.waitFor(() => expect(tab.count(sessionRefreshes, { via: "retry" })).toBeGreaterThanOrEqual(1), { interval: 10, timeout: 10_000 })
    target.dispatchEvent(new Event("online"))
    await vi.waitFor(() => expect(tab.count(sessionRefreshes, { via: "online" })).toBe(1), { interval: 10, timeout: 10_000 })
    expect(tab.session().status).toBe("unreachable")
    expect(lines(tab, "auth.refresh")).toHaveLength(1)
    fault.heal()
    await vi.waitFor(() => expect(tab.session().status).toBe("signed_in"), { interval: 10, timeout: 10_000 })
    expect(lines(tab, "auth.refresh")).toHaveLength(1)
    // Once the refresh has ended, the next run of failures starts a new one.
    await vi.waitFor(() => expect(tab.refreshing()).toBe(false), { interval: 10, timeout: 10_000 })
    expect(lines(tab, "flow.dispatch")).toEqual([expect.objectContaining({ flow: "auth/refresh", outcome: "done" })])
    fault.fail()
    target.dispatchEvent(new Event("online"))
    await vi.waitFor(() => expect(lines(tab, "auth.refresh")).toHaveLength(2), { interval: 10, timeout: 10_000 })
    fault.heal()
    await vi.waitFor(() => expect(lines(tab, "flow.dispatch")).toHaveLength(2), { interval: 10, timeout: 10_000 })
    expect(tab.session().status).toBe("signed_in")
  }, 30_000)
})

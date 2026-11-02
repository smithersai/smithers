// Sign-in on other hosts (decision 0130, docs/features/sign-in.md#other-hosts): an alias's sign-in goes through
// `APP_DOMAIN`'s one GitHub callback and comes back as a one-time code the alias redeems. The real routes, on this file's
// own schema of the compose Postgres, with the scripted GitHub (worker/test/github.ts) as the only stand-in; faults are
// injected database statements, never mocks.
import { Effect, Layer, Option, Redacted } from "effect"
import { HttpServerRequest } from "effect/http"
import { SqlClient } from "effect/sql"
import { ConnectionError, SqlError } from "effect/sql/SqlError"
import { beforeEach, describe, expect, test } from "vitest"
import * as TestDatabase from "../db/TestDatabase.ts"
import type { SessionState } from "../src/features/auth/contract.ts"
import * as SessionStore from "./SessionStore.ts"
import * as Actor from "./Actor.ts"
import * as Flows from "./Flows.ts"
import * as SessionKeys from "./SessionKeys.ts"
import { ARRIVE_HEADERS, CONFIRM_HEADERS, HANDOFF_CODE_TTL_SECONDS, SIGN_IN_TTL_SECONDS } from "./SignIn.ts"
import { testFile } from "./test/harness.ts"
import { configured, cookie, SECRET, setCookies, signInHarness } from "./test/signIn.ts"

const runtime = testFile("sign_in_handoff")

beforeEach(() =>
  runtime.runPromise(
    Effect.flatMap(SqlClient.SqlClient, (sql) => sql`TRUNCATE sessions, sign_in_attempts, people, domains CASCADE`),
  )
)

const sql = <A extends object>(statement: (sql: SqlClient.SqlClient) => Effect.Effect<ReadonlyArray<A>, unknown>) =>
  runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (client) => Effect.orDie(statement(client))))

const HOME = "http://smithers.test"
const ALIAS = "http://factory.test"
const OTHER = "http://other.test"
const CUSTOM = "http://custom.test"

/** Sign-in with a domain and two aliases. */
const withHome = { ...configured, APP_DOMAIN: "smithers.test", APP_ALIASES: "factory.test=/acme/widgets/-/factory, other.test=/acme/other" }

/** The `name=value` pairs a response's cookies set, without the ones it expires. */
const values = (response: Response) =>
  Object.fromEntries(
    Object.entries(setCookies(response)).filter(([, set]) => set.value !== "").map(([name, set]) => [name, set.value]),
  )

const harness = async (
  config: Record<string, string> = withHome,
  database?: Layer.Layer<SqlClient.SqlClient, unknown>,
  starter?: Flows.FlowStarter["Service"],
) => {
  const h = await signInHarness(runtime, {
    config,
    ...(database === undefined ? {} : { database }),
    ...(starter === undefined ? {} : { starter }),
  })

  /** Presses "Sign in with GitHub" on `origin`'s page: the redirect and the nonce cookie. */
  const press = async (origin = ALIAS, returnTo = "/acme/widgets/-/factory", site: string | null = "same-origin") => {
    const response = await h.at(`${origin}/api/auth/sign-in?return=${encodeURIComponent(returnTo)}`, {
      headers: site === null ? {} : { "sec-fetch-site": site },
    })
    return { response, location: response.headers.get("location")!, cookies: values(response) }
  }

  /** `APP_DOMAIN`'s hand-off for `location`, from a browser holding `cookies` there. */
  const handOff = (location: string, cookies: Record<string, string> = {}) =>
    h.at(location, { headers: { cookie: cookie(cookies) } })

  /** The code in a hand-off's redirect, read from its fragment. */
  const codeOf = (response: Response) => new URLSearchParams(new URL(response.headers.get("location")!).hash.slice(1)).get("code")!

  /** The alias's page posting `code` back, from a browser holding `cookies` there. */
  const arrive = (code: string | undefined, cookies: Record<string, string>, origin = ALIAS, init: RequestInit = {}) =>
    h.at(`${origin}/api/auth/arrive`, {
      method: "POST",
      body: code === undefined ? "" : new URLSearchParams({ code }).toString(),
      ...init,
      headers: { "content-type": "application/x-www-form-urlencoded", origin, cookie: cookie(cookies), ...init.headers },
    })

  /** Who `origin` says a browser holding `cookies` is. */
  const sessionAt = async (origin: string, cookies: Record<string, string>) =>
    (await (await h.at(`${origin}/api/auth/session`, { headers: { cookie: cookie(cookies) } })).json()) as SessionState

  /** The person pressing Continue on home's page for a custom domain, whose form posts `request`. */
  const confirm = (request: string, cookies: Record<string, string>, origin = HOME) =>
    h.at(`${HOME}/api/auth/handoff`, {
      method: "POST",
      body: new URLSearchParams({ request }).toString(),
      headers: { "content-type": "application/x-www-form-urlencoded", origin, cookie: cookie(cookies) },
    })

  /**
   * Signed in at home, presses Sign in at `origin`, and for a custom domain Continue at home: the hand-off's redirect
   * and the browser's cookies there.
   */
  const handedOff = async (origin = ALIAS, home?: Record<string, string>) => {
    const signedIn = home ?? (await h.signInAs()).cookies
    const pressed = await press(origin)
    const first = await handOff(pressed.location, signedIn)
    const response = first.status === 200
      ? await confirm(new URL(pressed.location).searchParams.get("request")!, signedIn)
      : first
    return { home: signedIn, pressed, response, code: codeOf(response) }
  }

  /** Signs in at `origin` all the way: the alias's cookies. */
  const signInAt = async (origin = ALIAS, home?: Record<string, string>) => {
    const { pressed, code, home: homeCookies } = await handedOff(origin, home)
    const response = await arrive(code, pressed.cookies, origin)
    return { home: homeCookies, response, cookies: values(response) }
  }

  /** Who `Actor.Sessions` says a request to `origin` holding `cookies` is. */
  const actorAt = (origin: string, cookies: Record<string, string>) =>
    runtime.runPromise(
      Effect.flatMap(Actor.Sessions, (sessions) => sessions.resolve).pipe(
        Effect.provide(h.sessions),
        Effect.provideService(
          HttpServerRequest.HttpServerRequest,
          HttpServerRequest.fromWeb(new Request(`${origin}/api/auth/session`, { headers: { cookie: cookie(cookies) } })),
        ),
      ),
    )

  return { ...h, press, handOff, codeOf, confirm, arrive, sessionAt, actorAt, handedOff, signInAt }
}

/** The stable id of a signed-in session's person. */
const personOf = (state: SessionState) => (state.signedIn ? state.personId! : "")

/**
 * Fails every statement whose text contains `fragment`, as an unreachable database would, or with `defect`, dies there
 * as a bug in a driver would.
 */
const failing = async (fragment: string, defect = false) => {
  const scratch = await runtime.runPromise(TestDatabase.Scratch)
  return Layer.effect(SqlClient.SqlClient, Effect.map(SqlClient.SqlClient, (real) => new Proxy(real, {
    apply(target, receiver, args) {
      if (!String(args[0]).includes(fragment)) return Reflect.apply(target, receiver, args)
      return defect
        ? Effect.die(new Error(`${fragment} broke`))
        : Effect.fail(new SqlError({ reason: new ConnectionError({ cause: `${fragment} unavailable` }) }))
    },
  }))).pipe(Layer.provide(scratch.database))
}

const hostSessions = () =>
  sql((client) => client<{ host: string; revoked: boolean }>`SELECT host, revoked_at IS NOT NULL AS revoked FROM host_sessions ORDER BY created_at`)

describe("signing in at an alias", () => {
  test("signed in at home, a press at the alias comes back signed in, with no GitHub and the one callback", async () => {
    const h = await harness()
    const home = (await h.signInAs()).cookies
    const calls = h.github.calls.length
    const pressed = await h.press()
    expect(pressed.response.status).toBe(302)
    const to = new URL(pressed.location)
    expect(`${to.origin}${to.pathname}`).toBe(`${HOME}/api/auth/handoff`)
    const nonce = setCookies(pressed.response)["smithers_handoff"]!
    expect(nonce.line).toMatch(/HttpOnly/)
    expect(nonce.line).toMatch(/SameSite=Lax/)
    expect(nonce.line).toMatch(new RegExp(`Max-Age=${SIGN_IN_TTL_SECONDS}`))
    expect(nonce.line).not.toMatch(/Domain=/)
    // The request names the nonce's digest only, never the nonce.
    const nonceValue = nonce.value.slice(0, nonce.value.lastIndexOf("."))
    expect(pressed.location).not.toContain(nonceValue)
    expect(pressed.location).toContain(SessionKeys.digest(nonceValue))

    const handed = await h.handOff(pressed.location, home)
    expect(handed.status).toBe(303)
    expect(handed.headers.get("referrer-policy")).toBe("no-referrer")
    const back = new URL(handed.headers.get("location")!)
    expect(`${back.origin}${back.pathname}${back.search}`).toBe(`${ALIAS}/api/auth/arrive`)
    const code = h.codeOf(handed)
    expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/)

    const arrived = await h.arrive(code, pressed.cookies)
    expect(arrived.status).toBe(303)
    expect(arrived.headers.get("location")).toBe("/acme/widgets/-/factory")
    const session = setCookies(arrived)["smithers_session"]!
    expect(session.line).toMatch(/HttpOnly/)
    expect(session.line).not.toMatch(/Domain=/)
    expect(setCookies(arrived)["smithers_handoff"]!.line).toMatch(/Max-Age=0/)
    expect(await h.sessionAt(ALIAS, { smithers_session: session.value })).toMatchObject({ signedIn: true, login: "octocat", role: "member" })
    // GitHub was asked nothing more, and home is still signed in with its own cookie.
    expect(h.github.calls.length).toBe(calls)
    expect(session.value).not.toBe(home["smithers_session"])
    expect(await h.sessionAt(HOME, home)).toMatchObject({ signedIn: true, login: "octocat" })
    expect(await hostSessions()).toEqual([{ host: "factory.test", revoked: false }])
    expect(h.count({ route: "handoff", outcome: "issued" })).toBe(1)
    expect(h.count({ route: "arrive", outcome: "signed_in" })).toBe(1)
  })

  // Device privacy (devpriv FINAL, step 1): an alias session has no end of its own (host_sessions has no expiry); the
  // answer at the alias reads the alias session it holds and says its parent's end, with the server's now.
  test("at an alias, the answer carries its parent session's end and the server's now", async () => {
    const h = await harness()
    const home = (await h.signInAs()).cookies
    const pressed = await h.press()
    const handed = await h.handOff(pressed.location, home)
    const arrived = await h.arrive(h.codeOf(handed), pressed.cookies)
    const alias = { smithers_session: setCookies(arrived)["smithers_session"]!.value }
    const parentEnd = async () => Number((await sql((client) =>
      client<{ readonly expiresAt: string }>`SELECT (extract(epoch FROM expires_at) * 1000)::bigint::text AS "expiresAt" FROM sessions`))[0]!.expiresAt)
    const before = Date.now()
    const answer = await h.sessionAt(ALIAS, alias) as SessionState & { readonly expiresAt?: number; readonly serverNow?: number }
    expect(answer).toMatchObject({ signedIn: true, login: "octocat", expiresAt: await parentEnd() })
    expect(answer.serverNow).toBeGreaterThanOrEqual(before)
    // The database's clock, not the Worker's: an alias answer an hour "later" on the Worker still says the database's now.
    h.advance(60 * 60 * 1000)
    const skewed = await h.sessionAt(ALIAS, alias) as { readonly expiresAt?: number; readonly serverNow?: number }
    expect(skewed.serverNow).toBeLessThan(Date.now() + 60 * 1000)
    expect(skewed.expiresAt).toBe(answer.expiresAt)
    h.advance(-60 * 60 * 1000)
    // The answer names no session: neither the parent's id nor the alias's own appears anywhere in it.
    const [ids] = await sql((client) =>
      client<{ readonly parent: string; readonly alias: string }>`
        SELECT s.id::text AS parent, h.id::text AS alias FROM host_sessions h JOIN sessions s ON s.id = h.parent_id`)
    expect(ids).toBeDefined()
    const serialized = JSON.stringify(answer)
    expect(serialized).not.toContain(ids!.parent)
    expect(serialized).not.toContain(ids!.alias)
    expect(answer).not.toHaveProperty("home")
    expect(answer).not.toHaveProperty("session")
    // The parent's end moves, and the alias's answer follows it; home says the same end.
    await sql((client) => client`UPDATE sessions SET expires_at = expires_at - interval '2 days'`)
    expect((await h.sessionAt(ALIAS, alias) as { readonly expiresAt?: number }).expiresAt).toBe(await parentEnd())
    expect((await h.sessionAt(HOME, home) as { readonly expiresAt?: number }).expiresAt).toBe(await parentEnd())
    // The alias session signed out on its own: the answer there is signed out, with no end, while home's stays.
    await sql((client) => client`UPDATE host_sessions SET revoked_at = now()`)
    expect(await h.sessionAt(ALIAS, alias)).toEqual({ signedIn: false, available: true, hostedModel: false })
    expect(await h.sessionAt(HOME, home)).toMatchObject({ signedIn: true, expiresAt: await parentEnd() })
  })

  test("signed out everywhere, GitHub's one callback at home finishes both", async () => {
    const h = await harness()
    const pressed = await h.press()
    const toGitHub = await h.handOff(pressed.location)
    expect(toGitHub.status).toBe(302)
    const authorize = new URL(toGitHub.headers.get("location")!)
    expect(authorize.searchParams.get("redirect_uri")).toBe(`${HOME}/api/auth/callback`)
    const { code, state } = h.github.approve(authorize.toString())
    const callback = await h.callback({ code, state }, values(toGitHub))
    expect(callback.status).toBe(303)
    const again = callback.headers.get("location")!
    expect(again).toBe(new URL(pressed.location).pathname + new URL(pressed.location).search)
    const home = values(callback)
    const handed = await h.handOff(`${HOME}${again}`, home)
    const arrived = await h.arrive(h.codeOf(handed), pressed.cookies)
    expect(arrived.headers.get("location")).toBe("/acme/widgets/-/factory")
    expect(await h.sessionAt(ALIAS, values(arrived))).toMatchObject({ signedIn: true, login: "octocat" })
    expect(await h.sessionAt(HOME, home)).toMatchObject({ signedIn: true })
  })

  test("a sign-in that fails at GitHub comes back to the alias saying so, without starting again", async () => {
    const h = await harness()
    const pressed = await h.press()
    const toGitHub = await h.handOff(pressed.location)
    const { state } = h.github.approve(toGitHub.headers.get("location")!)
    const denied = await h.callback({ error: "access_denied", state }, values(toGitHub))
    const failed = await h.handOff(`${HOME}${denied.headers.get("location")!}`)
    expect(failed.status).toBe(303)
    expect(failed.headers.get("location")).toBe(`${ALIAS}/acme/widgets/-/factory?sign_in=failed`)
    expect(h.count({ route: "handoff", reason: "sign_in_failed" })).toBe(1)
  })

  test("a verified custom domain signs in the same way; one still pending goes to GitHub as before", async () => {
    const h = await harness()
    const domain = (hostname: string, state: string) =>
      sql((client) => client`
        INSERT INTO domains (hostname, repo_id, poll_id, state, verification, certificate, updated_by)
        VALUES (${hostname}, 'acme/widgets', 'poll', ${state}, ${state}, ${state}, 'p')`)
    await domain("custom.test", "active")
    await domain("pending.test", "pending")
    // Home asks first: the domain's owner controls where its name points, so the person says so on home's own page.
    const home = (await h.signInAs()).cookies
    const pressed = await h.press(CUSTOM)
    const page = await h.handOff(pressed.location, home)
    expect(page.status).toBe(200)
    for (const [name, value] of Object.entries(CONFIRM_HEADERS)) expect(page.headers.get(name)).toBe(value)
    const html = await page.text()
    expect(html).toContain("<h1>Sign in to custom.test?</h1>")
    expect(html).toContain("custom.test will be signed in as @octocat.")
    expect(html).toContain(`<form method="post" action="/api/auth/handoff">`)
    expect(html).toContain("<button type=\"submit\">Continue to custom.test</button>")
    expect(html).not.toContain("<script")
    expect(await sql((client) => client`SELECT 1 FROM sign_in_handoffs`)).toEqual([])
    expect(h.count({ route: "handoff", outcome: "confirming" })).toBe(1)
    const signed = await h.signInAt(CUSTOM, home)
    expect(await h.sessionAt(CUSTOM, signed.cookies)).toMatchObject({ signedIn: true })
    const pending = await h.press("http://pending.test")
    expect(new URL(pending.location).origin).toBe("https://github.test")
    expect(new URL(pending.location).searchParams.get("redirect_uri")).toBe("http://pending.test/api/auth/callback")
  })

  test("without APP_DOMAIN, or with workers.dev, every host signs in through GitHub as before", async () => {
    for (const config of [configured, { ...configured, APP_DOMAIN: "workers.dev", APP_ALIASES: "factory.test=/a" }]) {
      const h = await harness(config)
      const pressed = await h.press()
      expect(new URL(pressed.location).searchParams.get("redirect_uri")).toBe(`${ALIAS}/api/auth/callback`)
      expect((await h.at(`${HOME}/api/auth/handoff?request=x`)).status).toBe(404)
      expect((await h.at(`${ALIAS}/api/auth/arrive`)).status).toBe(404)
    }
    // An alias list that doesn't parse, or none at all, names no alias.
    for (const config of [{ ...withHome, APP_ALIASES: "factory.test" }, { ...configured, APP_DOMAIN: "smithers.test" }]) {
      const h = await harness(config)
      expect(new URL((await h.press()).location).origin).toBe("https://github.test")
    }
  })
})

describe("what the hand-off refuses", () => {
  test("a foreign return host: a forged, tampered or expired request, or one naming a host that isn't ours", async () => {
    const h = await harness()
    const home = (await h.signInAs()).cookies
    const keys = await runtime.runPromise(SessionKeys.make(Redacted.make(SECRET)))
    const request = async (value: object) =>
      `${HOME}/api/auth/handoff?request=${encodeURIComponent(await runtime.runPromise(keys.sign("handoff_request", JSON.stringify(value))))}`
    const valid = { host: "factory.test", returnTo: "/", nonce: "n", expiresAt: Date.now() + 60_000 }
    const pressed = await h.press()
    const tampered = pressed.location.replace("factory.test", "evil.test")
    for (const [location, reason] of [
      [tampered, "invalid_request"],
      [`${HOME}/api/auth/handoff`, "invalid_request"],
      [await request({ ...valid, host: "evil.test" }), "foreign_host"],
      [await request({ ...valid, host: "smithers.test" }), "foreign_host"],
      [await request({ ...valid, host: "Evil Test" }), "foreign_host"],
      [await request({ host: "factory.test" }), "invalid_request"],
    ] as const) {
      const response = await h.handOff(location, home)
      expect(response.status, location).toBe(400)
      expect(response.headers.get("location")).toBeNull()
      expect(h.count({ route: "handoff", reason })).toBeGreaterThan(0)
    }
    // A request signed for another purpose is not a request.
    const asCookie = await runtime.runPromise(keys.sign("session", JSON.stringify(valid)))
    expect((await h.handOff(`${HOME}/api/auth/handoff?request=${encodeURIComponent(asCookie)}`, home)).status).toBe(400)
    // A request older than a sign-in's ten minutes is refused.
    h.advance((SIGN_IN_TTL_SECONDS + 1) * 1000)
    expect((await h.handOff(pressed.location, home)).status).toBe(400)
    expect(h.count({ route: "handoff", reason: "expired_request" })).toBe(1)
    expect(await sql((client) => client`SELECT 1 FROM sign_in_handoffs`)).toEqual([])
  })

  test("another browser's request for a custom domain gets only home's page, and its Continue only from home", async () => {
    const h = await harness()
    await sql((client) => client`
      INSERT INTO domains (hostname, repo_id, poll_id, state, verification, certificate, updated_by)
      VALUES ('custom.test', 'acme/widgets', 'poll', 'active', 'active', 'active', 'p')`)
    // The domain's owner presses Sign in on their own host, and sends the request to a person signed in at home.
    const attacker = await h.press(CUSTOM)
    const victim = (await h.signInAs()).cookies
    const lured = await h.handOff(attacker.location, victim)
    expect(lured.status).toBe(200)
    expect(lured.headers.get("location")).toBeNull()
    expect(await lured.text()).not.toMatch(/code=/)
    // A form on another site, or a browser that doesn't say where it posts from, hands nothing over.
    const request = new URL(attacker.location).searchParams.get("request")!
    expect((await h.confirm(request, victim, "http://evil.test")).status).toBe(403)
    const unsaid = await h.at(`${HOME}/api/auth/handoff`, {
      method: "POST",
      body: new URLSearchParams({ request }).toString(),
      headers: { cookie: cookie(victim), "sec-fetch-site": "cross-site" },
    })
    expect(unsaid.status).toBe(403)
    expect(h.count({ route: "handoff", reason: "cross_site" })).toBe(2)
    expect(await sql((client) => client`SELECT 1 FROM sign_in_handoffs`)).toEqual([])
    // A Continue without a request, or with a body too large to be one, is no request.
    expect((await h.confirm("", victim)).status).toBe(400)
    expect((await h.at(`${HOME}/api/auth/handoff`, { method: "POST", body: "x".repeat(5000), headers: { origin: HOME, cookie: cookie(victim) } })).status).toBe(400)
  })

  test("an alias request another browser obtained hands a code to that alias, where the victim's browser spends it", async () => {
    const h = await harness()
    const attacker = await h.press()
    const victim = (await h.signInAs()).cookies
    const lured = await h.handOff(attacker.location, victim)
    // The alias's page runs in the victim's browser, which holds no nonce: the code is spent and nobody is signed in.
    const arrived = await h.arrive(h.codeOf(lured), {})
    expect(arrived.headers.get("location")).toBe("/acme/widgets/-/factory?sign_in=failed")
    expect((await h.arrive(h.codeOf(lured), attacker.cookies)).headers.get("location")).toBe("/?sign_in=failed")
    expect(await hostSessions()).toEqual([])
  })

  test("a custom domain removed after its code was issued signs nobody in", async () => {
    const h = await harness()
    await sql((client) => client`
      INSERT INTO domains (hostname, repo_id, poll_id, state, verification, certificate, updated_by)
      VALUES ('custom.test', 'acme/widgets', 'poll', 'active', 'active', 'active', 'p')`)
    const { pressed, code } = await h.handedOff(CUSTOM)
    await sql((client) => client`UPDATE domains SET state = 'removing'`)
    expect((await h.arrive(code, pressed.cookies, CUSTOM)).headers.get("location")).toBe("/acme/widgets/-/factory?sign_in=failed")
    expect(h.count({ route: "arrive", reason: "foreign_host" })).toBe(1)
  })

  test("a signed request whose return names another site still returns to a path on the alias", async () => {
    const h = await harness()
    const home = (await h.signInAs()).cookies
    const keys = await runtime.runPromise(SessionKeys.make(Redacted.make(SECRET)))
    const pressed = await h.press()
    const nonce = pressed.cookies["smithers_handoff"]!.split(".")[0]!
    for (const returnTo of ["//evil.test/x", "https://evil.test/"]) {
      const signed = await runtime.runPromise(keys.sign("handoff_request", JSON.stringify({
        host: "factory.test", returnTo, nonce: SessionKeys.digest(nonce), expiresAt: Date.now() + 60_000,
      })))
      const handed = await h.handOff(`${HOME}/api/auth/handoff?request=${encodeURIComponent(signed)}`, home)
      expect((await h.arrive(h.codeOf(handed), pressed.cookies)).headers.get("location"), returnTo).toBe("/")
    }
  })

  test("the return is a path on the alias, never another site", async () => {
    const h = await harness()
    const home = (await h.signInAs()).cookies
    for (const target of ["//evil.test/x", "https://evil.test/", "/\\evil.test", "/.//evil.test"]) {
      const pressed = await h.press(ALIAS, target)
      const handed = await h.handOff(pressed.location, home)
      const arrived = await h.arrive(h.codeOf(handed), pressed.cookies)
      expect(arrived.headers.get("location"), target).toBe("/")
    }
  })

  test("the hand-off answers only at APP_DOMAIN, and the arrive page only away from it", async () => {
    const h = await harness()
    expect((await h.at(`${ALIAS}/api/auth/handoff?request=x`)).status).toBe(404)
    expect((await h.at(`${HOME}/api/auth/arrive`)).status).toBe(404)
    expect((await h.at(`${HOME}/api/auth/handoff`, { method: "PUT" })).status).toBe(405)
    expect((await h.at(`${ALIAS}/api/auth/arrive`, { method: "PUT" })).status).toBe(405)
  })

  test("a link on another site, or a browser that doesn't say, starts no sign-in at an alias", async () => {
    const h = await harness()
    for (const site of ["cross-site", "same-site", null]) {
      const pressed = await h.press(ALIAS, "/acme", site)
      expect(pressed.response.status).toBe(303)
      expect(pressed.location).toBe("/acme?sign_in=failed")
      expect(pressed.cookies).toEqual({})
    }
    // An address typed in is a person's own act.
    expect((await h.press(ALIAS, "/acme", "none")).response.status).toBe(302)
    expect(h.count({ route: "sign_in", reason: "cross_site" })).toBe(3)
  })

  test("a replayed code signs in once", async () => {
    const h = await harness()
    const { pressed, code } = await h.handedOff()
    expect((await h.arrive(code, pressed.cookies)).headers.get("location")).toBe("/acme/widgets/-/factory")
    const replayed = await h.arrive(code, pressed.cookies)
    expect(replayed.headers.get("location")).toBe("/?sign_in=failed")
    expect(values(replayed)["smithers_session"]).toBeUndefined()
    expect(await hostSessions()).toHaveLength(1)
    expect(h.count({ route: "arrive", reason: "unknown_code" })).toBe(1)
  })

  test(`an expired code, past its ${HANDOFF_CODE_TTL_SECONDS} seconds, signs nobody in`, async () => {
    const h = await harness()
    const { pressed, code } = await h.handedOff()
    await sql((client) => client`UPDATE sign_in_handoffs SET expires_at = now() - interval '1 second'`)
    const expired = await h.arrive(code, pressed.cookies)
    expect(expired.headers.get("location")).toBe("/acme/widgets/-/factory?sign_in=failed")
    expect(await hostSessions()).toEqual([])
    expect(h.count({ route: "arrive", reason: "expired" })).toBe(1)
  })

  test("a code is valid for 60 seconds", async () => {
    const h = await harness()
    await h.handedOff()
    const [row] = await sql((client) =>
      client<{ seconds: string }>`SELECT round(extract(epoch FROM expires_at - now()))::text AS seconds FROM sign_in_handoffs`)
    expect(Number(row!.seconds)).toBeLessThanOrEqual(HANDOFF_CODE_TTL_SECONDS)
    expect(Number(row!.seconds)).toBeGreaterThan(HANDOFF_CODE_TTL_SECONDS - 5)
  })

  test("a code used on another alias signs nobody in there, and is spent", async () => {
    const h = await harness()
    const { pressed, code } = await h.handedOff(ALIAS)
    // Even with this browser's nonce cookie carried over to the other host.
    const elsewhere = await h.arrive(code, pressed.cookies, OTHER)
    expect(elsewhere.headers.get("location")).toBe("/?sign_in=failed")
    expect(h.count({ route: "arrive", reason: "other_host" })).toBe(1)
    // Expired too, it is only expired.
    const late = await h.handedOff(ALIAS)
    await sql((client) => client`UPDATE sign_in_handoffs SET expires_at = now() - interval '1 second'`)
    expect((await h.arrive(late.code, late.pressed.cookies, OTHER)).headers.get("location")).toBe("/?sign_in=failed")
    expect(h.count({ route: "arrive", reason: "expired" })).toBe(1)
    expect((await h.arrive(code, pressed.cookies)).headers.get("location")).toBe("/?sign_in=failed")
    expect(await hostSessions()).toEqual([])
  })

  test("a missing or mismatched nonce signs nobody in, and spends the code (login CSRF)", async () => {
    const h = await harness()
    // The attacker's own code, planted in a victim's browser that pressed Sign in itself: the nonces differ.
    const attacker = await h.handedOff()
    const victim = await h.press()
    const planted = await h.arrive(attacker.code, victim.cookies)
    expect(planted.headers.get("location")).toBe("/acme/widgets/-/factory?sign_in=failed")
    expect(h.count({ route: "arrive", reason: "nonce_mismatch" })).toBe(1)
    expect((await h.arrive(attacker.code, attacker.pressed.cookies)).headers.get("location")).toBe("/?sign_in=failed")
    // No nonce at all: a browser that never pressed Sign in here.
    const second = await h.handedOff(ALIAS, attacker.home)
    expect((await h.arrive(second.code, {})).headers.get("location")).toBe("/acme/widgets/-/factory?sign_in=failed")
    // A nonce cookie that isn't ours.
    const third = await h.handedOff(ALIAS, attacker.home)
    const forged = { smithers_handoff: `${third.pressed.cookies["smithers_handoff"]!.split(".")[0]}.00` }
    expect((await h.arrive(third.code, forged)).headers.get("location")).toBe("/acme/widgets/-/factory?sign_in=failed")
    expect(h.count({ route: "arrive", reason: "nonce_missing" })).toBe(2)
    expect(await hostSessions()).toEqual([])
  })

  // The arrive page sends no referrer, so a real browser's form post carries `Origin: null` (Fetch, "append a request
  // `Origin` header": a POST under the no-referrer policy serializes its origin as null). Fetch Metadata says where it
  // came from: Arc sent exactly this on 2026-10-31, and the sign-in answered 403 until null counted as no origin.
  test("the arrive page's own post, Origin null under its no-referrer policy, signs in; another site's null origin doesn't", async () => {
    const h = await harness()
    const { pressed, code } = await h.handedOff()
    const lured = await h.handedOff()
    const crossSite = await h.arrive(lured.code, lured.pressed.cookies, ALIAS, {
      headers: { origin: "null", "sec-fetch-site": "cross-site" },
    })
    expect(crossSite.status).toBe(403)
    expect(h.count({ route: "arrive", reason: "cross_site" })).toBe(1)
    const arrived = await h.arrive(code, pressed.cookies, ALIAS, {
      headers: { origin: "null", "sec-fetch-site": "same-origin" },
    })
    expect(arrived.status).toBe(303)
    expect(arrived.headers.get("location")).toBe("/acme/widgets/-/factory")
    expect(await h.sessionAt(ALIAS, values(arrived))).toMatchObject({ signedIn: true, login: "octocat" })
  })

  test("another site's form, a missing code or an oversized body signs nobody in", async () => {
    const h = await harness()
    const { pressed, code } = await h.handedOff()
    const crossSite = await h.arrive(code, pressed.cookies, ALIAS, { headers: { origin: "http://evil.test" } })
    expect(crossSite.status).toBe(403)
    const noOrigin = await h.at(`${ALIAS}/api/auth/arrive`, {
      method: "POST",
      body: `code=${code}`,
      headers: { cookie: cookie(pressed.cookies), "sec-fetch-site": "cross-site" },
    })
    expect(noOrigin.status).toBe(403)
    expect(h.count({ route: "arrive", reason: "cross_site" })).toBe(2)
    expect((await h.arrive(undefined, pressed.cookies)).headers.get("location")).toBe("/?sign_in=failed")
    expect((await h.arrive("x".repeat(2000), pressed.cookies)).headers.get("location")).toBe("/?sign_in=failed")
    expect(h.count({ route: "arrive", reason: "body" })).toBe(1)
    // The refused attempts never reached the code: the browser that pressed still signs in, by Fetch Metadata alone.
    const arrived = await h.at(`${ALIAS}/api/auth/arrive`, {
      method: "POST",
      body: `code=${code}`,
      headers: { cookie: cookie(pressed.cookies), "sec-fetch-site": "same-origin" },
    })
    expect(arrived.headers.get("location")).toBe("/acme/widgets/-/factory")
  })

  test("a code in the Referer, a URL or a record: it travels only in the fragment and a POST body", async () => {
    const h = await harness()
    const { pressed, response, code } = await h.handedOff()
    // The redirect carries the code in its fragment, which no browser sends to a server or in a Referer.
    const location = new URL(response.headers.get("location")!)
    expect(location.search).toBe("")
    expect(location.hash).toBe(`#code=${code}`)
    // The page it lands on sends no referrer, runs only its own script and drops the fragment from history.
    const page = await h.at(`${ALIAS}/api/auth/arrive`)
    expect(page.status).toBe(200)
    expect(page.headers.get("content-type")).toMatch(/^text\/html/)
    for (const [name, value] of Object.entries(ARRIVE_HEADERS)) expect(page.headers.get(name)).toBe(value)
    const html = await page.text()
    expect(html).toContain(`<meta name="referrer" content="no-referrer">`)
    expect(html).toContain(`history.replaceState(null, "", location.pathname)`)
    expect(html).toContain(`<form method="post" action="/api/auth/arrive">`)
    const script = /<script>([\s\S]*)<\/script>/.exec(html)![1]!
    const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(script))
    expect(ARRIVE_HEADERS["content-security-policy"]).toContain(`'sha256-${Buffer.from(hash).toString("base64")}'`)
    // A code in the query string, as a leaked URL would carry it, is never read.
    const inQuery = await h.at(`${ALIAS}/api/auth/arrive?code=${code}`, {
      method: "POST",
      body: "",
      headers: { origin: ALIAS, cookie: cookie(pressed.cookies) },
    })
    expect(inQuery.headers.get("location")).toBe("/?sign_in=failed")
    expect(h.count({ route: "arrive", reason: "missing_code" })).toBe(1)
    const arrived = await h.arrive(code, pressed.cookies)
    expect(arrived.headers.get("referrer-policy")).toBe("no-referrer")
    expect(arrived.headers.get("location")).not.toContain(code)
    // Nothing recorded carries the code, the nonce or the session it made.
    const nonce = pressed.cookies["smithers_handoff"]!.split(".")[0]!
    const session = values(arrived)["smithers_session"]!.split(".")[0]!
    const records = JSON.stringify([h.logs, h.spans.map((span) => [span.name, span.attributes]), h.snapshot()], (_, value) =>
      typeof value === "bigint" ? String(value) : value)
    for (const secret of [code, nonce, session, SessionKeys.digest(code), SECRET]) expect(records).not.toContain(secret)
    expect(JSON.stringify(await sql((client) => client<object>`SELECT * FROM host_sessions`))).not.toContain(session)
  })
})

describe("alias sessions", () => {
  test("a fresh token at every sign-in: the browser's earlier alias session ends, and none it brings is adopted", async () => {
    const h = await harness()
    const first = await h.signInAt()
    const { pressed, code, home } = await h.handedOff(ALIAS)
    const again = await h.arrive(code, { ...pressed.cookies, ...first.cookies })
    const second = values(again)
    expect(second["smithers_session"]).not.toBe(first.cookies["smithers_session"])
    expect(await h.sessionAt(ALIAS, first.cookies)).toMatchObject({ signedIn: false })
    expect(await h.sessionAt(ALIAS, second)).toMatchObject({ signedIn: true })
    expect(await hostSessions()).toEqual([{ host: "factory.test", revoked: true }, { host: "factory.test", revoked: false }])
    expect(await h.sessionAt(HOME, home)).toMatchObject({ signedIn: true })
    // A cookie whose session already ended changes nothing, and starts no sign-out.
    const third = await h.handedOff(ALIAS, home)
    expect((await h.arrive(third.code, { ...third.pressed.cookies, ...first.cookies })).headers.get("location")).toBe("/acme/widgets/-/factory")
    expect(h.revocations).toEqual([])
  })

  test("an alias session reads only at its own host, and a home cookie still reads at an alias", async () => {
    const h = await harness()
    const { cookies, home } = await h.signInAt()
    expect(await h.sessionAt(OTHER, cookies)).toMatchObject({ signedIn: false })
    expect(await h.sessionAt(HOME, cookies)).toMatchObject({ signedIn: false })
    // A session signed in at the alias itself, before 0130, still reads there.
    expect(await h.sessionAt(ALIAS, home)).toMatchObject({ signedIn: true })
  })

  test("signing out at an alias ends that alias's session only", async () => {
    const h = await harness()
    const factory = await h.signInAt(ALIAS)
    const other = await h.signInAt(OTHER, factory.home)
    const out = await h.at(`${ALIAS}/api/auth/sign-out`, {
      method: "POST",
      headers: { origin: ALIAS, cookie: cookie(factory.cookies), "x-smithers-device-person": personOf(await h.sessionAt(ALIAS, factory.cookies)) },
    })
    expect(out.status).toBe(204)
    expect(setCookies(out)["smithers_session"]!.line).toMatch(/Max-Age=0/)
    expect(h.revocations).toEqual([])
    expect(await h.sessionAt(ALIAS, factory.cookies)).toMatchObject({ signedIn: false })
    expect(await h.sessionAt(OTHER, other.cookies)).toMatchObject({ signedIn: true })
    expect(await h.sessionAt(HOME, factory.home)).toMatchObject({ signedIn: true })
    expect(h.count({ route: "sign_out", reason: "alias" })).toBe(1)
    // Another person's page can't sign the alias out.
    const refused = await h.at(`${OTHER}/api/auth/sign-out`, {
      method: "POST",
      headers: { origin: OTHER, cookie: cookie(other.cookies), "x-smithers-device-person": "someone-else" },
    })
    expect(refused.status).toBe(403)
  })

  test("revoking the session at home revokes it at every alias", async () => {
    const h = await harness()
    const factory = await h.signInAt(ALIAS)
    const other = await h.signInAt(OTHER, factory.home)
    const person = personOf(await h.sessionAt(HOME, factory.home))
    const out = await h.at(`${HOME}/api/auth/sign-out`, {
      method: "POST",
      headers: { origin: HOME, cookie: cookie(factory.home), "x-smithers-device-person": person },
    })
    expect(out.status).toBe(204)
    expect(h.revocations).toHaveLength(1)
    expect(await h.sessionAt(ALIAS, factory.cookies)).toMatchObject({ signedIn: false })
    expect(await h.sessionAt(OTHER, other.cookies)).toMatchObject({ signedIn: false })
    // A code minted before home signed out signs nobody in.
    const late = await h.handedOff(ALIAS, (await h.signInAs()).cookies)
    await sql((client) => client`UPDATE sessions SET revoked_at = now(), revoked_reason = 'sign_out'`)
    expect((await h.arrive(late.code, late.pressed.cookies)).headers.get("location")).toBe("/acme/widgets/-/factory?sign_in=failed")
    expect(h.count({ route: "arrive", reason: "home_ended" })).toBe(1)
  })

  test("an alias session acts as its home session: its role check, credentials and GitHub writes are home's", async () => {
    const h = await harness()
    const { cookies } = await h.signInAt()
    const [home] = await sql((client) => client<{ id: string }>`SELECT id::text AS id FROM sessions`)
    h.advance(61 * 60 * 1000)
    await h.sessionAt(ALIAS, cookies)
    expect(h.roleChecks.map((check) => check.sessionId)).toEqual([home!.id])
    // The session a run credential names and a GitHub write takes the person's tokens from is the home session.
    expect(await h.actorAt(ALIAS, cookies)).toEqual(Option.some(expect.objectContaining({ session: home!.id, login: "octocat" })))
    expect(await runtime.runPromise(SessionStore.findLiveById(home!.id))).toEqual(Option.some(expect.objectContaining({ id: home!.id })))
    expect(await h.actorAt(OTHER, cookies)).toEqual(Option.none())
  })

  test("signing in at home again, or home's session expiring, ends every alias session under it", async () => {
    const h = await harness()
    const factory = await h.signInAt(ALIAS)
    // Signing in again in the home browser ends its session there, and the alias's with it.
    const again = await h.start()
    const { code, state } = h.github.approve(again.location)
    const callback = await h.callback({ code, state }, { ...values(again.response), ...factory.home })
    expect(callback.status).toBe(303)
    expect(await h.sessionAt(ALIAS, factory.cookies)).toMatchObject({ signedIn: false })
    const later = await h.signInAt(ALIAS, values(callback))
    await sql((client) => client`UPDATE sessions SET expires_at = now() - interval '1 second'`)
    expect(await h.sessionAt(ALIAS, later.cookies)).toMatchObject({ signedIn: false })
  })

  test("signing in at an alias again signs out a session made there through GitHub before 0130, revoking its token", async () => {
    const h = await harness()
    // Two browsers' sessions: the one that signed in at the alias itself, and the one at home.
    const legacy = (await h.signInAs()).cookies
    const home = (await h.signInAs()).cookies
    const [old] = await sql((client) => client<{ id: string }>`SELECT id::text AS id FROM sessions ORDER BY created_at LIMIT 1`)
    const { pressed, code } = await h.handedOff(ALIAS, home)
    const arrived = await h.arrive(code, { ...pressed.cookies, ...legacy })
    expect(arrived.headers.get("location")).toBe("/acme/widgets/-/factory")
    expect(h.revocations).toEqual([old!.id])
    expect(await h.sessionAt(ALIAS, legacy)).toMatchObject({ signedIn: false })
    expect(await h.sessionAt(ALIAS, values(arrived))).toMatchObject({ signedIn: true })
  })

  test("a legacy session's sign-out the host can't start fails the sign-in and keeps it", async () => {
    const h = await signInHarnessRefusing()
    const legacy = (await h.signInAs()).cookies
    const home = (await h.signInAs()).cookies
    const { pressed, code } = await h.handedOff(ALIAS, home)
    const arrived = await h.arrive(code, { ...pressed.cookies, ...legacy })
    expect(arrived.headers.get("location")).toBe("/acme/widgets/-/factory?sign_in=failed")
    expect(h.count({ route: "arrive", reason: "sign_out_not_started" })).toBe(1)
    expect(await h.sessionAt(ALIAS, legacy)).toMatchObject({ signedIn: true })
  })
})

describe("when Postgres fails", () => {
  test("checking a custom domain answers 503 as an alias presses Sign in", async () => {
    const h = await harness(withHome, await failing("FROM domains"))
    const response = await h.at(`${CUSTOM}/api/auth/sign-in?return=/`, { headers: { "sec-fetch-site": "same-origin" } })
    expect(response.status).toBe(503)
    expect(h.count({ route: "sign_in", reason: "error" })).toBe(1)
  })

  test("storing a code answers 503 at home", async () => {
    const h = await harness(withHome, await failing("INSERT INTO sign_in_handoffs"))
    const home = (await h.signInAs()).cookies
    const response = await h.handOff((await h.press()).location, home)
    expect(response.status).toBe(503)
    expect(h.count({ route: "handoff", reason: "error" })).toBe(1)
  })

  test.each([
    ["DELETE FROM sign_in_handoffs WHERE code_digest", "/?sign_in=failed"],
    ["INSERT INTO host_sessions", "/acme/widgets/-/factory?sign_in=failed"],
    ["UPDATE host_sessions", "/acme/widgets/-/factory?sign_in=failed"],
  ])("a statement that fails as the alias redeems (%s) signs nobody in", async (statement, location) => {
    const h = await harness(withHome, await failing(statement))
    const { pressed, code } = await h.handedOff()
    const extra: Record<string, string> = statement.startsWith("UPDATE") ? { smithers_session: await signedSession() } : {}
    const arrived = await h.arrive(code, { ...pressed.cookies, ...extra })
    expect(arrived.headers.get("location")).toBe(location)
    expect(h.count({ route: "arrive", reason: "database" })).toBe(1)
  })
})

test("a bug as the alias redeems signs nobody in, logged by its name", async () => {
  const h = await harness(withHome, await failing("DELETE FROM sign_in_handoffs WHERE code_digest", true))
  const { pressed, code } = await h.handedOff()
  expect((await h.arrive(code, pressed.cookies)).headers.get("location")).toBe("/?sign_in=failed")
  expect(h.count({ route: "arrive", reason: "error" })).toBe(1)
})

/** Sign-in where the host refuses to start every remote flow, `auth/RevokeGitHubToken` included. */
const signInHarnessRefusing = () =>
  harness(withHome, undefined, Flows.FlowStarter.of({ start: () => Effect.fail(new Flows.StartUnavailable({ errorCode: "rpc" })) }))

/** A session cookie this deployment signed, for a session that doesn't exist. */
const signedSession = async () => {
  const keys = await runtime.runPromise(SessionKeys.make(Redacted.make(SECRET)))
  return runtime.runPromise(keys.sign("session", "no-such-session"))
}

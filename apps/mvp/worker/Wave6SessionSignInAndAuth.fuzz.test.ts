// Generated scenarios against sign-in's real routes (worker/SignIn.ts), the session store (worker/SessionStore.ts) and
// the replaced-token cleanup (worker/flows/RevokeReplacedGitHubToken.ts), on this file's own schema of the compose
// Postgres with the scripted GitHub (worker/test/github.ts) as the only stand-in. Each property computes what must
// happen from the scenario alone, then reads the answer, the cookies and the rows.
import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Cause, ConfigProvider, Effect, Exit, Metric, Option, Redacted, Schema } from "effect"
import { FetchHttpClient } from "effect/http"
import { SqlClient } from "effect/sql"
import { expect, test } from "vitest"
import * as TestDatabase from "../db/TestDatabase.ts"
import { DEVICE_PERSON_HEADER, NO_DEVICE_DATA, type SessionState } from "../src/features/auth/contract.ts"
import type { Actor } from "./Actor.ts"
import * as Flows from "./Flows.ts"
import * as Cleanup from "./flows/RevokeReplacedGitHubToken.vibe"
import * as SessionKeys from "./SessionKeys.vibe"
import * as SessionStore from "./SessionStore.ts"
import * as SignIn from "./SignIn.ts"
import { scriptedGitHub } from "./test/github.ts"
import { testFile } from "./test/harness.ts"
import { configured, cookie, SECRET, setCookies, signInHarness } from "./test/signIn.ts"

const runtime = testFile("wave6_session_auth")

const seed = Number(process.env.EFFECT_FUZZ_SEED ?? 20261141)
const requested = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? 100)

/** Runs `check` on `executions` generated scenarios; a thrown expectation is the finding. */
const property = async <A>(scenarios: Arbitrary.Arbitrary<A>, executions: number, check: (scenario: A) => Promise<void>) => {
  const report = await Effect.runPromise(
    Fuzz.run(scenarios, (scenario) => Effect.as(Effect.promise(() => check(scenario)), true), { seed, executions }),
  )
  expect(Fuzz.formatReport(report)).toBeUndefined()
}

const sql = <A extends object>(statement: (sql: SqlClient.SqlClient) => Effect.Effect<ReadonlyArray<A>, unknown>) =>
  runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (client) => Effect.orDie(statement(client))))

const run = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) => runtime.runPromise(effect)

const HOME = "http://smithers.test"
const ALIAS = "http://factory.test"
const OTHER = "http://other.test"
const CUSTOM = "http://custom.test"
const withHome = { ...configured, APP_DOMAIN: "smithers.test", APP_ALIASES: "factory.test=/acme/widgets/-/factory, other.test=/acme/other" }

/** The `name=value` pairs a response's cookies set, without the ones it expires. */
const values = (response: Response) =>
  Object.fromEntries(
    Object.entries(setCookies(response)).filter(([, set]) => set.value !== "").map(([name, set]) => [name, set.value]),
  )

/** A signed cookie whose signature isn't ours. */
const forged = (signed: string) => `${signed.slice(0, signed.lastIndexOf("."))}.00`

const customDomain = () =>
  sql((client) => client`
    INSERT INTO domains (hostname, repo_id, poll_id, state, verification, certificate, updated_by)
    VALUES ('custom.test', 'acme/widgets', 'poll', 'active', 'active', 'active', 'p')
    ON CONFLICT DO NOTHING`)

/** Sign-in with a home, two aliases and a verified custom domain, and a browser's steps across them. */
const crossHost = async () => {
  const h = await signInHarness(runtime, { config: withHome })
  const press = async (origin: string, returnTo: string) => {
    const response = await h.at(`${origin}/api/auth/sign-in?return=${encodeURIComponent(returnTo)}`, {
      headers: { "sec-fetch-site": "same-origin" },
    })
    return { location: response.headers.get("location")!, cookies: values(response) }
  }
  /** Home's code for `origin`, with the person pressing Continue for a custom domain. */
  const handedOff = async (origin: string, returnTo: string, home: Record<string, string>) => {
    const pressed = await press(origin, returnTo)
    const first = await h.at(pressed.location, { headers: { cookie: cookie(home) } })
    const response = first.status === 200
      ? await h.at(`${HOME}/api/auth/handoff`, {
        method: "POST",
        body: new URLSearchParams({ request: new URL(pressed.location).searchParams.get("request")! }).toString(),
        headers: { "content-type": "application/x-www-form-urlencoded", cookie: cookie(home), origin: "null", "sec-fetch-site": "same-origin" },
      })
      : first
    expect(response.status).toBe(303)
    const code = new URLSearchParams(new URL(response.headers.get("location")!).hash.slice(1)).get("code")!
    return { pressed, code }
  }
  const arrive = (origin: string, body: string, headers: Record<string, string>) =>
    h.at(`${origin}/api/auth/arrive`, { method: "POST", body, headers: { "content-type": "application/x-www-form-urlencoded", ...headers } })
  const sessionAt = async (origin: string, cookies: Record<string, string>) =>
    (await (await h.at(`${origin}/api/auth/session`, { headers: { cookie: cookie(cookies) } })).json()) as SessionState
  return { ...h, press, handedOff, arrive, sessionAt }
}

const hostSessions = () =>
  sql((client) => client<{ host: string; revoked: boolean }>`SELECT host, revoked_at IS NOT NULL AS revoked FROM host_sessions ORDER BY created_at`)
const handoffCodes = async () => (await sql((client) => client`SELECT 1 FROM sign_in_handoffs`)).length
const personOf = (state: SessionState) => (state.signedIn ? state.personId : undefined)

test("an arrival signs the host in only with this browser's nonce, a live code for this host and a same-origin post", async () => {
  await sql((client) => client`TRUNCATE sessions, sign_in_attempts, people, domains CASCADE`)
  await customDomain()
  const h = await crossHost()
  const home = (await h.signInAs()).cookies
  const person = personOf(await h.sessionAt(HOME, home))
  expect(person).toEqual(expect.any(String))
  const scenarios = Arbitrary.schema(Schema.Struct({
    host: Schema.Literals(["alias", "custom"]),
    returnTo: Schema.Literals(["/acme/widgets/-/factory", "/acme"]),
    origin: Schema.Literals(["same", "null", "absent", "evil"]),
    site: Schema.Literals(["same-origin", "cross-site", "absent"]),
    nonce: Schema.Literals(["own", "missing", "forged", "another-press"]),
    code: Schema.Literals(["own", "missing", "unknown"]),
    elsewhere: Schema.Boolean,
    expired: Schema.Boolean,
    replay: Schema.Boolean,
  }))
  await property(scenarios, Math.min(requested, 60), async (s) => {
    await sql((client) => client`DELETE FROM host_sessions`)
    await sql((client) => client`DELETE FROM sign_in_handoffs`)
    const origin = s.host === "alias" ? ALIAS : CUSTOM
    const { pressed, code } = await h.handedOff(origin, s.returnTo, home)
    const target = s.elsewhere ? OTHER : origin
    const nonce: Record<string, string> = s.nonce === "own"
      ? pressed.cookies
      : s.nonce === "missing"
      ? {}
      : s.nonce === "forged"
      ? { smithers_handoff: forged(pressed.cookies["smithers_handoff"]!) }
      : (await h.press(origin, s.returnTo)).cookies
    if (s.expired) await sql((client) => client`UPDATE sign_in_handoffs SET expires_at = now() - interval '1 second'`)
    const body = s.code === "own" ? `code=${code}` : s.code === "unknown" ? `code=${"u".repeat(43)}` : ""
    const headers = {
      cookie: cookie(nonce),
      ...(s.origin === "absent" ? {} : { origin: s.origin === "same" ? target : s.origin === "null" ? "null" : "http://evil.test" }),
      ...(s.site === "absent" ? {} : { "sec-fetch-site": s.site }),
    }
    const fromHere = s.origin === "same" || (s.origin !== "evil" && s.site === "same-origin")
    const expected: { readonly reason: string; readonly location: string | null; readonly spent: boolean } = !fromHere
      ? { reason: "cross_site", location: null, spent: false }
      : s.code === "missing"
      ? { reason: "missing_code", location: "/?sign_in=failed", spent: false }
      : s.code === "unknown"
      ? { reason: "unknown_code", location: "/?sign_in=failed", spent: false }
      : s.elsewhere
      ? { reason: s.expired ? "expired" : "other_host", location: "/?sign_in=failed", spent: true }
      : s.expired
      ? { reason: "expired", location: `${s.returnTo}?sign_in=failed`, spent: true }
      : s.nonce === "missing" || s.nonce === "forged"
      ? { reason: "nonce_missing", location: `${s.returnTo}?sign_in=failed`, spent: true }
      : s.nonce === "another-press"
      ? { reason: "nonce_mismatch", location: `${s.returnTo}?sign_in=failed`, spent: true }
      : { reason: "signed_in", location: s.returnTo, spent: true }
    const counted = () =>
      expected.reason === "signed_in" ? h.count({ route: "arrive", outcome: "signed_in" }) : h.count({ route: "arrive", outcome: "failed", reason: expected.reason })
    const before = counted()
    const response = await h.arrive(target, body, headers)
    expect(counted() - before).toBe(1)
    expect(response.status).toBe(fromHere ? 303 : 403)
    expect(response.headers.get("location")).toBe(expected.location)
    expect(await handoffCodes()).toBe(expected.spent ? 0 : 1)
    const session = values(response)["smithers_session"]
    if (expected.reason === "signed_in") {
      expect(await hostSessions()).toEqual([{ host: new URL(origin).hostname, revoked: false }])
      expect(await h.sessionAt(origin, { smithers_session: session! })).toMatchObject({ signedIn: true, personId: person, login: "octocat" })
      // The host's session reads at its own host only, and is not home's cookie.
      expect(await h.sessionAt(OTHER, { smithers_session: session! })).toMatchObject({ signedIn: false })
      expect(session).not.toBe(home["smithers_session"])
    } else {
      expect(session).toBeUndefined()
      expect(await hostSessions()).toEqual([])
    }
    if (s.replay && expected.spent) {
      const rows = await hostSessions()
      const replayed = await h.arrive(origin, `code=${code}`, { cookie: cookie(pressed.cookies), origin })
      expect(replayed.status).toBe(303)
      expect(replayed.headers.get("location")).toBe("/?sign_in=failed")
      expect(values(replayed)["smithers_session"]).toBeUndefined()
      expect(await hostSessions()).toEqual(rows)
    }
    // Home stays signed in whatever an alias's arrival did.
    expect(personOf(await h.sessionAt(HOME, home))).toBe(person)
  })
})

test("sign-out ends exactly the presented session, only for a same-origin post from a page bound to its person", async () => {
  await sql((client) => client`TRUNCATE sessions, sign_in_attempts, people, domains CASCADE`)
  const h = await crossHost()
  const scenarios = Arbitrary.schema(Schema.Struct({
    where: Schema.Literals(["home", "alias"]),
    method: Schema.Literals(["POST", "POST", "POST", "GET"]),
    origin: Schema.Literals(["same", "absent", "evil"]),
    site: Schema.Literals(["same-origin", "cross-site", "absent"]),
    credential: Schema.Literals(["valid", "forged", "absent"]),
    device: Schema.Literals(["own", "another", "none", "absent"]),
  }))
  await property(scenarios, Math.min(requested, 40), async (s) => {
    await sql((client) => client`TRUNCATE sessions CASCADE`)
    const home = (await h.signInAs()).cookies
    const person = personOf(await h.sessionAt(HOME, home))!
    const [row] = await sql((client) => client<{ id: string }>`SELECT id::text AS id FROM sessions`)
    const at = s.where === "home" ? HOME : ALIAS
    let held = home
    if (s.where === "alias") {
      const { pressed, code } = await h.handedOff(ALIAS, "/acme", home)
      held = values(await h.arrive(ALIAS, `code=${code}`, { cookie: cookie(pressed.cookies), origin: ALIAS }))
      expect(personOf(await h.sessionAt(ALIAS, held))).toBe(person)
    }
    const presented = s.credential === "valid" ? held : s.credential === "forged" ? { smithers_session: forged(held["smithers_session"]!) } : undefined
    const device = s.device === "own" ? person : s.device === "another" ? crypto.randomUUID() : s.device === "none" ? NO_DEVICE_DATA : undefined
    const revocations = h.revocations.length
    const response = await h.at(`${at}/api/auth/sign-out`, {
      method: s.method,
      headers: {
        ...(s.origin === "absent" ? {} : { origin: s.origin === "same" ? at : "http://evil.test" }),
        ...(s.site === "absent" ? {} : { "sec-fetch-site": s.site }),
        ...(presented === undefined ? {} : { cookie: cookie(presented) }),
        ...(device === undefined ? {} : { [DEVICE_PERSON_HEADER]: device }),
      },
    })
    const fromHere = s.origin === "same" || (s.origin === "absent" && s.site === "same-origin")
    const bindingChecked = device !== NO_DEVICE_DATA && (device !== undefined || presented !== undefined)
    const unbound = bindingChecked && s.credential === "valid" && device !== person
    const status = s.method === "GET" ? 405 : !fromHere || unbound ? 403 : 204
    const ends = status === 204 && s.credential === "valid"
    expect(response.status).toBe(status)
    if (status === 204) expect(setCookies(response)["smithers_session"]!.line).toMatch(/Max-Age=0/)
    else expect(response.headers.get("set-cookie")).toBeNull()
    const homeLive = !(ends && s.where === "home")
    expect((await h.sessionAt(HOME, home)).signedIn).toBe(homeLive)
    expect(await sql((client) => client<{ ended: boolean; reason: string | null }>`
      SELECT revoked_at IS NOT NULL AS ended, revoked_reason AS reason FROM sessions`)).toEqual([
      { ended: !homeLive, reason: homeLive ? null : "sign_out" },
    ])
    // Only a home session holds GitHub tokens: ending it starts their revocation, once; an alias's ends alone.
    expect(h.revocations.slice(revocations)).toEqual(homeLive ? [] : [row!.id])
    if (s.where === "alias") {
      expect(await hostSessions()).toEqual([{ host: "factory.test", revoked: ends }])
      expect((await h.sessionAt(ALIAS, held)).signedIn).toBe(!ends)
    }
  })
})

test("SessionStore takes an attempt and a hand-off once, and a host session lives only under a live home session", async () => {
  await sql((client) => client`TRUNCATE sessions, sign_in_attempts, people, domains CASCADE`)
  const h = await signInHarness(runtime)
  const scenarios = Arbitrary.schema(Schema.Struct({
    returnTo: Schema.Literals(["/app", "/acme/widgets?tab=stack", "/"]),
    attemptExpired: Schema.Boolean,
    handoffExpired: Schema.Boolean,
    host: Schema.Literals(["factory.test", "custom.test"]),
    parent: Schema.Literals(["live", "ended-before", "ended-after"]),
    aliasSignsOut: Schema.Boolean,
  }))
  await property(scenarios, Math.min(requested, 60), async (s) => {
    await sql((client) => client`TRUNCATE sessions, sign_in_attempts CASCADE`)
    await h.signInAs()
    const [session] = await sql((client) => client<{ id: string; person: string }>`SELECT id::text AS id, person_id::text AS person FROM sessions`)
    const id = session!.id

    const stateDigest = SessionKeys.digest(crypto.randomUUID())
    const verifier = { ciphertext: crypto.randomUUID(), nonce: crypto.randomUUID() }
    const redirectUri = `http://smithers.test/api/auth/callback?${crypto.randomUUID()}`
    await run(SessionStore.beginAttempt({ stateDigest, verifier, redirectUri, returnTo: s.returnTo, ttlSeconds: 600 }))
    if (s.attemptExpired) await sql((client) => client`UPDATE sign_in_attempts SET expires_at = now() - interval '1 second'`)
    expect(await run(SessionStore.takeAttempt(SessionKeys.digest("another state")))).toEqual(Option.none())
    expect(await run(SessionStore.takeAttempt(stateDigest))).toEqual(
      Option.some({ verifier, redirectUri, returnTo: s.returnTo, live: !s.attemptExpired }),
    )
    expect(await run(SessionStore.takeAttempt(stateDigest))).toEqual(Option.none())
    expect(await sql((client) => client`SELECT 1 FROM sign_in_attempts`)).toEqual([])

    const codeDigest = SessionKeys.digest(crypto.randomUUID())
    const nonceDigest = SessionKeys.digest(crypto.randomUUID())
    await run(SessionStore.beginHandoff({ codeDigest, sessionId: id, host: s.host, nonceDigest, returnTo: s.returnTo, ttlSeconds: 60 }))
    if (s.handoffExpired) await sql((client) => client`UPDATE sign_in_handoffs SET expires_at = now() - interval '1 second'`)
    expect(await run(SessionStore.takeHandoff(nonceDigest))).toEqual(Option.none())
    expect(await run(SessionStore.takeHandoff(codeDigest))).toEqual(
      Option.some({ sessionId: id, host: s.host, nonceDigest, returnTo: s.returnTo, live: !s.handoffExpired }),
    )
    expect(await run(SessionStore.takeHandoff(codeDigest))).toEqual(Option.none())

    if (s.parent === "ended-before") await run(SessionStore.revoke({ id }, "sign_out"))
    const tokenDigest = SessionKeys.digest(crypto.randomUUID())
    const created = await run(SessionStore.createHostSession({ id: crypto.randomUUID(), tokenDigest, parentId: id, host: s.host }))
    expect(created).toBe(s.parent !== "ended-before")
    expect(await hostSessions()).toEqual(created ? [{ host: s.host, revoked: false }] : [])
    if (s.parent === "ended-after") await run(SessionStore.revoke({ id }, "sign_out"))
    const parentLive = s.parent === "live"
    const ended = parentLive && s.aliasSignsOut ? await run(SessionStore.revokeHost(tokenDigest, s.host)) : Option.none<string>()
    if (parentLive && s.aliasSignsOut) {
      expect(Option.isSome(ended)).toBe(true)
      // Ended once: a second sign-out there ends nothing.
      expect(await run(SessionStore.revokeHost(tokenDigest, s.host))).toEqual(Option.none())
    }
    const hostLive = parentLive && !s.aliasSignsOut
    const found = await run(SessionStore.findHostLive(tokenDigest, s.host))
    expect(Option.getOrUndefined(Option.map(found, (live) => ({ personId: live.personId, login: live.login, home: live.home })))).toEqual(
      hostLive ? { personId: session!.person, login: "octocat", home: id } : undefined,
    )
    // The same token at another host, or another token at this one, is nobody.
    expect(await run(SessionStore.findHostLive(tokenDigest, "other.test"))).toEqual(Option.none())
    expect(await run(SessionStore.findHostLive(SessionKeys.digest("another token"), s.host))).toEqual(Option.none())
    expect(Option.getOrUndefined(Option.map(await run(SessionStore.findLiveById(id)), (live) => live.personId))).toBe(
      parentLive ? session!.person : undefined,
    )
    expect(await sql((client) => client<{ reason: string | null }>`SELECT revoked_reason AS reason FROM sessions`)).toEqual([
      { reason: parentLive ? null : "sign_out" },
    ])
    expect(await hostSessions()).toEqual(created ? [{ host: s.host, revoked: !hostLive }] : [])
  })
})

test("a replaced token pair is revoked at GitHub and its row finished once, and kept sealed through every failure", async () => {
  const scenarios = Arbitrary.schema(Schema.Struct({
    fault: Schema.Literals(["none", "none", "unavailable", "misconfigured"]),
    key: Schema.Literals(["pinned", "pinned", "another"]),
    goneAtGitHub: Schema.Boolean,
    aged: Schema.Boolean,
  }))
  const database = (await runtime.runPromise(TestDatabase.Scratch)).database
  const pinned = await runtime.runPromise(SessionKeys.make(Redacted.make(SECRET)))
  const another = await runtime.runPromise(SessionKeys.make(Redacted.make("another-secret".padEnd(64, "4"))))
  await property(scenarios, Math.min(requested, 25), async (s) => {
    await sql((client) => client`TRUNCATE sessions, sign_in_attempts, people, github_token_cleanups CASCADE`)
    const h = await signInHarness(runtime)
    // Signing in again from a signed-in browser replaces its token pair: the first pair waits in a cleanup row.
    const first = await h.signInAs()
    const started = await h.start()
    await h.callback(h.github.approve(started.location), { ...first.cookies, smithers_sign_in: started.cookies["smithers_sign_in"]!.value })
    const rows = await sql((client) => client<{ id: string }>`SELECT id FROM github_token_cleanups`)
    expect(rows).toHaveLength(1)
    const id = rows[0]!.id
    const [replaced, current] = h.github.issued
    if (s.aged) await sql((client) => client`UPDATE github_token_cleanups SET created_at = now() - interval '6 minutes'`)
    if (s.goneAtGitHub) h.github.revoke(replaced!.accessToken)
    if (s.fault !== "none") h.github.faults.revoke = s.fault
    const services = { keys: s.key === "pinned" ? pinned : another, github: h.github.service }
    const revokes = () => h.github.calls.filter((call) => call === "revoke").length
    const row = async () =>
      (await sql((client) => client<{ finished: boolean; sealed: boolean; digest: boolean }>`
        SELECT finished_at IS NOT NULL AS finished, sealed_access IS NOT NULL AS sealed, pair_digest IS NOT NULL AS digest
        FROM github_token_cleanups WHERE id = ${id}`))[0]

    const exit = await runtime.runPromiseExit(Cleanup.revoke(id, services).pipe(Effect.provide(database)))
    const revoked = s.key === "pinned" && s.fault === "none"
    if (revoked) {
      expect(exit).toEqual(Exit.succeed({ outcome: "revoked" }))
    } else {
      expect(Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined).toMatchObject(
        s.key === "another" ? { _tag: "GitHubTokenCleanupFailed", reason: "unreadable" } : { step: "revoke", reason: s.fault },
      )
    }
    // An unreadable seal never reaches GitHub.
    expect(revokes()).toBe(s.key === "pinned" ? 1 : 0)
    expect(await row()).toEqual({ finished: revoked, sealed: !revoked, digest: true })
    expect(h.github.accepts(replaced!.accessToken)).toBe(!revoked && !s.goneAtGitHub)
    expect(h.github.accepts(current!.accessToken)).toBe(true)
    // The sweeper restarts only an aged row still waiting; cleanup never ends the session.
    expect(await run(Cleanup.sweep())).toEqual(s.aged && !revoked ? [id] : [])
    expect(await h.session(first.cookies)).toMatchObject({ signedIn: true, login: "octocat" })

    // Recovery: the pinned key and a healthy GitHub finish it once; after that there is nothing to do.
    delete h.github.faults.revoke
    const recovered = await run(Cleanup.revoke(id, { keys: pinned, github: h.github.service }))
    expect(recovered).toEqual({ outcome: revoked ? "none" : "revoked" })
    expect(revokes()).toBe(revoked || s.key === "pinned" ? (revoked ? 1 : 2) : 1)
    expect(await row()).toEqual({ finished: true, sealed: false, digest: true })
    expect(h.github.accepts(replaced!.accessToken)).toBe(false)
    expect(await run(Cleanup.revoke(id, { keys: pinned, github: h.github.service }))).toEqual({ outcome: "none" })
    expect(await run(Cleanup.sweep())).toEqual([])
  })
})

const GOOD = "g".repeat(SessionKeys.MIN_SECRET_LENGTH)
const SHORT = "s".repeat(SessionKeys.MIN_SECRET_LENGTH - 1)

test("sign-in is configured only by a client, a long enough signing secret and a long enough sealing secret", async () => {
  const github = scriptedGitHub()
  const secret = Schema.Literals(["absent", "short", "good"])
  const scenarios = Arbitrary.schema(Schema.Struct({
    clientId: Schema.Literals([true, true, true, false]),
    clientSecret: Schema.Literals([true, true, true, false]),
    secret,
    sealSecret: secret,
    secrets: Schema.Literals(["absent", "valid", "valid", "not-json", "short-value", "same-secret-twice", "empty"]),
    days: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 400 })),
    minutes: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 600 })),
    repository: Schema.Literals(["acme/widgets", "octo/hello.world"]),
  }))
  const lengthOf = (kind: typeof secret.Type) => (kind === "good" ? GOOD : SHORT)
  // No database: enough scenarios to reach the rare ones, as signing secrets with no sealing secret at all.
  await property(scenarios, Math.max(requested, 400), async (s) => {
    const encoded = {
      valid: JSON.stringify({ k1: "1".repeat(40), k2: "2".repeat(40) }),
      "not-json": "{k1",
      "short-value": JSON.stringify({ k1: SHORT }),
      "same-secret-twice": JSON.stringify({ k1: GOOD, k2: GOOD }),
      empty: "{}",
    }
    const env: Record<string, string> = {
      ...(s.clientId ? { GITHUB_APP_CLIENT_ID: "Iv1.scripted" } : {}),
      ...(s.clientSecret ? { GITHUB_APP_CLIENT_SECRET: "client-secret" } : {}),
      ...(s.secret === "absent" ? {} : { SESSION_SECRET: lengthOf(s.secret) }),
      ...(s.sealSecret === "absent" ? {} : { SESSION_SEAL_SECRET: lengthOf(s.sealSecret) }),
      ...(s.secrets === "absent" ? {} : { SESSION_SECRETS: encoded[s.secrets] }),
      SESSION_MAX_AGE_DAYS: String(s.days),
      ROLE_RECHECK_MINUTES: String(s.minutes),
      GITHUB_REPOSITORY: s.repository,
    }
    const sealing = s.sealSecret === "absent" ? s.secret : s.sealSecret
    const on = s.clientId && s.clientSecret && (s.secret !== "absent" || s.secrets !== "absent") && s.secret !== "short" &&
      sealing === "good" && (s.secrets === "absent" || s.secrets === "valid")
    const found = await Effect.runPromise(
      SignIn.configured(github.service).pipe(
        Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(env)),
        Effect.provide(FetchHttpClient.layer),
      ),
    )
    expect(Option.isSome(found)).toBe(on)
    if (Option.isSome(found)) {
      expect({ ...found.value, keys: [...found.value.keys.keyIds].sort() }).toEqual({
        keys: s.secrets === "valid" ? ["k1", "k2"] : ["legacy"],
        github: github.service,
        repository: s.repository,
        maxAgeSeconds: s.days * 86_400,
        recheckAfterMs: s.minutes * 60_000,
      })
      // The keys are usable: what they sign for one purpose verifies for that purpose only.
      const signed = await Effect.runPromise(found.value.keys.sign("session", "token"))
      expect(Option.map(await Effect.runPromise(found.value.keys.verify("session", signed)), (verified) => verified.value)).toEqual(Option.some("token"))
      expect(await Effect.runPromise(found.value.keys.verify("handoff", signed))).toEqual(Option.none())
    }
  })
})

const person = (id: string, role: "admin" | "member"): SignIn.Signed => {
  const actor: Actor = { subject: { kind: "person", id }, role }
  return { actor, login: id }
}

test("without the GitHub App, local development's cookies name who is signed in, and only they sign themselves out", async () => {
  const developer = person("local-developer", "admin")
  const teammate = person("local-teammate", "member")
  const newcomer = (name: string) => (name.startsWith("new-") ? person(name, "member") : undefined)
  const withDeveloper = await signInHarness(runtime, { config: {}, fallback: developer, teammates: { teammate }, newcomer })
  const alone = await signInHarness(runtime, { config: {}, teammates: { teammate }, newcomer })
  const scenarios = Arbitrary.schema(Schema.Struct({
    developer: Schema.Boolean,
    named: Schema.Literals(["nobody", "teammate", "new-hire", "stranger", "toString"]),
    signedOut: Schema.Boolean,
    origin: Schema.Literals(["same", "same", "evil"]),
    device: Schema.Literals(["own", "another", "none", "absent"]),
    returnTo: Schema.Literals(["/app?tab=1", "/acme/widgets"]),
  }))
  await property(scenarios, requested, async (s) => {
    const dev = s.developer ? withDeveloper : alone
    const cookies: Record<string, string> = {
      ...(s.named === "nobody" ? {} : { smithers_dev_person: s.named }),
      ...(s.signedOut ? { smithers_dev_signed_out: "1" } : {}),
    }
    // Without a developer nobody is signed in; with one, the cookie names a teammate or a newcomer, else the developer.
    const who = !s.developer || s.signedOut
      ? undefined
      : s.named === "teammate"
      ? teammate
      : s.named === "new-hire"
      ? person("new-hire", "member")
      : developer
    const state = await dev.session(cookies)
    if (who === undefined) expect(state).toEqual({ signedIn: false, available: s.developer, hostedModel: false })
    else expect(state).toMatchObject({ signedIn: true, personId: who.actor.subject.id, login: who.login, role: who.actor.role })

    const pressed = await dev.fetch(`/api/auth/sign-in?return=${encodeURIComponent(s.returnTo)}`, { headers: { cookie: cookie(cookies) } })
    if (s.developer) {
      expect(pressed.status).toBe(303)
      expect(pressed.headers.get("location")).toBe(s.returnTo)
      expect(setCookies(pressed)["smithers_dev_signed_out"]!.line).toMatch(/Max-Age=0/)
    } else {
      expect(pressed.status).toBe(503)
      expect(await pressed.json()).toEqual({ code: "not_configured" })
    }

    const device = s.device === "own" ? who?.actor.subject.id ?? "local-developer" : s.device === "another" ? "someone-else" : s.device === "none" ? NO_DEVICE_DATA : undefined
    const hasCookie = Object.keys(cookies).length > 0
    const out = await dev.fetch("/api/auth/sign-out", {
      method: "POST",
      headers: {
        origin: s.origin === "same" ? "http://smithers.test" : "http://evil.test",
        ...(hasCookie ? { cookie: cookie(cookies) } : {}),
        ...(device === undefined ? {} : { [DEVICE_PERSON_HEADER]: device }),
      },
    })
    const bindingChecked = device !== NO_DEVICE_DATA && (device !== undefined || hasCookie)
    const unbound = bindingChecked && who !== undefined && device !== who.actor.subject.id
    const status = s.origin === "evil" || unbound ? 403 : 204
    expect(out.status).toBe(status)
    const marker = setCookies(out)["smithers_dev_signed_out"]
    expect(marker?.value).toBe(status === 204 && s.developer ? "1" : undefined)
    if (marker !== undefined) {
      expect(await dev.session({ ...cookies, smithers_dev_signed_out: marker.value })).toEqual({ signedIn: false, available: true, hostedModel: false })
    }
    expect(dev.github.calls).toEqual([])
    expect(dev.revocations).toEqual([])
  })
})

test("a cleanup and session maintenance start under their own ids, absorb a repeated start, and count what the host refused", async () => {
  const report = await runtime.runPromise(Fuzz.run(
    Arbitrary.schema(Schema.Struct({
      host: Schema.Literals(["absent", "takes", "conflict", "unavailable"]),
      githubId: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 2_000_000_000 })),
    })),
    (s) =>
      Effect.gen(function* () {
        const registry: Metric.MetricRegistry = new Map()
        const counted = (metric: Metric.Metric<number, Metric.CounterState<number>>, outcome: string) =>
          Metric.value(Metric.withAttributes(metric, { outcome })).pipe(
            Effect.provideService(Metric.MetricRegistry, registry),
            Effect.map((state) => state.count),
          )
        const started: Array<{ readonly flow: string; readonly executionId: string; readonly payload: unknown }> = []
        const starter = Flows.FlowStarter.of({
          start: (flow, options) =>
            Effect.suspend((): Effect.Effect<void, Flows.StartConflict | Flows.StartUnavailable> => {
              started.push({ flow: flow._tag, ...options })
              return s.host === "conflict"
                ? Effect.fail(new Flows.StartConflict())
                : s.host === "unavailable"
                ? Effect.fail(new Flows.StartUnavailable({ errorCode: "down" }))
                : Effect.void
            }),
        })

        // A cleanup's start never fails its caller: the durable row is the request, and a refused start is counted.
        const id = crypto.randomUUID()
        const start = Cleanup.start(id).pipe(Effect.provideService(Metric.MetricRegistry, registry))
        yield* s.host === "absent" ? start : Effect.provideService(start, Flows.FlowStarter, starter)
        expect(started).toEqual(s.host === "absent" ? [] : [
          { flow: "auth/RevokeReplacedGitHubToken", executionId: `cleanup:${id}`, payload: { cleanupId: id } },
        ])
        expect(yield* counted(Cleanup.cleanups, "retried")).toBe(s.host === "absent" || s.host === "unavailable" ? 1 : 0)

        if (s.host !== "absent") {
          const ensured = yield* Effect.exit(Cleanup.ensure.pipe(
            Effect.provideService(Flows.FlowStarter, starter),
            Effect.provideService(Metric.MetricRegistry, registry),
          ))
          expect(started[1]).toEqual({ flow: "auth/MaintainSessions", executionId: "auth:session-maintenance:v1", payload: {} })
          expect(Exit.isSuccess(ensured) ? "admitted" : Option.getOrUndefined(Exit.findErrorOption(ensured))?._tag).toBe(
            s.host === "unavailable" ? "@smthrs/mvp/flows/StartUnavailable" : "admitted",
          )
          expect([yield* counted(Cleanup.maintenance, "admitted"), yield* counted(Cleanup.maintenance, "unavailable")]).toEqual(
            s.host === "unavailable" ? [0, 1] : [1, 0],
          )
        }

        // A person's GitHub id reads back from their row; a second sign-in under that id keeps the first row.
        const sql = yield* SqlClient.SqlClient
        yield* sql`DELETE FROM people WHERE github_id = ${s.githubId}`
        const [first, second, nobody] = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()]
        expect(yield* SessionStore.upsertPerson({ id: first, githubId: s.githubId, login: "first" })).toBe(first)
        expect(yield* SessionStore.upsertPerson({ id: second, githubId: s.githubId, login: "renamed" })).toBe(first)
        expect(yield* SessionStore.githubIdOf(first)).toBe(s.githubId)
        expect(yield* SessionStore.githubIdOf(second)).toBeUndefined()
        expect(yield* SessionStore.githubIdOf(nobody)).toBeUndefined()
        expect(yield* sql`SELECT id::text AS id, github_login AS login FROM people WHERE github_id = ${s.githubId}`).toEqual([
          { id: first, login: "renamed" },
        ])
        return true
      }),
    { seed, executions: requested },
  ))
  expect(Fuzz.formatReport(report)).toBeUndefined()
})

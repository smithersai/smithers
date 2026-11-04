import { readFileSync } from "node:fs"
import { ConfigProvider, Effect, Exit, Layer, Option, Redacted } from "effect"
import { FetchHttpClient, HttpEffect, HttpServerRequest, HttpServerResponse } from "effect/http"
import { SqlClient } from "effect/sql"
import { beforeEach, expect, test } from "vitest"
import { ACCEPTS_HEADER, ACCEPTS_CREDENTIAL_STALE } from "../src/features/auth/contract.ts"
import { Sessions } from "./Actor.ts"
import * as Keys from "./SessionKeys.ts"
import * as Store from "./SessionStore.ts"
import * as Rotation from "./SessionSigningKeys.ts"
import * as SignIn from "./SignIn.ts"
import { testFile } from "./test/harness.ts"
import { configured, cookie, SECRET, setCookies, signInHarness } from "./test/signIn.ts"

const runtime = testFile("signing_keys")
const query = <A extends object>(f: (sql: SqlClient.SqlClient) => Effect.Effect<ReadonlyArray<A>, unknown>) =>
  runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, f))
const NEXT = "next-signing-secret-".padEnd(64, "9")
const secrets = { legacy: SECRET, next: NEXT }
const config = { ...configured, SESSION_SECRETS: JSON.stringify(secrets), SESSION_SEAL_SECRET: SECRET }
const makeKeys = () => runtime.runPromise(Keys.make(Redacted.make(SECRET), {
  secrets: Object.fromEntries(Object.entries(secrets).map(([id, value]) => [id, Redacted.make(value)])),
  sealSecret: Redacted.make(SECRET),
}))
beforeEach(async () => {
  await query(sql => sql`TRUNCATE sessions, sign_in_attempts, people CASCADE`)
  await query(sql => sql`DELETE FROM session_signing_keys`)
  const legacyFingerprint = await runtime.runPromise(Rotation.fingerprint(Redacted.make(SECRET)))
  await query(sql => sql`INSERT INTO session_signing_keys (key_id, state, promoted_at, fingerprint) VALUES ('legacy', 'issuer', now(), ${legacyFingerprint})`)
  const sealFingerprint = await runtime.runPromise(Rotation.sealFingerprint(Redacted.make(SECRET)))
  await query(sql => sql`UPDATE session_seal_key SET fingerprint = ${sealFingerprint} WHERE id`)
})


test("the insert chooses the durable issuer and signs the cookie with that recorded key", async () => {
  await runtime.runPromise(Rotation.stage("next", Redacted.make(NEXT)))
  await runtime.runPromise(Rotation.promote("next"))
  const h = await signInHarness(runtime, { config })
  const signed = await h.signInAs()
  expect(signed.response.status).toBe(303)
  const [row] = await query(sql => sql<{ key: string }>`SELECT cookie_key AS key FROM sessions`)
  expect(row!.key).toBe("next")
  const keys = await makeKeys()
  expect((await runtime.runPromise(keys.verify("session", signed.cookies.smithers_session!))).pipe(Option.map(v => v.keyId))).toEqual(Option.some("next"))
})

test("an issuer absent from a Worker's configuration fails issuance closed", async () => {
  const h = await signInHarness(runtime)
  const started = await h.start()
  const { code, state } = h.github.approve(started.location)
  await runtime.runPromise(Rotation.stage("next", Redacted.make(NEXT)))
  await runtime.runPromise(Rotation.promote("next"))
  const response = await h.callback({ code, state }, { smithers_sign_in: started.cookies.smithers_sign_in!.value })
  expect(setCookies(response).smithers_session).toBeUndefined()
  expect(await query(sql => sql`SELECT id FROM sessions`)).toEqual([])
  expect(h.snapshot().some(entry => entry.id === "smithers_auth_issue" && entry.attributes?.outcome === "issuer_unconfigured")).toBe(true)
})

test("a re-stamped live row answers only credential stale, never an identity or a renewal", async () => {
  const h = await signInHarness(runtime, { config })
  const signed = await h.signInAs()
  await runtime.runPromise(Rotation.stage("next", Redacted.make(NEXT)))
  await runtime.runPromise(Rotation.promote("next"))
  await query(sql => sql`UPDATE sessions SET cookie_key = 'next', expires_at = now() + interval '20 days'`)
  const [before] = await query(sql => sql<{ expiry: string }>`SELECT expires_at::text AS expiry FROM sessions`)
  expect(await h.session(signed.cookies)).toEqual({ credential: "stale" })
  const [after] = await query(sql => sql<{ expiry: string }>`SELECT expires_at::text AS expiry FROM sessions`)
  expect(after).toEqual(before)
  const keys = await makeKeys()
  // Stale is a liveness diagnostic even when this Worker has not received the row's new key yet.
  await query(sql => sql`UPDATE sessions SET cookie_key = 'not-configured'`)
  expect(await h.session(signed.cookies)).toEqual({ credential: "stale" })
  await query(sql => sql`UPDATE sessions SET cookie_key = 'next'`)
  const current = await runtime.runPromise(keys.sign("session", signed.cookies.smithers_session!.split(".")[0]!, "next"))
  expect(await h.session({ smithers_session: current })).toMatchObject({ signedIn: true })
  const dropped = await signInHarness(runtime, { config: { ...config, SESSION_SECRETS: JSON.stringify({ next: NEXT }) } })
  expect(await dropped.session(signed.cookies)).toMatchObject({ signedIn: false })
  await query(sql => sql`UPDATE sessions SET revoked_at = now()`)
  expect(await h.session(signed.cookies)).toMatchObject({ signedIn: false })
})

test.each([undefined, "unknown", ACCEPTS_CREDENTIAL_STALE])("a stale cookie authenticates no route with accepts %s and the response carries the stale header", async accepts => {
  const h = await signInHarness(runtime, { config })
  const signed = await h.signInAs()
  await runtime.runPromise(Rotation.stage("next", Redacted.make(NEXT)))
  await runtime.runPromise(Rotation.promote("next"))
  await query(sql => sql`UPDATE sessions SET cookie_key = 'next'`)
  const effect = h.signIn.guard(HttpServerResponse.json({ private: true }))
  const handler = HttpEffect.toWebHandler(effect.pipe(Effect.provide(h.services)))
  const response = await handler(new Request("http://smithers.test/api/private", { headers: {
    cookie: cookie(signed.cookies), ...(accepts === undefined ? {} : { [ACCEPTS_HEADER]: accepts }),
  } }))
  expect(response.status).toBe(accepts === ACCEPTS_CREDENTIAL_STALE ? 503 : 401)
  expect(response.headers.get("x-smithers-credential")).toBe("stale")
  expect(response.headers.get("retry-after")).toBe(accepts === ACCEPTS_CREDENTIAL_STALE ? "1" : null)
  expect(response.headers.get("cache-control")).toContain("no-store")
  expect(await response.text()).not.toContain("private")
})

test("a copied or delayed callback cookie cannot authenticate beyond the server deadline", async () => {
  const h = await signInHarness(runtime, { config })
  const signed = await h.signInAs()
  await runtime.runPromise(Rotation.stage("next", Redacted.make(NEXT)))
  await runtime.runPromise(Rotation.promote("next"))
  await runtime.runPromise(Rotation.cease("legacy"))
  expect(await h.session(signed.cookies)).toMatchObject({ signedIn: true })
  await query(sql => sql`UPDATE sessions SET started_at = now() - interval '401 days', expires_at = now() + interval '30 days'`)
  h.advance(-2 * 366 * 86400000)
  expect(await h.session(signed.cookies)).toMatchObject({ signedIn: false })
})

test("the deploy gate checks retired rows too and never substitutes a machine clock", async () => {
  await runtime.runPromise(Rotation.stage("next", Redacted.make(NEXT)))
  await runtime.runPromise(Rotation.promote("next"))
  const gate = () => runtime.runPromise(Effect.exit(Rotation.gate({ next: Redacted.make(NEXT) }, Redacted.make(SECRET))))
  expect(Exit.isFailure(await gate())).toBe(true)
  await query(sql => sql`UPDATE session_signing_keys SET state = 'retired' WHERE key_id = 'legacy'`)
  expect(Exit.isFailure(await gate())).toBe(true)
  await query(sql => sql`UPDATE session_signing_keys SET ceased_at = now() - interval '400 days' WHERE key_id = 'legacy'`)
  expect(Exit.isFailure(await gate())).toBe(true)
  const boundary = (seconds: number) => runtime.runPromise(Effect.exit(Effect.flatMap(SqlClient.SqlClient, sql =>
    sql.withTransaction(Effect.gen(function* () {
      yield* sql`UPDATE session_signing_keys SET ceased_at = now() - interval '401 days' + make_interval(secs => ${seconds}) WHERE key_id = 'legacy'`
      yield* Rotation.gate({ next: Redacted.make(NEXT) }, Redacted.make(SECRET))
    })))))
  expect(Exit.isFailure(await boundary(1))).toBe(true)
  expect(Exit.isFailure(await boundary(0))).toBe(true)
  expect(Exit.isSuccess(await boundary(-1))).toBe(true)
  expect(Exit.isFailure(await runtime.runPromise(Effect.exit(Rotation.gate({ legacy: Redacted.make(SECRET) }, Redacted.make(SECRET)))))).toBe(true)
})

test("promotion and cessation are separate, idempotent commits, and two rotations retain both verifiers", async () => {
  for (const key of ["next", "third"]) {
    await runtime.runPromise(Rotation.stage(key, Redacted.make(key === "next" ? NEXT : "third-key".padEnd(64, "3"))))
    const pending = await runtime.runPromise(Rotation.promote(key))
    expect(pending).toContain(key === "next" ? "legacy" : "next")
    for (const old of pending) await runtime.runPromise(Rotation.cease(old))
    for (const old of pending) await runtime.runPromise(Rotation.cease(old))
  }
  const rows = await query(sql => sql<{ id: string; state: string; ceased: boolean }>`SELECT key_id AS id, state, ceased_at IS NOT NULL AS ceased FROM session_signing_keys ORDER BY key_id`)
  expect(rows).toEqual([{ id: "legacy", state: "verifier", ceased: true }, { id: "next", state: "verifier", ceased: true }, { id: "third", state: "issuer", ceased: false }])
  expect(Exit.isFailure(await runtime.runPromise(Effect.exit(Rotation.promote("legacy"))))).toBe(true)
})

test("Alchemy's publication depends on the database key gate and binds the key map and pinned seal", () => {
  const stack = readFileSync(new URL("../alchemy.run.ts", import.meta.url), "utf8")
  expect(stack).toContain("SessionSigningKeyGate")
  const binding = readFileSync(new URL("../infra/SignIn.ts", import.meta.url), "utf8")
  expect(binding).toContain('"SESSION_SECRETS"')
  expect(binding).toContain('"SESSION_SEAL_SECRET"')
  expect(stack).toContain("sealSecret: configuredSealSecret")
  expect(binding).toContain("signing.value.seal")
  const gate = readFileSync(new URL("../infra/SessionSigningKeyGate.ts", import.meta.url), "utf8")
  expect(gate).toContain("SigningKeys.gate(keys.value, input.sealSecret)")
})

const barrier = () => {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

const pauseInsert = async (pattern: string) => {
  const scratch = await runtime.runPromise((await import("../db/TestDatabase.ts")).Scratch)
  const entered = barrier()
  const release = barrier()
  const database = Layer.effect(SqlClient.SqlClient, Effect.map(SqlClient.SqlClient, real => new Proxy(real, {
    apply(target, receiver, args) {
      const statement = Reflect.apply(target, receiver, args)
      return String(args[0]).includes(pattern)
        ? Effect.andThen(Effect.sync(entered.resolve), Effect.andThen(Effect.promise(() => release.promise), statement))
        : statement
    },
  }))).pipe(Layer.provide(scratch.database))
  return { database, entered, release }
}

test("a callback paused before insertion across promotion records and signs the new issuer", async () => {
  const pause = await pauseInsert("INSERT INTO sessions")
  await runtime.runPromise(Rotation.stage("next", Redacted.make(NEXT)))
  const h = await signInHarness(runtime, { config, database: pause.database })
  const pending = h.signInAs()
  try {
    await pause.entered.promise
    await runtime.runPromise(Rotation.promote("next"))
  } finally { pause.release.resolve() }
  const signed = await pending
  expect(signed.response.status).toBe(303)
  const [row] = await query(sql => sql<{ key: string }>`SELECT cookie_key AS key FROM sessions`)
  expect(row!.key).toBe("next")
  const keys = await makeKeys()
  expect(Option.getOrThrow(await runtime.runPromise(keys.verify("session", signed.cookies.smithers_session!))).keyId).toBe("next")
})

test("an alias arrival paused before insertion across promotion records and signs the new issuer", async () => {
  const pause = await pauseInsert("INSERT INTO host_sessions")
  const h = await signInHarness(runtime, { config: { ...config, APP_DOMAIN: "smithers.test", APP_ALIASES: "alias.test=/" }, database: pause.database })
  const home = await h.signInAs()
  const pressed = await h.at("http://alias.test/api/auth/sign-in", { headers: { "sec-fetch-site": "same-origin" } })
  const handed = await h.at(pressed.headers.get("location")!, { headers: { cookie: cookie(home.cookies) } })
  const code = new URLSearchParams(new URL(handed.headers.get("location")!).hash.slice(1)).get("code")!
  const nonce = setCookies(pressed).smithers_handoff!.value
  await runtime.runPromise(Rotation.stage("next", Redacted.make(NEXT)))
  const pending = h.at("http://alias.test/api/auth/arrive", { method: "POST", body: new URLSearchParams({ code }).toString(),
    headers: { origin: "http://alias.test", "content-type": "application/x-www-form-urlencoded", cookie: cookie({ smithers_handoff: nonce }) } })
  try {
    await pause.entered.promise
    await runtime.runPromise(Rotation.promote("next"))
  } finally { pause.release.resolve() }
  const arrived = await pending
  expect(arrived.status).toBe(303)
  const [row] = await query(sql => sql<{ key: string }>`SELECT cookie_key AS key FROM host_sessions`)
  expect(row!.key).toBe("next")
  const keys = await makeKeys()
  expect(Option.getOrThrow(await runtime.runPromise(keys.verify("session", setCookies(arrived).smithers_session!.value))).keyId).toBe("next")
  await query(sql => sql`UPDATE host_sessions SET cookie_key = 'not-configured'`)
  const stale = await h.at("http://alias.test/api/auth/session", { headers: { cookie: cookie({ smithers_session: setCookies(arrived).smithers_session!.value }) } })
  expect(await stale.json()).toEqual({ credential: "stale" })
  await query(sql => sql`UPDATE host_sessions SET revoked_at = now()`)
  const ended = await h.at("http://alias.test/api/auth/session", { headers: { cookie: cookie({ smithers_session: setCookies(arrived).smithers_session!.value }) } })
  expect(await ended.json()).toMatchObject({ signedIn: false })
})

test("a stalled promotion allows old-key issuance, and cessation is sampled only after its commit", async () => {
  const entered = barrier()
  const release = barrier()
  await runtime.runPromise(Rotation.stage("next", Redacted.make(NEXT)))
  const promoting = runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, sql => sql.withTransaction(Effect.gen(function* () {
    yield* Rotation.promote("next")
    entered.resolve()
    yield* Effect.promise(() => release.promise)
  }))))
  try {
    await entered.promise
    const h = await signInHarness(runtime, { config })
    const signed = await h.signInAs()
    expect(signed.response.status).toBe(303)
    const [row] = await query(sql => sql<{ key: string }>`SELECT cookie_key AS key FROM sessions`)
    expect(row!.key).toBe("legacy")
  } finally { release.resolve() }
  await promoting
  const [before] = await query(sql => sql<{ absent: boolean }>`SELECT ceased_at IS NULL AS absent FROM session_signing_keys WHERE key_id = 'legacy'`)
  expect(before!.absent).toBe(true)
  expect(Exit.isFailure(await runtime.runPromise(Effect.exit(Rotation.gate({ next: Redacted.make(NEXT) }, Redacted.make(SECRET)))))).toBe(true)
  await runtime.runPromise(Rotation.cease("legacy"))
  const [proof] = await query(sql => sql<{ bounded: boolean }>`SELECT bool_and(s.started_at <= k.ceased_at) AS bounded FROM sessions s JOIN session_signing_keys k ON k.key_id = s.cookie_key`)
  expect(proof!.bounded).toBe(true)
})

test("issuance applies server timeouts, including transaction_timeout on PostgreSQL 17", async () => {
  const settings = await runtime.runPromise(Store.issuance(Effect.flatMap(SqlClient.SqlClient, sql => sql<{
    statement: string; lock: string; idle: string; version: number;
  }>`SELECT current_setting('statement_timeout') AS statement, current_setting('lock_timeout') AS lock,
      current_setting('idle_in_transaction_session_timeout') AS idle, current_setting('server_version_num')::int AS version`)))
  expect(settings[0]).toMatchObject({ statement: "5s", lock: "2s", idle: "10s" })
  if (settings[0]!.version >= 170000) {
    const values = await runtime.runPromise(Store.issuance(Effect.flatMap(SqlClient.SqlClient, sql => sql<{ timeout: string }>`SELECT current_setting('transaction_timeout') AS timeout`)))
    expect(values[0]!.timeout).toBe("15s")
  }
})

test("short-lived proofs stop issuing under the old key at promotion too", async () => {
  await runtime.runPromise(Rotation.stage("next", Redacted.make(NEXT)))
  await runtime.runPromise(Rotation.promote("next"))
  const h = await signInHarness(runtime, { config })
  const started = await h.start()
  const keys = await makeKeys()
  const proof = Option.getOrThrow(await runtime.runPromise(keys.verify("sign_in", started.cookies.smithers_sign_in!.value)))
  expect(proof.keyId).toBe("next")
})

test("key equality rejects re-stamped cookies in both direct resolution and socket authority", async () => {
  const h = await signInHarness(runtime, { config })
  const signed = await h.signInAs()
  const [row] = await query(sql => sql<{ id: string }>`SELECT id FROM sessions`)
  await runtime.runPromise(Rotation.stage("next", Redacted.make(NEXT)))
  await runtime.runPromise(Rotation.promote("next"))
  await query(sql => sql`UPDATE sessions SET cookie_key = 'next'`)
  const digest = Keys.digest(signed.cookies.smithers_session!.split(".")[0]!)
  expect(await runtime.runPromise(Store.findLive(digest, "legacy"))).toEqual(Option.none())
  expect(await runtime.runPromise(Store.findLiveById(row!.id, "legacy"))).toEqual(Option.none())
  expect(await runtime.runPromise(Store.authority(row!.id, null, "legacy"))).toEqual(Option.none())
  expect(Option.isSome(await runtime.runPromise(Store.authority(row!.id, null, "next").pipe(Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(config)))))).toBe(true)
})

test("an issuer holding a person's row lock cannot block promotion and is terminated by the idle timeout", async () => {
  const h = await signInHarness(runtime, { config })
  await h.signInAs()
  await runtime.runPromise(Rotation.stage("next", Redacted.make(NEXT)))
  const entered = barrier()
  const release = barrier()
  let pid = 0
  const stalled = runtime.runPromise(Effect.exit(Store.issuance(Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const [row] = yield* sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`
    pid = row!.pid
    yield* sql`SELECT id FROM people FOR UPDATE`
    entered.resolve()
    yield* Effect.promise(() => release.promise)
    yield* sql`SELECT 1`
  }))))
  try {
    await entered.promise
    await runtime.runPromise(Rotation.promote("next").pipe(Effect.timeout("2 seconds")))
    await query(sql => sql`SELECT pg_sleep(10.1)`)
    const [row] = await query(sql => sql<{ alive: boolean }>`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE pid = ${pid}) AS alive`)
    expect(row!.alive).toBe(false)
  } finally { release.resolve() }
  expect(Exit.isFailure(await stalled)).toBe(true)
})

test("a callback stalled past issuance's idle timeout rolls back without setting a cookie", async () => {
  const pause = await pauseInsert("INSERT INTO sessions")
  const h = await signInHarness(runtime, { config, database: pause.database })
  const pending = h.signInAs()
  try {
    await pause.entered.promise
    await query(sql => sql`SELECT pg_sleep(10.1)`)
  } finally { pause.release.resolve() }
  const signed = await pending
  expect(setCookies(signed.response).smithers_session).toBeUndefined()
  expect(await query(sql => sql`SELECT id FROM sessions`)).toEqual([])
})

test("an alias arrival stalled past issuance's idle timeout rolls back without setting a cookie", async () => {
  const pause = await pauseInsert("INSERT INTO host_sessions")
  const h = await signInHarness(runtime, { config: { ...config, APP_DOMAIN: "smithers.test", APP_ALIASES: "alias.test=/" }, database: pause.database })
  const home = await h.signInAs()
  const pressed = await h.at("http://alias.test/api/auth/sign-in", { headers: { "sec-fetch-site": "same-origin" } })
  const handed = await h.at(pressed.headers.get("location")!, { headers: { cookie: cookie(home.cookies) } })
  const code = new URLSearchParams(new URL(handed.headers.get("location")!).hash.slice(1)).get("code")!
  const nonce = setCookies(pressed).smithers_handoff!.value
  const pending = h.at("http://alias.test/api/auth/arrive", { method: "POST", body: new URLSearchParams({ code }).toString(),
    headers: { origin: "http://alias.test", "content-type": "application/x-www-form-urlencoded", cookie: cookie({ smithers_handoff: nonce }) } })
  try {
    await pause.entered.promise
    await query(sql => sql`SELECT pg_sleep(10.1)`)
  } finally { pause.release.resolve() }
  const arrived = await pending
  expect(setCookies(arrived).smithers_session).toBeUndefined()
  expect(await query(sql => sql`SELECT id FROM host_sessions`)).toEqual([])
})

test.each(["blocked", "uncommitted"] as const)("a %s renewal across expiry and promotion changes no cookie or cessation time", async mode => {
  const h = await signInHarness(runtime, { config })
  const signed = await h.signInAs()
  const digest = Keys.digest(signed.cookies.smithers_session!.split(".")[0]!)
  await query(sql => sql`UPDATE sessions SET expires_at = clock_timestamp() + interval '3 seconds', started_at = clock_timestamp() - interval '400 days' + interval '5 seconds'`)
  const entered = barrier()
  const release = barrier()
  const holding = runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, sql => sql.withTransaction(Effect.gen(function* () {
    if (mode === "blocked") yield* sql`SELECT id FROM sessions FOR UPDATE`
    else yield* Store.renew(digest, null, 30 * 86400, "legacy")
    entered.resolve()
    yield* Effect.promise(() => release.promise)
  }))))
  let answer: Promise<Response> | undefined
  try {
    await entered.promise
    if (mode === "blocked") answer = h.fetch("/api/auth/session", { headers: { cookie: cookie(signed.cookies) } })
    await runtime.runPromise(Rotation.stage("next", Redacted.make(NEXT)))
    await runtime.runPromise(Rotation.promote("next"))
    await runtime.runPromise(Rotation.cease("legacy"))
    const [before] = await query(sql => sql<{ stamp: string }>`SELECT ceased_at::text AS stamp FROM session_signing_keys WHERE key_id = 'legacy'`)
    await query(sql => sql`SELECT pg_sleep(5.1)`)
    const [after] = await query(sql => sql<{ stamp: string }>`SELECT ceased_at::text AS stamp FROM session_signing_keys WHERE key_id = 'legacy'`)
    expect(after).toEqual(before)
  } finally { release.resolve() }
  await holding
  const response = await (answer ?? h.fetch("/api/auth/session", { headers: { cookie: cookie(signed.cookies) } }))
  expect(await response.json()).toMatchObject({ signedIn: false })
  expect(response.headers.getSetCookie()).toEqual([])
  expect(Exit.isFailure(await runtime.runPromise(Effect.exit(Rotation.gate({ next: Redacted.make(NEXT) }, Redacted.make(SECRET)))))).toBe(true)
})

test("dropping a key ends internal authority too, even without a presented cookie", async () => {
  const h = await signInHarness(runtime, { config })
  await h.signInAs()
  const [row] = await query(sql => sql<{ id: string; person: string }>`SELECT id, person_id::text AS person FROM sessions`)
  const dropped = <A, E, R>(effect: Effect.Effect<A, E, R>) => effect.pipe(
    Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown({ SESSION_SECRETS: JSON.stringify({ next: NEXT }) })),
  )
  expect(await runtime.runPromise(dropped(Store.findLiveById(row!.id)))).toEqual(Option.none())
  expect(await runtime.runPromise(dropped(Store.authority(row!.id, null)))).toEqual(Option.none())
  expect(await runtime.runPromise(dropped(Store.deploymentMember(row!.person)))).toBe(false)
  const held = await runtime.runPromise(dropped(Store.held(row!.id)))
  expect(Option.isSome(held) && held.value.live).toBe(false)
})

test.each(["discovery", "protected request"] as const)("an alias %s refuses an unconfigured parent key and recovers after parent reauthentication", async route => {
  const setup = { ...config, APP_DOMAIN: "smithers.test", APP_ALIASES: "alias.test=/" }
  const h = await signInHarness(runtime, { config: setup })
  const signed = await h.signInAs()
  const [parent] = await query(sql => sql<{ id: string }>`SELECT id FROM sessions`)
  await runtime.runPromise(Rotation.stage("next", Redacted.make(NEXT)))
  await runtime.runPromise(Rotation.promote("next"))
  const token = crypto.randomUUID()
  expect(await runtime.runPromise(Store.createHostSession({ id: crypto.randomUUID(), tokenDigest: Keys.digest(token),
    parentId: parent!.id, host: "alias.test" }, ["legacy", "next"]))).toBe(true)
  const keys = await makeKeys()
  const headers = { cookie: cookie({ smithers_session: await runtime.runPromise(keys.sign("session", token, "next")) }) }
  const protectedRead = (host: Awaited<ReturnType<typeof signInHarness>>) => HttpEffect.toWebHandler(host.signIn.guard(
    Effect.gen(function* () {
      const actor = yield* (yield* Sessions).resolve
      return Option.isSome(actor) ? HttpServerResponse.jsonUnsafe({ private: true }) : HttpServerResponse.empty({ status: 401 })
    })).pipe(Effect.provide(host.sessions), Effect.provide(host.services)))
  const read = (host: Awaited<ReturnType<typeof signInHarness>>) => route === "discovery"
    ? host.at("http://alias.test/api/auth/session", { headers })
    : protectedRead(host)(new Request("http://alias.test/api/private", { headers }))
  const initial = await read(h)
  if (route === "discovery") expect(await initial.json()).toMatchObject({ signedIn: true })
  else expect(initial.status).toBe(200)
  const dropped = await signInHarness(runtime, { config: { ...setup, SESSION_SECRETS: JSON.stringify({ next: NEXT }) }, github: h.github })
  const refused = await read(dropped)
  if (route === "discovery") expect(await refused.json()).toMatchObject({ signedIn: false })
  else {
    expect(refused.status).toBe(401)
    expect(await refused.text()).not.toContain("private")
  }
  const started = await h.start()
  const response = await h.callback(h.github.approve(started.location), { ...signed.cookies, smithers_sign_in: started.cookies.smithers_sign_in!.value })
  expect(response.status).toBe(303)
  const recovered = await read(dropped)
  if (route === "discovery") expect(await recovered.json()).toMatchObject({ signedIn: true })
  else expect(await recovered.json()).toEqual({ private: true })
})

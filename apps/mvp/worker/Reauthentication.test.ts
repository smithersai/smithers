import { Outbox } from "@smthrs/effect-tanstack-db"
import { SharedText } from "@smthrs/sync"
import { startOfflineExecutor } from "@tanstack/offline-transactions"
import { ConfigProvider, Deferred, Effect, Exit, Layer, ManagedRuntime, Metric, Option, Redacted, Stream } from "effect"
import { Base64 } from "effect/encoding"
import { FetchHttpClient, HttpEffect, HttpServerResponse } from "effect/http"
import { SqlClient } from "effect/sql"
import { beforeEach, describe, expect, test, vi } from "vitest"
import * as TestDatabase from "../db/TestDatabase.ts"
import { DEVICE_PERSON_HEADER, type SessionState } from "../src/features/auth/contract.ts"
import { TextsClient } from "../src/features/coedit/api.ts"
import { sends } from "../src/features/coedit/metrics.ts"
import { TEXT_UPDATE, TextWrites } from "../src/features/coedit/writes.ts"
import { OutboxWrites } from "../src/outbox.ts"
import { Sessions } from "./Actor.ts"
import { BranchRoles } from "./branch/Access.ts"
import * as Flows from "./Flows.ts"
import * as RecheckRole from "./flows/RecheckRole.ts"
import * as Keys from "./SessionKeys.ts"
import * as Rotation from "./SessionSigningKeys.ts"
import * as Store from "./SessionStore.ts"
import { repositoryOf } from "./github/Config.ts"
import * as RepoRoles from "./github/RepoRoles.ts"
import { branchHarness, tracked } from "./test/branch.ts"
import { testFile } from "./test/harness.ts"
import { holdSql } from "./test/sqlWait.ts"
import { configured, cookie, SECRET, setCookies, signInHarness } from "./test/signIn.ts"

const runtime = testFile("reauthentication")
const query = <A extends object>(f: (sql: SqlClient.SqlClient) => Effect.Effect<ReadonlyArray<A>, unknown>) =>
  runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, f))
const NEXT = "next-reauth-signing-key-".padEnd(64, "8")
const config = { ...configured, SESSION_SECRETS: JSON.stringify({ legacy: SECRET, next: NEXT }), SESSION_SEAL_SECRET: SECRET,
  APP_DOMAIN: "smithers.test", APP_ALIASES: "alias.test=/" }
const makeKeys = () => runtime.runPromise(Keys.make(Redacted.make(SECRET), {
  secrets: { legacy: Redacted.make(SECRET), next: Redacted.make(NEXT) }, sealSecret: Redacted.make(SECRET),
}))
const values = (response: Response) => Object.fromEntries(Object.entries(setCookies(response)).filter(([, c]) => c.value !== "").map(([k, c]) => [k, c.value]))
const rows = () => query(sql => sql<{ id: string; revoked: boolean; gen: number; pair: string | null; key: string; start: number }>`
  SELECT id, revoked_at IS NOT NULL AS revoked, github_token_gen AS gen, github_pair_digest AS pair, cookie_key AS key,
    (extract(epoch FROM started_at)*1000)::float8 AS start FROM sessions ORDER BY created_at, id`)
const cleanups = () => query(sql => sql<{ id: string; session: string; pair: string; access: Store.Sealed | null; refresh: Store.Sealed | null; finished: boolean }>`
  SELECT id, session_id AS session, pair_digest AS pair, sealed_access AS access, sealed_refresh AS refresh,
    finished_at IS NOT NULL AS finished FROM github_token_cleanups ORDER BY created_at, id`)
const answer = (h: Awaited<ReturnType<typeof signInHarness>>, cookies: Record<string, string>) => h.session(cookies) as Promise<SessionState>
const prepare = async (h: Awaited<ReturnType<typeof signInHarness>>, cookies: Record<string, string>) => {
  const started = await h.start()
  const approved = h.github.approve(started.location)
  return () => h.callback(approved, { ...cookies, smithers_sign_in: started.cookies.smithers_sign_in!.value })
}
const setup = async (starter?: Flows.FlowStarter["Service"]) => {
  const h = await signInHarness(runtime, { config, ...(starter === undefined ? {} : { starter }) })
  const first = await h.signInAs()
  const [{ id }] = await query(sql => sql<{ id: string }>`SELECT id FROM sessions`)
  const keys = await makeKeys()
  const services: RecheckRole.Services = { keys, github: h.github.service, repository: "smithersai/smithers" }
  const database = (await runtime.runPromise(TestDatabase.Scratch)).database
  return { h, first, id: id!, keys, services, database }
}
const day394 = (id: string) => query(sql => sql`UPDATE sessions SET started_at = now() - interval '394 days', expires_at = now() + interval '6 days' WHERE id = ${id}`)
const expireAccess = (id: string) => query(sql => sql`UPDATE sessions SET github_access_expires_at = now() + interval '1 minute' WHERE id = ${id}`)
const rotate = async () => { await runtime.runPromise(Rotation.stage("next", Redacted.make(NEXT))); await runtime.runPromise(Rotation.promote("next")) }
const step = <A, E>(s: Awaited<ReturnType<typeof setup>>, effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  runtime.runPromise(effect.pipe(Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(config))))

beforeEach(async () => {
  await query(sql => sql`TRUNCATE sessions, sign_in_attempts, people CASCADE`)
  await query(sql => sql`TRUNCATE github_token_cleanups`)
  await query(sql => sql`DELETE FROM session_signing_keys`)
  await query(sql => sql`INSERT INTO session_signing_keys (key_id, state, promoted_at) VALUES ('legacy', 'issuer', now())`)
})

describe("in-place callback", () => {
  test.each(["home", "alias", "permission denial"].flatMap(boundary => ["role", "insert"].map(stage => ({ boundary, stage }))))("the coedit outbox distinguishes $boundary revalidation during $stage from a permanent refusal", async ({ boundary, stage }) => {
    const s = await setup()
    const alias = boundary === "alias" ? crypto.randomUUID() : undefined
    const token = crypto.randomUUID()
    if (alias !== undefined) expect(await step(s, Store.createHostSession({ id: alias,
      tokenDigest: Keys.digest(token), parentId: s.id, host: "chat.test" }, s.keys.keyIds))).toBe(true)
    const presented = alias === undefined ? s.first.cookies : { smithers_session: await runtime.runPromise(s.keys.sign("session", token, "legacy")) }
    let currentCookies = presented
    const auth = await signInHarness(runtime, { config: { ...config,
      APP_DOMAIN: alias === undefined ? "chat.test" : "smithers.test", APP_ALIASES: alias === undefined ? "" : "chat.test=/" }, github: s.h.github })
    const [person] = await query(sql => sql<{ id: string }>`SELECT person_id::text AS id FROM sessions WHERE id = ${s.id}`)
    const branch = await tracked(runtime, "github/smithersai/smithers", `reauth-${crypto.randomUUID()}`, "open", person!.id)
    const reached = Deferred.makeUnsafe<void>()
    const release = Deferred.makeUnsafe<void>()
    let hold = stage === "role"
    let admittedSession: string | undefined
    let admittedKey: string | undefined
    const sessions = Layer.effect(Sessions, Effect.map(Sessions, real => Sessions.of({ ...real,
      resolve: real.resolve.pipe(Effect.tap(resolved => Effect.gen(function* () {
        if (Option.isSome(resolved)) {
          admittedSession = resolved.value.session
          admittedKey = resolved.value.cookieKey
        }
        if (!hold) return
        hold = false
        yield* Deferred.succeed(reached, undefined)
        yield* Deferred.await(release)
      }))),
    }))).pipe(Layer.provide(auth.sessions))
    const roles = await runtime.runPromise(RepoRoles.make(s.database, { repository: repositoryOf("smithersai/smithers"), app: Option.none() }))
    const server = await branchHarness(runtime, { sessions, config,
      branchRoles: BranchRoles.layer(roles).pipe(Layer.provideMerge(Layer.succeed(Store.SigningKeyIds, s.keys.keyIds))) })
    const statuses: Array<number> = []
    let allowNext!: () => void
    const nextAllowed = new Promise<void>(resolve => { allowNext = resolve })
    const fetch: typeof globalThis.fetch = async (input, init) => {
      if (statuses.length > 0) await nextAllowed
      const request = new Request(input, init)
      const response = await server.fetch(new URL(request.url).pathname, { method: request.method,
        headers: { ...Object.fromEntries(request.headers), cookie: cookie(currentCookies), [DEVICE_PERSON_HEADER]: person!.id },
        body: await request.arrayBuffer(), signal: request.signal })
      statuses.push(response.status)
      return response
    }
    const entries = new Map<string, string>()
    const storageId = crypto.randomUUID()
    const storage: Outbox.Options<never>["storage"] = {
      withLock: (name, action) => navigator.locks.request(`${storageId}:${name}`, action),
      get: async key => entries.get(key) ?? null,
      set: async (key, value) => void entries.set(key, value),
      setMany: async rows => { for (const [key, value] of rows) entries.set(key, value) },
      delete: async key => void entries.delete(key),
      keys: async () => [...entries.keys()],
      clear: async () => entries.clear(),
    }
    const writes = TextWrites.layer.pipe(Layer.provide(TextsClient.layer({ origin: "http://chat.test", within: "20 seconds" }).pipe(
      Layer.provide(FetchHttpClient.layer), Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch)))))
    const device = ManagedRuntime.make(Layer.unwrap(Effect.map(OutboxWrites, registered => Outbox.layer({
      ...registered, start: startOfflineExecutor, storage, online: Outbox.Online.always(),
    }))).pipe(Layer.provideMerge(writes), Layer.provideMerge(Layer.succeed(Metric.MetricRegistry, new Map()))))
    let held: Awaited<ReturnType<typeof holdSql>> | undefined
    try {
      const outbox = await device.runPromise(Outbox.Outbox)
      const { sending } = await device.runPromise(TextWrites)
      await device.runPromise(Stream.runHead(outbox.status.pipe(Stream.filter(state => state.leader))).pipe(Effect.timeout("5 seconds")))
      const update = await runtime.runPromise(Effect.scoped(Effect.flatMap(SharedText.make, replica => replica.replace("retained edit"))))
      const id = crypto.randomUUID(), textId = crypto.randomUUID()
      if (stage === "insert" && boundary !== "permission denial") held = await holdSql(runtime, sql =>
        sql`INSERT INTO text_updates (id, scope, text_id, data, seed, person_id)
          VALUES (${id}, ${`branch:${branch.branchId}`}, ${textId}, ${Base64.encode(update!)}, false, ${person!.id})`)
      if (stage === "insert" && boundary === "permission denial") {
        await runtime.runPromise(Store.setRole(s.id, null, await runtime.runPromise(Store.roleObservation), 0))
      }
      const write = await device.runPromise(outbox.transact(TEXT_UPDATE, { idempotencyKey: id }, Effect.asVoid(sending.insert({
        id, textId, scope: { conversation: branch.conversationId }, data: Base64.encode(update!), seed: false,
      }))))
      await device.runPromise(write.admitted)
      if (stage === "role") await runtime.runPromise(Deferred.await(reached).pipe(Effect.timeout("5 seconds")))
      else if (held !== undefined) await expect.poll(async () =>
        (await query(sql => sql`SELECT pid FROM pg_stat_activity WHERE ${held!.pid} = ANY(pg_blocking_pids(pid))`)).length,
      { timeout: 5_000, interval: 10 }).toBe(1)
      else await vi.waitFor(() => expect(statuses).toEqual([403]), { timeout: 5_000 })
      expect(admittedSession).toBe(s.id)
      expect(admittedKey).toBe("legacy")
      let fresh = presented
      if (boundary === "permission denial") {
        await runtime.runPromise(Store.setRole(s.id, null, await runtime.runPromise(Store.roleObservation), 0))
      } else {
        await rotate()
        if (alias === undefined) {
          const response = await (await prepare(s.h, s.first.cookies))()
          expect(response.status).toBe(303)
          fresh = values(response)
        } else {
          expect(Option.getOrThrow(await step(s, Store.reauthenticateHost({ id: crypto.randomUUID(), tokenDigest: Keys.digest(token),
            parentId: s.id, host: "chat.test" }, { digest: Keys.digest(token), key: "legacy" }, s.keys.keyIds)))).toMatchObject({ id: alias, renewed: true })
          fresh = { smithers_session: await runtime.runPromise(s.keys.sign("session", token, "next")) }
        }
      }
      await runtime.runPromise(Deferred.succeed(release, undefined))
      await held?.release()
      held = undefined
      const count = (outcome: string) => device.runPromise(Metric.value(Metric.withAttributes(sends, { outcome })))
      await vi.waitFor(() => expect(statuses).toHaveLength(1), { timeout: 5_000 })
      expect(statuses).toEqual([boundary === "permission denial" ? 403 : 503])
      await vi.waitFor(async () => expect((await count("refused")).count + (await count("retry")).count).toBeGreaterThan(0), { timeout: 5_000 })
      const queued = () => storage.keys().then(keys => keys.filter(key => key.startsWith("tx:")))
      if (boundary === "permission denial") {
        await vi.waitFor(async () => expect(await queued()).toHaveLength(0))
        expect(statuses).toEqual([403])
        expect((await count("refused")).count).toBe(1)
        expect(server.line("auth.role_unavailable")).toHaveLength(0)
        expect((await device.runPromise(Effect.result(write.settled)))._tag).toBe("Failure")
      } else {
        expect(await queued()).toHaveLength(1)
        expect(sending.tanstack.get(id)).toBeDefined()
        expect((await count("refused")).count).toBe(0)
        expect(statuses).toEqual([503])
        expect(server.only(stage === "role" ? "auth.role_unavailable" : "write.authority_unavailable").annotations).toMatchObject({ reason: "session_authority" })
        expect(server.span(stage === "role" ? "auth.role" : "write.authority").some(span => stage === "role"
          ? span.attributes.get("auth.role.reason") === "session_authority" : span.attributes.get("write.authority.live") === false)).toBe(true)
        currentCookies = fresh
        allowNext()
        await device.runPromise(outbox.retryNow)
        await device.runPromise(write.settled.pipe(Effect.timeout("5 seconds")))
        expect(await queued()).toHaveLength(0)
        expect((await count("stored")).count).toBe(1)
        expect(await query(sql => sql`SELECT id FROM text_updates WHERE id = ${id}`)).toEqual([{ id }])
      }
    } finally {
      await held?.release()
      await runtime.runPromise(Deferred.succeed(release, undefined))
      allowNext()
      await device.dispose()
    }
  }, 60_000)

  test.each(["home", "alias", "alias parent"] as const)("role revalidation binds the presented cookie across %s reauthentication", async boundary => {
    const s = await setup()
    const alias = boundary === "home" ? undefined : crypto.randomUUID()
    const token = crypto.randomUUID()
    if (alias !== undefined) expect(await step(s, Store.createHostSession({ id: alias,
      tokenDigest: Keys.digest(token), parentId: s.id, host: "alias.test" }, s.keys.keyIds))).toBe(true)
    const cookies = alias === undefined ? s.first.cookies : { smithers_session: await runtime.runPromise(s.keys.sign("session", token, "legacy")) }
    const origin = alias === undefined ? "http://smithers.test" : "http://alias.test"
    const reached = Deferred.makeUnsafe<void>()
    const release = Deferred.makeUnsafe<void>()
    let hold = false
    const handler = HttpEffect.toWebHandler(Effect.gen(function* () {
      const actor = yield* (yield* Sessions).resolve
      if (Option.isNone(actor)) return HttpServerResponse.empty({ status: 401 })
      if (hold) { yield* Deferred.succeed(reached, undefined); yield* Deferred.await(release) }
      const role = yield* Store.freshRole(actor.value)
      return HttpServerResponse.empty({ status: role === null ? 403 : 204 })
    }).pipe(Effect.catchTag("@smthrs/mvp/auth/SessionsUnavailable", () => Effect.succeed(HttpServerResponse.empty({ status: 503 }))),
      Effect.provide(s.h.sessions), Effect.provide(s.database)))
    const read = (current: Record<string, string>) => handler(new Request(`${origin}/api/private`, { headers: { cookie: cookie(current) } }))
    expect((await read(cookies)).status).toBe(204)
    hold = true
    const pending = read(cookies)
    let fresh = cookies
    try {
      await runtime.runPromise(Deferred.await(reached).pipe(Effect.timeout("5 seconds")))
      await rotate()
      if (boundary === "alias") {
        const renewed = await step(s, Store.reauthenticateHost({ id: crypto.randomUUID(), tokenDigest: Keys.digest(token),
          parentId: s.id, host: "alias.test" }, { digest: Keys.digest(token), key: "legacy" }, s.keys.keyIds))
        expect(Option.getOrThrow(renewed)).toMatchObject({ id: alias, renewed: true, key: "next" })
        fresh = { smithers_session: await runtime.runPromise(s.keys.sign("session", token, "next")) }
      } else {
        const response = await (await prepare(s.h, s.first.cookies))()
        expect(response.status).toBe(303)
        if (alias === undefined) fresh = values(response)
      }
    } finally { hold = false; await runtime.runPromise(Deferred.succeed(release, undefined)) }
    expect((await pending).status).toBe(boundary === "alias parent" ? 204 : 503)
    expect((await read(fresh)).status).toBe(204)
  })

  test("day 394 keeps the row, token, tag and old-cookie reads, and journals only the replaced pair", async () => {
    const s = await setup()
    await day394(s.id)
    const before = await answer(s.h, s.first.cookies)
    const response = await (await prepare(s.h, s.first.cookies))()
    const after = await answer(s.h, values(response))
    expect(response.headers.get("location")).toBe("/app")
    expect((await rows()).map(r => [r.id, r.revoked, r.gen])).toEqual([[s.id, false, 1]])
    expect(after).toMatchObject({ signedIn: true, session: (before as { session: string }).session })
    expect((after as { deadline: number }).deadline).toBeGreaterThan((before as { deadline: number }).deadline)
    expect(values(response).smithers_session).toBe(s.first.cookies.smithers_session)
    expect(await answer(s.h, s.first.cookies)).toMatchObject({ signedIn: true, session: (before as { session: string }).session })
    expect((await cleanups()).map(r => [r.session, r.pair, r.finished])).toEqual([[s.id, Keys.digest(Redacted.value(s.h.github.issued[0]!.accessToken)), false]])
    expect(s.h.revocations).toEqual([])
    expect(s.h.cleanupStarts).toEqual([(await cleanups())[0]!.id])
  })

  test("a session read paused after its lookup still names the same person and tag after renewal", async () => {
    const s = await setup()
    await day394(s.id)
    const before = await answer(s.h, s.first.cookies)
    if (!before.signedIn) throw new Error("expected the held session to be live")
    const reached = Deferred.makeUnsafe<void>()
    const release = Deferred.makeUnsafe<void>()
    let paused = false
    const database = Layer.effect(SqlClient.SqlClient, Effect.map(SqlClient.SqlClient, real => new Proxy(real, {
      apply(target, receiver, args) {
        const result = Reflect.apply(target, receiver, args)
        if (paused || !String(args[0]).includes('AS "sessionTag"')) return result
        paused = true
        return result.pipe(Effect.tap(() => Deferred.succeed(reached, undefined)), Effect.tap(() => Deferred.await(release)))
      },
    }))).pipe(Layer.provide(s.database))
    const otherTab = await signInHarness(runtime, { config, github: s.h.github, database })
    const reading = otherTab.session(s.first.cookies)
    await Effect.runPromise(Deferred.await(reached))
    await (await prepare(s.h, s.first.cookies))()
    Effect.runSync(Deferred.succeed(release, undefined))
    expect(await reading).toMatchObject({ signedIn: true, personId: before.personId, session: before.session })
    expect(s.h.revocations).toEqual([])
  })

  test("a failed exchange leaves the held session and its tokens intact", async () => {
    const s = await setup()
    const complete = await prepare(s.h, s.first.cookies)
    s.h.github.faults.exchange = "unavailable"
    const response = await complete()
    expect(response.headers.get("location")).toBe("/app?sign_in=failed")
    expect(await answer(s.h, s.first.cookies)).toMatchObject({ signedIn: true })
    expect(s.h.revocations).toEqual([])
  })

  test("an unconfigured issuer rolls back the renewal and cleanup enqueue together", async () => {
    const s = await setup()
    const legacy = await signInHarness(runtime, { github: s.h.github, config: { ...config, SESSION_SECRETS: JSON.stringify({ legacy: SECRET }) } })
    const complete = await prepare(legacy, s.first.cookies)
    await rotate()
    const failed = await complete()
    expect(failed.headers.get("location")).toBe("/app?sign_in=failed")
    expect((await rows()).map(r => [r.id, r.gen, r.key, r.revoked])).toEqual([[s.id, 0, "legacy", false]])
    expect(await cleanups()).toEqual([])
    expect(legacy.revocations).toEqual([])
    expect(await legacy.session(s.first.cookies)).toMatchObject({ signedIn: true })
  })

  test("lost and delayed responses across rotation remain stale without identity, then a second old-key callback renews the same row", async () => {
    const s = await setup()
    const before = await answer(s.h, s.first.cookies)
    await rotate()
    const first = await (await prepare(s.h, s.first.cookies))()
    expect(await s.h.session(s.first.cookies)).toEqual({ credential: "stale" })
    // The first Set-Cookie has not reached the browser. A second callback still carries the configured old key.
    const second = await (await prepare(s.h, s.first.cookies))()
    expect((await rows()).map(r => [r.id, r.gen, r.key])).toEqual([[s.id, 2, "next"]])
    expect(await cleanups()).toHaveLength(2)
    expect(await s.h.session(values(second))).toMatchObject({ signedIn: true, session: (before as { session: string }).session })
    expect(await s.h.session(values(first))).toMatchObject({ signedIn: true, session: (before as { session: string }).session })
    const dropped = await signInHarness(runtime, { config: { ...config, SESSION_SECRETS: JSON.stringify({ next: NEXT }) }, github: s.h.github })
    expect(await dropped.session(s.first.cookies)).toMatchObject({ signedIn: false })
  })

  test.each(["delayed", "lost"])("a %s callback cookie leaves another tab's guarded write retryable", async delivery => {
    const s = await setup()
    await rotate()
    const response = await (await prepare(s.h, s.first.cookies))()
    let writes = 0
    const handler = HttpEffect.toWebHandler(s.h.signIn.guard(Effect.sync(() => {
      writes++
      return HttpServerResponse.empty({ status: 204 })
    })).pipe(Effect.provide(s.h.services)))
    const write = (cookies: Record<string, string>) => handler(new Request("http://smithers.test/api/private", {
      method: "POST", headers: { cookie: cookie(cookies), "x-smithers-accepts": "credential-stale" },
    }))
    const pending = await write(s.first.cookies)
    expect(pending.status).toBe(503)
    expect(pending.headers.get("x-smithers-credential")).toBe("stale")
    expect(pending.headers.get("retry-after")).toBe("1")
    expect(writes).toBe(0)
    expect(await s.h.session(s.first.cookies)).toEqual({ credential: "stale" })
    const delivered = delivery === "delayed" ? response : await (await prepare(s.h, s.first.cookies))()
    expect((await write(values(delivered))).status).toBe(204)
    expect(writes).toBe(1)
    expect((await rows()).map(row => [row.id, row.revoked])).toEqual([[s.id, false]])
  })

  test.each(["expired", "29 seconds", "sliding expiry in 29 seconds", "revoked", "other person", "absent", "dropped key"])("%s is ineligible and creates a new tag", async reason => {
    const s = await setup()
    const before = await answer(s.h, s.first.cookies)
    let held = s.first.cookies
    if (reason === "expired" || reason === "29 seconds") await query(sql => sql`UPDATE sessions SET
      started_at = clock_timestamp() - interval '400 days' + make_interval(secs => ${reason === "expired" ? -1 : 29}),
      expires_at = now() + interval '30 days' WHERE id = ${s.id}`)
    if (reason === "sliding expiry in 29 seconds") await query(sql => sql`UPDATE sessions SET expires_at = clock_timestamp() + interval '29 seconds' WHERE id = ${s.id}`)
    if (reason === "revoked") await runtime.runPromise(Store.revoke({ id: s.id }, "sign_out"))
    if (reason === "other person") s.h.github.person = { id: 22, login: "other" }
    if (reason === "absent") held = {}
    let h = s.h
    if (reason === "dropped key") {
      await rotate()
      h = await signInHarness(runtime, { config: { ...config, SESSION_SECRETS: JSON.stringify({ next: NEXT }) }, github: s.h.github })
    }
    const response = await (await prepare(h, held))()
    const next = await answer(h, values(response))
    expect(next).toMatchObject({ signedIn: true })
    expect((next as { session: string }).session).not.toBe((before as { session: string }).session)
    expect(await rows()).toHaveLength(2)
  })

  test("a callback paused at GitHub until after the held deadline creates a new row", async () => {
    const s = await setup()
    const reached = Deferred.makeUnsafe<void>()
    const release = Deferred.makeUnsafe<void>()
    const service = { ...s.h.github.service, permission: (...args: Parameters<typeof s.h.github.service.permission>) =>
      s.h.github.service.permission(...args).pipe(Effect.tap(() => Deferred.succeed(reached, undefined)), Effect.tap(() => Deferred.await(release))) }
    const h = await signInHarness(runtime, { config, github: { ...s.h.github, service } })
    const complete = await prepare(h, s.first.cookies)
    const pending = complete()
    await Effect.runPromise(Deferred.await(reached))
    await query(sql => sql`UPDATE sessions SET started_at = now() - interval '401 days' WHERE id = ${s.id}`)
    Effect.runSync(Deferred.succeed(release, undefined))
    const response = await pending
    expect((await rows()).find(r => r.id === s.id)!.revoked).toBe(true)
    expect(await h.session(values(response))).toMatchObject({ signedIn: true })
    expect(await rows()).toHaveLength(2)
  })

  test("sign-out while an old cookie is stale ends both the old and current cookie", async () => {
    const s = await setup()
    await rotate()
    const response = await (await prepare(s.h, s.first.cookies))()
    expect(await s.h.session(s.first.cookies)).toEqual({ credential: "stale" })
    await runtime.runPromise(Store.revoke({ id: s.id }, "sign_out"))
    expect(await s.h.session(s.first.cookies)).toMatchObject({ signedIn: false })
    expect(await s.h.session(values(response))).toMatchObject({ signedIn: false })
  })

  test("two simultaneous callbacks keep one row and enqueue each displaced pair once", async () => {
    const s = await setup()
    const a = await prepare(s.h, s.first.cookies)
    const b = await prepare(s.h, s.first.cookies)
    const responses = await Promise.all([a(), b()])
    expect(responses.map(r => r.headers.get("location"))).toEqual(["/app", "/app"])
    expect((await rows()).map(r => [r.id, r.revoked, r.gen])).toEqual([[s.id, false, 2]])
    expect(await cleanups()).toHaveLength(2)
    const cleanup = await import("./flows/RevokeReplacedGitHubToken.ts")
    for (const row of await cleanups()) await step(s, cleanup.revoke(row.id, s.services))
    expect(s.h.github.issued.filter(t => s.h.github.accepts(t.accessToken))).toHaveLength(1)
    expect(await s.h.session(values(responses[1]!))).toMatchObject({ signedIn: true })
  })

  test("an older callback cannot extend the winning role receipt's authorization deadline", async () => {
    const s = await setup()
    const reached = Deferred.makeUnsafe<void>()
    const release = Deferred.makeUnsafe<void>()
    const service = { ...s.h.github.service, permission: (...args: Parameters<typeof s.h.github.service.permission>) =>
      s.h.github.service.permission(...args).pipe(Effect.tap(() => Deferred.succeed(reached, undefined)), Effect.tap(() => Deferred.await(release))) }
    const older = await signInHarness(runtime, { config, github: { ...s.h.github, service } })
    s.h.github.permission = "admin"
    const pending = (await prepare(older, s.first.cookies))()
    const receipt = () => query(sql => sql<{ personId: string; role: string; generation: string; verified: string }>`
      SELECT person_id::text AS "personId", role, role_generation::text AS generation,
        role_verified_at::text AS verified FROM sessions WHERE id = ${s.id}`)
    try {
      await Effect.runPromise(Deferred.await(reached).pipe(Effect.timeout("5 seconds")))
      s.h.github.permission = "write"
      expect((await (await prepare(s.h, s.first.cookies))()).status).toBe(303)
      const [fresh] = await receipt()
      const actor = { subject: { kind: "person" as const, id: fresh!.personId }, role: "admin" as const, session: s.id }
      expect(await runtime.runPromise(Store.freshRole(actor))).toBe("member")
      // Advance the real SQL receipt beyond its window while the older GitHub observation remains paused.
      await query(sql => sql`UPDATE sessions SET role_verified_at = clock_timestamp() - interval '61 minutes' WHERE id = ${s.id}`)
      const [winning] = await receipt()
      expect((await runtime.runPromise(Effect.result(Store.freshRole(actor))))._tag).toBe("Failure")
      Effect.runSync(Deferred.succeed(release, undefined))
      expect((await pending).status).toBe(303)
      expect((await rows()).map(row => [row.id, row.gen, row.revoked])).toEqual([[s.id, 2, false]])
      expect((await receipt())[0]).toEqual(winning)
      expect((await runtime.runPromise(Effect.result(Store.freshRole(actor))))._tag).toBe("Failure")
    } finally {
      Effect.runSync(Deferred.succeed(release, undefined))
      await pending
    }
  })

  test.each(["signout first", "callback first"])("same-cookie sign-out race: %s ends the original row and aliases", async order => {
    const s = await setup()
    await step(s, Store.createHostSession({ id: crypto.randomUUID(), tokenDigest: Keys.digest("alias"), parentId: s.id, host: "alias.test" }, s.keys.keyIds))
    const complete = await prepare(s.h, s.first.cookies)
    if (order === "signout first") await runtime.runPromise(Store.revoke({ id: s.id }, "sign_out"))
    const response = await complete()
    if (order === "callback first") await runtime.runPromise(Store.revoke({ id: s.id }, "sign_out"))
    expect((await rows()).find(r => r.id === s.id)!.revoked).toBe(true)
    expect(await step(s, Store.findHostLive(Keys.digest("alias"), "alias.test"))).toEqual(Option.none())
    expect(await s.h.session(values(response))).toMatchObject({ signedIn: order === "signout first" })
  })

  test.each(["signout first", "callback first"])("row-lock race with blocked transactions: %s", async order => {
    const s = await setup()
    const reached = Deferred.makeUnsafe<void>()
    const release = Deferred.makeUnsafe<void>()
    let armed = true
    const paused = Layer.effect(SqlClient.SqlClient, Effect.map(SqlClient.SqlClient, real => new Proxy(real, {
      apply(target, receiver, args) {
        const statement = String(args[0])
        const result = Reflect.apply(target, receiver, args)
        if (!armed || !statement.includes("UPDATE sessions") || !statement.includes("github_token_gen")) return result
        armed = false
        return result.pipe(Effect.tap(() => Deferred.succeed(reached, undefined)), Effect.tap(() => Deferred.await(release)))
      },
    }))).pipe(Layer.provide(s.database))
    const h = await signInHarness(runtime, { config, github: s.h.github, database: paused })
    const complete = await prepare(h, s.first.cookies)
    if (order === "callback first") {
      const callback = complete()
      await Effect.runPromise(Deferred.await(reached))
      const signout = runtime.runPromise(Store.revoke({ id: s.id }, "sign_out"))
      Effect.runSync(Deferred.succeed(release, undefined))
      await callback
      await signout
      expect(await rows()).toMatchObject([{ id: s.id, revoked: true, gen: 1 }])
    } else {
      const signout = runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, sql => sql.withTransaction(Effect.gen(function* () {
        yield* Store.revoke({ id: s.id }, "sign_out")
        yield* Deferred.succeed(reached, undefined)
        yield* Deferred.await(release)
      }))))
      await Effect.runPromise(Deferred.await(reached))
      const callback = complete()
      Effect.runSync(Deferred.succeed(release, undefined))
      await signout
      await callback
      expect((await rows()).filter(r => !r.revoked)).toHaveLength(1)
      expect((await rows()).find(r => r.id === s.id)!.revoked).toBe(true)
    }
  })

})

describe("fenced redemption storage and cleanup", () => {
  test.each(["renewal", "signout"])("a journaled B losing to %s is queued once, including after cleanup and after 30-day retention", async winner => {
    const s = await setup()
    await expireAccess(s.id)
    const b = await step(s, RecheckRole.redeem(s.id, s.services))
    if (winner === "renewal") await (await prepare(s.h, s.first.cookies))()
    else await runtime.runPromise(Store.revoke({ id: s.id }, "sign_out"))
    const cleanup = await import("./flows/RevokeReplacedGitHubToken.ts")
    expect(await step(s, RecheckRole.store(s.id, b))).toMatchObject({ outcome: "abandoned_enqueued" })
    await step(s, RecheckRole.store(s.id, b))
    const digest = Keys.digest(Redacted.value(s.h.github.issued[1]!.accessToken))
    const target = (await cleanups()).filter(r => r.pair === digest)
    expect(target).toHaveLength(1)
    await step(s, cleanup.revoke(target[0]!.id, s.services))
    expect(s.h.github.accepts(s.h.github.issued[1]!.accessToken)).toBe(false)
    expect((await cleanups()).find(r => r.pair === digest)).toMatchObject({ access: null, refresh: null, finished: true })
    await step(s, RecheckRole.store(s.id, b))
    expect((await cleanups()).filter(r => r.pair === digest)).toHaveLength(1)
    await query(sql => sql`UPDATE github_token_cleanups SET finished_at = now() - interval '31 days' WHERE pair_digest = ${digest}`)
    await step(s, cleanup.sweep())
    expect((await cleanups()).some(r => r.pair === digest)).toBe(false)
    await step(s, RecheckRole.store(s.id, b))
    const again = (await cleanups()).find(r => r.pair === digest)!
    await step(s, cleanup.revoke(again.id, s.services))
    expect((await cleanups()).find(r => r.id === again.id)!.finished).toBe(true)
  })

  test("pre-fence journals recover their pair digest and recognize already installed legacy ciphertext", async () => {
    const s = await setup()
    await expireAccess(s.id)
    const b = await step(s, RecheckRole.redeem(s.id, s.services))
    if (b.kind !== "redeemed") throw new Error("expected a redemption")
    const { pairDigest: _pair, ...tokens } = b.tokens
    const legacy = { kind: "redeemed" as const, presented: b.presented, tokens }
    expect(await step(s, RecheckRole.store(s.id, legacy, s.services))).toMatchObject({ outcome: "stored" })
    await query(sql => sql`UPDATE sessions SET github_pair_digest = NULL WHERE id = ${s.id}`)
    expect(await step(s, RecheckRole.store(s.id, legacy, s.services))).toMatchObject({ outcome: "installed_replay" })
    expect(await cleanups()).toEqual([])
    await (await prepare(s.h, s.first.cookies))()
    expect(await step(s, RecheckRole.store(s.id, legacy, s.services))).toMatchObject({ outcome: "abandoned_enqueued" })
    expect(await cleanups()).toHaveLength(1)
  })

  test("installed B replay enqueues nothing, including overlapping transactions held after BEGIN", async () => {
    const s = await setup()
    await expireAccess(s.id)
    const b = await step(s, RecheckRole.redeem(s.id, s.services))
    const ready = Deferred.makeUnsafe<void>()
    const release = Deferred.makeUnsafe<void>()
    let entered = 0
    const overlapping = () => runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, sql => sql.withTransaction(Effect.gen(function* () {
      if (++entered === 2) yield* Deferred.succeed(ready, undefined)
      yield* Deferred.await(release)
      return yield* RecheckRole.store(s.id, b)
    }))))
    const attempts = [overlapping(), overlapping()]
    await Effect.runPromise(Deferred.await(ready))
    Effect.runSync(Deferred.succeed(release, undefined))
    expect((await Promise.all(attempts)).map(r => r.outcome).sort()).toEqual(["installed_replay", "stored"])
    expect(await cleanups()).toEqual([])
    expect(await step(s, RecheckRole.store(s.id, b))).toMatchObject({ outcome: "installed_replay" })
    await (await prepare(s.h, s.first.cookies))()
    await step(s, RecheckRole.store(s.id, b))
    const digest = Keys.digest(Redacted.value(s.h.github.issued[1]!.accessToken))
    expect((await cleanups()).filter(r => r.pair === digest)).toHaveLength(1)
  })

  test("overlapping stores with a renewal between them enqueue B exactly once", async () => {
    const s = await setup()
    await expireAccess(s.id)
    const b = await step(s, RecheckRole.redeem(s.id, s.services))
    const ready = Deferred.makeUnsafe<void>()
    const release = Deferred.makeUnsafe<void>()
    const delayed = runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, sql => sql.withTransaction(Effect.gen(function* () {
      yield* Deferred.succeed(ready, undefined)
      yield* Deferred.await(release)
      return yield* RecheckRole.store(s.id, b)
    }))))
    await Effect.runPromise(Deferred.await(ready))
    expect(await step(s, RecheckRole.store(s.id, b))).toMatchObject({ outcome: "stored" })
    await (await prepare(s.h, s.first.cookies))()
    Effect.runSync(Deferred.succeed(release, undefined))
    expect(await delayed).toMatchObject({ outcome: "abandoned_enqueued" })
    const digest = Keys.digest(Redacted.value(s.h.github.issued[1]!.accessToken))
    expect((await cleanups()).filter(r => r.pair === digest)).toHaveLength(1)
  })

  test("a refused old refresh and stale role writes never change a renewed generation", async () => {
    const s = await setup()
    await expireAccess(s.id)
    s.h.github.faults.refresh = "rejected"
    const refused = await step(s, RecheckRole.redeem(s.id, s.services))
    delete s.h.github.faults.refresh
    await (await prepare(s.h, s.first.cookies))()
    await step(s, RecheckRole.check(s.id, refused, s.services))
    const [before] = await query(sql => sql<{ role: string; checked: string }>`SELECT role, role_checked_at::text AS checked FROM sessions WHERE id = ${s.id}`)
    await step(s, Store.setRole(s.id, "admin", await runtime.runPromise(Store.roleObservation), 0))
    await step(s, Store.keepRole(s.id, 0))
    expect(await step(s, Store.revokeIf(s.id, "github_refused", 0))).toEqual(Option.none())
    expect((await rows())[0]).toMatchObject({ revoked: false, gen: 1 })
    expect((await query(sql => sql<{ role: string; checked: string }>`SELECT role, role_checked_at::text AS checked FROM sessions WHERE id = ${s.id}`))[0]).toEqual(before)
  })

  test("a permission check paused across renewal cannot overwrite the new generation's role", async () => {
    const s = await setup()
    const redemption = await step(s, RecheckRole.redeem(s.id, s.services))
    const reached = Deferred.makeUnsafe<void>()
    const release = Deferred.makeUnsafe<void>()
    const services = { ...s.services, github: { ...s.services.github, permission: () => Effect.gen(function* () {
      yield* Deferred.succeed(reached, undefined)
      yield* Deferred.await(release)
      return "admin" as const
    }) } }
    const checking = step(s, RecheckRole.check(s.id, redemption, services))
    await Effect.runPromise(Deferred.await(reached))
    await (await prepare(s.h, s.first.cookies))()
    Effect.runSync(Deferred.succeed(release, undefined))
    await checking
    expect((await query(sql => sql<{ role: string }>`SELECT role FROM sessions WHERE id = ${s.id}`))[0]!.role).toBe("member")
    expect((await rows())[0]!.gen).toBe(1)
  })

  test.each(["before", "during", "after"])("cleanup %s a callback leaves the session live with the same tag", async timing => {
    const s = await setup()
    const before = await s.h.session(s.first.cookies)
    await (await prepare(s.h, s.first.cookies))()
    const [old] = await cleanups()
    const cleanup = await import("./flows/RevokeReplacedGitHubToken.ts")
    const entered = Deferred.makeUnsafe<void>()
    const release = Deferred.makeUnsafe<void>()
    const services = { ...s.services, github: { ...s.services.github, revoke: (token: Redacted.Redacted<string>) =>
      Effect.andThen(Deferred.succeed(entered, undefined), Effect.andThen(Deferred.await(release), s.services.github.revoke(token))) } }
    let pending: Promise<unknown> | undefined
    if (timing === "before") await step(s, cleanup.revoke(old!.id, s.services))
    if (timing === "during") {
      pending = step(s, cleanup.revoke(old!.id, services))
      await Effect.runPromise(Deferred.await(entered))
    }
    const response = await (await prepare(s.h, s.first.cookies))()
    expect(await s.h.session(values(response))).toMatchObject({ signedIn: true, session: (before as { session: string }).session })
    if (timing === "during") { Effect.runSync(Deferred.succeed(release, undefined)); await pending }
    if (timing === "after") await step(s, cleanup.revoke(old!.id, s.services))
    expect((await rows()).map(r => [r.id, r.revoked])).toEqual([[s.id, false]])
    expect(s.h.github.accepts(s.h.github.issued.at(-1)!.accessToken)).toBe(true)
  })

  test("a failed cleanup start is recoverable from the five-minute sweeper; recent rows and tombstones are left alone", async () => {
    const s = await setup(Flows.FlowStarter.of({ start: () => Effect.fail(new Flows.StartUnavailable({ errorCode: "offline" })) }))
    const response = await (await prepare(s.h, s.first.cookies))()
    expect(response.headers.get("location")).toBe("/app")
    const cleanup = await import("./flows/RevokeReplacedGitHubToken.ts")
    expect(await step(s, cleanup.sweep())).toEqual([])
    await query(sql => sql`UPDATE github_token_cleanups SET created_at = now() - interval '6 minutes'`)
    expect(await step(s, cleanup.sweep())).toEqual([(await cleanups())[0]!.id])
    expect(s.h.snapshot().some(m => m.id === "smithers_auth_token_cleanup" && m.attributes?.outcome === "retried")).toBe(true)
  })
})

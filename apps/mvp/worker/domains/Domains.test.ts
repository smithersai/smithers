// Custom domains end to end in the Worker (decision 0039, docs/features/domains.md): a Maintainer's adds, refreshes and
// removals through the real routes and the real `domain/Verify` and `domain/Remove` on the Node host's engine, the
// shape, and each refusal, on the compose Postgres and Electric. The provider is the real `Dns` adapter over a resolver
// scripted at the network; an unhappy path swaps in a faulty provider.
import { Action } from "@smthrs/flow"
import { Logger as StructuredLogger } from "@smthrs/observability"
import { Effect, Fiber, Logger, Metric, Option, Redacted } from "effect"
import { Layer } from "effect"
import { HttpEffect } from "effect/http"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest"
import { SqlClient } from "effect/sql"
import * as Database from "../../db/Database.ts"
import * as TestDatabase from "../../db/TestDatabase.ts"
import { DOMAIN_RESOLVE_ROUTE, DOMAINS_SHAPE_ROUTE, domainRoute, domainsRoute } from "../../src/features/domains/contract.ts"
import * as Flows from "../Flows.ts"
import { type Actor, personOnlyRefusals } from "../Actor.ts"
import * as WriteAuthority from "../WriteAuthority.ts"
import { eventually, testFile } from "../test/harness.ts"
import { incarnation } from "../test/flowHost.ts"
import * as DomainsApi from "./Api.ts"
import * as DomainFlows from "./DomainFlows.ts"
import { DomainProvider, HostnameRejected, HostnameTaken, ProviderUnavailable } from "./Provider.vibe"
import * as Store from "./Store.vibe"
import {
  admin,
  agent,
  domainsHarness,
  engine,
  events,
  guest,
  maintainer,
  member,
  network,
  REPO,
  REPO_ID,
  resetDomains,
  rows,
  seed,
  switchable,
  TARGET,
  type Zone,
} from "./test/harness.ts"

const runtime = testFile("domains")
const zone: Zone = new Map()
const resolver = { fail: false, lookups: 0 }
let net: ReturnType<typeof network>
let provider: ReturnType<typeof switchable>
let host: Awaited<ReturnType<typeof engine>>
beforeAll(async () => {
  const scratch = await runtime.runPromise(Effect.service(TestDatabase.Scratch))
  net = network(scratch.name, zone, resolver)
  provider = switchable(net.fetch)
  host = await engine(runtime, provider.layer)
})
afterAll(() => host.close())
beforeEach(() => resetDomains(runtime))
afterEach(() => {
  zone.clear()
  resolver.fail = false
  provider.reset()
})

const open = (options: { actor?: Parameters<typeof domainsHarness>[1]["actor"]; starter?: Flows.FlowStarter["Service"]; off?: boolean } = {}) =>
  domainsHarness(runtime, {
    actor: options.actor,
    starter: options.starter ?? host.starter,
    provider: options.off === true ? Option.none() : Option.some(provider.provider),
    fetch: net.fetch,
  })

const add = (hostname: unknown) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: typeof hostname === "string" && hostname.startsWith("{") ? hostname : JSON.stringify({ hostname }),
})
const remove = { method: "DELETE" }
const path = domainsRoute(REPO.owner, REPO.name)
const json = async (response: Response) => [response.status, await response.json()] as const

describe("POST /api/repos/<owner>/<name>/domains", () => {
  test("a Maintainer adds a subdomain that already points at the target: it is verified, its certificate the host's", async () => {
    zone.set("docs.example.com CNAME", [`${TARGET.toUpperCase()}.`])
    const h = await open({ actor: maintainer })
    expect(await json(await h.fetch(path, add(" Docs.Example.com. ")))).toEqual([202, { hostname: "docs.example.com" }])
    const [row] = await rows(runtime)
    expect(row).toMatchObject({
      hostname: "docs.example.com",
      repoId: REPO_ID,
      providerId: "docs.example.com",
      state: "active",
      verification: "active",
      certificate: "unmanaged",
      records: [{ type: "CNAME", name: "docs.example.com", value: TARGET }],
      problem: null,
      updatedBy: "person-maintainer",
    })
    expect(row!.checkedAt).toBeInstanceOf(Date)
    expect(row!.pollId).toMatch(/^domain-add:/)
    expect(await events(runtime)).toEqual([
      { hostname: "docs.example.com", action: "add", actorId: "person-maintainer", state: "pending", problem: null },
      { hostname: "docs.example.com", action: "check", actorId: null, state: "active", problem: null },
    ])
    expect(h.count(DomainsApi.requests, { op: "add", outcome: "adding" })).toBe(1)
    expect(h.line("domain.request")[0]).toMatchObject({ annotations: { repoId: REPO_ID, status: 202 } })
    // A hostname is the Maintainer's until it is published: no record carries it.
    expect(JSON.stringify(h.line("domain.request"))).not.toContain("docs.example.com")
  })

  test("an Admin adds an apex: the record to add is an ALIAS, and an address shared with the target proves nothing", async () => {
    zone.set("vibelang.example A", ["192.0.2.10"])
    zone.set(`${TARGET} A`, ["192.0.2.10"])
    const h = await open({ actor: admin, starter: host.detached })
    expect((await h.fetch(path, add("vibelang.example"))).status).toBe(202)
    await eventually(async () => (await rows(runtime))[0]?.checkedAt != null, 5_000)
    expect(await rows(runtime)).toMatchObject([
      { state: "pending", records: [{ type: "ALIAS", name: "vibelang.example", value: TARGET }] },
    ])
  })

  test("a domain DNS doesn't point at the target yet is pending, and the poll waits on", async () => {
    const h = await open({ actor: maintainer, starter: host.detached })
    expect((await h.fetch(path, add("docs.example.com"))).status).toBe(202)
    await eventually(async () => (await rows(runtime))[0]?.checkedAt != null, 5_000)
    expect(await rows(runtime)).toMatchObject([
      { state: "pending", verification: "pending", certificate: "unmanaged", problem: null },
    ])
  })

  test("adding a domain the repository holds refreshes it: a new poll owns it, registers it anew, its problem clears", async () => {
    await seed(runtime, { hostname: "docs.example.com", pollId: "poll-old", state: "failed", providerId: "forgotten" })
    zone.set("docs.example.com CNAME", [TARGET])
    const h = await open({ actor: maintainer })
    expect((await h.fetch(path, add("docs.example.com"))).status).toBe(202)
    const [row] = await rows(runtime)
    expect(row).toMatchObject({ state: "active", providerId: "docs.example.com" })
    expect(row!.pollId).not.toBe("poll-old")
    expect((await events(runtime)).map((event) => event.action)).toEqual(["refresh", "check"])
    expect(h.count(DomainsApi.requests, { op: "add", outcome: "refreshing" })).toBe(1)
  })

  test("another Cloudflare account's hostname fails as taken, and a blocked one with the provider's reason", async () => {
    const h = await open({ actor: maintainer })
    provider.use({ ensure: () => Effect.fail(new HostnameTaken()) })
    await h.fetch(path, add("taken.example.com"))
    provider.use({ ensure: () => Effect.fail(new HostnameRejected({ reason: "blocked" })) })
    await h.fetch(path, add("blocked.example.com"))
    expect(await rows(runtime)).toMatchObject([
      { hostname: "blocked.example.com", state: "failed", problem: "blocked" },
      { hostname: "taken.example.com", state: "failed", problem: "taken" },
    ])
  })

  test.each([
    ["signed out", null, 401, "authentication"],
    ["a Member", member, 403, "forbidden"],
    ["a Guest", guest, 403, "forbidden"],
    ["someone with no role", { ...member, role: null }, 403, "forbidden"],
    ["an agent acting for a Maintainer", agent, 403, "person_only"],
  ] as const)("%s is refused %i %s, and nothing starts", async (_, actor, status, code) => {
    const h = await open({ actor })
    expect(await json(await h.fetch(path, add("docs.example.com")))).toEqual([status, { code }])
    expect(await json(await h.fetch(domainRoute(REPO.owner, REPO.name, "docs.example.com"), remove))).toEqual([
      status,
      { code },
    ])
    expect(await rows(runtime)).toEqual([])
    if (code === "person_only") {
      expect(h.count(personOnlyRefusals, { act: "domain/add", by: "agent" })).toBe(1)
      expect(h.count(personOnlyRefusals, { act: "domain/remove", by: "agent" })).toBe(1)
    }
  })

  test.each([
    ["not JSON", "{", 400, "invalid"],
    ["no hostname", "{}", 400, "invalid"],
    ["a URL", "https://docs.example.com", 400, "invalid_hostname"],
    ["one label", "localhost", 400, "invalid_hostname"],
    ["an IP address", "192.0.2.1", 400, "invalid_hostname"],
    ["a wildcard", "*.example.com", 400, "invalid_hostname"],
    ["the deployment's zone", "smithers.test", 400, "reserved"],
    ["a name under it", "app.smithers.test", 400, "reserved"],
    ["the host asked on", "chat.test", 400, "reserved"],
  ] as const)("%s is refused %i %s", async (_, hostname, status, code) => {
    const h = await open({ actor: maintainer })
    expect(await json(await h.fetch(path, add(hostname)))).toEqual([status, { code }])
    expect(await rows(runtime)).toEqual([])
  })

  test("a body over 1 KiB is too_large; one that isn't UTF-8 is invalid", async () => {
    const h = await open({ actor: maintainer })
    expect(await json(await h.fetch(path, add("a".repeat(2_000))))).toEqual([413, { code: "too_large" }])
    expect(await json(await h.fetch(path, { method: "POST", body: new Uint8Array([0x7b, 0xff, 0xfe, 0x7d]) }))).toEqual([
      400,
      { code: "invalid" },
    ])
  })

  test("another repository's hostname is taken, and another repository is not_found", async () => {
    await seed(runtime, { hostname: "docs.example.com", repoId: "github/acme/other" })
    const h = await open({ actor: maintainer })
    expect(await json(await h.fetch(path, add("docs.example.com")))).toEqual([409, { code: "taken" }])
    expect(await json(await h.fetch(domainsRoute("acme", "other"), add("new.example.com")))).toEqual([
      404,
      { code: "not_found" },
    ])
    expect(await rows(runtime)).toMatchObject([{ repoId: "github/acme/other" }])
  })

  test("with no provider every route is off; a flow that can't start is unavailable; a wrong method is 405", async () => {
    expect(await json(await (await open({ actor: maintainer, off: true })).fetch(path, add("docs.example.com")))).toEqual([
      503,
      { code: "off" },
    ])
    // Only a Maintainer learns whether custom domains are configured.
    expect(await json(await (await open({ actor: null, off: true })).fetch(path, add("docs.example.com")))).toEqual([
      401,
      { code: "authentication" },
    ])
    expect(await json(await (await open({ actor: member, off: true })).fetch(path, add("docs.example.com")))).toEqual([
      403,
      { code: "forbidden" },
    ])
    const failing = Flows.FlowStarter.of({ start: () => Effect.fail(new Error("down")) as never })
    const down = await open({ actor: maintainer, starter: failing })
    expect(await json(await down.fetch(path, add("docs.example.com")))).toEqual([503, { code: "unavailable" }])
    expect(await json(await down.fetch(domainRoute(REPO.owner, REPO.name, "docs.example.com"), remove))).toEqual([
      503,
      { code: "unavailable" },
    ])
    const h = await open({ actor: maintainer })
    expect((await h.fetch(path, remove)).status).toBe(405)
    expect((await h.fetch(path, { method: "GET" })).headers.get("allow")).toBe("POST")
    expect((await h.fetch(domainRoute(REPO.owner, REPO.name, "a.example.com"), add("x"))).headers.get("allow")).toBe(
      "DELETE",
    )
  })

  test("a failure no refusal names answers unavailable with its code logged", async () => {
    const throwing = Flows.FlowStarter.of({ start: () => Effect.die(new Error("boom")) })
    const h = await open({ actor: maintainer, starter: throwing })
    expect(await json(await h.fetch(path, add("docs.example.com")))).toEqual([503, { code: "unavailable" }])
    expect(h.line("domain.request")[0]!.annotations).toHaveProperty("errorCode")
  })
})

describe("DELETE /api/repos/<owner>/<name>/domains/<hostname>", () => {
  test("a Maintainer removes a domain: the provider forgets it and the row goes", async () => {
    zone.set("docs.example.com CNAME", [TARGET])
    const removed: Array<string> = []
    provider.use({ remove: (id) => Effect.sync(() => void removed.push(id)) })
    const h = await open({ actor: maintainer })
    await h.fetch(path, add("docs.example.com"))
    expect(await json(await h.fetch(domainRoute(REPO.owner, REPO.name, "Docs.Example.com"), remove))).toEqual([
      202,
      { hostname: "docs.example.com" },
    ])
    expect(await rows(runtime)).toEqual([])
    expect(removed).toEqual(["docs.example.com"])
    expect((await events(runtime)).map((event) => event.action)).toEqual(["add", "check", "remove"])
  })

  test("an old provider completion leaves a replacement that is itself being removed", async () => {
    const hostname = "docs.example.com"
    await seed(runtime, { hostname, pollId: "old-poll", providerId: "cf-old", state: "active" })
    const h = await open({ actor: maintainer })
    const route = domainRoute(REPO.owner, REPO.name, hostname)
    let arrived!: () => void, finish!: () => void
    const firstArrived = new Promise<void>((resolve) => { arrived = resolve })
    const firstGate = new Promise<void>((resolve) => { finish = resolve })
    let replacementArrived!: () => void, finishReplacement!: () => void
    const replacing = new Promise<void>((resolve) => { replacementArrived = resolve })
    const replacementGate = new Promise<void>((resolve) => { finishReplacement = resolve })
    let oldAttempts = 0
    provider.use({
      ensure: () => Effect.succeed({ id: "cf-new", records: [], verification: "active", certificate: "active" }),
      remove: (id) => Effect.promise(async () => {
        if (id === "cf-old" && ++oldAttempts === 1) {
          arrived()
          await firstGate
        }
        if (id === "cf-new") {
          replacementArrived()
          await replacementGate
        }
      }),
    })
    const first = h.fetch(route, remove)
    try {
      await firstArrived
      expect((await h.fetch(route, remove)).status).toBe(202)
      expect(await rows(runtime)).toEqual([])
      expect((await h.fetch(path, add(hostname))).status).toBe(202)
      const replacement = h.fetch(route, remove)
      await replacing
      finish()
      expect((await first).status).toBe(202)
      expect(host.exits.at(-1)).toMatchObject({ _tag: "Success", value: { change: "superseded" } })
      expect(await rows(runtime)).toMatchObject([{ providerId: "cf-new", state: "removing" }])
      finishReplacement()
      expect((await replacement).status).toBe(202)
      expect(await rows(runtime)).toEqual([])
    } finally {
      finish()
      finishReplacement()
    }
  })

  test("removing a domain the repository doesn't hold changes nothing, and an invalid hostname is refused", async () => {
    await seed(runtime, { hostname: "docs.example.com", repoId: "github/acme/other" })
    const h = await open({ actor: maintainer })
    expect((await h.fetch(domainRoute(REPO.owner, REPO.name, "docs.example.com"), remove)).status).toBe(202)
    expect(await rows(runtime)).toMatchObject([{ state: "pending" }])
    expect(await json(await h.fetch(domainRoute(REPO.owner, REPO.name, "bad_host"), remove))).toEqual([
      400,
      { code: "invalid_hostname" },
    ])
  })
})

describe("domain/Verify", () => {
  test("a later attempt checks without claiming: the row its poll owns turns active", async () => {
    await seed(runtime, { hostname: "docs.example.com", pollId: "poll-later" })
    zone.set("docs.example.com CNAME", [TARGET])
    await Effect.runPromise(
      host.starter.start(DomainFlows.Verify, {
        executionId: "poll-later",
        payload: {
          repoId: REPO_ID,
          hostname: "docs.example.com",
          authority: null, actorId: "p",
          pollId: "poll-later",
          refresh: true,
          attempt: 2,
        },
      }),
    )
    expect(await rows(runtime)).toMatchObject([{ state: "active", pollId: "poll-later" }])
    expect((await events(runtime)).map((event) => event.action)).toEqual(["check"])
  })
})

describe("replacement registration cleanup", () => {
  test.each([
    [null, false],
    [null, true],
    ["cf-obsolete", false],
    ["cf-obsolete", true],
  ] as const)("removal during registration from %s retains cleanup through a provider failure: %s", async (providerId, failOnce) => {
    const hostname = "docs.example.com"
    const pollId = crypto.randomUUID()
    await seed(runtime, { hostname, pollId, ...(providerId === null ? {} : { providerId }) })
    const removed: Array<string> = []
    let cleanupAttempts = 0
    const h = await open({ actor: maintainer })
    provider.use({
      status: () => Effect.succeed(Option.none()),
      ensure: () => Effect.gen(function* () {
        const response = yield* Effect.promise(() => h.fetch(domainRoute(REPO.owner, REPO.name, hostname), remove))
        expect(response.status).toBe(202)
        return { id: "cf-replacement", records: [], verification: "active", certificate: "active" } as const
      }),
      remove: (id) => Effect.suspend(() => {
        if (id === "cf-replacement" && ++cleanupAttempts === 1 && failOnce) {
          return Effect.fail(new ProviderUnavailable({ code: "http_503" }))
        }
        return Effect.sync(() => void removed.push(id))
      }),
    })
    await Effect.runPromise(host.starter.start(DomainFlows.Verify, {
      executionId: pollId,
      payload: { repoId: REPO_ID, hostname, authority: null, actorId: "p", pollId, refresh: true, attempt: 2 },
    }))
    expect(host.exits.at(-1)).toMatchObject({ _tag: "Success" })
    expect(await rows(runtime)).toEqual([])
    expect(removed).toEqual(providerId === null ? ["cf-replacement"] : [providerId, "cf-replacement"])
    expect(cleanupAttempts).toBe(failOnce ? 2 : 1)
  })
})

describe("durable registration cleanup", () => {
  test("a host restart resumes cleanup from the sealed id after the domain row is gone", async () => {
    const hostname = "docs.example.com"
    const pollId = crypto.randomUUID()
    const payload = { repoId: REPO_ID, hostname, authority: null, actorId: "p", pollId, refresh: true, attempt: 2 }
    await seed(runtime, { hostname, pollId, providerId: "cf-obsolete" })
    const scratch = await runtime.runPromise(Effect.service(TestDatabase.Scratch))
    const registration = DomainFlows.registration(scratch.database, provider.layer)
    const h = await open({ actor: maintainer })
    let ensured = 0
    let cleaning = false
    const removed: Array<string> = []
    provider.use({
      status: () => Effect.succeed(Option.none()),
      ensure: () => Effect.gen(function* () {
        ensured++
        yield* Effect.promise(() => h.fetch(domainRoute(REPO.owner, REPO.name, hostname), remove))
        return { id: "cf-replacement", records: [], verification: "active", certificate: "active" } as const
      }),
      remove: (id) => id === "cf-replacement"
        ? Effect.andThen(Effect.sync(() => { cleaning = true }), Effect.never)
        : Effect.void,
    })
    const first = await incarnation(registration)
    let second: Awaited<ReturnType<typeof incarnation>> | undefined
    const running = Effect.runFork(first.execute(DomainFlows.Verify, pollId, payload))
    try {
      await eventually(() => cleaning, 10_000)
      expect(await rows(runtime)).toEqual([])
      await first.crash()
      provider.use({ remove: (id) => Effect.sync(() => void removed.push(id)) })
      second = await incarnation(registration, first.engine.schema)
      expect(await Effect.runPromise(second.execute(DomainFlows.Verify, pollId, payload))).toMatchObject({ _tag: "Success" })
      expect(ensured).toBe(1)
      expect(removed).toEqual(["cf-replacement"])
      expect(await rows(runtime)).toEqual([])
    } finally {
      await Effect.runPromise(Fiber.interrupt(running))
      await second?.close()
      await first.close()
    }
  })
})

describe("the steps", () => {
  const keyed = <A, E>(effect: Effect.Effect<A, E, any>, key = "step-1") =>
    Effect.runPromise(
      Effect.provideService(effect, Action.CurrentInvocationKey, key).pipe(
        Effect.provide(provider.layer),
      ) as Effect.Effect<A, E>,
    )
  const database = async () => (await runtime.runPromise(Effect.service(TestDatabase.Scratch))).database
  const input = {
    repoId: REPO_ID,
    hostname: "docs.example.com",
    actorId: "person-maintainer",
    pollId: "poll-1",
    refresh: false,
    authority: null,
  }

  test("a check that can't reach the provider records unreachable and waits; the last attempt times out", async () => {
    const { claim, check } = DomainFlows.steps(await database())
    await keyed(claim(input))
    provider.use({ ensure: () => Effect.fail(new ProviderUnavailable({ code: "timeout" })) })
    expect(await keyed(check({ ...input, attempt: 1 }))).toEqual({ satisfied: false, output: "pending" })
    expect(await rows(runtime)).toMatchObject([{ state: "pending", problem: "unreachable", providerId: null }])
    expect(await keyed(check({ ...input, attempt: DomainFlows.VERIFY_ATTEMPTS }))).toEqual({
      satisfied: true,
      output: "failed",
    })
    expect(await rows(runtime)).toMatchObject([{ state: "failed", problem: "timed_out" }])
  })

  test("a domain still pending at the last attempt times out; one the provider forgot is registered anew", async () => {
    const { claim, check } = DomainFlows.steps(await database())
    await keyed(claim(input))
    expect(await keyed(check({ ...input, attempt: DomainFlows.VERIFY_ATTEMPTS }))).toEqual({
      satisfied: true,
      output: "failed",
    })
    await resetDomains(runtime)
    await seed(runtime, { hostname: "docs.example.com", pollId: "poll-2", providerId: "cf-gone" })
    provider.use({ status: () => Effect.succeed(Option.none()) })
    expect(await keyed(check({ ...input, pollId: "poll-2", attempt: 2 }))).toEqual({ satisfied: false, output: "pending" })
    expect(await rows(runtime)).toMatchObject([{ state: "pending", providerId: "docs.example.com", problem: null }])
  })

  test("with no provider, the last attempt times out", async () => {
    const { claim, check } = DomainFlows.steps(await database())
    await keyed(claim(input))
    const last = await Effect.runPromise(
      check({ ...input, attempt: DomainFlows.VERIFY_ATTEMPTS }).pipe(
        Effect.provideService(Action.CurrentInvocationKey, "step-9"),
        Effect.provide(DomainProvider.off),
      ) as Effect.Effect<unknown>,
    )
    expect(last).toEqual({ satisfied: true, output: "failed" })
    expect(await rows(runtime)).toMatchObject([{ state: "failed", problem: "timed_out" }])
  })

  test("a refresh keeps the registration and the state, so a removal right after it forgets the registration", async () => {
    const { claim, release } = DomainFlows.steps(await database())
    await seed(runtime, { hostname: "docs.example.com", pollId: "poll-0", providerId: "cf-1", state: "active" })
    expect(await keyed(claim({ ...input, refresh: true }))).toEqual({ change: "refresh" })
    expect(await rows(runtime)).toMatchObject([{ state: "active", providerId: "cf-1", pollId: "poll-1" }])
    const forgotten: Array<string> = []
    provider.use({ remove: (id) => Effect.sync(() => void forgotten.push(id)) })
    expect(await keyed(release(input), "step-2")).toEqual({
      change: "released",
    })
    expect(forgotten).toEqual(["cf-1"])
  })

  test("a poll ends once its row is removed, refreshed by another poll or with no provider records unreachable", async () => {
    const { claim, check } = DomainFlows.steps(await database())
    expect(await keyed(check({ ...input, attempt: 2 }))).toEqual({ satisfied: true, output: "superseded" })
    await keyed(claim(input))
    expect(await keyed(check({ ...input, pollId: "poll-0", attempt: 2 }))).toEqual({
      satisfied: true,
      output: "superseded",
    })
    expect(await keyed(claim(input))).toEqual({ change: "repeat" })
    const off = await Effect.runPromise(
      check({ ...input, attempt: 2 }).pipe(
        Effect.provideService(Action.CurrentInvocationKey, "step-3"),
        Effect.provide(DomainProvider.off),
      ) as Effect.Effect<unknown>,
    )
    expect(off).toEqual({ satisfied: false, output: "pending" })
    expect(await rows(runtime)).toMatchObject([{ problem: "unreachable" }])
  })

  test("a legacy release with a withdrawal receipt finishes after the provider recovers", async () => {
    const { release } = DomainFlows.steps(await database())
    await seed(runtime, { hostname: "docs.example.com", providerId: "cf-1", state: "active" })
    provider.use({ remove: () => Effect.fail(new ProviderUnavailable({ code: "http_500" })) })
    const exit = await Effect.runPromiseExit(
      release({ repoId: REPO_ID, hostname: "docs.example.com", authority: null, actorId: "p", pollId: "poll-seed" }).pipe(
        Effect.provideService(Action.CurrentInvocationKey, "step-1"),
        Effect.provide(provider.layer),
      ),
    )
    expect(JSON.stringify(exit)).toContain("@smthrs/mvp/domains/ReleaseUnavailable")
    expect(await rows(runtime)).toMatchObject([{ state: "removing" }])
    const forgotten: Array<string> = []
    provider.use({ remove: (id) => Effect.sync(() => void forgotten.push(id)) })
    expect(await keyed(release({ repoId: REPO_ID, hostname: "docs.example.com", authority: null, actorId: "p" }))).toEqual({
      change: "released",
    })
    expect(forgotten).toEqual(["cf-1"])
    expect(await rows(runtime)).toEqual([])
    expect((await events(runtime)).map((event) => event.action)).toEqual(["remove"])
    expect(await keyed(release({ repoId: REPO_ID, hostname: "docs.example.com", authority: null, actorId: "p" }))).toEqual({
      change: "missing",
    })
  })

  test("a retried release finishes only its own removal: a domain added again after it erased the row stays", async () => {
    const db = await database()
    const { claim, release } = DomainFlows.steps(db)
    await seed(runtime, { hostname: "docs.example.com", providerId: "cf-1", state: "active" })
    const forgotten: Array<string> = []
    provider.use({ remove: (id) => Effect.sync(() => void forgotten.push(id)) })
    const removal = { repoId: REPO_ID, hostname: "docs.example.com", authority: null, actorId: "p", pollId: "poll-seed" }
    expect(await keyed(release(removal))).toEqual({ change: "released" })
    // The step erased the row but the engine never sealed it; the domain is added again before the retry.
    expect(await keyed(claim({ ...input, pollId: "poll-2" }), "step-2")).toEqual({ change: "add" })
    await Effect.runPromise(
      Effect.provide(
        Store.record({ hostname: "docs.example.com", pollId: "poll-2", providerId: "cf-2", state: "active", problem: null, authority: null }),
        db,
      ) as Effect.Effect<unknown>,
    )
    expect(await keyed(release(removal))).toEqual({ change: "missing" })
    expect(forgotten).toEqual(["cf-1"])
    expect(await rows(runtime)).toMatchObject([{ state: "active", providerId: "cf-2", pollId: "poll-2" }])
  })

  test("a claim of another repository's hostname is taken and changes nothing", async () => {
    const { claim } = DomainFlows.steps(await database())
    await seed(runtime, { hostname: "docs.example.com", repoId: "github/acme/other" })
    expect(await keyed(claim(input))).toEqual({ change: "taken" })
    expect(await rows(runtime)).toMatchObject([{ repoId: "github/acme/other", pollId: "poll-seed" }])
    expect(await events(runtime)).toEqual([])
  })

  test("with no provider, a release of a registered domain waits rather than orphan it; an unregistered one goes", async () => {
    const { release } = DomainFlows.steps(await database())
    await seed(runtime, { hostname: "docs.example.com", providerId: "cf-1" })
    await seed(runtime, { hostname: "new.example.com" })
    const off = (hostname: string) =>
      Effect.runPromiseExit(
        release({ repoId: REPO_ID, hostname, authority: null, actorId: "p", pollId: "poll-seed" }).pipe(
          Effect.provideService(Action.CurrentInvocationKey, `step-${hostname}`),
          Effect.provide(DomainProvider.off),
        ),
      )
    expect(JSON.stringify(await off("docs.example.com"))).toContain("@smthrs/mvp/domains/ReleaseUnavailable")
    expect(JSON.stringify(await off("new.example.com"))).toContain("released")
    expect(await rows(runtime)).toMatchObject([{ hostname: "docs.example.com", state: "removing" }])
  })

  test("a refresh that runs after the removal it raced never adds the domain back", async () => {
    const { claim, check } = DomainFlows.steps(await database())
    expect(await keyed(claim({ ...input, refresh: true }))).toEqual({ change: "missing" })
    expect(await keyed(check({ ...input, attempt: 1 }))).toEqual({ satisfied: true, output: "superseded" })
    expect(await rows(runtime)).toEqual([])
    expect(await events(runtime)).toEqual([])
  })

  test("a refresh while a removal is in flight changes nothing; that removal's poll ends", async () => {
    const { claim, check } = DomainFlows.steps(await database())
    await seed(runtime, { hostname: "docs.example.com", pollId: "poll-1", state: "removing" })
    expect(await keyed(claim({ ...input, pollId: "poll-2" }))).toEqual({ change: "removing" })
    expect(await keyed(check({ ...input, pollId: "poll-1", attempt: 2 }))).toEqual({ satisfied: true, output: "superseded" })
    expect(await rows(runtime)).toMatchObject([{ state: "removing", pollId: "poll-1" }])
  })

  test("a removed check returns its new registration for durable cleanup; a superseded one keeps it", async () => {
    const { claim, check, cleanup } = DomainFlows.steps(await database())
    await keyed(claim(input))
    const forgotten: Array<string> = []
    provider.use({
      ensure: (hostname) =>
        Effect.as(Effect.promise(() => resetDomains(runtime)), {
          id: "cf-" + hostname,
          records: [],
          verification: "pending",
          certificate: "pending",
        } as const),
      remove: (id) => Effect.sync(() => void forgotten.push(id)),
    })
    expect(await keyed(check({ ...input, attempt: 2 }))).toEqual({
      satisfied: true, output: "superseded", cleanupId: "cf-docs.example.com",
    })
    expect(forgotten).toEqual([])
    const pending = { repoId: REPO_ID, hostname: input.hostname, pollId: input.pollId, providerId: "cf-docs.example.com" }
    provider.use({ remove: () => Effect.fail(new ProviderUnavailable({ code: "http_503" })) })
    expect(JSON.stringify(await Effect.runPromiseExit(
      cleanup(pending).pipe(Effect.provide(provider.layer)),
    ))).toContain("@smthrs/mvp/domains/ReleaseUnavailable")
    expect(JSON.stringify(await Effect.runPromiseExit(
      cleanup(pending).pipe(Effect.provide(DomainProvider.off)),
    ))).toContain("@smthrs/mvp/domains/ReleaseUnavailable")
    provider.use({ remove: (id) => Effect.sync(() => void forgotten.push(id)) })
    expect(await keyed(cleanup(pending))).toEqual({ satisfied: true, output: "superseded" })
    expect(forgotten).toEqual(["cf-docs.example.com"])
    await keyed(claim(input), "step-2")
    // A refresh takes the row over while this check registers it: the newer poll keeps the registration.
    provider.use({
      ensure: () =>
        Effect.as(Effect.promise(() => keyed(claim({ ...input, pollId: "poll-3" }), "step-3")), {
          id: "cf-kept",
          records: [],
          verification: "pending",
          certificate: "pending",
        } as const),
      remove: (id) => Effect.sync(() => void forgotten.push(id)),
    })
    expect(await keyed(check({ ...input, attempt: 2 }))).toEqual({ satisfied: true, output: "superseded" })
    expect(forgotten).toEqual(["cf-docs.example.com"])
  })

  test("cleanup after an outage preserves the registration a new poll adopted", async () => {
    const { claim, check, cleanup } = DomainFlows.steps(await database())
    const pending = { repoId: REPO_ID, hostname: input.hostname, pollId: "removed-poll", providerId: "cf-replacement" }
    provider.use({ remove: () => Effect.fail(new ProviderUnavailable({ code: "http_503" })) })
    expect(JSON.stringify(await Effect.runPromiseExit(
      cleanup(pending).pipe(Effect.provide(provider.layer)),
    ))).toContain("@smthrs/mvp/domains/ReleaseUnavailable")
    await keyed(claim(input))
    provider.use({
      ensure: () => Effect.succeed({
        id: pending.providerId, records: [], verification: "active", certificate: "active",
      } as const),
      remove: () => Effect.die(new Error("must retain the adopted registration")),
    })
    expect(await keyed(check({ ...input, attempt: 1 }))).toEqual({ satisfied: true, output: "active" })
    expect(await keyed(cleanup(pending))).toEqual({ satisfied: true, output: "superseded" })
    expect(await rows(runtime)).toMatchObject([{ providerId: pending.providerId, state: "active", pollId: input.pollId }])
    expect(await runtime.runPromise(Store.active(input.hostname))).toBe(true)
  })

  test("cleanup stays retryable until a newer poll records its id or is removed", async () => {
    const { claim, release, cleanup } = DomainFlows.steps(await database())
    const pending = { repoId: REPO_ID, hostname: input.hostname, pollId: "removed-poll", providerId: "cf-replacement" }
    await keyed(claim(input))
    const forgotten: Array<string> = []
    provider.use({ remove: (id) => Effect.sync(() => void forgotten.push(id)) })
    expect(JSON.stringify(await Effect.runPromiseExit(cleanup(pending).pipe(Effect.provide(provider.layer)))))
      .toContain("@smthrs/mvp/domains/ReleaseUnavailable")
    expect(forgotten).toEqual([])
    // The new poll is removed before its check can adopt the registration.
    expect(await keyed(release(input), "remove-new"))
      .toEqual({ change: "released" })
    expect(await keyed(cleanup(pending))).toEqual({ satisfied: true, output: "superseded" })
    expect(forgotten).toEqual(["cf-replacement"])
    expect(await rows(runtime)).toEqual([])
    expect(await runtime.runPromise(Store.active(input.hostname))).toBe(false)
  })

  test("a newer removing poll with an obsolete id does not inherit replacement cleanup", async () => {
    const { cleanup } = DomainFlows.steps(await database())
    await seed(runtime, { hostname: input.hostname, pollId: "newer-poll", providerId: "cf-obsolete", state: "removing" })
    const forgotten: Array<string> = []
    provider.use({ remove: (id) => Effect.sync(() => void forgotten.push(id)) })
    expect(await keyed(cleanup({ repoId: REPO_ID, hostname: input.hostname, pollId: "older-poll", providerId: "cf-replacement" })))
      .toEqual({ satisfied: true, output: "superseded" })
    expect(forgotten).toEqual(["cf-replacement"])
    expect(await rows(runtime)).toMatchObject([{ providerId: "cf-obsolete", state: "removing" }])
  })

  test("a new claim waits until cleanup finishes deleting the registration", async () => {
    const { claim, cleanup } = DomainFlows.steps(await database())
    const pending = { repoId: REPO_ID, hostname: input.hostname, pollId: "removed-poll", providerId: "cf-replacement" }
    let announce!: () => void
    let finish!: () => void
    const started = new Promise<void>((resolve) => { announce = resolve })
    const gate = new Promise<void>((resolve) => { finish = resolve })
    provider.use({ remove: () => Effect.promise(() => { announce(); return gate }) })
    const cleaning = keyed(cleanup(pending))
    await started
    let added = false
    const adding = keyed(claim(input)).then((result) => { added = true; return result })
    try {
      await eventually(async () => added || await runtime.runPromise(
        Effect.flatMap(SqlClient.SqlClient, (sql) =>
          Effect.map(sql<{ waiting: boolean }>`SELECT EXISTS (
            SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND NOT granted
          ) AS waiting`, (rows) => rows[0]!.waiting)),
      ), 5_000)
      expect(added).toBe(false)
    } finally {
      finish()
      await cleaning
    }
    expect(await adding).toEqual({ change: "add" })
    expect(await rows(runtime)).toMatchObject([{ pollId: input.pollId, providerId: null }])
  })

  test("cleanup also forgets a replacement while its original row is still removing", async () => {
    const db = await database()
    const { claim, check, cleanup } = DomainFlows.steps(db)
    await keyed(claim(input))
    provider.use({
      ensure: () => Effect.gen(function* () {
        yield* Store.withdraw({ ...input, invocationKey: "removing" })
          .pipe(Effect.provide(db), Effect.orDie)
        return { id: "cf-new", records: [], verification: "pending", certificate: "pending" } as const
      }),
    })
    expect(await keyed(check({ ...input, attempt: 1 }))).toEqual({
      satisfied: true, output: "superseded", cleanupId: "cf-new",
    })
    expect(await keyed(cleanup({ repoId: REPO_ID, hostname: input.hostname, pollId: input.pollId, providerId: "cf-new" })))
      .toEqual({ satisfied: true, output: "superseded" })
    expect(await rows(runtime)).toMatchObject([{ state: "removing", pollId: input.pollId }])
  })

  test("a removed check that only read the old registration leaves cleanup to the removal", async () => {
    const { check } = DomainFlows.steps(await database())
    await seed(runtime, { hostname: input.hostname, pollId: input.pollId, providerId: "cf-known" })
    provider.use({
      status: () => Effect.as(Effect.promise(() => resetDomains(runtime)), Option.some({
        id: "cf-known", records: [], verification: "active", certificate: "active",
      } as const)),
    })
    expect(await keyed(check({ ...input, attempt: 2 }))).toEqual({ satisfied: true, output: "superseded" })
  })

  test("a step whose database can't be reached fails as StoreUnavailable; one with no invocation key dies", async () => {
    const unreachable = Database.layer(Effect.succeed(Redacted.make("postgresql://smithers:smithers@127.0.0.1:1/smithers")))
    const down = DomainFlows.steps(unreachable)
    for (
      const effect of [
        down.claim(input),
        down.check({ ...input, attempt: 1 }),
        down.release({ repoId: REPO_ID, hostname: "x.example.com", authority: null, actorId: "p" }),
      ] as Array<Effect.Effect<unknown, unknown, any>>
    ) {
      const exit = await Effect.runPromiseExit(
        effect.pipe(Effect.provideService(Action.CurrentInvocationKey, "k"), Effect.provide(provider.layer)) as Effect.Effect<
          unknown,
          unknown
        >,
      )
      expect(JSON.stringify(exit)).toContain("@smthrs/mvp/domains/StoreUnavailable")
    }
    const { claim } = DomainFlows.steps(await database())
    expect(JSON.stringify(await Effect.runPromiseExit(claim(input) as Effect.Effect<unknown, unknown>))).toContain(
      "NoInvocationKey",
    )
  })

  test("a registration's state: active once verified with a certificate or none to manage, failed on either failing", () => {
    const of = (verification: "pending" | "active" | "failed", certificate: "pending" | "active" | "failed" | "unmanaged") =>
      DomainFlows.stateOf({ id: "x", records: [], verification, certificate })
    expect(of("active", "active")).toBe("active")
    expect(of("active", "unmanaged")).toBe("active")
    expect(of("active", "pending")).toBe("pending")
    expect(of("pending", "active")).toBe("pending")
    expect(of("failed", "active")).toBe("failed")
    expect(of("active", "failed")).toBe("failed")
  })

  test("erase preserves a withdrawn registration for legacy or unauthorized callers", async () => {
    const hostname = "docs.example.com"
    const pollId = "poll-1"
    const registration = { hostname, repoId: REPO_ID, pollId }
    await seed(runtime, { hostname, pollId, providerId: "provider-1", state: "removing" })

    expect(await runtime.runPromise(Store.erase(hostname, null))).toBe("stale")
    expect(await runtime.runPromise(Store.erase(registration))).toBe("stale")
    expect(await rows(runtime)).toMatchObject([
      { ...registration, providerId: "provider-1", state: "removing" },
    ])
  })

  test("the store keeps a check's verdicts it didn't get, and writes nothing for a poll that lost the row", async () => {
    const db = await database()
    await seed(runtime, { hostname: "docs.example.com", pollId: "poll-1" })
    const run = <A>(effect: Effect.Effect<A, unknown, any>) => Effect.runPromise(Effect.provide(effect, db) as Effect.Effect<A>)
    expect(await run(Store.record({ hostname: "docs.example.com", pollId: "poll-1", state: "pending", problem: null, authority: null })))
      .toBe("written")
    expect(await run(Store.record({ hostname: "docs.example.com", pollId: "poll-9", state: "active", problem: null, authority: null })))
      .toBe("superseded")
    expect(await run(Store.record({ hostname: "gone.example.com", pollId: "poll-1", state: "active", problem: null, authority: null })))
      .toBe("removed")
    expect(await rows(runtime)).toMatchObject([{ state: "pending", verification: "pending", records: [] }])
    expect(await events(runtime)).toEqual([])
  })
})

describe("authority held through the flows", () => {
  const query = <A extends object>(f: (sql: SqlClient.SqlClient) => Effect.Effect<ReadonlyArray<A>, unknown>) =>
    runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, f))
  /** A person signed in for real: a session row whose role was confirmed now. */
  const person = async (role: "maintainer" | "admin") => {
    const id = crypto.randomUUID(), session = crypto.randomUUID()
    await query((sql) => sql`INSERT INTO people (id, github_id, github_login)
      VALUES (${id}, ${Math.floor(Math.random() * 1e9)}, ${`writer-${id}`})`)
    await query((sql) => sql`
      INSERT INTO sessions (id, token_digest, person_id, role, role_checked_at, role_verified_at, expires_at)
      VALUES (${session}, ${session}, ${id}, ${role}, clock_timestamp(), clock_timestamp(),
        clock_timestamp() + interval '1 day')`)
    const actor: Actor = { subject: { kind: "person", id }, role, login: "writer", session, cookieKey: "legacy" }
    return { id, session, actor, authority: WriteAuthority.protectedOf(actor) }
  }
  type Person = Awaited<ReturnType<typeof person>>
  /** GitHub now says the person is only a Member, confirmed this instant. */
  const demote = (who: Person) =>
    query((sql) => sql`UPDATE sessions SET role = 'member', role_checked_at = clock_timestamp(),
      role_verified_at = clock_timestamp() WHERE id = ${who.session}`)
  const signOut = (who: Person) => query((sql) => sql`UPDATE sessions SET revoked_at = clock_timestamp() WHERE id = ${who.session}`)
  const signBackIn = (who: Person) => query((sql) => sql`UPDATE sessions SET revoked_at = NULL WHERE id = ${who.session}`)
  const keyed = <A, E>(effect: Effect.Effect<A, E, any>, key = "step-1") =>
    Effect.runPromise(
      Effect.provideService(effect, Action.CurrentInvocationKey, key).pipe(
        Effect.provide(provider.layer),
      ) as Effect.Effect<A, E>,
    )
  const database = async () => (await runtime.runPromise(Effect.service(TestDatabase.Scratch))).database
  const hostname = "docs.example.com"
  const verify = (who: Person) => ({
    authority: who.authority,
    repoId: REPO_ID,
    hostname,
    actorId: who.id,
    pollId: "poll-1",
    refresh: false,
  })
  /** A provider that counts what it is asked to change. */
  const counting = () => {
    const calls = { ensure: 0, status: 0, remove: 0 }
    provider.use({
      ensure: (name) =>
        Effect.sync(() => {
          calls.ensure++
          return { id: `cf-${name}`, records: [], verification: "active" as const, certificate: "active" as const }
        }),
      status: () => Effect.sync(() => (calls.status++, Option.none())),
      remove: () => Effect.sync(() => void calls.remove++),
    })
    return calls
  }

  test("the routes hand each flow the session and role scope they admitted", async () => {
    const who = await person("maintainer")
    const started: Array<{ readonly flow: unknown; readonly payload: unknown }> = []
    const starter = Flows.FlowStarter.of({
      start: (flow, { payload }) => Effect.sync(() => void started.push({ flow, payload })),
    })
    const h = await open({ actor: who.actor, starter })
    expect((await h.fetch(path, add(hostname))).status).toBe(202)
    expect((await h.fetch(domainRoute(REPO.owner, REPO.name, hostname), remove)).status).toBe(202)
    const authority = { personId: who.id, sessionId: who.session, cookieKey: "legacy", scope: { _tag: "Deployment" } }
    expect(started.map((start) => start.flow)).toEqual([DomainFlows.Verify, DomainFlows.Remove])
    expect(started.map((start) => start.payload)).toMatchObject([
      { authority, actorId: who.id },
      { authority, actorId: who.id },
    ])
  })

  test("a signed-in Maintainer adds and removes a domain through the real flows while the authority holds", async () => {
    const who = await person("maintainer")
    zone.set(`${hostname} CNAME`, [TARGET])
    const h = await open({ actor: who.actor })
    expect((await h.fetch(path, add(hostname))).status).toBe(202)
    expect(await rows(runtime)).toMatchObject([{ state: "active", updatedBy: who.id }])
    expect((await h.fetch(domainRoute(REPO.owner, REPO.name, hostname), remove)).status).toBe(202)
    expect(await rows(runtime)).toEqual([])
  })

  test("a delayed legacy removal without a withdrawal receipt leaves a reclaimed hostname active", async () => {
    const who = await person("maintainer")
    const legacy = { authority: who.authority, actorId: who.id, repoId: REPO_ID, hostname }
    await seed(runtime, { hostname, pollId: "original", providerId: "cf-original", state: "active" })
    const calls = counting()
    const h = await open({ actor: who.actor })
    expect((await h.fetch(domainRoute(REPO.owner, REPO.name, hostname), remove)).status).toBe(202)
    expect((await h.fetch(path, add(hostname))).status).toBe(202)
    const replacement = await rows(runtime)
    expect(replacement).toMatchObject([{ state: "active", providerId: `cf-${hostname}` }])

    for (const binding of [{}, { pollId: null }, { pollId: "original" }]) {
      await Effect.runPromise(host.starter.start(DomainFlows.Remove, {
        executionId: crypto.randomUUID(), payload: { ...legacy, ...binding },
      }))
      expect(host.exits.at(-1)).toMatchObject({ _tag: "Success", value: { change: "missing" } })
    }
    expect(calls.remove).toBe(1)
    expect(await rows(runtime)).toEqual(replacement)
    expect((await events(runtime)).map((event) => event.action)).toEqual(["remove", "add", "check"])
  })

  test("a Maintainer demoted after domain/Verify started: the next check ends the poll and never asks the provider", async () => {
    const who = await person("maintainer")
    const { claim, check } = DomainFlows.steps(await database())
    expect(await keyed(claim(verify(who)))).toEqual({ change: "add" })
    await demote(who)
    const calls = counting()
    expect(await keyed(check({ ...verify(who), attempt: 2 }))).toEqual({ satisfied: true, output: "unauthorized" })
    expect(calls).toEqual({ ensure: 0, status: 0, remove: 0 })
    expect(await rows(runtime)).toMatchObject([{ state: "pending", providerId: null, checkedAt: null }])
    expect((await events(runtime)).map((event) => event.action)).toEqual(["add"])
    // Nor may they claim again, and a payload recorded before steps carried authority fails closed.
    await resetDomains(runtime)
    expect(await keyed(claim(verify(who)), "step-2")).toEqual({ change: "stale" })
    const { authority: _legacy, ...legacy } = verify(await person("admin"))
    expect(await keyed(claim(legacy), "step-3")).toEqual({ change: "stale" })
    expect(await rows(runtime)).toEqual([])
    await seed(runtime, { hostname, pollId: "poll-1" })
    expect(await keyed(check({ ...legacy, attempt: 2 }))).toEqual({ satisfied: true, output: "unauthorized" })
    expect(calls).toEqual({ ensure: 0, status: 0, remove: 0 })
  })

  test("a whole domain/Verify started by someone demoted since ends without a row or a provider call", async () => {
    const who = await person("maintainer")
    await demote(who)
    const calls = counting()
    await Effect.runPromise(
      host.starter.start(DomainFlows.Verify, { executionId: "poll-demoted", payload: { ...verify(who), pollId: "poll-demoted" } }),
    )
    expect(await rows(runtime)).toEqual([])
    expect(calls).toEqual({ ensure: 0, status: 0, remove: 0 })
  })

  test("a signed-out session skips each attempt and the poll resumes once it is live again; the last attempt ends it", async () => {
    const who = await person("admin")
    const { claim, check } = DomainFlows.steps(await database())
    await keyed(claim(verify(who)))
    await signOut(who)
    const calls = counting()
    expect(await keyed(check({ ...verify(who), attempt: 2 }))).toEqual({ satisfied: false, output: "unauthorized" })
    expect(await keyed(check({ ...verify(who), attempt: DomainFlows.VERIFY_ATTEMPTS }))).toEqual({
      satisfied: true,
      output: "unauthorized",
    })
    expect(calls).toEqual({ ensure: 0, status: 0, remove: 0 })
    expect(await rows(runtime)).toMatchObject([{ state: "pending", providerId: null }])
    await signBackIn(who)
    expect(await keyed(check({ ...verify(who), attempt: 3 }))).toEqual({ satisfied: true, output: "active" })
    expect(calls.ensure).toBe(1)
    expect(await rows(runtime)).toMatchObject([{ state: "active", providerId: `cf-${hostname}` }])
  })

  test.each([false, true])("demotion during ensure cleans up unless another poll adopts the registration (adopt=%s)", async (adopt) => {
    const who = await person("maintainer")
    const next = await person("admin")
    const newer = await open({ actor: next.actor })
    const forgotten: Array<string> = []
    let ensures = 0
    const id = "cf-new"
    provider.use({
      ensure: () => Effect.promise(async () => {
        if (++ensures === 1) {
          await demote(who)
          expect(await rows(runtime)).toMatchObject([{ state: "pending", providerId: null, updatedBy: who.id }])
          if (adopt) expect((await newer.fetch(path, add(hostname))).status).toBe(202)
        }
        return { id, records: [], verification: "active", certificate: "active" } as const
      }),
      remove: (registrationId) => Effect.sync(() => void forgotten.push(registrationId)),
    })
    const pollId = crypto.randomUUID()
    await Effect.runPromise(host.starter.start(DomainFlows.Verify, {
      executionId: pollId, payload: { ...verify(who), pollId },
    }))
    expect(host.exits.at(-1)).toMatchObject({ _tag: "Success" })
    expect(forgotten).toEqual(adopt ? [] : [id])
    expect(await rows(runtime)).toMatchObject([adopt
      ? { state: "active", providerId: id, updatedBy: next.id }
      : { state: "pending", providerId: null, updatedBy: who.id, checkedAt: null }])
    expect((await events(runtime)).map((event) => event.action)).toEqual(adopt ? ["add", "refresh", "check"] : ["add"])
  })

  test("a Maintainer demoted after domain/Remove started: the provider keeps the domain and the row stays", async () => {
    const who = await person("maintainer")
    await seed(runtime, { hostname, providerId: "cf-1", state: "active" })
    await demote(who)
    const calls = counting()
    const h = await open({ actor: who.actor })
    // The route still holds the role its cookie carried; the flow asks the database again.
    expect((await h.fetch(domainRoute(REPO.owner, REPO.name, hostname), remove)).status).toBe(202)
    expect(calls).toEqual({ ensure: 0, status: 0, remove: 0 })
    expect(await rows(runtime)).toMatchObject([{ state: "active", providerId: "cf-1" }])
    expect(await events(runtime)).toEqual([])
    const { release } = DomainFlows.steps(await database())
    const { authority: _legacy, ...legacy } = { authority: null, repoId: REPO_ID, hostname, actorId: "p" }
    expect(await keyed(release(legacy))).toEqual({ change: "stale" })
    expect(calls.remove).toBe(0)
  })

  test("a removal retried after its person was demoted leaves the provider alone; another Maintainer finishes it", async () => {
    const who = await person("maintainer")
    await seed(runtime, { hostname, providerId: "cf-1", state: "active" })
    const { release } = DomainFlows.steps(await database())
    const removal = { authority: who.authority, repoId: REPO_ID, hostname, actorId: who.id, pollId: "poll-seed" }
    let asked = 0
    provider.use({ remove: () => Effect.suspend(() => (asked++, Effect.fail(new ProviderUnavailable({ code: "http_500" })))) })
    const exit = await Effect.runPromiseExit(
      release(removal).pipe(Effect.provideService(Action.CurrentInvocationKey, "step-1"), Effect.provide(provider.layer)),
    )
    expect(JSON.stringify(exit)).toContain("@smthrs/mvp/domains/ReleaseUnavailable")
    expect(asked).toBe(1)
    await demote(who)
    const calls = counting()
    expect(await keyed(release(removal))).toEqual({ change: "stale" })
    expect(calls.remove).toBe(0)
    expect(await rows(runtime)).toMatchObject([{ state: "removing", providerId: "cf-1" }])
    const next = await person("admin")
    expect(await keyed(release({ ...removal, authority: next.authority, actorId: next.id }), "step-2")).toEqual({
      change: "released",
    })
    expect(calls.remove).toBe(1)
    expect(await rows(runtime)).toEqual([])
  })
})

describe("GET /api/shapes/domains", () => {
  const values = async (h: Awaited<ReturnType<typeof open>>, count: number) => {
    const found: Array<Record<string, unknown>> = []
    let at = "offset=-1"
    await eventually(async () => {
      const response = await h.fetch(`${DOMAINS_SHAPE_ROUTE}?repo=${REPO_ID.toUpperCase()}&${at}`)
      expect(response.status).toBe(200)
      for (const message of (await response.json()) as Array<{ readonly value?: Record<string, unknown> }>) {
        if (message.value !== undefined) found.push(message.value)
      }
      at = `offset=${response.headers.get("electric-offset")}&handle=${response.headers.get("electric-handle")}`
      return found.length >= count
    }, 10_000)
    return found
  }

  test("a Maintainer reads the repository's domains, never the provider's id, the poll or who changed it", async () => {
    await seed(runtime, { hostname: "docs.example.com", providerId: "cf-1" })
    const before = net.electric.length
    const h = await open({ actor: maintainer })
    const [row] = await values(h, 1)
    expect(Object.keys(row!).sort()).toEqual([
      "certificate",
      "checked_at",
      "hostname",
      "problem",
      "records",
      "repo_id",
      "state",
      "updated_at",
      "verification",
    ])
    expect(row).toMatchObject({ hostname: "docs.example.com", repo_id: REPO_ID, state: "pending" })
    expect(net.electric[before]!.searchParams.get("params[1]")).toBe(REPO_ID)
  })

  test("a visitor, a Member, an agent acting for a Maintainer, or another repository gets no rows", async () => {
    await seed(runtime, { hostname: "docs.example.com" })
    for (const actor of [null, member, guest, agent] as const) {
      const before = net.electric.length
      const h = await open({ actor })
      const response = await h.fetch(`${DOMAINS_SHAPE_ROUTE}?offset=-1&repo=${REPO_ID}`)
      expect(response.status).toBe(200)
      expect(((await response.json()) as Array<{ readonly value?: unknown }>).filter((m) => m.value !== undefined)).toEqual(
        [],
      )
      expect(net.electric[before]!.searchParams.get("params[1]")).toBe("")
    }
    for (const query of ["&repo=github/acme/other", ""]) {
      const before = net.electric.length
      await (await open({ actor: maintainer })).fetch(`${DOMAINS_SHAPE_ROUTE}?offset=-1${query}`)
      expect(net.electric[before]!.searchParams.get("params[1]")).toBe("")
    }
  })

  test("the routes it handles", () => {
    expect(DomainsApi.handles(DOMAINS_SHAPE_ROUTE)).toBe(true)
    expect(DomainsApi.handles(DOMAIN_RESOLVE_ROUTE)).toBe(true)
    expect(DomainsApi.handles(domainsRoute("a", "b"))).toBe(true)
    expect(DomainsApi.handles(domainRoute("a", "b", "c.d"))).toBe(true)
    expect(DomainsApi.handles("/api/repos/a/b/secrets/X")).toBe(false)
  })

  test("GET /api/domains/resolve returns only active custom domains, and refuses invalid or non-GET requests", async () => {
    await seed(runtime, { hostname: "pending.example.com", state: "pending" })
    await seed(runtime, { hostname: "live.example.com", state: "active" })
    const h = await open({ actor: null })
    expect(h.line("domain.resolve")).toEqual([])
    expect((await h.fetch(`${DOMAIN_RESOLVE_ROUTE}?host=live.example.com`, { method: "POST" })).status).toBe(405)
    expect((await h.fetch(DOMAIN_RESOLVE_ROUTE)).status).toBe(400)
    expect((await h.fetch(`${DOMAIN_RESOLVE_ROUTE}?host=not_a_host`)).status).toBe(400)
    expect((await h.fetch(`${DOMAIN_RESOLVE_ROUTE}?host=missing.example.com`)).status).toBe(404)
    expect((await h.fetch(`${DOMAIN_RESOLVE_ROUTE}?host=pending.example.com`)).status).toBe(404)
    const active = await h.fetch(`${DOMAIN_RESOLVE_ROUTE}?host=LIVE.EXAMPLE.COM.`)
    expect(active.status).toBe(200)
    expect(await active.json()).toEqual({ path: "/acme/widgets" })
    // Every answer is one count, one log line and one server span, by outcome (OBS-1, OBS-2).
    expect(
      (["found", "not_found", "invalid", "method", "unavailable"] as const).map((outcome) =>
        h.count(DomainsApi.resolves, { outcome })
      ),
    ).toEqual([1, 2, 2, 1, 0])
    const lines = h.line("domain.resolve")
    expect(lines.map((line) => [line.annotations.outcome, line.annotations.status])).toEqual([
      ["method", 405], ["invalid", 400], ["invalid", 400], ["not_found", 404], ["not_found", 404], ["found", 200],
    ])
    expect(lines.at(-1)!.annotations).toMatchObject({ repoId: REPO_ID })
    expect(typeof lines.at(-1)!.annotations.durationMs).toBe("number")
    // A hostname someone asked about is never recorded: a pending one is its Maintainer's.
    expect(JSON.stringify(lines)).not.toMatch(/example\.com/i)
    const spans = h.spans.filter((span) => span.name === "domain.resolve")
    expect(spans.map((span) => [span.kind, span.attributes.get("outcome"), span.attributes.get("http.response.status_code")]))
      .toEqual([
        ["server", "method", 405], ["server", "invalid", 400], ["server", "invalid", 400], ["server", "not_found", 404],
        ["server", "not_found", 404], ["server", "found", 200],
      ])
  })

  test("GET /api/domains/resolve with the database down answers 503, counted and logged unavailable by code", async () => {
    const registry: Metric.MetricRegistry = new Map()
    const logs: Array<ReturnType<typeof StructuredLogger.formatStructured.log>> = []
    const logger = Logger.make((options) => void logs.push(StructuredLogger.formatStructured.log(options)))
    const broken = await Effect.runPromise(Effect.gen(function* () {
      const api = yield* DomainsApi.make({ id: REPO_ID }, Layer.effectDiscard(Effect.fail(new Error("db_down"))) as never)
      return HttpEffect.toWebHandler(
        (api.fetch as Effect.Effect<never>).pipe(
          Effect.provideService(Metric.MetricRegistry, registry),
          Effect.provideService(Logger.CurrentLoggers, new Set([logger])),
        ) as never,
      )
    }))
    expect((await broken(new Request(`http://localhost${DOMAIN_RESOLVE_ROUTE}?host=live.example.com`))).status).toBe(503)
    expect(
      Effect.runSync(
        Metric.value(Metric.withAttributes(DomainsApi.resolves, { outcome: "unavailable" })).pipe(
          Effect.provideService(Metric.MetricRegistry, registry),
        ),
      ).count,
    ).toBe(1)
    const [line] = logs.filter((log) => log.message === "domain.resolve")
    expect(line!.annotations).toMatchObject({ outcome: "unavailable", status: 503 })
    expect(typeof line!.annotations.errorCode).toBe("string")
    expect(JSON.stringify(line)).not.toContain("live.example.com")
  })
})

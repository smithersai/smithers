// Run credentials (worker/RunCredentials.ts, decision 0017 slice 0, docs/features/sign-in.md#run-credentials): the
// server mints a credential for every run that isn't the person's own press, sets its `act` from the registry, narrows
// its ceiling at every nested call, and reads it back as that run, never as the person. The claims' rules and their
// authority intersection run here directly, with property tests; the mint route, the person-only routes and a
// credential's whole life run through ChatApi's real handler on this file's schema of the compose Postgres.
import { Flow } from "@smthrs/flow"
import { Arbitrary, Clock, ConfigProvider, Effect, Layer, Logger, Metric, Option, Redacted, Result, Schema, Stream } from "effect"
import { FetchHttpClient, HttpServerRequest } from "effect/http"
import { beforeAll, describe, expect, test } from "vitest"
import { DEVICE_PERSON_HEADER, NO_DEVICE_DATA } from "../src/features/auth/contract.ts"
import { CREDENTIAL_TTL_MS, credentialRoute } from "../src/flows/contract.ts"
import {
  type Act,
  type Actor,
  AGENT_FLOWS,
  boundTo,
  PERSON_ONLY_FLOWS,
  personOnlyRefusals,
  refusesCredential,
  Sessions,
} from "./Actor.ts"
import * as TestDatabase from "../db/TestDatabase.ts"
import * as Database from "../db/Database.ts"
import * as RunCredentials from "./RunCredentials.ts"
import * as SessionKeys from "./SessionKeys.ts"
import * as SignIn from "./SignIn.ts"
import { harness, RUN_CREDENTIAL_SECRET, testFile } from "./test/harness.ts"
import { confirmedSession } from "./github/test/fixtures.ts"
import { cookie, signInHarness } from "./test/signIn.ts"

const runtime = testFile("credentials")

const member: Actor = { subject: { kind: "person", id: "person-member" }, role: "member", session: "session-1" }
const other: Actor = { subject: { kind: "person", id: "person-other" }, role: "member" }
const NOW = 1_800_000_000_000

const claims = (who: Actor, run: string, request: RunCredentials.MintRequest) =>
  RunCredentials.claimsFor(who, run, request, NOW)

/** `who` acting through the credential `minted` says. */
const acting = (who: Actor, minted: RunCredentials.Claims): Actor => ({
  ...who,
  act: { kind: minted.act, id: minted.run, root: minted.root, chain: minted.chain, ceiling: minted.ceiling },
})

const success = <A, E>(result: Result.Result<A, E>): A => {
  if (Result.isFailure(result)) throw new Error(`expected a credential, got ${String(result.failure)}`)
  return result.success
}

describe("claimsFor: who a credential says acts", () => {
  test("the person's session starts a chain: the agent for a flow the registry marks one, else a flow", () => {
    const agent = success(claims(member, "answer-1", { flow: "chat/Answer" }))
    expect(agent).toEqual({
      v: 1,
      sub: "person-member",
      sid: "session-1",
      act: "agent",
      run: "answer-1",
      root: "answer-1",
      chain: ["chat/Answer"],
      ceiling: [],
      exp: NOW + CREDENTIAL_TTL_MS,
    })
    expect(success(claims(other, "watch-1", { flow: "watch/set" }))).toMatchObject({ act: "flow", chain: ["watch/set"] })
    expect(success(claims(other, "watch-1", { flow: "watch/set" }))).not.toHaveProperty("sid")
    for (const flow of AGENT_FLOWS) expect(success(claims(member, "run", { flow })).act).toBe("agent")
  })

  test("a declared ceiling narrows the chain's from the start", () => {
    expect(success(claims(member, "r", { flow: "repo/read", ceiling: [["fs:read:src/**", "fs:read:src/**"]] })).ceiling)
      .toEqual([["fs:read:src/**"]])
  })

  test("a nested call grows the chain by one, keeps its root, and stays the agent inside an agent", () => {
    const answer = acting(member, success(claims(member, "answer-1", { flow: "chat/Answer" })))
    const call = success(claims(answer, "answer-1/call/0.1", { flow: "app/agent/ask" }))
    expect(call).toMatchObject({ act: "agent", run: "answer-1/call/0.1", root: "answer-1", chain: ["chat/Answer", "app/agent/ask"] })
    const deeper = success(claims(acting(member, call), "answer-1/call/0.1/x", { flow: "repo/read" }))
    expect(deeper).toMatchObject({ act: "agent", root: "answer-1", chain: ["chat/Answer", "app/agent/ask", "repo/read"] })
  })

  test("a flow's nested call stays the flow's, and becomes the agent's when it calls an agent", () => {
    const flow = acting(member, success(claims(member, "run-1", { flow: "flow/run" })))
    expect(success(claims(flow, "run-1/a", { flow: "repo/read" })).act).toBe("flow")
    expect(success(claims(flow, "run-1/b", { flow: "flow/run/prompt" })).act).toBe("agent")
    // A frame's (`app`) and a container's (`sandbox`) chains keep their kind.
    const app: Actor = { ...member, act: { kind: "app", id: "frame-1" } }
    expect(success(claims(app, "frame-1/a", { flow: "repo/read" }))).toMatchObject({
      act: "app",
      root: "frame-1",
      chain: ["frame-1", "repo/read"],
    })
  })

  test("no credential is minted for a person-only flow whose route refuses an act, nested or not", () => {
    const answer = acting(member, success(claims(member, "answer-1", { flow: "chat/Answer" })))
    for (const [flow, enforcement] of Object.entries(PERSON_ONLY_FLOWS)) {
      const refused = "route" in enforcement
      expect(refusesCredential(flow), flow).toBe(refused)
      if (!refused) continue
      expect(claims(member, "r", { flow }), flow).toEqual(Result.fail("person_only"))
      expect(claims(answer, "answer-1/call", { flow }), flow).toEqual(Result.fail("person_only"))
    }
    // An agent's own run, or a device-only flow, still gets one: their requests are the agent's or the device's.
    expect(Result.isSuccess(claims(member, "answer-1", { flow: "chat/Answer" }))).toBe(true)
    expect(Result.isSuccess(claims(member, "answer-1/close", { flow: "chat/Close" }))).toBe(true)
  })

  test("a callee wider than its caller's ceiling is refused; one inside it narrows to the intersection", () => {
    const plugin = acting(member, success(claims(member, "p", { flow: "repo/read", ceiling: [["fs:read:src/**"]] })))
    expect(claims(plugin, "p/1", { flow: "repo/tree", ceiling: [["fs:write:**"]] })).toEqual(
      Result.fail("capability_exceeded"),
    )
    expect(claims(plugin, "p/2", { flow: "repo/tree", ceiling: [["fs:read:**"]] })).toEqual(
      Result.fail("capability_exceeded"),
    )
    expect(success(claims(plugin, "p/3", { flow: "repo/tree", ceiling: [["fs:read:src/main.ts"]] })).ceiling).toEqual([
      ["fs:read:src/**"],
      ["fs:read:src/main.ts"],
    ])
    // A callee that declares nothing runs under its caller's ceiling: never wider.
    expect(success(claims(plugin, "p/4", { flow: "repo/tree" })).ceiling).toEqual([["fs:read:src/**"]])
  })

  test("a chain stops at its depth", () => {
    let who = acting(member, success(claims(member, "r", { flow: "flow/run" })))
    for (let depth = 1; depth < RunCredentials.MAX_CHAIN; depth += 1) {
      who = acting(member, success(claims(who, `r/${depth}`, { flow: "repo/read" })))
    }
    expect(who.act?.chain).toHaveLength(RunCredentials.MAX_CHAIN)
    expect(claims(who, "r/deep", { flow: "repo/read" })).toEqual(Result.fail("too_deep"))
  })
})

describe("the authority intersection, as properties", () => {
  // Small vocabularies, so generated chains overlap, refuse and narrow often.
  const PATTERNS = ["fs:read:src/**", "fs:read:src/main.ts", "fs:read:**", "fs:write:src/**", "net:get:**", "*"]
  const FLOWS = ["repo/read", "repo/tree", "chat/Answer", "flow/run", "flow/run/prompt", "run/answer", "todo/commit"]
  const Hop = Schema.Struct({
    flow: Schema.Literals(FLOWS),
    ceiling: Schema.optional(
      Schema.Array(Schema.Array(Schema.Literals(PATTERNS)).check(Schema.isMaxLength(2))).check(Schema.isMaxLength(2)),
    ),
  })
  const chains = Arbitrary.array(Arbitrary.schema(Hop), { minLength: 1, maxLength: 8 })

  const check = <A>(arbitrary: Arbitrary.Arbitrary<A>, holds: (value: A) => boolean) =>
    Effect.runPromise(Effect.gen(function* () {
      const result = yield* Arbitrary.checkEffect(arbitrary, holds, { runs: 500, seed: 20261020 })
      expect(Arbitrary.formatCheckFailure(result)).toBeUndefined()
    }))

  test("every hop narrows: a child's ceiling is within its parent's, its chain one longer, its root kept", () =>
    check(chains, (hops) => {
      let who: Actor = member
      for (const [index, hop] of hops.entries()) {
        const minted = claims(who, `run/${index}`, hop)
        if (Result.isFailure(minted)) {
          // A refusal is never for an ordinary callee inside its caller's ceiling.
          if (minted.failure === "person_only") return refusesCredential(hop.flow)
          if (minted.failure === "capability_exceeded") {
            return hop.ceiling !== undefined && !Flow.ceilingWithin(hop.ceiling, who.act?.ceiling ?? [])
          }
          return false
        }
        const parent = who.act
        const child = minted.success
        if (parent !== undefined) {
          if (!Flow.ceilingWithin(child.ceiling, parent.ceiling ?? [])) return false
          if (child.chain.length !== (parent.chain?.length ?? 1) + 1 || child.root !== (parent.root ?? parent.id)) {
            return false
          }
          if (parent.kind === "agent" && child.act !== "agent") return false
        }
        if (hop.ceiling !== undefined && !Flow.ceilingWithin(child.ceiling, hop.ceiling)) return false
        who = acting(member, child)
      }
      return true
    }))

  test("no chain ever acts as the person, or for anyone but the person who started it", () =>
    check(chains, (hops) => {
      let who: Actor = member
      for (const [index, hop] of hops.entries()) {
        const minted = claims(who, `run/${index}`, hop)
        if (Result.isFailure(minted)) return true
        if (minted.success.sub !== member.subject.id) return false
        who = acting(member, minted.success)
        if (who.act === undefined || !boundTo(who, minted.success.root)) return false
      }
      return true
    }))
})

// The test's keys, and a credential they read as `member`'s agent: WebCrypto signs, so they're made before the tests.
const keys = await Effect.runPromise(SessionKeys.make(Redacted.make(RUN_CREDENTIAL_SECRET)))
const credentials = RunCredentials.make({
  keys,
  person: (minted) => Effect.succeed(minted.sub === member.subject.id ? Option.some<Actor>(member) : Option.none()),
})
const sign = (minted: RunCredentials.Claims) => Effect.runPromise(credentials.sign(minted))

describe("signing and reading a credential", () => {
  /** `effect`, read at `now`. */
  const at = <A, E>(now: number, effect: Effect.Effect<A, E>) =>
    Effect.runPromise(effect.pipe(
      Effect.updateService(Clock.Clock, (clock) => ({
        monotonicTimeNanosUnsafe: () => clock.monotonicTimeNanosUnsafe(),
        monotonicTimeNanos: clock.monotonicTimeNanos,
        sleep: (duration) => clock.sleep(duration),
        currentTimeMillisUnsafe: () => now,
        currentTimeMillis: Effect.succeed(now),
        currentTimeNanosUnsafe: () => BigInt(now) * 1_000_000n,
        currentTimeNanos: Effect.succeed(BigInt(now) * 1_000_000n),
      })),
    ))
  const minted = success(claims(member, "answer-1", { flow: "chat/Answer" }))
  let signed = ""
  beforeAll(async () => void (signed = await sign(minted)))

  test("a signed credential reads back as its run acting for its person", async () => {
    const actor = await at(NOW, credentials.verify(signed))
    expect(actor).toEqual(
      Option.some({
        ...member,
        act: { kind: "agent", id: "answer-1", root: "answer-1", chain: ["chat/Answer"], ceiling: [] } satisfies Act,
      }),
    )
  })

  test("forged, tampered, another purpose's, expired or ended: nobody", async () => {
    const [value, mac] = [signed.slice(0, signed.lastIndexOf(".")), signed.slice(signed.lastIndexOf(".") + 1)]
    const otherRun = await sign({ ...minted, run: "answer-2" })
    const swapped = `${otherRun.slice(0, otherRun.lastIndexOf("."))}.${mac}`
    const cookieSigned = await Effect.runPromise(keys.sign("session", value))
    const notClaims = await Effect.runPromise(keys.sign("run", "bm90IGNsYWltcw"))
    for (const token of ["", "nope", `${value}.${"0".repeat(64)}`, swapped, cookieSigned, notClaims]) {
      expect(await at(NOW, credentials.verify(token)), token).toEqual(Option.none())
    }
    expect(await at(minted.exp, credentials.verify(signed))).toEqual(Option.none())
    expect(await at(minted.exp - 1, credentials.verify(signed))).toMatchObject({ _tag: "Some" })
    const stranger = await sign({ ...minted, sub: "person-gone" })
    expect(await at(NOW, credentials.verify(stranger))).toEqual(Option.none())
  })

  test("a request's bearer token is read only when it is one, bounded", () => {
    const of = (authorization?: string) =>
      RunCredentials.bearerOf(
        HttpServerRequest.fromWeb(
          new Request("http://chat.test/", authorization === undefined ? {} : { headers: { authorization } }),
        ),
      )
    expect(of()).toEqual(Option.none())
    expect(of("Basic abc")).toEqual(Option.none())
    expect(of("Bearer ")).toEqual(Option.none())
    expect(of(`Bearer ${"a".repeat(RunCredentials.MAX_TOKEN_LENGTH + 1)}`)).toEqual(Option.none())
    expect(of(`Bearer ${signed}`)).toEqual(Option.some(signed))
  })

  test("a request carrying a credential is never its cookie's person, even when the credential doesn't read", async () => {
    const sessions = RunCredentials.sessionsWith(Effect.succeedSome(member)).pipe(
      Layer.provide(Layer.succeed(RunCredentials.RunCredentials, credentials)),
    )
    const resolve = (headers: Record<string, string>) =>
      at(
        NOW,
        Effect.flatMap(Effect.service(Sessions), (service) => service.resolve).pipe(
          Effect.provideService(
            HttpServerRequest.HttpServerRequest,
            HttpServerRequest.fromWeb(new Request("http://chat.test/", { headers })),
          ),
          Effect.provide(sessions),
        ),
      )
    expect(await resolve({})).toEqual(Option.some(member))
    expect(await resolve({ authorization: `Bearer ${signed}` })).toMatchObject({ value: { act: { kind: "agent" } } })
    expect(await resolve({ authorization: "Bearer forged", cookie: "smithers_session=x" })).toEqual(Option.none())
  })

  test("the cookie resolver reads the cookie's person alone, never a credential, bound by the device header", async () => {
    const sessions = RunCredentials.sessionsWith(Effect.succeedSome(member)).pipe(
      Layer.provide(Layer.succeed(RunCredentials.RunCredentials, credentials)),
    )
    const resolve = (headers: Record<string, string>) =>
      at(
        NOW,
        Effect.flatMap(Effect.service(Sessions), (service) => service.resolveCookie!).pipe(
          Effect.provideService(
            HttpServerRequest.HttpServerRequest,
            HttpServerRequest.fromWeb(new Request("http://chat.test/", { headers })),
          ),
          Effect.provide(sessions),
        ),
      )
    expect(await resolve({})).toEqual(Option.some(member))
    // A credential, valid or not, changes nothing: the cookie's person, never the run acting for them.
    expect(await resolve({ authorization: `Bearer ${signed}` })).toEqual(Option.some(member))
    expect(await resolve({ authorization: "Bearer forged" })).toEqual(Option.some(member))
    // Bound as `resolve` binds a cookie: another person's device data reads as nobody.
    expect(await resolve({ [DEVICE_PERSON_HEADER]: "person-other" })).toEqual(Option.none())
    expect(await resolve({ [DEVICE_PERSON_HEADER]: NO_DEVICE_DATA })).toEqual(Option.some(member))
  })

  test("a request from another person's device data reads as nobody, counted and logged without either person", async () => {
    const registry: Metric.MetricRegistry = new Map()
    const logs: Array<unknown> = []
    const sessions = RunCredentials.sessionsWith(Effect.succeedSome(member)).pipe(
      Layer.provide(Layer.succeed(RunCredentials.RunCredentials, credentials)),
    )
    const resolve = (headers: Record<string, string>, method = "GET") =>
      at(
        NOW,
        Effect.flatMap(Effect.service(Sessions), (service) => service.resolve).pipe(
          Effect.provideService(
            HttpServerRequest.HttpServerRequest,
            HttpServerRequest.fromWeb(new Request("http://chat.test/", { method, headers })),
          ),
          Effect.provide(sessions),
          Effect.provideService(Metric.MetricRegistry, registry),
          Effect.provideService(Logger.CurrentLoggers, new Set([Logger.make((entry) => void logs.push(Logger.formatStructured.log(entry)))])),
        ),
      )
    const device = (person: string) => ({ [DEVICE_PERSON_HEADER]: person })
    // The device's own person, or no device data at all: the cookie's person, and the credential's run.
    expect(await resolve(device("person-member"))).toEqual(Option.some(member))
    expect(await resolve({ ...device("person-member"), authorization: `Bearer ${signed}` })).toMatchObject({ value: { act: { kind: "agent" } } })
    // Another person's data, or a visitor's, under this cookie or this credential: nobody.
    expect(await resolve(device("person-other"))).toEqual(Option.none())
    expect(await resolve(device("@visitor"))).toEqual(Option.none())
    expect(await resolve({ ...device("person-other"), authorization: `Bearer ${signed}` })).toEqual(Option.none())
    // A page that opened none of the device's data writes as its cookie's person; one that names no one, as an
    // earlier build's tab, is refused.
    expect(await resolve({ ...device(NO_DEVICE_DATA), cookie: "smithers_session=x" }, "POST")).toEqual(Option.some(member))
    expect(await resolve({ cookie: "smithers_session=x" }, "POST")).toEqual(Option.none())
    const unbound = await Effect.runPromise(
      Metric.value(Metric.withAttributes(RunCredentials.devicePrincipalRefusals, { outcome: "unbound" })).pipe(
        Effect.provideService(Metric.MetricRegistry, registry),
      ),
    )
    expect(unbound.count).toBe(1)
    const refused = await Effect.runPromise(
      Metric.value(Metric.withAttributes(RunCredentials.devicePrincipalRefusals, { outcome: "mismatch" })).pipe(
        Effect.provideService(Metric.MetricRegistry, registry),
      ),
    )
    expect(refused.count).toBe(3)
    const lines = (logs as Array<{ message: unknown; annotations: Record<string, unknown> }>).filter((line) =>
      JSON.stringify(line.message).includes("auth.device_principal")
    )
    expect(lines.map((line) => line.annotations)).toEqual([
      { outcome: "mismatch" },
      { outcome: "mismatch" },
      { outcome: "mismatch" },
      { outcome: "unbound" },
    ])
    expect(JSON.stringify(logs)).not.toMatch(/person-member|person-other/)
  })
})

// Through ChatApi: the mint route, the routes a credential is bound to, and the person-only answer.

const open = (actor: Actor) => harness(runtime, () => Stream.empty, { actor })
type Harness = Awaited<ReturnType<typeof open>>
/**
 * A Member whose session sign-in confirmed: the deployment repository's role is that receipt (decision 0156,
 * `SessionStore.freshRole`), so only a recorded session may ask a question there.
 */
const asker: Actor = { subject: { kind: "person", id: crypto.randomUUID() }, role: "member", session: crypto.randomUUID() }
const openSignedIn = async (actor: Actor) => {
  await confirmedSession(runtime, actor)
  return open(actor)
}

const post = (h: Harness, path: string, body: unknown, headers: Record<string, string> = {}) =>
  h.fetch(path, { method: "POST", headers, body: JSON.stringify(body) })
const bearer = (token: string) => ({ authorization: `Bearer ${token}` })
const mint = async (h: Harness, run: string, body: unknown, headers: Record<string, string> = {}) => {
  const response = await post(h, credentialRoute(run), body, headers)
  return { status: response.status, body: await response.json() as Record<string, unknown> }
}
const asked = async (h: Harness) => {
  const question = { id: crypto.randomUUID(), answerId: crypto.randomUUID(), text: "Deploy the docs preview" }
  expect((await h.ask(question)).status).toBe(202)
  return question.answerId
}
const waiting = { execution: "run/call/0.0", kind: "question", prompt: "Which branch?", options: ["main", "docs-v2"] }

describe("POST /api/runs/<run>/credential", () => {
  test("the agent asks for its run's credential, and answering the person's question with it is refused", async () => {
    const h = await openSignedIn(asker)
    const answerId = await asked(h)
    const root = await mint(h, answerId, { flow: "chat/Answer" })
    expect(root).toEqual({ status: 200, body: { token: expect.any(String), act: "agent", expiresAt: expect.any(Number) } })
    const agent = bearer(root.body.token as string)
    // The agent's run reports its question with its own credential.
    expect((await post(h, `/api/runs/${answerId}`, { status: "needs_you", wait: waiting }, agent)).status).toBe(200)
    // The agent's chat/Answer calling run/answer: no credential for the call, and its own is refused at the route.
    expect(await mint(h, `${answerId}/call/0.1`, { flow: "run/answer" }, agent)).toEqual({
      status: 403,
      body: { code: "person_only" },
    })
    const answered = await post(h, `/api/runs/${answerId}/answer`, { version: 1, value: "main" }, agent)
    expect([answered.status, await answered.json()]).toEqual([403, { code: "person_only" }])
    expect(h.count(personOnlyRefusals, { act: "run/answer", by: "agent" })).toBe(1)
    expect(h.only("auth.person_only")).toMatchObject({ annotations: { act: "run/answer", by: "agent", runId: answerId } })
    // The person's own press, in their session, answers it.
    expect((await post(h, `/api/runs/${answerId}/answer`, { version: 1, value: "main" })).status).toBe(200)
  })

  test("a nested call's credential grows the chain under its caller's and narrows; a wider callee is refused", async () => {
    const h = await openSignedIn(asker)
    const answerId = await asked(h)
    const root = (await mint(h, answerId, { flow: "chat/Answer" })).body.token as string
    const call = await mint(h, `${answerId}/call/0.1`, { flow: "app/agent/ask" }, bearer(root))
    expect(call).toMatchObject({ status: 200, body: { act: "agent" } })
    // A plugin's flow, its ceiling small, calls a flow that declares more: refused before it runs.
    const plugin = (await mint(h, "plugin-run", { flow: "repo/read", ceiling: [["fs:read:src/**"]] })).body.token as string
    expect(await mint(h, "plugin-run/1", { flow: "repo/tree", ceiling: [["fs:write:**"]] }, bearer(plugin))).toEqual({
      status: 403,
      body: { code: "capability_exceeded" },
    })
    expect((await mint(h, "plugin-run/2", { flow: "repo/tree", ceiling: [["fs:read:src/a.ts"]] }, bearer(plugin))).status)
      .toBe(200)
    expect(h.line("auth.credential").map((line) => line.annotations)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ flow: "app/agent/ask", act: "agent", depth: 2, by: "agent", status: 200 }),
        expect.objectContaining({ flow: "repo/tree", by: "flow", status: 403 }),
      ]),
    )
  })

  test("a credential for another person's run, another run, or none that reads is refused", async () => {
    const mine = await openSignedIn(asker)
    const theirs = await open(other)
    const theirAnswer = await asked(theirs)
    // Minting for another person's answer.
    expect(await mint(mine, theirAnswer, { flow: "chat/Answer" })).toEqual({ status: 403, body: { code: "forbidden" } })
    // A credential bound to one of my runs, used on another of mine.
    const first = await asked(mine)
    const second = await asked(mine)
    const token = (await mint(mine, first, { flow: "chat/Answer" })).body.token as string
    const report = await post(mine, `/api/runs/${second}`, { status: "working" }, bearer(token))
    expect([report.status, await report.json()]).toEqual([403, { code: "other_run" }])
    const write = await post(mine, `/api/answers/${second}`, { status: "streaming", parts: [] }, bearer(token))
    expect(write.status).toBe(403)
    // Forged and expired credentials read as nobody, never as the cookie's person: signed out.
    const expired = await sign({ ...success(claims(asker, first, { flow: "chat/Answer" })), exp: Date.now() - 1 })
    for (const forged of ["forged", expired]) {
      expect((await post(mine, `/api/runs/${first}`, { status: "working" }, bearer(forged))).status).toBe(401)
    }
    // The bad requests to the route, and an unknown flow, are refused before anything is minted.
    expect((await mine.fetch(credentialRoute(first), { method: "POST", body: "{" })).status).toBe(400)
    expect((await mine.fetch(credentialRoute(first), { method: "POST", body: new Uint8Array([0xff]) })).status).toBe(400)
    expect((await mine.fetch(credentialRoute(first), { method: "POST", body: "x".repeat(17_000) })).status).toBe(413)
    expect((await post(mine, credentialRoute(first), { flow: "Not A Flow" })).status).toBe(400)
    expect((await post(mine, "/api/runs/%E0%A4%A/credential", { flow: "chat/Answer" })).status).toBe(404)
    expect((await post(mine, `/api/runs/${encodeURIComponent("a b")}/credential`, { flow: "chat/Answer" })).status)
      .toBe(404)
    expect((await post(mine, credentialRoute("not-an-answer"), { flow: "chat/Answer" })).status).toBe(404)
  })

  test("signed out, nothing is minted", async () => {
    const h = await harness(runtime, () => Stream.empty)
    expect((await post(h, credentialRoute("run-1"), { flow: "watch/set" })).status).toBe(401)
  })
})

describe("a credential's life, with sign-in configured", () => {
  test("minted in the person's session, it reads as their agent until they sign out; replayed after, it is refused", async () => {
    const signIn = await signInHarness(runtime)
    const { cookies } = await signIn.signInAs()
    const h = await harness(runtime, () => Stream.empty, { sessions: signIn.sessions })
    const identity = await signIn.session(cookies) as import("../src/features/auth/contract.ts").SessionState
    if (!identity.signedIn) throw new Error("expected a signed-in person")
    const session = { cookie: cookie(cookies), [DEVICE_PERSON_HEADER]: identity.personId! }
    const answerId = crypto.randomUUID()
    expect(
      (await h.ask({ id: crypto.randomUUID(), answerId, text: "Deploy the docs preview" }, session)).status,
    ).toBe(202)
    const token = (await mint(h, answerId, { flow: "chat/Answer" }, session)).body.token as string
    expect((await post(h, `/api/runs/${answerId}`, { status: "needs_you", wait: waiting }, bearer(token))).status).toBe(200)
    // A valid credential whose live session cannot be read fails closed, with an unavailable response.
    const unavailable = Database.layer(Effect.succeed(Redacted.make("postgresql://smithers:smithers@127.0.0.1:1/smithers")))
    const downSignIn = await signInHarness(runtime, { github: signIn.github, database: unavailable })
    const down = await harness(runtime, () => Stream.empty, { sessions: downSignIn.sessions })
    const denied = await post(down, `/api/runs/${answerId}`, { status: "working" }, bearer(token))
    expect(denied.status).toBe(503)
    // A credential beside the cookie is still the agent: person-only routes refuse it.
    const both = await post(h, `/api/runs/${answerId}/answer`, { version: 1, value: "main" }, { ...session, ...bearer(token) })
    expect(both.status).toBe(403)
    // The agent never asks as the person.
    const asking = await h.ask({ id: crypto.randomUUID(), answerId: crypto.randomUUID(), text: "Hi" }, bearer(token))
    expect(asking.status).toBe(403)
    await signIn.fetch("/api/auth/sign-out", { method: "POST", headers: { origin: "http://smithers.test", ...session } })
    expect((await post(h, `/api/runs/${answerId}`, { status: "working" }, bearer(token))).status).toBe(401)
  })
})

describe("local development, sign-in not configured", () => {
  const developer: Actor = { subject: { kind: "person", id: "local-developer" }, role: "admin", login: "local-developer" }
  /** One start of the Worker's sign-in, as `alchemy dev` runs it after each reload, with `config` its environment. */
  const start = (config: Record<string, string>) =>
    runtime.runPromise(
      Effect.gen(function* () {
        const { database } = yield* TestDatabase.Scratch
        const signIn = yield* SignIn.make(database, { fallback: { actor: developer, login: "local-developer" } })
        return yield* Effect.service(RunCredentials.RunCredentials).pipe(
          Effect.provide(signIn.sessions),
          Effect.provideService(SignIn.RoleChecks, SignIn.RoleChecks.of({ start: () => Effect.void })),
        )
      }).pipe(
        Effect.provide(FetchHttpClient.layer),
        Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(config)),
      ),
    )
  const minted = success(claims(developer, "answer-1", { flow: "chat/Answer" }))

  test("with SESSION_SECRET bound, a credential outlives the Worker reloading", async () => {
    const config = { SESSION_SECRET: RUN_CREDENTIAL_SECRET }
    const token = await Effect.runPromise((await start(config)).sign(minted))
    const reloaded = await start(config)
    expect(await Effect.runPromise(reloaded.verify(token))).toMatchObject({ value: { act: { kind: "agent" } } })
  })

  test("without one, each start draws its own key: an earlier start's credential reads as nobody", async () => {
    const token = await Effect.runPromise((await start({})).sign(minted))
    expect(await Effect.runPromise((await start({})).verify(token))).toEqual(Option.none())
    // A secret too short to sign with is no secret.
    const short = await Effect.runPromise((await start({ SESSION_SECRET: "short" })).sign(minted))
    expect(await Effect.runPromise((await start({ SESSION_SECRET: "short" })).verify(short))).toEqual(Option.none())
  })
})

describe("renewing a queued write's signed authority", () => {
  test("an expired proof renews the exact agent principal, run, chain and ceiling", async () => {
    const parent = acting(member, success(claims(member, "queued-answer", { flow: "chat/Answer", ceiling: [["net:post:github/**"]] })))
    const original = { ...success(claims(parent, "queued-answer/call/1", { flow: "issue/create" })), exp: Date.now() - 1 }
    const token = await sign(original)
    expect(await Effect.runPromise(credentials.verify(token))).toEqual(Option.none())
    const renewed = Option.getOrThrow(await Effect.runPromise(credentials.renew(token, member, original.run)))
    expect({ ...renewed, exp: original.exp }).toEqual(original)
    expect(renewed.exp).toBeGreaterThan(Date.now())
    const actor = Option.getOrThrow(await Effect.runPromise(credentials.verify(await sign(renewed))))
    expect(actor).toMatchObject({ subject: member.subject, act: { kind: "agent", id: original.run, root: original.root, ceiling: original.ceiling, chain: original.chain } })
  })

  test("another person/session/run, an acting caller, forgery and revocation cannot renew", async () => {
    const original = { ...success(claims(member, "queued-run", { flow: "issue/create" })), exp: Date.now() - 1 }
    const token = await sign(original)
    for (const [proof, who, run] of [
      [token, other, original.run],
      [token, { ...member, session: "different-session" }, original.run],
      [token, member, "different-run"],
      [token, acting(member, original), original.run],
      ["forged", member, original.run],
    ] as const) expect(await Effect.runPromise(credentials.renew(proof, who, run))).toEqual(Option.none())
    // A valid MAC does not turn malformed or non-JSON payloads into authority (including another purpose).
    for (const payload of ["%%%", "bm90IGNsYWltcw"]) {
      const malformed = await Effect.runPromise(keys.sign("run", payload))
      expect(await Effect.runPromise(credentials.renew(malformed, member, original.run))).toEqual(Option.none())
      expect(await Effect.runPromise(credentials.verify(malformed))).toEqual(Option.none())
    }
    const cookieProof = await Effect.runPromise(keys.sign("session", "session-token"))
    expect(await Effect.runPromise(credentials.renew(cookieProof, member, original.run))).toEqual(Option.none())
    const revoked = RunCredentials.make({ keys, person: () => Effect.succeedNone })
    expect(await Effect.runPromise(revoked.renew(token, member, original.run))).toEqual(Option.none())
  })

  test("the real credential route renews an expired proof and rejects wider/foreign reinterpretations", async () => {
    const h = await open(member)
    const original = { ...success(claims(acting(member, success(claims(member, "answer", { flow: "chat/Answer", ceiling: [["net:post:github/**"]] }))), "answer/call/4", { flow: "issue/create" })), exp: Date.now() - 1 }
    const token = await sign(original)
    const reply = await mint(h, original.run, { flow: "repo/read", ceiling: [], renew: token })
    expect(reply.status).toBe(200)
    const actor = Option.getOrThrow(await Effect.runPromise(credentials.verify(reply.body.token as string)))
    expect(actor.act).toEqual({ kind: "agent", id: original.run, root: original.root, chain: original.chain, ceiling: original.ceiling })
    expect((await mint(await open(other), original.run, { flow: "issue/create", renew: token })).status).toBe(403)
    expect((await mint(h, "another-run", { flow: "issue/create", renew: token })).status).toBe(403)
  })
})


test("a stale tab's device-bound request never uses a different person's current cookie", async () => {
  const sessions = RunCredentials.sessionsWith(Effect.succeedSome(other)).pipe(Layer.provide(Layer.succeed(RunCredentials.RunCredentials, credentials)))
  const resolve = (expected: string) => Effect.runPromise(Effect.flatMap(Sessions, (service) => service.resolve).pipe(
    Effect.provideService(HttpServerRequest.HttpServerRequest, HttpServerRequest.fromWeb(new Request("http://chat.test/", { headers: { [DEVICE_PERSON_HEADER]: expected } }))),
    Effect.provide(sessions),
  ))
  expect(await resolve(member.subject.id)).toEqual(Option.none())
  expect(await resolve("@visitor")).toEqual(Option.none())
  expect(await resolve(other.subject.id)).toEqual(Option.some(other))
})

import { Action, Flow, FlowRuntime, Interpreter } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Core } from "@smthrs/integrations"
import { ConfigProvider, Context, Effect, Exit, Layer, Option, Redacted, Schema, Scope } from "effect"
import { FetchHttpClient, HttpClient } from "effect/http"
import { build, runFlow } from "../test/flowHost.ts"
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest"
import { SqlClient } from "effect/sql"
import * as TestDatabase from "../../db/TestDatabase.ts"
import { appKey } from "../github/test/scriptedGitHub.ts"
import { testFile } from "../test/harness.ts"
import { resetBranches } from "../test/branch.ts"
import * as RepoRoles from "../github/RepoRoles.ts"
import * as Conversations from "./Conversations.ts"
import { admit, read, send, configured, registration, settings, Settings, Create, make, type Input } from "./GitHubCreation.ts"

const input: Input = {
  actor: { subject: { kind: "person", id: crypto.randomUUID() }, role: "admin" },
  repository: { id: "github/octocat/repo", owner: "octocat", name: "repo" },
  ref: "maya/topic", from: "a".repeat(40), request: "request-1",
}
const appRuntime = testFile("github_branch_creation")
let signingKey: Promise<Redacted.Redacted<string>> | undefined
const TestStep = Action.make("test/GitHubCreation/send", { payload: { caseId: Schema.String }, success: Schema.Unknown })
const TestFlow = Flow.make("test/GitHubCreation", {
  description: "Exercise the GitHub branch write", capabilities: [], payload: { caseId: Schema.String }, success: Schema.Unknown,
  body: Node.capture({ send: TestStep.name }, (payload) => TestStep.call(payload)),
})
const cases = new Map<string, Effect.Effect<unknown>>()
const scope = Effect.runSync(Scope.make())
let executeCase: (caseId: string) => Promise<Exit.Exit<unknown, unknown>>
beforeAll(async () => {
  const layer = Interpreter.layerWithImplementations(TestFlow, TestStep.toLayer(({ caseId }) => cases.get(caseId)!)).pipe(
    Layer.provideMerge(Action.layerImplementations),
  )
  const { context } = await Effect.runPromise(build(layer).pipe(Effect.provideService(Scope.Scope, scope)))
  const engine = Context.get(context, FlowRuntime.FlowRuntime)
  executeCase = (caseId) => Effect.runPromise(Effect.exit(engine.execute(TestFlow, {
    executionId: crypto.randomUUID(), payload: { caseId },
  }).pipe(Effect.provide(context))))
}, 90_000)
afterAll(() => Effect.runPromise(Scope.close(scope, Exit.succeed(undefined))), 90_000)
const realServices = async (http: HttpClient.HttpClient) => {
  const scratch = await appRuntime.runPromise(Effect.service(TestDatabase.Scratch))
  await appRuntime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) => sql`
    INSERT INTO people (id, github_id, github_login) VALUES (${input.actor.subject.id}, 4242, 'maya') ON CONFLICT (id) DO NOTHING`))
  const services = await appRuntime.runPromise(Effect.flatMap(settings, (captured) => configured(scratch.database, http).pipe(Effect.provideService(Settings, captured))).pipe(
    Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown({
      GITHUB_REPOSITORY: "octocat/repo", GITHUB_APP_ID: "17", GITHUB_APP_PRIVATE_KEY: Redacted.value(await (signingKey ??= appKey())),
    })),
  ))
  return { services, database: scratch.database }
}
const run = async (options: { role?: "member" | "guest" | null; status?: number; lost?: boolean; installationFailure?: boolean; stale?: boolean; revoked?: boolean; recoverLost?: boolean; roleFailure?: RepoRoles.Refusal; decodeWrite?: boolean } = {}) => {
  const seen: Array<{ authorization: string | null; body: unknown; path: string }> = []
  const minted: Array<unknown> = []
  let listings = 0
  let http: HttpClient.HttpClient
  let written: { ref: string; object: { sha: string; type: string } } | undefined
  let real: Awaited<ReturnType<typeof realServices>>
  const program = Effect.gen(function* () {
    const execute = make({
      app: {
        installation: () => options.installationFailure
          ? Effect.fail(new Core.IntegrationError.IntegrationError("delivery-failed", "sentinel", { status: 404 }))
          : Effect.succeed({ id: 17 }),
        installationToken: (options) => Effect.sync(() => {
          minted.push(options)
          return { token: Redacted.make("scoped-token"), expiresAt: Date.now() + 60_000 }
        }),
      },
      hold: options.stale ? () => Effect.succeed(false) : real.services.hold,
      authorize: options.revoked ? () => Effect.succeed(false) : real.services.authorize,
      roles: options.role === undefined && options.roleFailure === undefined && !options.stale ? real.services.roles : {
        repository: input.repository, resolve: () => options.roleFailure === undefined
          ? Effect.succeed({ role: options.role === undefined ? "member" : options.role, held: options.stale ? Option.some({ repoId: input.repository.id, personId: input.actor.subject.id, role: "member" as const }) : Option.none() })
          : Effect.fail(new RepoRoles.RoleRefused({ code: options.roleFailure })),
      },
      http, apiBaseUrl: "https://api.github.com",
    })
    const first = yield* execute(input).pipe(Effect.result)
    const result = options.recoverLost ? yield* execute(input).pipe(Effect.result) : first
    return result._tag === "Success"
      ? { _tag: "Success" as const, success: result.success }
      : { _tag: "Failure" as const, failure: { code: result.failure.code, errorCode: result.failure.errorCode ?? result.failure.code } }
  })
  const fetch: typeof globalThis.fetch = async (request, init) => {
    const req = new Request(request, init)
    const body = req.method === "POST" ? await req.json() as { ref: string } : undefined
    seen.push({ authorization: req.headers.get("authorization"), body, path: new URL(req.url).pathname })
    if (new URL(req.url).pathname.endsWith("/permission")) return Response.json({ permission: "write", role_name: "write", user: { id: 4242 } })
    if (req.method === "GET") {
      listings++
      return Response.json(written === undefined || options.lost || (options.recoverLost && listings < 3) ? [] : [written])
    }
    if (options.status === undefined && !options.decodeWrite) written = { ref: body!.ref, object: { sha: input.from, type: "commit" } }
    if (options.lost || options.recoverLost) throw new TypeError("sentinel provider lost answer")
    if (options.decodeWrite) return Response.json({})
    return options.status === undefined
      ? Response.json({ ref: body!.ref, object: { sha: input.from, type: "commit" } })
      : Response.json({ message: "provider sentinel" }, { status: options.status })
  }
  http = await Effect.runPromise(Effect.service(HttpClient.HttpClient).pipe(
    Effect.provide(FetchHttpClient.layer),
    Effect.map((client) => HttpClient.transformResponse(client, (effect) => effect.pipe(Effect.provideService(FetchHttpClient.Fetch, fetch)))),
  ))
  real = await realServices(http)
  const caseId = crypto.randomUUID()
  cases.set(caseId, program.pipe(Effect.provide(real.database), Effect.orDie, Effect.provideService(FetchHttpClient.Fetch, fetch)))
  const exit = await executeCase(caseId)
  expect(exit).toMatchObject({ _tag: "Success" })
  if (Exit.isFailure(exit)) throw new Error("durable creation test failed")
  return { fixture: { seen, minted }, result: exit.value }

}

test("resolves the repository role before minting a narrowly scoped bot token", async () => {
  const { fixture, result } = await run()
  expect(result).toMatchObject({ _tag: "Success", success: { name: expect.stringMatching(/^smithers\/maya-topic-[0-9a-f]{12}$/), sha: input.from, namespace: "default", forge: "github" } })
  expect(fixture.seen).toEqual([
    { authorization: "Bearer scoped-token", body: undefined, path: "/repos/octocat/repo/git/matching-refs/heads/smithers/" },
    { authorization: "Bearer scoped-token", body: undefined, path: "/repos/octocat/repo/collaborators/maya/permission" },
    { authorization: "Bearer scoped-token", body: { ref: expect.stringMatching(/^refs\/heads\/smithers\/maya-topic-[0-9a-f]{12}$/), sha: input.from }, path: "/repos/octocat/repo/git/refs" },
  ])
  expect(fixture.minted).toEqual([{ installationId: 17, repositories: ["repo"], permissions: { contents: "write" } }])
})
test("the repository role refuses a guest despite the session's admin role, before any token or write", async () => {
  const { fixture, result } = await run({ role: "guest" })
  expect(result).toMatchObject({ _tag: "Failure", failure: { code: "forbidden" } })
  expect(fixture.minted).toEqual([])
})
test("an absent installation is not found and never mints a token", async () => {
  const { fixture, result } = await run({ installationFailure: true })
  expect(result).toMatchObject({ _tag: "Failure", failure: { code: "not_found" } })
  expect(fixture.minted).toEqual([])
})

test("a conflict never adopts an unknown existing ref", async () => {
  const { fixture, result } = await run({ status: 422 })
  expect(result).toMatchObject({ _tag: "Failure", failure: { code: "exists" } })
  expect(fixture.seen.filter((request) => request.path.endsWith("/git/refs"))).toHaveLength(1)
})
test("a lost write answer is marked unknown and never retried or adopted", async () => {
  const { fixture, result } = await run({ lost: true })
  expect(result).toMatchObject({ _tag: "Failure", failure: { code: "unavailable", errorCode: "outcome_unknown" } })
  expect(fixture.seen.filter((request) => request.path.endsWith("/git/refs"))).toHaveLength(1)
  expect(JSON.stringify(result)).not.toContain("sentinel")
  expect(JSON.stringify(result)).not.toContain("scoped-token")
})

test("a repository role revoked after resolution refuses before any token or write", async () => {
  const { fixture, result } = await run({ stale: true })
  expect(result).toMatchObject({ _tag: "Failure", failure: { code: "forbidden" } })
  expect(fixture.minted).toEqual([])
  expect(fixture.seen).toEqual([])
})

test("live repository membership is required again immediately before the provider write", async () => {
  const { fixture, result } = await run({ revoked: true })
  expect(result).toMatchObject({ _tag: "Failure", failure: { code: "forbidden" } })
  expect(fixture.seen.filter((request) => request.path.endsWith("/git/refs"))).toHaveLength(0)
})

test("the durable keyed write recovers a lost answer by its provider marker and never posts twice", async () => {
  const { fixture, result } = await run({ recoverLost: true })
  expect(result).toMatchObject({ _tag: "Success", success: { name: expect.stringMatching(/^smithers\/maya-topic-[0-9a-f]{12}$/) } })
  expect(fixture.seen.filter((request) => request.path.endsWith("/git/refs"))).toHaveLength(1)
  expect(fixture.seen.filter((request) => request.path.includes("matching-refs"))).toHaveLength(3)
})

// These receipts exercise the production action on the real durable Node/Postgres host.
describe("durable server creation receipts", () => {
  const runtime = appRuntime
  beforeEach(() => resetBranches(runtime))
  const person = input.actor.subject.id
  let key: Promise<Redacted.Redacted<string>> | undefined
  const setup = async (options: { permission?: string; account?: number; lost?: boolean; noApp?: boolean; external?: boolean; allowed?: string; noPerson?: boolean; noPermission?: boolean; noIdentity?: boolean; permissionDenied?: boolean } = {}) => {
    const scratch = await runtime.runPromise(Effect.service(TestDatabase.Scratch))
    await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) => sql`
      INSERT INTO people (id, github_id, github_login) VALUES (${person}, 4242, 'maya')
      ON CONFLICT (id) DO NOTHING`))
    const value: Input = { ...input, request: crypto.randomUUID(), actor: { subject: { kind: "person", id: options.noPerson ? crypto.randomUUID() : person }, role: "member" } }
    const calls: Array<string> = []
    let listings = 0
    let written: { ref: string; object: { sha: string; type: string } } | undefined
    const fetch: typeof globalThis.fetch = async (request, init) => {
      const req = new Request(request, init)
      const path = new URL(req.url).pathname
      calls.push(`${req.method} ${path}`)
      if (path.endsWith("/installation")) return Response.json({ id: 17 })
      if (path.endsWith("/access_tokens")) return Response.json({ token: "scoped-token", expires_at: new Date(Date.now() + 60_000).toISOString() })
      if (path.endsWith("/permission")) return options.noPermission || options.permissionDenied
        ? Response.json({ message: "permission refusal" }, { status: options.permissionDenied ? 403 : 404 })
        : Response.json({ permission: options.permission === "maintain" ? "write" : options.permission ?? "write", role_name: options.permission ?? "write", ...(options.noIdentity ? {} : { user: { id: options.account ?? 4242 } }) })
      if (path.includes("matching-refs")) {
        listings++
        return Response.json(written === undefined || (options.lost && listings < 3) ? [] : [written])
      }
      if (path.endsWith("/git/refs")) {
        const body = await req.json() as { ref: string; sha: string }
        written = { ref: body.ref, object: { sha: body.sha, type: "commit" } }
        if (options.lost) throw new TypeError("scripted lost acknowledgment")
        return Response.json(written)
      }
      return Response.json({ message: "Not found" }, { status: 404 })
    }
    const http = await Effect.runPromise(Effect.service(HttpClient.HttpClient).pipe(
      Effect.map((client) => HttpClient.transformResponse(client, (effect) => effect.pipe(Effect.provideService(FetchHttpClient.Fetch, fetch)))),
      Effect.provide(FetchHttpClient.layer), Effect.provideService(FetchHttpClient.Fetch, fetch),
    ))
    const config = options.noApp ? {} : {
      GITHUB_REPOSITORY: options.external ? "deployment/own" : "octocat/repo", GITHUB_APP_ID: "17", GITHUB_APP_PRIVATE_KEY: Redacted.value(await (key ??= appKey())),
    }
    if (options.external) await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) => sql`
      INSERT INTO github_repo_roles (repo_id, person_id, role) VALUES (${value.repository.id}, ${person}, 'member')
      ON CONFLICT (repo_id, person_id) DO UPDATE SET checked_at = now(), role = 'member'`))
    if (options.allowed !== undefined) Object.assign(config, { GITHUB_ALLOWED_REPOSITORIES: options.allowed })
    const captured = await Effect.runPromise(settings.pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(config)))))
    // The action host has no deployment environment after program construction.
    const layer = registration(scratch.database, http).pipe(
      Layer.provide(Layer.succeed(Settings, captured)),
      Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({}))),
    )
    return { value, calls, layer, database: scratch.database }
  }

  test("stores the actual keyed branch and forge atomically, and a replay makes no second provider call", async () => {
    const h = await setup({ lost: true })
    expect(await runtime.runPromise(admit(h.value))).toMatchObject({ id: h.value.request, failure: null, branchId: null })
    expect(await runtime.runPromise(admit({ ...h.value, ref: "different" }))).toBeUndefined()
    expect(await runtime.runPromise(read(h.value.request, "another-person"))).toBeUndefined()
    const ran = await runFlow(Create, { request: h.value.request }, h.layer, { executionId: h.value.request })
    expect(ran.exit).toEqual(Exit.succeed({ status: "done" }))
    const receipt = await runtime.runPromise(read(h.value.request, person))
    expect(receipt!.branchId).toEqual(expect.any(String))
    const branch = await runtime.runPromise(Conversations.createdFor(input.repository.id, person, h.value.request))
    expect(branch!.name).toMatch(/^smithers\/maya-topic-[0-9a-f]{12}$/)
    expect(await runtime.runPromise(Conversations.forgeOf(branch!.branchId))).toBe("github")
    expect(await runtime.runPromise(Conversations.namespaceOf(branch!.branchId))).toBe("default")
    expect(h.calls.filter((call) => call.endsWith("/git/refs"))).toHaveLength(1)
    expect(h.calls.filter((call) => call.includes("matching-refs"))).toHaveLength(3)
    const calls = h.calls.length
    expect((await runFlow(Create, { request: h.value.request }, h.layer)).exit).toEqual(Exit.succeed({ status: "done" }))
    expect(h.calls).toHaveLength(calls)
  }, 90_000)

  test("a database failure after the provider writes resumes its marker and persists the receipt once", async () => {
    const h = await setup()
    await runtime.runPromise(admit(h.value))
    await runtime.runPromise(Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* sql`CREATE SEQUENCE creation_fault_once`
      yield* sql.unsafe(`CREATE FUNCTION creation_fault_once() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF nextval('creation_fault_once') = 1 THEN RAISE EXCEPTION 'injected persistence fault'; END IF;
          RETURN NEW;
        END $$`)
      yield* sql`CREATE TRIGGER creation_fault_once BEFORE INSERT ON branches FOR EACH ROW EXECUTE FUNCTION creation_fault_once()`
    }))
    try {
      expect((await runFlow(Create, { request: h.value.request }, h.layer)).exit).toEqual(Exit.succeed({ status: "done" }))
      expect(await runtime.runPromise(read(h.value.request, person))).toMatchObject({ branchId: expect.any(String), failure: null })
      expect(h.calls.filter((call) => call.endsWith("/git/refs"))).toHaveLength(1)
      expect(await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) => sql`SELECT last_value::int AS attempts FROM creation_fault_once`)))
        .toEqual([{ attempts: 2 }])
    } finally {
      await runtime.runPromise(Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* sql`DROP TRIGGER creation_fault_once ON branches`
        yield* sql`DROP FUNCTION creation_fault_once()`
        yield* sql`DROP SEQUENCE creation_fault_once`
      }))
    }
  }, 90_000)

  test("revoked membership records a terminal refusal and a replay never calls GitHub again", async () => {
    const h = await setup({ permission: "read" })
    await runtime.runPromise(admit(h.value))
    expect((await runFlow(Create, { request: h.value.request }, h.layer)).exit).toEqual(Exit.succeed({ status: "failed" }))
    expect(await runtime.runPromise(read(h.value.request, person))).toMatchObject({ failure: "forbidden", branchId: null })
    expect(h.calls.filter((call) => call.endsWith("/git/refs"))).toHaveLength(0)
    const calls = h.calls.length
    expect((await runFlow(Create, { request: h.value.request }, h.layer)).exit).toEqual(Exit.succeed({ status: "failed" }))
    expect(h.calls).toHaveLength(calls)
  }, 90_000)

  test("a cached role on another repository is locked and still checked against GitHub before writing", async () => {
    const h = await setup({ external: true })
    await runtime.runPromise(admit(h.value))
    expect((await runFlow(Create, { request: h.value.request }, h.layer)).exit).toEqual(Exit.succeed({ status: "done" }))
    expect(h.calls.filter((call) => call.endsWith("/git/refs"))).toHaveLength(1)
  }, 90_000)

  test("missing people, missing permission and mismatched account identities never authorize the bot", async () => {
    for (const options of [{ noPerson: true }, { noPermission: true }, { noIdentity: true }, { account: 99 }, { permissionDenied: true }]) {
      const h = await setup(options)
      await runtime.runPromise(admit(h.value))
      expect((await runFlow(Create, { request: h.value.request }, h.layer)).exit).toEqual(Exit.succeed({ status: "failed" }))
      expect(await runtime.runPromise(read(h.value.request, h.value.actor.subject.id))).toMatchObject({ failure: "forbidden", branchId: null })
      expect(h.calls.filter((call) => call.endsWith("/git/refs"))).toHaveLength(0)
    }
  }, 90_000)

  test("an unavailable identity lookup retries before writing and never exposes the database error", async () => {
    const h = await setup()
    await runtime.runPromise(admit(h.value))
    await runtime.runPromise(Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* sql`CREATE SEQUENCE identity_fault_once`
      yield* sql.unsafe(`CREATE FUNCTION identity_fault_once() RETURNS boolean LANGUAGE plpgsql AS $$
        BEGIN
          IF nextval('identity_fault_once') = 1 THEN RAISE EXCEPTION 'injected identity lookup fault'; END IF;
          RETURN true;
        END $$`)
      yield* sql`ALTER TABLE people RENAME TO identity_people`
      yield* sql`CREATE VIEW people AS SELECT * FROM identity_people WHERE identity_fault_once()`
    }))
    try {
      expect((await runFlow(Create, { request: h.value.request }, h.layer)).exit).toEqual(Exit.succeed({ status: "done" }))
      expect(h.calls.filter((call) => call.endsWith("/git/refs"))).toHaveLength(1)
    } finally {
      await runtime.runPromise(Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* sql`DROP VIEW people`
        yield* sql`ALTER TABLE identity_people RENAME TO people`
        yield* sql`DROP FUNCTION identity_fault_once()`
        yield* sql`DROP SEQUENCE identity_fault_once`
      }))
    }
  }, 90_000)

  test("GitHub maintain permission can create an explicitly requested branch", async () => {
    const h = await setup({ permission: "maintain" })
    await runtime.runPromise(admit(h.value))
    expect((await runFlow(Create, { request: h.value.request }, h.layer)).exit).toEqual(Exit.succeed({ status: "done" }))
    expect(await runtime.runPromise(read(h.value.request, person))).toMatchObject({ failure: null, branchId: expect.any(String) })
    expect(h.calls.filter((call) => call.endsWith("/git/refs"))).toHaveLength(1)
  }, 90_000)

  test("captured repository allowlists refuse another repository after runtime Config disappears", async () => {
    const h = await setup({ external: true, allowed: "deployment/own" })
    await runtime.runPromise(admit(h.value))
    expect((await runFlow(Create, { request: h.value.request }, h.layer)).exit).toEqual(Exit.succeed({ status: "failed" }))
    expect(await runtime.runPromise(read(h.value.request, person))).toMatchObject({ failure: "not_found", branchId: null })
    expect(h.calls).toEqual([])
  }, 90_000)

  test("a missing admission and a deployment without an App fail closed", async () => {
    const h = await setup({ noApp: true })
    expect((await runFlow(Create, { request: crypto.randomUUID() }, h.layer)).exit).toEqual(Exit.succeed({ status: "failed" }))
    await runtime.runPromise(admit(h.value))
    expect((await runFlow(Create, { request: h.value.request }, h.layer)).exit).toEqual(Exit.succeed({ status: "failed" }))
    expect(await runtime.runPromise(read(h.value.request, person))).toMatchObject({ failure: "not_configured", branchId: null })
    expect(h.calls).toEqual([])
  }, 90_000)
})

test("repository authorization refusals preserve their safe classifications before minting", async () => {
  for (const [roleFailure, code] of [["not_found", "not_found"], ["app_not_installed", "not_found"], ["not_configured", "not_configured"], ["unavailable", "unavailable"]] as const) {
    const { fixture, result } = await run({ roleFailure })
    expect(result).toMatchObject({ _tag: "Failure", failure: { code } })
    expect(fixture.minted).toEqual([])
  }
}, 90_000)

test("the provider's authentication, absence and other failures are typed without provider bodies", async () => {
  for (const [status, code] of [[401, "forbidden"], [403, "forbidden"], [404, "not_found"], [409, "exists"], [500, "unavailable"]] as const) {
    const { fixture, result } = await run({ status })
    expect(result).toMatchObject({ _tag: "Failure", failure: { code } })
    expect(fixture.seen.filter((request) => request.path.endsWith("/git/refs"))).toHaveLength(1)
    expect(JSON.stringify(result)).not.toContain("provider sentinel")
  }
}, 90_000)

test("an unavailable database is a sanitized durable action failure", async () => {
  const faulty = Layer.effect(SqlClient.SqlClient, Effect.fail(new Error("injected database detail")))
  const result = await Effect.runPromise(Effect.flatMap(HttpClient.HttpClient, (http) => send(faulty, http)({ request: crypto.randomUUID() })).pipe(
    Effect.provide(FetchHttpClient.layer),
    Effect.provideService(Settings, { app: Option.none(), allowed: Option.none(), configReads: { token: { token: Option.none(), app: Option.none() }, visibilityApi: "https://api.github.com" } }), Effect.result,
  ))
  expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "GitHubCreationUnavailable" } })
  expect(JSON.stringify(result)).not.toContain("injected database detail")
})

test("no repository role refuses before minting, and an undecodable write answer remains unknown", async () => {
  const absent = await run({ role: null })
  expect(absent.result).toMatchObject({ _tag: "Failure", failure: { code: "forbidden" } })
  expect(absent.fixture.minted).toEqual([])
  const malformed = await run({ decodeWrite: true })
  expect(malformed.result).toMatchObject({ _tag: "Failure", failure: { code: "unavailable", errorCode: "outcome_unknown" } })
  expect(malformed.fixture.seen.filter((request) => request.path.endsWith("/git/refs"))).toHaveLength(1)
})

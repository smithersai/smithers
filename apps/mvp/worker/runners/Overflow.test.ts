// Overflow on Cloudflare (decision 0144) against the compose Postgres, on this file's own schema: an Admin's setting
// mints and registers the overflow runner's token with no person handling it, the box's egress puts that token and the
// Admin's API key in its requests without either entering the box, and the job store's probe wakes the box only when
// a job waited past the setting and the overflow runner sleeps. The flows run for real on the Node host's engine; the
// hosts a box reaches are scripted at the network.
import { AgentRunner } from "@smthrs/agent"
import { digestSync } from "@smthrs/crypto"
import { type Flow, FlowRuntime } from "@smthrs/flow"
import { Scrub } from "@smthrs/secrets"
import { Context, Effect, Exit, Option, Redacted, Scope, Tracer } from "effect"
import { FetchHttpClient, HttpEffect } from "effect/http"
import { SqlClient } from "effect/sql"
import { beforeEach, describe, expect, test } from "vitest"
import * as TestDatabase from "../../db/TestDatabase.ts"
import { CONNECTION_KINDS, PROTOCOLS } from "../../src/features/personal-model/contract.ts"
import * as Actor from "../Actor.ts"
import * as Flows from "../Flows.ts"
import { KEY, resetModels, seedKeys, VALUE as API_KEY } from "../personal/test/harness.ts"
import { SecretKeys } from "../secrets/Keys.ts"
import * as SandboxEgress from "../secrets/SandboxEgress.ts"
import * as FlowHost from "../test/flowHost.ts"
import * as RunContentTest from "../test/runContent.ts"
import { branchRoles, signedIn, signedOut, testFile } from "../test/harness.ts"
import * as Admin from "./Admin.ts"
import * as AdminFlows from "./AdminFlows.ts"
import * as RunnersApi from "./Api.ts"
import * as Jobs from "./Jobs.ts"
import * as Overflow from "./Overflow.ts"
import * as Store from "./Store.ts"

const runtime = testFile("overflow")
const REPO = "github/acme/widgets"
const ORIGIN = "https://smithers.test"
const MODEL = "https://api.model.test"

const admin: Actor.Actor = { subject: { kind: "person", id: "person-admin" }, role: "admin" }
const member: Actor.Actor = { subject: { kind: "person", id: "person-member" }, role: "member" }

beforeEach(async () => {
  await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) =>
    sql`TRUNCATE agent_jobs, runners, runner_changes, agents, agent_changes, repo_overflow, secret_events, admin_receipts, admin_generations RESTART IDENTITY CASCADE`))
  // Overflow is turned on, and its runner claims, only where the App's installation is recorded (decision 0148).
  await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) =>
    sql`INSERT INTO github_repositories (repo_id, installation_id) VALUES (${REPO}, 42)
      ON CONFLICT (repo_id) DO UPDATE SET installation_id = 42`))
  await resetModels(runtime)
})

const database = () => runtime.runPromise(Effect.map(Effect.service(TestDatabase.Scratch), (scratch) => scratch.database))
const sql = <A extends object>(text: string) =>
  runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (client) => client.unsafe<A>(text)))
const keys = () => runtime.runPromise(Effect.map(Effect.service(SecretKeys).pipe(Effect.provide(SecretKeys.layer(KEY))), Option.getOrThrow))

/** The Admin's own key, as a person saves it in Settings. */
const seedKey = async (person = "person-admin") =>
  (await seedKeys(runtime, person, [{ kind: "api_key", protocol: PROTOCOLS[1], baseUrl: MODEL, key: API_KEY }]))[0]!

/** The Admin routes as `actor`, with SECRETS_KEY unless `secrets` is false; flows run to their end before they answer. */
const adminRoutes = async (actor: Actor.Actor | null, secrets = true, unavailable = false) => {
  const db = await database()
  const scope = Effect.runSync(Scope.make())
  const built = await Effect.runPromise(Scope.provide(FlowHost.build(AdminFlows.registration(db)), scope))
  const flows = Context.get(built.context, FlowRuntime.FlowRuntime)
  const journal: Array<string> = []
  const starter = Flows.FlowStarter.of({
    start: (flow: Flow.Any, { executionId, payload }) => {
      journal.push(JSON.stringify(payload))
      if (unavailable) return Effect.fail(new Flows.StartUnavailable({ errorCode: "injected" }))
      return (flows.execute(flow as never, { executionId, payload: payload as never }) as Effect.Effect<unknown, unknown>).pipe(
        Effect.provide(built.context),
        Effect.orDie,
        Effect.asVoid,
      )
    },
  })
  const api = await Effect.runPromise(Admin.make(db))
  const handler = HttpEffect.toWebHandler(api.fetch.pipe(
    Effect.provideService(Flows.FlowStarter, starter),
    Effect.provide(secrets ? SecretKeys.layer(KEY) : SecretKeys.off),
    Effect.provide(actor === null ? signedOut : signedIn(actor)),
    Effect.provide(branchRoles(db, "acme/widgets")),
  ))
  const send = async (path: string, method: string, body?: unknown) => {
    const response = await handler(new Request(`${ORIGIN}/api/repos/acme/widgets/${path}`, {
      method,
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }))
    return { status: response.status, body: await response.json().catch(() => null) }
  }
  return { send, journal, close: () => Effect.runPromise(Scope.close(scope, Exit.void)) }
}

/** The overflow token as the egress opens it: what only the host ever reads. */
const tokenNow = async () => {
  const overflow = Option.getOrThrow(await runtime.runPromise(Overflow.read(REPO)))
  const opened = await Effect.runPromise((await keys()).cipher.open(overflow.token, Overflow.tokenContext(REPO, overflow.token.keyVersion)))
  return Redacted.value(opened)
}

/** Every row of every table in the file's schema, as text. */
const everything = async () => {
  const scratch = await runtime.runPromise(Effect.service(TestDatabase.Scratch))
  const tables = await sql<{ name: string }>(
    `SELECT table_name AS name FROM information_schema.tables WHERE table_schema = '${scratch.name}'`,
  )
  const rows = await Promise.all(tables.map((table) =>
    sql<{ row: string }>(`SELECT row_to_json(t)::text AS row FROM "${scratch.name}"."${table.name}" t`)))
  return rows.flat().map((each) => each.row).join("\n")
}

const setting = (connectionId: string) => ({
  connectionId,
  profile: "coder-profile",
  argv: ["my-agent", "--acp"],
  labels: ["linux"],
  minQueuedSeconds: 30,
})

// Astra's review of 6b13eb85: a replay answered the outcome recorded under its execution, and the overflow setting
// was then written, or deleted, again as if it were new: an old success overwrote a newer setting, even after its
// authority was gone.
describe("a replayed overflow action", () => {
  const runnerKey = () => Store.resourceKey("runners", REPO, Overflow.RUNNER)
  const generation = () => runtime.runPromise(Store.generationOf(runnerKey()))
  const fenced = async (execution: string, op: "put" | "delete", expiresAt = Date.now() + 60_000): Promise<Store.By> => ({
    actorId: admin.subject.id,
    invocationKey: crypto.randomUUID(),
    fenced: { kind: "overflow", op, fence: { execution, expiresAt, generation: await generation(), authority: { _tag: "Local" } } },
  })
  const writeOf = (connectionId: string, profile: string, sha: string) => ({
    ...setting(connectionId),
    profile,
    capacity: 2,
    repoId: REPO,
    personId: admin.subject.id,
    origin: "https://smithers.example",
    token: { ciphertext: `ciphertext-${profile}`, nonce: `nonce-${profile}`, keyVersion: 1 },
    tokenSha256: sha.repeat(64),
    repoAuthorized: true,
  })
  const state = async () => ({
    profile: Option.map(await runtime.runPromise(Overflow.read(REPO)), (each) => each.profile),
    runners: await sql(`SELECT token_sha256 AS sha, removed_at IS NULL AS live FROM runners`),
  })

  // Astra's review of f7b3de5f: the write locked the overflow row before the runner's, the reverse of the release
  // before it (runner, then overflow), so the two deadlocked while a deploy ran both.
  test("a write that locks the runner's row, then the overflow's, as the release before did, never deadlocks with it", async () => {
    const connectionId = await seedKey()
    expect(await runtime.runPromise(Overflow.set(writeOf(connectionId, "first-profile", "1"), await fenced("overflow-put:base", "put"))))
      .toBe("set")
    let locked = () => {}
    const runnerLocked = new Promise<void>((done) => (locked = done))
    let wantOverflow = () => {}
    const overflowWanted = new Promise<void>((done) => (wantOverflow = done))
    // The release before: the runner's row first, then the overflow's.
    const old = runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (client) =>
      client.withTransaction(Effect.gen(function* () {
        yield* client`SELECT 1 FROM runners WHERE repo_id = ${REPO} AND name = ${Overflow.RUNNER} FOR UPDATE`
        yield* Effect.sync(locked)
        yield* Effect.promise(() => overflowWanted)
        yield* client`SELECT 1 FROM repo_overflow WHERE repo_id = ${REPO} FOR UPDATE`
      }))))
    await runnerLocked
    // Signal the real runner-lock query as it starts. With reversed ordering the new write already owns the
    // overflow row here, so the old write cannot finish and the new one's fixed lock deadline fails the assertion.
    const tracer = Tracer.make({ span(options) {
      const span = new Tracer.NativeSpan(options)
      const attribute = span.attribute.bind(span)
      span.attribute = (key, value) => {
        attribute(key, value)
        if ((key === "db.query.text" || key === "db.statement") && /SELECT 1 FROM runners\b.*FOR UPDATE/s.test(String(value))) wantOverflow()
      }
      return span
    } })
    const writing = runtime.runPromise(
      Effect.result(Overflow.set(writeOf(connectionId, "second-profile", "2"), await fenced("overflow-put:during", "put"))
        .pipe(Effect.provideService(Tracer.Tracer, tracer))),
    )
    const [, result] = await Promise.all([old, writing.finally(wantOverflow)])
    expect(result).toMatchObject({ _tag: "Success", success: "set" })
  })

  test("a PUT replayed after a later change, and after its authority ended, changes nothing", async () => {
    const connectionId = await seedKey()
    const first = writeOf(connectionId, "first-profile", "1")
    const putFirst = await fenced("overflow-put:first", "put")
    expect(await runtime.runPromise(Overflow.set(first, putFirst))).toBe("set")
    expect(await runtime.runPromise(Overflow.set(writeOf(connectionId, "second-profile", "2"), await fenced("overflow-put:second", "put"))))
      .toBe("set")
    const after = await state()
    expect(after.profile).toEqual(Option.some("second-profile"))
    // The first action again: its recorded outcome, nothing written.
    expect(await runtime.runPromise(Overflow.set(first, { ...putFirst, invocationKey: crypto.randomUUID() }))).toBe("set")
    expect(await state()).toEqual(after)
    // Again after its authority ended (its fence expired).
    const expired = { ...putFirst, fenced: { ...putFirst.fenced!, fence: { ...putFirst.fenced!.fence, expiresAt: Date.now() - 1 } } }
    expect(await runtime.runPromise(Overflow.set(first, expired))).toBe("set")
    expect(await state()).toEqual(after)
  })

  test("a DELETE replayed after overflow was turned on again, and after its authority ended, changes nothing", async () => {
    const connectionId = await seedKey()
    expect(await runtime.runPromise(Overflow.set(writeOf(connectionId, "first-profile", "1"), await fenced("overflow-put:on", "put"))))
      .toBe("set")
    const removing = await fenced("overflow-delete:off", "delete")
    expect(await runtime.runPromise(Overflow.remove({ repoId: REPO }, removing))).toBe("removed")
    expect(await runtime.runPromise(Overflow.set(writeOf(connectionId, "again-profile", "3"), await fenced("overflow-put:again", "put"))))
      .toBe("set")
    const after = await state()
    expect(after.profile).toEqual(Option.some("again-profile"))
    expect(await runtime.runPromise(Overflow.remove({ repoId: REPO }, { ...removing, invocationKey: crypto.randomUUID() }))).toBe("removed")
    expect(await state()).toEqual(after)
    const expired = { ...removing, fenced: { ...removing.fenced!, fence: { ...removing.fenced!.fence, expiresAt: Date.now() - 1 } } }
    expect(await runtime.runPromise(Overflow.remove({ repoId: REPO }, expired))).toBe("removed")
    expect(await state()).toEqual(after)
  })
})

describe("an Admin's overflow setting", () => {
  test("omitted optional settings use the declared defaults, and a refused durable start saves nothing", async () => {
    const connectionId = await seedKey()
    const body = { connectionId, profile: "coder-profile", argv: ["my-agent", "--acp"] }
    const failed = await adminRoutes(admin, true, true)
    const real = await adminRoutes(admin)
    try {
      expect((await failed.send("overflow/cloudflare", "PUT", body)).status).toBe(503)
      expect(await runtime.runPromise(Overflow.read(REPO))).toEqual(Option.none())
      expect((await real.send("overflow/cloudflare", "PUT", body)).status).toBe(202)
      expect(Option.getOrThrow(await runtime.runPromise(Overflow.read(REPO)))).toMatchObject({ labels: [], minQueuedSeconds: 60, capacity: 2 })
    } finally { await Promise.all([failed.close(), real.close()]) }
  })
  test("mints and registers the overflow runner's token, which no person, table, journal or answer sees", async () => {
    const connectionId = await seedKey()
    const asAdmin = await adminRoutes(admin)
    try {
      const answer = await asAdmin.send("overflow/cloudflare", "PUT", setting(connectionId))
      expect(answer).toMatchObject({ status: 202, body: { name: "cloudflare" } })
      expect(await sql(`SELECT name, labels, capacity, token_sha256 AS sha FROM runners`)).toEqual([
        { name: "cloudflare-overflow", labels: ["linux", "cloudflare"], capacity: 2, sha: expect.stringMatching(/^[0-9a-f]{64}$/) },
      ])
      // Replaying the same durable writer invocation leaves the registration and setting unchanged.
      const kept = Option.getOrThrow(await runtime.runPromise(Overflow.read(REPO)))
      const invocation = { actorId: admin.subject.id, invocationKey: "repeat-overflow" }
      const write = { ...kept, tokenSha256: digestSync(await tokenNow()), repoAuthorized: true }
      expect(await runtime.runPromise(Overflow.set(write, invocation))).toBe("set")
      expect(await runtime.runPromise(Overflow.set(write, invocation))).toBe("repeat")
      const token = await tokenNow()
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)
      const [runner] = await sql<{ sha: string }>(`SELECT token_sha256 AS sha FROM runners`)
      expect(runner!.sha).toBe(digestSync(token))
      expect(await sql(`SELECT origin, profile, argv, min_queued_seconds AS wait, person_id AS person FROM repo_overflow`)).toEqual([
        { origin: ORIGIN, profile: "coder-profile", argv: ["my-agent", "--acp"], wait: 30, person: "person-admin" },
      ])
      const seen = [JSON.stringify(answer), asAdmin.journal.join("\n"), await everything()].join("\n")
      expect(Scrub.forms(token).filter((form) => seen.includes(form))).toEqual([])

      // The token works on the runner routes, and a second PUT rotates it: the old one is refused from then on.
      const routes = HttpEffect.toWebHandler(
        RunnersApi.make(await database(), { pollMillis: 50, runOf: () => undefined }).fetch.pipe(
          Effect.provide(RunContentTest.transcripts().layer),
        ),
      )
      const claim = (bearer: string) =>
        routes(new Request(`${ORIGIN}${AgentRunner.ROUTES.claim}`, {
          method: "POST",
          headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
          body: JSON.stringify({ profiles: ["coder-profile"], free: 1, running: [], waitSeconds: 0 }),
        }))
      expect((await claim(token)).status).toBe(200)
      expect((await asAdmin.send("overflow/cloudflare", "PUT", { ...setting(connectionId), capacity: 4 })).status).toBe(202)
      const rotated = await tokenNow()
      expect(rotated).not.toBe(token)
      expect((await claim(token)).status).toBe(401)
      expect((await claim(rotated)).status).toBe(200)

      // Off: the runner is retired and the sealed token is gone.
      expect((await asAdmin.send("overflow/cloudflare", "DELETE")).status).toBe(202)
      expect((await claim(rotated)).status).toBe(401)
      expect(await sql(`SELECT count(*)::int AS n FROM repo_overflow`)).toEqual([{ n: 0 }])
    } finally {
      await asAdmin.close()
    }
  })

  test("needs an Admin in person, their own key on a model wire, and SECRETS_KEY", async () => {
    const mine = await seedKey()
    const theirs = await seedKey("person-member")
    const [subscription] = await seedKeys(runtime, "person-admin", [{ kind: CONNECTION_KINDS.find((kind) => kind.endsWith("_subscription"))!, key: "subscription-token-x" }])
    const asAdmin = await adminRoutes(admin)
    const asMember = await adminRoutes(member)
    const asAgent = await adminRoutes({ ...admin, act: { kind: "agent", id: "agent-1" } })
    const asNobody = await adminRoutes(null)
    const keyless = await adminRoutes(admin, false)
    try {
      expect((await asNobody.send("overflow/cloudflare", "PUT", setting(mine))).status).toBe(401)
      expect((await asMember.send("overflow/cloudflare", "PUT", setting(theirs))).status).toBe(403)
      expect((await asAgent.send("overflow/cloudflare", "PUT", setting(mine))).status).toBe(403)
      expect((await asAdmin.send("overflow/cloudflare", "PUT", setting(theirs))).status).toBe(400)
      expect((await asAdmin.send("overflow/cloudflare", "PUT", setting(subscription!))).status).toBe(400)
      expect((await asAdmin.send("overflow/cloudflare", "PUT", { ...setting(mine), argv: [] })).status).toBe(400)
      expect((await asAdmin.send("overflow/elsewhere", "PUT", setting(mine))).status).toBe(404)
      expect((await keyless.send("overflow/cloudflare", "PUT", setting(mine))).status).toBe(503)
      expect(await sql(`SELECT count(*)::int AS n FROM runners`)).toEqual([{ n: 0 }])
    } finally {
      await Promise.all([asAdmin, asMember, asAgent, asNobody, keyless].map((each) => each.close()))
    }
  })
})

describe("an overflow box's egress", () => {
  test("puts the runner token in requests to this deployment and the Admin's key in requests to the key's host, and neither anywhere else", async () => {
    const connectionId = await seedKey()
    const asAdmin = await adminRoutes(admin)
    await asAdmin.send("overflow/cloudflare", "PUT", setting(connectionId))
    await asAdmin.close()
    const token = await tokenNow()
    const overflow = Option.getOrThrow(await runtime.runPromise(Overflow.read(REPO)))
    const guest = { repoId: REPO, branchId: Overflow.boxId(REPO), generation: 1 }
    const placeholders = await Effect.runPromise(SandboxEgress.overflowPlaceholders(guest, await keys(), overflow))
    const credentials: SandboxEgress.OverflowCredentials = {
      repoId: REPO,
      origin: overflow.origin,
      token: overflow.token,
      personId: overflow.personId,
      connectionId,
      baseUrl: MODEL,
    }
    const seen: Array<{ readonly url: string; readonly headers: Record<string, string> }> = []
    const upstream: typeof globalThis.fetch = async (input, init) => {
      const request = new Request(input, init)
      seen.push({ url: request.url, headers: Object.fromEntries(request.headers) })
      return new Response(`saw ${request.headers.get("authorization") ?? request.headers.get("x-api-key")}`)
    }
    const db = await database()
    const box = (generation: number, value = credentials, enabled = true) =>
      HttpEffect.toWebHandler(
        SandboxEgress.forwardOverflow({ ...guest, generation }, value).pipe(
          Effect.provide(enabled ? SecretKeys.layer(KEY) : SecretKeys.off),
          Effect.provide(db),
          Effect.provide(FetchHttpClient.layer),
          Effect.provideService(FetchHttpClient.Fetch, upstream),
        ),
      )
    const claim = await box(1)(new Request(`${ORIGIN}/api/runners/claim`, {
      method: "POST",
      headers: { authorization: `Bearer ${placeholders.token}` },
      body: "{}",
    }))
    expect(claim.status).toBe(200)
    expect(seen.at(-1)).toMatchObject({ url: `${ORIGIN}/api/runners/claim`, headers: { authorization: `Bearer ${token}` } })
    // What the host answers is scrubbed of the token before the box reads it.
    expect(await claim.text()).not.toContain(token)
    const model = await box(1)(new Request(`${MODEL}/v1/messages`, { method: "POST", headers: { "x-api-key": placeholders.key }, body: "{}" }))
    expect(model.status).toBe(200)
    expect(seen.at(-1)!.headers["x-api-key"]).toBe(API_KEY)
    // Each credential goes to its own host only, and a later generation's box can't use an earlier one's placeholders.
    const crossed = await box(1)(new Request(`${MODEL}/v1/messages`, { headers: { authorization: `Bearer ${placeholders.token}` } }))
    expect(crossed.status).toBe(403)
    const stale = await box(2)(new Request(`${ORIGIN}/api/runners/claim`, { headers: { authorization: `Bearer ${placeholders.token}` } }))
    expect(stale.status).toBe(403)
    expect(seen).toHaveLength(2)
    expect(await sql(`SELECT host, outcome, names FROM secret_events WHERE action = 'use' ORDER BY id`)).toEqual([
      { host: "smithers.test", outcome: "forwarded", names: ["overflow:runner-token"] },
      { host: "api.model.test", outcome: "forwarded", names: [`connection:${connectionId}`] },
      expect.objectContaining({ host: "api.model.test" }),
      expect.objectContaining({ host: "smithers.test" }),
    ])
    // The box's plan holds the placeholders and nothing else secret.
    const plan = Overflow.boxPlan(overflow, placeholders, { protocol: PROTOCOLS[1], baseUrl: MODEL }, "http://forge.smithers.internal/acme/widgets")
    const written = JSON.stringify(plan)
    expect(written).toContain(placeholders.token)
    expect(written).toContain(placeholders.key)
    for (const value of [token, API_KEY]) expect(Scrub.forms(value).filter((form) => written.includes(form))).toEqual([])
    expect(JSON.parse(plan.config)).toMatchObject({
      origin: ORIGIN,
      name: "cloudflare-overflow",
      minQueuedSeconds: 30,
      idleExitSeconds: Overflow.IDLE_EXIT_SECONDS,
      profiles: { "coder-profile": { argv: ["my-agent", "--acp"], secretEnv: ["SMITHERS_MODEL_KEY"] } },
    })
    const request = () => new Request(`${MODEL}/v1/messages`, { headers: { "x-api-key": placeholders.key } })
    expect((await box(1, credentials, false)(request())).status).toBe(503)
    expect((await box(1, { ...credentials, token: { ...credentials.token, ciphertext: "broken" } })(request())).status).toBe(503)
    await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) => sql`DELETE FROM personal_models WHERE id = ${connectionId}::uuid`))
    expect((await box(1)(request())).status).toBe(503)
    expect(seen).toHaveLength(2)
  })
})

describe("the overflow wake", () => {
  const agent: AgentRunner.Agent = { name: "coder", labels: ["linux"], profile: "coder-profile", maxHours: 4, restarts: 1 }
  const task: AgentRunner.Task = { agent, repository: REPO, base: "0".repeat(40), system: [], prompt: "p", limits: { files: 2, bytes: 8 } }

  test("wakes the repository's box once a job waited past the setting, and not while its runner is awake", async () => {
    const woken: Array<string> = []
    const jobs = Jobs.make(await database(), undefined, (due) => Effect.sync(() => void woken.push(due.repoId)))
    await Effect.runPromise(jobs.start(task, "todo:1#g1"))
    // No overflow on the repository: nothing to wake.
    await Effect.runPromise(jobs.status("todo:1#g1"))
    expect(woken).toEqual([])
    const connectionId = await seedKey()
    const asAdmin = await adminRoutes(admin)
    await asAdmin.send("overflow/cloudflare", "PUT", { ...setting(connectionId), minQueuedSeconds: 30 })
    await asAdmin.close()
    // Queued 5 s ago: not yet.
    await sql(`UPDATE agent_jobs SET created_at = now() - interval '5 seconds'`)
    await Effect.runPromise(jobs.status("todo:1#g1"))
    expect(woken).toEqual([])
    // Waited 31 s with the box asleep: woken.
    await sql(`UPDATE agent_jobs SET created_at = now() - interval '31 seconds'`)
    await Effect.runPromise(jobs.status("todo:1#g1"))
    expect(woken).toEqual([REPO])
    // Its runner asked a moment ago: the box is awake, so nothing more.
    await sql(`UPDATE runners SET seen_at = now() WHERE name = 'cloudflare-overflow'`)
    await Effect.runPromise(jobs.status("todo:1#g1"))
    expect(woken).toEqual([REPO])
    // A job pinned to an attached runner (a retry) never overflows, and a wake that fails fails no probe.
    await sql(`UPDATE runners SET seen_at = now() - interval '1 hour'`)
    await runtime.runPromise(Store.addRunner({ repoId: REPO, name: "nyc-01", tokenSha256: "c".repeat(64), labels: ["linux"], capacity: 1, repoAuthorized: true }, {
      actorId: "person-admin",
      invocationKey: crypto.randomUUID(),
    }))
    await sql(`UPDATE agent_jobs SET pinned_runner = (SELECT id FROM runners WHERE name = 'nyc-01')`)
    await Effect.runPromise(jobs.status("todo:1#g1"))
    expect(woken).toEqual([REPO])
    const failing = Jobs.make(await database(), undefined, () => Effect.fail(new Error("waiting")))
    await sql(`UPDATE agent_jobs SET pinned_runner = NULL`)
    expect(await Effect.runPromise(failing.status("todo:1#g1"))).toEqual({ _tag: "Running" })
  })
})


test("overflow box identities preserve the repository and are distinct from branch workspaces", async () => {
  expect(Overflow.isBox(Overflow.boxId(REPO))).toBe(true)
  expect(Overflow.isBox("branch-1")).toBe(false)
  expect(Overflow.boxBranch(REPO)).toMatchObject({ owner: "acme", name: "widgets", branch: "", forge: "github" })
  expect(Overflow.boxBranch("")).toMatchObject({ owner: "", name: "" })
  expect(await runtime.runPromise(Overflow.read(REPO))).toEqual(Option.none())
})

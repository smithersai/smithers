import { Action, Flow, Interpreter } from "@smthrs/flow"
import { Engine } from "@smthrs/flows"
import { Node } from "@smthrs/plan"
import { Logger as StructuredLogger } from "@smthrs/observability"
import { NodeHost } from "@smthrs/platform-node"
import { Deferred, Effect, Exit, Fiber, Layer, Logger, Option } from "effect"
import { TestClock } from "effect/testing"
import { SqlClient } from "effect/sql"
import { beforeEach, expect, test } from "vitest"
import * as Policy from "./NotificationPolicy.ts"
import * as Notifications from "./Notifications.ts"
import { testFile } from "./test/harness.ts"

const runtime = testFile("notification_policy")
const repoId = "github/acme/widgets"
const event: Notifications.RepoEvent = {
  repoId, kind: "main", ref: "a".repeat(40), actor: null, title: "PRIVATE-CONTENT-SENTINEL", href: "/acme/widgets",
  occurredAt: new Date("2026-11-01T00:00:00Z"),
}
const people = [{ id: "ann", role: "member" }, { id: "ben", role: "member" }] as const
const query = <A extends object>(text: string, ...args: unknown[]) => runtime.runPromise(
  Effect.flatMap(SqlClient.SqlClient, sql => sql.unsafe<A>(text, args as never[])))
beforeEach(() => runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, sql => sql.withTransaction(Effect.gen(function* () {
  for (const table of ["notifications", "watches", "runs", "branch_shares", "github_repo_roles", "sessions", "people"]) {
    yield* sql`DELETE FROM ${sql(table)}`
  }
  yield* sql`DELETE FROM branches WHERE repo_id = ${repoId} AND name = 'policy-test'`
})))))
const watch = () => query(`INSERT INTO watches (principal_id, subject, level) VALUES ('ann', $1, 'all'), ('ben', $1, 'all')`, `repo:${repoId}`)
const rows = () => query<{ recipient: string; quiet: boolean; version: number }>(`SELECT recipient, quiet, version FROM notifications ORDER BY recipient`)
const narrow = Flow.make("test/notification-policy/narrow", {
  payload: Policy.Request, success: Policy.Decision,
  body: Node.capture({ version: "narrow/v1" }, (input: Policy.Request) => Node.succeed({ recipients: input.defaults.slice(1), handling: { quiet: true } })),
})
const flowLayer = Policy.layerFlow(repoId, narrow).pipe(
  Layer.provide(Interpreter.layerWithImplementations(narrow, Layer.empty).pipe(Layer.provideMerge(Engine.FlowEngine.layerMemory))),
  Layer.provide(NodeHost.NodeCrypto.layer),
)

test("a repository flow selects recipients and quiet handling through the real notification writer", async () => {
  await watch()
  expect(await runtime.runPromise(Notifications.recordRepoEvent(event, people).pipe(Effect.provide(flowLayer)))).toBe(1)
  expect(await rows()).toEqual([{ recipient: "ben", quiet: true, version: 1 }])
})

const request: Policy.Request = { repoId, kind: "main", subject: `main:${repoId}`, revision: "1", candidates: ["ann", "ben"], defaults: ["ann", "ben"] }
const faulty = (decide: Policy.RecipientPolicy["Service"]["decide"]) => Layer.succeed(Policy.RecipientPolicy, { decide })
const answer = (value: unknown) => faulty(() => Effect.succeed(Option.some(value)))

// Real declared flows handle successful policy decisions. Faulty services exercise hostile output and unavailable hosts.
test("absent and unselected repository policies keep the full existing default", async () => {
  expect(await Effect.runPromise(Policy.select(request))).toEqual({ source: "default", recipients: ["ann", "ben"] })
  expect(await Effect.runPromise(Policy.select({ ...request, repoId: "github/other/repository" }).pipe(Effect.provide(flowLayer))))
    .toEqual({ source: "default", recipients: ["ann", "ben"] })
  await watch()
  expect(await runtime.runPromise(Notifications.recordRepoEvent(event, people))).toBe(2)
  expect(await rows()).toEqual([{ recipient: "ann", quiet: false, version: 1 }, { recipient: "ben", quiet: false, version: 1 }])
})

test.each([
  null,
  { recipients: "ann" },
  { recipients: ["ann"], title: "PRIVATE-CONTENT-SENTINEL" },
  { recipients: ["ann"], handling: { quiet: true, secret: "SECRET-SENTINEL" } },
  { recipients: ["ann"], handling: { quiet: "true" } },
  { recipients: ["an email@example.com"] },
  { recipients: Array.from({ length: 51 }, () => "ann") },
])("malformed policy output falls back without carrying untrusted fields: %j", async (value) => {
  expect(await Effect.runPromise(Policy.select(request).pipe(Effect.provide(answer(value)))))
    .toEqual({ source: "default", reason: "policy-malformed", recipients: ["ann", "ben"] })
})

test("duplicate recipients are bounded before deduplication; handling has only the optional quiet flag", async () => {
  for (const handling of [undefined, {}, { quiet: false }, { quiet: true }]) {
    const selected = await Effect.runPromise(Policy.select(request).pipe(Effect.provide(answer({
      recipients: Array.from({ length: 50 }, () => "ann"), ...(handling === undefined ? {} : { handling }),
    }))))
    expect(selected).toEqual({ source: "policy", recipients: ["ann"], ...(handling?.quiet === undefined ? {} : { quiet: handling.quiet }) })
  }
  expect(await Effect.runPromise(Policy.select(request).pipe(Effect.provide(answer({ recipients: [] })))))
    .toEqual({ source: "policy", recipients: [] })
})

test("a large built-in audience falls back intact without calling a policy", async () => {
  const many = Array.from({ length: 51 }, (_, i) => `person-${i}`)
  for (const input of [{ ...request, candidates: many }, { ...request, defaults: many }]) {
    expect(await Effect.runPromise(Policy.select(input).pipe(Effect.provide(faulty(() => Effect.die("must not call"))))))
      .toEqual({ source: "default", reason: "policy-unavailable", recipients: input.defaults })
  }
})

test("failed and defective services fall back with closed records that contain no raw error", async () => {
  const logs: unknown[] = []
  const loggers = new Set([Logger.make(entry => { logs.push(StructuredLogger.formatStructured.log(entry)) })])
  for (const failure of [Effect.fail("SECRET-SENTINEL"), Effect.die("SECRET-SENTINEL")]) {
    expect(await Effect.runPromise(Policy.select(request).pipe(
      Effect.provide(faulty(() => failure)), Effect.provideService(Logger.CurrentLoggers, loggers),
    ))).toEqual({ source: "default", reason: "policy-failed", recipients: ["ann", "ben"] })
  }
  expect(JSON.stringify(logs)).toContain("policy-failed")
  expect(JSON.stringify(logs)).not.toContain("SECRET-SENTINEL")
  await watch()
  expect(await runtime.runPromise(Notifications.recordRepoEvent(event, people).pipe(Effect.provide(faulty(() => Effect.fail("unavailable")))))).toBe(2)
})

test("a hung service falls back at 10 seconds; cancelling the caller remains cancellation", async () => {
  await Effect.runPromise(Effect.gen(function* () {
    const started = yield* Deferred.make<void>()
    const layer = faulty(() => Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)))
    const fiber = yield* Policy.select(request).pipe(Effect.provide(layer), Effect.forkChild)
    yield* Deferred.await(started)
    yield* TestClock.adjust(9_999)
    expect(fiber.pollUnsafe()).toBeUndefined()
    yield* TestClock.adjust(1)
    expect(yield* Fiber.join(fiber)).toEqual({ source: "default", reason: "policy-unavailable", recipients: ["ann", "ben"] })
    const cancelled = yield* Policy.select(request).pipe(Effect.provide(layer), Effect.forkChild)
    yield* Fiber.interrupt(cancelled)
    const cancelledExit = yield* Fiber.await(cancelled)
    expect(Exit.isFailure(cancelledExit)).toBe(true)
  }).pipe(Effect.provide(TestClock.layer()), Effect.scoped))
})

test("policy selection never adds an outsider or a muted watcher", async () => {
  await watch()
  await query(`UPDATE watches SET level = 'muted' WHERE principal_id = 'ann'`)
  // An invalid host tries to select people outside its advertised audience.
  expect(await runtime.runPromise(Notifications.recordRepoEvent(event, people).pipe(Effect.provide(answer({ recipients: ["ann", "ben", "outsider"] }))))).toBe(1)
  expect(await rows()).toEqual([{ recipient: "ben", quiet: false, version: 1 }])
})

test.each(["mute", "unwatch", "deny"])("access is checked after policy execution: %s", async (change) => {
  await watch()
  const started = Deferred.makeUnsafe<void>()
  const finish = Deferred.makeUnsafe<void>()
  const pending = runtime.runPromise(Notifications.recordRepoEvent(event, people).pipe(Effect.provide(faulty(() => Effect.gen(function* () {
    yield* Deferred.succeed(started, undefined)
    yield* Deferred.await(finish)
    return Option.some({ recipients: ["ann", "ben"] })
  })))))
  await Effect.runPromise(Deferred.await(started))
  try {
    if (change === "mute") await query(`UPDATE watches SET level = 'muted' WHERE principal_id = 'ann'`)
    if (change === "unwatch") await query(`DELETE FROM watches WHERE principal_id = 'ann'`)
    if (change === "deny") await query(`INSERT INTO github_repo_roles (repo_id, person_id, role, checked_at) VALUES ($1, 'ann', NULL, now())`, repoId)
  } finally {
    await Effect.runPromise(Deferred.succeed(finish, undefined))
  }
  expect(await pending).toBe(1)
  expect(await rows()).toEqual([{ recipient: "ben", quiet: false, version: 1 }])
})

test.each(["revoked", "expired", "demoted"])("policy cannot override a session that becomes %s", async (change) => {
  const person = "00000000-0000-4000-8000-000000000b02"
  await query(`INSERT INTO people (id, github_id, github_login) VALUES ($1, 4026, 'policy-person')`, person)
  await query(`INSERT INTO sessions (id, token_digest, person_id, role, role_checked_at, expires_at)
    VALUES (gen_random_uuid(), 'policy-session', $1, 'member', now(), now() + interval '1 day')`, person)
  await query(`INSERT INTO watches (principal_id, subject, level) VALUES ($1, $2, 'all')`, person, `repo:${repoId}`)
  const started = Deferred.makeUnsafe<void>()
  const finish = Deferred.makeUnsafe<void>()
  const pending = runtime.runPromise(Notifications.recordRepoEvent(event).pipe(Effect.provide(faulty(() => Effect.gen(function* () {
    yield* Deferred.succeed(started, undefined)
    yield* Deferred.await(finish)
    return Option.some({ recipients: [person] })
  })))))
  await Effect.runPromise(Deferred.await(started))
  try {
    if (change === "revoked") await query(`UPDATE sessions SET revoked_at = now() WHERE person_id = $1`, person)
    if (change === "expired") await query(`UPDATE sessions SET expires_at = now() - interval '1 minute' WHERE person_id = $1`, person)
    if (change === "demoted") await query(`UPDATE sessions SET role = 'guest' WHERE person_id = $1`, person)
  } finally {
    await Effect.runPromise(Deferred.succeed(finish, undefined))
  }
  expect(await pending).toBe(0)
  expect(await rows()).toEqual([])
})

test("policy flows receive identity only, replay once, and retain independent acknowledgments on newer releases", async () => {
  await watch()
  const Decide = Action.make("test/notification-policy/decide", { payload: Policy.Request, success: Policy.Decision })
  const policy = Flow.make("test/notification-policy/recorded", {
    payload: Policy.Request, success: Policy.Decision, body: Node.capture({ action: Decide.name, version: "recorded/v1" }, (input: Policy.Request) => Decide.call(input)),
  })
  const seen: Policy.Request[] = []
  const layer = Policy.layerFlow(repoId, policy).pipe(
    Layer.provide(Interpreter.layerWithImplementations(policy, Decide.toLayer(input => Effect.sync(() => {
      seen.push(input)
      return { recipients: input.defaults }
    }))).pipe(Layer.provideMerge(Engine.FlowEngine.layerMemory))),
    Layer.provide(NodeHost.NodeCrypto.layer),
  )
  const release = { ...event, kind: "release" as const, ref: "v1.0" }
  await runtime.runPromise(Effect.gen(function* () {
    const first = yield* Notifications.recordRepoEvent(release, people)
    const replay = yield* Notifications.recordRepoEvent(release, people)
    expect(first).toBe(2)
    expect(replay).toBe(0)
    expect(seen).toHaveLength(1)
  }).pipe(Effect.provide(layer)))
  expect(seen[0]).toEqual({ repoId, kind: "release", subject: `release:${repoId}:v1.0`, revision: `v1.0:${event.occurredAt.toISOString()}`, candidates: ["ann", "ben"], defaults: ["ann", "ben"] })
  expect(JSON.stringify(seen)).not.toContain(event.title)
  await query(`UPDATE notifications SET read_version = 1, dismissed_version = 1, hidden_version = 1 WHERE recipient = 'ann'`)
  const next = { ...release, occurredAt: new Date("2026-11-02T00:00:00Z") }
  expect(await runtime.runPromise(Notifications.recordRepoEvent(next, people).pipe(Effect.provide(layer)))).toBe(2)
  expect(await query(`SELECT recipient, version, read_version, dismissed_version, hidden_version FROM notifications ORDER BY recipient`))
    .toEqual([
      { recipient: "ann", version: 2, read_version: 1, dismissed_version: 1, hidden_version: 1 },
      { recipient: "ben", version: 2, read_version: 0, dismissed_version: 0, hidden_version: 0 },
    ])
})

const run = async () => {
  const id = crypto.randomUUID()
  const branch = crypto.randomUUID()
  await query(`INSERT INTO branches (id, repo_id, name, mode) VALUES ($1, $2, 'policy-test', 'open')`, branch, repoId)
  await query(`INSERT INTO branch_shares (branch_id, grantee, access) VALUES ($1, 'repository', 'edit')`, branch)
  await query(`INSERT INTO watches (principal_id, subject, level) VALUES ('ben', $1, 'all')`, `branch:${branch}`)
  await query(`INSERT INTO runs (id, flow, status, launched_by, branch_id, repo_id) VALUES ($1, 'test', 'working', 'ann', $2, $3)`, id, branch, repoId)
  return { id, branch }
}
const fold = (id: string) => Effect.flatMap(SqlClient.SqlClient, sql => sql.withTransaction(Notifications.foldRun(id, undefined)))

test("repository run policy narrows new notices; existing recipients still settle with acknowledgments intact", async () => {
  const { id } = await run()
  expect(await runtime.runPromise(fold(id).pipe(Effect.provide(flowLayer)))).toBe(1)
  expect(await rows()).toEqual([{ recipient: "ben", quiet: true, version: 1 }])
  await query(`UPDATE notifications SET read_version = 1 WHERE recipient = 'ben'`)
  await query(`UPDATE runs SET status = 'done' WHERE id = $1`, id)
  const silent = Flow.make("test/notification-policy/silent", {
    payload: Policy.Request, success: Policy.Decision, body: Node.capture({ version: "silent/v1" }, () => Node.succeed({ recipients: [] })),
  })
  const layer = Policy.layerFlow(repoId, silent).pipe(
    Layer.provide(Interpreter.layerWithImplementations(silent, Layer.empty).pipe(Layer.provideMerge(Engine.FlowEngine.layerMemory))),
    Layer.provide(NodeHost.NodeCrypto.layer),
  )
  expect(await runtime.runPromise(fold(id).pipe(Effect.provide(layer)))).toBe(1)
  expect(await query(`SELECT recipient, state, read_version FROM notifications`)).toEqual([{ recipient: "ben", state: "done", read_version: 1 }])
})

test.each(["branch", "repository"])("run policy cannot preserve revoked %s access", async (scope) => {
  const { id, branch } = await run()
  const count = await runtime.runPromise(Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const layer = faulty(() => Effect.gen(function* () {
      if (scope === "branch") yield* sql`DELETE FROM branch_shares WHERE branch_id = ${branch}`
      else yield* sql`INSERT INTO github_repo_roles (repo_id, person_id, role, checked_at) VALUES (${repoId}, 'ben', NULL, now())`
      return Option.some({ recipients: ["ben"] })
    }))
    return yield* fold(id).pipe(Effect.provide(layer))
  }))
  expect(count).toBe(0)
  expect(await rows()).toEqual([])
})

test("an interrupted policy preserves interruption instead of reporting fallback success", async () => {
  const exit = await Effect.runPromise(Policy.select(request).pipe(Effect.provide(faulty(() => Effect.interrupt)), Effect.exit))
  expect(Exit.isFailure(exit)).toBe(true)
})

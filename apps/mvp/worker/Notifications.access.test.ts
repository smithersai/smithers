// Feed authorization through the real ChatApi handler, Postgres, Electric and RepoRoles.
import { Effect, Layer, Option, Stream } from "effect"
import { SqlClient } from "effect/sql"
import { beforeEach, expect, test, vi } from "vitest"
import * as TestDatabase from "../db/TestDatabase.ts"
import { NOTIFICATIONS_SHAPE_ROUTE } from "../src/features/attention/contract.ts"
import { Sessions, SessionsUnavailable, type Actor } from "./Actor.vibe"
import { BranchRoles } from "./branch/Access.ts"
import * as Notifications from "./Notifications.ts"
import * as SessionStore from "./SessionStore.ts"
import { repositoryOf } from "./github/Config.vibe"
import * as RepoRoles from "./github/RepoRoles.ts"
import { app } from "./github/test/harness.ts"
import { accountIdOf, appKey, INSTALLATION_ID, scriptedGitHub } from "./github/test/scriptedGitHub.ts"
import { harness, testFile } from "./test/harness.ts"

const runtime = testFile("notification_access")
const sql = (query: string, ...params: ReadonlyArray<unknown>) => runtime.runPromise(
  Effect.flatMap(SqlClient.SqlClient, (client) => client.unsafe(query, params as Array<never>)))
// Keep Electric handles alive; every scenario has its own recipient and follows its real snapshot receipts.
beforeEach(() => runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, client => client.withTransaction(Effect.gen(function* () {
  for (const table of ["notifications", "notification_repository_access", "watches", "github_repo_roles", "github_repositories", "people"]) {
    yield* client`DELETE FROM ${client(table)}`
  }
})))))
const proxy = async (actor: Actor, branchRoles: Layer.Layer<BranchRoles>, beforeUpstream?: () => Promise<void>) => {
  const { name } = await runtime.runPromise(Effect.service(TestDatabase.Scratch))
  const upstream: Array<URL> = []
  const h = await harness(runtime, () => Stream.empty, { actor, branchRoles,
    fetch: async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      upstream.push(new URL(url))
      url.searchParams.set("table", `${name}.notifications`)
      await beforeUpstream?.()
      return fetch(url, init)
    },
  })
  return { h, upstream }
}
const values = async (response: Response) =>
  ((await response.json()) as Array<{ readonly value?: Record<string, unknown>; readonly headers?: { readonly operation?: string } }>).flatMap((row) =>
    row.value === undefined || row.headers?.operation === "delete" ? [] : [row.value])

test("feed read rechecks each repository before disclosing historical private launcher prompts", async () => {
  const id = "00000000-0000-4000-8000-0000000000f3"
  const actor: Actor = { subject: { kind: "person", id }, role: "member", login: "reader" }
  await sql(`INSERT INTO people (id, github_id, github_login) VALUES ($1, $2, 'reader')`, id, accountIdOf("reader"))
  const github = scriptedGitHub("acme", "private")
  const repoId = "github/acme/private"
  await sql(`INSERT INTO github_repositories (repo_id, private, installation_id) VALUES ($1, true, $2)`, repoId, INSTALLATION_ID)
  // A historical allow, past freshness; no denial has been recorded yet. GitHub now knows no collaborator.
  await sql(`INSERT INTO github_repo_roles (repo_id, person_id, role, checked_at)
    VALUES ($1, $2, 'member', now() - interval '6 minutes')`, repoId, id)
  await sql(`INSERT INTO notifications (recipient, subject, kind, state, mine, run_id, repo_id, title, href)
    SELECT $1, 'run:private-' || n, 'run', 'done', true, gen_random_uuid(), $2, 'private-launcher-prompt', '/acme/private'
    FROM generate_series(1, 20) n`, id, repoId)
  await sql(`INSERT INTO notifications (recipient, subject, kind, state, mine, run_id, title, href)
    VALUES ($1, 'run:unscoped', 'run', 'done', true, gen_random_uuid(), 'home', '/app')`, id)
  const scratch = await runtime.runPromise(Effect.service(TestDatabase.Scratch))
  const roles = await runtime.runPromise(RepoRoles.make(scratch.database, {
    repository: repositoryOf("acme/home"), app: Option.some(app({ privateKey: await appKey() })), http: github.http,
  }))
  const { h } = await proxy(actor, BranchRoles.layer(roles))
  const start = performance.now()
  const response = await h.fetch(`${NOTIFICATIONS_SHAPE_ROUTE}?offset=-1`)
  const synced = await values(response)
  console.info("feed-access-cost", { rows: 21, repositories: 1, permissionRequests: github.seen("GET", /\/permission$/).length,
    elapsedMs: Math.round(performance.now() - start) })
  expect(response.status).toBe(200)
  expect(synced.map((row) => row.subject)).toEqual(["run:unscoped"])
  expect(github.seen("GET", /\/permission$/)).toHaveLength(1)
})


test("feed access checks are per repository and a fresh role avoids another GitHub read", async () => {
  const id = "00000000-0000-4000-8000-0000000000f4"
  const actor: Actor = { subject: { kind: "person", id }, role: "member", login: "reader" }
  await sql(`INSERT INTO people (id, github_id, github_login) VALUES ($1, $2, 'reader')`, id, accountIdOf("reader"))
  const github = scriptedGitHub("acme", "allowed")
  github.roles.set("reader", "write")
  const repoId = "github/acme/allowed"
  await sql(`INSERT INTO github_repositories (repo_id, private, installation_id) VALUES ($1, true, $2)`, repoId, INSTALLATION_ID)
  await sql(`INSERT INTO notifications (recipient, subject, kind, state, mine, run_id, repo_id, title, href)
    SELECT $1, 'run:allowed-' || n, 'run', 'done', true, gen_random_uuid(), $2, 'allowed prompt', '/acme/allowed'
    FROM generate_series(1, 20) n`, id, repoId)
  const scratch = await runtime.runPromise(Effect.service(TestDatabase.Scratch))
  const roles = await runtime.runPromise(RepoRoles.make(scratch.database, {
    repository: repositoryOf("acme/home"), app: Option.some(app({ privateKey: await appKey() })), http: github.http,
  }))
  const { h, upstream } = await proxy(actor, BranchRoles.layer(roles))
  const start = performance.now()
  const cold = await h.fetch(`${NOTIFICATIONS_SHAPE_ROUTE}?offset=-1`)
  expect(cold.status).toBe(200)
  expect(await values(cold)).toHaveLength(20)
  const coldMs = Math.round(performance.now() - start)
  expect(github.seen("GET", /\/permission$/)).toHaveLength(1)
  const warmStart = performance.now()
  const warm = await h.fetch(`${NOTIFICATIONS_SHAPE_ROUTE}?offset=-1`)
  expect(warm.status).toBe(200)
  expect(await values(warm)).toHaveLength(20)
  expect(github.seen("GET", /\/permission$/)).toHaveLength(1)
  console.info("feed-access-cost", { rows: 20, repositories: 1, coldPermissionRequests: 1, warmPermissionRequests: 0,
    coldMs, warmMs: Math.round(performance.now() - warmStart) })
  expect(h.line("notifications.access").map((line) => line.annotations)).toEqual([
    expect.objectContaining({ repositories: 1, permitted: 1, durationMs: expect.any(Number) }),
    expect.objectContaining({ repositories: 1, permitted: 1, durationMs: expect.any(Number) }),
  ])
  // An unreadable repository is withheld; the rest of the feed remains usable.
  await sql(`UPDATE github_repo_roles SET checked_at = now() - interval '6 minutes' WHERE repo_id = $1`, repoId)
  github.faults.push({ match: (_, path) => path.endsWith("/permission"), status: 502 })
  const degraded = await h.fetch(`${NOTIFICATIONS_SHAPE_ROUTE}?offset=-1`)
  expect(degraded.status).toBe(200)
  expect(await values(degraded)).toEqual([])
  expect(degraded.headers.get("retry-after")).not.toBeNull()
  expect(upstream).toHaveLength(3)
})


test("a denied watched repository recovers delivery after pruning without visiting another route or rewriting its role row", async () => {
  const id = "00000000-0000-4000-8000-0000000000f5"
  const repoId = "github/acme/restored"
  const actor: Actor = { subject: { kind: "person", id }, role: "member", login: "reader" }
  await sql(`INSERT INTO people (id, github_id, github_login) VALUES ($1, $2, 'reader')`, id, accountIdOf("reader"))
  await sql(`INSERT INTO sessions (id, token_digest, person_id, role, role_checked_at, role_verified_at, expires_at) VALUES (gen_random_uuid(), $1, $2, 'member', now(), now(), now() + interval '1 day')`, id, id)
  await sql(`INSERT INTO watches (principal_id, subject, level) VALUES ($1, $2, 'all')`, id, `repo:${repoId}`)
  await sql(`INSERT INTO github_repositories (repo_id, private, installation_id) VALUES ($1, true, $2)`, repoId, INSTALLATION_ID)
  await sql(`INSERT INTO notifications (recipient, subject, kind, state, repo_id, title, href)
    VALUES ($1, 'main:old', 'main', 'update', $2, 'historical', '/acme/restored')`, id, repoId)
  const github = scriptedGitHub("acme", "restored")
  const scratch = await runtime.runPromise(Effect.service(TestDatabase.Scratch))
  const roles = await runtime.runPromise(RepoRoles.make(scratch.database, {
    repository: repositoryOf("acme/home"), app: Option.some(app({ privateKey: await appKey() })), http: github.http,
    freshSeconds: 0.25,
  }))
  const { h } = await proxy(actor, BranchRoles.layer(roles))
  expect((await h.fetch(`${NOTIFICATIONS_SHAPE_ROUTE}?offset=-1`)).status).toBe(200)
  expect(await sql(`SELECT subject FROM notifications WHERE recipient = $1`, id)).toEqual([])
  const event = { kind: "main" as const, repoId, actor: "writer", title: "new main", ref: "a".repeat(40), href: "/acme/restored", occurredAt: new Date() }
  expect(await runtime.runPromise(Notifications.recordRepoEvent(event))).toBe(0)
  github.roles.set("reader", "write")
  await new Promise((resolve) => setTimeout(resolve, 350))
  // Only the feed is reopened; the permission cache is written by its real resolver, not the test.
  const refreshed = await h.fetch(`${NOTIFICATIONS_SHAPE_ROUTE}?offset=-1`)
  expect(refreshed.status).toBe(200)
  expect(await runtime.runPromise(Notifications.recordRepoEvent(event))).toBe(1)
  expect(github.seen("GET", /\/permission$/)).toHaveLength(2)
  const cursor = new URLSearchParams({ handle: refreshed.headers.get("electric-handle")!, offset: refreshed.headers.get("electric-offset")! })
  await vi.waitFor(async () => {
    const next = await h.fetch(`${NOTIFICATIONS_SHAPE_ROUTE}?${cursor}`)
    expect(await values(next)).toHaveLength(1)
  }, { timeout: 5000 })
})

test("mixed repository availability preserves unrelated notices and public copies without discovery on each poll", async () => {
  const id = "00000000-0000-4000-8000-0000000000f6"
  const actor: Actor = { subject: { kind: "person", id }, role: "member", login: "reader" }
  await sql(`INSERT INTO people (id, github_id, github_login) VALUES ($1, $2, 'reader')`, id, accountIdOf("reader"))
  const scratch = await runtime.runPromise(Effect.service(TestDatabase.Scratch))
  const providers = ["public-a", "public-b", "private-good", "private-down"].map((name) => scriptedGitHub("acme", name))
  const byId = new Map<string, RepoRoles.RepoRoles>()
  for (const [index, github] of providers.entries()) {
    const name = ["public-a", "public-b", "private-good", "private-down"][index]!
    const repository = repositoryOf(`acme/${name}`)
    const publicCopy = index < 2
    github.installed = !publicCopy
    github.roles.set("reader", "write")
    if (publicCopy) github.faults.push({ match: () => true, status: 502 })
    if (index === 3) github.faults.push({ match: (_, path) => path.endsWith("/permission"), status: 429, headers: { "retry-after": "7" } })
    await sql(`INSERT INTO github_repositories (repo_id, private, visibility_verified_at, installation_id)
      VALUES ($1, $2, now(), $3)`, repository.id, !publicCopy, publicCopy ? null : INSTALLATION_ID)
    await sql(`INSERT INTO notifications (recipient, subject, kind, state, mine, run_id, repo_id, title, href)
      VALUES ($1, $2, 'run', 'done', true, gen_random_uuid(), $3, 'fixture notice', '/app')`, id, name, repository.id)
    byId.set(repository.id, await runtime.runPromise(RepoRoles.make(scratch.database, {
      repository: repositoryOf("acme/home"), app: Option.some(app({ privateKey: await appKey() })), http: github.http,
    })))
  }
  await sql(`INSERT INTO notifications (recipient, subject, kind, state, mine, run_id, title, href)
    VALUES ($1, 'unscoped', 'run', 'done', true, gen_random_uuid(), 'home', '/app')`, id)
  const routes = Layer.succeed(BranchRoles, BranchRoles.of({
    roleOn: (reader, repoId) => RepoRoles.workRole(byId.get(repoId)!, reader, repositoryOf(repoId.replace(/^github\//, ""))),
    workUninstalled: (reader, repoId) => RepoRoles.workUninstalled(byId.get(repoId)!, reader, repositoryOf(repoId.replace(/^github\//, ""))),
  }))
  const { h } = await proxy(actor, routes)
  const cold = await h.fetch(`${NOTIFICATIONS_SHAPE_ROUTE}?offset=-1`)
  expect(cold.status).toBe(200)
  expect((await values(cold)).map((row) => row.subject).sort()).toEqual(["private-good", "public-a", "public-b", "unscoped"])
  expect(cold.headers.get("retry-after")).toBe("7")
  const coldRequests = providers.map((github) => github.calls.length)
  const warm = await h.fetch(`${NOTIFICATIONS_SHAPE_ROUTE}?offset=-1`)
  expect(warm.status).toBe(200)
  expect((await values(warm)).map((row) => row.subject).sort()).toEqual(["private-good", "public-a", "public-b", "unscoped"])
  expect(providers.map((github) => github.calls.length)).toEqual(coldRequests)
  expect(coldRequests.slice(0, 2)).toEqual([0, 0])
  console.info("mixed-feed-cost", { repositories: 4, rows: 5, coldGitHubRequests: coldRequests,
    warmGitHubRequests: providers.map((github, index) => github.calls.length - coldRequests[index]!), unavailable: 1 })
})

test("an existing feed cursor survives repository outage and recovery without rebuilding unrelated notices", async () => {
  const id = "00000000-0000-4000-8000-0000000000f7"
  const repoId = "github/acme/cursor"
  const actor: Actor = { subject: { kind: "person", id }, role: "member", login: "reader" }
  await sql(`INSERT INTO people (id, github_id, github_login) VALUES ($1, $2, 'reader')`, id, accountIdOf("reader"))
  await sql(`INSERT INTO github_repositories (repo_id, private, installation_id) VALUES ($1, true, $2)`, repoId, INSTALLATION_ID)
  await sql(`INSERT INTO notifications (recipient, subject, kind, state, mine, run_id, repo_id, title, href)
    VALUES ($1, 'scoped', 'run', 'done', true, gen_random_uuid(), $2, 'private prompt', '/app'),
      ($1, 'home', 'run', 'done', true, gen_random_uuid(), NULL, 'home', '/app')`, id, repoId)
  const github = scriptedGitHub("acme", "cursor")
  github.roles.set("reader", "write")
  const scratch = await runtime.runPromise(Effect.service(TestDatabase.Scratch))
  const roles = await runtime.runPromise(RepoRoles.make(scratch.database, {
    repository: repositoryOf("acme/home"), app: Option.some(app({ privateKey: await appKey() })), http: github.http,
  }))
  const { h, upstream } = await proxy(actor, BranchRoles.layer(roles))
  const opened = await h.fetch(`${NOTIFICATIONS_SHAPE_ROUTE}?offset=-1`)
  expect(opened.status).toBe(200)
  expect((await values(opened)).map((row) => row.subject).sort()).toEqual(["home", "scoped"])
  const cursor = new URLSearchParams({ handle: opened.headers.get("electric-handle")!, offset: opened.headers.get("electric-offset")! })
  await sql(`UPDATE github_repo_roles SET checked_at = now() - interval '6 minutes' WHERE repo_id = $1`, repoId)
  github.faults.push({ match: (_, path) => path.endsWith("/permission"), status: 429, headers: { "retry-after": "7" } })
  const outage = await h.fetch(`${NOTIFICATIONS_SHAPE_ROUTE}?${cursor}`)
  expect(outage.status).toBe(200)
  expect(outage.headers.get("electric-handle")).toBe(opened.headers.get("electric-handle"))
  expect(outage.headers.get("retry-after")).toBe("7")
  const definition = (url: URL) => [url.searchParams.get("where"), [...url.searchParams].filter(([key]) => key.startsWith("params["))]
  expect(definition(upstream[1]!)).toEqual(definition(upstream[0]!))
  // A fresh snapshot while down withholds only the uncertain repository.
  const down = await h.fetch(`${NOTIFICATIONS_SHAPE_ROUTE}?offset=-1`)
  expect(await down.clone().text()).not.toContain("private prompt")
  expect((await values(down)).map((row) => row.subject)).toEqual(["home"])
  // Let the real shared failure receipt expire, then recover on the original cursor.
  await sql(`UPDATE github_repo_roles SET read_until = now() - interval '1 second' WHERE repo_id = $1`, repoId)
  const recovered = await h.fetch(`${NOTIFICATIONS_SHAPE_ROUTE}?${cursor}`)
  expect(recovered.status).toBe(200)
  expect(recovered.headers.get("electric-handle")).toBe(opened.headers.get("electric-handle"))
  expect(definition(upstream.at(-1)!)).toEqual(definition(upstream[0]!))
  const fresh = await h.fetch(`${NOTIFICATIONS_SHAPE_ROUTE}?offset=-1`)
  expect((await values(fresh)).map((row) => row.subject).sort()).toEqual(["home", "scoped"])
})


test.each([true, false])("concurrent tab recovery preserves cursors when recovery=%s", async (recovery) => {
  const id = crypto.randomUUID()
  const repoId = "github/acme/tabs"
  const actor: Actor = { subject: { kind: "person", id }, role: "member", login: "reader" }
  await sql(`INSERT INTO people (id, github_id, github_login) VALUES ($1, $2, 'reader')`, id, accountIdOf("reader"))
  await sql(`INSERT INTO github_repositories (repo_id, private, installation_id) VALUES ($1, true, $2)`, repoId, INSTALLATION_ID)
  await sql(`INSERT INTO notifications (recipient, subject, kind, state, mine, run_id, repo_id, title, href)
    VALUES ($1, 'scoped', 'run', 'done', true, gen_random_uuid(), $2, 'private prompt', '/acme/tabs')`, id, repoId)
  const github = scriptedGitHub("acme", "tabs")
  github.roles.set("reader", "write")
  const scratch = await runtime.runPromise(Effect.service(TestDatabase.Scratch))
  const roles = await runtime.runPromise(RepoRoles.make(scratch.database, {
    repository: repositoryOf("acme/home"), app: Option.some(app({ privateKey: await appKey() })), http: github.http,
  }))
  let hold = false
  let entered!: () => void
  let release!: () => void
  const atUpstream = new Promise<void>((resolve) => { entered = resolve })
  const released = new Promise<void>((resolve) => { release = resolve })
  const a = await proxy(actor, BranchRoles.layer(roles), async () => {
    if (hold) { entered(); await released }
  })
  const b = await proxy(actor, BranchRoles.layer(roles))
  let snapshot = await a.h.fetch(`${NOTIFICATIONS_SHAPE_ROUTE}?offset=-1`)
  expect((await values(snapshot)).map((row) => row.subject)).toContain("scoped")
  if (recovery) {
    await sql(`UPDATE github_repo_roles SET checked_at = now() - interval '6 minutes' WHERE repo_id = $1`, repoId)
    github.faults.push({ match: (_, path) => path.endsWith("/permission"), status: 429, headers: { "retry-after": "7" } })
    snapshot = await a.h.fetch(`${NOTIFICATIONS_SHAPE_ROUTE}?offset=-1`)
    expect(await values(snapshot)).toEqual([])
  }
  const cursor = new URLSearchParams({ handle: snapshot.headers.get("electric-handle")!, offset: snapshot.headers.get("electric-offset")! })
  hold = true
  const pending = a.h.fetch(`${NOTIFICATIONS_SHAPE_ROUTE}?${cursor}`)
  await atUpstream
  try {
    if (recovery) {
      await sql(`UPDATE github_repo_roles SET read_until = now() - interval '1 second' WHERE repo_id = $1`, repoId)
      // B sees the real Electric recovery insert before A's old poll returns.
      await vi.waitFor(async () => {
        const recovered = await b.h.fetch(`${NOTIFICATIONS_SHAPE_ROUTE}?${cursor}`)
        expect((await values(recovered)).map((row) => row.subject)).toContain("scoped")
      }, { timeout: 5000 })
    } else {
      // B advances checked_at while confirming the same decision. This must not invalidate A's poll.
      expect((await b.h.fetch(`${NOTIFICATIONS_SHAPE_ROUTE}?offset=-1`)).status).toBe(200)
    }
  } finally { hold = false; release() }
  const raced = await pending
  expect(raced.status).toBe(200)
  expect(raced.headers.get("electric-handle")).toBe(snapshot.headers.get("electric-handle"))
  expect(raced.headers.get("electric-offset")).not.toBeNull()
  if (recovery) {
    // The emit snapshot can permit the recovery insert already in A's buffered response.
    expect((await values(raced)).map(row => row.subject)).toContain("scoped")
  } else await raced.arrayBuffer()
})

test.each(["response", "authorization", "restored"] as const)("recorded denial fences a held feed %s", async (stage) => {
  const id = crypto.randomUUID()
  const repoId = "github/acme/denial"
  const actor: Actor = { subject: { kind: "person", id }, role: "member", login: "reader" }
  await sql(`INSERT INTO people (id, github_id, github_login) VALUES ($1, $2, 'reader')`, id, accountIdOf("reader"))
  await sql(`INSERT INTO github_repositories (repo_id, private, installation_id) VALUES ($1, true, $2)`, repoId, INSTALLATION_ID)
  await sql(`INSERT INTO watches (principal_id, subject, level) VALUES ($1, $2, 'all')`, id, `repo:${repoId}`)
  await sql(`INSERT INTO notifications (recipient, subject, kind, state, mine, run_id, repo_id, title, href)
    VALUES ($1, 'scoped', 'run', 'done', true, gen_random_uuid(), $2, 'private held prompt', '/acme/denial')`, id, repoId)
  const github = scriptedGitHub("acme", "denial")
  github.roles.set("reader", "write")
  const scratch = await runtime.runPromise(Effect.service(TestDatabase.Scratch))
  const roles = await runtime.runPromise(RepoRoles.make(scratch.database, {
    repository: repositoryOf("acme/home"), app: Option.some(app({ privateKey: await appKey() })), http: github.http,
  }))
  let hold = false
  let entered!: () => void
  let release!: () => void
  const atHold = new Promise<void>((resolve) => { entered = resolve })
  const released = new Promise<void>((resolve) => { release = resolve })
  const pause = async () => { entered(); await released }
  const real = BranchRoles.layer(roles)
  const branchRoles = stage !== "authorization" ? real : Layer.effect(BranchRoles, Effect.gen(function* () {
    const service = yield* BranchRoles
    return BranchRoles.of({
      ...service,
      roleOn: (reader, repo) => service.roleOn(reader, repo).pipe(Effect.tap(() =>
        hold ? Effect.promise(pause) : Effect.void)),
    })
  }).pipe(Effect.provide(real)))
  const { name } = await runtime.runPromise(Effect.service(TestDatabase.Scratch))
  const h = await harness(runtime, () => Stream.empty, { actor, branchRoles, fetch: async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    url.searchParams.set("table", `${name}.notifications`)
    const response = await fetch(url, init)
    // Buffer the actual Electric payload before denial, so its insert cannot disappear with the SQL deletion.
    const body = await response.arrayBuffer()
    if (hold && stage !== "authorization") await pause()
    return new Response(body, { status: response.status, headers: response.headers })
  } })
  expect((await values(await h.fetch(`${NOTIFICATIONS_SHAPE_ROUTE}?offset=-1`))).map((row) => row.subject)).toEqual(["scoped"])
  hold = true
  const pending = h.fetch(`${NOTIFICATIONS_SHAPE_ROUTE}?offset=-1`)
  await atHold
  const remember = (role: "member" | null) => runtime.runPromise(Effect.gen(function* () {
    const client = yield* SqlClient.SqlClient
    const [at] = yield* client<{ readonly at: string }>`SELECT clock_timestamp()::text AS at`
    return yield* RepoRoles.remember(repoId, id, role, at!.at)
  }))
  try {
    // A non-feed request records authoritative removal. No second feed read is needed to invalidate A.
    await remember(null)
    expect(await sql(`SELECT subject FROM notifications WHERE recipient = $1`, id)).toEqual([])
    if (stage === "restored") {
      await remember("member")
      const b = await proxy(actor, real)
      expect((await b.h.fetch(`${NOTIFICATIONS_SHAPE_ROUTE}?offset=-1`)).status).toBe(200)
    }
  } finally { hold = false; release() }
  const raced = await pending
  expect(raced.status).toBe(503)
  expect(raced.headers.get("electric-offset")).toBeNull()
  expect(raced.headers.get("electric-handle")).toBeNull()
  expect(raced.headers.get("cache-control")).toContain("no-store")
  expect(await raced.text()).not.toContain("private held prompt")
  expect(h.line("notifications.shape").at(-1)?.annotations).toMatchObject({ upstream: "access", outcome: "superseded" })
  expect(await sql(`SELECT readable FROM notification_repository_access WHERE recipient = $1 AND repo_id = $2`, id, repoId))
    .toEqual([{ readable: stage === "restored" }])
})

test.each([
  ["repository", "denial", "response"], ["repository", "denial", "authorization"],
  ["repository", "demotion", "response"], ["repository", "demotion", "authorization"],
  ["deployment", "denial", "response"], ["deployment", "denial", "authorization"],
  ["deployment", "demotion", "response"], ["deployment", "demotion", "authorization"],
  ["deployment-record", "denial", "response"], ["deployment-record", "denial", "authorization"],
  ["deployment-record", "demotion", "response"], ["deployment-record", "demotion", "authorization"],
] as const)("%s %s retains only cursor fences across restoration of a held %s", async (source, loss, stage) => {
  const id = crypto.randomUUID()
  const repoId = "github/acme/loss"
  const session = crypto.randomUUID()
  const actor: Actor = { subject: { kind: "person", id }, role: "admin", login: "reader",
    ...(source === "deployment-record" ? { session } : {}),
  }
  await sql(`INSERT INTO people (id, github_id, github_login) VALUES ($1, $2, 'reader')`, id, accountIdOf("reader"))
  await sql(`INSERT INTO github_repositories (repo_id, private, installation_id) VALUES ($1, true, $2)`, repoId, INSTALLATION_ID)
  await sql(`INSERT INTO watches (principal_id, subject, level) VALUES ($1, $2, 'all')`, id, `repo:${repoId}`)
  await sql(`INSERT INTO notifications (recipient, subject, kind, state, mine, repo_id, title, href)
    VALUES ($1, 'held-fleet', 'fleet', 'update', false, $2, 'private fleet payload', '/acme/loss')`, id, repoId)
  if (source === "deployment-record") await runtime.runPromise(Effect.gen(function* () {
    return yield* SessionStore.createSession({ id: session, tokenDigest: crypto.randomUUID(), personId: id,
      role: "admin", roleGeneration: yield* SessionStore.roleObservation,
      access: { ciphertext: "unused", nonce: "unused" }, accessExpiresAt: null,
      refresh: null, refreshDigest: null, maxAgeSeconds: 3600 })
  }))
  const github = scriptedGitHub("acme", "loss")
  github.roles.set("reader", "admin")
  const scratch = await runtime.runPromise(Effect.service(TestDatabase.Scratch))
  const roles = await runtime.runPromise(RepoRoles.make(scratch.database, {
    repository: repositoryOf(source !== "repository" ? "acme/loss" : "acme/home"),
    app: Option.some(app({ privateKey: await appKey() })), http: github.http,
  }))
  const real = BranchRoles.layer(roles)
  let hold = false
  let entered!: () => void
  let release!: () => void
  const atHold = new Promise<void>(resolve => { entered = resolve })
  const released = new Promise<void>(resolve => { release = resolve })
  const pause = async () => { entered(); await released }
  const branchRoles = stage === "response" ? real : Layer.effect(BranchRoles, Effect.gen(function* () {
    const service = yield* BranchRoles
    return BranchRoles.of({ ...service, roleOn: (reader, repo) => service.roleOn(reader, repo).pipe(
      Effect.tap(() => hold ? Effect.promise(pause) : Effect.void)) })
  }).pipe(Effect.provide(real)))
  const { name } = scratch
  const h = await harness(runtime, () => Stream.empty, { actor, branchRoles, fetch: async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    url.searchParams.set("table", `${name}.notifications`)
    const response = await fetch(url, init)
    const body = await response.arrayBuffer()
    if (hold && stage === "response") await pause()
    return new Response(body, { status: response.status, headers: response.headers })
  } })
  expect((await values(await h.fetch(`${NOTIFICATIONS_SHAPE_ROUTE}?offset=-1`))).map(row => row.subject)).toEqual(["held-fleet"])
  const fence = () => sql(`SELECT denial_sequence::text AS sequence FROM notification_repository_access WHERE recipient = $1 AND repo_id = $2`, id, repoId)
  const [before] = await fence() as Array<{ sequence: string }>
  hold = true
  const pending = h.fetch(`${NOTIFICATIONS_SHAPE_ROUTE}?offset=-1`)
  await atHold
  try {
    if (source === "repository") {
      const remember = (role: "admin" | "member" | null) => runtime.runPromise(Effect.gen(function* () {
        const client = yield* SqlClient.SqlClient
        const [at] = yield* client<{ at: string }>`SELECT clock_timestamp()::text AS at`
        return yield* RepoRoles.remember(repoId, id, role, at!.at)
      }))
      await remember(loss === "denial" ? null : "member")
      await remember("admin")
    } else if (source === "deployment-record") {
      const record = (role: "admin" | "member" | null) => runtime.runPromise(Effect.gen(function* () {
        return yield* SessionStore.setRole(session, role, yield* SessionStore.roleObservation)
      }))
      // No projection or notification changed: the emit snapshot can use the restored authority directly.
      await record(loss === "denial" ? null : "member")
      await record("admin")
    } else {
      const reduced = await proxy({ ...actor, role: loss === "denial" ? null : "member" }, real)
      expect((await reduced.h.fetch(`${NOTIFICATIONS_SHAPE_ROUTE}?offset=-1`)).status).toBe(200)
    }
    const restored = await proxy(actor, real)
    expect((await restored.h.fetch(`${NOTIFICATIONS_SHAPE_ROUTE}?offset=-1`)).status).toBe(200)
  } finally { hold = false; release() }
  const response = await pending
  const cursorChanged = source === "repository" || source === "deployment" && loss === "denial"
  const [after] = await fence() as Array<{ sequence: string }>
  if (cursorChanged) {
    expect(response.status).toBe(503)
    expect(response.headers.get("electric-handle")).toBeNull()
    expect(response.headers.get("electric-offset")).toBeNull()
    expect(await response.text()).not.toContain("private fleet payload")
    expect(BigInt(after!.sequence)).toBeGreaterThan(BigInt(before!.sequence))
    expect(h.line("notifications.shape").at(-1)?.annotations).toMatchObject({ upstream: "access", outcome: "superseded" })
  } else {
    // Pure role loss/restoration leaves the current subject and projection intact; no cursor reset is needed.
    expect(response.status).toBe(200)
    const prunedByIntermediateRead = source === "deployment" && loss === "demotion"
    expect((await values(response)).map(row => row.subject)).toEqual(prunedByIntermediateRead ? [] : ["held-fleet"])
    if (prunedByIntermediateRead) expect(await sql(`SELECT subject FROM notifications WHERE recipient = $1`, id)).toEqual([])
    expect(after!.sequence).toBe(before!.sequence)
  }
})


// Round 7: payload authority is decided after buffering, not by pairing an old actor with a new fence.
const emitFixture = async (sessionBacked = false) => {
  const id = crypto.randomUUID()
  const repoId = "github/acme/emission"
  const session = crypto.randomUUID()
  const actor: Actor = { subject: { kind: "person", id }, role: "admin", login: "reader",
    ...(sessionBacked ? { session } : {}) }
  await sql(`INSERT INTO people (id, github_id, github_login) VALUES ($1, $2, 'reader')`, id, accountIdOf("reader"))
  await sql(`INSERT INTO github_repositories (repo_id, private, installation_id) VALUES ($1, true, $2)`, repoId, INSTALLATION_ID)
  await sql(`INSERT INTO watches (principal_id, subject, level) VALUES ($1, $2, 'all')`, id, `repo:${repoId}`)
  await sql(`INSERT INTO notifications (recipient, subject, kind, state, mine, repo_id, title, href, run_id)
    VALUES ($1, 'fleet', 'fleet', 'update', false, $2, 'historical fleet payload', '/app', NULL),
      ($1, 'followed', 'run', 'done', false, $2, 'followed payload', '/app', gen_random_uuid()),
      ($1, 'mine', 'run', 'done', true, NULL, 'own payload', '/app', gen_random_uuid())`, id, repoId)
  if (sessionBacked) await runtime.runPromise(Effect.gen(function* () {
    yield* SessionStore.createSession({ id: session, tokenDigest: crypto.randomUUID(), personId: id,
      role: "admin", roleGeneration: yield* SessionStore.roleObservation,
      access: { ciphertext: "unused", nonce: "unused" }, accessExpiresAt: null,
      refresh: null, refreshDigest: null, maxAgeSeconds: 3600 })
  }))
  const github = scriptedGitHub("acme", "emission")
  github.roles.set("reader", "admin")
  const scratch = await runtime.runPromise(Effect.service(TestDatabase.Scratch))
  const roles = await runtime.runPromise(RepoRoles.make(scratch.database, {
    repository: repositoryOf("acme/home"), app: Option.some(app({ privateKey: await appKey() })), http: github.http,
  }))
  const remember = (role: "admin" | "member" | null) => runtime.runPromise(Effect.gen(function* () {
    const client = yield* SqlClient.SqlClient
    const [at] = yield* client<{ at: string }>`SELECT clock_timestamp()::text AS at`
    return yield* RepoRoles.remember(repoId, id, role, at!.at)
  }))
  return { id, repoId, session, actor, github, scratch, roles, remember }
}

test("emit snapshot excludes non-mine rows when deployment denial lands between actor and fence reads", async () => {
  const f = await emitFixture(true)
  const sessions = Layer.succeed(Sessions, Sessions.of({ resolve: Effect.gen(function* () {
    // The actor was resolved from the old receipt. Renewal commits before the feed captures its sequences.
    yield* Effect.gen(function* () {
      yield* SessionStore.setRole(f.session, null, yield* SessionStore.roleObservation)
    }).pipe(Effect.provide(f.scratch.database), Effect.mapError(() => new SessionsUnavailable()))
    return Option.some(f.actor)
  }) }))
  const h = await harness(runtime, () => Stream.empty, { sessions, branchRoles: BranchRoles.layer(f.roles),
    fetch: async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      url.searchParams.set("table", `${f.scratch.name}.notifications`)
      return fetch(url, init)
    } })
  const response = await h.fetch(`${NOTIFICATIONS_SHAPE_ROUTE}?offset=-1`)
  expect(response.status).toBe(503)
  expect(response.headers.get("electric-offset")).toBeNull()
  expect(await response.text()).toBe("")
})

test("emit snapshot drops a cached fleet insert whose subject was pruned before a new request", async () => {
  const f = await emitFixture()
  let cached: { body: ArrayBuffer; status: number; headers: Headers } | undefined
  let replay = false
  const h = await harness(runtime, () => Stream.empty, { actor: f.actor, branchRoles: BranchRoles.layer(f.roles),
    fetch: async (input, init) => {
      if (!replay) {
        const url = new URL(input instanceof Request ? input.url : String(input))
        url.searchParams.set("table", `${f.scratch.name}.notifications`)
        const response = await fetch(url, init)
        cached = { body: await response.arrayBuffer(), status: response.status, headers: response.headers }
      }
      return new Response(cached!.body.slice(0), { status: cached!.status, headers: cached!.headers })
    } })
  expect((await values(await h.fetch(`${NOTIFICATIONS_SHAPE_ROUTE}?offset=-1`))).map(row => row.subject)).toContain("fleet")
  await f.remember("member")
  expect(await sql(`SELECT subject FROM notifications WHERE recipient = $1 AND kind = 'fleet'`, f.id)).toEqual([])
  replay = true
  const response = await h.fetch(`${NOTIFICATIONS_SHAPE_ROUTE}?offset=-1`)
  expect(response.status).toBe(200)
  expect((await values(response)).map(row => row.subject).sort()).toEqual(["followed", "mine"])
})

test.each(["denied", "outage"] as const)("unchanged withheld %s preserves an overlapping poll and its cursor", async (reason) => {
  const f = await emitFixture()
  if (reason === "denied") f.github.roles.delete("reader")
  else f.github.faults.push({ match: (_, path) => path.endsWith("/permission"), status: 429, headers: { "retry-after": "60" } })
  let hold = false
  let entered!: () => void
  let release!: () => void
  const atHold = new Promise<void>(resolve => { entered = resolve })
  const released = new Promise<void>(resolve => { release = resolve })
  const h = await harness(runtime, () => Stream.empty, { actor: f.actor, branchRoles: BranchRoles.layer(f.roles),
    fetch: async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      url.searchParams.set("table", `${f.scratch.name}.notifications`)
      const response = await fetch(url, init)
      const body = await response.arrayBuffer()
      if (hold) { entered(); await released }
      return new Response(body, { status: response.status, headers: response.headers })
    } })
  expect((await values(await h.fetch(`${NOTIFICATIONS_SHAPE_ROUTE}?offset=-1`))).map(row => row.subject)).toEqual(["mine"])
  const [before] = await sql(`SELECT denial_sequence::text AS sequence FROM notification_repository_access
    WHERE recipient = $1 AND repo_id = $2`, f.id, f.repoId) as Array<{ sequence: string }>
  hold = true
  const pending = h.fetch(`${NOTIFICATIONS_SHAPE_ROUTE}?offset=-1`)
  await atHold
  try {
    if (reason === "denied") await f.remember(null) // Identical authoritative receipts must commute too.
    const b = await proxy(f.actor, BranchRoles.layer(f.roles))
    expect((await b.h.fetch(`${NOTIFICATIONS_SHAPE_ROUTE}?offset=-1`)).status).toBe(200)
  } finally { hold = false; release() }
  const response = await pending
  expect(response.status).toBe(200)
  expect(response.headers.get("electric-offset")).not.toBeNull()
  expect((await values(response)).map(row => row.subject)).toEqual(["mine"])
  expect(await sql(`SELECT denial_sequence::text AS sequence FROM notification_repository_access
    WHERE recipient = $1 AND repo_id = $2`, f.id, f.repoId)).toEqual([before])
})


test.each(["refresh", "sign-in", "sign-out"] as const)("emit snapshot observes %s authority committed after the Electric body was buffered", async (receipt) => {
  const f = await emitFixture(true)
  let entered!: () => void
  let release!: () => void
  const atHold = new Promise<void>(resolve => { entered = resolve })
  const released = new Promise<void>(resolve => { release = resolve })
  const h = await harness(runtime, () => Stream.empty, { actor: f.actor, branchRoles: BranchRoles.layer(f.roles),
    fetch: async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      url.searchParams.set("table", `${f.scratch.name}.notifications`)
      const response = await fetch(url, init)
      const body = await response.arrayBuffer()
      entered(); await released
      return new Response(body, { status: response.status, headers: response.headers })
    } })
  const pending = h.fetch(`${NOTIFICATIONS_SHAPE_ROUTE}?offset=-1`)
  await atHold
  try {
    await runtime.runPromise(Effect.gen(function* () {
      if (receipt === "sign-out") yield* SessionStore.revoke({ id: f.session }, "sign_out")
      else if (receipt === "refresh") yield* SessionStore.setRole(f.session, null, yield* SessionStore.roleObservation)
      else yield* SessionStore.createSession({ id: crypto.randomUUID(), tokenDigest: crypto.randomUUID(), personId: f.id,
        role: null, roleGeneration: yield* SessionStore.roleObservation,
        access: { ciphertext: "unused", nonce: "unused" }, accessExpiresAt: null,
        refresh: null, refreshDigest: null, maxAgeSeconds: 3600 })
    }))
  } finally { release() }
  const response = await pending
  expect(response.status).toBe(503)
  expect(response.headers.get("electric-offset")).toBeNull()
  expect(await response.text()).toBe("")
  expect(h.line("notifications.access.emit").at(-1)?.annotations).toMatchObject({ cursorStable: true, subjects: receipt === "sign-out" ? 0 : 1 })
})

test.each(["deployment", "public-copy", "independent"] as const)("emit snapshot applies current %s authority to repository-scoped mine rows", async (basis) => {
  const f = await emitFixture(true)
  await sql(`DELETE FROM notifications WHERE recipient = $1 AND subject <> 'mine'`, f.id)
  await sql(`UPDATE notifications SET repo_id = $2 WHERE recipient = $1 AND subject = 'mine'`, f.id, f.repoId)
  if (basis === "public-copy") await sql(`UPDATE github_repositories SET installation_id = NULL, private = false,
    visibility_verified_at = clock_timestamp() WHERE repo_id = $1`, f.repoId)
  const roles = await runtime.runPromise(RepoRoles.make(f.scratch.database, {
    repository: repositoryOf(basis === "deployment" ? "acme/emission" : "acme/home"),
    app: Option.some(app({ privateKey: await appKey() })), http: f.github.http,
  }))
  let entered!: () => void
  let release!: () => void
  const atHold = new Promise<void>(resolve => { entered = resolve })
  const released = new Promise<void>(resolve => { release = resolve })
  const h = await harness(runtime, () => Stream.empty, { actor: f.actor, branchRoles: BranchRoles.layer(roles),
    fetch: async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      url.searchParams.set("table", `${f.scratch.name}.notifications`)
      const response = await fetch(url, init)
      const body = await response.arrayBuffer()
      expect(new TextDecoder().decode(body)).toContain("own payload")
      entered(); await released
      return new Response(body, { status: response.status, headers: response.headers })
    } })
  const pending = h.fetch(`${NOTIFICATIONS_SHAPE_ROUTE}?offset=-1`)
  await atHold
  try {
    await runtime.runPromise(Effect.gen(function* () {
      yield* SessionStore.setRole(f.session, null, yield* SessionStore.roleObservation)
    }))
  } finally { release() }
  const response = await pending
  if (basis === "independent") {
    expect(response.status).toBe(200)
    expect((await values(response)).map(row => row.subject)).toEqual(["mine"])
  } else {
    expect(await response.text()).not.toContain("own payload")
    expect(response.status).toBe(503)
    expect(response.headers.get("electric-offset")).toBeNull()
  }
})

test("deployment filtering preserves the cursor so a retained insert replays after restoration", async () => {
  const f = await emitFixture(true)
  await sql(`DELETE FROM notifications WHERE recipient = $1 AND subject <> 'mine'`, f.id)
  let hold = false
  let entered!: () => void
  let release!: () => void
  const atHold = new Promise<void>(resolve => { entered = resolve })
  const released = new Promise<void>(resolve => { release = resolve })
  const h = await harness(runtime, () => Stream.empty, { actor: f.actor, branchRoles: BranchRoles.layer(f.roles),
    fetch: async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      url.searchParams.set("table", `${f.scratch.name}.notifications`)
      const response = await fetch(url, init)
      const body = await response.arrayBuffer()
      if (hold) {
        expect(new TextDecoder().decode(body)).toContain("late followed payload")
        entered(); await released
      }
      return new Response(body, { status: response.status, headers: response.headers })
    } })
  let opened = await h.fetch(`${NOTIFICATIONS_SHAPE_ROUTE}?offset=-1`)
  let original = new URLSearchParams()
  // Finish Electric's initial snapshot pages before inserting the delta this test holds.
  // Every response must succeed; this follows protocol cursors, never retries a refusal.
  for (;;) {
    expect(opened.status).toBe(200)
    const messages = await opened.json() as Array<{ headers?: { control?: string } }>
    original = new URLSearchParams({ handle: opened.headers.get("electric-handle")!, offset: opened.headers.get("electric-offset")! })
    if (messages.some(row => row.headers?.control === "up-to-date")) break
    opened = await h.fetch(`${NOTIFICATIONS_SHAPE_ROUTE}?${original}`)
  }
  await sql(`INSERT INTO notifications (recipient, subject, kind, state, mine, run_id, repo_id, title, href)
    VALUES ($1, 'late-followed', 'run', 'done', false, gen_random_uuid(), $2, 'late followed payload', '/app')`, f.id, f.repoId)
  hold = true
  const pending = h.fetch(`${NOTIFICATIONS_SHAPE_ROUTE}?${original}&live=true`)
  await atHold
  const record = (role: "admin" | null) => runtime.runPromise(Effect.gen(function* () {
    yield* SessionStore.setRole(f.session, role, yield* SessionStore.roleObservation)
  }))
  try { await record(null) } finally { hold = false; release() }
  const withheld = await pending
  expect(await withheld.text()).not.toContain("late followed payload")
  // Follow the cursor the response really offered; 503 means retry the caller's unchanged original cursor.
  const next = withheld.headers.has("electric-offset")
    ? new URLSearchParams({ handle: withheld.headers.get("electric-handle")!, offset: withheld.headers.get("electric-offset")! })
    : original
  await record("admin")
  const recovered = await h.fetch(`${NOTIFICATIONS_SHAPE_ROUTE}?${next}`)
  expect(recovered.status).toBe(200)
  expect((await values(recovered)).map(row => row.subject)).toContain("late-followed")
  expect(withheld.status).toBe(503)
  expect(withheld.headers.get("electric-offset")).toBeNull()
})

test.each(["deployment-expiry", "permission-expiry", "visibility-expiry", "visibility-private", "installation-loss"] as const)(
  "emit snapshot observes %s after buffering without trusting the earlier projection", async (change) => {
    const f = await emitFixture(true)
    await sql(`DELETE FROM notifications WHERE recipient = $1 AND subject <> 'mine'`, f.id)
    await sql(`UPDATE notifications SET repo_id = $2 WHERE recipient = $1 AND subject = 'mine'`, f.id, f.repoId)
    const publicCopy = change === "visibility-expiry" || change === "visibility-private"
    if (publicCopy) await sql(`UPDATE github_repositories SET installation_id = NULL, private = false,
      visibility_verified_at = clock_timestamp() WHERE repo_id = $1`, f.repoId)
    const roles = await runtime.runPromise(RepoRoles.make(f.scratch.database, {
      repository: repositoryOf(change === "deployment-expiry" ? "acme/emission" : "acme/home"),
      app: Option.some(app({ privateKey: await appKey() })), http: f.github.http,
    }))
    let entered!: () => void
    let release!: () => void
    const atHold = new Promise<void>(resolve => { entered = resolve })
    const released = new Promise<void>(resolve => { release = resolve })
    const h = await harness(runtime, () => Stream.empty, { actor: f.actor, branchRoles: BranchRoles.layer(roles),
      fetch: async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : String(input))
        url.searchParams.set("table", `${f.scratch.name}.notifications`)
        const response = await fetch(url, init)
        const body = await response.arrayBuffer()
        expect(new TextDecoder().decode(body)).toContain("own payload")
        entered(); await released
        return new Response(body, { status: response.status, headers: response.headers })
      } })
    const pending = h.fetch(`${NOTIFICATIONS_SHAPE_ROUTE}?offset=-1`)
    await atHold
    try {
      if (change === "deployment-expiry") await sql(`UPDATE sessions SET role_verified_at = now() - interval '61 minutes' WHERE id = $1`, f.session)
      else if (change === "permission-expiry") await sql(`UPDATE github_repo_roles SET checked_at = now() - interval '6 minutes'
        WHERE repo_id = $1 AND person_id = $2`, f.repoId, f.id)
      else if (change === "visibility-expiry") await sql(`UPDATE github_repositories SET visibility_verified_at = now() - interval '61 seconds'
        WHERE repo_id = $1`, f.repoId)
      else if (change === "visibility-private") await sql(`UPDATE github_repositories SET private = true, visibility_verified_at = clock_timestamp()
        WHERE repo_id = $1`, f.repoId)
      else await sql(`UPDATE github_repositories SET installation_id = NULL WHERE repo_id = $1`, f.repoId)
    } finally { release() }
    const response = await pending
    expect(response.status).toBe(503)
    expect(response.headers.get("electric-offset")).toBeNull()
    expect(await response.text()).toBe("")
  },
)

test("deployment demotion without restoration removes buffered fleet rows from the current audience", async () => {
  const f = await emitFixture(true)
  const roles = await runtime.runPromise(RepoRoles.make(f.scratch.database, {
    repository: repositoryOf("acme/emission"), app: Option.some(app({ privateKey: await appKey() })), http: f.github.http,
  }))
  let entered!: () => void
  let release!: () => void
  const atHold = new Promise<void>(resolve => { entered = resolve })
  const released = new Promise<void>(resolve => { release = resolve })
  const h = await harness(runtime, () => Stream.empty, { actor: f.actor, branchRoles: BranchRoles.layer(roles),
    fetch: async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      url.searchParams.set("table", `${f.scratch.name}.notifications`)
      const response = await fetch(url, init)
      const body = await response.arrayBuffer()
      expect(new TextDecoder().decode(body)).toContain("historical fleet payload")
      entered(); await released
      return new Response(body, { status: response.status, headers: response.headers })
    } })
  const pending = h.fetch(`${NOTIFICATIONS_SHAPE_ROUTE}?offset=-1`)
  await atHold
  try {
    await runtime.runPromise(Effect.gen(function* () {
      yield* SessionStore.setRole(f.session, "member", yield* SessionStore.roleObservation)
    }))
  } finally { release() }
  const response = await pending
  expect(response.status).toBe(200)
  expect((await values(response)).map(row => row.subject).sort()).toEqual(["followed", "mine"])
  expect(await sql(`SELECT subject FROM notifications WHERE recipient = $1 AND kind = 'fleet'`, f.id)).toEqual([])
})

test.each(["excluded", "app-none"] as const)("installed public-copy grants stay readable when %s without a repository permission receipt", async (configuration) => {
  const f = await emitFixture(true)
  const actor = { ...f.actor, role: "member" as const }
  await runtime.runPromise(Effect.gen(function* () {
    yield* SessionStore.setRole(f.session, "member", yield* SessionStore.roleObservation)
  }))
  await sql(`DELETE FROM notifications WHERE recipient = $1 AND kind = 'fleet'`, f.id)
  await sql(`UPDATE github_repositories SET private = false, visibility_verified_at = clock_timestamp() WHERE repo_id = $1`, f.repoId)
  const roles = await runtime.runPromise(RepoRoles.make(f.scratch.database, {
    repository: repositoryOf("acme/home"), app: configuration === "excluded" ? Option.some(app({ privateKey: await appKey() })) : Option.none(),
    allowed: configuration === "excluded" ? Option.some(new Set(["github/acme/elsewhere"])) : Option.none(), http: f.github.http,
  }))
  const { h } = await proxy(actor, BranchRoles.layer(roles))
  for (const stale of [false, true]) {
    if (stale) await sql(`INSERT INTO github_repo_roles (repo_id, person_id, role, checked_at)
      VALUES ($1, $2, 'member', now() - interval '6 minutes')`, f.repoId, f.id)
    const response = await h.fetch(`${NOTIFICATIONS_SHAPE_ROUTE}?offset=-1`)
    expect(response.status).toBe(200)
    expect((await values(response)).map(row => row.subject).sort()).toEqual(["followed", "mine"])
  }
  expect(f.github.seen("GET", /\/permission$/)).toHaveLength(0)
})


test.each([
  ["cost", "admin", false, true], ["cost", "maintainer", false, false],
  ["cost", "member", true, true], ["cost", "member", false, false],
  ["stalled", "maintainer", false, true], ["stalled", "member", true, true],
  ["stalled", "member", false, false], ["waiting", "member", true, false],
  ["offline", "maintainer", true, false], ["failed", "member", true, true],
  ["failed", "member", false, false],
] as const)("fleet %s permits current %s with committer=%s only when eligible=%s", async (kind, role, committer, eligible) => {
  const f = await emitFixture(true)
  const alertId = crypto.randomUUID()
  const todoId = crypto.randomUUID()
  const attemptId = crypto.randomUUID()
  const agentKey = `audience-${alertId}`
  await sql(`INSERT INTO stacks (repo_id) VALUES ($1) ON CONFLICT DO NOTHING`, f.repoId)
  await sql(`INSERT INTO todos (id, repo_id, number, title, state, position, created_by, created_login)
    SELECT $1, $2, coalesce(max(number), 0) + 1, 'incident', 'working', coalesce(max(position), 0) + 1, $3, 'reader'
    FROM todos WHERE repo_id = $2`, todoId, f.repoId, committer ? f.id : "another-person")
  await sql(`INSERT INTO todo_attempts (id, todo_id, repo_id, ordinal, revision, status)
    VALUES ($1, $2, $3, 1, 1, 'running')`, attemptId, todoId, f.repoId)
  await sql(`INSERT INTO agent_runs (key, repo_id, agent, generation, todo_id, queued_at)
    VALUES ($1, $2, 'test', 1, $3, clock_timestamp())`, agentKey, f.repoId, todoId)
  await sql(`INSERT INTO fleet_alerts (id, kind, repo_id, subject, title, href)
    VALUES ($1, $2, $3, $4, 'incident', '/app')`, alertId, kind, f.repoId, kind === "failed" ? attemptId : agentKey)
  await sql(`UPDATE notifications SET subject = $2 WHERE recipient = $1 AND subject = 'fleet'`, f.id, `fleet:${alertId}`)
  await runtime.runPromise(Effect.gen(function* () {
    yield* SessionStore.setRole(f.session, role, yield* SessionStore.roleObservation)
  }))
  const roles = await runtime.runPromise(RepoRoles.make(f.scratch.database, {
    repository: repositoryOf("acme/emission"), app: Option.some(app({ privateKey: await appKey() })), http: f.github.http,
  }))
  const { h } = await proxy({ ...f.actor, role }, BranchRoles.layer(roles))
  const response = await h.fetch(`${NOTIFICATIONS_SHAPE_ROUTE}?offset=-1`)
  expect(response.status).toBe(200)
  const subjects = (await values(response)).map(row => row.subject)
  expect(subjects.includes(`fleet:${alertId}`)).toBe(eligible)
  expect(subjects).toContain("mine")
  expect(subjects).toContain("followed")
  expect(await sql(`SELECT subject FROM notifications WHERE recipient = $1 AND kind = 'fleet'`, f.id))
    .toEqual(eligible ? [{ subject: `fleet:${alertId}` }] : [])
})

test("explicit local grants remain local for an excluded installed private copy", async () => {
  const f = await emitFixture(true)
  await sql(`DELETE FROM notifications WHERE recipient = $1 AND kind = 'fleet'`, f.id)
  const roles = await runtime.runPromise(RepoRoles.make(f.scratch.database, {
    repository: repositoryOf("acme/home"), app: Option.some(app({ privateKey: await appKey() })), http: f.github.http,
    allowed: Option.some(new Set(["github/acme/elsewhere"])), local: true, localRoles: () => "member",
  }))
  const { h } = await proxy(f.actor, BranchRoles.layer(roles))
  const response = await h.fetch(`${NOTIFICATIONS_SHAPE_ROUTE}?offset=-1`)
  expect(response.status).toBe(200)
  expect((await values(response)).map(row => row.subject).sort()).toEqual(["followed", "mine"])
})

test("the emit snapshot uses the configured local grant after an installation disappears", async () => {
  const f = await emitFixture(true)
  const roles = await runtime.runPromise(RepoRoles.make(f.scratch.database, {
    repository: repositoryOf("acme/home"), app: Option.some(app({ privateKey: await appKey() })), http: f.github.http,
    local: true, localRoles: () => "member",
  }))
  let entered!: () => void
  let release!: () => void
  const atHold = new Promise<void>(resolve => { entered = resolve })
  const released = new Promise<void>(resolve => { release = resolve })
  const h = await harness(runtime, () => Stream.empty, { actor: f.actor, branchRoles: BranchRoles.layer(roles),
    fetch: async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      url.searchParams.set("table", `${f.scratch.name}.notifications`)
      const response = await fetch(url, init)
      const body = await response.arrayBuffer()
      entered(); await released
      return new Response(body, { status: response.status, headers: response.headers })
    } })
  const pending = h.fetch(`${NOTIFICATIONS_SHAPE_ROUTE}?offset=-1`)
  await atHold
  try { await sql(`UPDATE github_repositories SET installation_id = NULL WHERE repo_id = $1`, f.repoId) }
  finally { release() }
  const response = await pending
  expect(response.status).toBe(200)
  expect((await values(response)).map(row => row.subject).sort()).toEqual(["followed", "mine"])
  expect(await sql(`SELECT subject FROM notifications WHERE recipient = $1 AND kind = 'fleet'`, f.id)).toEqual([])
})

// The browser fleet store over the real route and Electric, with live Postgres changes and shared cached queries.
import { ShapeSource } from "@smthrs/effect-electric"
import { Effect, Layer, ManagedRuntime, Stream } from "effect"
import { FetchHttpClient } from "effect/http"
import { SqlClient } from "effect/sql"
import { expect, test } from "vitest"
import { Persistence } from "@smthrs/effect-tanstack-db"
import { AuthStore, SESSION } from "../auth/store"
import { replaceRole, RepoStore } from "../repo/store"
import { maintainer } from "../../../worker/feeds/test/harness.ts"
import { testFile } from "../../../worker/test/harness.ts"
import { fleetHarness } from "../../../worker/runners/test/fleet.ts"
import { isLive, RUN_STATES } from "./contract"
import { FleetStore } from "./store"

const server = testFile("fleet_browser")
const sql = <A>(body: (sql: SqlClient.SqlClient) => Effect.Effect<A, unknown>) => server.runPromise(Effect.flatMap(SqlClient.SqlClient, body))

test("each repository has one live run and machine query; timestamps and reported usage decode and update", async ({ signal }) => {
  await sql((sql) => Effect.all([
    sql`INSERT INTO agent_runs (key, repo_id, agent, generation, queued_at, claimed_at, state, context_tokens, cost_usd)
      VALUES ('old', 'github/smithersai/vibelang', 'coder', 1, '2026-10-31T12:00:00Z', NULL, 'queued', NULL, NULL),
        ('new', 'github/smithersai/vibelang', 'coder', 2, '2026-11-01T12:00:00Z', '2026-11-01T12:01:00Z', 'working', 812000, 1.25)`,
    sql`INSERT INTO runners (repo_id, name, token_sha256, capacity, added_by, seen_at, load1, disk_free_gb)
      VALUES ('github/smithersai/vibelang', 'zulu', repeat('b',64), 2, 'person', NULL, NULL, NULL),
        ('github/smithersai/vibelang', 'alpha', repeat('c',64), 3, 'person', '2026-11-01T12:00:00Z', 1.5, 24.75)`,
  ], { discard: true }))
  const h = await fleetHarness(server, { actor: maintainer })
  const runtime = ManagedRuntime.make(FleetStore.layer({ origin: h.origin }).pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, h.fetch))))
  try {
    const store = await runtime.runPromise(Effect.service(FleetStore))
    const [runs, same, machines] = await Promise.all([
      runtime.runPromise(store.runs("smithersai/vibelang")),
      runtime.runPromise(store.runs("smithersai/vibelang")),
      runtime.runPromise(store.machines("smithersai/vibelang")),
    ])
    expect(same).toBe(runs)
    expect(await runtime.runPromise(store.machines("smithersai/vibelang"))).toBe(machines)
    await runtime.runPromise(Effect.all([runs.preload, machines.preload]), { signal })
    expect(await runtime.runPromise(runs.toArray)).toMatchObject([
      { key: "new", queuedAt: "2026-11-01T12:00:00.000Z", claimedAt: "2026-11-01T12:01:00.000Z", contextTokens: 812000, costUsd: 1.25 },
      { key: "old", contextTokens: null, costUsd: null },
    ])
    expect(await runtime.runPromise(machines.toArray)).toMatchObject([
      { name: "alpha", capacity: 3, seenAt: "2026-11-01T12:00:00.000Z", load1: 1.5, diskFreeGb: 24.75 },
      { name: "zulu", seenAt: null, load1: null, diskFreeGb: null },
    ])
    await sql((sql) => sql`UPDATE agent_runs SET state = 'done', context_tokens = 900000 WHERE key = 'new'`)
    await runtime.runPromise(runs.rows.pipe(Stream.filter((rows) => rows.some((row) => row.key === "new" && row.state === "done")), Stream.runHead), { signal })
    expect(await runtime.runPromise(runs.toArray)).toMatchObject([{ key: "new", state: "done", contextTokens: 900000 }, { key: "old" }])
    await sql((sql) => sql`UPDATE runners SET held = 'load 31/24' WHERE name = 'alpha'`)
    await runtime.runPromise(machines.rows.pipe(Stream.filter((rows) => rows.some((row) => row.name === "alpha" && row.held === "load 31/24")), Stream.runHead), { signal })
    expect(await runtime.runPromise(machines.toArray)).toMatchObject([{ name: "alpha", held: "load 31/24" }, { name: "zulu" }])
    expect(h.electric.some((url) => url.searchParams.get("live") === "true")).toBe(true)
    expect(h.electric.every((url) =>
      !url.searchParams.has("live_sse") && !url.searchParams.has("experimental_live_sse"),
    )).toBe(true)
  } finally { await runtime.dispose() }
})

test("only queued, working, stalled and stopping runs still hold or await a slot", () => {
  expect(RUN_STATES.filter(isLive)).toEqual(["queued", "working", "stalled", "stopping"])
})

// Astra on the fleet store: a 403 stopped the shape and left what it had synced readable in the tab. A 401 stops it and
// keeps them, since only a session confirmed ended wipes (decision 0110, 2026-11-03).
test.each([[403, 0], [401, 1]] as const)("a shape's %s asks no more and leaves %i rows", async (status, left) => {
  const repository = `refused-${status}`
  const key = `private-${status}`
  await sql((sql) => sql`INSERT INTO agent_runs (key, repo_id, agent, generation, queued_at, claimed_at, state, context_tokens, cost_usd)
    VALUES (${key}, ${`github/smithersai/${repository}`}, 'coder', 1, '2026-11-01T12:00:00Z', NULL, 'queued', NULL, NULL)`)
  const h = await fleetHarness(server, { actor: maintainer })
  const refusing = { now: false, asked: 0 }
  const source = Layer.succeed(ShapeSource.ShapeSource, {
    request: (url: string, init: RequestInit) => Effect.suspend(() => {
      if (!refusing.now) return ShapeSource.fetchSource.request(url, init)
      refusing.asked += 1
      return Effect.succeed(new Response(null, { status }))
    }),
  })
  const runtime = ManagedRuntime.make(FleetStore.layer({ origin: h.origin }).pipe(
    Layer.provide(source),
    Layer.provide(Layer.succeed(FetchHttpClient.Fetch, h.fetch)),
  ))
  try {
    const store = await runtime.runPromise(Effect.service(FleetStore))
    const runs = await runtime.runPromise(store.runs(`smithersai/${repository}`))
    await runtime.runPromise(runs.preload)
    expect(await runtime.runPromise(runs.toArray)).toHaveLength(1)
    refusing.now = true
    await sql((sql) => sql`UPDATE agent_runs SET state = 'done' WHERE key = ${key}`)
    await expect.poll(() => refusing.asked, { timeout: 20_000 }).toBeGreaterThan(0)
    await expect.poll(async () => (await runtime.runPromise(runs.toArray)).length, { timeout: 5_000 }).toBe(left)
    const asked = refusing.asked
    await new Promise((resolve) => setTimeout(resolve, 1_000))
    expect(refusing.asked).toBe(asked)
    expect(await runtime.runPromise(runs.toArray)).toHaveLength(left)
  } finally {
    await runtime.dispose()
    await sql((sql) => sql`DELETE FROM agent_runs WHERE key = ${key}`)
  }
}, 60_000)

// Astra on d3cd07db: a stopped shape stayed stopped for good. A session check that confirms someone starts it again.
test("a stopped shape starts again once authority may have returned", async () => {
  const key = "private-recovers"
  await sql((sql) => sql`INSERT INTO agent_runs (key, repo_id, agent, generation, queued_at, claimed_at, state, context_tokens, cost_usd)
    VALUES (${key}, 'github/smithersai/recovers', 'coder', 1, '2026-11-01T12:00:00Z', NULL, 'queued', NULL, NULL)`)
  const h = await fleetHarness(server, { actor: maintainer })
  const refusing = { now: false }
  const source = Layer.succeed(ShapeSource.ShapeSource, {
    request: (url: string, init: RequestInit) => Effect.suspend(() => refusing.now
      ? Effect.succeed(new Response(null, { status: 403 }))
      : ShapeSource.fetchSource.request(url, init)),
  })
  const runtime = ManagedRuntime.make(FleetStore.layer({ origin: h.origin }).pipe(
    Layer.provideMerge(AuthStore.layer),
    Layer.provide(Persistence.memory),
    Layer.provide(source),
    Layer.provide(Layer.succeed(FetchHttpClient.Fetch, h.fetch)),
  ))
  try {
    const store = await runtime.runPromise(Effect.service(FleetStore))
    const auth = await runtime.runPromise(Effect.service(AuthStore))
    const runs = await runtime.runPromise(store.runs("smithersai/recovers"))
    await runtime.runPromise(runs.preload)
    refusing.now = true
    await sql((sql) => sql`UPDATE agent_runs SET state = 'done' WHERE key = ${key}`)
    await expect.poll(async () => (await runtime.runPromise(runs.toArray)).length, { timeout: 20_000 }).toBe(0)
    refusing.now = false
    await runtime.runPromise(auth.session.update(SESSION, (row) => { row.status = "signed_in" }))
    await runtime.runPromise(auth.sessionConfirmed)
    await expect.poll(async () => (await runtime.runPromise(runs.toArray)).length, { timeout: 20_000 }).toBe(1)
    // A reached server that couldn't verify the session: nothing restarts the shape (the plugin host's gate hides it).
    refusing.now = true
    await sql((sql) => sql`UPDATE agent_runs SET state = 'queued' WHERE key = ${key}`)
    await expect.poll(async () => (await runtime.runPromise(runs.toArray)).length, { timeout: 20_000 }).toBe(0)
    refusing.now = false
    await runtime.runPromise(auth.session.update(SESSION, (row) => { row.status = "unreachable"; row.unverifiable = true }))
    await runtime.runPromise(auth.sessionConfirmed)
    await new Promise((resolve) => setTimeout(resolve, 1_000))
    expect(await runtime.runPromise(runs.toArray)).toHaveLength(0)
  } finally {
    await runtime.dispose()
    await sql((sql) => sql`DELETE FROM agent_runs WHERE key = ${key}`)
  }
}, 60_000)

// Astra on 11855d97: a Member's machines are refused; once the role answer grants Maintainer they sync, though the
// answer was already "granted" before.
test("machines a Member was refused sync once a role answer grants Maintainer", async () => {
  const h = await fleetHarness(server, { actor: maintainer })
  const refusing = { now: true }
  const source = Layer.succeed(ShapeSource.ShapeSource, {
    request: (url: string, init: RequestInit) => Effect.suspend(() => refusing.now && new URL(url).pathname.includes("machines")
      ? Effect.succeed(new Response(null, { status: 403 }))
      : ShapeSource.fetchSource.request(url, init)),
  })
  const runtime = ManagedRuntime.make(FleetStore.layer({ origin: h.origin }).pipe(
    Layer.provideMerge(RepoStore.layer({ origin: h.origin })),
    Layer.provideMerge(AuthStore.layer),
    Layer.provide(Persistence.memory),
    Layer.provide(source),
    Layer.provide(Layer.succeed(FetchHttpClient.Fetch, h.fetch)),
  ))
  try {
    const repos = await runtime.runPromise(Effect.service(RepoStore))
    const id = "github/smithersai/vibelang"
    await runtime.runPromise(repos.roles.insert({ id, role: "member", own: false }))
    const store = await runtime.runPromise(Effect.service(FleetStore))
    const machines = await runtime.runPromise(store.machines("smithersai/vibelang"))
    // As a page that shows them does: the shape starts.
    void runtime.runPromise(Effect.ignore(machines.preload))
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(await runtime.runPromise(machines.toArray)).toEqual([])
    refusing.now = false
    // Astra on 342a97fb: while a reached server couldn't verify the session, a role answer restarts nothing.
    const auth = await runtime.runPromise(Effect.service(AuthStore))
    await runtime.runPromise(auth.session.update(SESSION, (row) => { row.status = "unreachable"; row.unverifiable = true }))
    await runtime.runPromise(repos.roles.update(id, (row) => { row.role = "maintainer" }))
    await new Promise((resolve) => setTimeout(resolve, 1_000))
    expect(await runtime.runPromise(machines.toArray)).toEqual([])
    await runtime.runPromise(auth.session.update(SESSION, (row) => { row.status = "signed_in"; row.unverifiable = false }))
    await runtime.runPromise(repos.roles.update(id, (row) => { row.role = "admin" }))
    await expect.poll(async () => (await runtime.runPromise(machines.toArray)).length, { timeout: 20_000 }).toBeGreaterThan(0)
  } finally { await runtime.dispose() }
}, 60_000)


// The data gate (decision 0110, 2026-11-03): what the store exposes of a repository's runs and machines holds nothing of
// it from the change that hides it, a refusal mark or a session a reached server couldn't verify, before any eviction.
test("its runs and machines drop a repository's rows in the change that hides it, and show them again", async () => {
  // The harness's roles make this person a Maintainer on smithersai/vibelang only: machines show to a Maintainer and up.
  const repository = "smithersai/vibelang"
  const id = `github/${repository}`
  await sql((sql) => Effect.all([
    sql`INSERT INTO agent_runs (key, repo_id, agent, generation, queued_at, claimed_at, state, context_tokens, cost_usd)
      VALUES ('gated-run', ${id}, 'coder', 1, '2026-11-01T12:00:00Z', NULL, 'queued', NULL, NULL)`,
    sql`INSERT INTO runners (repo_id, name, token_sha256, capacity, added_by, seen_at, load1, disk_free_gb)
      VALUES (${id}, 'gated', repeat('d',64), 1, 'person', NULL, NULL, NULL)`,
  ], { discard: true }))
  const h = await fleetHarness(server, { actor: maintainer })
  const runtime = ManagedRuntime.make(FleetStore.layer({ origin: h.origin }).pipe(
    Layer.provideMerge(RepoStore.layer({ origin: h.origin })),
    Layer.provideMerge(AuthStore.layer),
    Layer.provide(Persistence.memory),
    Layer.provide(Layer.succeed(FetchHttpClient.Fetch, h.fetch)),
  ))
  try {
    const repos = await runtime.runPromise(Effect.service(RepoStore))
    const auth = await runtime.runPromise(Effect.service(AuthStore))
    const member = { id, role: "maintainer" as const, own: false }
    await runtime.runPromise(repos.roles.insert(member))
    const store = await runtime.runPromise(Effect.service(FleetStore))
    const runs = await runtime.runPromise(store.runs(repository))
    const machines = await runtime.runPromise(store.machines(repository))
    // Both start on their first read, as a page's `useLiveQuery` starts them.
    runs.tanstack.startSyncImmediate()
    machines.tanstack.startSyncImmediate()
    await expect.poll(async () => [
      (await runtime.runPromise(runs.toArray)).some((run) => run.key === "gated-run"),
      (await runtime.runPromise(machines.toArray)).some((machine) => machine.name === "gated"),
    ], { timeout: 20_000 }).toEqual([true, true])
    const shown = [(await runtime.runPromise(runs.toArray)).length, (await runtime.runPromise(machines.toArray)).length]
    /** Both queries' row counts, read in the same Effect as `change`, with nothing run between. */
    const countsAfter = (change: Effect.Effect<unknown, unknown>) => runtime.runPromise(Effect.gen(function* () {
      yield* change
      return [(yield* runs.toArray).length, (yield* machines.toArray).length]
    }))
    expect(await countsAfter(auth.session.update(SESSION, (row) => { row.status = "unreachable"; row.unverifiable = true }))).toEqual([0, 0])
    expect(await countsAfter(auth.session.update(SESSION, (row) => { row.status = "signed_in"; delete row.unverifiable }))).toEqual(shown)
    expect(await countsAfter(replaceRole(repos, { id, role: null, own: false, refused: "forbidden" }))).toEqual([0, 0])
    expect(await countsAfter(replaceRole(repos, member))).toEqual(shown)
  } finally {
    await runtime.dispose()
    await sql((sql) => Effect.all([
      sql`DELETE FROM agent_runs WHERE key = 'gated-run'`,
      sql`DELETE FROM runners WHERE name = 'gated'`,
    ], { discard: true }))
  }
}, 60_000)

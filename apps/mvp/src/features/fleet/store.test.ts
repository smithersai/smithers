// The browser fleet store over the real route and Electric, with live Postgres changes and shared cached queries.
import { Effect, Layer, ManagedRuntime, Stream } from "effect"
import { FetchHttpClient } from "effect/http"
import { SqlClient } from "effect/sql"
import { expect, test } from "vitest"
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
  } finally { await runtime.dispose() }
})

test("only queued, working, stalled and stopping runs still hold or await a slot", () => {
  expect(RUN_STATES.filter(isLive)).toEqual(["queued", "working", "stalled", "stopping"])
})

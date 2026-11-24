import { Effect, Exit, Layer, Option } from "effect"
import { FetchHttpClient, HttpClient, HttpEffect, UrlParams } from "effect/http"
import { SqlClient } from "effect/sql"
import { beforeEach, describe, expect, test } from "vitest"
import {
  FLEET_ACCOUNTS_SHAPE_ROUTE,
  FLEET_NODES_SHAPE_ROUTE,
  FLEET_SESSIONS_SHAPE_ROUTE,
} from "../../src/features/fleet/globalContract.ts"
import { testFile } from "../test/harness.ts"
import * as Actor from "../Actor.ts"
import * as FleetMcpTools from "./FleetMcpTools.vibe"
import * as FleetShapes from "./FleetShapes.vibe"
import * as FleetStore from "./FleetStore.vibe"

const runtime = testFile("fleet_store")

beforeEach(() =>
  runtime.runPromise(
    Effect.flatMap(SqlClient.SqlClient, (sql) =>
      sql`TRUNCATE host_nodes, observed_sessions, provider_accounts, sandbox_generations CASCADE`
    ),
  )
)

describe("FleetStore (real Postgres)", () => {
  test("upserts host nodes, reconciles sessions with OBS-5 scrubbing, stores accounts, and projects open Cloudflare BranchSandboxes", async () => {
    await runtime.runPromise(
      Effect.gen(function* () {
        yield* FleetStore.upsertHostNode({
          nodeId: "node-1",
          name: "Node one",
          kind: "macbook",
          labels: ["macbook", "darwin", "arm64"],
          cpuCores: 16,
          memUsedGb: 42.1,
          memTotalGb: 64,
          diskFreeGb: 16.2,
          diskTotalGb: 1000,
          activeSessions: 2,
          runnerCapacity: 4,
          version: "1.0.0",
        })

        const reported = yield* FleetStore.reportSessions({
          nodeId: "node-1",
          replaceActive: true,
          sessions: [
            {
              sessionKey: "node-1:claude:s1",
              managed: false,
              harness: "claude",
              model: "claude-opus-4-7",
              accountLabel: "claude-1",
              repo: "smithers",
              lane: "feat/fleet",
              title: "Fix deploy with ghp_SecretToken1234567890abcdef and sk-ant-secret123",
              status: "working",
              pid: 4242,
              cpuSeconds: 18.5,
              tokensUsed: 12000,
            },
            {
              sessionKey: "node-1:agy-cli:conv-1",
              managed: false,
              harness: "agy-cli",
              model: "gemini-4-neon-high",
              accountLabel: "google-antigravity",
              title: "Smithers Multi-Host Monitoring",
              status: "working",
            },
          ],
        })
        expect(reported).toEqual({ nodeId: "node-1", reported: 2, active: 2 })

        // Second report with replaceActive=true drops s1 -> marks s1 as ended
        yield* FleetStore.reportSessions({
          nodeId: "node-1",
          replaceActive: true,
          sessions: [
            {
              sessionKey: "node-1:agy-cli:conv-1",
              managed: false,
              harness: "agy-cli",
              model: "gemini-4-neon-high",
              accountLabel: "google-antigravity",
              title: "Smithers Multi-Host Monitoring",
              status: "working",
            },
          ],
        })

        const accts = yield* FleetStore.reportAccounts({
          sourceNode: "node-1",
          accounts: [
            {
              accountKey: "claude:claude-1",
              provider: "claude",
              label: "claude-1",
              plan: "max",
              status: "ready",
              fiveHourPct: 14,
              weeklyPct: 48,
              activeSessions: 1,
              pools: ["max"],
            },
            {
              accountKey: "google-agy:google-antigravity",
              provider: "google-agy",
              label: "google-antigravity",
              plan: "google-gemini-only",
              status: "ready",
              activeSessions: 1,
              pools: ["agy-gemini"],
            },
          ],
        })
        expect(accts).toEqual({ reported: 2, applied: 2, sourceNode: "node-1" })

        // Seed an open Cloudflare BranchSandbox generation
        const sql = yield* SqlClient.SqlClient
        yield* sql`
          INSERT INTO sandbox_generations (branch_id, generation, kind, instance)
          VALUES ('smithersai/smithers#feat/fleet', 1, 'branch', 'do-inst-1')
        `

        const active = yield* FleetStore.readOverview(false)
        expect(active.nodes.map((n: Record<string, unknown>) => n["nodeId"])).toEqual([
          "node-1",
          "cloudflare-branch-sandbox",
        ])
        expect(active.sessions.map((s: Record<string, unknown>) => s["harness"]).sort()).toEqual([
          "agy-cli",
          "cf-sandbox",
        ])
        expect(active.accounts).toHaveLength(2)
        // Regression guard: bigint tokens_used must serialize cleanly with JSON.stringify (no BigInt TypeError).
        expect(() => JSON.stringify(active)).not.toThrow()

        const withEnded = yield* FleetStore.readOverview(true)
        const endedClaude = withEnded.sessions.find(
          (s: Record<string, unknown>) => s["sessionKey"] === "node-1:claude:s1"
        ) as Record<string, unknown> | undefined
        expect(endedClaude?.["status"]).toBe("ended")
        expect(String(endedClaude?.["title"])).not.toContain("ghp_SecretToken")
        expect(String(endedClaude?.["title"])).not.toContain("sk-ant-secret123")
        expect(String(endedClaude?.["title"])).toContain("[redacted]")
        expect(() => JSON.stringify(withEnded)).not.toThrow()
        expect(typeof endedClaude?.["tokensUsed"]).toBe("number")
      })
    )
  })
})

describe("FleetShapes authorization", () => {
  const ADMINS: ReadonlySet<string> = new Set(["maya"])
  const ROUTES = [FLEET_NODES_SHAPE_ROUTE, FLEET_SESSIONS_SHAPE_ROUTE, FLEET_ACCOUNTS_SHAPE_ROUTE]
  const admin: Actor.Actor = { subject: { kind: "person", id: "p-maya" }, role: "admin", login: "maya" }
  /** What Electric was asked, by table: a refused request never reaches it. */
  const runShape = async (route: string, actor: Option.Option<Actor.Actor>, admins?: ReadonlySet<string>) => {
    const asked: Array<string> = []
    // The stack's own Electric answers; the client only records which table each request names.
    const electric = Layer.effect(
      HttpClient.HttpClient,
      Effect.map(HttpClient.HttpClient, (client) =>
        HttpClient.tapRequest(client, (request) =>
          Effect.sync(() => void asked.push(String(UrlParams.toRecord(request.urlParams)["table"] ?? ""))))),
    ).pipe(Layer.provide(FetchHttpClient.layer))
    const shapes = await runtime.runPromise(FleetShapes.make(admins))
    const handler = HttpEffect.toWebHandler(
      shapes.fetch.pipe(Effect.provide(Layer.merge(Layer.succeed(Actor.Sessions, { resolve: Effect.succeed(actor) }), electric))),
    )
    const response = await handler(new Request(`http://smithers.test${route}?offset=-1`))
    return { status: response.status, asked }
  }

  test("signed-out gets 401 and non-admin contributor gets 403 on all 3 fleet shape routes", async () => {
    for (const route of ROUTES) {
      expect(await runShape(route, Option.none(), ADMINS)).toEqual({ status: 401, asked: [] })
      const contributor: Actor.Actor = { subject: { kind: "person", id: "p-contrib" }, role: "member", login: "alice" }
      expect(await runShape(route, Option.some(contributor), ADMINS)).toEqual({ status: 403, asked: [] })
    }
  })

  // R1-Astra-D4-004: nobody is a deployment admin until configuration names one.
  test("a deployment that names no admin refuses a repository Admin and the formerly built-in login", async () => {
    for (const route of ROUTES) {
      for (const login of ["roninjin10", "maya"]) {
        expect(await runShape(route, Option.some({ ...admin, login })), `${route} ${login}`).toEqual({ status: 403, asked: [] })
      }
    }
  })

  // R1-Astra-D4-002, R1-NEON-D4-004: the admin's cookie reaches Electric; a run acting for the same admin does not.
  test.each(["agent", "flow", "sandbox", "app"] as const)("an admin's person session reads each fleet shape; a %s credential for them is refused", async (kind) => {
    const tables = ["host_nodes", "observed_sessions", "provider_accounts"]
    for (const [index, route] of ROUTES.entries()) {
      // Electric decides the answer for a table of this file's schema; what matters is that it was asked.
      const reached = await runShape(route, Option.some(admin), ADMINS)
      expect(reached.asked, route).toEqual([tables[index]])
      expect([401, 403], route).not.toContain(reached.status)
      const delegated: Actor.Actor = { ...admin, act: { kind, id: "run-1", root: "run-1", chain: ["todo/Run"], ceiling: [["repo:read"]] } }
      expect(await runShape(route, Option.some(delegated), ADMINS), route).toEqual({ status: 403, asked: [] })
    }
  })
})

// A report's failures here are Postgres' own: no fake database stands in for it.
describe("FleetStore reports commit whole and keep the newest observation", () => {
  const rows = (query: string) =>
    runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) => sql.unsafe(query))) as Promise<ReadonlyArray<Record<string, unknown>>>
  const host = (nodeId: string) => FleetStore.upsertHostNode({ nodeId, name: nodeId, kind: "macbook" })
  const session = (sessionKey: string, more: Partial<FleetStore.ObservedSessionInput> = {}): FleetStore.ObservedSessionInput => ({
    sessionKey,
    harness: "claude",
    status: "working",
    ...more,
  })

  // R1-Astra-D4-014: a report whose last row Postgres refuses changes nothing.
  test("a report whose final row fails leaves the fleet as it was", async () => {
    await runtime.runPromise(host("node-1"))
    await runtime.runPromise(FleetStore.reportSessions({ nodeId: "node-1", replaceActive: true, sessions: [session("node-1:kept")] }))
    const exit = await runtime.runPromiseExit(FleetStore.reportSessions({
      nodeId: "node-1",
      replaceActive: true,
      // `pid` is an integer column: the last row overflows it, after the first row was written.
      sessions: [session("node-1:new"), session("node-1:bad", { pid: 3_000_000_000 })],
    }))
    expect(Exit.isFailure(exit)).toBe(true)
    expect(await rows(`SELECT session_key, status FROM observed_sessions ORDER BY session_key`)).toEqual([
      { session_key: "node-1:kept", status: "working" },
    ])
    expect(await rows(`SELECT active_sessions FROM host_nodes WHERE node_id = 'node-1'`)).toEqual([{ active_sessions: 1 }])
  })

  test("a one-session report on a two-session host counts both, and a key named twice counts once", async () => {
    await runtime.runPromise(host("node-1"))
    expect(await runtime.runPromise(FleetStore.reportSessions({ nodeId: "node-1", sessions: [session("node-1:a"), session("node-1:b")] })))
      .toEqual({ nodeId: "node-1", reported: 2, active: 2 })
    // An incremental report (no `replaceActive`) names one session: the other is still active.
    expect(await runtime.runPromise(FleetStore.reportSessions({ nodeId: "node-1", sessions: [session("node-1:a", { status: "idle" })] })))
      .toEqual({ nodeId: "node-1", reported: 1, active: 2 })
    expect(await rows(`SELECT active_sessions FROM host_nodes WHERE node_id = 'node-1'`)).toEqual([{ active_sessions: 2 }])
    // The same key twice is one session, as its last entry says.
    expect(await runtime.runPromise(FleetStore.reportSessions({
      nodeId: "node-1",
      sessions: [session("node-1:b", { title: "first" }), session("node-1:b", { status: "ended", title: "last" })],
    }))).toEqual({ nodeId: "node-1", reported: 1, active: 1 })
    expect(await rows(`SELECT session_key, status, title FROM observed_sessions ORDER BY session_key`)).toEqual([
      { session_key: "node-1:a", status: "idle", title: null },
      { session_key: "node-1:b", status: "ended", title: "last" },
    ])
    expect(await rows(`SELECT active_sessions FROM host_nodes WHERE node_id = 'node-1'`)).toEqual([{ active_sessions: 1 }])
  })

  test("an account report whose final row fails stores none of its accounts", async () => {
    const account = (accountKey: string, more: Partial<FleetStore.ProviderAccountInput> = {}): FleetStore.ProviderAccountInput => ({
      accountKey,
      provider: "claude",
      label: accountKey,
      status: "ready",
      ...more,
    })
    const exit = await runtime.runPromiseExit(FleetStore.reportAccounts({
      sourceNode: "node-1",
      // `active_sessions` is an integer column: the last account overflows it.
      accounts: [account("claude:one"), account("claude:two", { activeSessions: 3_000_000_000 })],
    }))
    expect(Exit.isFailure(exit)).toBe(true)
    expect(await rows(`SELECT account_key FROM provider_accounts`)).toEqual([])
  })

  // R1-Astra-D4-015: a delayed report never replaces a newer observation.
  test("two observations of one account delivered in reverse order keep every field of the newer", async () => {
    const newer: FleetStore.ProviderAccountInput = {
      accountKey: "claude:shared",
      provider: "claude",
      label: "shared",
      plan: "max",
      status: "limit_reached",
      fiveHourPct: 100,
      weeklyPct: 91,
      scopedPct: 12,
      resetsAt: "2026-11-23T15:00:00Z",
      grantsJson: { policy: "newer" },
      creditsBalance: 0,
      activeSessions: 3,
      pools: ["max"],
      coolReason: "five hour limit",
      coolUntil: "2026-11-23T15:00:00Z",
      checkedAt: "2026-11-23T12:00:00Z",
    }
    const older: FleetStore.ProviderAccountInput = {
      accountKey: "claude:shared",
      provider: "claude",
      label: "shared-old",
      plan: "pro",
      status: "ready",
      fiveHourPct: 10,
      weeklyPct: 20,
      scopedPct: 1,
      resetsAt: "2026-11-23T11:00:00Z",
      grantsJson: { policy: "older" },
      creditsBalance: 5,
      activeSessions: 0,
      pools: ["pro"],
      coolReason: null,
      coolUntil: null,
      checkedAt: "2026-11-23T11:59:00Z",
    }
    expect(await runtime.runPromise(FleetStore.reportAccounts({ sourceNode: "node-b", accounts: [newer] })))
      .toEqual({ sourceNode: "node-b", reported: 1, applied: 1 })
    expect(await runtime.runPromise(FleetStore.reportAccounts({ sourceNode: "node-a", accounts: [older] })))
      .toEqual({ sourceNode: "node-a", reported: 1, applied: 0 })
    const overview = await runtime.runPromise(FleetStore.readOverview(false))
    expect(overview.accounts).toHaveLength(1)
    expect(overview.accounts[0]).toMatchObject({
      accountKey: "claude:shared",
      label: "shared",
      plan: "max",
      status: "limit_reached",
      fiveHourPct: 100,
      weeklyPct: 91,
      scopedPct: 12,
      grantsJson: { policy: "newer" },
      creditsBalance: 0,
      activeSessions: 3,
      pools: ["max"],
      coolReason: "five hour limit",
      sourceNode: "node-b",
    })
    expect(await rows(`SELECT to_char(checked_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS at,
      to_char(resets_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS resets,
      to_char(cool_until AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS cool FROM provider_accounts`))
      .toEqual([{ at: "2026-11-23T12:00:00Z", resets: "2026-11-23T15:00:00Z", cool: "2026-11-23T15:00:00Z" }])
    // The same instant from two nodes: the node whose name sorts last stands, whichever arrives first.
    const tied = (label: string): FleetStore.ProviderAccountInput => ({ ...newer, accountKey: "claude:tied", label, checkedAt: "2026-11-23T13:00:00Z" })
    await runtime.runPromise(FleetStore.reportAccounts({ sourceNode: "node-b", accounts: [tied("from-b")] }))
    expect(await runtime.runPromise(FleetStore.reportAccounts({ sourceNode: "node-a", accounts: [tied("from-a")] })))
      .toMatchObject({ applied: 0 })
    expect(await rows(`SELECT label, source_node FROM provider_accounts WHERE account_key = 'claude:tied'`))
      .toEqual([{ label: "from-b", source_node: "node-b" }])
    // A newer observation still lands.
    expect(await runtime.runPromise(FleetStore.reportAccounts({
      sourceNode: "node-a",
      accounts: [{ ...older, checkedAt: "2026-11-23T12:30:00Z" }],
    }))).toMatchObject({ applied: 1 })
    expect(await rows(`SELECT label, source_node FROM provider_accounts WHERE account_key = 'claude:shared'`))
      .toEqual([{ label: "shared-old", source_node: "node-a" }])
  })

  // R1-Astra-D4-011, R1-NEON-D4-015: no unapproved or secret-looking text reaches Postgres or the overview.
  test("grant telemetry is stored as its approved fields only and free-form texts are scrubbed", async () => {
    const SECRET = "ghp_SecretToken1234567890abcdef"
    await runtime.runPromise(FleetStore.upsertHostNode({
      nodeId: "node-1",
      name: `Host ${SECRET}`,
      kind: "macbook",
      labels: ["darwin", `TOKEN=${SECRET}`, "darwin"],
    }))
    await runtime.runPromise(FleetStore.reportAccounts({
      sourceNode: "node-1",
      accounts: [{
        accountKey: "claude:one",
        provider: "claude",
        label: `label ${SECRET}`,
        plan: `plan ${SECRET}`,
        status: "ready",
        pools: ["max", `pool ${SECRET}`],
        grantsJson: {
          policy: `policy ${SECRET}`,
          resetCreditsAvailable: 2,
          account: { email: "sentinel-nested@example.test", token: "sentinel-nested-token" },
          grants: [{ name: "weekly", pct: 40, rawPrompt: "sentinel-nested-prompt" }],
        },
      }],
    }))
    const stored = await rows(`SELECT label, plan, pools, grants_json FROM provider_accounts`)
    expect(stored).toEqual([{
      label: "label [redacted]",
      plan: "plan [redacted]",
      pools: ["max", "pool [redacted]"],
      grants_json: { policy: "policy [redacted]", resetCreditsAvailable: 2, grants: [{ name: "weekly", pct: 40 }] },
    }])
    expect(await rows(`SELECT name, labels FROM host_nodes`)).toEqual([{ name: "Host [redacted]", labels: ["darwin", "[redacted]"] }])
    // A row stored before the allowlist existed is read through it.
    await rows(`UPDATE provider_accounts SET grants_json = '{"policy":"kept","leak":{"token":"sentinel-stored"}}'::jsonb`)
    const overview = await runtime.runPromise(FleetStore.readOverview(false))
    expect(overview.accounts[0]).toMatchObject({ grantsJson: { policy: "kept" } })
    const everything = JSON.stringify([overview, stored])
    expect(everything).not.toContain("sentinel")
    expect(everything).not.toContain("ghp_")
  })
})

// R1-Astra-D4-001: a refused fleet tool call changes no fleet row, with Postgres there to be changed.
describe("FleetMcpTools against Postgres", () => {
  const ADMINS: ReadonlySet<string> = new Set(["maya"])
  const principal = (repoScope: string | null) =>
    Option.some({
      tokenId: "tok-1",
      personId: "p-1",
      login: "maya",
      clientName: "test-agent",
      repoScope,
      scopes: ["mcp:read", "mcp:write"] as const,
      actor: { subject: { kind: "person" as const, id: "p-1" }, role: null, login: "maya", act: { kind: "agent" as const, id: "mcp:tok-1" } },
    })
  const call = (name: FleetMcpTools.FleetToolName, args: unknown, repoScope: string | null) =>
    runtime.runPromiseExit(FleetMcpTools.callFleetTool(
      name,
      args,
      { principal: principal(repoScope), requestId: "req-1", origin: "https://smithers.test" },
      // The file's own database answers: the runtime already provides it.
      Layer.empty as unknown as Layer.Layer<SqlClient.SqlClient, never>,
      ADMINS,
    ))
  const counts = () =>
    runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) => sql<{ nodes: number; sessions: number; accounts: number }>`
      SELECT (SELECT count(*)::int FROM host_nodes) AS nodes, (SELECT count(*)::int FROM observed_sessions) AS sessions,
        (SELECT count(*)::int FROM provider_accounts) AS accounts`))

  test("a repository-pinned admin token writes nothing; the same admin's unpinned token writes", async () => {
    const heartbeat = { nodeId: "node-1", name: "Node one", kind: "macbook" }
    const sessions = { nodeId: "node-1", sessions: [{ sessionKey: "node-1:s1", harness: "claude", status: "working" }] }
    const accounts = { sourceNode: "node-1", accounts: [{ accountKey: "claude:one", provider: "claude", label: "one", status: "ready" }] }
    for (const [name, args] of [["fleet_heartbeat", heartbeat], ["fleet_sessions_report", sessions], ["fleet_accounts_report", accounts], ["fleet_overview", {}]] as const) {
      expect(Exit.isFailure(await call(name, args, "github/acme/widgets")), name).toBe(true)
    }
    expect(await counts()).toEqual([{ nodes: 0, sessions: 0, accounts: 0 }])
    for (const [name, args] of [["fleet_heartbeat", heartbeat], ["fleet_sessions_report", sessions], ["fleet_accounts_report", accounts], ["fleet_overview", {}]] as const) {
      expect(Exit.isSuccess(await call(name, args, null)), name).toBe(true)
    }
    expect(await counts()).toEqual([{ nodes: 1, sessions: 1, accounts: 1 }])
  })
})

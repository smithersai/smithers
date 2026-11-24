import { Effect, Exit, Layer, Option } from "effect"
import { FetchHttpClient, HttpClient, HttpEffect, UrlParams } from "effect/http"
import { SqlClient } from "effect/sql"
import { beforeAll, beforeEach, describe, expect, test } from "vitest"
import scrubFleetTranscripts from "../../db/migrations/0131_scrub_fleet_transcripts.ts"
import {
  ACTIVE_SESSIONS_WHERE,
  FLEET_ACCOUNTS_SHAPE_ROUTE,
  FLEET_NODES_SHAPE_ROUTE,
  FLEET_SESSIONS_SHAPE_ROUTE,
  PROVIDER_ACCOUNT_COLUMNS,
} from "../../src/features/fleet/globalContract.ts"
import { FLEET_REPORT_MAX_BYTES, MIN_TRANSCRIPT_ENTRIES, planSessionsReport } from "../../src/features/fleet/snapshotBudget.ts"
import { MCP_MAX_REQUEST_BYTES, MCP_ROUTE } from "../../src/features/mcp/contract.ts"
import { testFile } from "../test/harness.ts"
import * as Actor from "../Actor.ts"
import * as McpApi from "../mcp/Api.ts"
import { McpAuthService, type McpPrincipal, McpToolRegistry } from "../mcp/Contract.ts"
import { makeLiveToolDeps, makeMcpToolRegistry } from "../mcp/Tools.ts"
import * as FleetMcpTools from "./FleetMcpTools.vibe"
import * as FleetShapes from "./FleetShapes.vibe"
import * as FleetStore from "./FleetStore.vibe"

const runtime = testFile("fleet_store")

// Migration 0131 creates the snapshot staging table. It can run again on a schema that already has it.
beforeAll(() => runtime.runPromise(scrubFleetTranscripts))

beforeEach(() =>
  runtime.runPromise(
    Effect.flatMap(SqlClient.SqlClient, (sql) =>
      sql`TRUNCATE host_nodes, observed_sessions, provider_accounts, sandbox_generations,
        fleet_session_snapshot_keys, fleet_session_snapshot_receipts CASCADE`
    ),
  )
)

/** Shaped as `ops/machine-token/issue.ts` issues one (`smm_` and 43 base64url characters), and never issued. */
const MACHINE_TOKEN = `smm_${"Ab3-_xY9".repeat(6).slice(0, 43)}`

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

        const cfSession = active.sessions.find(
          (s: Record<string, unknown>) => s["harness"] === "cf-sandbox"
        ) as Record<string, unknown> | undefined
        expect(cfSession?.["project"]).toBe("smithersai/smithers")
        expect(cfSession?.["summary"]).toBe("BranchSandbox branch smithersai/smithers#feat/fleet (gen 1)")
        expect(cfSession?.["cwd"]).toBeNull()
        expect(cfSession?.["transcriptJson"]).toBeNull()
      })
    )
  })

  test("persists and reads project, summary, cwd, and OBS-5 scrubbed transcriptJson capped to last 24 entries", async () => {
    await runtime.runPromise(
      Effect.gen(function* () {
        yield* FleetStore.upsertHostNode({
          nodeId: "node-obs",
          name: "Mac mini",
          kind: "mac-mini",
          labels: ["mac-mini"],
        })

        const secret = "ghp_SecretToken1234567890abcdef"
        const rawEntries = Array.from({ length: 30 }, (_, i) => ({
          ts: `2026-11-24T04:00:${String(i).padStart(2, "0")}Z`,
          role: i % 3 === 0 ? "user" : i % 3 === 1 ? "tool" : "assistant",
          label: i === 29 ? `Bash ${secret}` : i % 3 === 1 ? "Edit" : "assistant",
          text: i === 29
            ? `Ran deploy with ${secret} and sk-ant-api03-secretvalue and TOKEN=supersecret`
            : `Step ${i} completed cleanly`,
        }))

        const reported = yield* FleetStore.reportSessions({
          nodeId: "node-obs",
          replaceActive: true,
          sessions: [
            {
              sessionKey: "node-obs:claude:obs-1",
              managed: false,
              harness: "claude",
              model: "claude-opus-4-7",
              accountLabel: "claude-1",
              repo: "smithers-fleet-byoa",
              project: "smithersai/smithers",
              lane: "feat/observability",
              title: "Fleet observability upgrade",
              summary: `Upgrade fleet collectors with ${secret} — running vitest`,
              cwd: "/Users/williamcory/smithers-fleet-byoa",
              transcriptJson: rawEntries,
              status: "working",
              pid: 9001,
              cpuSeconds: 12.4,
              tokensUsed: 98765,
            },
          ],
        })
        expect(reported).toEqual({ nodeId: "node-obs", reported: 1, active: 1 })

        const overview = yield* FleetStore.readOverview(false)
        expect(() => JSON.stringify(overview)).not.toThrow()
        const serialized = JSON.stringify(overview)
        expect(serialized).not.toContain("ghp_SecretToken")
        expect(serialized).not.toContain("sk-ant-api03")
        expect(serialized).not.toContain("TOKEN=supersecret")

        const row = overview.sessions.find(
          (s: Record<string, unknown>) => s["sessionKey"] === "node-obs:claude:obs-1"
        ) as Record<string, unknown> | undefined
        expect(row).toBeDefined()
        expect(row?.["project"]).toBe("smithersai/smithers")
        expect(row?.["cwd"]).toBe("/Users/williamcory/smithers-fleet-byoa")
        expect(String(row?.["summary"])).toContain("[redacted]")
        expect(String(row?.["summary"])).toContain("running vitest")
        const transcript = row?.["transcriptJson"] as ReadonlyArray<Record<string, unknown>>
        expect(Array.isArray(transcript)).toBe(true)
        expect(transcript).toHaveLength(24)
        // Keeps the last 24 entries (indices 6..29)
        expect(transcript[0]?.["text"]).toBe("Step 6 completed cleanly")
        expect(transcript[23]?.["label"]).toBe("Bash [redacted]")
        expect(String(transcript[23]?.["text"])).toContain("[redacted]")
        expect(String(transcript[23]?.["text"])).not.toContain(secret)
      })
    )
  })
})

describe("FleetShapes authorization", () => {
  const ADMINS: ReadonlySet<string> = new Set(["maya"])
  const ROUTES = [FLEET_NODES_SHAPE_ROUTE, FLEET_SESSIONS_SHAPE_ROUTE, FLEET_ACCOUNTS_SHAPE_ROUTE]
  const admin: Actor.Actor = { subject: { kind: "person", id: "p-maya" }, role: "admin", login: "maya" }
  /** What Electric was asked, by table: a refused request never reaches it. */
  const runShape = async (
    route: string,
    actor: Option.Option<Actor.Actor>,
    admins?: ReadonlySet<string>,
    sent: Array<Record<string, string | ReadonlyArray<string>>> = [],
  ) => {
    const asked: Array<string> = []
    // The stack's own Electric answers; the client only records which table each request names.
    const electric = Layer.effect(
      HttpClient.HttpClient,
      Effect.map(HttpClient.HttpClient, (client) =>
        HttpClient.tapRequest(client, (request) =>
          Effect.sync(() => {
            const params = UrlParams.toRecord(request.urlParams)
            sent.push(params)
            asked.push(String(params["table"] ?? ""))
          }))),
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

  // R2-Astra-D4-015, R2-Fable-D4-011: an ended session, and its transcript, is never replicated to a browser.
  test("the session shape asks Electric only for sessions that have not ended", async () => {
    const sent: Array<Record<string, string | ReadonlyArray<string>>> = []
    await runShape(FLEET_SESSIONS_SHAPE_ROUTE, Option.some(admin), ADMINS, sent)
    expect(ACTIVE_SESSIONS_WHERE).toBe("status <> 'ended'")
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ table: "observed_sessions", where: "status <> 'ended'" })
    // The other fleet shapes are whole tables.
    for (const route of [FLEET_NODES_SHAPE_ROUTE, FLEET_ACCOUNTS_SHAPE_ROUTE]) {
      const other: Array<Record<string, string | ReadonlyArray<string>>> = []
      await runShape(route, Option.some(admin), ADMINS, other)
      expect(other[0]?.["where"], route).toBeUndefined()
    }
  })

  // R2-Astra-D4-004: a legacy row's disallowed grant fields reach neither Electric nor the overview.
  test("a legacy grants_json row is outside the account shape's columns and is read through the allowlist", async () => {
    await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) => sql`
      INSERT INTO provider_accounts (account_key, provider, label, status, grants_json)
      VALUES ('claude:legacy', 'claude', 'legacy', 'ready', ${JSON.stringify({ policy: "kept", leak: { token: "sentinel-legacy-grant" } })}::jsonb)
    `))
    const sent: Array<Record<string, string | ReadonlyArray<string>>> = []
    await runShape(FLEET_ACCOUNTS_SHAPE_ROUTE, Option.some(admin), ADMINS, sent)
    expect(sent).toHaveLength(1)
    const columns = String(sent[0]?.["columns"]).split(",")
    expect(columns).toEqual([...PROVIDER_ACCOUNT_COLUMNS])
    expect(columns).not.toContain("grants_json")
    expect(columns).toContain("account_key")
    const overview = await runtime.runPromise(FleetStore.readOverview(false))
    expect(overview.accounts).toHaveLength(1)
    expect(overview.accounts[0]).toMatchObject({ accountKey: "claude:legacy", grantsJson: { policy: "kept" } })
    expect(JSON.stringify(overview)).not.toContain("sentinel")
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

  // R2-Astra-D4-018: only a heartbeat that states a count changes it.
  test("a heartbeat that omits activeSessions keeps the host's count, and an explicit zero replaces it", async () => {
    const count = () => rows(`SELECT active_sessions FROM host_nodes WHERE node_id = 'node-1'`)
    await runtime.runPromise(host("node-1"))
    // A new host that states no count has none.
    expect(await count()).toEqual([{ active_sessions: 0 }])
    await runtime.runPromise(FleetStore.reportSessions({ nodeId: "node-1", sessions: [session("node-1:a"), session("node-1:b")] }))
    expect(await count()).toEqual([{ active_sessions: 2 }])
    await runtime.runPromise(host("node-1"))
    expect(await count()).toEqual([{ active_sessions: 2 }])
    await runtime.runPromise(FleetStore.upsertHostNode({ nodeId: "node-1", name: "node-1", kind: "macbook", activeSessions: 0 }))
    expect(await count()).toEqual([{ active_sessions: 0 }])
    await runtime.runPromise(FleetStore.upsertHostNode({ nodeId: "node-1", name: "node-1", kind: "macbook", activeSessions: 5 }))
    expect(await count()).toEqual([{ active_sessions: 5 }])
  })

  // R2-Fable-D4-011: the table keeps recent history, not every session the fleet ever ran.
  test("the next report deletes sessions that ended more than the retention ago and keeps the rest", async () => {
    await runtime.runPromise(host("node-1"))
    await runtime.runPromise(FleetStore.reportSessions({
      nodeId: "node-1",
      sessions: [session("node-1:old"), session("node-1:recent"), session("node-1:live"), session("node-1:undated", { status: "ended" })],
    }))
    await runtime.runPromise(FleetStore.reportSessions({ nodeId: "node-1", replaceActive: true, sessions: [session("node-1:live")] }))
    await rows(`UPDATE observed_sessions SET ended_at = now() - interval '${FleetStore.ENDED_SESSION_RETENTION_DAYS} days 1 hour'
      WHERE session_key = 'node-1:old'`)
    await rows(`UPDATE observed_sessions SET ended_at = now() - interval '${FleetStore.ENDED_SESSION_RETENTION_DAYS - 1} days'
      WHERE session_key = 'node-1:recent'`)
    // An active session is kept however long ago it was last named.
    await rows(`UPDATE observed_sessions SET updated_at = now() - interval '90 days' WHERE session_key = 'node-1:live'`)
    // Another host's report prunes too: a host that stopped reporting never would.
    await runtime.runPromise(FleetStore.reportSessions({ nodeId: "node-2", sessions: [session("node-2:a")] }))
    expect(await rows(`SELECT session_key, status FROM observed_sessions ORDER BY session_key`)).toEqual([
      { session_key: "node-1:live", status: "working" },
      { session_key: "node-1:recent", status: "ended" },
      { session_key: "node-1:undated", status: "ended" },
      { session_key: "node-2:a", status: "working" },
    ])
    // An ended session with no end time goes once nothing has named it for the retention.
    await rows(`UPDATE observed_sessions SET updated_at = now() - interval '${FleetStore.ENDED_SESSION_RETENTION_DAYS} days 1 hour'
      WHERE session_key = 'node-1:undated'`)
    await runtime.runPromise(FleetStore.reportSessions({ nodeId: "node-2", sessions: [] }))
    expect((await rows(`SELECT session_key FROM observed_sessions ORDER BY session_key`)).map((row) => row["session_key"]))
      .toEqual(["node-1:live", "node-1:recent", "node-2:a"])
  })

  // R2-Fable-D4-012: a reporter whose clock runs ahead cannot shut out later observations.
  test("a checkedAt a year ahead is stored as now, so the next report without one applies", async () => {
    const account = (label: string, more: Partial<FleetStore.ProviderAccountInput> = {}): FleetStore.ProviderAccountInput => ({
      accountKey: "claude:ahead",
      provider: "claude",
      label,
      status: "ready",
      ...more,
    })
    const ahead = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString()
    expect(await runtime.runPromise(FleetStore.reportAccounts({ sourceNode: "node-1", accounts: [account("ahead", { checkedAt: ahead })] })))
      .toMatchObject({ applied: 1 })
    expect(await rows(`SELECT checked_at <= now() AS clamped FROM provider_accounts`)).toEqual([{ clamped: true }])
    expect(await runtime.runPromise(FleetStore.reportAccounts({ sourceNode: "node-1", accounts: [account("later")] })))
      .toMatchObject({ applied: 1 })
    expect(await rows(`SELECT label FROM provider_accounts`)).toEqual([{ label: "later" }])
    // A past observation is still stored as its reporter dated it.
    await runtime.runPromise(FleetStore.reportAccounts({
      sourceNode: "node-1",
      accounts: [{ ...account("past"), accountKey: "claude:past", checkedAt: "2026-01-02T03:04:05Z" }],
    }))
    expect(await rows(`SELECT to_char(checked_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS at
      FROM provider_accounts WHERE account_key = 'claude:past'`)).toEqual([{ at: "2026-01-02T03:04:05Z" }])
  })

  // R2-Astra-D4-001: a machine token never reaches a stored row, the overview or a device, whenever the row was written.
  test("a Smithers machine token is redacted at ingestion, in the overview, and in a row stored before the rule", async () => {
    await runtime.runPromise(host("node-1"))
    await runtime.runPromise(FleetStore.reportSessions({
      nodeId: "node-1",
      sessions: [session("node-1:leaky", {
        title: `Deploy with ${MACHINE_TOKEN}`,
        summary: `export SMITHERS=${MACHINE_TOKEN} then push`,
        lane: `lane/${MACHINE_TOKEN}`,
        cwd: `/tmp/${MACHINE_TOKEN}/work`,
        transcriptJson: [
          { ts: "2026-11-23T10:00:00Z", role: "user", label: null, text: `use ${MACHINE_TOKEN} for the issue write` },
          { ts: "2026-11-23T10:00:01Z", role: "tool", label: `Bash ${MACHINE_TOKEN}`, text: `curl -H "Authorization: Bearer ${MACHINE_TOKEN}" https://smithers.test` },
          { ts: "2026-11-23T10:00:02Z", role: "assistant", label: null, text: `Done. Token:${MACHINE_TOKEN}.` },
        ],
      })],
    }))
    const storedRows = await rows(`SELECT title, summary, lane, cwd, transcript_json::text AS transcript FROM observed_sessions`)
    expect(storedRows).toHaveLength(1)
    expect(JSON.stringify(storedRows)).not.toContain("smm_")
    expect(storedRows[0]?.["title"]).toBe("Deploy with [redacted]")
    const storedTranscript = JSON.parse(String(storedRows[0]?.["transcript"])) as ReadonlyArray<Record<string, unknown>>
    expect(storedTranscript).toHaveLength(3)
    expect(storedTranscript[0]?.["text"]).toBe("use [redacted] for the issue write")
    expect(storedTranscript[1]?.["label"]).toBe("Bash [redacted]")

    // A row as a worker before the rule stored it: the token passed the old pattern untouched.
    const legacyTranscript = JSON.stringify([
      { ts: null, role: "tool", label: `Bash ${MACHINE_TOKEN}`, text: `curl -H "x-smithers: ${MACHINE_TOKEN}" https://smithers.test` },
      { ts: null, role: "assistant", label: null, text: "kept text" },
    ])
    await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) => sql`
      INSERT INTO observed_sessions (session_key, node_id, harness, status, title, summary, cwd, transcript_json)
      VALUES ('node-old:claude:legacy', 'node-old', 'claude', 'working', ${`Legacy ${MACHINE_TOKEN}`}, ${`ran ${MACHINE_TOKEN}`},
        ${`/tmp/${MACHINE_TOKEN}`}, ${legacyTranscript}::jsonb)
    `))
    expect(JSON.stringify(await rows(`SELECT title, transcript_json::text AS transcript FROM observed_sessions WHERE session_key = 'node-old:claude:legacy'`)))
      .toContain(MACHINE_TOKEN)
    const overview = await runtime.runPromise(FleetStore.readOverview(true))
    expect(overview.sessions).toHaveLength(2)
    expect(JSON.stringify(overview)).not.toContain("smm_")
    const legacy = overview.sessions.find((row: Record<string, unknown>) => row["sessionKey"] === "node-old:claude:legacy") as Record<string, unknown>
    expect(legacy["title"]).toBe("Legacy [redacted]")
    expect(legacy["transcriptJson"]).toEqual([
      { ts: null, role: "tool", label: "Bash [redacted]", text: 'curl -H "x-smithers: [redacted]" https://smithers.test' },
      { ts: null, role: "assistant", label: null, text: "kept text" },
    ])

    // Electric serves the column as stored, so migration 0131 rewrites what is stored.
    await runtime.runPromise(scrubFleetTranscripts)
    const migrated = await rows(`SELECT session_key, title, summary, cwd, transcript_json FROM observed_sessions ORDER BY session_key`)
    expect(JSON.stringify(migrated)).not.toContain("smm_")
    expect(migrated).toEqual([
      { session_key: "node-1:leaky", title: "Deploy with [redacted]", summary: expect.any(String), cwd: expect.any(String), transcript_json: null },
      { session_key: "node-old:claude:legacy", title: "Legacy [redacted]", summary: "ran [redacted]", cwd: "/tmp/[redacted]", transcript_json: null },
    ])
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

  /** A call's outcome: `ok`, or the code the tool refused it with. */
  const codeOf = (exit: Exit.Exit<unknown, unknown>) => {
    if (Exit.isSuccess(exit)) return "ok"
    const error = Option.getOrUndefined(Exit.findErrorOption(exit))
    return typeof error === "object" && error !== null && "code" in error ? String(error.code) : "died"
  }

  // R2-Astra-D4-001: the read-only overview tool returns no machine token from a row stored before the rule.
  test("fleet_overview returns a pre-upgrade transcript without its machine token", async () => {
    await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) => sql`
      INSERT INTO observed_sessions (session_key, node_id, harness, status, title, transcript_json)
      VALUES ('node-old:claude:legacy', 'node-old', 'claude', 'working', ${`Legacy ${MACHINE_TOKEN}`},
        ${JSON.stringify([{ ts: null, role: "user", label: null, text: `token ${MACHINE_TOKEN}` }])}::jsonb)
    `))
    const exit = await call("fleet_overview", {}, null)
    if (!Exit.isSuccess(exit)) throw new Error("fleet_overview failed")
    const text = exit.value.content.map((block) => block.type === "text" ? block.text : "").join("")
    expect(text).toContain("node-old:claude:legacy")
    expect(text).toContain("token [redacted]")
    expect(text).not.toContain("smm_")
  })

  // R2-Astra-D4-019: a count Postgres cannot hold is an invalid argument, not a database outage.
  test("a count of 2,147,483,647 is stored and 2,147,483,648 is refused as invalid_params before SQL", async () => {
    const accounts = (activeSessions: number) => ({
      sourceNode: "node-1",
      accounts: [
        { accountKey: "claude:first", provider: "claude", label: "first", status: "ready" },
        { accountKey: "claude:edge", provider: "claude", label: "edge", status: "ready", activeSessions },
      ],
    })
    expect(codeOf(await call("fleet_accounts_report", accounts(2_147_483_648), null))).toBe("invalid_params")
    expect(await counts()).toEqual([{ nodes: 0, sessions: 0, accounts: 0 }])
    expect(codeOf(await call("fleet_accounts_report", accounts(2_147_483_647), null))).toBe("ok")
    expect(await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) =>
      sql`SELECT active_sessions FROM provider_accounts WHERE account_key = 'claude:edge'`))).toEqual([{ active_sessions: 2_147_483_647 }])
    const heartbeat = (more: Record<string, number>) => ({ nodeId: "node-1", name: "Node one", kind: "macbook", ...more })
    for (const field of ["activeSessions", "runnerCapacity", "cpuCores"]) {
      expect(codeOf(await call("fleet_heartbeat", heartbeat({ [field]: 2_147_483_648 }), null)), field).toBe("invalid_params")
    }
    expect(codeOf(await call("fleet_sessions_report", {
      nodeId: "node-1",
      sessions: [{ sessionKey: "node-1:s1", harness: "claude", status: "working", pid: 2_147_483_648 }],
    }, null))).toBe("invalid_params")
    expect(await counts()).toEqual([{ nodes: 0, sessions: 0, accounts: 2 }])
    expect(codeOf(await call("fleet_heartbeat", heartbeat({ activeSessions: 2_147_483_647, runnerCapacity: 2_147_483_647, cpuCores: 2_147_483_647 }), null))).toBe("ok")
    expect(codeOf(await call("fleet_sessions_report", {
      nodeId: "node-1",
      sessions: [{ sessionKey: "node-1:s1", harness: "claude", status: "working", pid: 2_147_483_647 }],
    }, null))).toBe("ok")
    // A chunk index outside its snapshot is refused the same way.
    expect(codeOf(await call("fleet_sessions_report", { nodeId: "node-1", replaceActive: true, snapshotId: "s", chunkIndex: 2, totalChunks: 2, sessions: [] }, null)))
      .toBe("invalid_params")
  })
})

// R2-Astra-D4-011: a busy host's replacement snapshot crosses MCP's real HTTP route (worker/mcp/Api.ts), with its
// 262,144-byte bound, into the real tool registry and Postgres.
describe("fleet replacement snapshots through the MCP HTTP boundary", () => {
  const ADMINS: ReadonlySet<string> = new Set(["maya"])
  const principal: McpPrincipal = {
    tokenId: "tok-1",
    personId: "p-1",
    login: "maya",
    clientName: "smithers-node",
    repoScope: null,
    scopes: ["mcp:read", "mcp:write"],
    actor: { subject: { kind: "person", id: "p-1" }, role: null, login: "maya", act: { kind: "agent", id: "mcp:tok-1" } },
  }
  const rows = (query: string) =>
    runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) => sql.unsafe(query))) as Promise<ReadonlyArray<Record<string, unknown>>>

  /** The MCP route over this file's Postgres: only the bearer check is stood in for. */
  const openMcp = async () => {
    const sql = await runtime.runPromise(Effect.map(SqlClient.SqlClient, (client) => client))
    const auth = McpAuthService.of({
      authenticate: () => Effect.succeed({ _tag: "Authenticated", principal }),
      resolveRepoAccess: () => Effect.die("unused"),
      requireWriteAccess: () => Effect.die("unused"),
      listTokens: () => Effect.die("unused"),
      revokeToken: () => Effect.die("unused"),
      handleOAuthOrTokenRoute: () => Effect.die("unused"),
    })
    const registry = await Effect.runPromise(
      makeMcpToolRegistry(makeLiveToolDeps({ fleet: { database: Layer.succeed(SqlClient.SqlClient, sql), admins: ADMINS } }))
        .pipe(Effect.provideService(McpAuthService, auth)),
    )
    const handler = HttpEffect.toWebHandler(
      McpApi.make().fetch.pipe(Effect.provideService(McpAuthService, auth), Effect.provideService(McpToolRegistry, registry)),
    )
    let id = 0
    /** One `tools/call` request: its body's bytes, the HTTP status, and the tool's own answer. */
    return async (name: string, args: unknown) => {
      id += 1
      const body = JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } })
      const response = await handler(new Request(`https://smithers.test${MCP_ROUTE}`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer sma_${"ab".repeat(32)}` },
        body,
      }))
      const bytes = new TextEncoder().encode(body).length
      if (response.status !== 200) return { bytes, status: response.status, isError: true, answer: undefined }
      const reply = await response.json() as { readonly result?: { readonly isError?: boolean; readonly content?: ReadonlyArray<{ readonly text: string }> } }
      const text = reply.result?.content?.[0]?.text
      return {
        bytes,
        status: response.status,
        isError: reply.result === undefined || reply.result.isError === true,
        answer: text === undefined ? undefined : JSON.parse(text) as Record<string, unknown>,
      }
    }
  }

  /** The finding's host: 40 sessions, each with 20 transcript entries of 360 characters. */
  const KEYS = Array.from({ length: 40 }, (_, index) => `node-big:claude:session-${String(index).padStart(2, "0")}`)
  const snapshot = KEYS.map((sessionKey, index) => ({
    sessionKey,
    harness: "claude",
    status: "working",
    model: "claude-opus-4-7",
    title: `Session ${index}`,
    summary: `Working on lane ${index}`,
    cwd: `/Users/dev/lanes/lane-${index}`,
    transcriptJson: Array.from({ length: 20 }, (_unused, entry) => ({
      ts: `2026-11-23T10:${String(entry).padStart(2, "0")}:00.000Z`,
      role: entry % 2 === 0 ? "assistant" : "tool",
      label: entry % 2 === 0 ? null : "Bash",
      text: `session ${index} entry ${entry} `.padEnd(360, "ran the fleet suite and it passed "),
    })),
  }))
  const active = async () =>
    (await rows(`SELECT session_key FROM observed_sessions WHERE status <> 'ended' ORDER BY session_key`)).map((row) => row["session_key"])
  const ended = async () =>
    (await rows(`SELECT session_key FROM observed_sessions WHERE status = 'ended' ORDER BY session_key`)).map((row) => row["session_key"])

  test("a 40-session snapshot fits one request once trimmed, and a chunked one ends nothing before its final chunk", async () => {
    const post = await openMcp()
    expect(FLEET_REPORT_MAX_BYTES).toBeLessThan(MCP_MAX_REQUEST_BYTES)
    expect(MCP_MAX_REQUEST_BYTES).toBe(262_144)
    expect((await post("fleet_heartbeat", { nodeId: "node-big", name: "Busy host", kind: "bare-metal", activeSessions: 41 })).isError).toBe(false)
    // The host already runs the 40 sessions and one more that the snapshot will not name.
    const before = await post("fleet_sessions_report", {
      nodeId: "node-big",
      sessions: [...KEYS, "node-big:claude:stale"].map((sessionKey) => ({ sessionKey, harness: "claude", status: "working" })),
    })
    expect(before.answer).toEqual({ nodeId: "node-big", reported: 41, active: 41 })

    // The snapshot as the daemon sent it: refused whole by the route, so nothing changes.
    const whole = await post("fleet_sessions_report", { nodeId: "node-big", replaceActive: true, sessions: snapshot })
    expect(whole.bytes).toBeGreaterThan(MCP_MAX_REQUEST_BYTES)
    expect(whole.status).toBe(413)
    expect(await ended()).toEqual([])

    // Trimmed to its newest transcript entries, it is one ordinary replacement request.
    const single = planSessionsReport({ nodeId: "node-big", sessions: snapshot, snapshotId: "snapshot-1" })
    expect(single).toHaveLength(1)
    expect(single[0]?.snapshotId).toBeUndefined()
    expect(single[0]?.sessions.map((session) => session.sessionKey)).toEqual(KEYS)
    const kept = single[0]?.sessions.map((session) => session.transcriptJson.length) ?? []
    expect(Math.min(...kept)).toBeGreaterThanOrEqual(MIN_TRANSCRIPT_ENTRIES)
    // The newest entries are the ones kept.
    expect(single[0]?.sessions[0]?.transcriptJson.at(-1)).toEqual(snapshot[0]?.transcriptJson.at(-1))
    const sentOnce = await post("fleet_sessions_report", single[0])
    expect(sentOnce.bytes).toBeLessThanOrEqual(MCP_MAX_REQUEST_BYTES)
    expect(sentOnce.bytes).toBeLessThanOrEqual(FLEET_REPORT_MAX_BYTES + 1_024)
    expect(sentOnce.answer).toEqual({ nodeId: "node-big", reported: 40, active: 40 })
    expect(await active()).toEqual(KEYS)
    expect(await ended()).toEqual(["node-big:claude:stale"])
    expect(await rows(`SELECT count(*)::int AS stored FROM observed_sessions WHERE jsonb_array_length(transcript_json) = ${kept[0] ?? -1}`))
      .toEqual([{ stored: 40 }])

    // The stale session runs again, and the same snapshot is sent under a budget only chunks can meet.
    await post("fleet_sessions_report", { nodeId: "node-big", sessions: [{ sessionKey: "node-big:claude:stale", harness: "claude", status: "working" }] })
    expect(await ended()).toEqual([])
    const chunks = planSessionsReport({ nodeId: "node-big", sessions: snapshot, snapshotId: "snapshot-2", maxBytes: 48_000 })
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.flatMap((chunk) => chunk.sessions.map((session) => session.sessionKey))).toEqual(KEYS)
    expect(chunks.map((chunk) => chunk.final)).toEqual([...chunks.slice(1).map(() => false), true])
    for (const chunk of chunks) {
      const sent = await post("fleet_sessions_report", chunk)
      expect(sent.bytes).toBeLessThanOrEqual(48_000 + 1_024)
      expect(sent.bytes).toBeLessThanOrEqual(MCP_MAX_REQUEST_BYTES)
      expect(sent.isError).toBe(false)
      expect(sent.answer).toMatchObject({ snapshotId: "snapshot-2", final: chunk.final, reported: chunk.sessions.length })
      // No session the host still runs is ended while the snapshot is only partly here.
      if (chunk.final !== true) {
        expect(await ended()).toEqual([])
        expect(await active()).toEqual([...KEYS, "node-big:claude:stale"])
      }
    }
    expect(await active()).toEqual(KEYS)
    expect(await ended()).toEqual(["node-big:claude:stale"])
    expect(await rows(`SELECT active_sessions FROM host_nodes WHERE node_id = 'node-big'`)).toEqual([{ active_sessions: 40 }])
    expect(await rows(`SELECT count(*)::int AS staged FROM fleet_session_snapshot_keys`)).toEqual([{ staged: 0 }])
  })

  test("replaying a finalized snapshot returns its receipt and keeps sessions from every chunk active", async () => {
    const post = await openMcp()
    const nodeId = "node-big"
    const report = (args: unknown) => post("fleet_sessions_report", args)
    const snapshot = { nodeId, mode: "replace", snapshotId: "two-chunks", totalChunks: 2 }
    const session = (sessionKey: string) => ({ sessionKey, harness: "claude", status: "working" })
    const first = { ...snapshot, chunkIndex: 0, sessions: [session("a"), session("b")] }
    const last = { ...snapshot, chunkIndex: 1, sessions: [session("c")] }
    expect((await post("fleet_heartbeat", { nodeId, name: "Busy host", kind: "bare-metal" })).isError).toBe(false)
    expect((await report(first)).answer).toMatchObject({ reported: 2, active: 2, final: false })
    const completed = (await report(last)).answer
    expect(completed).toEqual({ nodeId, snapshotId: snapshot.snapshotId, reported: 1, active: 3, final: true })
    expect(await active()).toEqual(["a", "b", "c"])

    // C reports a newer status while the final response is lost.
    expect((await report({ nodeId, sessions: [{ ...session("c"), status: "idle" }] })).answer).toMatchObject({ active: 3 })
    expect((await report(last)).answer).toEqual(completed)
    expect(await active()).toEqual(["a", "b", "c"])
    expect(await rows(`SELECT active_sessions FROM host_nodes WHERE node_id = 'node-big'`)).toEqual([{ active_sessions: 3 }])
    expect(await rows(`SELECT status FROM observed_sessions WHERE session_key = 'c'`)).toEqual([{ status: "idle" }])
    expect((await report(first)).answer).toEqual(completed)
    expect(await rows(`SELECT count(*)::int AS staged FROM fleet_session_snapshot_keys`)).toEqual([{ staged: 0 }])
  })

  test("hosts finalize the same snapshot ID independently and reports prune old receipts", async () => {
    const post = await openMcp()
    const snapshot = { mode: "replace", snapshotId: "shared", final: true }
    const session = { sessionKey: "a", harness: "claude", status: "working" }
    expect((await post("fleet_sessions_report", { ...snapshot, nodeId: "one", sessions: [session] })).answer)
      .toEqual({ nodeId: "one", snapshotId: "shared", final: true, reported: 1, active: 1 })
    expect((await post("fleet_sessions_report", { ...snapshot, nodeId: "two", sessions: [] })).answer)
      .toEqual({ nodeId: "two", snapshotId: "shared", final: true, reported: 0, active: 0 })
    await rows(`UPDATE fleet_session_snapshot_receipts SET completed_at = now() - interval '8 days' WHERE node_id = 'one'`)
    expect((await post("fleet_sessions_report", { nodeId: "two", sessions: [] })).isError).toBe(false)
    expect(await rows(`SELECT node_id, snapshot_id FROM fleet_session_snapshot_receipts`)).toEqual([{ node_id: "two", snapshot_id: "shared" }])
  })

  test("a snapshot abandoned before its final chunk ends nothing, and the next whole snapshot still reconciles", async () => {
    const post = await openMcp()
    const bare = (sessionKey: string) => ({ sessionKey, harness: "claude", status: "working" })
    await post("fleet_heartbeat", { nodeId: "node-big", name: "Busy host", kind: "bare-metal" })
    await post("fleet_sessions_report", { nodeId: "node-big", sessions: [bare("node-big:a"), bare("node-big:b"), bare("node-big:c")] })
    // First chunk of two, then the reporter stops.
    const first = await post("fleet_sessions_report", {
      nodeId: "node-big", replaceActive: true, snapshotId: "abandoned", chunkIndex: 0, totalChunks: 2, sessions: [bare("node-big:a")],
    })
    expect(first.answer).toEqual({ nodeId: "node-big", reported: 1, active: 3, snapshotId: "abandoned", final: false })
    expect(await ended()).toEqual([])
    // A later snapshot, its last chunk named by position alone, ends only what neither of its chunks named.
    await post("fleet_sessions_report", {
      nodeId: "node-big", mode: "replace", snapshotId: "next", chunkIndex: 0, totalChunks: 2, sessions: [bare("node-big:b")],
    })
    expect(await ended()).toEqual([])
    const last = await post("fleet_sessions_report", {
      nodeId: "node-big", mode: "replace", snapshotId: "next", chunkIndex: 1, totalChunks: 2, sessions: [bare("node-big:c")],
    })
    expect(last.answer).toEqual({ nodeId: "node-big", reported: 1, active: 2, snapshotId: "next", final: true })
    expect(await active()).toEqual(["node-big:b", "node-big:c"])
    expect(await ended()).toEqual(["node-big:a"])
    // `mode: "append"` never ends a session, whatever else the report says.
    await post("fleet_sessions_report", { nodeId: "node-big", replaceActive: true, mode: "append", snapshotId: "appended", final: true, sessions: [bare("node-big:d")] })
    expect(await active()).toEqual(["node-big:b", "node-big:c", "node-big:d"])
    // The abandoned snapshot's keys wait out their hour; the finished one's are gone.
    expect(await rows(`SELECT snapshot_id, session_key FROM fleet_session_snapshot_keys ORDER BY snapshot_id`))
      .toEqual([{ snapshot_id: "abandoned", session_key: "node-big:a" }])
    await rows(`UPDATE fleet_session_snapshot_keys SET staged_at = now() - interval '2 hours'`)
    await post("fleet_sessions_report", { nodeId: "node-big", replaceActive: true, snapshotId: "third", final: true, sessions: [bare("node-big:b")] })
    expect(await rows(`SELECT count(*)::int AS staged FROM fleet_session_snapshot_keys`)).toEqual([{ staged: 0 }])
    expect(await active()).toEqual(["node-big:b"])
  })
})

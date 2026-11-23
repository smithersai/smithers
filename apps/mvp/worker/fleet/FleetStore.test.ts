import { Effect, Layer, Option } from "effect"
import { FetchHttpClient, HttpEffect } from "effect/http"
import * as TestDatabase from "../../db/TestDatabase.ts"
import { SqlClient } from "effect/sql"
import { beforeEach, describe, expect, test } from "vitest"
import {
  FLEET_ACCOUNTS_SHAPE_ROUTE,
  FLEET_NODES_SHAPE_ROUTE,
  FLEET_SESSIONS_SHAPE_ROUTE,
} from "../../src/features/fleet/globalContract.ts"
import { testFile } from "../test/harness.ts"
import * as Actor from "../Actor.ts"
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
          nodeId: "williams-macbook-pro-2",
          name: "MacBook Pro",
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
          nodeId: "williams-macbook-pro-2",
          replaceActive: true,
          sessions: [
            {
              sessionKey: "williams-macbook-pro-2:claude:s1",
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
              sessionKey: "williams-macbook-pro-2:agy-cli:conv-1",
              managed: false,
              harness: "agy-cli",
              model: "gemini-4-neon-high",
              accountLabel: "google-antigravity",
              title: "Smithers Multi-Host Monitoring",
              status: "working",
            },
          ],
        })
        expect(reported).toEqual({ nodeId: "williams-macbook-pro-2", reported: 2, active: 2 })

        // Second report with replaceActive=true drops s1 -> marks s1 as ended
        yield* FleetStore.reportSessions({
          nodeId: "williams-macbook-pro-2",
          replaceActive: true,
          sessions: [
            {
              sessionKey: "williams-macbook-pro-2:agy-cli:conv-1",
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
          sourceNode: "williams-macbook-pro-2",
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
        expect(accts).toEqual({ reported: 2, sourceNode: "williams-macbook-pro-2" })

        // Seed an open Cloudflare BranchSandbox generation
        const sql = yield* SqlClient.SqlClient
        yield* sql`
          INSERT INTO sandbox_generations (branch_id, generation, kind, instance)
          VALUES ('smithersai/smithers#feat/fleet', 1, 'branch', 'do-inst-1')
        `

        const active = yield* FleetStore.readOverview(false)
        expect(active.nodes.map((n: Record<string, unknown>) => n["nodeId"])).toEqual([
          "williams-macbook-pro-2",
          "cloudflare-branch-sandbox",
        ])
        expect(active.sessions.map((s: Record<string, unknown>) => s["harness"]).sort()).toEqual([
          "agy-cli",
          "cf-sandbox",
        ])
        expect(active.accounts).toHaveLength(2)

        const withEnded = yield* FleetStore.readOverview(true)
        const endedClaude = withEnded.sessions.find(
          (s: Record<string, unknown>) => s["sessionKey"] === "williams-macbook-pro-2:claude:s1"
        ) as Record<string, unknown> | undefined
        expect(endedClaude?.["status"]).toBe("ended")
        expect(String(endedClaude?.["title"])).not.toContain("ghp_SecretToken")
        expect(String(endedClaude?.["title"])).not.toContain("sk-ant-secret123")
        expect(String(endedClaude?.["title"])).toContain("[redacted]")
      })
    )
  })
})

describe("FleetShapes authorization", () => {
  const runShape = async (route: string, actor: Option.Option<Actor.Actor>) => {
    const shapes = await runtime.runPromise(FleetShapes.make())
    const handler = HttpEffect.toWebHandler(
      shapes.fetch.pipe(
        Effect.provide(
          Layer.merge(
            Layer.succeed(Actor.Sessions, { resolve: Effect.succeed(actor) }),
            FetchHttpClient.layer,
          )
        )
      )
    )
    return handler(new Request(`http://smithers.test${route}?offset=-1`))
  }

  test("signed-out gets 401 and non-admin contributor gets 403 on all 3 fleet shape routes", async () => {
    for (const route of [FLEET_NODES_SHAPE_ROUTE, FLEET_SESSIONS_SHAPE_ROUTE, FLEET_ACCOUNTS_SHAPE_ROUTE]) {
      const anon = await runShape(route, Option.none())
      expect(anon.status).toBe(401)

      const contrib = await runShape(
        route,
        Option.some({
          subject: { kind: "person", id: "p-contrib" },
          role: "member",
          login: "alice",
        })
      )
      expect(contrib.status).toBe(403)
    }
  })

  test("deployment admin roninjin10 passes auth and reaches ElectricSQL", async () => {
    const res = await runShape(
      FLEET_NODES_SHAPE_ROUTE,
      Option.some({
        subject: { kind: "person", id: "p-will" },
        role: "admin",
        login: "roninjin10",
      })
    )
    expect([200, 400, 502, 503]).toContain(res.status)
    expect(res.status).not.toBe(401)
    expect(res.status).not.toBe(403)
  })
})

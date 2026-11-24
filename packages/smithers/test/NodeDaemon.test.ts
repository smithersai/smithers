import { Effect, Layer } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import { describe, expect, test } from "vitest"
import * as NodeDaemon from "../src/node/NodeDaemon.vibe"

describe("NodeDaemon BYOA MCP sync", () => {
  test("syncHostOnce & syncAccountsAndCfboxOnce send MCP tools/call over HTTP", async () => {
    const calls: Array<{ name: string; arguments: Record<string, unknown> }> = []
    const httpLayer = Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.sync(() => {
          const rawBody = request.body._tag === "Uint8Array"
            ? new TextDecoder().decode(request.body.body)
            : "{}"
          const parsed = JSON.parse(rawBody) as {
            id: string
            params: { name: string; arguments: Record<string, unknown> }
          }
          calls.push(parsed.params)
          return HttpClientResponse.fromWeb(
            request,
            new Response(
              JSON.stringify({
                jsonrpc: "2.0",
                id: parsed.id,
                result: { content: [{ type: "text", text: JSON.stringify({ ok: true }) }] }
              }),
              { status: 200, headers: { "content-type": "application/json" } }
            )
          )
        })
      )
    )
    const collectors = Layer.succeed(NodeDaemon.NodeCollectors, {
      collectHost: () =>
        Effect.succeed({
          nodeId: "mbp",
          name: "MacBook Pro",
          kind: "macbook",
          labels: ["macbook"],
          online: true,
          held: null,
          load1: 2.5,
          cpuCores: 16,
          memUsedGb: 32,
          memTotalGb: 64,
          diskFreeGb: 50,
          diskTotalGb: 926,
          activeSessions: 0,
          runnerCapacity: 4,
          version: "1.0.0"
        }),
      collectSessions: () =>
        Effect.succeed([
          {
            sessionKey: "mbp:agy-cli:1",
            managed: false,
            harness: "agy-cli",
            model: "gemini-4-neon-high",
            accountLabel: "google-antigravity",
            repo: "smithers",
            lane: null,
            title: "Audit",
            status: "working",
            pid: null,
            cpuSeconds: null,
            tokensUsed: null,
            startedAt: null,
            lastActivityAt: "2026-11-23T23:30:00Z",
            endedAt: null
          }
        ]),
      collectAccounts: () =>
        Effect.succeed([
          {
            accountKey: "google-agy:google-antigravity",
            provider: "google-agy",
            label: "google-antigravity",
            plan: "google-gemini-only",
            status: "ready",
            fiveHourPct: null,
            weeklyPct: null,
            scopedPct: null,
            resetsAt: null,
            grantsJson: null,
            creditsBalance: null,
            activeSessions: 1,
            pools: ["agy-gemini"],
            coolReason: null,
            coolUntil: null,
            checkedAt: "2026-11-23T23:30:00Z"
          }
        ]),
      collectCfbox: () =>
        Effect.succeed({
          host: {
            nodeId: "cloudflare-cfbox",
            name: "Cloudflare Sandboxes (cfbox)",
            kind: "cloudflare",
            labels: ["cloudflare"],
            online: true,
            held: null,
            load1: null,
            cpuCores: null,
            memUsedGb: null,
            memTotalGb: null,
            diskFreeGb: null,
            diskTotalGb: null,
            activeSessions: 1,
            runnerCapacity: 64,
            version: "cfbox"
          },
          sessions: [
            {
              sessionKey: "cloudflare-cfbox:cfbox:job-1",
              managed: true,
              harness: "cfbox",
              model: null,
              accountLabel: null,
              repo: null,
              lane: "ci-1",
              title: "node26 (job-1)",
              status: "working",
              pid: null,
              cpuSeconds: null,
              tokensUsed: null,
              startedAt: null,
              lastActivityAt: "2026-11-23T23:30:00Z",
              endedAt: null
            }
          ]
        })
    })
    const mcp = { origin: "https://smithers.sh", token: "sma_" + "a".repeat(64) }
    await Effect.runPromise(
      NodeDaemon.runDaemon({
        mcp,
        intervalMs: 1000,
        accountIntervalMs: 1000,
        collectAccounts: true,
        collectCfbox: true,
        once: true
      }).pipe(Effect.provide(Layer.merge(httpLayer, collectors)))
    )
    expect(calls.map((c) => c.name)).toEqual([
      "fleet_heartbeat",
      "fleet_sessions_report",
      "fleet_accounts_report",
      "fleet_heartbeat",
      "fleet_sessions_report"
    ])
  })
})

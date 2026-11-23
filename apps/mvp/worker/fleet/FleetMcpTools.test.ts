import { Effect, Exit, Layer, Option } from "effect"
import type { SqlClient } from "effect/sql"
import { describe, expect, test } from "vitest"
import * as FleetMcpTools from "./FleetMcpTools.vibe"
import * as FleetStore from "./FleetStore.vibe"

const dummyDb = Layer.empty as unknown as Layer.Layer<SqlClient.SqlClient, Error>

const principalFor = (login: string, scopes: ReadonlyArray<"mcp:read" | "mcp:write">) =>
  Option.some({
    tokenId: "tok-1",
    personId: "p-1",
    login,
    clientName: "test-agent",
    repoScope: null,
    scopes,
    actor: {
      subject: { kind: "person" as const, id: "p-1" },
      role: null,
      login,
      act: { kind: "agent" as const, id: "mcp:tok-1" },
    },
  })

describe("FleetMcpTools BYOA auth & OBS-5 scrubbing", () => {
  test("only roninjin10 sees fleet MCP tools in tools/list", () => {
    const adminTools = FleetMcpTools.visibleDescriptors(principalFor("roninjin10", ["mcp:read", "mcp:write"]))
    const readOnlyAdmin = FleetMcpTools.visibleDescriptors(principalFor("roninjin10", ["mcp:read"]))
    const contributorTools = FleetMcpTools.visibleDescriptors(principalFor("alice", ["mcp:read", "mcp:write"]))
    const anonTools = FleetMcpTools.visibleDescriptors(Option.none())
    expect(adminTools.map((t) => t.name)).toEqual([
      "fleet_heartbeat",
      "fleet_sessions_report",
      "fleet_accounts_report",
      "fleet_overview",
    ])
    expect(readOnlyAdmin.map((t) => t.name)).toEqual(["fleet_overview"])
    expect(contributorTools).toEqual([])
    expect(anonTools).toEqual([])
  })

  test("non-roninjin10 and anonymous calls are refused before touching DB", async () => {
    const ctxAnon = { principal: Option.none(), requestId: "req-1", origin: "https://smithers.sh" }
    const ctxContrib = {
      principal: principalFor("alice", ["mcp:read", "mcp:write"]),
      requestId: "req-2",
      origin: "https://smithers.sh",
    }
    const rAnon = await Effect.runPromise(Effect.exit(FleetMcpTools.callFleetTool("fleet_overview", {}, ctxAnon, dummyDb)))
    const rContrib = await Effect.runPromise(Effect.exit(FleetMcpTools.callFleetTool("fleet_heartbeat", {
      nodeId: "mbp",
      name: "MacBook",
      kind: "macbook",
    }, ctxContrib, dummyDb)))
    expect(Exit.isFailure(rAnon)).toBe(true)
    expect(Exit.isFailure(rContrib)).toBe(true)
  })

  test("scrubText redacts GitHub, Anthropic, OpenAI, and Smithers MCP tokens", () => {
    const scrubbed = FleetStore.scrubText(
      "Fix ghp_SecretToken1234567890 and sk-ant-api03-secretvalue and sma_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      160
    )
    expect(scrubbed).not.toContain("ghp_")
    expect(scrubbed).not.toContain("sk-ant-")
    expect(scrubbed).not.toContain("sma_")
    expect(scrubbed).toContain("[redacted]")
  })
})

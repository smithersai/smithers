import { Effect, Exit, Layer, Option } from "effect"
import type { SqlClient } from "effect/sql"
import { describe, expect, test } from "vitest"
import * as FleetMcpTools from "./FleetMcpTools.vibe"
import * as FleetStore from "./FleetStore.vibe"

const dummyDb = Layer.empty as unknown as Layer.Layer<SqlClient.SqlClient, Error>

/** The deployment's configured admins: no login is one unless configuration names it. */
const ADMINS: ReadonlySet<string> = new Set(["maya"])

const principalFor = (
  login: string,
  scopes: ReadonlyArray<"mcp:read" | "mcp:write">,
  repoScope: string | null = null,
) =>
  Option.some({
    tokenId: "tok-1",
    personId: "p-1",
    login,
    clientName: "test-agent",
    repoScope,
    scopes,
    actor: {
      subject: { kind: "person" as const, id: "p-1" },
      role: null,
      login,
      act: { kind: "agent" as const, id: "mcp:tok-1" },
    },
  })

const codeOf = (exit: Exit.Exit<unknown, { readonly code: string }>) =>
  Exit.isFailure(exit) ? Option.getOrUndefined(Option.map(Exit.findErrorOption(exit), (error) => error.code)) : "ok"

const call = (name: FleetMcpTools.FleetToolName, args: unknown, principal: ReturnType<typeof principalFor> | Option.None<never>, admins?: ReadonlySet<string>) =>
  Effect.runPromise(Effect.exit(FleetMcpTools.callFleetTool(
    name,
    args,
    { principal, requestId: "req-1", origin: "https://smithers.test" },
    dummyDb,
    admins,
  )))

const HEARTBEAT = { nodeId: "node-1", name: "Node one", kind: "macbook" }

describe("FleetMcpTools BYOA auth & OBS-5 scrubbing", () => {
  test("only a configured deployment admin sees fleet MCP tools in tools/list", () => {
    const adminTools = FleetMcpTools.visibleDescriptors(principalFor("maya", ["mcp:read", "mcp:write"]), ADMINS)
    const readOnlyAdmin = FleetMcpTools.visibleDescriptors(principalFor("maya", ["mcp:read"]), ADMINS)
    const contributorTools = FleetMcpTools.visibleDescriptors(principalFor("alice", ["mcp:read", "mcp:write"]), ADMINS)
    const anonTools = FleetMcpTools.visibleDescriptors(Option.none(), ADMINS)
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

  // R1-Astra-D4-004: with no configured admin, nobody reaches the fleet, the formerly built-in login included.
  test("a deployment that names no admin lists and runs no fleet tool for anyone", async () => {
    for (const login of ["roninjin10", "maya"]) {
      const principal = principalFor(login, ["mcp:read", "mcp:write"])
      expect(FleetMcpTools.visibleDescriptors(principal)).toEqual([])
      expect(codeOf(await call("fleet_overview", {}, principal))).toBe("forbidden")
      expect(codeOf(await call("fleet_heartbeat", HEARTBEAT, principal))).toBe("forbidden")
    }
  })

  // R1-Astra-D4-001, R1-NEON-D4-003: a token pinned to one repository never reaches deployment-wide tools.
  test("a deployment admin's repository-pinned token sees no fleet tool and every call is refused", async () => {
    const pinned = principalFor("maya", ["mcp:read", "mcp:write"], "github/acme/widgets")
    expect(FleetMcpTools.visibleDescriptors(pinned, ADMINS)).toEqual([])
    for (const [name, args] of [
      ["fleet_overview", {}],
      ["fleet_heartbeat", HEARTBEAT],
      ["fleet_sessions_report", { nodeId: "node-1", sessions: [] }],
      ["fleet_accounts_report", { sourceNode: "node-1", accounts: [] }],
    ] as const) {
      // The database layer here cannot answer: a refusal that reached it would read as `unavailable`.
      expect(codeOf(await call(name, args, pinned, ADMINS)), name).toBe("forbidden")
    }
  })

  test("a contributor's, an anonymous and an under-scoped call are refused before touching the database", async () => {
    expect(codeOf(await call("fleet_overview", {}, Option.none(), ADMINS))).toBe("authentication")
    expect(codeOf(await call("fleet_heartbeat", HEARTBEAT, principalFor("alice", ["mcp:read", "mcp:write"]), ADMINS))).toBe("forbidden")
    expect(codeOf(await call("fleet_heartbeat", HEARTBEAT, principalFor("maya", ["mcp:read"]), ADMINS))).toBe("forbidden")
  })

  test("an oversized report is refused whole as invalid arguments", async () => {
    const admin = principalFor("maya", ["mcp:read", "mcp:write"])
    const sessions = Array.from({ length: FleetStore.MAX_SESSIONS_PER_REPORT + 1 }, (_, index) => ({
      sessionKey: `node-1:s${index}`,
      harness: "claude",
      status: "working",
    }))
    expect(codeOf(await call("fleet_sessions_report", { nodeId: "node-1", sessions }, admin, ADMINS))).toBe("invalid_params")
    const accounts = Array.from({ length: FleetStore.MAX_ACCOUNTS_PER_REPORT + 1 }, (_, index) => ({
      accountKey: `claude:${index}`,
      provider: "claude",
      label: `a${index}`,
      status: "ready",
    }))
    expect(codeOf(await call("fleet_accounts_report", { sourceNode: "node-1", accounts }, admin, ADMINS))).toBe("invalid_params")
    const labels = Array.from({ length: FleetStore.MAX_TAGS + 1 }, (_, index) => `l${index}`)
    expect(codeOf(await call("fleet_heartbeat", { ...HEARTBEAT, labels }, admin, ADMINS))).toBe("invalid_params")
    // A timestamp no date reads from refuses the report before any row is written.
    expect(codeOf(await call("fleet_sessions_report", {
      nodeId: "node-1",
      sessions: [{ sessionKey: "node-1:s1", harness: "claude", status: "working", startedAt: "not a time" }],
    }, admin, ADMINS))).toBe("invalid_params")
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

  // R2-Astra-D4-001: the journal's machine-token rule, and the forms around it, apply to every fleet text.
  test("scrubText redacts Smithers machine, scoped and access tokens, whole or cut short", () => {
    const machine = `smm_${"Ab3-_xY9".repeat(6).slice(0, 43)}`
    for (const text of [
      machine,
      `token ${machine} trailing`,
      `https://smithers.test/hooks/${machine}/x`,
      `Authorization: Bearer ${machine}`,
      `SMITHERS_MACHINE_TOKEN=${machine}`,
      `"${machine}"`,
      `cut ${machine.slice(0, 20)}`,
      `smt1.${"a".repeat(24)}.${"b".repeat(43)}`,
      `smithers_${"0123456789abcdef".repeat(3).slice(0, 40)}`,
    ]) {
      const scrubbed = FleetStore.scrubText(text, 400)
      expect(scrubbed, text).toContain("[redacted]")
      expect(scrubbed, text).not.toMatch(/smm_|smt1\.|smithers_0/)
      expect(scrubbed, text).not.toContain("[REDACTED]")
      // A scrubbed text read again is unchanged.
      expect(FleetStore.scrubText(scrubbed, 400), text).toBe(scrubbed)
    }
    expect(FleetStore.scrubText("Fleet observability upgrade in /Users/dev/smithers-fleet", 400)).toBe("Fleet observability upgrade in /Users/dev/smithers-fleet")
    expect(FleetStore.scrubTranscript([{ ts: null, role: "tool", label: `Bash ${machine}`, text: `echo ${machine}` }]))
      .toEqual([{ ts: null, role: "tool", label: "Bash [redacted]", text: "echo [redacted]" }])
  })

  // R2-Astra-D4-019: a count Postgres cannot hold is refused as an argument, with no database to reach.
  test("a count above the integer range is invalid_params on every tool that stores one", async () => {
    const admin = principalFor("maya", ["mcp:read", "mcp:write"])
    expect(FleetStore.MAX_INT32).toBe(2_147_483_647)
    for (const field of ["activeSessions", "runnerCapacity", "cpuCores"]) {
      expect(codeOf(await call("fleet_heartbeat", { ...HEARTBEAT, [field]: 2_147_483_648 }, admin, ADMINS)), field).toBe("invalid_params")
    }
    expect(codeOf(await call("fleet_accounts_report", {
      sourceNode: "node-1",
      accounts: [{ accountKey: "claude:one", provider: "claude", label: "one", status: "ready", activeSessions: 2_147_483_648 }],
    }, admin, ADMINS))).toBe("invalid_params")
    expect(codeOf(await call("fleet_sessions_report", {
      nodeId: "node-1",
      sessions: [{ sessionKey: "node-1:s1", harness: "claude", status: "working", pid: 2_147_483_648 }],
    }, admin, ADMINS))).toBe("invalid_params")
  })

  // R1-Astra-D4-011: provider grant telemetry keeps approved fields only, at every depth.
  test("projectGrants keeps the approved quota fields and drops everything else", () => {
    expect(FleetStore.projectGrants({
      policy: "provider-models-only",
      resetCreditsAvailable: 3,
      email: "person@example.test",
      nested: { token: "sentinel-unknown-nested" },
      grants: [
        { name: "weekly", kind: "quota", pct: 42, limit: 100, used: 42, remaining: 58, resetsAt: "2026-11-24T00:00:00Z", owner: { email: "sentinel@example.test" }, prompt: "sentinel prompt" },
        "plain-grant",
        { secret: "sentinel-only-unknown" },
        7,
        { name: "ghp_SecretToken1234567890abcdef" },
      ],
    })).toEqual({
      policy: "provider-models-only",
      resetCreditsAvailable: 3,
      grants: [
        { name: "weekly", kind: "quota", pct: 42, limit: 100, used: 42, remaining: 58, resetsAt: "2026-11-24T00:00:00Z" },
        "plain-grant",
        { name: "[redacted]" },
      ],
    })
    expect(FleetStore.projectGrants({ token: "sentinel" })).toBeNull()
    expect(FleetStore.projectGrants({ policy: 7, resetCreditsAvailable: -1, grants: "no list" })).toBeNull()
    expect(FleetStore.projectGrants(null)).toBeNull()
    expect(FleetStore.projectGrants(["policy"])).toBeNull()
    const many = FleetStore.projectGrants({ grants: Array.from({ length: FleetStore.MAX_GRANTS + 5 }, (_, index) => `g${index}`) })
    expect((many?.["grants"] as ReadonlyArray<unknown>).length).toBe(FleetStore.MAX_GRANTS)
  })
})

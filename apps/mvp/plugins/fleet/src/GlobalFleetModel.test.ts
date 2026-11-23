import { describe, expect, test } from "vitest"
import { accountRowsOf, hostRowsOf, sessionRowsOf, summarizeGlobal } from "./GlobalFleetModel.vibe"

describe("GlobalFleetModel", () => {
  test("computes host status, disk warnings, Codex credit-burn alert, and harness counts", () => {
    const now = Date.parse("2026-11-23T23:30:00Z")
    const hosts = hostRowsOf([
      {
        nodeId: "mbp",
        name: "MacBook Pro",
        kind: "macbook",
        labels: ["macbook"],
        online: true,
        held: null,
        load1: 4.2,
        cpuCores: 16,
        memUsedGb: 48,
        memTotalGb: 64,
        diskFreeGb: 16,
        diskTotalGb: 926,
        activeSessions: 3,
        runnerCapacity: 4,
        version: "1.0.0",
        seenAt: "2026-11-23T23:29:50Z",
      },
      {
        nodeId: "nyc-01",
        name: "Latitude nyc-01",
        kind: "bare-metal",
        labels: ["bare-metal"],
        online: true,
        held: null,
        load1: 12,
        cpuCores: 48,
        memUsedGb: 60,
        memTotalGb: 150,
        diskFreeGb: 200,
        diskTotalGb: 1800,
        activeSessions: 1,
        runnerCapacity: 16,
        version: "1.0.0",
        seenAt: "2026-11-23T23:20:00Z", // stale -> Offline
      },
    ], now)
    expect(hosts[0]?.stateWord).toBe("Low disk")
    expect(hosts[0]?.diskLow).toBe(true)
    expect(hosts[1]?.stateWord).toBe("Offline")

    const sessions = sessionRowsOf([
      {
        sessionKey: "mbp:claude:1",
        nodeId: "mbp",
        managed: false,
        harness: "claude",
        model: "claude-opus-5-5",
        accountLabel: "claude-2",
        repo: "smithers",
        lane: "lead",
        title: "Build fleet",
        status: "working",
        pid: 100,
        cpuSeconds: 5,
        tokensUsed: 12000,
        startedAt: "2026-11-23T23:00:00Z",
        lastActivityAt: "2026-11-23T23:29:55Z",
        endedAt: null,
      },
      {
        sessionKey: "mbp:agy-cli:2",
        nodeId: "mbp",
        managed: false,
        harness: "agy-cli",
        model: "gemini-4-neon-high",
        accountLabel: "google-antigravity",
        repo: "smithers",
        lane: null,
        title: "Design fleet",
        status: "working",
        pid: null,
        cpuSeconds: null,
        tokensUsed: null,
        startedAt: "2026-11-23T23:15:00Z",
        lastActivityAt: "2026-11-23T23:29:59Z",
        endedAt: null,
      },
      {
        sessionKey: "cf:cfbox:3",
        nodeId: "cloudflare-cfbox",
        managed: true,
        harness: "cfbox",
        model: null,
        accountLabel: null,
        repo: null,
        lane: "ci-1",
        title: "node26 test",
        status: "working",
        pid: null,
        cpuSeconds: null,
        tokensUsed: null,
        startedAt: null,
        lastActivityAt: "2026-11-23T23:29:00Z",
        endedAt: null,
      },
    ], now)

    const accounts = accountRowsOf([
      {
        accountKey: "claude:claude-1",
        provider: "claude",
        label: "claude-1",
        plan: "max",
        status: "ready",
        fiveHourPct: 5,
        weeklyPct: 10,
        scopedPct: 0,
        resetsAt: "2026-11-30T11:00:00Z",
        grantsJson: null,
        creditsBalance: null,
        activeSessions: 1,
        pools: ["ci"],
        coolReason: null,
        coolUntil: null,
        sourceNode: "mbp",
        checkedAt: "2026-11-23T23:29:00Z",
      },
      {
        accountKey: "codex:codex-5",
        provider: "codex",
        label: "codex-5",
        plan: "promax",
        status: "ready",
        fiveHourPct: null,
        weeklyPct: 96,
        scopedPct: null,
        resetsAt: "2026-11-27T11:00:00Z",
        grantsJson: null,
        creditsBalance: 500,
        activeSessions: 1,
        pools: [],
        coolReason: null,
        coolUntil: null,
        sourceNode: "mbp",
        checkedAt: "2026-11-23T23:29:00Z",
      },
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
        grantsJson: { policy: "google-models-only" },
        creditsBalance: null,
        activeSessions: 1,
        pools: ["agy-gemini"],
        coolReason: null,
        coolUntil: null,
        sourceNode: "mbp",
        checkedAt: "2026-11-23T23:29:00Z",
      },
    ])
    expect(accounts[1]?.statusWord).toBe("Credit risk")
    expect(accounts[1]?.tone).toBe("bad")
    expect(accounts[2]?.provider).toBe("google-agy")

    const summary = summarizeGlobal(hosts, sessions, accounts)
    expect(summary).toEqual({
      onlineHosts: 1,
      totalHosts: 2,
      activeSessions: 3,
      claudeSessions: 1,
      codexSessions: 0,
      agySessions: 1,
      cloudflareSessions: 1,
      readyAccounts: 2,
      totalAccounts: 3,
      alertsCount: 3, // mbp low disk + nyc-01 offline + codex-5 credit risk
    })
  })
})

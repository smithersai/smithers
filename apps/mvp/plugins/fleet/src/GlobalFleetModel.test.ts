import { describe, expect, test } from "vitest"
import {
  accountRowsOf,
  ACTIVE_STATUS,
  ALL,
  attentionItemsOf,
  filterSessions,
  formatCpuSeconds,
  formatTokensAndTime,
  hostRowsOf,
  parseRepoSlug,
  parseTranscript,
  projectsOf,
  sectionOf,
  selectedSessionOf,
  sessionRowsOf,
  statusCountsOf,
  summarizeGlobal,
  summaryOfGlobal,
  UNASSIGNED_PROJECT,
} from "./GlobalFleetModel"

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
      harnesses: [{ harness: "agy-cli", sessions: 1 }, { harness: "cfbox", sessions: 1 }, { harness: "claude", sessions: 1 }],
      readyAccounts: 2,
      totalAccounts: 3,
      alertsCount: 3, // mbp low disk + nyc-01 offline + codex-5 credit risk
    })
  })

  // Neon-D4-014: the harness labels and filter choices are the rows' own, so no operator's private names ship.
  test("counts and filters sessions by the harnesses the rows report", () => {
    const now = Date.parse("2026-11-23T23:30:00Z")
    const session = (sessionKey: string, nodeId: string, harness: "smithers" | "daemon") => ({
      sessionKey, nodeId, managed: false, harness, model: null, accountLabel: null, repo: null, lane: null, title: null,
      status: "working" as const, pid: null, cpuSeconds: null, tokensUsed: null, startedAt: null, lastActivityAt: null, endedAt: null,
    })
    const rows = sessionRowsOf([session("a", "one", "smithers"), session("b", "two", "daemon"), session("c", "two", "smithers")], now)
    expect(summarizeGlobal([], rows, []).harnesses).toEqual([{ harness: "daemon", sessions: 1 }, { harness: "smithers", sessions: 2 }])
    expect(filterSessions(rows, { host: ALL, harness: ALL }).map((row) => row.sessionKey)).toEqual(["a", "b", "c"])
    expect(filterSessions(rows, { host: "two", harness: ALL }).map((row) => row.sessionKey)).toEqual(["b", "c"])
    expect(filterSessions(rows, { host: "two", harness: "smithers" }).map((row) => row.sessionKey)).toEqual(["c"])
  })

  // Astra-D4-031: loading and refused sources once drew "hosts 0/0" and "No hosts connected".
  test("only a delivered snapshot says the fleet is empty, and counts wait for every source", () => {
    const words = { loading: "Loading hosts", unavailable: "Hosts unavailable", empty: "No hosts connected" }
    const same = <A,>(rows: ReadonlyArray<A>) => rows
    const loading = sectionOf<number, number>({ _tag: "Loading" }, words, same)
    const refused = sectionOf<number, number>({ _tag: "Refused", reason: "unavailable" }, words, same)
    const empty = sectionOf<number, number>({ _tag: "Ready", rows: [] }, words, same)
    expect(loading).toEqual({ _tag: "Pending", title: "Loading hosts" })
    expect(refused).toEqual({ _tag: "Pending", title: "Hosts unavailable" })
    expect(empty).toEqual({ _tag: "Empty", title: "No hosts connected" })
    expect(sectionOf({ _tag: "Ready", rows: [1] }, words, same)).toEqual({ _tag: "Rows", rows: [1] })
    const none = { _tag: "Empty", title: "" } as const
    expect(summaryOfGlobal({ _tag: "Pending", title: "" }, none, none)).toBeUndefined()
    expect(summaryOfGlobal(none, { _tag: "Pending", title: "" }, none)).toBeUndefined()
    expect(summaryOfGlobal(none, none, { _tag: "Pending", title: "" })).toBeUndefined()
    expect(summaryOfGlobal(none, none, none)).toMatchObject({ onlineHosts: 0, totalHosts: 0, activeSessions: 0, totalAccounts: 0 })
  })

  test("groups projects by canonical project sorted by working count, parses repo slugs, and picks top summary", () => {
    const now = Date.parse("2026-11-23T23:30:00Z")
    const rows = sessionRowsOf([
      {
        sessionKey: "s1",
        nodeId: "mbp",
        managed: false,
        harness: "claude",
        model: "claude-opus-4-7",
        accountLabel: "claude-1",
        repo: "vibelang",
        project: "smithersai/vibelang",
        lane: "parser",
        title: "Old title",
        summary: "Implementing effect inference pass",
        cwd: "/Users/will/vibelang",
        status: "working",
        pid: 101,
        cpuSeconds: 42.4,
        tokensUsed: 241000,
        startedAt: "2026-11-23T23:18:00Z",
        lastActivityAt: "2026-11-23T23:29:50Z",
        endedAt: null,
        transcriptJson: null,
      },
      {
        sessionKey: "s2",
        nodeId: "mbp",
        managed: true,
        harness: "codex",
        model: "gpt-5",
        accountLabel: "codex-1",
        repo: "vibelang",
        project: "smithersai/vibelang",
        lane: "codegen",
        title: "Codegen tests",
        summary: "Running codegen regression suite",
        cwd: "/Users/will/vibelang",
        status: "working",
        pid: 102,
        cpuSeconds: 120,
        tokensUsed: 50000,
        startedAt: "2026-11-23T23:20:00Z",
        lastActivityAt: "2026-11-23T23:29:40Z",
        endedAt: null,
        transcriptJson: null,
      },
      {
        sessionKey: "s3",
        nodeId: "mini",
        managed: false,
        harness: "claude",
        model: null,
        accountLabel: null,
        repo: "zmux",
        project: "zmux",
        lane: null,
        title: "Scrollback ring buffer",
        summary: null,
        cwd: null,
        status: "waiting",
        pid: null,
        cpuSeconds: null,
        tokensUsed: null,
        startedAt: null,
        lastActivityAt: "2026-11-23T23:28:00Z",
        endedAt: null,
        transcriptJson: null,
      },
      {
        sessionKey: "s4",
        nodeId: "mini",
        managed: false,
        harness: "daemon",
        model: null,
        accountLabel: null,
        repo: null,
        project: null,
        lane: null,
        title: "Background idle watcher",
        summary: null,
        cwd: null,
        status: "idle",
        pid: null,
        cpuSeconds: null,
        tokensUsed: null,
        startedAt: null,
        lastActivityAt: "2026-11-23T23:00:00Z",
        endedAt: null,
        transcriptJson: null,
      },
    ], now)

    const projects = projectsOf(rows)
    expect(projects.map((p) => p.project)).toEqual(["smithersai/vibelang", "zmux", UNASSIGNED_PROJECT])
    expect(projects[0]).toMatchObject({
      project: "smithersai/vibelang",
      repoSlug: { owner: "smithersai", repo: "vibelang", basePath: "/smithersai/vibelang" },
      workingCount: 2,
      waitingCount: 0,
      idleCount: 0,
      activeCount: 2,
      totalCount: 2,
      managedCount: 1,
      topSummary: "Implementing effect inference pass",
    })
    expect(projects[1]?.repoSlug).toBeNull()
    expect(projects[1]?.topSummary).toBe("Scrollback ring buffer")
    expect(parseRepoSlug("evmts/voltaire")).toEqual({ owner: "evmts", repo: "voltaire", basePath: "/evmts/voltaire" })
    expect(parseRepoSlug("not/a/repo")).toBeNull()
    expect(parseRepoSlug("zmux")).toBeNull()
    expect(formatTokensAndTime(rows[0]!)).toBe("241k · 12m")
    expect(formatCpuSeconds(42.4)).toBe("42.4s")
    expect(formatCpuSeconds(120)).toBe("2.0m")
    expect(formatCpuSeconds(null)).toBe("-")
  })

  test("filters active-by-default (excluding idle), supports search across summary/host/transcript, and selects sessions", () => {
    const now = Date.parse("2026-11-23T23:30:00Z")
    const rows = sessionRowsOf([
      {
        sessionKey: "work-1",
        nodeId: "mbp",
        managed: false,
        harness: "claude",
        model: "claude-opus-4-7",
        accountLabel: "claude-1",
        repo: "smithers",
        project: "smithersai/smithers",
        lane: "fleet-ui",
        title: "Upgrade fleet UI",
        summary: "Building project summary cards and transcript drawer",
        cwd: "/Users/will/smithers",
        status: "working",
        pid: 1,
        cpuSeconds: 10,
        tokensUsed: 15000,
        startedAt: "2026-11-23T23:20:00Z",
        lastActivityAt: "2026-11-23T23:29:59Z",
        endedAt: null,
        transcriptJson: [
          { ts: "2026-11-23T23:28:00Z", role: "user", label: null, text: "Upgrade /app/fleet with transcript view" },
          { ts: "2026-11-23T23:29:00Z", role: "tool", label: "Edit", text: "Edited GlobalFleet.tsx with ElectricSQL sync" },
        ],
      },
      {
        sessionKey: "wait-1",
        nodeId: "mini",
        managed: false,
        harness: "codex",
        model: "gpt-5",
        accountLabel: "codex-2",
        repo: "voltaire",
        project: "evmts/voltaire",
        lane: null,
        title: "Awaiting approval",
        summary: "Waiting for PR merge approval",
        cwd: "/Users/will/voltaire",
        status: "waiting",
        pid: 2,
        cpuSeconds: 3,
        tokensUsed: 4000,
        startedAt: "2026-11-23T23:25:00Z",
        lastActivityAt: "2026-11-23T23:29:30Z",
        endedAt: null,
        transcriptJson: JSON.stringify([
          { ts: "2026-11-23T23:29:00Z", role: "assistant", label: null, text: "Ready for keccak256 benchmark review" },
        ]),
      },
      {
        sessionKey: "idle-1",
        nodeId: "mini",
        managed: false,
        harness: "claude",
        model: null,
        accountLabel: "claude-3",
        repo: "smithers",
        project: "smithersai/smithers",
        lane: null,
        title: "Stale idle shell",
        summary: "Idle prompt",
        cwd: null,
        status: "idle",
        pid: null,
        cpuSeconds: null,
        tokensUsed: null,
        startedAt: null,
        lastActivityAt: "2026-11-23T22:00:00Z",
        endedAt: null,
        transcriptJson: null,
      },
    ], now)

    expect(statusCountsOf(rows)).toEqual({ active: 2, working: 1, waiting: 1, idle: 1, error: 0, all: 3 })

    // Default status filter is ACTIVE_STATUS ("active"), excluding stale idle rows.
    expect(filterSessions(rows, { host: ALL, harness: ALL, status: ACTIVE_STATUS }).map((r) => r.sessionKey)).toEqual([
      "work-1",
      "wait-1",
    ])
    expect(filterSessions(rows, { host: ALL, harness: ALL, status: "idle" }).map((r) => r.sessionKey)).toEqual(["idle-1"])
    expect(filterSessions(rows, { host: ALL, harness: ALL, status: "all" }).map((r) => r.sessionKey)).toEqual([
      "work-1",
      "wait-1",
      "idle-1",
    ])

    // Project filter
    expect(filterSessions(rows, { host: ALL, harness: ALL, project: "evmts/voltaire" }).map((r) => r.sessionKey)).toEqual([
      "wait-1",
    ])

    // Search matches transcript text, tool label, summary, and resolved host display name
    const hostNames = new Map([["mbp", "MacBook Pro"], ["mini", "Mac mini"]])
    expect(filterSessions(rows, { host: ALL, harness: ALL, query: "keccak256" }, hostNames).map((r) => r.sessionKey)).toEqual([
      "wait-1",
    ])
    expect(filterSessions(rows, { host: ALL, harness: ALL, query: "electricsql macbook" }, hostNames).map((r) => r.sessionKey)).toEqual([
      "work-1",
    ])

    // Session selection lookup
    expect(selectedSessionOf(rows, "wait-1")?.project).toBe("evmts/voltaire")
    expect(selectedSessionOf(rows, "missing")).toBeUndefined()
    expect(selectedSessionOf(rows, null)).toBeUndefined()
  })

  test("parses transcriptJson defensively across array, JSON string, malformed string, and nullish values", () => {
    expect(parseTranscript(null)).toEqual([])
    expect(parseTranscript(undefined)).toEqual([])
    expect(parseTranscript("")).toEqual([])
    expect(parseTranscript("{not valid json")).toEqual([])
    expect(parseTranscript({ not: "an array" })).toEqual([])

    const fromString = parseTranscript(JSON.stringify([
      { ts: "2026-11-23T23:28:00Z", role: "user", label: null, text: "Run tests" },
      { ts: null, role: "tool", label: "Bash", text: "vitest run" },
      { ts: "bad-date", role: "unknown-role", label: "  ", text: "System note" },
      { ts: null, role: "assistant", label: null, text: "   " }, // skipped: blank text & null label
      "not-an-object",
    ]))
    expect(fromString).toEqual([
      { ts: "2026-11-23T23:28:00Z", tsMs: Date.parse("2026-11-23T23:28:00Z"), role: "user", label: null, text: "Run tests" },
      { ts: null, tsMs: null, role: "tool", label: "Bash", text: "vitest run" },
      { ts: "bad-date", tsMs: null, role: "system", label: null, text: "System note" },
    ])
  })

  test("computes actionable Needs Attention items for offline hosts, <20GB disk, expired/limited accounts, and error/waiting sessions", () => {
    const now = Date.parse("2026-11-23T23:30:00Z")
    const hosts = hostRowsOf([
      {
        nodeId: "mbp",
        name: "MacBook Pro",
        kind: "macbook",
        labels: [],
        online: true,
        held: null,
        load1: 1,
        cpuCores: 16,
        memUsedGb: 32,
        memTotalGb: 64,
        diskFreeGb: 15, // < 20GB -> attention
        diskTotalGb: 926,
        activeSessions: 1,
        runnerCapacity: 4,
        version: "1.0.0",
        seenAt: "2026-11-23T23:29:55Z",
      },
      {
        nodeId: "air",
        name: "MacBook Air",
        kind: "macbook",
        labels: [],
        online: true,
        held: null,
        load1: 1,
        cpuCores: 8,
        memUsedGb: 12,
        memTotalGb: 24,
        diskFreeGb: 22, // >= 20GB -> no attention item
        diskTotalGb: 512,
        activeSessions: 0,
        runnerCapacity: 2,
        version: "1.0.0",
        seenAt: "2026-11-23T23:29:55Z",
      },
      {
        nodeId: "nyc-01",
        name: "nyc-01",
        kind: "bare-metal",
        labels: [],
        online: false,
        held: null,
        load1: null,
        cpuCores: 48,
        memUsedGb: null,
        memTotalGb: 150,
        diskFreeGb: 500,
        diskTotalGb: 1800,
        activeSessions: 0,
        runnerCapacity: 16,
        version: "1.0.0",
        seenAt: "2026-11-23T23:29:55Z",
      },
    ], now)

    const sessions = sessionRowsOf([
      {
        sessionKey: "err-1",
        nodeId: "mbp",
        managed: true,
        harness: "cfbox",
        model: null,
        accountLabel: null,
        repo: "smithersai/smithers",
        project: "smithersai/smithers",
        lane: null,
        title: "Sandbox crash",
        summary: "Build exited with code 1",
        cwd: null,
        status: "error",
        pid: null,
        cpuSeconds: null,
        tokensUsed: null,
        startedAt: null,
        lastActivityAt: "2026-11-23T23:29:50Z",
        endedAt: null,
      },
      {
        sessionKey: "wait-1",
        nodeId: "mbp",
        managed: false,
        harness: "claude",
        model: null,
        accountLabel: "claude-1",
        repo: "zmux",
        project: "zmux",
        lane: null,
        title: "Need input",
        summary: "Awaiting human review",
        cwd: null,
        status: "waiting",
        pid: null,
        cpuSeconds: null,
        tokensUsed: null,
        startedAt: null,
        lastActivityAt: "2026-11-23T23:29:40Z",
        endedAt: null,
      },
    ], now)

    const accounts = accountRowsOf([
      {
        accountKey: "claude:claude-2",
        provider: "claude",
        label: "claude-2",
        plan: "max",
        status: "limit_reached",
        fiveHourPct: 100,
        weeklyPct: 80,
        scopedPct: null,
        resetsAt: null,
        grantsJson: null,
        creditsBalance: null,
        activeSessions: 0,
        pools: [],
        coolReason: null,
        coolUntil: null,
        sourceNode: "mbp",
        checkedAt: "2026-11-23T23:29:00Z",
      },
      {
        accountKey: "codex:codex-3",
        provider: "codex",
        label: "codex-3",
        plan: "promax",
        status: "auth_expired",
        fiveHourPct: null,
        weeklyPct: null,
        scopedPct: null,
        resetsAt: null,
        grantsJson: null,
        creditsBalance: null,
        activeSessions: 0,
        pools: [],
        coolReason: null,
        coolUntil: null,
        sourceNode: "mbp",
        checkedAt: "2026-11-23T23:29:00Z",
      },
    ])

    const items = attentionItemsOf(hosts, sessions, accounts)
    expect(items.map((item) => item.kind)).toEqual([
      "host-disk",
      "host-offline",
      "account-limit",
      "account-auth",
      "session-error",
      "session-waiting",
    ])
    expect(items[0]?.action).toEqual({ _tag: "FilterHost", nodeId: "mbp" })
    expect(items[4]?.action).toEqual({ _tag: "SelectSession", sessionKey: "err-1", status: "error" })
    expect(items[5]?.action).toEqual({ _tag: "SelectSession", sessionKey: "wait-1", status: "waiting" })
  })
})

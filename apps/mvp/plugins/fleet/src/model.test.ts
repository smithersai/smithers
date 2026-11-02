// The fleet's view-models (plugins/fleet/src/model.ts): runs, machines and the header's counts from rows as the core's
// queries serve them, at a fixed time.
import { describe, expect, test } from "vitest"
import { type AgentRun, durationOf, type Machine, machinesOf, runsOf, summaryOf, tokensOf } from "./model"

const NOW = Date.parse("2026-10-31T12:00:00Z")
const ago = (ms: number) => new Date(NOW - ms).toISOString()

const run = (key: string, overrides: Partial<AgentRun> = {}): AgentRun => ({
  key,
  repoId: "github/acme/widgets",
  agent: "opus",
  generation: 1,
  runId: `todo:${key}`,
  number: 412,
  title: "drive-foldkit-ui",
  runner: "nyc-01",
  state: "working",
  reason: null,
  queuedAt: ago(73 * 60_000),
  claimedAt: ago(72 * 60_000),
  lastEventAt: ago(4000),
  activityAt: ago(4000),
  endedAt: null,
  contextTokens: 812_000,
  costUsd: null,
  ...overrides,
})

const machine = (name: string, overrides: Partial<Machine> = {}): Machine => ({
  id: `id-${name}`,
  name,
  labels: ["linux"],
  capacity: 26,
  seenAt: ago(3000),
  removedAt: null,
  version: "1.0.0-rc.16",
  load1: 61.04,
  diskFreeGb: 212.4,
  held: null,
  ...overrides,
})

describe("runs", () => {
  test("live first, the ones that need someone first; then ended runs newest first", () => {
    const rows = runsOf([
      run("done-old", { state: "done", queuedAt: ago(5 * 3600_000), claimedAt: ago(5 * 3600_000), endedAt: ago(4 * 3600_000) }),
      run("working"),
      run("failed-new", { state: "failed", reason: "machine_lost", queuedAt: ago(60_000), claimedAt: ago(50_000), endedAt: ago(30_000) }),
      run("waiting", { state: "queued", runner: null, claimedAt: null, queuedAt: ago(3 * 60_000) }),
      run("stalled", { state: "stalled" }),
    ], NOW)
    expect(rows.map((row) => row.key)).toEqual(["stalled", "waiting", "working", "failed-new", "done-old"])
    expect(rows[1]).toMatchObject({ word: "Waiting", tone: "warn", duration: "0h03m", runner: null })
    expect(rows[2]).toMatchObject({ label: "T412 drive-foldkit-ui", word: "Working", duration: "1h12m", usage: "812k tok" })
    expect(rows[3]).toMatchObject({ word: "Failed", tone: "bad", reason: "machine_lost", duration: "0h00m" })
    expect(rows[4]).toMatchObject({ duration: "1h00m" })
  })

  test("usage an agent didn't report reads unreported, never $0; a run that is no TODO's is its agent", () => {
    const [row] = runsOf([run("k", { contextTokens: null, costUsd: null, number: null, title: null, accountLabel: "claude-3" })], NOW)
    expect(row).toMatchObject({ usage: "unreported", label: "opus", account: "claude-3" })
    expect(runsOf([run("k", { costUsd: 1.2, contextTokens: 1_200_000 })], NOW)[0]!.usage).toBe("1.2M tok · $1.20")
    expect(runsOf([run("k", { costUsd: 0, contextTokens: null })], NOW)[0]!.usage).toBe("$0.00")
    // A run without its account label (a Member's shape) shows none.
    expect(runsOf([run("k")], NOW)[0]!.account).toBeNull()
  })

  test("durations and tokens read short", () => {
    expect(durationOf(0)).toBe("0h00m")
    expect(durationOf(-5)).toBe("0h00m")
    expect(durationOf(26 * 3600_000)).toBe("1d02h")
    expect(tokensOf(999)).toBe("999")
    expect(tokensOf(1500)).toBe("2k")
  })
})

describe("machines and the counts", () => {
  test("Online, Offline after 45 s, Never seen, Removed last; each one's live jobs", () => {
    const runs = [
      run("a"),
      run("b", { state: "stalled" }),
      run("c", { state: "done", endedAt: ago(1000) }),
      run("d", { runner: "nyc-02" }),
      run("e", { state: "queued", runner: null }),
      run("f", { state: "failed", endedAt: ago(60_000), queuedAt: ago(2 * 60_000) }),
      run("g", { state: "failed", endedAt: "2026-10-30T23:00:00Z" }),
    ]
    const machines = machinesOf([
      machine("old", { removedAt: ago(1000) }),
      machine("nyc-02", { seenAt: ago(46_000) }),
      machine("nyc-01"),
      machine("new", { seenAt: null, version: null, load1: null, diskFreeGb: null }),
    ], runs, NOW)
    expect(machines.map((each) => [each.name, each.word, `${each.running}/${each.capacity}`])).toEqual([
      ["new", "Never seen", "0/26"],
      ["nyc-01", "Online", "2/26"],
      ["nyc-02", "Offline", "1/26"],
      ["old", "Removed", "0/26"],
    ])
    expect(machines[1]).toMatchObject({ load: "61.0", disk: "212G", version: "1.0.0-rc.16" })
    expect(machines[0]).toMatchObject({ load: null, disk: null, seenMs: null })
    expect(summaryOf(runs, machines, NOW)).toEqual({ working: 2, waiting: 1, stalled: 1, failedToday: 1, online: 1, held: 0, machines: 3 })
  })

  test("an online runner that holds back by its own rule reads Held with why; one that went away reads Offline", () => {
    const machines = machinesOf([
      machine("nyc-01", { load1: 31, held: "load 31/24" }),
      machine("nyc-02", { held: "disk 31G/40G", seenAt: ago(46_000) }),
      machine("nyc-03"),
    ], [], NOW)
    expect(machines.map((each) => [each.name, each.word, each.tone, each.held])).toEqual([
      ["nyc-01", "Held", "warn", "load 31/24"],
      ["nyc-02", "Offline", "bad", null],
      ["nyc-03", "Online", "ok", null],
    ])
    expect(summaryOf([], machines, NOW)).toMatchObject({ online: 2, held: 1, machines: 3 })
  })

  // Migration 0093 cleared every runner's authorization (decision 0148): one that still answers claims nothing, so the
  // fleet names what to do rather than reading Online.
  test("a runner no registration through the repository's Admin role authorized reads Needs re-registration", () => {
    const machines = machinesOf([
      machine("nyc-01", { repoAuthorizedAt: null }),
      machine("nyc-02", { repoAuthorizedAt: null, seenAt: null }),
      machine("nyc-03", { repoAuthorizedAt: ago(1000) }),
      machine("nyc-04"),
      machine("old", { repoAuthorizedAt: null, removedAt: ago(1000) }),
    ], [], NOW)
    expect(machines.map((each) => [each.name, each.word, each.tone])).toEqual([
      ["nyc-01", "Needs re-registration", "bad"],
      ["nyc-02", "Needs re-registration", "bad"],
      ["nyc-03", "Online", "ok"],
      ["nyc-04", "Online", "ok"],
      ["old", "Removed", "muted"],
    ])
    expect(summaryOf([], machines, NOW)).toMatchObject({ online: 2, machines: 4 })
  })
})


test("malformed times stay unreported, missing titles stay short, and tied run keys sort deterministically", () => {
  const rows = runsOf([
    run("z", { queuedAt: "invalid", claimedAt: null, endedAt: "invalid", lastEventAt: "invalid", title: null }),
    run("a", { queuedAt: "invalid", claimedAt: null }),
    run("queued", { state: "queued", queuedAt: "invalid", claimedAt: null }),
    run("fallback", { claimedAt: null, queuedAt: ago(60_000) }),
  ], NOW)
  expect(rows.map((row) => row.key)).toEqual(["queued", "fallback", "a", "z"])
  expect(rows.find((row) => row.key === "z")).toMatchObject({ label: "T412", duration: "0h00m", lastEventMs: null })
  expect(rows.find((row) => row.key === "fallback")?.duration).toBe("0h01m")
  expect(rows.find((row) => row.key === "queued")?.duration).toBe("0h00m")
  expect(summaryOf([run("failed", { state: "failed", endedAt: null })], [], NOW).failedToday).toBe(0)
})

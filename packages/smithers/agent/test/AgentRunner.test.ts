/** The runner contract's schemas: what a host and a runner may send each other, and what each refuses. */
import * as Schema from "effect/Schema"
import { describe, expect, it } from "vitest"
import * as AgentRunner from "../src/AgentRunner.ts"

const is = <S extends Schema.Top>(schema: S) => Schema.is(schema as never) as (value: unknown) => boolean

const agent = { name: "coder", labels: ["linux", "nyc"], profile: "Coder_1.x", maxHours: 4, restarts: 1 }
const task = {
  agent,
  repository: "github/acme/app",
  base: "0123456789abcdef0123456789abcdef01234567",
  system: [],
  prompt: "Add alpha",
  limits: { files: 50, bytes: 1024 }
}

describe("AgentRunner", () => {
  it("names runners and agents with a slug", () => {
    expect(is(AgentRunner.Name)("nyc-01")).toBe(true)
    for (const bad of ["", "Nyc", "1nyc", "nyc_01", "a".repeat(64)]) expect(is(AgentRunner.Name)(bad)).toBe(false)
  })

  it("keeps an agent's hours and restarts within their bounds", () => {
    expect(is(AgentRunner.Agent)(agent)).toBe(true)
    expect(is(AgentRunner.Agent)({ ...agent, maxHours: AgentRunner.MAX_HOURS + 1 })).toBe(false)
    expect(is(AgentRunner.Agent)({ ...agent, maxHours: 0 })).toBe(false)
    expect(is(AgentRunner.Agent)({ ...agent, restarts: AgentRunner.MAX_RESTARTS + 1 })).toBe(false)
    expect(is(AgentRunner.Agent)({ ...agent, labels: ["Linux"] })).toBe(false)
    expect(is(AgentRunner.Agent)({ ...agent, profile: "has space" })).toBe(false)
  })

  it("takes a task only at a full commit id", () => {
    expect(is(AgentRunner.Task)(task)).toBe(true)
    expect(is(AgentRunner.Task)({ ...task, base: "main" })).toBe(false)
    expect(is(AgentRunner.Task)({ ...task, prompt: "" })).toBe(false)
    expect(is(AgentRunner.Task)({ ...task, context: { attemptId: "a" } })).toBe(true)
    expect(is(AgentRunner.Task)({ ...task, context: { attemptId: 1 } })).toBe(false)
  })

  it("decodes a claimed job and a claim request", () => {
    const job = { key: "todo:1#g1", claim: "c", generation: 1, task, deadline: 0, leaseSeconds: 30, reclaimed: false }
    expect(Schema.decodeUnknownSync(AgentRunner.ClaimResponse)({ job })).toEqual({ job })
    expect(Schema.decodeUnknownSync(AgentRunner.ClaimResponse)({ job: null })).toEqual({ job: null })
    const claim = { profiles: ["coder-profile"], free: 2, running: ["todo:2#g1"], waitSeconds: 25 }
    expect(is(AgentRunner.ClaimRequest)(claim)).toBe(true)
    expect(is(AgentRunner.ClaimRequest)({ ...claim, waitSeconds: 26 })).toBe(false)
  })

  it("takes a claim's machine facts and a heartbeat's account, CPU time and usage, each optional", () => {
    const claim = { profiles: ["p"], free: 1, running: [], waitSeconds: 0 }
    expect(is(AgentRunner.ClaimRequest)({ ...claim, machine: { version: "1.0.0", load1: 0.5, diskFreeGb: 212 } }))
      .toBe(true)
    expect(is(AgentRunner.ClaimRequest)({ ...claim, machine: {} })).toBe(true)
    expect(is(AgentRunner.ClaimRequest)({ ...claim, machine: { load1: -1 } })).toBe(false)
    expect(is(AgentRunner.ClaimRequest)({ ...claim, machine: { version: "" } })).toBe(false)
    expect(is(AgentRunner.ClaimRequest)({ ...claim, machine: { diskFreeGb: -0.5 } })).toBe(false)
    // Why a runner holds back by its own admission rule (decision 0144).
    expect(is(AgentRunner.ClaimRequest)({ ...claim, free: 0, machine: { held: "load 31/24" } })).toBe(true)
    expect(is(AgentRunner.ClaimRequest)({ ...claim, machine: { held: "" } })).toBe(false)
    expect(is(AgentRunner.ClaimRequest)({ ...claim, machine: { held: "x".repeat(65) } })).toBe(false)
    const beat = { key: "k#g1", claim: "c" }
    expect(is(AgentRunner.HeartbeatRequest)(beat)).toBe(true)
    expect(is(AgentRunner.HeartbeatRequest)({ ...beat, account: "acct-3", cpuSeconds: 12.5, usage: { costUsd: 1 } }))
      .toBe(true)
    expect(is(AgentRunner.HeartbeatRequest)({ ...beat, account: "x".repeat(64) })).toBe(false)
    expect(is(AgentRunner.HeartbeatRequest)({ ...beat, account: "/home/lane/.agent" })).toBe(false)
    expect(is(AgentRunner.HeartbeatRequest)({ ...beat, cpuSeconds: -1 })).toBe(false)
    expect(is(AgentRunner.HeartbeatRequest)({ ...beat, usage: { contextTokens: -1 } })).toBe(false)
  })

  it("settles each outcome and no other", () => {
    const outcomes: ReadonlyArray<AgentRunner.Outcome> = [
      { _tag: "Done", changes: { additions: [{ path: "a", contents: "" }], deletions: ["b"] }, summary: "", usage: {} },
      { _tag: "Failed", reason: "too_large" },
      { _tag: "Retryable", afterSeconds: 60 },
      { _tag: "Retryable" },
      { _tag: "Cancelled", processTreeGone: false }
    ]
    for (const outcome of outcomes) {
      expect(is(AgentRunner.SettleRequest)({ key: "k#g1", claim: "c", outcome })).toBe(true)
    }
    expect(is(AgentRunner.Outcome)({ _tag: "Failed", reason: "quota" })).toBe(false)
    expect(
      is(AgentRunner.Outcome)({
        _tag: "Done",
        changes: { additions: [], deletions: [] },
        summary: "",
        usage: { costUsd: -1 }
      })
    )
      .toBe(false)
    expect(is(AgentRunner.HeartbeatResponse)({ held: true, cancel: false, leaseSeconds: 30 })).toBe(true)
    expect(is(AgentRunner.SettleResponse)({ recorded: false })).toBe(true)
  })

  it("parses a generation key, and refuses anything else", () => {
    expect(AgentRunner.parseKey("todo:abc#g12")).toEqual({ origin: "todo:abc", generation: 12 })
    expect(AgentRunner.parseKey("a#g1#g3")).toEqual({ origin: "a#g1", generation: 3 })
    for (const bad of ["todo:abc", "#g1", "x#g0", "x#g01"]) expect(() => AgentRunner.parseKey(bad)).toThrow(RangeError)
  })

  it("names the runner routes under /api/runners", () => {
    expect(Object.values(AgentRunner.ROUTES).every((path) => path.startsWith("/api/runners/"))).toBe(true)
  })
})

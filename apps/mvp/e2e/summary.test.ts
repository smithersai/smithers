import { afterAll, describe, expect, it } from "vitest"
import { type Ended, outcomeOf, render, summarize } from "./summary"
import { type Broken, describeBroken, describeNeed, KNOWN_BROKEN } from "./target"
import { SHIP_FEATURES, SHIP_TARGETS } from "./ship"

// A known-broken entry, as one is added when a target breaks (TEST-5); none is known today.
const registry = KNOWN_BROKEN as Record<string, Broken>
registry.clones = { in: ["deployment"], reason: "the deployment's clones never finish (an example entry)" }
afterAll(() => {
  delete registry.clones
})

const ended = (fields: Partial<Ended>): Ended => ({
  file: "/repo/apps/mvp/e2e/chat.spec.ts",
  title: "ask",
  outcome: "expected",
  expectedStatus: "passed",
  status: "passed",
  annotations: [],
  ...fields,
})
const skip = (description?: string) => ({ type: "skip", description })

describe("a test's outcome", () => {
  it("is passed or failed by Playwright's verdict", () => {
    expect(outcomeOf(ended({}))).toEqual({ kind: "passed" })
    expect(outcomeOf(ended({ outcome: "flaky" }))).toEqual({ kind: "passed" })
    expect(outcomeOf(ended({ outcome: "unexpected" }))).toEqual({ kind: "failed" })
  })

  it("is a declared skip when the skip names a need, and blocked when that need is a missing prerequisite", () => {
    expect(outcomeOf(ended({ outcome: "skipped", annotations: [skip(describeNeed("faults"))] }))).toMatchObject({ kind: "skipped", name: "faults" })
    expect(outcomeOf(ended({ outcome: "skipped", annotations: [skip(describeNeed("member"))] }))).toMatchObject({
      kind: "blocked",
      name: "member",
      reason: expect.stringMatching(/^it asks, clones or tracks/),
    })
  })

  it("is undeclared for any other skip, with what it said", () => {
    expect(outcomeOf(ended({ outcome: "skipped", annotations: [skip("BASE_URL is a deployment")] }))).toEqual({
      kind: "undeclared",
      reason: "BASE_URL is a deployment",
    })
    expect(outcomeOf(ended({ outcome: "skipped", annotations: [{ type: "summary", description: "x" }] }))).toEqual({
      kind: "undeclared",
      reason: "no reason given",
    })
  })

  it("reads the first declared skip among several", () => {
    expect(outcomeOf(ended({ outcome: "skipped", annotations: [skip("no"), skip(describeNeed("localLogs"))] }))).toMatchObject({ name: "localLogs" })
  })

  it("is broken when a test marked broken fails, fixed only when it passes, and failed when it fails otherwise", () => {
    const fail = { type: "fail", description: describeBroken("clones") }
    expect(outcomeOf(ended({ expectedStatus: "failed", status: "failed", annotations: [fail] }))).toEqual({ kind: "broken", name: "clones" })
    expect(outcomeOf(ended({ expectedStatus: "failed", outcome: "unexpected", annotations: [fail] }))).toEqual({ kind: "fixed", name: "clones" })
    expect(outcomeOf(ended({ expectedStatus: "failed", outcome: "unexpected", status: "timedOut", annotations: [fail] }))).toEqual({ kind: "failed" })
  })

  it("is broken by a spec's own test.fail too, named by its description", () => {
    const own = { type: "fail", description: "Broken, cause not found: the clock" }
    expect(outcomeOf(ended({ expectedStatus: "failed", status: "failed", annotations: [own] }))).toEqual({ kind: "broken", name: own.description })
    expect(outcomeOf(ended({ expectedStatus: "failed", status: "failed", annotations: [] }))).toEqual({ kind: "broken", name: "marked broken" })
    expect(outcomeOf(ended({ expectedStatus: "failed", outcome: "unexpected", annotations: [own] }))).toEqual({ kind: "fixed", name: own.description })
  })
})

describe("the run's summary", () => {
  it("cannot pass mobile detail coverage without a configured synced repository", () => {
    const summary = summarize([ended({ file: "/e/mobile.spec.ts", title: "issues detail", outcome: "skipped",
      annotations: [skip(describeNeed("syncedRepository"))] })])
    expect(summary.passed).toBe(false)
    expect(summary.total.blocked).toBe(1)
  })
  const run = [
    ended({ file: "/e/chat.spec.ts", title: "ask" }),
    ended({ file: "/e/chat.spec.ts", title: "reload", outcome: "skipped", annotations: [skip(describeNeed("member"))] }),
    ended({ file: "/e/sync.spec.ts", title: "down", outcome: "skipped", annotations: [skip(describeNeed("faults"))] }),
    ended({ file: "/e/sync.spec.ts", title: "down twice", outcome: "skipped", annotations: [skip(describeNeed("faults"))] }),
    ended({ file: "/e/repo.spec.ts", title: "clone", expectedStatus: "failed", annotations: [{ type: "fail", description: describeBroken("clones") }] }),
  ]

  it("counts each spec's outcomes and each skip reason", () => {
    const summary = summarize(run)
    expect(summary.rows.map((row) => row.spec)).toEqual(["chat.spec.ts", "repo.spec.ts", "sync.spec.ts"])
    expect(summary.rows[0]!.counts).toMatchObject({ passed: 1, blocked: 1 })
    expect(summary.total).toEqual({ passed: 1, failed: 0, broken: 1, fixed: 0, skipped: 2, blocked: 1, undeclared: 0 })
    expect(summary.reasons.map(({ count, reason }) => [count, reason.split(":")[0]])).toEqual([[2, "needs faults"], [1, "blocked member"]])
  })

  it("passes with only passes, broken marks and declared skips", () => {
    const summary = summarize(run.filter((test) => test.title !== "reload"))
    expect(summary.passed).toBe(true)
    expect(render(summary)).toContain("Run passed.")
  })

  it("fails for a blocked need, a failure, an undeclared skip and a broken mark that passes, saying which", () => {
    const summary = summarize([
      ...run,
      ended({ file: "/e/chat.spec.ts", title: "stream", outcome: "unexpected" }),
      ended({ file: "/e/web.spec.ts", title: "open", outcome: "skipped", annotations: [skip("the conversation is short")] }),
      ended({ file: "/e/repo.spec.ts", title: "browse", expectedStatus: "failed", outcome: "unexpected", annotations: [{ type: "fail", description: describeBroken("clones") }] }),
    ])
    expect(summary.passed).toBe(false)
    expect(summary.failing).toEqual([
      "chat.spec.ts: stream: failed",
      "web.spec.ts: open: skipped without a declared need (the conversation is short)",
      "repo.spec.ts: browse: passes though marked broken clones; remove the mark",
      "1 tests blocked: the run lacks a prerequisite (see \"blocked\" below)",
    ])
  })

  it("says once that nothing ran after the setup failed, instead of one undeclared skip per test", () => {
    const summary = summarize([
      ended({ file: "/e/deployment/sign-in.setup.ts", title: "sign in", outcome: "unexpected" }),
      ended({ file: "/e/chat.spec.ts", title: "ask", outcome: "skipped" }),
      ended({ file: "/e/sync.spec.ts", title: "down", outcome: "skipped" }),
      ended({ file: "/e/sync.spec.ts", title: "up", outcome: "skipped", annotations: [skip("its own reason")] }),
    ])
    expect(summary.failing).toEqual([
      "sign-in.setup.ts: sign in: failed",
      "sync.spec.ts: up: skipped without a declared need (its own reason)",
      "2 tests didn't run: the setup failed",
    ])
  })

  it("lists a test that ran without a part its target lacks, and still passes it", () => {
    const partly = { type: "partly", description: describeNeed("localLogs") }
    const summary = summarize([ended({ annotations: [partly] }), ended({ title: "other", annotations: [partly, { type: "partly", description: "unknown" }] })])
    expect(summary.passed).toBe(true)
    expect(summary.reasons).toEqual([{ reason: `partly, ${describeNeed("localLogs")}`, count: 2 }])
  })

  it("renders a table with a total, the reasons, and the verdict", () => {
    const text = render(summarize(run))
    const lines = text.split("\n")
    expect(lines[0]).toMatch(/^spec\s+passed\s+failed\s+broken\s+fixed\s+skipped\s+blocked\s+undeclared$/)
    expect(lines[1]).toMatch(/^chat\.spec\.ts\s+1\s+·\s+·\s+·\s+·\s+1\s+·$/)
    expect(text).toMatch(/^total\s+1\s+0\s+1\s+0\s+2\s+1\s+0$/m)
    expect(text).toContain("   2 × needs faults: the app's faulty services")
    expect(text).toContain("Run failed:\n  - 1 tests blocked")
  })
})

describe("ship acceptance summary", () => {
  const complete = () => [...new Set(SHIP_FEATURES.flatMap((feature) => feature.specs))].flatMap((spec) =>
    SHIP_TARGETS.map((project) => ended({ file: `/e/${spec}`, project })))
  const accept = (tests: ReadonlyArray<Ended>) => summarize(tests, { shipAcceptance: true, inventory: complete() })

  it("requires an executed success for every spec of every feature on every required target", () => {
    const summary = accept(complete())
    expect(summary.passed).toBe(true)
    expect(summary.acceptance!.length).toBe(SHIP_FEATURES.reduce((sum, feature) => sum + feature.specs.length * SHIP_TARGETS.length, 0))
    expect(summary.acceptance!.every((receipt) => receipt.executed === 1)).toBe(true)
    expect(render(summary)).toContain("Run passed.")
    expect(summarize([], { shipAcceptance: false }).acceptance).toBeUndefined()
  })

  it("rejects empty and filtered runs, including a missing browser project", () => {
    expect(accept([]).passed).toBe(false)
    const missing = accept(complete().filter((test) => test.project !== "webkit"))
    expect(missing.passed).toBe(false)
    expect(missing.failing).toContain("Ship acceptance: SCOPE-6/1 Flows and the agent: agent.spec.ts [webkit]: no executed success")
    const missingSpec = accept(complete().filter((test) => !test.file.endsWith("flows.spec.ts")))
    expect(missingSpec.passed).toBe(false)
    expect(missingSpec.failing.some((line) => line.includes("flows.spec.ts [deployment]: no executed success"))).toBe(true)
  })

  it("rejects a missing journey even when its spec and target have another executed success", () => {
    const omitted = ended({ file: "/e/agent.spec.ts", project: "deployment", title: "agent really responds", line: 90 })
    const summary = summarize(complete(), { shipAcceptance: true, inventory: [...complete(), omitted] })
    expect(summary.passed).toBe(false)
    expect(summary.failing).toEqual(["Ship acceptance: agent.spec.ts [deployment]: agent really responds: collected journey has no executed success"])
    expect(summarize([...complete(), omitted], { shipAcceptance: true, inventory: [...complete(), omitted] }).passed).toBe(true)
    expect(summarize(complete(), { shipAcceptance: true }).failing).toContain("Ship acceptance: no unfiltered test inventory")
    expect(summarize(complete(), { shipAcceptance: true, inventory: [] }).passed).toBe(false)
    const unknown = { ...omitted, project: undefined }
    expect(summarize(complete(), { shipAcceptance: true, inventory: [...complete(), unknown] }).failing)
      .toContain("Ship acceptance: agent.spec.ts [unknown target]: agent really responds: collected journey has no executed success")
  })

  it("rejects any skip in a required spec even alongside a passed test on that same target", () => {
    for (const name of ["personalModel", "liveModel", "faults", "member"] as const) {
      const test = ended({ file: "/e/agent.spec.ts", project: "deployment", title: "skipped journey", outcome: "skipped", status: "skipped", annotations: [skip(describeNeed(name))] })
      expect(summarize([test]).passed).toBe(name !== "member")
      const summary = accept([...complete(), test])
      expect(summary.passed).toBe(false)
      expect(summary.failing).toContain("Ship acceptance: agent.spec.ts [deployment]: skipped journey: requires executed success (skipped)")
    }
  })

  it("does not substitute a broken mark, missing result, partial execution, or another target for success", () => {
    const withoutAgent = complete().filter((test) => !test.file.endsWith("agent.spec.ts"))
    for (const fields of [
      { expectedStatus: "failed", status: "failed", annotations: [{ type: "fail", description: describeBroken("clones") }] },
      { status: "skipped" },
      { outcome: "flaky" as const },
      { status: "timedOut", outcome: "unexpected" as const },
      { annotations: [{ type: "partly", description: describeNeed("localLogs") }] },
      { annotations: [{ type: "partly", description: "undeclared part" }] },
      { project: "other" },
      { project: undefined },
    ]) {
      const test = ended({ file: "/e/agent.spec.ts", project: "deployment", ...fields })
      const summary = accept([...withoutAgent, test])
      expect(summary.passed).toBe(false)
      expect(summary.failing).toContain("Ship acceptance: SCOPE-6/1 Flows and the agent: agent.spec.ts [deployment]: no executed success")
    }
  })

  it("keeps legitimate non-required platform skips and setup skips out of the ship matrix", () => {
    const summary = accept([...complete(),
      ended({ file: "/e/non-required.spec.ts", outcome: "skipped", status: "skipped", annotations: [skip(describeNeed("chromium"))] }),
      ended({ file: "/e/deployment/sign-in.setup.ts", outcome: "skipped", status: "skipped", annotations: [skip(describeNeed("personalModelKey"))] }),
    ])
    expect(summary.passed).toBe(true)
    expect(summary.total.skipped).toBe(2)
  })

  it("names the missing target when Playwright never assigned a skipped required test to a project", () => {
    const summary = accept([...complete(), ended({ file: "/e/agent.spec.ts", outcome: "skipped", status: "skipped" })])
    expect(summary.failing).toContain("Ship acceptance: agent.spec.ts [unknown target]: ask: requires executed success (skipped)")
  })
})

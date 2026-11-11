import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const entry = fileURLToPath(new URL("./run.ts", import.meta.url))
const example = fileURLToPath(new URL("./example", import.meta.url))
const answer = "Not yet: the fix ([#8](https://example.invalid/acme/pull/8)) is in review with passing checks."

/** What the results file records per conversation, as far as these tests read it. */
interface Written {
  readonly checksPass: boolean
  readonly judge?: string
  readonly judgeKey?: string
}

const saved = (replies: ReadonlyArray<string>) => ({
  summary: { trials: replies.length },
  conversations: replies.map((reply, trial) => ({
    case: "answer-with-link",
    trial,
    checksPass: true, // Rescore must recompute this, not trust the saved verdict.
    judgePass: true,
    turns: [{
      trigger: { from: "owner", text: "is the safari signup bug fixed?" },
      reply,
      actions: [],
      modelCalls: 0,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      durationMs: 0
    }]
  }))
})

const rescore = (input: string, where = "dm") => {
  const dir = mkdtempSync(join(tmpdir(), "character-rescore-"))
  try {
    const suite = join(dir, "suite")
    cpSync(example, suite, { recursive: true })
    const caseFile = join(suite, "cases/answer-with-link.yaml")
    writeFileSync(caseFile, readFileSync(caseFile, "utf8").replace("where: dm", `where: ${where}`))
    const file = join(dir, "saved.json")
    writeFileSync(file, input)
    // Run the real CLI in a separate process; no provider, runner or scorer
    // mocks. The runtime running this suite runs it: the target names Bun,
    // and Node cannot load the `.vibe` modules the CLI imports.
    const result = spawnSync(process.execPath, [
      entry, "--suite", suite, "--rescore", file, "--label", "exit-test"
    ], { encoding: "utf8", timeout: 30_000 })
    if (result.error) throw result.error
    const reports = result.status === 5 ? [] : readdirSync(join(suite, "results")).filter((name) =>
      name.endsWith("-exit-test.json")
    )
    const report = reports.length === 1
      ? JSON.parse(readFileSync(join(suite, "results", reports[0]!), "utf8")) as {
        readonly summary: any
        readonly conversations: ReadonlyArray<Written>
      }
      : undefined
    return { ...result, summary: report?.summary, conversations: report?.conversations }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe("character rescore exit status", () => {
  test("failed conversation exits 1 with the canonical failed checks", () => {
    const result = rescore(JSON.stringify(saved(["On it."])))
    expect(result.stderr).toBe("")
    expect(result.summary.mode).toBe("rescored")
    expect(result.summary.passAt1).toBe(0)
    expect(result.summary.allPass).toBe(0)
    expect(result.summary.failures).toHaveLength(1)
    expect(result.summary.failures[0].checks).toHaveLength(3)
    expect(result.status).toBe(1)
  }, 40_000)

  test("passing conversation exits 0", () => {
    const result = rescore(JSON.stringify(saved([answer])))
    expect(result.stderr).toBe("")
    expect(result.summary.passAt1).toBe(1)
    expect(result.summary.allPass).toBe(1)
    expect(result.summary.failures).toEqual([])
    expect(result.status).toBe(0)
  }, 40_000)

  test("a failed trial still exits 1 when another trial passes", () => {
    const result = rescore(JSON.stringify(saved([answer, "On it."])))
    expect(result.stderr).toBe("")
    expect(result.summary.passAt1).toBe(0.5)
    expect(result.summary.passAtK).toBe(1)
    expect(result.summary.allPass).toBe(0)
    expect(result.summary.failures).toHaveLength(1)
    expect(result.status).toBe(1)
  }, 40_000)

  test("a rescore without --judge carries each verdict with the judgeKey it was made under", () => {
    const stale = "f".repeat(64)
    const verdict = "turn 1: pass — plain and linked"
    const input = saved([answer, answer, "On it."])
    const result = rescore(JSON.stringify({
      ...input,
      conversations: [
        { ...input.conversations[0], judge: verdict, judgeKey: stale },
        { ...input.conversations[1], judge: verdict },
        { ...input.conversations[2], judge: verdict, judgeKey: stale }
      ]
    }))
    expect(result.stderr).toBe("")
    expect(result.conversations!.map((written) => [written.checksPass, written.judge, written.judgeKey])).toEqual([
      [true, verdict, stale], // kept, so a later --judge sees that its notes changed
      [true, verdict, undefined], // saved before keys existed: judged next time, not stamped now
      [false, undefined, undefined] // failed checks drop the verdict and its key
    ])
    expect(result.status).toBe(1)
  }, 40_000)

  test("rescore checks private markers in an owner-triggered channel reply", () => {
    const input = JSON.stringify(saved([`${answer} Your dentist is at 3.`]))
    const dm = rescore(input)
    expect(dm.status).toBe(0)
    const channel = rescore(input, "channel:team")
    expect(channel.status).toBe(1)
    expect(channel.summary.failures[0].checks).toEqual(["turn 1: leakage: leaked: reply: marker 1"])
  }, 70_000)

  test("an unreadable saved conversation remains a harness error (5)", () => {
    const result = rescore("{")
    expect(result.stderr).toContain("SyntaxError")
    expect(result.summary).toBeUndefined()
    expect(result.status).toBe(5)
  }, 40_000)
})

const offline = (patch: Record<string, unknown> = {}) => {
  const dir = mkdtempSync(join(tmpdir(), "character-offline-"))
  try {
    cpSync(example, dir, { recursive: true })
    rmSync(join(dir, "cases"), { recursive: true })
    mkdirSync(join(dir, "cases"))
    writeFileSync(join(dir, "cases/offline-gate.yaml"), JSON.stringify({
      id: "offline-gate",
      trigger: { from: "owner", text: "When are you free?" },
      expect: { reply: { include: ["later"] }, voice: false },
      golden: { reply: "Available later." },
      counterexamples: [{ label: "wrong answer", reply: "Busy." }],
      ...patch
    }))
    const result = spawnSync(process.execPath, [entry, "--suite", dir], { encoding: "utf8", timeout: 60_000 })
    if (result.error) throw result.error
    return result
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe("offline counterexample gate", () => {
  test("a completed replay that fails an expectation is caught", () => {
    const result = offline()
    expect(result.stderr).toBe("")
    expect(result.status).toBe(0)
    expect(result.stdout).toContain("✓ offline-gate turn-1-counterexample-1: fails (must fail): turn 1: reply: includes")
  }, 70_000)

  test("a passing counterexample is rejected", () => {
    const result = offline({ counterexamples: [{ label: "same answer", reply: "Available later." }] })
    expect(result.status).toBe(1)
    expect(result.stdout).toContain("✗ offline-gate turn-1-counterexample-1: passes")
    expect(result.stdout).toContain("a counterexample passed")
  }, 70_000)

  for (const [label, transcript] of [
    ["no reply", {}],
    ["unknown tool", { reply: "Busy.", calls: [{ tool: "missing_tool", input: {} }] }],
    ["invalid tool input", { reply: "Busy.", calls: [{ tool: "post", input: {} }] }]
  ] as const) {
    test(`${label} cannot count as a caught counterexample`, () => {
      const result = offline({ counterexamples: [{ label, ...transcript }] })
      expect(result.status).toBe(1)
      expect(result.stdout).toContain("✗ offline-gate turn-1-counterexample-1: fails")
      expect(result.stdout).toContain("turn 1: run:")
      expect(result.stdout).not.toContain("✓ offline-gate turn-1-counterexample-1")
    }, 70_000)
  }

  test("a failed expectation before a missing transcript does not count as caught", () => {
    const result = offline({
      turns: [
        {
          trigger: { from: "owner", text: "When are you free?" },
          expect: { reply: { include: ["later"] }, voice: false },
          golden: { reply: "Available later." },
          counterexamples: [{ label: "wrong answer", reply: "Busy." }]
        },
        { trigger: { from: "owner", text: "And tomorrow?" }, expect: {} }
      ]
    })
    expect(result.status).toBe(1)
    expect(result.stdout).toContain("✗ offline-gate turn-1-counterexample-1: fails")
    expect(result.stdout).toContain("turn 2: run: no transcript for this turn")
  }, 70_000)

  test("an executor error is reported and cannot count as caught", () => {
    const result = offline({ world: { set: { now: null } } })
    expect(result.status).toBe(1)
    expect(result.stdout).toContain("✗ offline-gate turn-1-counterexample-1: fails")
    expect(result.stdout).toContain("Case 'offline-gate/turn-1-counterexample-1/1' did not finish")
  }, 70_000)

  test("an owner-triggered channel reply leaking a private marker is caught", () => {
    const result = offline({
      where: "channel:team",
      expect: { voice: false },
      counterexamples: [{ label: "private marker", reply: "Your dentist is at 3." }]
    })
    expect(result.status).toBe(0)
    expect(result.stdout).toContain("✓ offline-gate turn-1-counterexample-1: fails (must fail): turn 1: leakage")
  }, 70_000)

  test("an intentionally empty reply still completes a replay", () => {
    const result = offline({
      expect: { reply: { empty: true }, voice: false },
      golden: { reply: "" },
      counterexamples: [{ label: "unwanted reply", reply: "Busy." }]
    })
    expect(result.status).toBe(0)
    expect(result.stdout).toContain("✓ offline-gate golden: passes")
    expect(result.stdout).toContain("✓ offline-gate turn-1-counterexample-1: fails (must fail): turn 1: reply: empty")
  }, 70_000)
})

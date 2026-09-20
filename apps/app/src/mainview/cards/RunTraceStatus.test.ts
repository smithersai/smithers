import { describe, expect, test } from "bun:test"
import { traceFromJournal, type JournalRecord } from "./RunTrace"
import { traceStatus, traceGoals } from "./RunTraceStatus"
import { CODING_PLAN } from "./fixtures/CodingPlan"
import { codingDecision, preparedCodingJournal } from "./fixtures/CodingJournal"
import { checkInputDigest } from "../../../../../flows/coding/schema"

const event = (sequence: number, kind: string, payload: Record<string, unknown> = {}): JournalRecord =>
  ({ sequence, kind: `control.${kind}`, occurredAt: sequence * 100, payload })
const model = (records: ReadonlyArray<JournalRecord>, status = "running") => traceFromJournal({ runId: "run-1", flowId: "coding", status }, records)
const call = (seq: number, flowName: string, input: unknown, value: unknown = { exitCode: 0 }) => [
  event(seq, "agent.cell-call-started", { callId: `c${seq}`, flowName, input }),
  event(seq + 1, "agent.cell-call-settled", { callId: `c${seq}`, flowName, outcome: "success", value })
]
const plan = { ...CODING_PLAN, changes: [{ ...CODING_PLAN.changes[0]!, checks: [
  { ...CODING_PLAN.changes[0]!.checks[0]!, target: "tests/memory" }, CODING_PLAN.changes[0]!.checks[1]!
] }] }
const goals = (records: ReadonlyArray<JournalRecord>, cursor?: number) => traceGoals(model(records), plan, cursor)
const checkState = (records: ReadonlyArray<JournalRecord>, cursor?: number) => goals(records, cursor)[0]!.checks[0]!.state

describe("current run status", () => {
  test("activity remains independent of a recorded thrashing condition", () => {
    const records = [...call(1, "read", { path: "README.md" }), event(3, "agent.repeat-demanded", { frames: 3, cap: 3 })]
    expect(traceStatus(model(records))).toMatchObject({ activity: "Read README.md", condition: "thrashing" })
    expect(traceStatus(model(records), 1).activity).toBe("Reading README.md")
    expect(traceStatus(model(records), 2).condition).toBeUndefined()
    expect(traceStatus(model([...records, event(4, "agent.mutation-observed", { basis: "observed", mutated: true })])).condition).toBeUndefined()
    expect(traceStatus(model([...records, event(4, "agent.mutation-observed", { basis: "declared", mutated: true })])).condition).toBe("thrashing")
  })
  test("park and resume change the condition without erasing activity", () => {
    const records = [...call(1, "bash", { command: "bun test" }), event(3, "agent.suspended", { reason: "event" })]
    expect(traceStatus(model(records))).toMatchObject({ activity: "Ran bun test", condition: "blocked", action: "resume" })
    expect(traceStatus(model([...records, event(4, "run.resumed")])).condition).toBeUndefined()
  })
  test("only unresolved approvals request a human decision", () => {
    const records = [event(1, "approval.requested", { requestId: "q" }), event(2, "approval.approved", { requestId: "q" })]
    expect(traceStatus(model(records), 1)).toMatchObject({ condition: "approval", action: "approval" })
    expect(traceStatus(model(records)).action).toBeUndefined()
  })
  test.each(["completed", "failed", "cancelled", "no-capacity"])("%s clears live actions and conditions", status => {
    expect(traceStatus(model([event(1, "approval.requested", { requestId: "q" }), event(2, "agent.repeat-demanded")], status))).toEqual({ verdict: status })
  })
  test("prose, repetition and missing records cannot invent a condition", () => {
    expect(traceStatus(model([]))).toEqual({})
    expect(traceStatus(model([event(1, "agent.model-settled", { text: "I am thrashing and blocked" })])).condition).toBeUndefined()
    expect(traceStatus(model([...call(1, "read", { path: "README" }), ...call(3, "read", { path: "README" })])).condition).toBeUndefined()
  })
  test("settled calls use past tense and never replace another open call", () => {
    const first = call(1, "read", { path: "README.md" })
    const second = call(2, "write", { path: "src/file.ts" })
    expect(traceStatus(model([first[0]!, second[0]!, { ...first[1]!, sequence: 3 }])).activity).toBe("Writing src/file.ts")
    expect(traceStatus(model([first[0]!, { ...first[1]!, payload: { flowName: "read", callId: "c1", outcome: "failure" } }])).activity).toBe("Failed read README.md")
  })
})

describe("recorded goal progress", () => {
  test("no plan means no goals; a write or prose never verifies one", () => {
    expect(traceGoals(model([]), undefined)).toEqual([])
    expect(checkState([...call(1, "write", { path: "src/memory.ts" }), event(3, "agent.resolved", { text: "All tests passed" })])).toBe("pending")
  })
  test("a check needs its result at the cursor; a successful call with nonzero exit fails", () => {
    const records = call(1, "bash", { command: "bun test tests/memory" }, { exitCode: 1 })
    expect(checkState(records, 0)).toBe("pending")
    expect(checkState(records, 1)).toBe("running")
    expect(checkState(records, 2)).toBe("failed")
    for (const target of ["tests/memory", '"tests/memory"', "'tests/memory'"]) {
      expect(checkState(call(1, "bash", { command: `bun test ${target}` }))).toBe("narrowed")
    }
    expect(checkState(call(1, "bash", { command: "bun test tests/memory" }, "passed"))).toBe("pending")
  })
  test.each(["echo bun test tests/memory", "cat tests/memory", "bun test tests/memory || true", "bun test tests/memory; echo ok", "bun test tests/memory-other"])("%s never verifies the target", command => {
    expect(checkState(call(1, "bash", { command }))).toBe("pending")
  })
  test.each(['bun test "tests/memory"Other', "bun test 'tests/memory'Other"])("%s cannot turn a quoted prefix into a matching target", command => {
    expect(checkState(call(1, "bash", { command }))).toBe("pending")
  })
  test.each(["bun test tests/memory/a.test.ts", "bun test tests/memory --test-name-pattern tiny", "pytest tests/memory -k tiny"])("%s records narrowed verification", command => {
    expect(checkState(call(1, "bash", { command }))).toBe("narrowed")
  })
  test("relevant changes invalidate results; unrelated paths do not; an earlier in-flight check stays stale", () => {
    const checked = call(1, "bash", { command: "bun test tests/memory" })
    expect(checkState([...checked, event(3, "agent.mutation-observed", { basis: "observed", mutated: true, paths: ["README.md"] })])).toBe("narrowed")
    const changed = [...checked, event(3, "agent.mutation-observed", { basis: "observed", mutated: true, paths: ["src/memory.ts"] })]
    expect(checkState(changed)).toBe("stale")
    expect(checkState([...checked, ...call(3, "apply_patch", { input: "*** Begin Patch\n*** Update File: README.md\n*** Move to: src/memory.ts\n*** End Patch" })])).toBe("stale")
    expect(checkState(changed, 2)).toBe("narrowed")
    expect(checkState([...changed, ...call(4, "bash", { command: "bun test tests/memory" })])).toBe("narrowed")
    expect(checkState([checked[0]!, event(2, "agent.mutation-observed", { basis: "observed", mutated: true }), { ...checked[1]!, sequence: 3 }])).toBe("stale")
  })
  test("recorded commands leave a goal partial however many of its checks they match", () => {
    expect(goals(call(1, "bash", { command: "bun test tests/memory" }))[0]!.state).toBe("narrowed")
    expect(goals([...call(1, "bash", { command: "bun test tests/memory" }), ...call(3, "bash", { command: "bun run check //memory:review" })])[0]!.state).toBe("narrowed")
  })
  test.each(["./src/memory.ts", "src/../src/memory.ts", "/workspace/src/memory.ts", "src\\memory.ts"])("a changed path spelled %s cannot retain a passing check", path => {
    expect(checkState([...call(1, "bash", { command: "bun test tests/memory" }),
      event(3, "agent.mutation-observed", { basis: "observed", mutated: true, paths: [path] })])).toBe("stale")
  })
  test("native receipts bind the exact plan check, implementation and ancestry", () => {
    const change = CODING_PLAN.changes[0]!, check = change.checks[0]!
    const implementation = { change: change.id, parent: CODING_PLAN.base, head: CODING_PLAN.base, atoms: [CODING_PLAN.base], reads: [], writes: ["src/memory.ts"] }
    const receipt = { checkId: check.id, target: check.target, tier: check.tier, change: change.id, commitId: implementation.head.commitId,
      treeId: implementation.head.treeId, inputDigest: checkInputDigest(implementation, check), status: "passed", evidence: "", findings: [] }
    const recorded = (value = receipt, parent = "correct") => [...preparedCodingJournal(),
      codingDecision(6, "check", "coding/CommandCheck", { parent, input: { flow: check.flow, input: { implementation, check } }, status: "completed", value })]
    const state = (records: ReadonlyArray<JournalRecord>, cursor?: number) => traceGoals(model(records), CODING_PLAN, cursor)[0]!.checks[0]!.state
    expect(state(recorded())).toBe("passed")
    expect(state(recorded(), 5)).toBe("pending")
    expect(state(recorded({ ...receipt, inputDigest: "other" }))).toBe("pending")
    expect(state(recorded(receipt, "unrelated"))).toBe("pending")
    expect(state(recorded({ ...receipt, status: "failed" }))).toBe("failed")
    expect(state(recorded({ ...receipt, status: "superseded" }))).toBe("stale")
    const started = [...preparedCodingJournal(), codingDecision(6, "check", "coding/CommandCheck", {
      parent: "correct", status: "running", input: { flow: check.flow, input: { implementation, check } }
    })]
    expect(state(started)).toBe("running")
    expect(state([...started, codingDecision(7, "check", "coding/CommandCheck", {
      parent: "correct", status: "failed", input: { flow: check.flow, input: { implementation, check } }
    })])).toBe("failed")
    expect(state([...recorded(), codingDecision(7, "implementation", "coding/ImplementAtoms", {
      parent: "correct", status: "completed", value: { ...implementation, head: { ...implementation.head, treeId: "new-tree" } }
    })])).toBe("stale")
    const concurrent = [...started, event(7, "agent.mutation-observed", { basis: "observed", mutated: true }),
      codingDecision(8, "check", "coding/CommandCheck", { parent: "correct", status: "completed", input: { flow: check.flow, input: { implementation, check } }, value: receipt })]
    expect(state(concurrent)).toBe("stale")
  })
  test("a goal is verified only when every required check carries its own matching receipt", () => {
    const change = CODING_PLAN.changes[0]!
    const implementation = { change: change.id, parent: CODING_PLAN.base, head: CODING_PLAN.base, atoms: [CODING_PLAN.base], reads: [], writes: ["src/memory.ts"] }
    const receipt = (check: (typeof change.checks)[number]) => ({
      checkId: check.id, target: check.target, tier: check.tier, change: change.id, commitId: implementation.head.commitId,
      treeId: implementation.head.treeId, inputDigest: checkInputDigest(implementation, check), status: "passed", evidence: "", findings: []
    })
    const checked = (...bound: ReadonlyArray<readonly [(typeof change.checks)[number], string]>) => [...preparedCodingJournal(),
      ...bound.map(([check, flow], index) => codingDecision(6 + index, `check-${check.id}`, "coding/CommandCheck", {
        parent: "correct", status: "completed", input: { flow, input: { implementation, check } }, value: receipt(check)
      }))]
    const goal = (records: ReadonlyArray<JournalRecord>) => traceGoals(model(records), CODING_PLAN)[0]!
    const [types, review] = change.checks
    expect(goal(checked([types!, types!.flow])).state).toBe("pending")
    expect(goal(checked([types!, types!.flow], [review!, review!.flow])).checks.map(check => check.state)).toEqual(["passed", "passed"])
    expect(goal(checked([types!, types!.flow], [review!, review!.flow])).state).toBe("passed")
    // The wrapper names the flow the check declared, or the receipt is not this check's.
    expect(goal(checked([types!, review!.flow], [review!, review!.flow])).checks.map(check => check.state)).toEqual(["pending", "passed"])
  })
  test("test selections, declaration-only mutations, and explicit narrowing preserve the evidence boundary", () => {
    const passed = call(1, "test", { selection: ["tests/memory"] })
    expect(checkState(passed)).toBe("narrowed")
    expect(checkState(call(1, "test", { selection: ["tests/memory/single.test.ts"] }))).toBe("narrowed")
    expect(checkState(call(1, "test", { selection: ["tests/memory"] }, { exitCode: 0, parsed: true, passed: 0, failed: [] }))).toBe("pending")
    expect(checkState(call(1, "bash", { command: "bun test tests/memory" }, { exitCode: 0, invalidProbe: {} }))).toBe("failed")
    expect(checkState([...passed, event(3, "agent.mutation-observed", { basis: "declared", mutated: true })])).toBe("narrowed")
    expect(checkState([...passed, event(3, "agent.narrowed-demanded", { flow: "test", broader: { selection: ["tests/memory"] }, narrower: { selection: ["tests/memory/one"] } })])).toBe("narrowed")
  })
  test("a baseline comparison uses the workspace result and unknown runner options make no scope claim", () => {
    expect(checkState(call(1, "test", { selection: ["tests/memory"], against: "base" }, { exitCode: 1, base: { exitCode: 0 } }))).toBe("failed")
    expect(checkState(call(1, "bash", { command: "bun test tests/memory --unknown-option" }))).toBe("pending")
    expect(checkState(call(1, "bash", { command: "bun test tests/memory --help" }))).toBe("pending")
  })
})

import * as AgentEvent from "@smthrs/harness/AgentEvent"
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setImmediate } from "node:timers/promises"
import * as Credit from "../src/credit.vibe"
import type * as Host from "../src/host.ts"
import * as RunCard from "../src/run-card.ts"
import * as Session from "../src/session.ts"
import * as Transcript from "../src/transcript.ts"
import { type Tab, Workspace } from "../src/workspace.ts"
import * as Wrapped from "../src/wrapped.ts"

const failover = (to = "openai:gpt-6-luna", code: AgentEvent.SeatFailedOver["code"] = "rate_limited") =>
  new AgentEvent.SeatFailedOver({
    eventType: "flows.harness.seat-failed-over.v1",
    from: "openai:gpt-6.1-sol",
    to,
    code
  })
const tab: Tab = {
  id: "fix",
  title: "Fix",
  prompt: "Fix",
  depth: 0,
  file: "fixture",
  seat: "openai:gpt-6.1-sol",
  activeSeat: "openai:gpt-6-luna",
  status: "running",
  startedAt: 1
}
const selected = new AgentEvent.ModelSelected({
  eventType: "flows.harness.model-selected.v1",
  seat: "openai:gpt-6-luna"
})
test("only typed failover sets the card notice; selection, seat differences and note text cannot fabricate it", () => {
  const history = Transcript.apply(Transcript.note(Transcript.empty, "↪ switched to claude", 1), selected, 2)
  expect(RunCard.worker(tab, history, 3).modelSwitch).toBeUndefined()
  const switched = Transcript.apply(history, failover(), 4)
  expect(RunCard.worker(tab, switched, 5).modelSwitch).toBe("↪ switched to GPT-6 Luna")
  const later = Transcript.apply(switched, failover("anthropic:claude"), 6)
  expect(RunCard.worker(tab, later, 7).modelSwitch).toBe("↪ switched to claude")
  expect(later.items.filter((item) => item.kind === "note").map((item) => item.text)).toEqual([
    "↪ switched to claude",
    "↪ switched to GPT-6 Luna",
    "↪ switched to claude"
  ])
})
test.each(["done", "failed", "cancelled"] as const)(
  "%s keeps the last actual switch without changing the outcome",
  (status) => {
    const history = Transcript.apply(Transcript.empty, failover(), 2)
    const card = RunCard.worker({ ...tab, status, endedAt: 4, answer: "Answer" }, history, 9)
    expect(card.modelSwitch).toBe("↪ switched to GPT-6 Luna")
    expect(card.outcome).toBe(RunCard.worker({ ...tab, status, endedAt: 4 }, Transcript.empty, 9).outcome)
    expect(card.answer).toBe("Answer")
    expect(card.duration).toBe("3ms")
  }
)
test("steering preserves a switch; a new turn clears it but retains the worker's historical note", () => {
  const switched = Transcript.apply(Transcript.user(Transcript.empty, "First", false, 1), failover(), 2)
  const steered = Transcript.user(switched, "Steer", true, 3)
  expect(steered.modelSwitch).toBe(switched.modelSwitch)
  const next = Transcript.user(steered, "Continue", false, 4)
  expect(next.modelSwitch).toBeUndefined()
  expect(next.items).toContainEqual({ kind: "note", id: "1", at: 2, text: "↪ switched to GPT-6 Luna" })
})
test("terminal credit copy is shared with the worker view; timed refusal does not claim exhausted credit or price", () => {
  const terminal = Transcript.apply(Transcript.empty, failover("openai:gpt-6-luna", "out_of_credit"), 2)
  expect(terminal.modelSwitch).toBe(Credit.notice("openai:gpt-6.1-sol", "openai:gpt-6-luna"))
  expect(terminal.items[0]).toMatchObject({ kind: "note", text: terminal.modelSwitch })
  const timed = Transcript.apply(
    terminal,
    new AgentEvent.SeatFailedOver({
      ...failover("anthropic:claude", "quota_exceeded"),
      resetAtEpochMillis: 10000
    }),
    3
  )
  expect(timed.modelSwitch).toBe("↪ switched to claude")
})

let root: string
let previousSessions: string | undefined
let workspaces: Array<Workspace>
let controls: Array<ReturnType<typeof Promise.withResolvers<Host.Outcome>>>
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "tui-switch-lifecycle-"))
  previousSessions = process.env.SMITHERS_TUI_SESSION_DIR
  process.env.SMITHERS_TUI_SESSION_DIR = join(root, "sessions")
  workspaces = []
  controls = []
})
afterEach(async () => {
  workspaces.forEach((workspace) => workspace.dispose())
  controls.forEach((done) => done.resolve({ _tag: "cancelled" }))
  await setImmediate()
  if (previousSessions === undefined) delete process.env.SMITHERS_TUI_SESSION_DIR
  else process.env.SMITHERS_TUI_SESSION_DIR = previousSessions
  rmSync(root, { recursive: true, force: true })
})
const fixture = (restored?: ConstructorParameters<typeof Workspace>[0]["restored"], credit?: Credit.Ledger) => {
  const inputs: Array<Host.TurnInput> = []
  const done: Array<ReturnType<typeof Promise.withResolvers<Host.Outcome>>> = []
  const records: Array<Session.Record> = []
  const host: Host.Host = {
    cwd: root,
    judged: false,
    credit,
    dispose: async () => {},
    run: (input) => {
      inputs.push(input)
      const control = Promise.withResolvers<Host.Outcome>()
      controls.push(control)
      done.push(control)
      return { done: control.promise, cancel: () => control.resolve({ _tag: "cancelled" }) }
    }
  }
  const workspace = new Workspace({
    host,
    workerSeat: tab.seat,
    chatSeat: () => "cerebras:qwen-3.8-27b",
    history: () => [],
    persist: (r) => records.push(r),
    restored
  })
  workspaces.push(workspace)
  const current = () => workspace.snapshot().tabs.find((item) => item.id === "fix")!
  const card = () => RunCard.worker(current(), workspace.transcript("fix"), Date.now())
  return { workspace, inputs, done, records, current, card }
}
const request = { id: "fix", title: "Fix", prompt: "Fix" }
test("existing Session event records replay the exact notice, including legacy plain events and new turn boundaries", () => {
  const writer = Session.create(root, "worker")
  writer.append({ type: "user", at: 1, text: "Fix" })
  writer.append({ type: "event", at: 2, event: failover() })
  writer.append({ type: "note", at: 3, text: "↪ switched to forged" })
  // Plain JSON events are what existing session files contain.
  writer.append({ type: "event", at: 4, event: JSON.parse(JSON.stringify(failover("anthropic:claude"))) })
  writer.append({ type: "outcome", at: 5, prompt: "Fix", outcome: { _tag: "done", answer: "Fixed" } })
  const loaded = Session.load(writer.file)
  expect(loaded.some((record) => "modelSwitch" in record)).toBe(false)
  const replay = Session.restore(loaded).transcript
  expect(RunCard.worker({ ...tab, status: "done", answer: "Fixed" }, replay, 9).modelSwitch).toBe(
    "↪ switched to claude"
  )
  writer.append({ type: "user", at: 6, text: "Next" })
  expect(Session.restore(Session.load(writer.file)).transcript.modelSwitch).toBeUndefined()
})
test.each([false, true] as const)(
  "a restored continuation reads only its own records; switch in this execution: %s",
  (switched) => {
    const writer = Session.create(root, "worker")
    writer.append({ type: "user", at: 1, text: "Fix" })
    writer.append({ type: "event", at: 2, event: failover() })
    writer.append({ type: "outcome", at: 3, prompt: "Fix", outcome: { _tag: "done", answer: "Fixed" } })
    // The continuation's own turn starts here, so the seeded switch is not its own.
    writer.append({ type: "user", at: 4, text: "Next" })
    if (switched) writer.append({ type: "event", at: 5, event: failover("anthropic:claude") })
    writer.append({ type: "outcome", at: 6, prompt: "Next", outcome: { _tag: "done", answer: "Next answer" } })
    const f = fixture({
      tabs: [{
        ...tab,
        status: "done",
        answer: "Next answer",
        endedAt: 7,
        file: writer.file,
        continuedFrom: 3
      }],
      panels: []
    })
    expect(f.card().modelSwitch).toBe(switched ? "↪ switched to claude" : undefined)
    expect(f.card().answer).toBe("Next answer")
    // The seeded switch keeps its line in the worker's own view either way.
    expect(f.workspace.transcript("fix").items.filter((item) => item.kind === "note").map((item) => item.text))
      .toEqual(switched ? ["↪ switched to GPT-6 Luna", "↪ switched to claude"] : ["↪ switched to GPT-6 Luna"])
  }
)
test.each(["continue", "retry", "request"] as const)(
  "%s clears a prior switch before launch, after settlement, and after restore",
  async (action) => {
    const f = fixture()
    f.workspace.request(request)
    await setImmediate()
    f.inputs[0]!.onEvent(failover())
    expect(f.card().modelSwitch).toBe("↪ switched to GPT-6 Luna")
    f.done[0]!.resolve(action === "continue" ? { _tag: "done", answer: "Fixed" } : { _tag: "cancelled" })
    await setImmediate()
    const settled = fixture(f.workspace.snapshot())
    expect(settled.card().modelSwitch).toBe("↪ switched to GPT-6 Luna")
    settled.workspace.dispose()
    if (action === "continue") f.workspace.continue("fix", "Next")
    else if (action === "retry") f.workspace.retry("fix")
    else f.workspace.request({ ...request, prompt: "New task" })
    expect(f.card().modelSwitch).toBeUndefined()
    // Persisted pending attempt must also exclude seeded history, before it launches.
    const pending = fixture(f.workspace.snapshot())
    expect(pending.card().modelSwitch).toBeUndefined()
    pending.workspace.dispose()
    await setImmediate()
    expect(f.card().modelSwitch).toBeUndefined()
    f.inputs[1]!.onEvent(selected)
    expect(f.card().modelSwitch).toBeUndefined()
    f.inputs[1]!.onEvent(failover("anthropic:claude"))
    expect(f.card().modelSwitch).toBe("↪ switched to claude")
    f.done[1]!.resolve({ _tag: "done", answer: "Next answer" })
    await setImmediate()
    const restored = fixture(f.workspace.snapshot())
    expect(restored.card().modelSwitch).toBe("↪ switched to claude")
    expect(restored.card().answer).toBe("Next answer")
    expect(restored.workspace.transcript("fix").items.filter((item) => item.kind === "note").map((item) => item.text))
      .toEqual(action === "request" ? ["↪ switched to claude"] : ["↪ switched to GPT-6 Luna", "↪ switched to claude"])
  }
)

test("queued continuation and its persisted restore cannot show the previous execution's switch", async () => {
  const f = fixture()
  f.workspace.request(request)
  await setImmediate()
  f.inputs[0]!.onEvent(failover())
  f.done[0]!.resolve({ _tag: "done", answer: "Fixed" })
  await setImmediate()
  for (let index = 0; index < 6; index++) f.workspace.request({ ...request, id: `blocker-${index}` })
  await setImmediate()
  expect(f.workspace.continue("fix", "Next").status).toBe("queued")
  expect(f.card().modelSwitch).toBeUndefined()
  const pending = fixture(f.workspace.snapshot())
  expect(pending.card().modelSwitch).toBeUndefined()
  pending.workspace.dispose()
  f.done[1]!.resolve({ _tag: "done", answer: "Slot freed" })
  await setImmediate()
  expect(f.current().status).toBe("running")
  expect(f.card().modelSwitch).toBeUndefined()
  expect(f.inputs.at(-1)!.prompt).toBe("Next")
})

test("a failed preparation after a switch remains clear after restore, even without a new user event", async () => {
  const f = fixture()
  f.workspace.request(request)
  await setImmediate()
  f.inputs[0]!.onEvent(failover())
  f.done[0]!.resolve({ _tag: "cancelled" })
  await setImmediate()
  f.workspace.retry("fix")
  const pending = f.current()
  // A preparation can fail before launch writes the next user event.
  f.workspace.dispose()
  Session.reopen(pending.file).append({
    type: "outcome",
    at: Date.now(),
    prompt: "Fix",
    outcome: { _tag: "failed", message: "Agent unavailable", headline: "Agent unavailable" }
  })
  const restored = fixture({ ...f.workspace.snapshot(), tabs: [{ ...pending, status: "failed" }] })
  expect(restored.card().modelSwitch).toBeUndefined()
  expect(restored.card().outcome).toContain("failed:")
  expect(
    restored.workspace.transcript("fix").items.some((item) => item.kind === "note" && item.text.includes("switched"))
  )
    .toBe(true)
})

test("restoring an interrupted execution retains its note in the worker view and clears the card on relaunch", async () => {
  const f = fixture()
  f.workspace.request(request)
  await setImmediate()
  f.inputs[0]!.onEvent(failover())
  const snapshot = f.workspace.snapshot()
  f.workspace.dispose()
  const restored = fixture(snapshot)
  expect(restored.card().modelSwitch).toBe("↪ switched to GPT-6 Luna")
  await setImmediate()
  expect(restored.card().modelSwitch).toBeUndefined()
  expect(restored.inputs[0]!.seat).toBe(tab.seat)
  expect(
    restored.workspace.transcript("fix").items.some((item) => item.kind === "note" && item.text.includes("switched"))
  )
    .toBe(true)
  restored.inputs[0]!.onEvent(failover("anthropic:claude"))
  expect(restored.card().modelSwitch).toBe("↪ switched to claude")
})

const spentCredit = () => {
  const credit = Credit.make([{ seat: "cerebras:qwen-3.8-27b", label: "Chosen Qwen", provider: "Cerebras" }])
  credit.spend(tab.seat)
  return credit
}
test("the real pre-launch stand-in persists its actual target and one shared notice, then a typed failover supersedes it", async () => {
  const credit = spentCredit()
  const f = fixture(undefined, credit)
  f.workspace.request(request)
  await setImmediate()
  const notice = credit.notice(tab.seat, "cerebras:qwen-3.8-27b")
  expect(f.inputs[0]!.seat).toBe("cerebras:qwen-3.8-27b")
  expect(f.inputs[0]!.fallbackSeats).toEqual([])
  expect(f.card().modelSwitch).toBe(notice)
  const records = Session.load(f.current().file)
  expect(records.filter((r) => r.type === "credit-substitution")).toEqual([{
    type: "credit-substitution",
    at: expect.any(Number),
    from: tab.seat,
    to: "cerebras:qwen-3.8-27b",
    text: notice
  }])
  expect(records.findIndex((r) => r.type === "user")).toBeLessThan(
    records.findIndex((r) => r.type === "credit-substitution")
  )
  expect(records.some((r) => r.type === "note" && r.text === notice)).toBe(false)
  expect(records.some((r) => r.type === "event" && r.event._tag === "seat-failed-over")).toBe(false)
  const restored = Session.restore(records).transcript
  expect(restored.modelSwitch).toBe(notice)
  expect(restored.items.filter((item) => item.kind === "note")).toEqual([
    { kind: "note", id: "1", at: expect.any(Number), text: notice }
  ])
  f.inputs[0]!.onEvent(
    new AgentEvent.SeatFailedOver({
      ...failover(),
      from: "cerebras:qwen-3.8-27b"
    })
  )
  expect(f.card().modelSwitch).toBe("↪ switched to GPT-6 Luna")
  f.done[0]!.resolve({ _tag: "done", answer: "Fixed" })
  await setImmediate()
  const settled = fixture(f.workspace.snapshot())
  expect(settled.card().modelSwitch).toBe("↪ switched to GPT-6 Luna")
  expect(settled.workspace.transcript("fix").items.filter((item) => item.kind === "note").map((item) => item.text))
    .toEqual([notice, "↪ switched to GPT-6 Luna"])
})
test.each(["continue", "retry", "request"] as const)(
  "%s clears a pre-launch stand-in live and after restore without losing old history",
  async (action) => {
    const credit = spentCredit()
    const f = fixture(undefined, credit)
    f.workspace.request(request)
    await setImmediate()
    const notice = credit.notice(tab.seat, "cerebras:qwen-3.8-27b")
    expect(f.card().modelSwitch).toBe(notice)
    f.done[0]!.resolve(action === "continue" ? { _tag: "done", answer: "Fixed" } : { _tag: "cancelled" })
    await setImmediate()
    const before = fixture(f.workspace.snapshot())
    expect(before.card().modelSwitch).toBe(notice)
    before.workspace.dispose()
    if (action === "continue") f.workspace.continue("fix", "Next")
    else if (action === "retry") f.workspace.retry("fix")
    else f.workspace.request({ ...request, prompt: "New", model: "cerebras:qwen-3.8-27b" })
    expect(f.card().modelSwitch).toBeUndefined()
    const pending = fixture(f.workspace.snapshot())
    expect(pending.card().modelSwitch).toBeUndefined()
    pending.workspace.dispose()
    await setImmediate()
    expect(f.inputs[1]!.seat).toBe("cerebras:qwen-3.8-27b")
    expect(f.card().modelSwitch).toBeUndefined()
    f.done[1]!.resolve({ _tag: "done", answer: "Next" })
    await setImmediate()
    const after = fixture(f.workspace.snapshot())
    expect(after.card().modelSwitch).toBeUndefined()
    expect(after.workspace.transcript("fix").items.filter((item) => item.kind === "note").map((item) => item.text))
      .toEqual(action === "request" ? [] : [notice])
  }
)
test("a continuation that is replaced again shows its own stand-in, live and restored past the seeded one", async () => {
  // The stand-in's own account refuses before the next turn, so the continuation replaces it again:
  // the only case where a persisted replacement must be read through the continuation boundary.
  const credit = Credit.make([
    { seat: "cerebras:qwen-3.8-27b", label: "Chosen Qwen", provider: "Cerebras" },
    { seat: "anthropic:claude-opus-5", label: "Chosen Opus", provider: "Anthropic" }
  ])
  credit.spend(tab.seat)
  const f = fixture(undefined, credit)
  f.workspace.request(request)
  await setImmediate()
  const first = credit.notice(tab.seat, "cerebras:qwen-3.8-27b")
  expect(f.inputs[0]!.seat).toBe("cerebras:qwen-3.8-27b")
  expect(f.card().modelSwitch).toBe(first)
  f.done[0]!.resolve({ _tag: "done", answer: "Fixed" })
  await setImmediate()
  credit.spend("cerebras:qwen-3.8-27b")
  credit.answered("anthropic:claude-opus-5")
  f.workspace.continue("fix", "Next")
  expect(f.card().modelSwitch).toBeUndefined()
  await setImmediate()
  const second = credit.notice("cerebras:qwen-3.8-27b", "anthropic:claude-opus-5")
  expect(second).not.toBe(first)
  expect(f.inputs[1]!.seat).toBe("anthropic:claude-opus-5")
  expect(f.card().modelSwitch).toBe(second)
  f.done[1]!.resolve({ _tag: "done", answer: "Next answer" })
  await setImmediate()
  const restored = fixture(f.workspace.snapshot(), credit)
  expect(restored.card().modelSwitch).toBe(second)
  expect(restored.card().answer).toBe("Next answer")
  // Both replacements stay in the worker's own view; only the latest one of this turn reaches the card.
  expect(restored.workspace.transcript("fix").items.filter((item) => item.kind === "note").map((item) => item.text))
    .toEqual([first, second])
  expect(
    Session.load(restored.current().file).flatMap((record) => record.type === "credit-substitution" ? [record.to] : [])
  ).toEqual(["cerebras:qwen-3.8-27b", "anthropic:claude-opus-5"])
})
test("legacy stand-in-looking notes remain visible history without becoming trusted metadata", () => {
  const writer = Session.create(root, "worker")
  // Old launch wrote its arbitrary note before its user record.
  const text = Credit.notice(tab.seat, "cerebras:qwen-3.8-27b")
  writer.append({ type: "note", at: 1, text })
  writer.append({ type: "user", at: 1, text: "Fix" })
  writer.append({ type: "outcome", at: 2, prompt: "Fix", outcome: { _tag: "done", answer: "Fixed" } })
  const restored = Session.restore(Session.load(writer.file)).transcript
  expect(restored.items[0]).toMatchObject({ kind: "note", text })
  expect(restored.modelSwitch).toBeUndefined()
  expect(restored.items.filter((item) => item.kind === "note")).toHaveLength(1)
})
test.each(["healthy", "no replacement", "pinned", "replay"] as const)(
  "%s starts without fabricating a credit substitution",
  async (mode) => {
    const credit = mode === "healthy" ? Credit.make([]) : spentCredit()
    if (mode === "no replacement") credit.spend("cerebras:qwen-3.8-27b")
    const f = fixture(undefined, credit)
    f.workspace.request({
      ...request,
      ...(mode === "pinned" ? { pinned: true, model: "sol" } : {}),
      ...(mode === "replay" ? { model: "replay:one" } : {})
    })
    await setImmediate()
    expect(f.inputs[0]!.seat).toBe(mode === "replay" ? "replay:one" : tab.seat)
    expect(f.card().modelSwitch).toBeUndefined()
    expect(Session.load(f.current().file).some((r) => r.type === "credit-substitution")).toBe(false)
    expect(f.workspace.transcript("fix").items.some((item) => item.kind === "note" && item.text.startsWith("↪"))).toBe(
      false
    )
  }
)
test("wrapped harnesses keep their own execution and never select a credit stand-in", async () => {
  const credit = spentCredit()
  const instead = spyOn(credit, "instead")
  const done = Promise.withResolvers<Wrapped.Outcome>()
  const run = spyOn(Wrapped, "run").mockImplementation(() => ({
    done: done.promise,
    stop: () => done.resolve({ _tag: "stopped" })
  }))
  const f = fixture(undefined, credit)
  try {
    f.workspace.request({ ...request, harness: "codex" })
    await setImmediate()
    expect(run).toHaveBeenCalledTimes(1)
    expect(instead).not.toHaveBeenCalled()
    expect(f.inputs).toHaveLength(0)
    expect(f.card().modelSwitch).toBeUndefined()
    expect(Session.load(f.current().file).some((r) => r.type === "credit-substitution")).toBe(false)
  } finally {
    f.workspace.dispose()
    done.resolve({ _tag: "stopped" })
    await setImmediate()
    run.mockRestore()
    instead.mockRestore()
  }
})

import type * as Audience from "@smthrs/build-cli/Audience"
import type { ControlSchema } from "@smthrs/control"
import { Cause, Effect, Exit, Fiber, Stream } from "effect"
import { Writable } from "node:stream"
import { stripVTControlCharacters } from "node:util"
import { describe, expect, it, vi } from "vitest"
import * as RunProgress from "../src/cli/RunProgress.ts"

const policy = (progress: Audience.Policy["progress"]): Audience.Policy => ({
  audience: progress === "silent" ? "agent" : "human",
  source: "override",
  harnesses: [],
  structured: true,
  progress,
  interactive: progress === "live"
})

const terminal = () => {
  const chunks: Array<string> = []
  const output = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(String(chunk))
      callback()
    }
  })
  Object.assign(output, { columns: 100, isTTY: true })
  return { output, text: () => stripVTControlCharacters(chunks.join("")) }
}

const event = (
  sequence: number,
  kind: string,
  payload: ControlSchema.ControlEvent["payload"] = {}
): ControlSchema.ControlEvent => ({ sequence, kind, runId: "run-test", occurredAt: sequence, payload })

const events = [
  event(1, "control.run.accepted"),
  event(2, "control.agent.turn-opened", { seat: "test-seat" }),
  event(3, "control.agent.cell-call-started", { flowName: "lint", input: { password: "never display this" } }),
  event(4, "control.agent.cell-printed", { text: "Checking source files\nAll files checked" }),
  event(5, "control.agent.cell-call-settled", { flowName: "lint", outcome: "success", value: "large task output" }),
  event(6, "control.run.completed")
]

describe("durable run progress projection", () => {
  it("upgrades telemetry to native call facts without double counting or retaining an incorrect outcome", () => {
    const callId = `cell-call-v1:${"a".repeat(64)}`
    const telemetry = [
      event(1, "control.agent.cell-call-started", { callId, flowName: "lint" }),
      event(2, "control.agent.cell-call-settled", { callId, flowName: "lint", outcome: "success" })
    ]
    const native = (phase: "invoked" | "settled") =>
      event(3, "control.engine.event", {
        version: 1,
        executionId: "native",
        generation: 0,
        sequence: 3,
        emittedAtMs: 30,
        sourceSequence: 0,
        sourceId: `call-fact-v1:${callId}:${phase}`,
        eventType: "flows.harness.call-fact.v1",
        payload: {
          version: 1,
          phase,
          callId,
          identity: { runId: "run-test", frame: 0, cell: "cell", ordinal: 0, declaration: "d", layers: [] },
          flowName: "lint",
          ...(phase === "invoked" ? { input: {} } : { outcome: "failure", value: null, message: "timeout" })
        }
      })
    let state = RunProgress.initial()
    for (const input of [...telemetry, native("invoked"), native("settled"), native("settled"), telemetry[1]!]) {
      state = RunProgress.project(state, input).state
    }
    expect(state).toMatchObject({ started: 1, failed: 1, completed: 0, active: [] })
    let onlyFacts = RunProgress.initial()
    for (const input of [native("invoked"), native("settled")]) onlyFacts = RunProgress.project(onlyFacts, input).state
    expect(onlyFacts).toMatchObject({ started: 1, failed: 1, completed: 0, active: [] })
  })

  it("uses call identity for overlapping active calls and counts each lifecycle event once", () => {
    const first = { flowName: "lint", callId: "first" }
    const second = { flowName: "lint", callId: "second" }
    let state = RunProgress.initial()
    const before = state
    for (
      const entry of [
        event(1, "control.agent.cell-call-started", first),
        event(2, "control.agent.cell-call-started", second),
        event(3, "control.agent.cell-call-started", first),
        event(4, "control.agent.cell-call-settled", { ...second, outcome: "failure" })
      ]
    ) state = RunProgress.project(state, entry).state
    expect(state).toMatchObject({ started: 2, failed: 1, completed: 0, active: ["lint"], activeCallIds: ["first"] })
    const duplicate = RunProgress.project(
      state,
      event(5, "control.agent.cell-call-settled", { ...second, outcome: "failure" })
    )
    expect(duplicate).toEqual({ state, lines: [] })
    const done = RunProgress.project(
      state,
      event(6, "control.agent.cell-call-settled", { ...first, outcome: "success" })
    )
    expect(done.state).toMatchObject({ started: 2, failed: 1, completed: 1, active: [], activeCallIds: [] })
    expect(before).toEqual(RunProgress.initial())
  })

  it("keeps identified active calls when an unknown or legacy settlement arrives", () => {
    let state = RunProgress.project(
      RunProgress.initial(),
      event(1, "control.agent.cell-call-started", { flowName: "lint", callId: "first" })
    ).state
    state = RunProgress.project(
      state,
      event(2, "control.agent.cell-call-settled", { flowName: "lint", callId: "unknown", outcome: "success" })
    ).state
    state = RunProgress.project(
      state,
      event(3, "control.agent.cell-call-settled", { flowName: "lint", outcome: "success" })
    ).state
    expect(state.activeCallIds).toEqual(["first"])
    expect(state.active).toEqual(["lint"])
  })

  it("prints the recorded provider cause when an attached run fails", () => {
    const result = RunProgress.project(
      RunProgress.initial(),
      event(1, "control.run.failed", {
        cause: "quota_exceeded: Add credits to continue.\nError: wrapper"
      })
    )
    expect(result.state.status).toBe("Failed")
    expect(result.lines).toEqual([{ level: "info", text: "quota_exceeded: Add credits to continue." }])
  })
  it.each(
    [
      ["control.run.running", "Starting run", false],
      ["control.run.resumed", "Starting run", false],
      ["control.agent.model-settled", "Preparing tasks", false],
      ["control.run.pending", "Pending · executor did not start", true],
      ["control.run.cancelled", "Cancelled", true]
    ] as const
  )("projects %s without discarding existing task counts", (kind, status, settled) => {
    const state = { ...RunProgress.initial(), started: 3, completed: 1 }
    const result = RunProgress.project(state, event(10, kind))
    expect(result.state).toEqual({ ...state, status, settled })
    expect(result.lines).toEqual([])
  })

  it("does not invent task counts or text from missing or non-record event metadata", () => {
    for (const payload of [null, [], "not a record"]) {
      const result = RunProgress.project(RunProgress.initial(), event(1, "flows.engine.plan-recorded", payload))
      expect(result.lines).toEqual([{ level: "step", text: "Plan recorded" }])
      expect(result.state.started).toBe(0)
    }
    const turn = RunProgress.project(RunProgress.initial(), event(2, "control.agent.turn-opened"))
    expect(turn.lines).toEqual([{ level: "step", text: "Turn 1" }])
    const ignored = RunProgress.project(turn.state, event(3, "control.agent.cell-printed", { text: 42 }))
    expect(ignored).toEqual({ state: turn.state, lines: [] })
    expect(RunProgress.project(turn.state, event(4, "unrelated.event"))).toEqual({ state: turn.state, lines: [] })
  })

  it("keeps retry counts stable when a label has fallen outside the bounded active window", () => {
    let state = RunProgress.initial()
    for (let index = 0; index < 9; index++) {
      state = RunProgress.project(
        state,
        event(index, "flows.engine.node-scheduled", {
          nodeId: `task-${index}`,
          attempt: 1
        })
      ).state
    }
    expect(state.active).not.toContain("task-0")
    const retried = RunProgress.project(
      state,
      event(10, "flows.engine.node-scheduled", { nodeId: "task-0", attempt: 2 })
    )
    expect(retried.state.started).toBe(9)
    expect(retried.state.active).toHaveLength(8)
    expect(retried.state.active.at(-1)).toBe("task-0")
    expect(retried.lines).toEqual([{ level: "step", text: "Retrying task-0" }])
    const deferred = RunProgress.project(
      retried.state,
      event(11, "flows.engine.node-settled", {
        nodeId: "task-0",
        outcome: "deferred"
      })
    )
    expect(deferred.state).toMatchObject({ started: 9, completed: 0, failed: 0, skipped: 1 })
    expect(deferred.state.active).not.toContain("task-0")
    expect(deferred.lines).toEqual([{ level: "warn", text: "task-0 skipped" }])
  })

  it("shows every task lifecycle but keeps inputs, generated code, and complete results out of progress", () => {
    let state = RunProgress.initial()
    const lines: Array<string> = []
    for (const item of events) {
      const next = RunProgress.project(state, item)
      state = next.state
      lines.push(...next.lines.map((line) => line.text))
    }
    expect(state).toMatchObject({ turns: 1, started: 1, completed: 1, failed: 0, active: [], settled: true })
    expect(lines.join("\n")).toContain("Running lint")
    expect(lines.join("\n")).toContain("lint completed")
    expect(lines.join("\n")).toContain("Checking source files")
    expect(lines.join("\n")).not.toContain("never display this")
    expect(lines.join("\n")).not.toContain("large task output")
    expect(RunProgress.project(state, event(7, "control.agent.cell-produced", { text: "private code" })).lines)
      .toEqual([])
  })

  it("bounds retained task labels and log excerpts, strips terminal instructions, and redacts credentials", () => {
    let state = RunProgress.initial()
    for (let i = 0; i < 500; i++) {
      state = RunProgress.project(state, event(i, "control.agent.cell-call-started", { flowName: `task-${i}` })).state
    }
    expect(state.active).toHaveLength(8)
    expect(state.started).toBe(500)
    const result = RunProgress.project(
      state,
      event(501, "control.agent.cell-printed", {
        text: `\u001b[2JBearer abcdefghijklmnopqrstuvwxyz\u0000\u202e\n${"line\n".repeat(100)}`
      })
    )
    expect(result.lines).toHaveLength(5)
    const rendered = result.lines.map((line) => line.text).join("\n")
    expect(rendered).toContain("[REDACTED_TOKEN]")
    expect(rendered).not.toContain("abcdefghijklmnopqrstuvwxyz")
    expect(rendered).not.toMatch(/[\u001b\u0000\u202e]/)
    expect(result.lines[4]?.text).toContain("more lines saved")
    expect(RunProgress.text("x".repeat(10_000))).toHaveLength(180)
  })

  it("tracks task failures and parks without treating an approval pause as completion", () => {
    const opened = RunProgress.project(RunProgress.initial(), events[2]!).state
    const failed = RunProgress.project(
      opened,
      event(4, "control.agent.cell-call-settled", {
        flowName: "lint",
        outcome: "failure",
        message: "token=secret-token-long"
      })
    )
    expect(failed.state).toMatchObject({ completed: 0, failed: 1, active: [] })
    expect(failed.lines[0]?.level).toBe("error")
    expect(failed.lines[0]?.text).not.toContain("secret-token-long")
    const parked = RunProgress.project(failed.state, event(5, "control.run.waiting-approval"))
    expect(parked.state).toMatchObject({ settled: true, status: "Waiting for approval" })
  })

  it("shows scheduled plan tasks, retries, cache hits, and skipped dependencies", () => {
    let state = RunProgress.initial()
    const lines: Array<string> = []
    for (
      const item of [
        event(1, "flows.engine.plan-recorded", { nodes: 2 }),
        event(2, "flows.engine.node-scheduled", { nodeId: "compile", attempt: 1 }),
        event(3, "flows.engine.node-scheduled", { nodeId: "compile", attempt: 2 }),
        event(4, "flows.engine.node-settled", { nodeId: "compile", outcome: "clean" }),
        event(5, "flows.engine.node-settled", { nodeId: "test", outcome: "skipped" })
      ]
    ) {
      const result = RunProgress.project(state, item)
      state = result.state
      lines.push(...result.lines.map((line) => line.text))
    }
    expect(lines).toEqual([
      "Plan recorded · 2 tasks",
      "Running compile",
      "Retrying compile",
      "compile cached",
      "test skipped"
    ])
    expect(state).toMatchObject({ started: 1, completed: 1, skipped: 1, failed: 0, active: [] })
  })
})

describe("durable run progress lifecycle", () => {
  it("uses the ambient agent policy without an injected configuration or progress output", async () => {
    vi.stubEnv("SMITHERS_AUDIENCE", "agent")
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true)
    let consumed = 0
    try {
      const source = Stream.fromIterable(events).pipe(Stream.tap(() => Effect.sync(() => consumed++)))
      const result = await Effect.runPromise(RunProgress.observe(source, "run-test").pipe(Stream.runCollect))
      expect(Array.from(result)).toEqual(events)
      expect(consumed).toBe(events.length)
      expect(stderr).not.toHaveBeenCalled()
    } finally {
      stderr.mockRestore()
      vi.unstubAllEnvs()
    }
  })

  it("shows human progress on a separate sink even for a structured result, using the original event stream once", async () => {
    const term = terminal()
    let consumed = 0
    const stream = Stream.fromIterable(events).pipe(Stream.tap(() => Effect.sync(() => consumed++)))
    const result = await Effect.runPromise(
      RunProgress.observe(stream, "run-test").pipe(
        Stream.filter((item) => item.kind === "control.run.completed"),
        Stream.take(1),
        Stream.runCollect,
        Effect.provideService(RunProgress.Configuration, { policy: policy("plain"), output: term.output })
      )
    )
    expect(Array.from(result)).toEqual([events[5]])
    expect(consumed).toBe(events.length)
    expect(term.text()).toContain("Running lint")
    expect(term.text()).toContain("Completed · 1 completed")
    expect(term.text()).toContain("smthrs runs output 'run-test'")
  })

  it("agent and explicit silent sessions produce no progress bytes, even with a terminal sink", async () => {
    for (const [progress, silent] of [["silent", false], ["live", true]] as const) {
      const term = terminal()
      await Effect.runPromise(
        RunProgress.observe(Stream.fromIterable(events), "run-test", silent).pipe(
          Stream.runDrain,
          Effect.provideService(RunProgress.Configuration, { policy: policy(progress), output: term.output })
        )
      )
      expect(term.text()).toBe("")
    }
  })

  it("keeps source failures intact and explains how to inspect the persisted run", async () => {
    const term = terminal()
    const result = await Effect.runPromiseExit(
      RunProgress.observe(Stream.concat(Stream.make(events[2]!), Stream.fail("watch unavailable")), "run-test").pipe(
        Stream.runDrain,
        Effect.provideService(RunProgress.Configuration, { policy: policy("plain"), output: term.output })
      )
    )
    expect(Exit.isFailure(result)).toBe(true)
    if (Exit.isFailure(result)) expect(Cause.squash(result.cause)).toBe("watch unavailable")
    expect(term.text()).toContain("Progress stream failed")
    expect(term.text()).toContain("smthrs runs logs 'run-test'")
  })

  it("releases live Clack listeners after settlement and interruption without cancelling the run", async () => {
    const signals = ["SIGINT", "SIGTERM", "exit", "unhandledRejection", "uncaughtExceptionMonitor"] as const
    const before = signals.map((signal) => process.listenerCount(signal))
    const term = terminal()
    const renderer = RunProgress.make("run-test", { policy: policy("live"), output: term.output })
    for (const item of events) renderer.event(item)
    renderer.close("ended")
    renderer.close("ended")
    expect(signals.map((signal) => process.listenerCount(signal))).toEqual(before)
    expect(term.text()).toContain("Completed · 1 completed")

    const interrupted = terminal()
    await Effect.runPromise(Effect.gen(function*() {
      const fiber = yield* RunProgress.observe(Stream.concat(Stream.make(events[2]!), Stream.never), "run-test").pipe(
        Stream.runDrain,
        Effect.provideService(RunProgress.Configuration, { policy: policy("live"), output: interrupted.output }),
        Effect.forkChild
      )
      yield* Effect.sleep(10)
      yield* Fiber.interrupt(fiber)
    }))
    expect(interrupted.text()).toContain("Stopped watching")
    expect(interrupted.text()).not.toContain("Run cancelled")
    expect(signals.map((signal) => process.listenerCount(signal))).toEqual(before)
  })

  it("releases the live indicator if its output closes before the command", () => {
    const term = terminal()
    const before = process.listenerCount("SIGTERM")
    const renderer = RunProgress.make("run-test", { policy: policy("live"), output: term.output })
    term.output.destroy()
    expect(() => renderer.event(events[2]!)).not.toThrow()
    expect(() => renderer.close("interrupted")).not.toThrow()
    expect(process.listenerCount("SIGTERM")).toBe(before)
  })

  it("leaves no live indicator while following a parked or terminal run and starts it again on resume", () => {
    const term = terminal()
    const before = process.listenerCount("SIGTERM")
    const renderer = RunProgress.make("run-test", { policy: policy("live"), output: term.output })
    expect(process.listenerCount("SIGTERM")).toBeGreaterThan(before)
    renderer.event(event(1, "control.run.waiting-approval"))
    expect(process.listenerCount("SIGTERM")).toBe(before)
    expect(term.text()).toContain("Waiting for approval")
    renderer.event(event(2, "control.run.resumed"))
    expect(process.listenerCount("SIGTERM")).toBeGreaterThan(before)
    renderer.event(event(3, "control.run.completed"))
    expect(process.listenerCount("SIGTERM")).toBe(before)
    renderer.close("ended")
    expect(process.listenerCount("SIGTERM")).toBe(before)
    expect(term.text().match(/Completed · 0 completed/g)).toHaveLength(1)
  })
})

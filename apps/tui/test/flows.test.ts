/** Flow runs over a controllable fake Port: persistence, receipts, and settlement only from the watch. */
import { describe, expect, it } from "bun:test"
import { Schema } from "effect"
import { type Card, FlowRuns, type Listed, type Port, type Run, type Settled } from "../src/flows.ts"
import * as Session from "../src/session.ts"

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

interface Pending<A> {
  readonly promise: Promise<A>
  readonly resolve: (value: A) => void
  readonly reject: (error: unknown) => void
}
const pending = <A>(): Pending<A> => {
  let resolve!: (value: A) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<A>((ok, fail) => {
    resolve = ok
    reject = fail
  })
  return { promise, resolve, reject }
}

/** Every method records its call; the test resolves each promise or leaves it pending. */
const fake = (options: { listed?: ReadonlyArray<Listed>; schema?: Schema.Top; refuseCancel?: boolean } = {}) => {
  const calls: Array<string> = []
  const inputs: Array<Pending<Schema.Top | undefined>> = []
  const plans: Array<Pending<Card>> = []
  const starts: Array<Pending<string>> = []
  const resumes: Array<Pending<{ runId: string } | Settled>> = []
  const watches: Array<{ done: Pending<Settled>; emit: (event: unknown) => void }> = []
  const auto = { input: true, plan: true, start: true }
  const listed = options.listed ?? [{ name: "review", description: "Review a change", modelInvocable: true }]
  const port: Port = {
    discover: async () => {
      calls.push("discover")
      return listed
    },
    input: (flow) => {
      calls.push(`input:${flow}`)
      const next = pending<Schema.Top | undefined>()
      inputs.push(next)
      if (auto.input) next.resolve(options.schema)
      return next.promise
    },
    plan: (flow, input) => {
      calls.push(`plan:${flow}:${JSON.stringify(input)}`)
      const next = pending<Card>()
      plans.push(next)
      if (auto.plan) next.resolve({ all: false, raw: {} })
      return next.promise
    },
    start: () => {
      calls.push("start")
      const next = pending<string>()
      starts.push(next)
      if (auto.start) next.resolve(`run-${starts.length}`)
      return next.promise
    },
    resume: (runId) => {
      calls.push(`resume:${runId}`)
      const next = pending<{ runId: string } | Settled>()
      resumes.push(next)
      return next.promise
    },
    watch: (runId, onEvent) => {
      calls.push(`watch:${runId}`)
      const done = pending<Settled>()
      watches.push({ done, emit: (event) => onEvent(event as Parameters<typeof onEvent>[0]) })
      return { done: done.promise, close: () => calls.push(`close:${runId}`) }
    },
    events: async (runId) => {
      calls.push(`events:${runId}`)
      return []
    },
    cancel: async (runId) => {
      calls.push(`cancel:${runId}`)
      if (options.refuseCancel === true) throw new Error("Cancel refused")
    },
    dispose: async () => {}
  }
  return { port, calls, inputs, plans, starts, resumes, watches, auto }
}

const setup = (options: Parameters<typeof fake>[0] & { restored?: ReadonlyArray<Run> } = {}) => {
  const port = fake(options)
  const records: Array<Session.Record> = []
  const runs = new FlowRuns({ port: port.port, persist: (record) => records.push(record), restored: options.restored })
  return { ...port, records, runs }
}

const call = (event: string, nodeId: number) => ({
  sequence: nodeId,
  kind: event,
  runId: "run-1",
  occurredAt: nodeId,
  payload: { flowName: "bash", input: { command: "ls" }, output: "ok", callId: `c${nodeId}` }
})

describe("flow runs", () => {
  it("persists and acknowledges before any port call and deduplicates", () => {
    const f = setup()
    expect(f.runs.request({ id: "r1", flow: "review", input: {}, by: "agent" })).toEqual({ id: "r1", status: "requested" })
    expect(f.records).toHaveLength(1)
    expect(f.records[0]).toMatchObject({ type: "flow", run: { id: "r1", flow: "review", status: "requested" } })
    expect(f.calls).toEqual([])
    expect(f.runs.busy).toBe(true)
    expect(f.runs.request({ id: "r1", flow: "review", input: {}, by: "agent" })).toEqual({ id: "r1", status: "requested" })
    expect(f.records).toHaveLength(1)
    expect(() => f.runs.request({ id: "r1", flow: "review", input: { title: "x" }, by: "agent" })).toThrow("another task")
  })

  it("an unresolved input() keeps it busy, and cancel ignores the stale answer", async () => {
    const f = setup({ schema: Schema.Struct({}) })
    f.auto.input = false
    f.runs.request({ id: "r1", flow: "review", input: {}, by: "user" })
    await tick()
    expect(f.calls).toEqual(["discover", "input:review"])
    expect(f.runs.busy).toBe(true)
    f.runs.cancel("r1")
    expect(f.runs.get("r1")?.status).toBe("cancelled")
    expect(f.runs.busy).toBe(false)
    f.inputs[0]!.resolve(Schema.Struct({}))
    await tick()
    expect(f.calls.some((each) => each.startsWith("plan"))).toBe(false)
    expect(f.runs.get("r1")?.status).toBe("cancelled")
  })

  it("missing required input parks for a form, and fill proceeds to launch", async () => {
    const f = setup({ schema: Schema.Struct({ title: Schema.String }) })
    f.runs.request({ id: "r1", flow: "review", input: {}, by: "user" })
    await tick()
    expect(f.runs.get("r1")).toMatchObject({ status: "input", message: "Needs: Title" })
    expect(f.calls.some((each) => each.startsWith("plan"))).toBe(false)
    expect(f.runs.panel("r1").rows[0]).toMatchObject({ id: "act", label: "Fill in" })
    f.runs.fill("r1", { title: "x" })
    await tick()
    expect(f.calls).toContain(`plan:review:{"title":"x"}`)
    expect(f.calls).toContain("start")
    expect(f.calls).toContain("watch:run-1")
    expect(f.runs.get("r1")).toMatchObject({ status: "running", runId: "run-1", input: { title: "x" } })
    expect(f.records.at(-1)).toMatchObject({ type: "flow", run: { status: "running", runId: "run-1" } })
    expect(f.runs.get("r1")?.endedAt).toBeUndefined()
    expect(f.runs.busy).toBe(true)
  })

  it("a * envelope waits for approval and never auto-approves a model request", async () => {
    const f = setup()
    f.auto.plan = false
    f.runs.request({ id: "r1", flow: "review", input: {}, by: "agent" })
    await tick()
    f.plans[0]!.resolve({ all: true, raw: {} })
    await tick()
    expect(f.runs.get("r1")?.status).toBe("approval")
    expect(f.calls).not.toContain("start")
    expect(f.runs.panel("r1").rows[0]).toMatchObject({ id: "act", label: "Approve" })
    f.runs.approve("r1")
    await tick()
    expect(f.calls).toContain("start")
    expect(f.runs.get("r1")?.status).toBe("running")
  })

  it("settles only from the watch", async () => {
    const f = setup()
    f.runs.request({ id: "r1", flow: "review", input: {}, by: "user" })
    await tick()
    expect(f.runs.get("r1")?.status).toBe("running")
    f.watches[0]!.emit(call("control.agent.cell-call-started", 1))
    f.watches[0]!.emit(call("control.agent.cell-call-settled", 2))
    expect(f.runs.get("r1")?.status).toBe("running")

    const done = setup()
    done.runs.request({ id: "r1", flow: "review", input: {}, by: "user" })
    await tick()
    done.watches[0]!.emit(call("control.agent.cell-call-started", 1))
    done.watches[0]!.done.resolve({ kind: "done", answer: "Looks good." })
    await tick()
    expect(done.runs.get("r1")).toMatchObject({ status: "done", answer: "Looks good." })
    expect(done.runs.get("r1")?.endedAt).toBeNumber()
    const panel = done.runs.panel("r1")
    expect(panel.summary).toBe("Looks good.")
    expect(panel.rows.map((row) => row.label)).toEqual(["bash", "Result"])

    const failed = setup()
    failed.runs.request({ id: "r1", flow: "review", input: {}, by: "user" })
    await tick()
    failed.watches[0]!.done.resolve({ kind: "failed", message: "boom" })
    await tick()
    expect(failed.runs.get("r1")).toMatchObject({ status: "failed", message: "boom" })
    expect(failed.runs.busy).toBe(false)
  })

  it("cancel while running asks the control plane and waits for the watch", async () => {
    const f = setup()
    f.runs.request({ id: "r1", flow: "review", input: {}, by: "user" })
    await tick()
    f.runs.cancel("r1")
    await tick()
    expect(f.calls).toContain("cancel:run-1")
    expect(f.runs.get("r1")?.status).toBe("running")
    f.watches[0]!.done.resolve({ kind: "cancelled" })
    await tick()
    expect(f.runs.get("r1")?.status).toBe("cancelled")
    expect(f.runs.panel("r1").summary).toBe("Stopped.")
  })

  it("a run parked for approval keeps its watch: resumes, and a stop settles it", async () => {
    const f = setup()
    f.runs.request({ id: "r1", flow: "review", input: {}, by: "user" })
    await tick()
    f.watches[0]!.emit(call("control.run.waiting-approval", 1))
    expect(f.runs.get("r1")?.status).toBe("waiting")
    expect(f.runs.busy).toBe(true)
    // Repeated approval events cannot report a resume.
    f.watches[0]!.emit(call("control.run.waiting-approval", 2))
    expect(f.runs.get("r1")?.status).toBe("waiting")
    // Approved elsewhere: the same watch sees the run move on.
    f.watches[0]!.emit(call("control.run.running", 3))
    expect(f.runs.get("r1")?.status).toBe("running")
    f.watches[0]!.emit(call("control.run.waiting-approval", 4))
    expect(f.runs.get("r1")?.status).toBe("waiting")
    f.runs.cancel("r1")
    await tick()
    expect(f.calls).toEqual(["discover", "input:review", "plan:review:{}", "start", "watch:run-1", "cancel:run-1"])
    f.watches[0]!.done.resolve({ kind: "cancelled" })
    await tick()
    expect(f.runs.get("r1")?.status).toBe("cancelled")
    expect(f.runs.busy).toBe(false)
  })

  it("a stop while start is in flight stops the run start launched", async () => {
    const f = setup()
    f.auto.start = false
    f.runs.request({ id: "r1", flow: "review", input: {}, by: "user" })
    await tick()
    expect(f.calls.at(-1)).toBe("start")
    f.runs.cancel("r1")
    expect(f.runs.get("r1")?.status).toBe("cancelled")
    f.starts[0]!.resolve("run-1")
    await tick()
    expect(f.calls).toContain("cancel:run-1")
    expect(f.calls).not.toContain("watch:run-1")
    expect(f.runs.get("r1")?.status).toBe("cancelled")
  })

  it("a refused late stop stays visible on the cancelled run", async () => {
    const f = setup({ refuseCancel: true })
    f.auto.start = false
    f.runs.request({ id: "r1", flow: "review", input: {}, by: "user" })
    await tick()
    f.runs.cancel("r1")
    f.starts[0]!.resolve("run-1")
    await tick()
    await tick()
    expect(f.runs.get("r1")).toMatchObject({ status: "cancelled", runId: "run-1", message: "Cancel refused" })
  })

  it("the coordinator context bounds a run's message", async () => {
    const f = setup()
    f.runs.request({ id: "r1", flow: "review", input: {}, by: "user" })
    await tick()
    f.watches[0]!.done.resolve({ kind: "failed", message: "x".repeat(5000) })
    await tick()
    const [run] = JSON.parse(f.runs.context()) as Array<{ message: string }>
    expect(run!.message.length).toBeLessThanOrEqual(500)
  })

  it("restore marks interrupted and retry resumes the same durable run", async () => {
    const base = { flow: "review", by: "user" as const, input: {}, requested: "{}", startedAt: 1 }
    const f = setup({
      restored: [
        { ...base, id: "r1", status: "running", runId: "run-9" },
        { ...base, id: "r2", status: "failed", message: "boom" }
      ]
    })
    expect(f.runs.get("r1")).toMatchObject({ status: "failed", message: "Interrupted; retry to continue.", runId: "run-9" })
    expect(f.records).toHaveLength(1)
    f.runs.retry("r1")
    await tick()
    expect(f.calls).toEqual(["resume:run-9"])
    expect(f.runs.get("r1")?.status).toBe("running")
    f.resumes[0]!.resolve({ runId: "run-9" })
    await tick()
    expect(f.calls).toContain("watch:run-9")

    f.runs.retry("r2")
    await tick()
    expect(f.calls).toContain("plan:review:{}")
    expect(f.calls.filter((each) => each.startsWith("resume"))).toHaveLength(1)
  })

  it("an agent request for a non-model-invocable flow is refused", async () => {
    const f = setup({ listed: [{ name: "deploy", description: "Deploy", modelInvocable: false }] })
    f.runs.request({ id: "r1", flow: "deploy", input: {}, by: "agent" })
    await tick()
    expect(f.runs.get("r1")).toMatchObject({ status: "failed" })
    expect(f.runs.get("r1")?.message).toContain("not for a model to start")
    expect(f.calls.some((each) => each.startsWith("plan"))).toBe(false)
    // Once discovery is cached, the binding refuses at once.
    expect(() => f.runs.request({ id: "r2", flow: "deploy", input: {}, by: "agent" })).toThrow("not for a model to start")
  })

  it("an unknown flow fails with its name", async () => {
    const f = setup()
    f.runs.request({ id: "r1", flow: "nope", input: {}, by: "user" })
    await tick()
    expect(f.runs.get("r1")).toMatchObject({ status: "failed", message: "Unknown flow nope" })
  })

  it("caps active runs at three", () => {
    const f = setup()
    for (const id of ["a", "b", "c"]) f.runs.request({ id, flow: "review", input: {}, by: "user" })
    expect(() => f.runs.request({ id: "d", flow: "review", input: {}, by: "user" })).toThrow("Three flow runs")
  })

  it("refuses without a port", () => {
    const runs = new FlowRuns({ persist: () => {} })
    expect(() => runs.request({ flow: "review", input: {}, by: "user" })).toThrow("Flows unavailable")
  })
})

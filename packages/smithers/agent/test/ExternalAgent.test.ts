/**
 * An external agent step run on the memory flow runtime over an in-memory job
 * store with the port's real semantics: a start is create-or-get by key, a
 * runner settles each queued generation, a retryable end reads `Again`, and a
 * cancel ends an open job or a key not started yet. Unhappy paths wrap that
 * store in a faulty one; nothing scripts the step itself.
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { FlowEngine } from "@smthrs/engine"
import { Action, ExternalJob, Fault, Flow, Interpreter } from "@smthrs/flow"
import { Logger as StructuredLogger } from "@smthrs/observability"
import * as Cause from "effect/Cause"
import type * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as Logger from "effect/Logger"
import * as Metric from "effect/Metric"
import * as References from "effect/References"
import * as Schema from "effect/Schema"
import { TestClock } from "effect/testing"
import * as Tracer from "effect/Tracer"
import { describe, expect, it } from "vitest"
import * as AgentRunner from "../src/AgentRunner.ts"
import * as ExternalAgent from "../src/ExternalAgent.ts"

const PROMPT = "SENTINEL-PROMPT-4d1c"
const BASE = "0123456789abcdef0123456789abcdef01234567"

const agent: AgentRunner.Agent = {
  name: "coder",
  labels: ["linux"],
  profile: "coder-profile",
  maxHours: 4,
  restarts: 1
}
const changes: AgentRunner.Changes = { additions: [{ path: "NOTES.md", contents: "YWxwaGEK" }], deletions: ["OLD.md"] }
const done: AgentRunner.Outcome = { _tag: "Done", changes, summary: "Added alpha.", usage: { costUsd: 0.25 } }

/** What the runner does with one generation, read by read: `running` keeps it open. */
type Settlement = AgentRunner.Outcome | "running"

interface Row {
  /** Absent for a key cancelled before any start reached the store. */
  readonly task: AgentRunner.Task | undefined
  readonly script: Array<Settlement>
  standing: AgentRunner.Standing
}

const running: AgentRunner.Standing = { _tag: "Running" }

/** How a job stands after the runner's settlement: a retryable end reads `Again`, as the store answers it. */
const advance = (next: Settlement): AgentRunner.Standing =>
  next === "running" ? running : next._tag === "Retryable" ? { _tag: "Again" } : { _tag: "Ended", outcome: next }

/** The host's job store in memory. `work(generation)` is what the runner does with that generation. */
const memoryJobs = (work: (generation: number) => ReadonlyArray<Settlement>) => {
  const rows = new Map<string, Row>()
  const calls: Array<string> = []
  const service = AgentRunner.AgentJobs.of({
    start: (task, key) =>
      Effect.sync(() => {
        calls.push(`start:${key}`)
        if (!rows.has(key)) {
          rows.set(key, { task, script: [...work(AgentRunner.parseKey(key).generation)], standing: running })
        }
      }),
    status: (key) =>
      Effect.sync(() => {
        calls.push(`status:${key}`)
        const row = rows.get(key)!
        if (row.standing._tag === "Running") row.standing = advance(row.script.shift() ?? "running")
        return row.standing
      }),
    cancel: (key) =>
      Effect.sync(() => {
        calls.push(`cancel:${key}`)
        const row = rows.get(key)
        const cancelled: AgentRunner.Standing = {
          _tag: "Ended",
          outcome: { _tag: "Cancelled", processTreeGone: true }
        }
        if (row === undefined) rows.set(key, { task: undefined, script: [], standing: cancelled })
        else if (row.standing._tag === "Running") row.standing = cancelled
      })
  })
  return { rows, calls, service }
}

type Store = ReturnType<typeof memoryJobs>

const Session = ExternalAgent.make("agent/test/Session", {
  payload: { todo: Schema.String },
  task: ({ todo }) => ({
    agent,
    repository: "github/acme/app",
    base: BASE,
    system: ["Keep the repository's style."],
    prompt: `${PROMPT} ${todo}`,
    limits: { files: 50, bytes: 1024 * 1024 }
  })
})

const Caller = Flow.make("agent/test/SessionCaller", {
  payload: { todo: Schema.String },
  success: ExternalAgent.Result,
  error: Session.errorSchema,
  body: ({ todo }) => Session.call({ todo })
})

/** A task that breaks the contract: a base that is no commit id. */
const Broken = ExternalAgent.make("agent/test/Broken", {
  payload: {},
  task: () => ({
    agent,
    repository: "github/acme/app",
    base: "main",
    system: [],
    prompt: PROMPT,
    limits: { files: 1, bytes: 1 }
  })
})

const BrokenCaller = Flow.make("agent/test/BrokenCaller", {
  payload: {},
  success: ExternalAgent.Result,
  error: Broken.errorSchema,
  body: () => Broken.call({})
})

const stack = (service: AgentRunner.AgentJobs["Service"]) =>
  Layer.mergeAll(Session.toLayer(), Broken.toLayer(), Interpreter.layer(Caller), Interpreter.layer(BrokenCaller)).pipe(
    Layer.provideMerge(Layer.succeed(AgentRunner.AgentJobs, service)),
    Layer.provideMerge(Action.layerImplementations),
    Layer.provideMerge(FlowEngine.layerMemory),
    Layer.provideMerge(NodeCrypto.layer)
  )

const turns = Effect.gen(function*() {
  for (let index = 0; index < 50; index++) yield* Effect.yieldNow
})

/** Advances the test clock one `step` at a time until `fiber` ends. */
const settle = <A, E>(fiber: Fiber.Fiber<A, E>, step: Duration.Input = "2 seconds") =>
  Effect.gen(function*() {
    for (let index = 0; index < 3_000 && fiber.pollUnsafe() === undefined; index++) {
      yield* turns
      yield* TestClock.adjust(step)
    }
    return yield* Fiber.await(fiber)
  })

/** Runs `declaration` for `executionId` to its end. */
const execute = (executionId: string, declaration: typeof Caller | typeof BrokenCaller = Caller) =>
  Effect.gen(function*() {
    const fiber = yield* (declaration as typeof Caller).execute({ todo: "NOTES" }, { executionId }).pipe(
      Effect.forkChild({ startImmediately: true })
    )
    return yield* settle(fiber)
  })

interface Observed {
  readonly spans: Array<{ readonly name: string; readonly attributes: Record<string, unknown> }>
  readonly text: Array<string>
}

const run = <A, E>(
  store: Store | AgentRunner.AgentJobs["Service"],
  body: Effect.Effect<A, E, Layer.Success<ReturnType<typeof stack>>>
): Promise<
  { readonly value: A; readonly observed: Observed; readonly metrics: ReadonlyArray<Metric.Metric.Snapshot> }
> => {
  const observed: Observed = { spans: [], text: [] }
  const capture = Logger.make((options) => {
    observed.text.push(JSON.stringify(StructuredLogger.formatStructured.log(options)), Cause.pretty(options.cause))
  })
  const tracing = (inner: Tracer.Tracer) =>
    Tracer.make({
      ...inner,
      span(options) {
        const span = inner.span(options)
        const end = span.end.bind(span)
        span.end = (time, exit) => {
          const attributes = Object.fromEntries(span.attributes)
          observed.spans.push({ name: span.name, attributes })
          observed.text.push(JSON.stringify(attributes), Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "")
          end(time, exit)
        }
        return span
      }
    })
  const service = "service" in store ? store.service : store
  return Effect.runPromise(
    Effect.gen(function*() {
      const value = yield* body.pipe(Effect.provide(stack(service)))
      return { value, observed, metrics: yield* Metric.snapshot }
    }).pipe(
      Effect.updateService(Tracer.Tracer, tracing),
      Effect.provide(Logger.layer([capture])),
      Effect.provideService(References.MinimumLogLevel, "Debug"),
      Effect.provideService(Metric.MetricRegistry, new Map()),
      Effect.provide(TestClock.layer()),
      Effect.scoped
    )
  )
}

/** The typed failure an exit ended with. */
const failure = (exit: Exit.Exit<unknown, unknown>): unknown => {
  if (Exit.isSuccess(exit)) return expect.unreachable("the step succeeded")
  const reason = exit.cause.reasons.find(Cause.isFailReason)
  return reason === undefined ? expect.unreachable(Cause.pretty(exit.cause)) : reason.error
}

const starts = (store: Store) => store.calls.filter((call) => call.startsWith("start:"))
const cancels = (store: Store) => store.calls.filter((call) => call.startsWith("cancel:"))

/** The job counter's series, as `agent/outcome[/reason]=count`. */
const counted = (metrics: ReadonlyArray<Metric.Metric.Snapshot>): Array<string> =>
  metrics.filter((metric) => metric.id === "smithers_external_agent_jobs").map((metric) => {
    const attributes = metric.attributes ?? {}
    const series = [attributes.agent, attributes.outcome, attributes.reason].filter((part) => part !== undefined)
    return `${series.join("/")}=${(metric.state as { readonly count: number }).count}`
  }).sort()

describe("ExternalAgent.make", () => {
  it("answers the first generation's changes, summary and usage, starting the job once", async () => {
    const store = memoryJobs(() => ["running", done])
    const { metrics, observed, value: exit } = await run(store, execute("done"))
    expect(exit).toEqual(Exit.succeed({ changes, summary: "Added alpha.", usage: { costUsd: 0.25 }, generation: 1 }))
    const [start] = starts(store)
    const key = start!.slice("start:".length)
    expect(AgentRunner.parseKey(key).generation).toBe(1)
    expect(starts(store)).toHaveLength(1)
    expect(cancels(store)).toEqual([])
    expect(store.rows.get(key)?.task).toEqual({
      agent,
      repository: "github/acme/app",
      base: BASE,
      system: ["Keep the repository's style."],
      prompt: `${PROMPT} NOTES`,
      limits: { files: 50, bytes: 1024 * 1024 }
    })
    expect(counted(metrics)).toEqual(["coder/done=1", "coder/started=1"])
    const names = new Set(observed.spans.map((span) => span.name).filter((name) => name.startsWith("agent.external.")))
    expect(names).toEqual(new Set(["agent.external.start", "agent.external.status", "agent.external.collect"]))
    for (const span of observed.spans.filter((each) => each.name.startsWith("agent.external."))) {
      expect(span.attributes).toMatchObject({
        "smithers.external_agent.key": key,
        "smithers.external_agent.agent": "coder",
        "smithers.external_agent.generation": 1
      })
    }
    // The task's content never reaches a log line or a span.
    expect(observed.text.join("\n")).not.toContain(PROMPT)
  })

  it("replaces a retryable generation with the next one, which finishes", async () => {
    const store = memoryJobs((generation) => generation === 1 ? [{ _tag: "Retryable", afterSeconds: 30 }] : [done])
    const { metrics, value: exit } = await run(store, execute("again"))
    expect(Exit.isSuccess(exit) && exit.value.generation).toBe(2)
    expect(starts(store).map((call) => AgentRunner.parseKey(call.slice(6)).generation)).toEqual([1, 2])
    // The ended generation is cancelled by key before its replacement starts, which the store ignores.
    expect(cancels(store)).toHaveLength(1)
    expect(counted(metrics)).toEqual(["coder/again=1", "coder/done=1", "coder/started=2"])
  })

  it("fails ExternalJobLost once every replacement generation ended retryable", async () => {
    const store = memoryJobs(() => [{ _tag: "Retryable" }])
    const { value: exit } = await run(store, execute("exhausted"))
    expect(failure(exit)).toBeInstanceOf(ExternalJob.ExternalJobLost)
    expect(starts(store)).toHaveLength(AgentRunner.MAX_RESTARTS + 1)
  })

  it.each(AgentRunner.FAILURES)("fails AgentFailed %s with the runner's code", async (reason) => {
    const store = memoryJobs(() => [{ _tag: "Failed", reason }])
    const { metrics, value: exit } = await run(store, execute(`failed-${reason}`))
    expect(failure(exit)).toEqual(new ExternalAgent.AgentFailed({ reason }))
    expect(counted(metrics)).toContain(`coder/failed/${reason}=1`)
  })

  it("fails AgentFailed cancelled when the runner settled the job cancelled", async () => {
    const store = memoryJobs(() => [{ _tag: "Cancelled", processTreeGone: true }])
    const { value: exit } = await run(store, execute("cancelled"))
    expect(failure(exit)).toEqual(new ExternalAgent.AgentFailed({ reason: "cancelled" }))
  })

  it("starts the next generation when collect reads an ended job as open", async () => {
    const store = memoryJobs(() => [done])
    let reads = 0
    const flaky = AgentRunner.AgentJobs.of({
      ...store.service,
      // The probe reads it ended; the collect after it reads it open, once.
      status: (key) => Effect.map(store.service.status(key), (standing) => ++reads === 2 ? running : standing)
    })
    const { value: exit } = await run(flaky, execute("reopened"))
    expect(Exit.isSuccess(exit) && exit.value.generation).toBe(2)
  })

  it("retries a start the store could not record, as the infra fault it is", async () => {
    const store = memoryJobs(() => [done])
    let failures = 1
    const unavailable = AgentRunner.AgentJobs.of({
      ...store.service,
      start: (task, key) =>
        failures-- > 0 ? Effect.fail(new AgentRunner.AgentJobsUnavailable()) : store.service.start(task, key)
    })
    const { value: exit } = await run(unavailable, execute("retried"))
    expect(Exit.isSuccess(exit)).toBe(true)
    expect(Fault.of(new AgentRunner.AgentJobsUnavailable()).class).toBe("infra")
  })

  it("cancels its job when the run is cancelled during a probe", async () => {
    const store = memoryJobs(() => [])
    let probes = 0
    // A store slow to answer keeps the probe in flight when the cancellation lands.
    const slow = AgentRunner.AgentJobs.of({
      ...store.service,
      status: (key) =>
        Effect.suspend(() => {
          probes++
          return Effect.andThen(store.service.status(key), Effect.never)
        })
    })
    const { value: exit } = await run(
      slow,
      Effect.gen(function*() {
        const fiber = yield* Caller.execute({ todo: "NOTES" }, { executionId: "interrupted" }).pipe(
          Effect.forkChild({ startImmediately: true })
        )
        while (probes === 0) yield* turns
        yield* Caller.interrupt("interrupted")
        return yield* settle(fiber)
      })
    )
    expect(Exit.hasInterrupts(exit)).toBe(true)
    expect(cancels(store)).toHaveLength(1)
    expect([...store.rows.values()][0]!.standing).toEqual({
      _tag: "Ended",
      outcome: { _tag: "Cancelled", processTreeGone: true }
    })
  })

  it("times out a running job at TIMEOUT and cancels its current generation", async () => {
    const store = memoryJobs(() => [])
    // Keep the probe in flight: the deadline must win even when the store does not answer.
    const pending = AgentRunner.AgentJobs.of({
      ...store.service,
      status: (key) => Effect.andThen(store.service.status(key), Effect.never)
    })
    const { value: exit } = await run(
      pending,
      Effect.gen(function*() {
        const fiber = yield* Caller.execute({ todo: "NOTES" }, { executionId: "timed-out" }).pipe(
          Effect.forkChild({ startImmediately: true })
        )
        for (let attempt = 0; attempt < 3_000 && !store.calls.some((call) => call.startsWith("status:")); attempt++) {
          yield* turns
        }
        expect(store.calls.some((call) => call.startsWith("status:"))).toBe(true)
        expect([...store.rows.values()][0]!.standing).toEqual(running)
        expect(cancels(store)).toEqual([])
        yield* TestClock.adjust(ExternalAgent.TIMEOUT)
        return yield* settle(fiber)
      })
    )
    const key = starts(store)[0]!.slice("start:".length)
    expect(failure(exit)).toBeInstanceOf(ExternalJob.ExternalJobTimedOut)
    expect(failure(exit)).toMatchObject({ key })
    expect(starts(store)).toHaveLength(1)
    expect(cancels(store)).toEqual([`cancel:${key}`])
    expect(store.rows.get(key)?.standing).toEqual({
      _tag: "Ended",
      outcome: { _tag: "Cancelled", processTreeGone: true }
    })
  })

  it("abandons a key whose start never answered when the run is cancelled", async () => {
    const store = memoryJobs(() => [])
    const admitting = AgentRunner.AgentJobs.of({
      ...store.service,
      start: (task, key) => Effect.andThen(store.service.start(task, key), Effect.never)
    })
    const { metrics, value: exit } = await run(
      admitting,
      Effect.gen(function*() {
        const fiber = yield* Caller.execute({ todo: "NOTES" }, { executionId: "abandoned" }).pipe(
          Effect.forkChild({ startImmediately: true })
        )
        while (store.rows.size === 0) yield* turns
        yield* Caller.interrupt("abandoned")
        return yield* settle(fiber)
      })
    )
    expect(Exit.hasInterrupts(exit)).toBe(true)
    expect(cancels(store)).toHaveLength(1)
    expect([...store.rows.values()][0]!.standing).toEqual({
      _tag: "Ended",
      outcome: { _tag: "Cancelled", processTreeGone: true }
    })
    expect(counted(metrics)).toEqual(["coder/abandoned=1"])
  })

  it("dies when task(payload) breaks the runner contract", async () => {
    const store = memoryJobs(() => [done])
    const { value: exit } = await run(store, execute("broken", BrokenCaller))
    expect(Exit.isFailure(exit) && Cause.pretty(exit.cause)).toContain("is not an AgentRunner.Task")
    expect(starts(store)).toEqual([])
  })

  it("classes each failure for the engine", () => {
    const classes = Object.fromEntries(
      ExternalAgent.REASONS.map((reason) => [reason, Fault.of(new ExternalAgent.AgentFailed({ reason })).class])
    )
    expect(classes).toEqual({
      agent: "factory",
      refused: "dependency",
      workspace: "dependency",
      too_large: "factory",
      timeout: "dependency",
      machine_lost: "dependency",
      exhausted: "dependency",
      cancelled: "user"
    })
  })
})

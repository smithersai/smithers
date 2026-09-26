/**
 * Role budgets: the per-task token ceiling over the run's budget, the daily
 * task ledger charged up the hiring chain, the concurrency permits, and the
 * `blocked` result a limit answers with, through the real role-task stack.
 */
import * as AgentAction from "@smthrs/agent/AgentAction"
import * as Budget from "@smthrs/agent/Budget"
import { FlowEngine } from "@smthrs/engine"
import { Action, Flow, Interpreter } from "@smthrs/flow"
import { HarnessError } from "@smthrs/harness/HarnessError"
import * as Model from "@smthrs/model/Model"
import * as ModelError from "@smthrs/model/ModelError"
import * as ModelEvent from "@smthrs/model/ModelEvent"
import { Node } from "@smthrs/plan"
import { Effect, Exit, Layer, Option, Schema, Stream } from "effect"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import * as Actions from "../src/Actions.ts"
import * as Authority from "../src/Authority.ts"
import * as Budgets from "../src/Budgets.ts"
import * as Profile from "../src/Profile.ts"
import {
  agentStack,
  answering,
  done,
  failureOf,
  fileServices,
  loadSnapshot,
  memoryServices,
  patched,
  payloadFor,
  task,
  wikiRoot
} from "./dispatchSupport.ts"
import { exampleDir, faultyLayer, nodeLayer, tempDir } from "./support.ts"

const Dispatch = Flow.make("test/budget-dispatch", {
  payload: Authority.RoleTaskPayload,
  success: Profile.RoleResult,
  error: AgentAction.AgentFailure,
  body: (payload) => Actions.RoleTask.call(payload)
})

/** A model answering one scripted cell per request, each reporting `tokens` of usage. */
const metered = (cells: ReadonlyArray<string>, tokens: number, asked: Array<number>): Model.Model => {
  let index = 0
  return Model.make({
    stream: () =>
      Stream.suspend(() => {
        const source = cells[index] ?? cells.at(-1)!
        index++
        asked.push(index)
        if (source === "refuse") {
          return Stream.fail(
            new ModelError.ModelError({ code: "invalid_request", message: "refused", httpStatus: 400 })
          )
        }
        return Stream.fromIterable([
          ModelEvent.ModelEvent.TextStart({ type: "text-start", id: `cell-${index}` }),
          ModelEvent.ModelEvent.TextDelta({
            type: "text-delta",
            id: `cell-${index}`,
            text: "```cell\n" + source + "\n```"
          }),
          ModelEvent.ModelEvent.TextEnd({ type: "text-end", id: `cell-${index}` }),
          ModelEvent.ModelEvent.Usage({ totalTokens: tokens }),
          ModelEvent.ModelEvent.Settle({ type: "settle", stopReason: "stop" })
        ])
      })
  })
}

const result = done({ summary: "Changed it.", commands: "none" })
const recall = `await ctx.call("recall", { query: "anything" });`

const stackFor = (snapshot: Authority.Snapshot, model: Model.Model, maxConcurrentTasks = 2) =>
  Layer.mergeAll(
    Authority.layer(Budgets.layer(Actions.RoleTask.layer, { maxConcurrentTasks })),
    Interpreter.layer(Dispatch)
  ).pipe(
    Layer.provideMerge(Budgets.layerLedgerMemory),
    Layer.provideMerge(
      agentStack({
        snapshot,
        resources: { memory: memoryServices, wiki: { root: wikiRoot(), services: fileServices }, claimCap: 0 },
        model,
        recorded: []
      })
    )
  )

const dispatchAll = (
  snapshot: Authority.Snapshot,
  model: Model.Model,
  payloads: ReadonlyArray<unknown>,
  maxConcurrentTasks = 2
) =>
  Effect.runPromise(
    Effect.forEach(
      payloads,
      (payload, index) =>
        Dispatch.execute(payload as Authority.RoleTaskPayload, { executionId: `budget-${index}` }).pipe(Effect.exit)
    ).pipe(Effect.provide(stackFor(snapshot, model, maxConcurrentTasks)))
  )

const valueOf = (exit: Exit.Exit<Profile.RoleResult, unknown>): Profile.RoleResult => {
  if (Exit.isFailure(exit)) throw new Error(String(failureOf(exit)))
  return exit.value
}

describe("Budgets.taskBudget", () => {
  const shared = (): Budget.Service & { readonly asked: Array<string> } => {
    const asked: Array<string> = []
    return {
      asked,
      check: (key) => Effect.sync(() => (asked.push(`check:${key}`), { _tag: "proceed" as const })),
      reserve: (key) => Effect.sync(() => (asked.push(`reserve:${key}`), { _tag: "proceed" as const })),
      record: (key) => Effect.sync(() => void asked.push(`record:${key}`)),
      usage: Effect.succeed({ tokens: 1, calls: 1, largestCall: 1 }),
      usageOf: () => Effect.succeed({ tokens: 2, calls: 1, largestCall: 2 })
    }
  }

  it("asks the run's budget until the task's own ceiling refuses, and counts each step once", async () => {
    const run = shared()
    const budget = Budgets.taskBudget(run, "builder", 1_000)
    const verdicts = await Effect.runPromise(Effect.gen(function*() {
      const first = yield* Effect.scoped(budget.reserve("a"))
      yield* budget.record("a", { totalTokens: 600 })
      yield* budget.record("a", { totalTokens: 600 })
      const replayed = yield* budget.check("a")
      const second = yield* budget.check("b")
      const unkeyed = yield* budget.check(undefined)
      yield* budget.record("c", { totalTokens: Number.NaN })
      return { first, replayed, second, unkeyed, usage: yield* budget.usage, of: yield* budget.usageOf("x") }
    }))
    expect(verdicts.first._tag).toBe("proceed")
    expect(verdicts.replayed._tag).toBe("proceed")
    expect(verdicts.second._tag).toBe("refuse")
    expect(verdicts.unkeyed._tag).toBe("refuse")
    if (verdicts.second._tag !== "refuse") throw new Error("expected a refusal")
    expect(verdicts.second.exceeded.message).toBe("builder has spent 600 of its 1000 tokens for this task")
    expect(verdicts.second.failure).toBeInstanceOf(Budget.BudgetExceeded)
    expect(verdicts.usage.tokens).toBe(1)
    expect(verdicts.of.tokens).toBe(2)
    expect(run.asked).toEqual(["reserve:a", "record:a", "record:a", "check:a", "record:c"])
  })

  it("stands alone without a run budget, reporting its own usage", async () => {
    const budget = Budgets.taskBudget(undefined, "builder", 1_000)
    const seen = await Effect.runPromise(Effect.gen(function*() {
      const first = yield* budget.check("a")
      const reserved = yield* Effect.scoped(budget.reserve("a"))
      yield* budget.record("a", { totalTokens: 700 })
      return {
        first,
        reserved,
        usage: yield* budget.usage,
        of: yield* budget.usageOf("x"),
        next: yield* budget.check("b")
      }
    }))
    expect(seen.first._tag).toBe("proceed")
    expect(seen.reserved._tag).toBe("proceed")
    expect(seen.usage).toEqual({ tokens: 700, calls: 1, largestCall: 700 })
    expect(seen.of).toEqual({ tokens: 700, calls: 1, largestCall: 700 })
    expect(seen.next._tag).toBe("refuse")
  })

  it("refuses once the ceiling is spent, whatever the next call costs", async () => {
    const budget = Budgets.taskBudget(shared(), "builder", 100)
    const verdict = await Effect.runPromise(Effect.gen(function*() {
      yield* budget.record("a", { totalTokens: 100 })
      return yield* Effect.scoped(budget.reserve("b"))
    }))
    expect(verdict._tag).toBe("refuse")
  })
})

describe("Budgets.exhaustion and blocked", () => {
  it("finds a spent budget anywhere in a failure's causes", () => {
    const exceeded = new Budget.BudgetExceeded({
      scope: "tokens",
      onExceeded: "fail",
      used: 1,
      max: 1,
      next: 1,
      message: "spent"
    })
    expect(Budgets.exhaustion(exceeded)).toEqual(Option.some("spent"))
    expect(Budgets.exhaustion(new HarnessError({ code: "model_failed", message: "x", cause: exceeded }))).toEqual(
      Option.some("spent")
    )
    expect(Budgets.exhaustion({ _tag: Budget.skippedTag, message: "" })).toEqual(
      Option.some("the task's budget is spent")
    )
    expect(Budgets.exhaustion({ _tag: Budget.skippedTag, message: 3 })).toEqual(
      Option.some("the task's budget is spent")
    )
    expect(Budgets.exhaustion(new Error("other"))).toEqual(Option.none())
    expect(Budgets.exhaustion(undefined)).toEqual(Option.none())
  })

  it("answers blocked, escalating a core role to the assistant and a hire to its parent", async () => {
    const snapshot = await loadSnapshot((profiles) => profiles, exampleDir)
    const lead = snapshot.roster.profiles.get("lead")!
    const hire = snapshot.roster.profiles.get("lead.research")!
    expect(Budgets.blocked(lead, "spent")).toEqual({
      status: "blocked",
      summary: "budget: spent",
      fields: {},
      evidence: [{ kind: "record", ref: "budget/lead", detail: "spent" }],
      handoffs: [],
      escalations: [{ to: "assistant", reason: "budget: spent" }],
      decisions: []
    })
    expect(Budgets.blocked(hire, "spent").escalations).toEqual([{ to: "parent", reason: "budget: spent" }])
  })
})

describe("Budgets ledgers", () => {
  const charge = (
    ledger: Budgets.LedgerService,
    dayText: string,
    task: string,
    charges: ReadonlyArray<Budgets.Charge>
  ) => Effect.runPromise(ledger.charge({ day: dayText, task, charges }))

  const exercise = async (ledger: Budgets.LedgerService) => {
    const both = [{ principal: "lead.research", tasksPerDay: 2 }, { principal: "lead", tasksPerDay: 2 }]
    expect(await charge(ledger, "2026-09-25", "t1", both)).toEqual({ _tag: "charged" })
    expect(await charge(ledger, "2026-09-25", "t1", both)).toEqual({ _tag: "charged" })
    expect(await charge(ledger, "2026-09-25", "t2", [{ principal: "lead", tasksPerDay: 2 }])).toEqual({
      _tag: "charged"
    })
    expect(await charge(ledger, "2026-09-25", "t3", both)).toEqual({
      _tag: "exceeded",
      principal: "lead",
      tasksPerDay: 2
    })
    expect(await Effect.runPromise(ledger.count("2026-09-25", "lead"))).toBe(2)
    expect(await Effect.runPromise(ledger.count("2026-09-25", "lead.research"))).toBe(1)
    expect(await Effect.runPromise(ledger.count("2026-09-24", "lead"))).toBe(0)
    for (let dayOfMonth = 1; dayOfMonth <= 9; dayOfMonth++) {
      await charge(ledger, `2026-10-0${dayOfMonth}`, "t", [{ principal: "lead", tasksPerDay: 1 }])
    }
    expect(await Effect.runPromise(ledger.count("2026-09-25", "lead"))).toBe(0)
    expect(await Effect.runPromise(ledger.count("2026-10-09", "lead"))).toBe(1)
  }

  it("charges all or nothing, once per task, and keeps a week in memory", async () => {
    await exercise(await Effect.runPromise(Budgets.makeLedgerMemory()))
  })

  it("keeps the same book in a file", async () => {
    const file = join(tempDir(), "state", "ledger.json")
    const ledger = await Effect.runPromise(
      Effect.map(Budgets.Ledger, (service) => service).pipe(
        Effect.provide(Budgets.layerLedgerFile({ file }).pipe(Layer.provide(nodeLayer)))
      )
    )
    await exercise(ledger)
    expect(Object.keys(JSON.parse(readFileSync(file, "utf8")))).toHaveLength(Budgets.retainedDays)
  })

  it("fails with the ledger's path when its file cannot be used", async () => {
    const dir = tempDir()
    const file = join(dir, "ledger.json")
    const attempt = (fault: (method: string, path: string) => boolean) =>
      Effect.runPromise(
        Effect.flatMap(Budgets.Ledger, (ledger) =>
          ledger.charge({ day: "2026-09-25", task: "t", charges: [{ principal: "lead", tasksPerDay: 1 }] })).pipe(
            Effect.provide(Budgets.layerLedgerFile({ file }).pipe(Layer.provide(faultyLayer(fault)))),
            Effect.flip
          )
      )
    expect((await attempt((method) => method === "exists")).message).toBe(
      `the task ledger ${file} could not be checked`
    )
    expect((await attempt((method) => method === "makeDirectory")).message).toContain("directory could not be created")
    expect((await attempt((method) => method === "writeFileString")).message).toContain("could not be written")
    expect((await attempt((method) => method === "rename")).message).toContain("could not be replaced")
    writeFileSync(file, "{}")
    expect((await attempt((method) => method === "readFileString")).message).toContain("could not be read")
    writeFileSync(file, "not json")
    expect((await attempt(() => false)).message).toContain("does not parse")
    expect(existsSync(file)).toBe(true)
    expect(Budgets.dayOf(Date.parse("2026-09-25T23:59:59Z"))).toBe("2026-09-25")
  })
})

describe("Budgets.layer on role tasks", () => {
  it("stops a task that spends its tokens with a blocked result naming the limit", async () => {
    const snapshot = await loadSnapshot((profiles) =>
      patched(profiles, "builder", { budget: { tokensPerTask: 1_000, tasksPerDay: 10, concurrency: 1 } })
    )
    const asked: Array<number> = []
    const [exit] = await dispatchAll(snapshot, metered([recall, recall, answering(result)], 800, asked), [
      payloadFor(snapshot, "builder", task())
    ])
    expect(valueOf(exit!)).toEqual(
      Budgets.blocked(
        snapshot.roster.profiles.get("builder")!,
        "builder has spent 800 of its 1000 tokens for this task"
      )
    )
    expect(asked).toEqual([1])
  })

  it("runs tasks within their ceiling to their answers, one at a time per principal", async () => {
    const snapshot = await loadSnapshot()
    const exits = await dispatchAll(snapshot, metered([answering(result)], 800, []), [
      payloadFor(snapshot, "builder", task("first")),
      payloadFor(snapshot, "builder", task("second"))
    ])
    expect(exits.map(valueOf)).toEqual([result, result])
  })

  it("charges each task to its principal and its hirers, and blocks past a daily limit", async () => {
    const snapshot = await loadSnapshot(
      (profiles) => patched(profiles, "lead", { budget: { tokensPerTask: 600_000, tasksPerDay: 1, concurrency: 1 } }),
      exampleDir
    )
    const exits = await dispatchAll(snapshot, metered([answering(done({ report: "x" }))], 10, []), [
      payloadFor(snapshot, "lead.research", task("research-1")),
      payloadFor(snapshot, "lead.research", task("research-2")),
      payloadFor(snapshot, "lead", task("lead-1"))
    ], 1)
    expect(valueOf(exits[0]!).status).toBe("done")
    expect(valueOf(exits[1]!).summary).toBe("budget: lead.research's hirer lead has run its 1 tasks for today")
    expect(valueOf(exits[2]!).summary).toBe("budget: lead has run its 1 tasks for today")
  })

  it("passes a failure that is not a spent budget through", async () => {
    const snapshot = await loadSnapshot()
    const [exit] = await dispatchAll(snapshot, metered(["refuse"], 0, []), [payloadFor(snapshot, "builder", task())])
    expect(Budgets.exhaustion(failureOf(exit!))).toEqual(Option.none())
  })

  it("leaves a payload it cannot resolve to authority, and wraps a role task registered as a flow", async () => {
    const snapshot = await loadSnapshot()
    const seen: Array<unknown> = []
    const stub = Layer.effectDiscard(Effect.flatMap(Action.Implementations, (table) =>
      table.add({
        name: Authority.roleTaskTag,
        action: (payload) => Effect.sync(() => (seen.push(payload), done({ commands: "none" }, "stub")))
      })))
    const flowResult = done({ commands: "none" }, "flow")
    const RoleFlow = Flow.make(Authority.roleTaskTag, {
      payload: { principal: Schema.String },
      success: Schema.String,
      body: () => Node.succeed(flowResult.summary)
    })
    const layer = Layer.mergeAll(
      Budgets.layer(stub, { maxConcurrentTasks: 1 }),
      Budgets.layer(Interpreter.layer(RoleFlow), { maxConcurrentTasks: 1 })
    ).pipe(
      Layer.provideMerge(Budgets.layerLedgerMemory),
      Layer.provideMerge(agentStack({ snapshot, resources: {}, model: metered([], 0, []), recorded: [] }))
    )
    const outcome = await Effect.runPromise(
      Effect.gen(function*() {
        const table = yield* Action.Implementations
        const implementation = Option.getOrThrow(yield* table.get(Authority.roleTaskTag))
        const malformed = yield* (implementation.action({ malformed: true }) as Effect.Effect<Profile.RoleResult>)
        const unknown = yield* (implementation.action({
          ...payloadFor(snapshot, "builder", task()),
          principal: "nobody"
        }) as Effect.Effect<Profile.RoleResult>)
        const outside =
          yield* (implementation.action(payloadFor(snapshot, "builder", task("outside"))) as Effect.Effect<
            Profile.RoleResult
          >)
        const flowed = yield* RoleFlow.execute({ principal: "builder" }, { executionId: "role-flow-1" })
        return { malformed, unknown, outside, flowed }
      }).pipe(Effect.provide(layer))
    )
    expect(outcome.malformed.summary).toBe("stub")
    expect(outcome.unknown.summary).toBe("stub")
    expect(outcome.outside.summary).toBe("stub")
    expect(outcome.flowed).toBe("flow")
    expect(seen).toHaveLength(3)
  })

  it("keeps the task's ceiling where the composition approved no run budget", async () => {
    const snapshot = await loadSnapshot()
    const stub = Layer.effectDiscard(Effect.flatMap(Action.Implementations, (table) =>
      table.add({
        name: Authority.roleTaskTag,
        action: () => Effect.map(Budget.Budget, (budget) => budget === undefined ? "none" : "task budget") as never
      })))
    const answer = await Effect.runPromise(
      Effect.gen(function*() {
        const table = yield* Action.Implementations
        const implementation = Option.getOrThrow(yield* table.get(Authority.roleTaskTag))
        return yield* (implementation.action(payloadFor(snapshot, "builder", task())) as Effect.Effect<string>)
      }).pipe(Effect.provide(
        Budgets.layer(stub, { maxConcurrentTasks: 1 }).pipe(
          Layer.provideMerge(Layer.mergeAll(Budgets.layerLedgerMemory, Authority.layerRegistry(snapshot))),
          Layer.provideMerge(Action.layerImplementations),
          Layer.provideMerge(FlowEngine.layerMemory)
        )
      ))
    )
    expect(answer).toBe("task budget")
  })

  it("passes every other registration through", async () => {
    const snapshot = await loadSnapshot()
    const Other = Action.make("test/other", { implementationVersion: "other/v1", payload: {}, success: Schema.String })
    const OtherFlow = Flow.make("test/other-flow", { payload: {}, success: Schema.String, body: () => Other.call({}) })
    const layer = Layer.mergeAll(
      Budgets.layer(Other.toLayer(() => Effect.succeed("other ran"), { implementationVersion: "other/v1" }), {
        maxConcurrentTasks: 1
      }),
      Budgets.layer(Interpreter.layer(OtherFlow), { maxConcurrentTasks: 1 })
    ).pipe(
      Layer.provideMerge(Budgets.layerLedgerMemory),
      Layer.provideMerge(agentStack({ snapshot, resources: {}, model: metered([], 0, []), recorded: [] }))
    )
    expect(await Effect.runPromise(OtherFlow.execute({}, { executionId: "other-1" }).pipe(Effect.provide(layer)))).toBe(
      "other ran"
    )
  })
})

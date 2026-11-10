// Agent status's flows when ChatApi's runs routes fail, by injection (docs/rules.md, test.faults-by-injection): the flows
// run on the Node host's durable engine over the compose Postgres (`pnpm db:up`), with a `RunsClient` given here in place
// of the real one. The happy paths run against the real routes in flows.test.ts and status.test.ts.
import { Action, FlowRuntime } from "@smthrs/flow"
import { Cause, Context, Effect, Exit, Layer, Scope } from "effect"
import { afterEach, describe, expect, test } from "vitest"
import { build } from "../../../worker/test/flowHost.ts"
import { RunsClient, RunsRefused } from "./api"
import { AnswerNotOpen, AnswerRefused, AnswerRun, Ask, Deliver } from "./flows"
import * as Status from "./flows"
import { RunReporter } from "./reporter"
import type { Report, RunAnswer } from "./schema"

/** A failed call's error. The engine annotates an action's failed cause with its FailureSite, which the outcome doesn't depend on. */
const failureOf = (exit: Exit.Exit<unknown, unknown>) => Exit.isFailure(exit) ? Cause.squash(exit.cause) : exit

const scopes: Array<Scope.Closeable> = []
afterEach(async () => {
  for (const scope of scopes.splice(0)) await Effect.runPromise(Scope.close(scope, Exit.void))
})

/**
 * The status flows on a fresh engine, over a client whose reports and answers fail with the next of `reports` and
 * `answers` (and succeed once those run out). Records what it was sent.
 */
const engine = async (
  faults: { readonly reports?: ReadonlyArray<RunsRefused>; readonly answers?: ReadonlyArray<RunsRefused> } = {},
) => {
  const reported: Array<readonly [string, Report]> = []
  const answered: Array<readonly [string, RunAnswer]> = []
  const next = <A>(sent: Array<A>, sending: A, failures: ReadonlyArray<RunsRefused> = []) =>
    Effect.suspend(() => {
      sent.push(sending)
      const failure = failures[sent.length - 1]
      return failure === undefined ? Effect.void : Effect.fail(failure)
    })
  const client = RunsClient.of({
    report: (runId, report) => next(reported, [runId, report] as const, faults.reports),
    answer: (runId, answer) => next(answered, [runId, answer] as const, faults.answers),
  })
  const registration = Status.registration.pipe(
    Layer.provide(RunReporter.layer),
    Layer.provide(Layer.succeed(RunsClient, client)),
    Layer.provideMerge(Action.layerImplementations),
  )
  const scope = Effect.runSync(Scope.make())
  scopes.push(scope)
  const built = await Effect.runPromise(Scope.provide(scope)(build(registration)))
  const flows = Context.get(built.context, FlowRuntime.FlowRuntime)
  const run = <A, E>(effect: (flows: FlowRuntime.FlowRuntime["Service"]) => Effect.Effect<A, E>) =>
    Effect.runPromise(Effect.exit(effect(flows)))
  return { run, reported, answered }
}

describe("app/agent/ask under faults", () => {
  test("a question whose report fails is reported again, and an answer delivered before it parks waits for it", async () => {
    const e = await engine({ reports: [new RunsRefused({ status: 503 })] })
    const execution = `${crypto.randomUUID()}/chat/Respond@x:1#0/call/0.0`
    await e.run((flows) =>
      flows.execute(Ask, { executionId: execution, payload: { kind: "question", prompt: "Which?" }, discard: true }))
    // Delivered at once: the question isn't parked yet, while its report waits to be sent again.
    const delivered = await e.run((flows) =>
      flows.execute(Deliver, { executionId: `deliver-${execution}`, payload: { execution, value: "main" } }))
    expect(delivered).toEqual(Exit.succeed({ delivered: true }))
    expect(await e.run((flows) => flows.execute(Ask, { executionId: execution, payload: { kind: "question", prompt: "Which?" } })))
      .toEqual(Exit.succeed({ answered: true, answer: "main" }))
    expect(e.reported.map(([, report]) => report.status)).toEqual(["needs_you", "needs_you", "working"])
  })

  test("an approval the route refuses to show isn't asked: the agent hears no decision", async () => {
    const e = await engine({ reports: [new RunsRefused({ status: 404, code: "not_found" })] })
    const exit = await e.run((flows) =>
      flows.execute(Ask, { executionId: `${crypto.randomUUID()}/call/0.0`, payload: { kind: "approval", prompt: "Delete?" } }))
    expect(exit).toEqual(Exit.succeed({ answered: false }))
  })
})

describe("run/answer under faults", () => {
  const payload = (value: string | boolean = "main") => ({
    runId: crypto.randomUUID(),
    version: 1,
    execution: `${crypto.randomUUID()}/call/0.0`,
    value,
  })

  test("an answer the route couldn't take is sent again; with no run here, it is recorded and not delivered", async () => {
    const e = await engine({ answers: [new RunsRefused({})] })
    const answer = payload()
    const exit = await e.run((flows) => flows.execute(AnswerRun, { executionId: crypto.randomUUID(), payload: answer }))
    expect(exit).toEqual(Exit.succeed({ delivered: false }))
    expect(e.answered).toEqual([
      [answer.runId, { version: 1, value: "main" }],
      [answer.runId, { version: 1, value: "main" }],
    ])
  })

  test("408 and 429 say to try again later: an answer and a question are sent again, not refused", async () => {
    for (const status of [408, 429]) {
      const e = await engine({ answers: [new RunsRefused({ status })] })
      const answer = payload()
      expect(await e.run((flows) => flows.execute(AnswerRun, { executionId: crypto.randomUUID(), payload: answer })))
        .toEqual(Exit.succeed({ delivered: false }))
      expect(e.answered).toHaveLength(2)
      const asked = await engine({ reports: [new RunsRefused({ status })] })
      const execution = `${crypto.randomUUID()}/chat/Respond@x:1#0/call/0.0`
      await asked.run((flows) =>
        flows.execute(Ask, { executionId: execution, payload: { kind: "question", prompt: "Which?" }, discard: true }))
      await asked.run((flows) =>
        flows.execute(Deliver, { executionId: `deliver-${execution}`, payload: { execution, value: "main" } }))
      expect(await asked.run((flows) => flows.execute(Ask, { executionId: execution, payload: { kind: "question", prompt: "Which?" } })))
        .toEqual(Exit.succeed({ answered: true, answer: "main" }))
      expect(asked.reported.map(([, report]) => report.status)).toEqual(["needs_you", "needs_you", "working"])
    }
  })

  test("a question the route can't write, as for a settled run, isn't asked: the agent hears no answer", async () => {
    const e = await engine({ reports: [new RunsRefused({ status: 409, code: "not_writable" })] })
    const exit = await e.run((flows) =>
      flows.execute(Ask, { executionId: `${crypto.randomUUID()}/call/0.0`, payload: { kind: "question", prompt: "Which?" } }))
    expect(exit).toEqual(Exit.succeed({ answered: false }))
    expect(e.reported.map(([, report]) => report.status)).toEqual(["needs_you", "working"])
  })

  test("a refusal, or a question no longer open, is final", async () => {
    const refused = await engine({ answers: [new RunsRefused({ status: 403, code: "forbidden" })] })
    expect(failureOf(await refused.run((flows) => flows.execute(AnswerRun, { executionId: crypto.randomUUID(), payload: payload() }))))
      .toEqual(new AnswerRefused({ status: 403 }))
    expect(refused.answered).toHaveLength(1)
    const closed = await engine({ answers: [new RunsRefused({ status: 409, code: "not_open" })] })
    expect(failureOf(await closed.run((flows) => flows.execute(AnswerRun, { executionId: crypto.randomUUID(), payload: payload(true) }))))
      .toEqual(new AnswerNotOpen())
    expect(closed.answered).toHaveLength(1)
  })
})

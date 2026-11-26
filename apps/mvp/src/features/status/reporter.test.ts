// `RunReporter` over a `RunsClient` given here (faults by injection, docs/rules.md): what it sends, what it skips, and
// how it fails. The real client and routes run in flows.test.ts and status.test.ts.
import { Deferred, Effect, Exit, Fiber, Layer, Metric } from "effect"
import { describe, expect, test } from "vitest"
import { RunsClient, RunsRefused } from "./api.vibe"
import { reports, RunReporter } from "./reporter.vibe"
import type { Report } from "./schema"

/** The reporter over a client that answers each report with the next of `outcomes` (success when they run out). */
const reporter = (...outcomes: ReadonlyArray<RunsRefused | undefined>) => {
  const sent: Array<readonly [string, Report]> = []
  const runs = RunsClient.of({
    report: (runId, report) =>
      Effect.suspend(() => {
        sent.push([runId, report])
        const outcome = outcomes[sent.length - 1]
        return outcome === undefined ? Effect.void : Effect.fail(outcome)
      }),
    answer: () => Effect.void,
  })
  const layer = RunReporter.layer.pipe(Layer.provide(Layer.succeed(RunsClient, runs)))
  const registry: Metric.MetricRegistry = new Map()
  const run = <A, E>(effect: (reporter: RunReporter["Service"]) => Effect.Effect<A, E>) =>
    Effect.runPromise(
      Effect.exit(Effect.flatMap(RunReporter, effect).pipe(Effect.provide(layer), Effect.provideService(Metric.MetricRegistry, registry))),
    )
  const count = (status: string, outcome: string) =>
    Effect.runSync(
      Metric.value(Metric.withAttributes(reports, { status, outcome })).pipe(Effect.provideService(Metric.MetricRegistry, registry)),
    ).count
  return { run, sent, count }
}

const question: Report = {
  status: "needs_you",
  wait: { execution: "a/chat/Respond@x:1#0/call/0.0", kind: "question", prompt: "Which?", options: [] },
}

describe("RunReporter", () => {
  test("reports for the run an execution belongs to, once per status, and again after a settle", async () => {
    const r = reporter()
    await r.run((reporter) =>
      Effect.gen(function* () {
        yield* reporter.report("a", { status: "waiting", waiting: "turn" })
        yield* reporter.report("a", { status: "waiting", waiting: "turn" })
        yield* reporter.report("a", { status: "working" })
        yield* reporter.reportOrFail("a/chat/Respond@x:1#0/call/0.0", question)
        yield* reporter.report("a/chat/Respond@x:1#0/call/0.0", question)
        yield* reporter.report("a", { status: "done" })
        yield* reporter.report("a", { status: "done" })
      })
    )
    expect(r.sent.map(([runId, report]) => [runId, report.status])).toEqual([
      ["a", "waiting"],
      ["a", "working"],
      ["a", "needs_you"],
      ["a", "done"],
      ["a", "done"],
    ])
    expect(r.count("waiting", "skipped")).toBe(1)
    expect(r.count("needs_you", "skipped")).toBe(1)
    expect(r.count("done", "sent")).toBe(2)
  })

  test("report never fails, and a report that failed is sent again next time", async () => {
    const r = reporter(new RunsRefused({ status: 404, code: "not_found" }), new RunsRefused({ status: 503 }), new RunsRefused({}))
    const exit = await r.run((reporter) =>
      Effect.gen(function* () {
        yield* reporter.report("a", { status: "working" })
        yield* reporter.report("a", { status: "working" })
        yield* reporter.report("a", { status: "working" })
        yield* reporter.report("a", { status: "working" })
      })
    )
    expect(exit).toEqual(Exit.void)
    expect(r.sent).toHaveLength(4)
    expect(r.count("working", "failed")).toBe(3)
    expect(r.count("working", "sent")).toBe(1)
  })

  test("reportOrFail fails with the client's refusal", async () => {
    const refusal = new RunsRefused({ status: 404, code: "not_found" })
    expect(await reporter(refusal).run((reporter) => reporter.reportOrFail("a", question))).toEqual(Exit.fail(refusal))
  })

  test("a run's reports land in order: one still on its way holds back the next, which isn't skipped", async () => {
    const sent: Array<string> = []
    const gate = Deferred.makeUnsafe<void>()
    const runs = RunsClient.of({
      report: (_runId, report) =>
        Effect.andThen(
          report.status === "needs_you" ? Deferred.await(gate) : Effect.void,
          Effect.sync(() => void sent.push(report.status)),
        ),
      answer: () => Effect.void,
    })
    await Effect.runPromise(
      Effect.gen(function* () {
        const reporter = yield* RunReporter
        yield* reporter.report("a", { status: "working" })
        const asking = yield* Effect.forkChild(reporter.reportOrFail("a/chat/Respond@x:1#0/call/0.0", question))
        yield* Effect.yieldNow
        const working = yield* Effect.forkChild(reporter.report("a", { status: "working" }))
        yield* Effect.yieldNow
        // The question is still on its way; the next report waits for it rather than being skipped as sent.
        expect(sent).toEqual(["working"])
        yield* Deferred.succeed(gate, undefined)
        yield* Fiber.join(asking)
        yield* Fiber.join(working)
      }).pipe(Effect.provide(RunReporter.layer.pipe(Layer.provide(Layer.succeed(RunsClient, runs))))),
    )
    expect(sent).toEqual(["working", "needs_you", "working"])
  })
})

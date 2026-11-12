/**
 * `Control.run` with a `Retry` request: a settled run retried from one of its
 * steps as a new run of the source's approved plan (ruling FLOW-11).
 *
 * The executor resolves the step against its engine's record, so these tests
 * answer through the executor port; the CLI suite drives the same request
 * through a real engine. Every refusal comes before anything is written.
 */
import { Effect, Exit, Stream } from "effect"
import * as SqlClient from "effect/sql/SqlClient"
import { describe, expect, it } from "vitest"
import { Control } from "../src/Control.ts"
import { InvalidInput, RunNotFound } from "../src/ControlError.ts"
import * as ControlExecutor from "../src/ControlExecutor.ts"
import { ControlRuntime } from "../src/ControlRuntime.ts"
import type { RunId, RunStatus } from "../src/ControlSchema.ts"
import type { DurableFlow } from "../src/SqlControlRuntime.ts"
import { durable, type DurableStack } from "./DurableStack.ts"

const flow: DurableFlow = {
  flowId: "retried",
  description: "A flow whose runs are retried",
  deployClass: false,
  envelope: { capabilities: [], flows: [], budget: {} },
  executionDigest: "digest-v1"
}

/** Every retry request and launch the executor saw. */
interface Seen {
  readonly retries: Array<ControlExecutor.RetryRequest>
  readonly launches: Array<ControlExecutor.Launch>
}

/** An executor that accepts every launch and answers a retry with `answer`, or keeps no step history. */
const executor = (seen: Seen, answer: ControlExecutor.RetryStep | undefined) =>
  ControlExecutor.makeNoop({
    launch: (launch) =>
      Effect.sync(() => {
        seen.launches.push(launch)
        return "accepted" as const
      }),
    ...(answer === undefined ? {} : {
      retryStep: (request: ControlExecutor.RetryRequest) =>
        Effect.sync(() => {
          seen.retries.push(request)
          return answer
        })
    })
  })

/** Starts one run of the flow and leaves it `status`. */
const source = (status: RunStatus) =>
  Effect.gen(function*() {
    const control = yield* Control
    const runtime = yield* ControlRuntime
    const card = yield* control.plan({ flowId: "retried", input: { value: 1 } })
    yield* control.approve({ ...card.approval, idempotencyKey: "approve:retried" })
    const receipt = yield* control.run({
      _tag: "Plan",
      planId: card.planId,
      digest: card.digest,
      envelope: card.envelope,
      idempotencyKey: "run:retried"
    })
    const runId = (receipt as { readonly runId: RunId }).runId
    if (status !== "running") yield* runtime.writeStatus(runId, yield* runtime.claimFence(runId), status)
    return { runId, planId: card.planId }
  })

const scenario = <A, E>(
  answer: ControlExecutor.RetryStep | undefined,
  body: (seen: Seen) => Effect.Effect<A, E, DurableStack>
) => {
  const seen: Seen = { retries: [], launches: [] }
  return Effect.runPromise(
    body(seen).pipe(
      Effect.provide(durable({ loadFlows: () => Effect.succeed([flow]), executor: executor(seen, answer) })),
      Effect.scoped
    )
  )
}

/** The run ids the control plane holds. */
const runIds = Effect.gen(function*() {
  const listed = yield* (yield* Control).list({ _tag: "runs" })
  return listed._tag === "runs" ? listed.items.map((item) => item.runId) : []
})

const retry = (runId: RunId, step?: string, idempotencyKey = "retry:1") =>
  Effect.flatMap(
    Control,
    (control) => control.run({ _tag: "Retry", runId, ...(step === undefined ? {} : { step }), idempotencyKey })
  )

/** The typed failure a refused retry ended with. */
const refused = (runId: RunId, step?: string) =>
  Effect.map(
    Effect.exit(retry(runId, step)),
    (exit) => Exit.isFailure(exit) && exit.cause.reasons[0]?._tag === "Fail" ? exit.cause.reasons[0].error : exit
  )

const resolved: ControlExecutor.RetryStep = { _tag: "Step", nodeId: "root.work" }

describe("a retry", () => {
  it("admits a new run of the source's plan from the step the executor resolved", () =>
    scenario(resolved, (seen) =>
      Effect.gen(function*() {
        const { planId, runId } = yield* source("failed")
        const receipt = yield* retry(runId, "app/Work")
        expect(receipt).toMatchObject({ _tag: "Accepted", receiptId: "retry:1" })
        const retried = (receipt as { readonly runId: RunId }).runId
        expect(retried).not.toBe(runId)
        // The executor read the settled source, its plan and the step named.
        expect(seen.retries).toHaveLength(1)
        expect(seen.retries[0]).toMatchObject({ run: { runId, status: "failed" }, step: "app/Work" })
        expect(seen.retries[0]!.plan.card.planId).toBe(planId)
        // The retry runs under the source's approved plan and was handed over.
        expect(yield* (yield* ControlRuntime).getRun(retried)).toMatchObject({ planId, status: "running" })
        expect(seen.launches.map((launch) => launch.run.runId)).toEqual([runId, retried])
        // Its admission records what it retries; the executor reads it back on every drive.
        const events = yield* Stream.runCollect((yield* Control).watch({ runId: retried, follow: false }))
        expect(events.find((event) => event.kind === "control.run.accepted")?.payload).toMatchObject({
          runId: retried,
          planId,
          retryOf: { runId, step: "root.work" }
        })
        // The source is left as it was.
        expect(yield* (yield* ControlRuntime).getRun(runId)).toMatchObject({ status: "failed" })
      })))

  it("replays its receipt for the same key, and admits a second retry under another", () =>
    scenario(resolved, () =>
      Effect.gen(function*() {
        const { runId } = yield* source("completed")
        const first = yield* retry(runId)
        expect(yield* retry(runId)).toMatchObject({ _tag: "AlreadyApplied", runId: (first as { runId: RunId }).runId })
        const second = yield* retry(runId, undefined, "retry:2")
        expect(second).toMatchObject({ _tag: "Accepted" })
        expect((second as { runId: RunId }).runId).not.toBe((first as { runId: RunId }).runId)
      })))

  it("retries a cancelled run", () =>
    scenario(resolved, () =>
      Effect.gen(function*() {
        const { runId } = yield* source("cancelled")
        expect(yield* retry(runId)).toMatchObject({ _tag: "Accepted" })
      })))
})

describe("a refused retry admits nothing", () => {
  it.each(["running", "parked", "waiting-approval"] as const)(
    "refuses a %s source",
    (status) =>
      scenario(resolved, (seen) =>
        Effect.gen(function*() {
          const { runId } = yield* source(status)
          expect(yield* refused(runId)).toEqual(
            new InvalidInput({ issue: `retry: run ${runId} is ${status}; only a settled run can be retried` })
          )
          expect(seen.retries).toEqual([])
          expect(yield* runIds).toEqual([runId])
        }))
  )

  it("refuses a run it does not hold", () =>
    scenario(resolved, () =>
      Effect.gen(function*() {
        expect(yield* refused("run-404" as RunId)).toEqual(new RunNotFound({ runId: "run-404" }))
      })))

  it("refuses a run no plan started", () =>
    scenario(resolved, () =>
      Effect.gen(function*() {
        const { runId } = yield* source("failed")
        const sql = yield* SqlClient.SqlClient
        const [stored] = yield* sql<
          { state: string }
        >`SELECT state_json AS state FROM flows_runs WHERE run_id = ${runId}`
        const state = JSON.parse(stored!.state) as Record<string, unknown>
        delete state.planId
        yield* sql`UPDATE flows_runs SET state_json = ${JSON.stringify(state)} WHERE run_id = ${runId}`
        expect(yield* refused(runId)).toEqual(
          new InvalidInput({ issue: `retry: run ${runId} was not started from a plan` })
        )
        expect(yield* runIds).toEqual([runId])
      })))

  it("refuses on a host that keeps no step history", () =>
    scenario(undefined, () =>
      Effect.gen(function*() {
        const { runId } = yield* source("failed")
        expect(yield* refused(runId)).toEqual(
          new InvalidInput({ issue: "retry: this host keeps no step history to retry from" })
        )
        expect(yield* runIds).toEqual([runId])
      })))

  it("refuses with the executor's reason", () =>
    scenario(
      { _tag: "Refused", reason: "run x ran no step app/Nope; its steps are app/Work" },
      () =>
        Effect.gen(function*() {
          const { runId } = yield* source("failed")
          expect(yield* refused(runId, "app/Nope")).toEqual(
            new InvalidInput({ issue: "retry: run x ran no step app/Nope; its steps are app/Work" })
          )
          expect(yield* runIds).toEqual([runId])
        })
    ))
})

describe("an observing host", () => {
  it("keeps no step history, so it refuses every retry", () => {
    const observing = ControlExecutor.makeObserving(executor({ retries: [], launches: [] }, resolved))
    expect(observing.retryStep).toBeUndefined()
  })
})

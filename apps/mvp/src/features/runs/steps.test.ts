import { EngineStore } from "@smthrs/flows"
import { Cause, Effect, Exit, Logger } from "effect"
import { expect, test } from "vitest"
import { FLOW_CODE } from "../flows-ui/reference"
import { list, retry, cancel } from "./steps"
import { RemoteReadFailed, RemoteRunsClient, StopFailed, SteerFailed, RepoRunsFailed } from "./api"
import { RunActRefused } from "./flows"

test("a remote agent already stopped records settled and refuses cancellation as settled", async () => {
  const remote = RemoteRunsClient.of({
    inspect: () => Effect.fail(new RemoteReadFailed({})), list: Effect.fail(new RemoteReadFailed({})),
    stop: () => Effect.fail(new StopFailed({ status: 409 })), steer: () => Effect.fail(new SteerFailed({})),
    flows: () => Effect.fail(new RepoRunsFailed({})), inputs: () => Effect.fail(new RepoRunsFailed({})), start: () => Effect.fail(new RepoRunsFailed({})),
  })
  const logs: Array<ReturnType<typeof Logger.formatStructured.log>> = []
  expect(await Effect.runPromise(Effect.flip(cancel({ runId: "todo:ended", seq: 0, host: "cloud" }) as Effect.Effect<unknown, unknown, RemoteRunsClient>).pipe(
    Effect.provideService(RemoteRunsClient, remote),
    Effect.provideService(Logger.CurrentLoggers, new Set([Logger.make((o) => void logs.push(Logger.formatStructured.log(o)))])),
  ))).toEqual(new RunActRefused({ code: "settled" }))
  expect(logs).toContainEqual(expect.objectContaining({ annotations: expect.objectContaining({ outcome: "settled" }) }))
})

// Inject the engine's bounded listing service: internal work fills a whole page.
test("run/list fills its limit with eligible runs beyond pages of internal runs", async () => {
  const seen: Array<string | undefined> = []
  const row = (runId: string, flowName: string) => ({ runId, flowName, status: "completed" as const, createdAtMs: 1, startedAtMs: 1, finishedAtMs: 2, parentRunId: null, cancelRequestedAtMs: null, waiting: null, lastSeq: 1, origin: null })
  const service = EngineStore.RunInspection.RunInspection.of({
    inspect: () => Effect.die("unused"), payload: () => Effect.die("unused"),
    list: (options) => { seen.push(options?.cursor); return Effect.succeed(options?.cursor === undefined
      ? { runs: Array.from({ length: 50 }, (_, n) => row(`internal:${n}`, "run/inspect")), cursor: "older" }
      : { runs: Array.from({ length: 50 }, (_, n) => row(`work:${n}`, "flow/run")), cursor: "still-older" }) },
  })
  const result = await Effect.runPromise(list().pipe(Effect.provideService(EngineStore.RunInspection.RunInspection, service)))
  expect(result.runs).toHaveLength(50)
  expect(result.runs[0]?.runId).toBe("work:0")
  expect(seen).toEqual([undefined, "older"])
})

test("run/list ends with a short eligible page when the engine has no continuation", async () => {
  const service = EngineStore.RunInspection.RunInspection.of({
    inspect: () => Effect.die("unused"), payload: () => Effect.die("unused"),
    list: () => Effect.succeed({ runs: [], cursor: null }),
  })
  expect(await Effect.runPromise(list().pipe(Effect.provideService(EngineStore.RunInspection.RunInspection, service)))).toEqual({ runs: [] })
})

/**
 * A store holding `r`, a settled run of `hello` whose own payload names no revision, and its pinned child `r/code`,
 * whose payload is what `child` reads.
 */
const pinnedStore = (child: (runId: string) => Effect.Effect<{ flowName: string; payload: unknown }, EngineStore.RunInspection.RunNotFound>) => {
  const run = { runId: "r", flowName: "flow/run", status: "completed" as const, createdAtMs: 1, startedAtMs: 1, finishedAtMs: 2, parentRunId: null, cancelRequestedAtMs: null, waiting: null, lastSeq: 1, origin: null }
  return EngineStore.RunInspection.RunInspection.of({
    inspect: (runId) => Effect.succeed({
      run: { ...run, runId, input: { text: "{}", bytes: 2, clipped: false }, result: null },
      steps: [],
      children: [{ ...run, runId: "r/code", flowName: FLOW_CODE, parentRunId: runId }],
      journal: { events: [], afterSeq: -1, nextSeq: -1, hasMore: false },
    } as never),
    payload: (runId) => runId === "r" ? Effect.succeed({ flowName: "flow/run", payload: { name: "hello" } }) : child(runId),
    list: () => Effect.die("unused"),
  })
}

/** A pinned Retry of `r` over `store`, without the engine's runtime: its exit, and its `run.retry.revision` lines. */
const pinnedRetry = async (store: EngineStore.RunInspection.RunInspection["Service"]) => {
  const logs: Array<ReturnType<typeof Logger.formatStructured.log>> = []
  const exit = await Effect.runPromise(Effect.exit(retry({ runId: "r", version: "pinned" }) as unknown as Effect.Effect<unknown, unknown, EngineStore.RunInspection.RunInspection>).pipe(
    Effect.provideService(EngineStore.RunInspection.RunInspection, store),
    Effect.provideService(Logger.CurrentLoggers, new Set([Logger.make((entry) => void logs.push(Logger.formatStructured.log(entry)))])),
  ))
  return { exit, revision: logs.filter((log) => log.message === "run.retry.revision") }
}

// Inject a store whose pinned child's payload can't be read. The run's own payload would run the latest: the step fails
// on the child's read instead, before it asks the engine's runtime for anything, and logs why.
test("a pinned Retry whose pinned child can't be read fails the step before starting anything, logged", async () => {
  const { exit, revision } = await pinnedRetry(pinnedStore((runId) => Effect.fail(new EngineStore.RunInspection.RunNotFound({ runId }))))
  expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause) ? Cause.squash(exit.cause) : exit)
    .toEqual(new EngineStore.RunInspection.RunNotFound({ runId: "r/code" }))
  expect(revision).toEqual([
    expect.objectContaining({
      level: "WARN",
      annotations: expect.objectContaining({ feature: "runs", outcome: "unread", errorCode: "@smthrs/engine-store/RunNotFound" }),
    }),
  ])
})

// Inject a store whose pinned child's payload names no revision: refused, never the run's own payload.
test("a pinned Retry whose pinned child names no revision is refused not_retryable, logged", async () => {
  const { exit, revision } = await pinnedRetry(pinnedStore(() => Effect.succeed({ flowName: FLOW_CODE, payload: { name: "hello" } })))
  expect(exit).toEqual(Exit.fail(new RunActRefused({ code: "not_retryable" })))
  expect(revision).toEqual([
    expect.objectContaining({ level: "WARN", annotations: expect.objectContaining({ feature: "runs", outcome: "malformed" }) }),
  ])
})

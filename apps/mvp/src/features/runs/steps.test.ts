import { EngineStore } from "@smthrs/flows"
import { Effect, Logger } from "effect"
import { expect, test } from "vitest"
import { FLOW_CODE } from "../flows-ui/reference"
import { list, retry } from "./steps"

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

// Inject a store whose pinned child's payload can't be read: the retry falls back to the run's own payload, logged.
test("a pinned Retry whose pinned child can't be read logs run.retry.revision with its code", async () => {
  const logs: Array<ReturnType<typeof Logger.formatStructured.log>> = []
  const run = { runId: "r", flowName: "flow/run", status: "completed" as const, createdAtMs: 1, startedAtMs: 1, finishedAtMs: 2, parentRunId: null, cancelRequestedAtMs: null, waiting: null, lastSeq: 1, origin: null }
  const service = EngineStore.RunInspection.RunInspection.of({
    inspect: (runId) => Effect.succeed({
      run: { ...run, runId, input: { text: "{}", bytes: 2, clipped: false }, result: null },
      steps: [],
      children: [{ ...run, runId: "r/code", flowName: FLOW_CODE, parentRunId: runId }],
      journal: { events: [], afterSeq: -1, nextSeq: -1, hasMore: false },
    } as never),
    payload: (runId) => runId === "r"
      ? Effect.succeed({ flowName: "flow/run", payload: {} })
      : Effect.fail(new EngineStore.RunInspection.RunNotFound({ runId })),
    list: () => Effect.die("unused"),
  })
  // The step goes on to decode and start the retry, which this test doesn't provide: only its log line is asserted.
  await Effect.runPromise(Effect.exit(retry({ runId: "r", version: "pinned" }) as unknown as Effect.Effect<unknown, unknown, EngineStore.RunInspection.RunInspection>).pipe(
    Effect.provideService(EngineStore.RunInspection.RunInspection, service),
    Effect.provideService(Logger.CurrentLoggers, new Set([Logger.make((entry) => void logs.push(Logger.formatStructured.log(entry)))])),
  ))
  expect(logs.filter((log) => log.message === "run.retry.revision")).toEqual([
    expect.objectContaining({
      level: "WARN",
      annotations: expect.objectContaining({ feature: "runs", outcome: "unread", errorCode: "@smthrs/engine-store/RunNotFound" }),
    }),
  ])
})

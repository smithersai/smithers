import { EngineStore } from "@smthrs/flows"
import { Effect } from "effect"
import { expect, test } from "vitest"
import { list } from "./steps"

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

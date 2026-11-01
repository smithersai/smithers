import { Collection } from "@smthrs/effect-tanstack-db"
import { Deferred, Effect, Exit, Scope, Stream } from "effect"
import { expect, test } from "vitest"
import { HOME_HREF, LOCAL_RECIPIENT } from "../attention/contract"
import { Notice } from "../attention/schema"
import { followNotice, noticeRow, NOTICE_TEXT, TimelineNotice } from "./notice"
import { makeLane, followPhases, followSummaries, STOPPING_FAILURES, type Everything } from "./store"
import { SummaryFailed } from "./flow"
import { DispatchFailed, type FlowDispatch } from "../../flows/dispatch"
import { Message } from "../chat/schema"
import { exchangeUnits, planOf } from "./marks"

const scoped = async <A>(use: (scope: Scope.Closeable) => Promise<A>) => {
  const scope = Effect.runSync(Scope.make())
  try { return await use(scope) } finally { await Effect.runPromise(Scope.close(scope, Exit.void)) }
}
const collections = Effect.gen(function* () {
  const state = yield* Collection.local<TimelineNotice, string>({ id: `notice-${crypto.randomUUID()}`, schema: TimelineNotice, getKey: row => row.id })
  const launches = yield* Collection.local<Notice, string>({ id: `launches-${crypto.randomUUID()}`, schema: Notice, getKey: row => row.subject })
  return { state, launches }
})

test.each(["unconfigured", "capped", "credit", "unavailable", "server"])("a lane stopped by %s says so once, to the rail and on the stack", cause => scoped(async scope => {
  expect(STOPPING_FAILURES).toContain(cause)
  const lane = await Effect.runPromise(makeLane)
  const { state, launches } = await Effect.runPromise(Scope.provide(scope)(collections))
  Effect.runFork(Effect.forkIn(followNotice(lane, state, launches), scope))
  // However many followers fail that way, the first stop is the cause.
  await Effect.runPromise(lane.stop(cause))
  await Effect.runPromise(lane.stop(cause))
  await Effect.runPromise(Effect.sleep("20 millis"))
  const [row] = await Effect.runPromise(state.toArray)
  expect(row).toMatchObject({ id: "notice", code: cause, text: NOTICE_TEXT[cause] })
  const stacked = await Effect.runPromise(launches.toArray)
  expect(stacked.map(notice => notice.subject)).toEqual([`timeline-summaries:${cause}`])
  expect(stacked[0]).toMatchObject({ recipient: LOCAL_RECIPIENT, kind: "write", state: "failed", title: NOTICE_TEXT[cause] })
}))

test("a stop's cause is readable the moment the stop is seen", async () => {
  const lane = await Effect.runPromise(makeLane)
  const seen = Effect.runPromise(Deferred.await(lane.stopped).pipe(Effect.map(() => lane.stoppedFor())))
  await Effect.runPromise(lane.stop("credit"))
  expect(await seen).toBe("credit")
})

test("a lane stopped without a named cause says unavailable, never nothing", () => scoped(async scope => {
  const lane = await Effect.runPromise(makeLane)
  const { state, launches } = await Effect.runPromise(Scope.provide(scope)(collections))
  Effect.runFork(Effect.forkIn(followNotice(lane, state, launches), scope))
  await Effect.runPromise(Deferred.succeed(lane.stopped, undefined))
  await expect.poll(async () => (await Effect.runPromise(state.toArray))[0]?.code).toBe("unavailable")
  expect((await Effect.runPromise(state.toArray))[0]!.text).toBe(NOTICE_TEXT.unavailable)
}))

test("a lane stopped for a cause with no words of its own reads as unavailable", () => scoped(async scope => {
  const lane = await Effect.runPromise(makeLane)
  const { state, launches } = await Effect.runPromise(Scope.provide(scope)(collections))
  Effect.runFork(Effect.forkIn(followNotice(lane, state, launches), scope))
  await Effect.runPromise(lane.stop("something-new"))
  await expect.poll(async () => (await Effect.runPromise(state.toArray))[0]?.text).toBe(NOTICE_TEXT.unavailable)
}))

test("every failure that stops a lane has product words, and an unknown one reads as unavailable", () => {
  for (const code of STOPPING_FAILURES) expect(NOTICE_TEXT[code]).toBeDefined()
  expect(noticeRow("anything", "2026-10-31T00:00:00Z").title).toBe(NOTICE_TEXT.unavailable)
  expect(noticeRow("unconfigured", "2026-10-31T00:00:00Z").href).toBe("/settings")
  expect(noticeRow("capped", "2026-10-31T00:00:00Z").href).toBe(HOME_HREF)
})

const rows = Array.from({ length: 8 }, (_, n) => [
  { id: `q${n}`, role: "user", status: "done", text: `Question ${n}`, phase: "" },
  { id: `a${n}`, role: "assistant", status: "done", text: `Answer ${n}`, questionId: `q${n}` },
]).flat()
const whole: Everything = {
  toArray: Effect.succeed(rows),
  changes: () => Stream.make(rows.map(value => ({ type: "insert" as const, key: value.id, value: { ...value }, previousValue: undefined })) as never).pipe(Stream.concat(Stream.never)),
}
const faulty = (code: "capped" | "credit" | "unconfigured" | "unavailable" | "invalid" | undefined) => {
  const asked: Array<string> = []
  const dispatch = {
    dispatch: (name: string) => Effect.sync(() => {
      asked.push(name)
      return code === undefined ? { _tag: "Done" as const, value: { spans: 1 } } : { _tag: "Failed" as const, error: new SummaryFailed({ code }) }
    }),
  } as unknown as FlowDispatch["Service"]
  return { asked, dispatch }
}

test.each(["capped", "credit", "unconfigured", "unavailable"] as const)("a segmentation failing %s stops the lane once", code => scoped(async scope => {
  const lane = await Effect.runPromise(makeLane)
  const { asked, dispatch } = faulty(code)
  Effect.runFork(Effect.forkIn(followPhases(whole, dispatch, lane), scope))
  await expect.poll(() => lane.stoppedFor(), { timeout: 8_000 }).toBe(code)
  expect(asked).toEqual(["timeline/phases"])
}), 10_000)

test("an unusable answer belongs to its call: the lane goes on, and the plan isn't asked twice", () => scoped(async scope => {
  const lane = await Effect.runPromise(makeLane)
  const { asked, dispatch } = faulty("invalid")
  Effect.runFork(Effect.forkIn(followPhases(whole, dispatch, lane), scope))
  await expect.poll(() => asked.length, { timeout: 8_000 }).toBe(1)
  expect(lane.stoppedFor()).toBeUndefined()
}), 10_000)

test("a conversation that can't be read leaves phases for the next settle, without stopping the lane", () => scoped(async scope => {
  const lane = await Effect.runPromise(makeLane)
  const { asked, dispatch } = faulty(undefined)
  const unreadable: Everything = { ...whole, toArray: Effect.fail(new Error("the collection is gone")) as never }
  Effect.runFork(Effect.forkIn(followPhases(unreadable, dispatch, lane), scope))
  await Effect.runPromise(Effect.sleep("3500 millis"))
  expect(asked).toEqual([])
  expect(lane.stoppedFor()).toBeUndefined()
}), 10_000)

// Faults enter at the Effect dispatch service; collections and the notification follower are real.
test("every preventing cause is replayed to a late subscriber once, even after the lane stops", () => scoped(async scope => {
  const lane = await Effect.runPromise(makeLane)
  await Effect.runPromise(lane.report("invalid"))
  await Effect.runPromise(lane.report("invalid"))
  await Effect.runPromise(lane.stop("credit"))
  await Effect.runPromise(lane.report("refused"))
  const { state, launches } = await Effect.runPromise(Scope.provide(scope)(collections))
  Effect.runFork(Effect.forkIn(followNotice(lane, state, launches), scope))
  await expect.poll(async () => (await Effect.runPromise(launches.toArray)).map(row => row.ref).sort()).toEqual(["credit", "invalid", "refused"])
  await Effect.runPromise(lane.report("invalid"))
  await Effect.runPromise(lane.stop("credit"))
  await Effect.runPromise(lane.stop("server"))
  await expect.poll(async () => (await Effect.runPromise(launches.toArray)).length).toBe(4)
  expect((await Effect.runPromise(state.toArray)).map(({ id, code, text }) => ({ id, code, text }))).toEqual([{ id: "notice", code: "credit", text: NOTICE_TEXT.credit }])
  expect(lane.stoppedFor()).toBe("credit")
}))

test.each(["invalid", "refused", "dispatch", "defect"] as const)("message %s raises one notification and lets later messages run", fault => scoped(async scope => {
  const lane = await Effect.runPromise(makeLane)
  const { state, launches } = await Effect.runPromise(Scope.provide(scope)(collections))
  const messages = await Effect.runPromise(Scope.provide(scope)(Collection.local<Message, Collection.Key>({ id: crypto.randomUUID(), schema: Message, getKey: row => row.id })))
  await Effect.runPromise(messages.insert([0, 1].map(n => ({ id: `m${n}`, role: "assistant", status: "done", text: "Settled answer", questionId: null, failure: null, modelId: null, stopReason: null, inputTokens: null, outputTokens: null, position: n, createdAt: "2026-10-31", updatedAt: "2026-10-31" }))))
  const asked: string[] = []
  const dispatch = { dispatch: (_: string, p: { id: string }) => Effect.suspend(() => {
    asked.push(p.id)
    return fault === "dispatch" ? Effect.fail(new DispatchFailed({ flow: "timeline/summarize", reason: "unavailable" }))
      : fault === "defect" ? Effect.die("private provider output")
      : Effect.succeed({ _tag: "Failed", error: new SummaryFailed({ code: fault }) })
  }) } as unknown as FlowDispatch["Service"]
  Effect.runFork(Effect.forkIn(followNotice(lane, state, launches), scope))
  Effect.runFork(Effect.forkIn(followSummaries(messages, messages, dispatch, lane), scope))
  await expect.poll(() => asked.length).toBe(2)
  const code = fault === "dispatch" ? "dispatch:unavailable" : fault === "defect" ? "defect" : fault
  await expect.poll(async () => (await Effect.runPromise(launches.toArray)).map(row => row.ref)).toEqual([code])
  expect(await Effect.runPromise(Deferred.isDone(lane.stopped))).toBe(false)
  expect(await Effect.runPromise(state.toArray)).toEqual([])
  expect(JSON.stringify(await Effect.runPromise(launches.toArray))).not.toContain("private provider output")
}))

test.each(["invalid", "refused", "dispatch", "defect"] as const)("phase %s raises a notification without stopping the lane", fault => scoped(async scope => {
  const lane = await Effect.runPromise(makeLane)
  const { state, launches } = await Effect.runPromise(Scope.provide(scope)(collections))
  const dispatch = { dispatch: () => fault === "dispatch" ? Effect.fail(new DispatchFailed({ flow: "timeline/phases", reason: "refused" }))
    : fault === "defect" ? Effect.die("private phase text")
    : Effect.succeed({ _tag: "Failed", error: new SummaryFailed({ code: fault }) }) } as unknown as FlowDispatch["Service"]
  Effect.runFork(Effect.forkIn(followNotice(lane, state, launches), scope))
  Effect.runFork(Effect.forkIn(followPhases(whole, dispatch, lane), scope))
  await expect.poll(async () => (await Effect.runPromise(launches.toArray)).map(row => row.ref), { timeout: 8_000 }).toEqual([fault === "dispatch" ? "dispatch:refused" : fault])
  expect(await Effect.runPromise(Deferred.isDone(lane.stopped))).toBe(false)
  expect(await Effect.runPromise(state.toArray)).toEqual([])
}), 10_000)


test("streaming-only changes do not read or dispatch a segmentation", async () => {
  const { asked, dispatch } = faulty("invalid")
  const lane = await Effect.runPromise(makeLane)
  const changing: Everything = {
    toArray: Effect.die("An unsettled change must not be read"),
    changes: () => Stream.make([{ type: "update", key: "q0", value: { ...rows[0], status: "streaming" }, previousValue: undefined }] as never),
  }
  await Effect.runPromise(followPhases(changing, dispatch, lane))
  expect(asked).toEqual([])
})

test("failed-answer changes still trigger segmentation, but a settled revision is not dispatched again", async () => {
  const { asked, dispatch } = faulty("invalid")
  const lane = await Effect.runPromise(makeLane)
  const changes: Everything = { ...whole, changes: () => Stream.make([{ type: "update", key: "a0", value: { ...rows[1], status: "failed" }, previousValue: undefined }] as never) }
  await Effect.runPromise(followPhases(changes, dispatch, lane))
  expect(asked).toEqual(["timeline/phases"])
  expect(lane.settled.has(planOf(exchangeUnits(rows), 1)!.revision)).toBe(true)
  await Effect.runPromise(followPhases(changes, dispatch, lane))
  expect(asked).toEqual(["timeline/phases"])
})


test("a global failure reported before the stop receipt still explains the rail once", () => scoped(async scope => {
  const lane = await Effect.runPromise(makeLane)
  const { state, launches } = await Effect.runPromise(Scope.provide(scope)(collections))
  Effect.runFork(Effect.forkIn(followNotice(lane, state, launches), scope))
  await Effect.runPromise(lane.report("server"))
  await expect.poll(async () => (await Effect.runPromise(state.toArray))[0]?.code).toBe("server")
  expect(lane.stoppedFor()).toBeUndefined()
  await Effect.runPromise(lane.stop("server"))
  await expect.poll(async () => (await Effect.runPromise(launches.toArray)).length).toBe(1)
  expect(lane.stoppedFor()).toBe("server")
}))

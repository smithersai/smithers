import { describe, expect, it } from "@effect/vitest"
import { Control } from "@smthrs/control/Control"
import type { ControlEvent, RunSummary } from "@smthrs/control/ControlSchema"
import { Effect, Schema, Stream } from "effect"
import { readFileSync } from "node:fs"
import * as RuntimeBridge from "../src/RuntimeBridge.ts"
import { emit, stack } from "./GatewayStack.ts"

const runId = "bridge-cursor-run"
const summary: RunSummary = {
  runId,
  flowId: "fixture/cursor",
  status: "running",
  createdAt: 1,
  updatedAt: 1
}
const request = { protocol: RuntimeBridge.protocol, runId, limit: 1 } as const

// The journal and expanded watch are real. The listing supplies the identity
// of the synthetic journal partition without launching an unrelated flow.
const listed = (control: Control["Service"]): Control["Service"] => ({
  ...control,
  list: () => Effect.succeed({ _tag: "runs", items: [summary] })
})

describe("RuntimeBridge observation cursors", () => {
  it.effect("matches the shared Go/TypeScript reconnect pages", () =>
    Effect.gen(function*() {
      const fixture = JSON.parse(
        readFileSync(new URL("../testdata/runtime-bridge-v1.json", import.meta.url), "utf8")
      ) as {
        readonly cursorPages: ReadonlyArray<{
          readonly afterCursor: string
          readonly events: ReadonlyArray<ControlEvent>
          readonly nextCursor: string
          readonly hasMore: boolean
        }>
      }
      const events = fixture.cursorPages.flatMap((page) => page.events)
      for (const [index, page] of fixture.cursorPages.entries()) {
        const control = {
          list: () => Effect.succeed({ _tag: "runs", items: [summary] }),
          watch: (filter) => {
            const after = filter.afterCursor ??
              (filter.afterSequence === undefined ? undefined : { sequence: filter.afterSequence })
            return index === 0 ?
              Stream.empty :
              Stream.fromIterable(events.filter((event) =>
                after === undefined || event.sequence > after.sequence ||
                event.sequence === after.sequence && after.offset !== undefined &&
                  (event.cursor?.offset === undefined || event.cursor.offset > after.offset)
              ))
          }
        } satisfies Pick<Control["Service"], "list" | "watch">
        const result = yield* RuntimeBridge.observe(
          control as unknown as Control["Service"],
          Schema.decodeUnknownSync(RuntimeBridge.ObserveRequest)({ ...request, afterCursor: page.afterCursor })
        )
        expect(result).toMatchObject({ events: page.events, nextCursor: page.nextCursor, hasMore: page.hasMore })
      }
    }))

  it.effect("pages every member of a real Control expansion without loss or duplication", () =>
    Effect.gen(function*() {
      const control = listed(yield* Control)
      yield* emit(runId, "flows/notifications/Promoted", { boundary: "turn", ids: ["first", "second"] })
      yield* emit(runId, "control.agent.turn-opened", { seat: "fixture" })
      const expected = Array.from(yield* Stream.runCollect(control.watch({ runId, follow: false })))
      expect(expected.map((event) => event.cursor)).toEqual([
        { sequence: 0, offset: 0 },
        { sequence: 0, offset: 1 },
        { sequence: 0 },
        { sequence: 1 }
      ])

      const observed: Array<ControlEvent> = []
      const cursors: Array<string> = []
      let afterCursor: string | undefined
      for (let page = 0; page < expected.length; page++) {
        const input = Schema.decodeUnknownSync(RuntimeBridge.ObserveRequest)({
          ...request,
          ...(afterCursor === undefined ? {} : { afterCursor })
        })
        const result = yield* RuntimeBridge.observe(control, input)
        observed.push(...result.events)
        cursors.push(result.nextCursor)
        expect(result.hasMore).toBe(page < expected.length - 1)
        afterCursor = result.nextCursor
      }
      expect(observed).toEqual(expected)
      expect(cursors).toEqual(["v1:0:0", "v1:0:1", "0", "1"])
      const complete = yield* RuntimeBridge.observe(control, { ...request, afterCursor: "1" })
      expect(complete).toMatchObject({ events: [], nextCursor: "1", hasMore: false })

      const legacy = yield* RuntimeBridge.observe(control, { ...request, afterCursor: "0" })
      expect(legacy.events).toEqual(expected.slice(3))
    }).pipe(Effect.provide(stack())))

  it.effect("keeps an empty seed until sequence zero is committed", () =>
    Effect.gen(function*() {
      const control = listed(yield* Control)
      const empty = yield* RuntimeBridge.observe(control, request)
      expect(empty).toMatchObject({ events: [], nextCursor: "", hasMore: false })
      yield* emit(runId, "control.agent.turn-opened", { seat: "fixture" })
      const next = yield* RuntimeBridge.observe(
        control,
        Schema.decodeUnknownSync(RuntimeBridge.ObserveRequest)({
          ...request,
          afterCursor: empty.nextCursor
        })
      )
      expect(next.events.map((event) => event.sequence)).toEqual([0])
      expect(next.nextCursor).toBe("0")
    }).pipe(Effect.provide(stack())))

  it.each(["", "0", "12", "v1:0:0", "v1:12:3", "v1:9007199254740990:0"])(
    "accepts canonical cursor %j",
    (afterCursor) => {
      expect(() => Schema.decodeUnknownSync(RuntimeBridge.ObserveRequest)({ ...request, afterCursor })).not.toThrow()
    }
  )

  it.effect.each([
    "-1",
    "01",
    "1.0",
    "1e2",
    " 1",
    "1\n",
    "v1:1:0\n",
    "v1:1",
    "v1:1:",
    "v1:01:0",
    "v1:1:01",
    "v2:1:0",
    "v1:1:-1",
    "v1:1:0:0",
    "9007199254740991",
    "9007199254740992",
    "v1:9007199254740991:0",
    "v1:1:9007199254740991"
  ])("refuses invalid cursor %j before reading Control", (afterCursor) =>
    Effect.gen(function*() {
      let reads = 0
      const control = {
        list: () => {
          reads++
          return Effect.succeed({ _tag: "runs" as const, items: [summary] })
        },
        watch: () => {
          reads++
          return Stream.empty
        }
      } as unknown as Control["Service"]
      const error = yield* Effect.flip(RuntimeBridge.observe(control, { ...request, afterCursor }))
      expect(error).toMatchObject({ code: "invalid_request", retryable: false })
      expect(reads).toBe(0)
    }))
})

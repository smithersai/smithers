import * as Channels from "@smthrs/control/Channels"
import { Unauthorized, Unavailable } from "@smthrs/control/ControlError"
import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import * as Channel from "../src/core/Channel.ts"
import { CursorStore } from "../src/core/CursorStore.ts"
import type { ExternalEvent } from "../src/core/ExternalEvent.ts"
import { runWithCursor } from "../src/core/Source.ts"
import { recorded, register, runInFlow, withChannels } from "./SourceDoorHarness.ts"

const event = (id: number, overrides: Partial<ExternalEvent> = {}): ExternalEvent => ({
  source: "chat",
  eventName: "integration:chat:message",
  correlationId: "room:1",
  payload: { id, text: `message ${id}` },
  dedupeKey: `chat:${id}`,
  receivedAtMs: 1_000 + id,
  ...overrides
})

describe("Channel.fromSource", () => {
  it("starts the routed flow with the polled event and answers with a receipt named by its dedupe key", async () => {
    const seen = recorded()
    const door = Channel.fromSource({ name: "chat", route: Channel.startFlow("triage") })
    const receipt = await withChannels(Effect.andThen(register(door), door.ingest(event(1))), seen)
    expect(receipt).toEqual({ _tag: "Accepted", receiptId: "chat:1" })
    expect(seen.calls).toEqual(["plan", "run"])
    // The flow's input is the whole event, receipt time included.
    expect(seen.inputs).toEqual([event(1)])
  })

  it("signals the routed run with the event's signal name and payload", async () => {
    const seen = recorded()
    const door = Channel.fromSource({ name: "chat", route: Channel.signalRun("run-7") })
    await withChannels(Effect.andThen(register(door), door.ingest(event(2))), seen)
    expect(seen.calls).toEqual(["signal:run-7:integration:chat:message"])
    expect(seen.inputs).toEqual([{ id: 2, text: "message 2" }])
  })

  it("answers an event polled again after a crash as already applied, without a second start", async () => {
    const seen = recorded()
    const door = Channel.fromSource({ name: "chat", route: Channel.startFlow("triage") })
    const again = await withChannels(
      Effect.gen(function*() {
        yield* register(door)
        yield* door.ingest(event(3))
        // The same update fetched by a later poll: a new receipt time and a different key order.
        const { dedupeKey, payload, ...rest } = event(3, { receivedAtMs: 99_000 })
        return yield* door.ingest({ payload, dedupeKey, ...rest })
      }),
      seen
    )
    expect(again._tag).toBe("AlreadyApplied")
    expect(seen.calls).toEqual(["plan", "run"])
  })

  it("refuses a delivery that did not come through the door, before the event is decoded or routed", async () => {
    const seen = recorded()
    const routed: Array<string> = []
    const door = Channel.fromSource({
      name: "chat",
      route: (found) => {
        routed.push(found.dedupeKey)
        return Channel.startFlow("triage")(found)
      }
    })
    const forged = (headers: Record<string, string>) =>
      Effect.flatMap(Channels.Channels, (channels) =>
        Effect.flip(channels.ingest({
          channel: "chat",
          raw: { body: new TextEncoder().encode(JSON.stringify(event(4))), headers, idempotencyKey: "chat:4" }
        })))
    const failures = await withChannels(
      Effect.gen(function*() {
        yield* register(door)
        return [
          // What an HTTP route mounted on this channel's name by mistake would hand over.
          yield* forged({}),
          yield* forged({ "x-smithers-source-pass": "" }),
          yield* forged({ "x-smithers-source-pass": "0".repeat(64) }),
          // Another door with the same name holds another pass.
          yield* Effect.flip(Channel.fromSource({ name: "chat", route: Channel.startFlow("other") }).ingest(event(4)))
        ]
      }),
      seen
    )
    for (const failure of failures.slice(0, 3)) {
      expect(failure).toMatchObject({
        _tag: "/control/Unauthorized",
        message: "chat takes events from its polling source only."
      })
    }
    expect(failures[3]).toMatchObject({
      reason: "delivery-failed",
      details: { channel: "chat", control: "/control/Unauthorized", retryable: false }
    })
    expect(failures[3]).toBeInstanceOf(Error)
    expect((failures[3] as Error).cause).toBeInstanceOf(Unauthorized)
    expect(routed).toEqual([])
    expect(seen.calls).toEqual([])
  })

  it.each([
    [
      "an event name outside the integration namespace",
      event(5, { eventName: "message" }),
      "chat source event is not a valid event."
    ],
    ["an empty dedupe key", event(5, { dedupeKey: "" }), "chat source event is not a valid event."],
    [
      "a payload JSON cannot carry",
      event(5, { payload: { id: 5n } as unknown as ExternalEvent["payload"] }),
      "chat source event is not JSON."
    ]
  ])("refuses %s as decode-failed and starts nothing", async (_case, malformed, summary) => {
    const seen = recorded()
    const door = Channel.fromSource({ name: "chat", route: Channel.startFlow("triage") })
    const failure = await withChannels(Effect.andThen(register(door), Effect.flip(door.ingest(malformed))), seen)
    expect(failure).toMatchObject({
      reason: "decode-failed",
      summary,
      details: { channel: "chat", retryable: false }
    })
    expect(seen.calls).toEqual([])
  })

  it("reports a control plane that cannot take the event as a retryable delivery failure", async () => {
    const seen = recorded()
    const door = Channel.fromSource({ name: "chat", route: Channel.startFlow("triage") })
    const [unregistered, unavailable] = await withChannels(
      Effect.gen(function*() {
        const unregistered = yield* Effect.flip(door.ingest(event(6)))
        yield* register(door)
        return [unregistered, yield* Effect.flip(door.ingest(event(6)))] as const
      }),
      seen,
      { run: Effect.fail(new Unavailable({ feature: "launch", ticket: "fault" })) }
    )
    for (const failure of [unregistered, unavailable]) {
      expect(failure).toMatchObject({
        reason: "delivery-failed",
        summary: "chat source event did not reach the control plane.",
        details: { channel: "chat", control: "/control/Unavailable", retryable: true }
      })
    }
    // Only the registered attempt reached the control plane.
    expect(seen.calls).toEqual(["plan", "run"])
  })

  it("handles a batch in order and stops at the first event that waits for a plan approval", async () => {
    const delivered = recorded()
    const door = Channel.fromSource({ name: "chat", route: Channel.startFlow("triage") })
    await withChannels(Effect.andThen(register(door), door.handle([event(7), event(8)])), delivered)
    expect(delivered.inputs).toEqual([event(7), event(8)])

    const parked = recorded()
    const failure = await withChannels(
      Effect.andThen(register(door), Effect.flip(door.handle([event(7), event(8)]))),
      parked,
      { run: Effect.succeed({ _tag: "Parked", receiptId: "chat:7", planId: "plan", status: "waiting-approval" }) }
    )
    expect(failure).toMatchObject({
      reason: "delivery-failed",
      summary: "chat source event waits for a plan approval and has not started its flow.",
      details: { channel: "chat", retryable: true, planId: "plan" }
    })
    expect(parked.inputs).toEqual([event(7)])
  })

  it("fails a batch whose event reuses a dedupe key with different content, for good", async () => {
    const seen = recorded()
    const door = Channel.fromSource({ name: "chat", route: Channel.startFlow("triage") })
    const failure = await withChannels(
      Effect.andThen(
        register(door),
        Effect.flip(door.handle([event(9), event(9, { payload: { id: 9, text: "edited" } })]))
      ),
      seen
    )
    expect(failure).toMatchObject({
      reason: "delivery-failed",
      summary: "chat source event reuses a dedupe key with different content.",
      details: { channel: "chat", retryable: false }
    })
    expect(seen.calls).toEqual(["plan", "run"])
  })

  it("counts a signal to a run that has ended as delivered", async () => {
    const seen = recorded()
    const door = Channel.fromSource({ name: "chat", route: Channel.signalRun("run-7") })
    await withChannels(Effect.andThen(register(door), door.handle([event(10), event(11)])), seen, {
      signal: Effect.succeed({ _tag: "Terminal", runId: "run-7", status: "completed" })
    })
    expect(seen.calls).toHaveLength(2)
  })

  it("projects nothing by default and what the source declares otherwise", () => {
    const run = { updatedAt: 123 } as Parameters<Channels.Channel["project"]>[0]
    const quiet = Channel.fromSource({ name: "chat", route: Channel.startFlow("triage") })
    expect(quiet.channel.project(run, undefined)).toEqual({ cursor: "123", operation: "noop", message: null })
    const posting = Channel.fromSource({
      name: "chat",
      route: Channel.startFlow("triage"),
      project: (summary) => ({ cursor: String(summary.updatedAt), operation: "post", message: "done" })
    })
    expect(posting.channel.project(run, undefined)).toEqual({ cursor: "123", operation: "post", message: "done" })
  })
})

describe("a polling source behind Channel.fromSource", () => {
  const door = Channel.fromSource({ name: "chat", route: Channel.startFlow("triage") })
  const poll = (polled: Array<string | null>) => (cursor: string | null) =>
    Effect.sync(() => {
      polled.push(cursor)
      return { events: [event(1), event(2)], cursor: "3" }
    })

  it("starts one flow per polled event, then commits the cursor", async () => {
    const seen = recorded()
    const polled: Array<string | null> = []
    const cursor = await runInFlow(
      Effect.gen(function*() {
        yield* register(door)
        yield* runWithCursor("chat", poll(polled), door.handle, { maxTurns: 1 })
        return yield* Effect.flatMap(CursorStore, (cursors) => cursors.get("chat"))
      }),
      seen
    )
    expect(polled).toEqual([null])
    expect(seen.calls).toEqual(["plan", "run", "plan", "run"])
    expect(seen.inputs).toEqual([event(1), event(2)])
    expect(cursor).toBe("3")
  })

  it("leaves the cursor behind an event the control plane did not take", async () => {
    const seen = recorded()
    const [failure, cursor] = await runInFlow(
      Effect.gen(function*() {
        yield* register(door)
        const failure = yield* Effect.flip(runWithCursor("chat", poll([]), door.handle, { maxTurns: 1 }))
        return [failure.reason, yield* Effect.flatMap(CursorStore, (cursors) => cursors.get("chat"))] as const
      }),
      seen,
      { run: Effect.fail(new Unavailable({ feature: "launch", ticket: "fault" })) }
    )
    expect(failure).toBe("delivery-failed")
    expect(cursor).toBeNull()
  })
})

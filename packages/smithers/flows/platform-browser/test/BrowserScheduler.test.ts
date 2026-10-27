/**
 * The browser's fiber scheduler: queued fiber work goes to the event loop as
 * messages on a `MessageChannel`, never as `setTimeout(f, 0)`, which a browser
 * holds to 4 ms once nested five deep. Every case runs over Node's own
 * `MessageChannel`.
 */
import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Scheduler from "effect/Scheduler"
import { afterEach } from "vitest"
import { BrowserScheduler } from "../src/index.ts"

/** Every channel a case opened, closed after it so no port keeps the process alive. */
const opened: Array<MessageChannel> = []

afterEach(() => {
  for (const channel of opened.splice(0)) {
    channel.port1.close()
    channel.port2.close()
  }
})

/** A real `MessageChannel` constructor that counts the messages posted on the channels it makes. */
const counted = () => {
  const posted = { messages: 0, channels: 0 }
  class Counted extends MessageChannel {
    constructor() {
      super()
      opened.push(this)
      posted.channels++
      const post = this.port2.postMessage.bind(this.port2)
      this.port2.postMessage = (message: unknown) => {
        posted.messages++
        post(message)
      }
    }
  }
  return { posted, MessageChannel: Counted as unknown as new() => BrowserScheduler.ChannelLike }
}

/** Waits until `ran` holds `length` entries, or a second passes. */
const settled = (ran: ReadonlyArray<unknown>, length: number) =>
  new Promise<void>((resolve, reject) => {
    const started = Date.now()
    const poll = () =>
      ran.length >= length
        ? resolve()
        : Date.now() - started > 1_000
        ? reject(new Error("timed out"))
        : setTimeout(poll)
    poll()
  })

describe("BrowserScheduler.immediate", () => {
  it("runs each task once, in the order posted, as a message on the channel", async () => {
    const { posted, MessageChannel: Channel } = counted()
    const schedule = BrowserScheduler.immediate(new Channel())
    const ran: Array<number> = []
    for (const n of [1, 2, 3]) schedule(() => ran.push(n))
    expect(ran).toEqual([])
    await settled(ran, 3)
    expect(ran).toEqual([1, 2, 3])
    expect(posted.messages).toBe(3)
  })

  it("never runs a task cancelled before its message arrives", async () => {
    const { MessageChannel: Channel } = counted()
    const enqueue = BrowserScheduler.immediate(new Channel())
    const ran: Array<string> = []
    enqueue(() => ran.push("first"))
    const cancel = enqueue(() => ran.push("cancelled"))
    enqueue(() => ran.push("last"))
    cancel()
    await settled(ran, 2)
    // The cancelled task's message still arrives, and runs nothing.
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(ran).toEqual(["first", "last"])
  })
})

describe("BrowserScheduler.make", () => {
  it("dispatches a program's fiber work over a MessageChannel where the global has no setImmediate", async () => {
    const { posted, MessageChannel: Channel } = counted()
    const scheduler = BrowserScheduler.make({ MessageChannel: Channel })
    expect(scheduler).toBeInstanceOf(Scheduler.MixedScheduler)
    expect(scheduler.executionMode).toBe("async")
    const yields = 200
    const result = await Effect.runPromise(
      Effect.gen(function*() {
        let count = 0
        for (let i = 0; i < yields; i++) {
          yield* Effect.yieldNow
          count++
        }
        return count
      }),
      { scheduler }
    )
    expect(result).toBe(yields)
    expect(posted.channels).toBe(1)
    // Each yield waits for one message, not one timer.
    expect(posted.messages).toBeGreaterThanOrEqual(yields)
  })

  it.each([
    ["has setImmediate", { setImmediate: () => undefined }],
    ["has no MessageChannel", {}]
  ])("keeps Effect's default where the global %s", async (_, environment) => {
    const { posted, MessageChannel: Channel } = counted()
    const scheduler = BrowserScheduler.make(
      "setImmediate" in environment ? { ...environment, MessageChannel: Channel } : environment
    )
    expect(scheduler).toBeInstanceOf(Scheduler.MixedScheduler)
    expect(await Effect.runPromise(Effect.andThen(Effect.yieldNow, Effect.succeed("ran")), { scheduler })).toBe("ran")
    expect(posted.channels).toBe(0)
  })

  it("reads the global by default, which in Node has setImmediate", () => {
    const { posted } = counted()
    expect(BrowserScheduler.make()).toBeInstanceOf(Scheduler.MixedScheduler)
    expect(posted.channels).toBe(0)
  })
})

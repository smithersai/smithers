/**
 * The one guaranteed-once cleanup path a streamed turn hangs its bookkeeping on.
 *
 * `AppSession.turn` used to clear `busy` and drop the turn's AbortController in
 * a `TransformStream`'s `flush`, which does not run when the readable side is
 * cancelled or the source errors. A browser that navigated away therefore left
 * the session busy forever and every later turn answered 409. So the three
 * endings a stream can have are what this file asserts: close, source error,
 * and cancel, each settling exactly once.
 */
import { describe, expect, it } from "vitest"
import { track } from "../worker/stream.ts"
import { drain } from "./support/drain.ts"
import { recordingSource } from "./support/recordingSource.ts"

describe("track", () => {
  it("forwards every chunk in order and settles once when the source closes", async () => {
    let settled = 0
    const source = recordingSource(["one ", "two ", "three"])
    const text = await drain(track(source.stream, { onSettle: () => (settled += 1) }))
    expect(text).toBe("one two three")
    expect(settled).toBe(1)
  })

  it("settles once when the source errors, and surfaces that error", async () => {
    let settled = 0
    const boom = new Error("provider died")
    const source = recordingSource(["partial"], { fail: boom })
    const reader = track(source.stream, { onSettle: () => (settled += 1) }).getReader()
    await reader.read()
    await expect(reader.read()).rejects.toThrow("provider died")
    expect(settled).toBe(1)
  })

  it("cancels the source, reports the reason, and settles once when the consumer hangs up", async () => {
    let settled = 0
    const cancelled: Array<unknown> = []
    const source = recordingSource(["one ", "two "])
    const reader = track(source.stream, {
      onSettle: () => (settled += 1),
      onCancel: (reason) => cancelled.push(reason)
    }).getReader()
    await reader.read()
    await reader.cancel("navigated away")

    expect(cancelled).toEqual(["navigated away"])
    expect(source.cancels).toEqual(["navigated away"])
    expect(settled).toBe(1)
  })

  it("settles exactly once when a cancel arrives after the source already closed", async () => {
    let settled = 0
    const source = recordingSource([])
    const tracked = track(source.stream, { onSettle: () => (settled += 1) })
    const reader = tracked.getReader()
    await reader.read()
    await reader.cancel("late")
    expect(settled).toBe(1)
  })
})

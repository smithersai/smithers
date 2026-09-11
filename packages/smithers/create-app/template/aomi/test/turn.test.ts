/**
 * The lazy turn wrapper, driven with an injected loader.
 *
 * `worker/turn.ts` defers importing the agent runtime until the first request,
 * so the real loader pulls in `@smthrs/*`, QuickJS, and the tools directory.
 * The wrapper's own contract has nothing to do with any of that: it forwards
 * the inner stream, and it must stop the inner stream when the consumer hangs
 * up. Its `cancel` used to be a no-op with a comment claiming the inner stream
 * watched the caller's AbortSignal, which only an explicit cancel request ever
 * aborted, so a hangup left the provider running.
 */
import { describe, expect, it } from "vitest"
import { runTurn, type TurnOptions } from "../worker/turn.ts"
import { drain } from "./support/drain.ts"
import { recordingSource } from "./support/recordingSource.ts"

// The wrapper reads no field of its options; it hands them straight to the
// loaded implementation. So a test supplies a marker rather than a whole fake
// session, and asserts the marker arrived.
const marker = { probe: "turn-options" } as unknown as TurnOptions

describe("runTurn", () => {
  it("forwards the loaded implementation's stream and hands it the options", async () => {
    const seen: Array<TurnOptions> = []
    const inner = recordingSource(["{\"type\":\"text\"}\n", "{\"type\":\"done\"}\n"])
    const text = await drain(runTurn(marker, async () => ({
      runTurn: (options: TurnOptions) => {
        seen.push(options)
        return inner.stream
      }
    })))
    expect(text).toBe("{\"type\":\"text\"}\n{\"type\":\"done\"}\n")
    expect(seen).toEqual([marker])
  })

  it("cancels the inner stream when the consumer hangs up", async () => {
    const inner = recordingSource(["one", "two", "three"])
    const reader = runTurn(marker, async () => ({ runTurn: () => inner.stream })).getReader()
    await reader.read()
    await reader.cancel("client gone")
    expect(inner.cancels).toEqual(["client gone"])
  })

  it("cancels an implementation that only arrives after the hangup, and enqueues nothing", async () => {
    const inner = recordingSource(["never delivered"])
    let deliver: (() => void) | undefined
    const loaded = new Promise<void>((resolve) => (deliver = resolve))
    const stream = runTurn(marker, async () => {
      await loaded
      return { runTurn: () => inner.stream }
    })
    const reader = stream.getReader()
    // Cancel while the loader is still pending: the wrapper holds no reader yet.
    await reader.cancel("client gone")
    deliver!()
    // One turn of the event loop is enough for the pending loader to settle and
    // for the wrapper to cancel what it was handed.
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(inner.cancels).toEqual(["client gone"])
  })

  it("errors the stream when the implementation cannot be loaded", async () => {
    const stream = runTurn(marker, () => Promise.reject(new Error("module missing")))
    await expect(drain(stream)).rejects.toThrow("module missing")
  })
})

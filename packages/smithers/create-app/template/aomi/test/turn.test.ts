/**
 * The lazy turn wrapper, driven with an injected loader.
 *
 * `worker/turn.ts` defers importing the agent runtime until the first request,
 * so the real loader pulls in `@smthrs/*`, QuickJS, and the tools directory.
 * The wrapper's own contract has nothing to do with any of that: it hands the
 * options to the loaded implementation and returns what it returned, stream or
 * refusal, so the caller holds the implementation's own stream and a hangup
 * cancels it directly.
 */
import { describe, expect, it } from "vitest"
import { runTurn, type TurnOptions } from "../worker/turn.ts"
import { recordingSource } from "./support/recordingSource.ts"

// The wrapper reads no field of its options; it hands them straight to the
// loaded implementation. So a test supplies a marker rather than a whole fake
// session, and asserts the marker arrived.
const marker = { probe: "turn-options" } as unknown as TurnOptions

describe("runTurn", () => {
  it("returns the loaded implementation's own stream and hands it the options", async () => {
    const seen: Array<TurnOptions> = []
    const inner = recordingSource(["{\"type\":\"done\"}\n"])
    const result = await runTurn(marker, async () => ({
      runTurn: async (options: TurnOptions) => {
        seen.push(options)
        return inner.stream
      }
    }))
    expect(result).toBe(inner.stream)
    expect(seen).toEqual([marker])
    await (result as ReadableStream<Uint8Array>).cancel("client gone")
    expect(inner.cancels).toEqual(["client gone"])
  })

  it("returns a refusal unchanged", async () => {
    const refusal = { status: 503, error: "host_unconfigured", message: "Set the OPENAI_API_KEY secret" } as const
    expect(await runTurn(marker, async () => ({ runTurn: async () => refusal }))).toBe(refusal)
  })

  it("rejects when the implementation cannot be loaded", async () => {
    await expect(runTurn(marker, () => Promise.reject(new Error("module missing")))).rejects.toThrow("module missing")
  })
})

import * as Effect from "effect/Effect"
import { describe, expect, it } from "vitest"
import * as Channel from "../src/Channel.ts"

describe("Channel", () => {
  it("declares start and signal mappings without adding authority", async () => {
    const starts = Channel.make<{ readonly kind: "start"; readonly value: number }>({
      name: "starts",
      verify: () => Effect.void,
      inbound: (payload) => ({
        start: {
          flowId: "review",
          input: { value: payload.value }
        }
      })
    })
    const signals = Channel.make<{ readonly kind: "signal"; readonly value: boolean }>({
      name: "signals",
      verify: () => Effect.void,
      inbound: (payload) => ({
        signal: {
          runId: "run-1",
          stepId: "approval",
          value: payload.value
        }
      })
    })

    expect(starts.inbound({ kind: "start", value: 42 })).toEqual({
      start: { flowId: "review", input: { value: 42 } }
    })
    expect(signals.inbound({ kind: "signal", value: true })).toEqual({
      signal: { runId: "run-1", stepId: "approval", value: true }
    })
    expect("envelope" in starts).toBe(false)
    expect("capabilities" in starts).toBe(false)
    expect("run" in starts).toBe(false)
  })

  it("supports an optional pure outbound projection", () => {
    const channel = Channel.make<never, { readonly status: string }, string>({
      name: "projected",
      verify: () => Effect.void,
      inbound: (payload) => payload,
      outbound: (run) => `status:${run.status}`
    })

    expect(channel.outbound?.({ status: "running" })).toBe("status:running")
  })
})

import { describe, expect, it } from "@effect/vitest"
import { Stall } from "@smthrs/flow"
import { Schema } from "effect"

const run = (policy: Stall.Policy, rounds: ReadonlyArray<Stall.Observation>) => {
  let state = Stall.initial
  return rounds.map((observation) => {
    const next = Stall.observe(policy, state, observation)
    state = next.state
    return next.stalled
  })
}

describe("Stall", () => {
  it("resolves options and refuses a bound that cannot repeat", () => {
    expect(Stall.policy({ rounds: 3 })).toEqual({ rounds: 3, on: "stop" })
    expect(Stall.policy({ rounds: 2, on: "park" })).toEqual({ rounds: 2, on: "park" })
    for (const rounds of [1, 0, 2.5, Number.NaN]) expect(() => Stall.policy({ rounds })).toThrow(RangeError)
  })

  it("stalls on the same tree fingerprint", () => {
    expect(run(Stall.policy({ rounds: 2, on: "escalate" }), [{ tree: "a" }, { tree: "b" }, { tree: "b" }]))
      .toEqual([undefined, undefined, { _tag: "Stalled", signal: "tree", rounds: 2, on: "escalate" }])
  })

  it("stalls on the same failing checks in any order", () => {
    expect(
      run(Stall.policy({ rounds: 3 }), [{ checks: ["x", "y"] }, { checks: ["y", "x"] }, { checks: ["x", "y", "x"] }])
    )
      .toEqual([undefined, undefined, { _tag: "Stalled", signal: "checks", rounds: 3, on: "stop" }])
  })

  it("stalls on an identical output hash, compared canonically", () => {
    const policy = Stall.policy({ rounds: 2, on: "park" })
    expect(run(policy, [{ output: { a: 1, b: 2 } }, { output: { b: 2, a: 1 } }]))
      .toEqual([undefined, { _tag: "Stalled", signal: "output", rounds: 2, on: "park" }])
    expect(run(policy, [{ output: undefined }, { output: null }])[1]?.signal).toBe("output")
    expect(run(policy, [{ output: new Error("x") }, { output: new Error("x") }])).toEqual([undefined, undefined])
  })

  it("resets a streak when its signal moves or is absent, and prefers tree over checks over output", () => {
    const policy = Stall.policy({ rounds: 2 })
    expect(run(policy, [{ tree: "a" }, {}, { tree: "a" }, { tree: "b" }])).toEqual([
      undefined,
      undefined,
      undefined,
      undefined
    ])
    expect(run(policy, [{ tree: "a", checks: ["c"], output: 1 }, { tree: "a", checks: ["c"], output: 1 }])[1]?.signal)
      .toBe("tree")
    expect(run(policy, [{ tree: "a", checks: ["c"], output: 1 }, { tree: "b", checks: ["c"], output: 1 }])[1]?.signal)
      .toBe("checks")
  })

  it("carries state that round-trips through its schema", () => {
    const { state } = Stall.observe(Stall.policy({ rounds: 2 }), Stall.initial, { tree: "t", checks: [], output: "v" })
    expect(Schema.decodeUnknownSync(Stall.State)(JSON.parse(JSON.stringify(state)))).toEqual(state)
    expect(Schema.is(Stall.Policy)({ rounds: 1, on: "stop" })).toBe(false)
  })
})

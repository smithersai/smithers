import { describe, expect, it } from "@effect/vitest"
import { Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Effect } from "effect"
import * as Schema from "effect/Schema"
import { FlowEngine } from "../src/index.ts"
import { withCrypto } from "./Crypto.ts"

const { Round } = FlowEngine

const flow = Flow.make("engine/Round", { payload: {}, success: Schema.String, body: () => Node.succeed("ready") })

describe("Round identity space", () => {
  it("names round zero's execution id rootExecutionId, apart from the journal lineage", () => {
    const instance = FlowEngine.makeInstance(flow, "run-1")
    // A journal lineage id is well-formed text, so only the type can refuse
    // it where round zero's execution id belongs. Never invoked.
    const wrongSpace = () => {
      // @ts-expect-error a journal lineage id is not an execution id
      Round.initial(instance.lineageId)
      // @ts-expect-error only Round.initial mints a root execution id
      const forged: FlowEngine.Round.Round = { rootExecutionId: instance.lineageId, ordinal: 1 }
      return forged
    }
    expect(wrongSpace).toBeTypeOf("function")
    expect(Round.initial("run-1")).toEqual({ rootExecutionId: "run-1", ordinal: 0 })
    expect(Round.initial("run-1")).not.toHaveProperty("lineageId")
  })
})

describe("Round identity validation", () => {
  it("rejects a trailing high surrogate synchronously", () => {
    for (const id of ["\ud800", "root-\udbff"]) {
      expect(() => Round.initial(id)).toThrow(Round.InvalidRound)
    }
  })

  it.effect("validates trailing high surrogates before deriving any ordinal", () =>
    withCrypto(Effect.gen(function*() {
      for (const ordinal of [0, 1]) {
        const error = yield* Round.executionId({
          rootExecutionId: "root-\ud800" as FlowEngine.Round.RootExecutionId,
          ordinal
        }).pipe(Effect.flip)
        expect(error).toBeInstanceOf(Round.InvalidRound)
      }
    })))

  it.effect("returns the caller's execution id for the initial round", () =>
    withCrypto(Effect.gen(function*() {
      for (const id of ["root", "round-🚀", "e\u0301"]) {
        expect(yield* Round.executionId(Round.initial(id))).toBe(id)
      }
    })))
})

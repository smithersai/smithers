import { ConfigProvider, Effect, Option } from "effect"
import { describe, expect, it } from "vitest"
import * as Placement from "./Placement.vibe"

/** A namespace that answers each name with the options it was reached with. */
const recording: Placement.Namespace<{ readonly name: string; readonly options: unknown }> = {
  getByName: (name, options) => ({ name, options }),
}

const read = (env: Record<string, string>) =>
  Effect.runSync(Effect.result(Effect.gen(function* () {
    return yield* Placement.location
  }).pipe(Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(env)))))

describe("where remote flow executions' objects are created", () => {
  it("creates each object at the configured hint, and nowhere in particular without one", () => {
    expect(Placement.placed(recording, Option.some("enam")).getByName("run-1")).toEqual({
      name: "run-1",
      options: { locationHint: "enam" },
    })
    expect(Placement.placed(recording, Option.none()).getByName("run-1")).toEqual({ name: "run-1", options: undefined })
  })

  it("reads FLOW_EXECUTION_LOCATION as a Durable Object location hint, and refuses anything else", () => {
    expect(read({ FLOW_EXECUTION_LOCATION: "enam" })).toMatchObject({ _tag: "Success", success: Option.some("enam") })
    expect(read({})).toMatchObject({ _tag: "Success", success: Option.none() })
    expect(read({ FLOW_EXECUTION_LOCATION: "us-east-1" })._tag).toBe("Failure")
  })
})

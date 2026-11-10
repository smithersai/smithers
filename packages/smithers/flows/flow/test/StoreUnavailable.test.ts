import { Fault, FlowRuntime } from "@smthrs/flow"
import * as Schema from "effect/Schema"
import { describe, expect, it } from "vitest"

describe("StoreUnavailable", () => {
  it("has a stable wire code, execution identity and retryable infrastructure classification", () => {
    const error = new FlowRuntime.StoreUnavailable({ executionId: "ask" })
    expect(error.message).toBe("The engine store could not record a step of execution \"ask\"")
    expect(error.code).toBe("store_unavailable")
    expect(
      Schema.decodeUnknownSync(FlowRuntime.StoreUnavailable)(Schema.encodeSync(FlowRuntime.StoreUnavailable)(error))
    ).toEqual(error)
    expect(Fault.of(error)).toEqual({ class: "infra", tag: "@smthrs/flow/StoreUnavailable/store_unavailable" })
  })
})

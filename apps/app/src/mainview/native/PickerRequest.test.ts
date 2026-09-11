import { describe, expect, test } from "bun:test"
import { PICKER_REQUEST_OPTIONS, pickLocalRepositoryVia } from "./PickerRequest"

/*
 * Regression: the native folder picker is a modal dialog, and the Electrobun
 * RPC layer rejects a request after 1000 ms unless told otherwise. The
 * "Select a repo" pill died in that timeout ("The native repository picker
 * stopped responding") before the dialog could be answered.
 */
describe("the picker request", () => {
  test("carries no deadline, because a human answers the dialog", async () => {
    const calls: Array<{ params: unknown; options: unknown }> = []
    const result = await pickLocalRepositoryVia(async (params, options) => {
      calls.push({ params, options })
      return { status: "cancelled" }
    }, "read-write")
    expect(result).toEqual({ status: "cancelled" })
    expect(calls).toEqual([{ params: { access: "read-write" }, options: { maxRequestTime: Number.POSITIVE_INFINITY } }])
    expect(PICKER_REQUEST_OPTIONS.maxRequestTime).toBe(Number.POSITIVE_INFINITY)
  })
})

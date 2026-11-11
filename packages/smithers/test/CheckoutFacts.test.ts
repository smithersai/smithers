import { describe, expect, it } from "vitest"
import * as CliError from "../src/CliError.ts"
import { checkoutFacts } from "../src/internal/NativeEquipment.ts"

describe("the checkout facts an operator declares", () => {
  it("declares nothing about a checkout the operator said nothing about", () => {
    expect(checkoutFacts({})).toEqual({})
    expect(checkoutFacts({ SMITHERS_CHECKOUT_NO_LATER_COMMITS: " " })).toEqual({})
  })

  it("declares that the checkout holds nothing later only when the operator says so", () => {
    expect(checkoutFacts({ SMITHERS_CHECKOUT_NO_LATER_COMMITS: " 1 " })).toEqual({ noLaterCommits: true })
  })

  it("refuses to start on any other value rather than guessing", () => {
    expect(() => checkoutFacts({ SMITHERS_CHECKOUT_NO_LATER_COMMITS: "true" })).toThrow(CliError.UsageError)
    expect(() => checkoutFacts({ SMITHERS_CHECKOUT_NO_LATER_COMMITS: "0" })).toThrow(CliError.UsageError)
  })
})

import { describe, expect, it } from "vitest"
import * as CliError from "../src/CliError.ts"
import { askPolicy } from "../src/internal/NativeEquipment.ts"

describe("the host's ask policy", () => {
  it("parks by default and refuses only when the host declares nobody answers", () => {
    expect(askPolicy({})).toBe("park")
    expect(askPolicy({ SMITHERS_ASKS: "park" })).toBe("park")
    expect(askPolicy({ SMITHERS_ASKS: " refuse " })).toBe("refuse")
  })

  it("refuses to start on any other value rather than guessing", () => {
    expect(() => askPolicy({ SMITHERS_ASKS: "approve" })).toThrow(CliError.UsageError)
  })
})

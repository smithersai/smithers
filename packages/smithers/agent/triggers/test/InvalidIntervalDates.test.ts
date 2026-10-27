import * as Effect from "effect/Effect"
import { describe, expect, it } from "vitest"
import { Cron } from "../src/index.ts"

describe("cron interval dates", () => {
  it("identifies invalid interval endpoints before searching, including a zero limit", async () => {
    const cron = await Effect.runPromise(Cron.parse("0 * * * *", "UTC"))
    const valid = new Date("2026-01-01T00:00:00Z")
    const invalid = new Date("garbage")
    for (const limit of [undefined, 0, 1]) {
      for (
        const [from, to, path] of [[invalid, valid, "from"], [valid, invalid, "to"], [
          invalid,
          invalid,
          "from"
        ]] as const
      ) {
        expect(await Effect.runPromise(Effect.flip(Cron.occurrencesBetween(cron, from, to, limit))))
          .toMatchObject({ code: "invalid_options", path })
      }
    }
  })
})

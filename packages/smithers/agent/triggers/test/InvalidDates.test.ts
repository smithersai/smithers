import * as Effect from "effect/Effect"
import { describe, expect, it } from "vitest"
import { Cron } from "../src/index.ts"

describe("cron input dates", () => {
  it("identifies invalid single-search dates", async () => {
    const cron = await Effect.runPromise(Cron.parse("0 * * * *", "UTC"))
    for (const date of [new Date("garbage"), new Date(Infinity), new Date(-Infinity)]) {
      expect(await Effect.runPromise(Effect.flip(Cron.next(cron, date)))).toMatchObject({
        code: "invalid_options",
        path: "from"
      })
      expect(await Effect.runPromise(Effect.flip(Cron.previousAtOrBefore(cron, date)))).toMatchObject({
        code: "invalid_options",
        path: "at"
      })
    }
  })
})

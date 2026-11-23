import { describe, test } from "vitest"
import { notice } from "./golden.ts"

describe("smthrs-deprecation hot paths", () => {
  test("import deprecation notice rejection", async ({ bench }) => {
    await bench("import deprecation entry and catch notice", async () => {
      const error = await import("../src/index.ts").then(
        () => undefined,
        (caught: unknown) => caught as Error
      )
      if (error?.message !== notice) {
        throw new Error("unexpected deprecation notice")
      }
    }).run({ time: 120, warmupTime: 30 })
  })
})

import { Effect, Redacted, Stream } from "effect"
import { expect, test } from "vitest"
import { Scrub } from "../src/index.ts"

const encoder = new TextEncoder()

const check = async (value: string, echo: string) => {
  const scrub = Scrub.make([{ value: Redacted.make(value), replacement: "PH" }])
  expect(scrub.text(`before ${echo} after`)).toBe("before PH after")
  const bytes = encoder.encode(`before ${echo} after`)
  for (let split = 0; split <= bytes.length; split++) {
    const chunks = await Effect.runPromise(Stream.runCollect(scrub.stream(Stream.make(
      bytes.subarray(0, split),
      bytes.subarray(split)
    ))))
    expect(Array.from(chunks, (chunk) => new TextDecoder().decode(chunk)).join("")).toBe("before PH after")
  }
}

test("percent echoes include reserved punctuation, mixed hex case and form spaces", async () => {
  const value = "ab!c'd(e)*~key-XYZ/9+ "
  await check(value, "ab%21c%27d%28e%29%2A~key-XYZ%2F9%2B%20")
  await check(value, "ab%21c'd%28e)%2a~key-XYZ%2f9%2b+")
})

test("an empty target does not scrub arbitrary text", () => {
  const scrub = Scrub.make([{ value: Redacted.make(""), replacement: "PH" }])
  expect(scrub.active).toBe(false)
  expect(scrub.text("ordinary text")).toBe("ordinary text")
})

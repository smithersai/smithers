import { Effect, Redacted, Stream } from "effect"
import { expect, test } from "vitest"
import { Scrub } from "../src/index.ts"

const unicode = (value: string, upper = false) =>
  value.split("").map((unit) => {
    const hex = unit.charCodeAt(0).toString(16).padStart(4, "0")
    return `\\u${upper ? hex.toUpperCase() : hex}`
  }).join("")

const check = async (value: string, echo: string) => {
  const scrub = Scrub.make([{ value: Redacted.make(value), replacement: "PH" }])
  const input = `{"token":"${echo}"}`
  expect(JSON.parse(input).token).toBe(value)
  expect(scrub.text(input)).toBe("{\"token\":\"PH\"}")
  const bytes = new TextEncoder().encode(input)
  for (let split = 0; split <= bytes.length; split++) {
    const output = await Effect.runPromise(Stream.runCollect(scrub.stream(Stream.make(
      bytes.subarray(0, split),
      bytes.subarray(split)
    ))))
    const result = Array.from(output).flatMap((part) => Array.from(part))
    expect(new TextDecoder().decode(Uint8Array.from(result))).toBe("{\"token\":\"PH\"}")
  }
}

test("JSON echoes support every ASCII unit, short escape, slash and Unicode hex case", async () => {
  for (let unit = 0; unit < 128; unit++) {
    const value = `prefix${String.fromCharCode(unit)}suffix`
    await check(value, unicode(value))
    await check(value, unicode(value, true))
    await check(value, JSON.stringify(value).slice(1, -1).replaceAll("/", "\\/"))
  }
})

test("JSON echoes support non-ASCII, surrogate pairs and mixed literal and escaped units", async () => {
  for (const value of ["pässwörd-key-1234", "a\u2028\u2029z", "key😀𐀀􏿿end"]) {
    await check(value, unicode(value))
    await check(value, unicode(value, true))
    await check(value, Array.from(value, (char, index) => index % 2 ? unicode(char, true) : char).join(""))
  }
  await check("a«z", "a\\u00aBz")
})

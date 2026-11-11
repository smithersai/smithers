import { Chunk, Effect, Redacted, Stream } from "effect"
import { describe, expect, test } from "vitest"
import { Scrub } from "../src/index.ts"
import { leaks, PLACEHOLDER, VALUE as HEADER_VALUE } from "./fixtures.ts"

// Scrubbing still protects legacy Unicode values, even though new header credentials are ASCII.
const VALUE = `${HEADER_VALUE}é`

const encoder = new TextEncoder()
const b64 = (text: string) => btoa(String.fromCharCode(...encoder.encode(text)))
const b64url = (text: string) => b64(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")

const scrubber = Scrub.make([{ value: Redacted.make(VALUE), replacement: PLACEHOLDER }])

/** Every way `VALUE` may be echoed, as the answers in these tests carry it. */
const echoes = [
  VALUE,
  encodeURIComponent(VALUE),
  encodeURIComponent(VALUE).toLowerCase(),
  encodeURIComponent(VALUE).replace(/%20/g, "+"),
  JSON.stringify({ token: VALUE }),
  b64(VALUE),
  b64(`user:${VALUE}`),
  b64(`ab:${VALUE}`),
  b64(`x:${VALUE}:y`),
  b64url(`u:${VALUE}`),
  `Basic ${b64(`t:${VALUE}`)}`
]

const streamed = (chunks: ReadonlyArray<Uint8Array>) =>
  Effect.runPromise(
    Stream.runCollect(scrubber.stream(Stream.fromIterable(chunks))).pipe(
      Effect.map((out) => new TextDecoder().decode(concat(Chunk.toReadonlyArray(Chunk.fromIterable(out)))))
    )
  )

/** What `scrub` delivers for `chunks`, one text per delivery: the scrubber delivers at most once per chunk. */
const deliveries = (scrub: Scrub.Scrubber, chunks: ReadonlyArray<string>) =>
  Effect.runPromise(
    Stream.runCollect(scrub.stream(Stream.fromIterable(chunks.map((chunk) => encoder.encode(chunk))))).pipe(
      Effect.map((out) => Array.from(out, (bytes) => new TextDecoder().decode(bytes)))
    )
  )

const concat = (parts: ReadonlyArray<Uint8Array>) => {
  const all = new Uint8Array(parts.reduce((total, part) => total + part.length, 0))
  let at = 0
  for (const part of parts) {
    all.set(part, at)
    at += part.length
  }
  return all
}

describe("Scrub", () => {
  test("forms are the value, its percent, JSON and base64 encodings at every alignment, without repeats", () => {
    const forms = Scrub.forms(VALUE)
    expect(forms).toContain(VALUE)
    expect(forms).toContain(encodeURIComponent(VALUE))
    expect(new Set(forms).size).toBe(forms.length)
    expect(forms).not.toContain("")
    // A plain value has only its base64 forms beside itself, one per alignment: no `+` or `/` makes base64url differ.
    expect(Scrub.forms("abcdefgh")).toEqual(["abcdefgh", "YWJjZGVmZ2", "FiY2RlZmdo", "hYmNkZWZna"])
  })

  test.each(echoes)("text: %s loses every form of the value", (echo) => {
    const out = scrubber.text(`before ${echo} after`)
    expect(leaks(out, [VALUE])).toEqual([])
    expect(out.startsWith("before ")).toBe(true)
    expect(out.endsWith(" after")).toBe(true)
  })

  test("text keeps everything that isn't a form of a value", () => {
    expect(scrubber.text("plain text, no secret: sk_live_51Hq")).toBe("plain text, no secret: sk_live_51Hq")
    expect(scrubber.text(VALUE)).toBe(PLACEHOLDER)
    expect(scrubber.text(`${VALUE}${VALUE}`)).toBe(`${PLACEHOLDER}${PLACEHOLDER}`)
  })

  test("a scrubber with no targets changes nothing and passes a stream through as is", async () => {
    const none = Scrub.make([])
    expect(none.active).toBe(false)
    expect(none.text(VALUE)).toBe(VALUE)
    const body = Stream.make(encoder.encode(VALUE))
    expect(none.stream(body)).toBe(body)
    expect(scrubber.active).toBe(true)
  })

  test("where two forms match at one position, the longer one is replaced", () => {
    const both = Scrub.make([
      { value: Redacted.make("abcdefgh"), replacement: "<short>" },
      { value: Redacted.make("abcdefghijkl"), replacement: "<long>" }
    ])
    expect(both.text("xabcdefghijklx abcdefghx")).toBe("x<long>x <short>x")
  })

  test("a stream loses every echo at every split point between chunks", async () => {
    for (const echo of echoes) {
      const bytes = encoder.encode(`<${echo}>`)
      for (let split = 0; split <= bytes.length; split++) {
        const out = await streamed([bytes.subarray(0, split), bytes.subarray(split)])
        expect(leaks(out, [VALUE])).toEqual([])
        expect(out.startsWith("<")).toBe(true)
        expect(out.endsWith(">")).toBe(true)
      }
    }
  })

  test("a stream of one-byte chunks loses the value and keeps every other byte in order", async () => {
    const text = `head ${VALUE} middle ${b64(`user:${VALUE}`)} tail`
    const bytes = encoder.encode(text)
    const out = await streamed(Array.from(bytes, (byte) => Uint8Array.of(byte)))
    expect(leaks(out, [VALUE])).toEqual([])
    expect(out).toBe(scrubber.text(text))
  })

  test("a stream shorter than the longest form, and an empty one, come out as they went in", async () => {
    expect(await streamed([encoder.encode("hi")])).toBe("hi")
    expect(await streamed([])).toBe("")
  })

  test("a chunk no form can continue from is delivered at once, however long the longest value", async () => {
    // The longest form of a 16 KiB value is about 98 KiB: every event here is far shorter.
    const long = Scrub.make([
      { value: Redacted.make(VALUE), replacement: PLACEHOLDER },
      { value: Redacted.make("k".repeat(16 * 1024)), replacement: "<long>" }
    ])
    const events = Array.from({ length: 12 }, (_, index) => `data: {"delta":${index}}\n\n`)
    expect(await deliveries(long, events)).toEqual(events)
  })

  test("only the end of a chunk that a form could continue from waits for the next chunk", async () => {
    expect(await deliveries(scrubber, [`data: ${VALUE.slice(0, 5)}`, `${VALUE.slice(5)}\n`, "tail"])).toEqual([
      "data: ",
      `${PLACEHOLDER}\n`,
      "tail"
    ])
    // The start of a value that turns out not to be one is delivered with the chunk that settles it.
    expect(await deliveries(scrubber, [`data: ${VALUE.slice(0, 5)}`, "ost\n"])).toEqual([
      "data: ",
      `${VALUE.slice(0, 5)}ost\n`
    ])
    // A stream that ends inside a form delivers what it held.
    expect(await deliveries(scrubber, [`data: ${VALUE.slice(0, 5)}`])).toEqual(["data: ", VALUE.slice(0, 5)])
  })

  test("a shorter form waits while a longer one at the same position could still continue", async () => {
    const both = Scrub.make([
      { value: Redacted.make("abcdefgh"), replacement: "<short>" },
      { value: Redacted.make("abcdefghijkl"), replacement: "<long>" }
    ])
    expect(await deliveries(both, ["xabcdefgh", "ijklx"])).toEqual(["x", "<long>x"])
    expect(await deliveries(both, ["xabcdefgh", "ijx"])).toEqual(["x", "<short>ijx"])
    expect(await deliveries(both, ["xabcdefghij"])).toEqual(["x", "<short>ij"])
  })

  test("scrubbing costs time linear in the body's size", async () => {
    const run = async (size: number) => {
      const chunk = encoder.encode("x".repeat(64 * 1024))
      await streamed(Array.from({ length: size }, () => chunk))
    }
    await run(4)
    const time = async (size: number) => {
      const start = performance.now()
      await run(size)
      return performance.now() - start
    }
    const small = Math.min(await time(8), await time(8))
    const large = Math.min(await time(32), await time(32))
    expect(large / small).toBeLessThan(10)
  })
})

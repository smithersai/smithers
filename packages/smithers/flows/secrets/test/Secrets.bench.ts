import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"
import * as Stream from "effect/Stream"
import { beforeAll, describe, test } from "vitest"
import { Binding, Egress, Placeholder, Scrub } from "../src/index.ts"
import { API, OTHER, OTHER_PLACEHOLDER, PLACEHOLDER, policy, VALUE } from "./fixtures.ts"

const encoder = new TextEncoder()
const masterKey = Redacted.make("bench-master-key-0123456789abcdef0123456789abcdef")

const scrubber = Scrub.make([
  { value: Redacted.make(VALUE), replacement: PLACEHOLDER },
  { value: Redacted.make(OTHER), replacement: OTHER_PLACEHOLDER }
])

const cleanPayload = "ordinary json response payload without any secret values ".repeat(64)
const dirtyPayload = [
  "prefix ".repeat(32),
  VALUE,
  " middle ".repeat(32),
  encodeURIComponent(VALUE),
  " more ".repeat(32),
  OTHER,
  " suffix ".repeat(32)
].join("")

const streamChunks = Array.from(
  { length: 16 },
  (_, index) => encoder.encode(index === 7 ? `chunk-${index} ${VALUE} end\n` : `chunk-${index} ${"x".repeat(512)}\n`)
)

let minter: Placeholder.Minter

beforeAll(async () => {
  minter = await Effect.runPromise(Placeholder.minter(masterKey))
})

describe("@smthrs/secrets", () => {
  test("Placeholder.minter derive (HMAC-SHA-256)", async ({ bench }) => {
    let counter = 0
    await bench("Placeholder.derive", async () => {
      await Effect.runPromise(minter.derive(`repo/branch/gen-${counter++}`, "API_KEY"))
    }).run({ time: 150, warmupTime: 30 })
  })

  test("Egress.decide (allowed + denied header inspection)", async ({ bench }) => {
    const allowedHeaders = {
      authorization: `Bearer ${PLACEHOLDER}`,
      "x-trace": "trace-12345",
      accept: "application/json"
    }
    const deniedHeaders = {
      authorization: `Bearer ${PLACEHOLDER}`
    }
    await bench("Egress.decide", () => {
      Egress.decide({ method: "POST", url: `https://${API}/v1/items`, headers: allowedHeaders }, policy)
      Egress.decide({ method: "GET", url: "https://api.github.com/repos", headers: deniedHeaders }, policy)
    }).run({ time: 120, warmupTime: 30 })
  })

  test("Scrub.text (clean 3.5 KiB payload)", async ({ bench }) => {
    await bench("Scrub.text clean 3.5 KiB", () => {
      scrubber.text(cleanPayload)
    }).run({ time: 120, warmupTime: 30 })
  })

  test("Scrub.text (echoed raw + percent-encoded secrets)", async ({ bench }) => {
    await bench("Scrub.text echoed secrets", () => {
      scrubber.text(dirtyPayload)
    }).run({ time: 120, warmupTime: 30 })
  })

  test("Scrub.stream (16 chunks / 8 KiB streaming scrub)", async ({ bench }) => {
    await bench("Scrub.stream 8 KiB", async () => {
      await Effect.runPromise(Stream.runDrain(scrubber.stream(Stream.fromIterable(streamChunks))))
    }).run({ time: 150, warmupTime: 30 })
  })

  test("Binding.isHost + Placeholder.find", async ({ bench }) => {
    const headerText = `Bearer ${PLACEHOLDER}, alt=${OTHER_PLACEHOLDER}`
    await bench("Binding.isHost + Placeholder.find", () => {
      Binding.isHost("api.example.com")
      Binding.isHost("127.0.0.1")
      Placeholder.find(headerText)
    }).run({ time: 120, warmupTime: 30 })
  })
})

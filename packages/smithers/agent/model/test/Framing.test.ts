import { Deferred, Effect, Fiber, type Scope, Stream } from "effect"
import { describe, expect, it } from "vitest"
import * as Framing from "../src/Framing.ts"

const encoder = new TextEncoder()

const split = (input: Uint8Array, size: number): ReadonlyArray<Uint8Array> => {
  const chunks: Array<Uint8Array> = []
  for (let index = 0; index < input.length; index += size) chunks.push(input.slice(index, index + size))
  return chunks
}

const decodeWith = (framing: Framing.Framing<string>) => (input: string, size: number) =>
  Effect.runPromise(
    Stream.runCollect(framing.frame(Stream.fromIterable(split(encoder.encode(input), size))))
  ).then(Array.from)

const decode = decodeWith(Framing.sse)
const decodeNdjson = decodeWith(Framing.ndjson)

describe("Framing.sse", () => {
  const fixture =
    ": keepalive\r\nid: event-1\r\nevent: message\r\ndata: first\r\ndata: second\r\n\r\nevent: unicode\ndata: café\n\n"
  const expected = ["first\nsecond", "café"]

  it.each([1, 3, 7, 4096])("decodes byte-split SSE at chunk size %s", async (size) => {
    await expect(decode(fixture, size)).resolves.toEqual(expected)
  })

  it("drops the terminal sentinel before protocol JSON decoding", async () => {
    await expect(decode("data: [DONE]\n\n", 1)).resolves.toEqual([])
  })

  it("drops a truncated final frame without failing the stream", async () => {
    await expect(decode("data: complete\n\ndata: incomplete", 3)).resolves.toEqual(["complete"])
  })

  it("deliberately ignores retry directives", async () => {
    await expect(decode("data: before\n\nretry: 100\n\ndata: after\n\n", 2)).resolves.toEqual(["before", "after"])
  })

  it.each([1, 3, 17, 4096])(
    "continues across retry metadata in independent asynchronous pulls (%s bytes)",
    async (size) => {
      for (const newline of ["\n", "\r\n", "\r"]) {
        const input = ["retry: 100", "", "data: before", "", "retry: 0", "", "data: after", "", ""].join(newline)
        const source = Stream.fromIterable(split(encoder.encode(input), size)).pipe(
          Stream.rechunk(1),
          Stream.mapEffect((chunk) => Effect.as(Effect.yieldNow, chunk))
        )
        expect(Array.from(await Effect.runPromise(Stream.runCollect(Framing.sse.frame(source)))))
          .toEqual(["before", "after"])
      }
    }
  )

  it("keeps pulling a live connection after a separately delivered retry directive", async () => {
    await Effect.runPromise(Effect.gen(function*() {
      const firstFrame = yield* Deferred.make<void>()
      const sendRetry = yield* Deferred.make<void>()
      const requestedAfterRetry = yield* Deferred.make<void>()
      const sendAfter = yield* Deferred.make<void>()
      const frames: Array<string> = []
      const source = Stream.concat(
        Stream.make(encoder.encode("data: before\n\n")),
        Stream.concat(
          Stream.fromEffect(Effect.as(Deferred.await(sendRetry), encoder.encode("retry: 100\n\n"))),
          Stream.fromEffect(Effect.gen(function*() {
            yield* Deferred.succeed(requestedAfterRetry, undefined)
            yield* Deferred.await(sendAfter)
            return encoder.encode("data: after\n\n")
          }))
        )
      )
      const running = yield* Stream.runForEach(Framing.sse.frame(source), (frame) =>
        Effect.gen(function*() {
          frames.push(frame)
          if (frame === "before") yield* Deferred.succeed(firstFrame, undefined)
        })).pipe(Effect.forkChild)
      yield* Deferred.await(firstFrame)
      expect(frames).toEqual(["before"])
      yield* Deferred.succeed(sendRetry, undefined)
      // The old catch-Retry-with-empty parser stopped here and never requested
      // another chunk. The producer need not end before a consumer sees data.
      yield* Deferred.await(requestedAfterRetry).pipe(Effect.timeout("1 second"))
      expect(frames).toEqual(["before"])
      yield* Deferred.succeed(sendAfter, undefined)
      yield* Fiber.join(running)
      expect(frames).toEqual(["before", "after"])
    }))
  })
})

describe("Framing.ndjson", () => {
  const fixture = "{\"type\":\"delta\",\"text\":\"one\"}\n{\"type\":\"delta\",\"text\":\"café\"}\n{\"type\":\"done\"}\n"
  const expected = [
    "{\"type\":\"delta\",\"text\":\"one\"}",
    "{\"type\":\"delta\",\"text\":\"café\"}",
    "{\"type\":\"done\"}"
  ]

  it.each([1, 3, 7, 4096])("decodes byte-split NDJSON at chunk size %s", async (size) => {
    await expect(decodeNdjson(fixture, size)).resolves.toEqual(expected)
  })

  it("frames a producer that omits the trailing newline identically", async () => {
    await expect(decodeNdjson("{\"a\":1}\n{\"b\":2}", 4)).resolves.toEqual(["{\"a\":1}", "{\"b\":2}"])
  })

  it("discards blank lines rather than emitting empty frames", async () => {
    await expect(decodeNdjson("\n{\"a\":1}\n\n\n{\"b\":2}\n\n", 5)).resolves.toEqual(["{\"a\":1}", "{\"b\":2}"])
  })

  it("emits a truncated final record so protocol decoding can reject it", async () => {
    // A cut record is a failure to report, not a record to drop silently.
    await expect(decodeNdjson("{\"a\":1}\n{\"b\":", 3)).resolves.toEqual(["{\"a\":1}", "{\"b\":"])
  })
})

const failure = async (framing: Framing.Framing<string>, input: Stream.Stream<Uint8Array, never, Scope.Scope>) => {
  const exit = await Effect.runPromise(Effect.scoped(Effect.exit(Stream.runCollect(framing.frame(input)))))
  if (exit._tag !== "Failure") throw new Error("expected framing failure")
  return exit.cause.reasons.find((reason) => reason._tag === "Fail")?.error
}

describe("framing resource contracts", () => {
  for (const format of ["sse", "ndjson"] as const) {
    const make = format === "sse" ? Framing.makeSse : Framing.makeNdjson
    for (const offset of [-1, 0, 1]) {
      it(`${format} enforces complete encoded record bytes at 64${offset >= 0 ? "+" : ""}${offset}`, async () => {
        const prefix = format === "sse" ? "data: " : ""
        const suffix = format === "sse" ? "\n" : ""
        const unicode = "café😀"
        const text = unicode + "x".repeat(64 + offset - encoder.encode(prefix + unicode + suffix).length)
        const record = prefix + text + suffix
        expect(encoder.encode(record).length).toBe(64 + offset)
        for (const size of [1, 3, 11, 4096]) {
          const stream = Stream.fromIterable(split(encoder.encode(record + "\n"), size))
          if (offset <= 0) {
            expect(Array.from(await Effect.runPromise(Stream.runCollect(make({ maxRecordBytes: 64 }).frame(stream)))))
              .toEqual([text])
          } else {
            expect(await failure(make({ maxRecordBytes: 64 }), stream)).toMatchObject({
              code: "invalid_provider_output",
              message: "Model stream record exceeds 64 bytes"
            })
          }
        }
      })
    }

    it(`${format} defaults the record ceiling to 4 MiB`, () => {
      expect(Framing.defaultMaxRecordBytes).toBe(4 * 1024 * 1024)
    })

    // The record ceiling logic is the same for any limit, so the boundary
    // walks a 64 KiB record under an injected one instead of 4 MiB under the
    // default, which timed out under coverage on a loaded host.
    it(`${format} preserves the complete maximum-sized record`, async () => {
      const prefix = format === "sse" ? "data: " : ""
      const suffix = format === "sse" ? "\n" : ""
      const maxRecordBytes = 64 * 1024
      for (const offset of [-1, 0, 1]) {
        const text = "x".repeat(maxRecordBytes + offset - prefix.length - suffix.length)
        const source = Stream.fromIterable(split(encoder.encode(prefix + text + suffix + "\n"), 4096))
        if (offset <= 0) {
          expect(Array.from(await Effect.runPromise(Stream.runCollect(make({ maxRecordBytes }).frame(source)))))
            .toEqual([text])
        } else {
          expect(await failure(make({ maxRecordBytes }), source)).toMatchObject({ code: "invalid_provider_output" })
        }
      }
    })

    it(`${format} defaults the response ceiling to 64 MiB`, () => {
      expect(Framing.defaultMaxResponseBytes).toBe(64 * 1024 * 1024)
    })

    // The ceiling logic is the same for any limit, so each boundary walks a
    // 256 KiB stream under an injected one instead of 64 MiB under the
    // default, which timed out under coverage on a loaded host.
    it.each([-1, 0, 1])(
      `${format} checks the response ceiling with bounded retained output (offset %i)`,
      async (offset) => {
        const prefix = format === "sse" ? "data: " : ""
        const suffix = format === "sse" ? "\n\n" : "\n"
        const size = 64 * 1024
        const count = 4
        const maxResponseBytes = count * size
        const text = "x".repeat(size - prefix.length - suffix.length)
        const full = encoder.encode(prefix + text + suffix)
        const finalText = text + (offset > 0 ? "x" : "")
        const final = encoder.encode(prefix + (offset < 0 ? finalText.slice(1) : finalText) + suffix)
        const source = Stream.fromIterable([...Array(count - 1).fill(full) as Array<Uint8Array>, final])
        let records = 0
        const exit = await Effect.runPromise(
          Effect.exit(Stream.runForEach(make({ maxResponseBytes }).frame(source), (frame) =>
            Effect.sync(() => {
              expect(frame).toBe(records === count - 1 && offset < 0 ? text.slice(1) : text)
              records++
            })))
        )
        if (offset <= 0) {
          expect(exit._tag).toBe("Success")
          expect(records).toBe(count)
        } else {
          expect(exit._tag).toBe("Failure")
          if (exit._tag === "Failure") {
            expect(exit.cause.reasons.find((reason) => reason._tag === "Fail")?.error)
              .toMatchObject({
                code: "invalid_provider_output",
                message: `Model response exceeds ${maxResponseBytes} bytes`
              })
          }
          expect(records).toBe(count - 1)
        }
      }
    )

    it(`${format} bounds a long unterminated record and cancels its producer`, async () => {
      let pulls = 0
      let released = false
      const source = Stream.fromEffect(Effect.acquireRelease(Effect.void, () =>
        Effect.sync(() => {
          released = true
        }))).pipe(
          Stream.flatMap(() =>
            Stream.fromEffectRepeat(Effect.sync(() => {
              pulls++
              return encoder.encode("x")
            }))
          )
        )
      expect(await failure(make({ maxRecordBytes: 64 }), source)).toMatchObject({ code: "invalid_provider_output" })
      expect(pulls).toBe(65)
      expect(released).toBe(true)
    })

    it(`${format} enforces a total response budget across individually small frames`, async () => {
      const record = format === "sse" ? "data: x\n\n" : "x\n"
      const data = encoder.encode(record.repeat(10))
      for (const offset of [-1, 0, 1]) {
        const framing = make({ maxResponseBytes: data.length + offset })
        const stream = Stream.fromIterable(split(data, 1))
        if (offset >= 0) {
          expect(Array.from(await Effect.runPromise(Stream.runCollect(framing.frame(stream))))).toEqual(
            Array(10).fill("x")
          )
        } else {
          expect(await failure(framing, stream)).toMatchObject({
            code: "invalid_provider_output",
            message: `Model response exceeds ${data.length - 1} bytes`
          })
        }
      }
    })

    it(`${format} preserves arbitrary byte partitions and empty chunks around UTF-8`, async () => {
      const input = encoder.encode(format === "sse" ? "data: 😀é\r\n\r\n" : "😀é\r\n")
      for (let boundary = 0; boundary <= input.length; boundary++) {
        const chunks = [input.slice(0, boundary), new Uint8Array(), input.slice(boundary), new Uint8Array()]
        expect(Array.from(await Effect.runPromise(Stream.runCollect(make().frame(Stream.fromIterable(chunks))))))
          .toEqual(["😀é"])
      }
    })

    it(`${format} documents replacement decoding of malformed UTF-8`, async () => {
      const prefix = encoder.encode(format === "sse" ? "data: " : "")
      const suffix = encoder.encode(format === "sse" ? "\n\n" : "\n")
      const chunks = [prefix, Uint8Array.of(0xff, 0xc3), suffix]
      expect(Array.from(await Effect.runPromise(Stream.runCollect(make().frame(Stream.fromIterable(chunks)))))).toEqual(
        ["��"]
      )
    })

    it(`${format} preserves transport failure while buffering a partial record`, async () => {
      const marker = new Error("transport cut")
      const input = Stream.concat(
        Stream.make(encoder.encode(format === "sse" ? "data: partial" : "partial")),
        Stream.fail(marker)
      )
      const exit = await Effect.runPromise(Effect.exit(Stream.runCollect(make().frame(input))))
      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure") {
        expect(exit.cause.reasons.find((reason) => reason._tag === "Fail")?.error).toBe(marker)
      }
    })

    it(`${format} releases a producer interrupted while buffering`, async () => {
      let released = false
      await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
        const started = yield* Deferred.make<void>()
        const source = Stream.fromEffect(Effect.acquireRelease(Effect.void, () =>
          Effect.sync(() => {
            released = true
          }))).pipe(
            Stream.flatMap(() =>
              Stream.concat(
                Stream.make(encoder.encode(format === "sse" ? "data: partial" : "partial")),
                Stream.fromEffect(Effect.andThen(Deferred.succeed(started, undefined), Effect.never))
              )
            )
          )
        const fiber = yield* Stream.runCollect(make().frame(source)).pipe(Effect.forkChild)
        yield* Deferred.await(started)
        yield* Fiber.interrupt(fiber)
      })))
      expect(released).toBe(true)
    })

    it(`${format} validates all limit values before pulling from a producer`, async () => {
      for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
        for (const limits of [{ maxRecordBytes: bad }, { maxResponseBytes: bad }]) {
          expect(await failure(make(limits), Stream.empty)).toMatchObject({ code: "invalid_request" })
        }
      }
    })
  }

  it("bounds a multiline SSE event across individually small lines", async () => {
    const framing = Framing.makeSse({ maxRecordBytes: 16 })
    expect(await decodeWith(framing)("data: a\ndata: b\n\n", 1)).toEqual(["a\nb"])
    expect(await failure(framing, Stream.make(encoder.encode("data: a\ndata: bb\n\n")))).toMatchObject({
      code: "invalid_provider_output"
    })
    expect(await decodeWith(framing)("data: a\r\ndata: b\r\n\r\n", 1)).toEqual(["a\nb"])
  })

  it("ignores SSE metadata while preserving empty data fields and unspaced values", async () => {
    expect(await decode("data:one\ndata\ndata:three\nretry: 0\n\n", 1)).toEqual(["one\n\nthree"])
    expect(await decode("data: x\r\r", 1)).toEqual(["x"])
  })

  it("resets per-response counters when a framing instance is reused", async () => {
    const decode = decodeWith(Framing.makeNdjson({ maxResponseBytes: 2 }))
    expect(await decode("x\n", 1)).toEqual(["x"])
    expect(await decode("y\n", 1)).toEqual(["y"])
  })
})

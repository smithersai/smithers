/**
 * The webhook ingress is the one control-plane door a bearer holder reaches
 * with an arbitrary payload, so its bounds and its decoding failures are the
 * assertions worth pinning.
 *
 * A declared flood is refused before reading, and an undeclared or understated
 * flood is stopped while streaming, before signature verification.
 */
import { Cause, Effect, Exit, Layer, Redacted, Schema, Stream } from "effect"
import * as HttpServerRequest from "effect/http/HttpServerRequest"
import { describe, expect, it } from "vitest"
import * as Channels from "../src/Channels.vibe"
import { InvalidInput, Unauthorized } from "../src/ControlError.ts"
import type { CredentialRef } from "../src/Credential.vibe"
import * as WebhookChannel from "../src/WebhookChannel.vibe"

const accepted = { _tag: "Accepted" as const, receiptId: "receipt" }

const credential: Redacted.Redacted<CredentialRef> = Redacted.make({ id: "cred", name: "webhook" })

/** A Channels service that records what reached it instead of ingesting. */
const recordingChannels = (
  seen: Array<Channels.IngestRequest>,
  verify: Channels.Channel["verify"] = () => Effect.void
) =>
  Layer.succeed(
    Channels.Channels,
    Channels.Channels.of({
      register: () => Effect.void,
      lookup: () => Effect.die("unused"),
      ingest: (request) =>
        verify(request.raw).pipe(Effect.map(() => {
          seen.push(request)
          return accepted
        })),
      project: () => Effect.die("unused")
    })
  )

/**
 * A minimal request with lazy body reads, so an over-declared length must cost
 * nothing to refuse.
 */
const request = (
  headers: Readonly<Record<string, string | undefined>>,
  body: () => Uint8Array
): Layer.Layer<HttpServerRequest.HttpServerRequest> =>
  Layer.succeed(
    HttpServerRequest.HttpServerRequest,
    {
      headers,
      get stream() {
        return Stream.fromEffect(Effect.sync(body))
      },
      get arrayBuffer() {
        return Effect.sync(() => {
          const bytes = body()
          return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
        })
      }
    } as unknown as HttpServerRequest.HttpServerRequest
  )

const bytes = (length: number): Uint8Array => new Uint8Array(length).fill(0x61)

/** The typed failure an exit carries, so an assertion reads the error, not its printed shape. */
const failure = <A, E>(exit: Exit.Exit<A, E>): E => {
  if (Exit.isSuccess(exit)) throw new Error("expected a typed failure")
  return Cause.squash(exit.cause) as E
}

const runHandler = (
  headers: Readonly<Record<string, string | undefined>>,
  body: () => Uint8Array,
  seen: Array<Channels.IngestRequest>,
  options?: { readonly maximumBodyBytes?: number }
) =>
  Effect.runPromiseExit(
    WebhookChannel.handler("hook", "key", options).pipe(
      Effect.provide(Layer.mergeAll(recordingChannels(seen), request(headers, body)))
    )
  )

describe("WebhookChannel.handler bounds the request body", () => {
  it.each([0, 64])("preserves streamed bytes at the %i byte limit", async (limit) => {
    const expected = Uint8Array.from({ length: limit }, (_, index) => index)
    const seen: Array<Channels.IngestRequest> = []
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(expected.slice(0, 17))
        controller.enqueue(new Uint8Array(0))
        controller.enqueue(expected.slice(17))
        controller.close()
      }
    })
    const webRequest = new Request("https://example.com/webhook", {
      method: "POST",
      body,
      duplex: "half"
    } as RequestInit)
    const exit = await Effect.runPromiseExit(
      WebhookChannel.handler("hook", "key", { maximumBodyBytes: limit }).pipe(
        Effect.provide(Layer.mergeAll(
          Layer.succeed(HttpServerRequest.HttpServerRequest, HttpServerRequest.fromWeb(webRequest)),
          recordingChannels(seen)
        ))
      )
    )
    expect(exit._tag).toBe("Success")
    expect(seen).toHaveLength(1)
    expect(seen[0]?.raw.body).toEqual(expected)
  })

  it.each([undefined, "1"])("stops an oversized stream with content-length %s before verification", async (length) => {
    let chunksRead = 0
    let cancelled = false
    let verified = false
    const seen: Array<Channels.IngestRequest> = []
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        chunksRead++
        controller.enqueue(bytes(64))
        if (chunksRead === 100) controller.close()
      },
      cancel() {
        cancelled = true
      }
    }, { highWaterMark: 0 })
    const webRequest = new Request("https://example.com/webhook", {
      method: "POST",
      headers: length === undefined ? {} : { "content-length": length },
      body,
      duplex: "half"
    } as RequestInit)
    const exit = await Effect.runPromiseExit(
      WebhookChannel.handler("hook", "key", { maximumBodyBytes: 64 }).pipe(
        Effect.provide(Layer.mergeAll(
          Layer.succeed(HttpServerRequest.HttpServerRequest, HttpServerRequest.fromWeb(webRequest)),
          recordingChannels(seen, () =>
            Effect.sync(() => {
              verified = true
            }))
        ))
      )
    )
    expect(failure(exit)).toMatchObject({ _tag: "/control/InvalidInput" })
    expect(chunksRead).toBe(2)
    expect(cancelled).toBe(true)
    expect(verified).toBe(false)
    expect(seen).toHaveLength(0)
  })

  it("accepts a body at exactly the limit", async () => {
    const seen: Array<Channels.IngestRequest> = []
    const exit = await runHandler({}, () => bytes(64), seen, { maximumBodyBytes: 64 })
    expect(exit._tag).toBe("Success")
    expect(seen).toHaveLength(1)
    expect(seen[0]?.raw.body.byteLength).toBe(64)
    expect(seen[0]?.channel).toBe("hook")
    expect(seen[0]?.raw.idempotencyKey).toBe("key")
  })

  it("refuses a body one byte over the limit and never ingests it", async () => {
    const seen: Array<Channels.IngestRequest> = []
    const exit = await runHandler({}, () => bytes(65), seen, { maximumBodyBytes: 64 })
    expect(failure(exit)).toMatchObject({
      _tag: "/control/InvalidInput",
      code: "invalid_input",
      issue: "webhook body: 65 bytes exceeds the 64 byte limit"
    })
    expect(seen).toHaveLength(0)
  })

  it("refuses an over-declared content-length before reading the body", async () => {
    const seen: Array<Channels.IngestRequest> = []
    let pulled = false
    const exit = await runHandler(
      { "content-length": "5000" },
      () => {
        pulled = true
        return bytes(1)
      },
      seen,
      { maximumBodyBytes: 64 }
    )
    expect(failure(exit)).toMatchObject({
      _tag: "/control/InvalidInput",
      issue: "webhook body: declared 5000 bytes exceeds the 64 byte limit"
    })
    expect(pulled).toBe(false)
    expect(seen).toHaveLength(0)
  })

  it("refuses a body whose content-length lied low", async () => {
    const seen: Array<Channels.IngestRequest> = []
    const exit = await runHandler({ "content-length": "1" }, () => bytes(200), seen, { maximumBodyBytes: 64 })
    expect(failure(exit)).toMatchObject({ issue: "webhook body: 200 bytes exceeds the 64 byte limit" })
    expect(seen).toHaveLength(0)
  })

  it("reads a capitalised Content-Length the same way", async () => {
    const seen: Array<Channels.IngestRequest> = []
    const exit = await runHandler({ "Content-Length": "5000" }, () => bytes(1), seen, { maximumBodyBytes: 64 })
    expect(failure(exit)).toMatchObject({ issue: "webhook body: declared 5000 bytes exceeds the 64 byte limit" })
  })

  it("ignores a content-length it cannot trust", async () => {
    const seen: Array<Channels.IngestRequest> = []
    for (const value of ["not-a-number", "-1", "1.5", undefined]) {
      const exit = await runHandler({ "content-length": value, other: "x" }, () => bytes(8), seen, {
        maximumBodyBytes: 64
      })
      expect(exit._tag).toBe("Success")
    }
    expect(seen).toHaveLength(4)
  })

  it.each([Number.NaN, -1, Number.POSITIVE_INFINITY])(
    "refuses to read any body under a nonsense %d byte limit",
    async (limit) => {
      // A NaN limit made every `size > limit` comparison false, so the
      // handler read an unbounded body; a mount misconfiguration must fail
      // loudly rather than silently drop the bound.
      const seen: Array<Channels.IngestRequest> = []
      let pulled = false
      const exit = await runHandler(
        {},
        () => {
          pulled = true
          return bytes(8)
        },
        seen,
        { maximumBodyBytes: limit }
      )
      expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
      expect(String(failure(exit))).toContain(
        "maximumBodyBytes must be a non-negative finite number"
      )
      expect(pulled).toBe(false)
      expect(seen).toHaveLength(0)
    }
  )

  it("applies the package default when a mount names no limit", async () => {
    const seen: Array<Channels.IngestRequest> = []
    expect(WebhookChannel.maximumBodyBytes).toBe(1024 * 1024)
    const exit = await runHandler(
      { "content-length": String(WebhookChannel.maximumBodyBytes + 1) },
      () => bytes(1),
      seen
    )
    expect(failure(exit)).toMatchObject({ _tag: "/control/InvalidInput" })
    const withinDefault = await runHandler({}, () => bytes(16), seen)
    expect(withinDefault._tag).toBe("Success")
  })
})

const channel = (
  overrides: Partial<WebhookChannel.Config<{ readonly kind: string }>> = {}
): Channels.Channel<{ readonly kind: string }> =>
  WebhookChannel.make<{ readonly kind: string }>({
    name: "hook",
    schema: Schema.Struct({ kind: Schema.String }),
    credential,
    verify: () => Effect.void,
    map: (payload) => Effect.succeed({ _tag: "Start", flowId: payload.kind, input: {} }),
    project: () => ({ cursor: "1", operation: "post", message: {} }),
    ...overrides
  })

const raw = (body: string): Channels.RawInbound => ({
  body: new TextEncoder().encode(body),
  headers: {},
  idempotencyKey: "key"
})

describe("WebhookChannel.make", () => {
  it("hands the configured credential to the verifier with the raw bytes", async () => {
    let handed: Redacted.Redacted<CredentialRef> | undefined
    const built = channel({
      verify: (_raw, given) =>
        Effect.sync(() => {
          handed = given
        })
    })
    await Effect.runPromise(built.verify(raw("{\"kind\":\"start\"}")))
    expect(handed === undefined ? undefined : Redacted.value(handed)).toEqual({ id: "cred", name: "webhook" })
  })

  it("passes a rejected signature through unchanged", async () => {
    const built = channel({ verify: () => Effect.fail(new Unauthorized({ message: "bad signature" })) })
    const exit = await Effect.runPromiseExit(built.verify(raw("{}")))
    expect(failure(exit)).toMatchObject({ _tag: "/control/Unauthorized", message: "bad signature" })
  })

  it("decodes a valid payload", async () => {
    const decoded = await Effect.runPromise(channel().decode(raw("{\"kind\":\"start\"}")))
    expect(decoded).toEqual({ kind: "start" })
  })

  it("refuses malformed JSON as InvalidInput", async () => {
    const exit = await Effect.runPromiseExit(channel().decode(raw("{not json")))
    const error = failure(exit) as InvalidInput
    expect(error._tag).toBe("/control/InvalidInput")
    expect(error.issue).toContain("invalid webhook JSON")
  })

  it("refuses a body that is not valid UTF-8 instead of substituting U+FFFD", async () => {
    // {"kind":"st\xFFart"} would otherwise decode to "st\uFFFDart" and reach the schema altered.
    const prefix = new TextEncoder().encode("{\"kind\":\"st")
    const suffix = new TextEncoder().encode("art\"}")
    const body = new Uint8Array([...prefix, 0xff, ...suffix])
    const exit = await Effect.runPromiseExit(
      channel().decode({ body, headers: {}, idempotencyKey: "key" })
    )
    const error = failure(exit) as InvalidInput
    expect(error._tag).toBe("/control/InvalidInput")
    expect(error.issue).toBe("invalid webhook JSON")
  })

  it("keeps malformed payload secrets out of the error and its serialization", async () => {
    const secret = "SECRET123"
    const exit = await Effect.runPromiseExit(channel().decode(raw(secret)))
    const error = failure(exit) as InvalidInput
    expect(error.issue).not.toContain(secret)
    expect(String(error)).not.toContain(secret)
    expect(JSON.stringify(error)).not.toContain(secret)
    expect(JSON.stringify(exit)).not.toContain(secret)
    expect(error.issue).toBe("invalid webhook JSON")
  })

  it("refuses well-formed JSON that fails the declared schema", async () => {
    const exit = await Effect.runPromiseExit(channel().decode(raw("{\"kind\":7}")))
    const error = failure(exit) as InvalidInput
    expect(error._tag).toBe("/control/InvalidInput")
    expect(error.issue).toContain("kind")
  })

  it("keeps an InvalidInput a mapper raises", async () => {
    const built = channel({ map: () => Effect.fail(new InvalidInput({ issue: "unmapped event" })) })
    const exit = await Effect.runPromiseExit(built.map({ kind: "start" }))
    expect(failure(exit)).toMatchObject({ _tag: "/control/InvalidInput", issue: "unmapped event" })
  })

  it("carries declared fingerprint headers onto the channel and omits them otherwise", () => {
    expect(channel().fingerprintHeaders).toBeUndefined()
    expect(channel({ fingerprintHeaders: ["x-event-type"] }).fingerprintHeaders).toEqual(["x-event-type"])
  })

  it("exposes the configured projection", () => {
    expect(channel().project({ runId: "run" } as never, undefined)).toEqual({
      cursor: "1",
      operation: "post",
      message: {}
    })
  })
})

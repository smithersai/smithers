/**
 * A failed model call must not carry the provider's words to a trace
 * collector. Each case runs a real route and executor against a provider
 * whose failure quotes a sentinel, exports the spans with Effect's own OTLP
 * tracer, and reads the bytes the collector received.
 */
import { SpanFailure } from "@smthrs/flow"
import { HttpClient as KernelHttpClient } from "@smthrs/kernel"
import { Cause, Effect, Exit, Layer, Redacted, Result, Stream, Tracer } from "effect"
import * as HttpClient from "effect/http/HttpClient"
import type * as HttpClientRequest from "effect/http/HttpClientRequest"
import * as HttpClientResponse from "effect/http/HttpClientResponse"
import * as OtlpExporter from "effect/observability/OtlpExporter"
import * as OtlpSerialization from "effect/observability/OtlpSerialization"
import * as OtlpTracer from "effect/observability/OtlpTracer"
import { describe, expect, it } from "vitest"
import * as Model from "../src/Model.ts"
import { ModelError } from "../src/ModelError.vibe"
import * as ModelRequest from "../src/ModelRequest.ts"
import * as RequestExecutor from "../src/RequestExecutor.ts"
import * as Route from "../src/Route.ts"

const sentinel = "sentinel-7c41-quoted-prompt"
const modelId = "gpt-test"

const request = ModelRequest.ModelRequest.make({
  modelId,
  system: [],
  messages: [ModelRequest.Message.user("hello")],
  tools: [],
  params: ModelRequest.GenerationParams.make()
})

interface ExportedSpan {
  readonly name: string
  readonly status: { readonly code?: number; readonly message?: string }
  readonly events: ReadonlyArray<{
    readonly name: string
    readonly attributes: ReadonlyArray<{ readonly key: string; readonly value: { readonly stringValue?: string } }>
  }>
}

interface Exported {
  /** Every byte the collector received, decoded. */
  readonly text: string
  readonly spans: ReadonlyArray<ExportedSpan>
}

const exception = (span: ExportedSpan): Record<string, string | undefined> => {
  const event = span.events.find((entry) => entry.name === "exception")
  return Object.fromEntries((event?.attributes ?? []).map(({ key, value }) => [key, value.stringValue]))
}

/**
 * Runs one model call through `withGenAiSpan` on a real OpenAI Responses
 * route whose provider is `provider`, with Effect's OTLP tracer exporting to a
 * collector that keeps every request body. Returns the call's exit and what
 * the collector received once the exporter is flushed.
 */
const traced = (provider: (request: HttpClientRequest.HttpClientRequest) => Effect.Effect<Response>) =>
  Effect.gen(function*() {
    const bodies: Array<string> = []
    const collector = HttpClient.make((exported) =>
      Effect.sync(() => {
        if (exported.body._tag === "Uint8Array") bodies.push(new TextDecoder().decode(exported.body.body))
        return HttpClientResponse.fromWeb(exported, new Response(null, { status: 200 }))
      })
    )
    const providerClient = HttpClient.make((sent) =>
      Effect.map(provider(sent), (response) => HttpClientResponse.fromWeb(sent, response))
    )
    const route = Result.getOrThrow(Route.openai({ apiKey: Redacted.make("provider-key") }))
    const exit = yield* Effect.gen(function*() {
      const result = yield* Effect.scoped(Effect.gen(function*() {
        const model = yield* Model.Model
        return yield* model.stream(request).pipe(Model.withGenAiSpan(request, "openai"), Stream.runDrain, Effect.exit)
      }))
      yield* (yield* OtlpExporter.Flusher).flush
      return result
    }).pipe(
      Effect.provide(Route.layer(route)),
      Effect.provide(RequestExecutor.layer),
      Effect.provide(Layer.succeed(KernelHttpClient.HttpClient)(providerClient)),
      Effect.provide(
        OtlpTracer.layer({ url: "http://collector.test/v1/traces", resource: { serviceName: "span-failure-test" } })
          .pipe(
            Layer.provide(OtlpSerialization.layerJson),
            Layer.provide(Layer.succeed(HttpClient.HttpClient)(collector))
          )
      )
    )
    const text = bodies.join("\n")
    const spans = bodies.flatMap((body) =>
      (JSON.parse(body) as {
        readonly resourceSpans: ReadonlyArray<
          { readonly scopeSpans: ReadonlyArray<{ readonly spans: ReadonlyArray<ExportedSpan> }> }
        >
      }).resourceSpans.flatMap((resource) => resource.scopeSpans.flatMap((scope) => scope.spans))
    )
    return { exit, exported: { text, spans } satisfies Exported }
  })

const named = (exported: Exported, name: string): ExportedSpan => {
  const span = exported.spans.find((candidate) => candidate.name === name)
  expect(span, `exported span ${name}`).toBeDefined()
  return span!
}

/** The span ended in error, and its status and exception say only `type: message`. */
const expectWithheld = (span: ExportedSpan, type: string, message: string) => {
  expect(span.status).toEqual({ code: 2, message })
  expect(exception(span)).toMatchObject({ "exception.type": type, "exception.message": message })
  expect(exception(span)["exception.stacktrace"]?.split("\n")[0]).toBe(`${type}: ${message}`)
}

describe("span failures", () => {
  it("export a provider's HTTP refusal as its code, and the caller still reads the provider's message", async () => {
    const { exit, exported } = await Effect.runPromise(traced(() =>
      Effect.succeed(
        new Response(
          JSON.stringify({
            error: { message: `Your prompt "${sentinel}" was refused`, type: "invalid_request_error", code: sentinel }
          }),
          { status: 400, headers: { "content-type": "application/json", "x-request-id": sentinel } }
        )
      )
    ))

    expect(Exit.isFailure(exit)).toBe(true)
    const error = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined
    expect(error).toBeInstanceOf(ModelError)
    const failure = error as ModelError
    expect(failure.message).toContain(sentinel)
    expect(failure.httpStatus).toBe(400)

    expect(exported.text).not.toContain(sentinel)
    for (const name of [`chat ${modelId}`, "flows/model/Route.stream", "RequestExecutor.execute"]) {
      expectWithheld(named(exported, name), "flows/model/ModelError", failure.code)
    }
  })

  it("export a provider's failure event mid-stream as its code", async () => {
    const sse = [
      "event: response.failed",
      `data: ${
        JSON.stringify({
          type: "response.failed",
          response: { error: { code: "server_error", message: `The model repeated "${sentinel}"` } }
        })
      }`,
      "",
      ""
    ].join("\n")
    const { exit, exported } = await Effect.runPromise(
      traced(() => Effect.succeed(new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } })))
    )

    const error = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined
    expect(error).toBeInstanceOf(ModelError)
    const failure = error as ModelError
    expect(failure.message).toContain(sentinel)

    expect(exported.text).not.toContain(sentinel)
    expectWithheld(named(exported, `chat ${modelId}`), "flows/model/ModelError", failure.code)
    expectWithheld(named(exported, "OpenAIResponses.step"), "flows/model/ModelError", failure.code)
  })

  it("export a provider's defect as its class name alone, and the caller still gets the defect", async () => {
    const defect = new TypeError(`fetch failed for "${sentinel}"`)
    defect.stack = `TypeError: fetch failed for "${sentinel}"\n    at provider (/srv/${sentinel}/client.js:1:1)`
    const { exit, exported } = await Effect.runPromise(traced(() => Effect.die(defect)))

    expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toBe(defect)

    expect(exported.text).not.toContain(sentinel)
    for (const name of [`chat ${modelId}`, "flows/model/Route.stream", "RequestExecutor.execute"]) {
      expectWithheld(named(exported, name), "TypeError", "redacted")
    }
  })
})

describe("SpanFailure.exit", () => {
  const failed = (cause: Cause.Cause<unknown>): ReadonlyArray<Error> => {
    const result = SpanFailure.exit(Exit.failCause(cause))
    return Exit.isFailure(result) ? Cause.prettyErrors(result.cause) : []
  }

  it("names each failure by its tag or class name and keeps only a tagged failure's token code", () => {
    const errors = failed(Cause.fromReasons<unknown>([
      Cause.makeFailReason(new ModelError({ code: "rate_limited", message: sentinel })),
      Cause.makeFailReason({ _tag: "flows/model/Unversioned", message: sentinel }),
      Cause.makeFailReason({ _tag: "Elsewhere", code: sentinel, message: sentinel }),
      Cause.makeFailReason({ _tag: 7, message: sentinel }),
      Cause.makeDieReason(Object.assign(new Error(sentinel), { name: `Named ${sentinel}` })),
      Cause.makeDieReason(sentinel)
    ]))
    expect(errors.map((error) => `${error.name}: ${error.message}`)).toEqual([
      "flows/model/ModelError: rate_limited",
      "flows/model/Unversioned: redacted",
      "Elsewhere: redacted",
      "Error: redacted",
      "Error: redacted",
      "Error: redacted"
    ])
    expect(errors.map((error) => error.stack).join("\n")).not.toContain(sentinel)
  })

  it("keeps an interruption beside a failure, and a stand-in as it is", () => {
    const once = SpanFailure.exit(Exit.failCause(Cause.fromReasons([
      Cause.makeFailReason(new ModelError({ code: "transport", message: sentinel })),
      Cause.makeInterruptReason(3)
    ])))
    const twice = SpanFailure.exit(once)
    expect(Exit.isFailure(twice) && twice.cause.reasons.map((reason) => reason._tag)).toEqual(["Fail", "Interrupt"])
    expect(Exit.isFailure(once) && Exit.isFailure(twice) && twice.cause.reasons[0]).toEqual(
      Exit.isFailure(once) && once.cause.reasons[0]
    )
  })

  it("passes a success and a bare interruption through unchanged", () => {
    const success = Exit.succeed(1)
    const interrupted = Exit.failCause(Cause.interrupt(3))
    expect(SpanFailure.exit(success)).toBe(success)
    expect(SpanFailure.exit(interrupted)).toBe(interrupted)
  })
})

describe("SpanFailure.tracer", () => {
  it("wraps a tracer once", () => {
    const wrapped = SpanFailure.tracer(Tracer.make({ span: (options) => new Tracer.NativeSpan(options) }))
    expect(SpanFailure.tracer(wrapped)).toBe(wrapped)
  })
})

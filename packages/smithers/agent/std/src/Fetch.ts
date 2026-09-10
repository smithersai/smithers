/**
 * HTTP GET flow declaration and portable handler.
 *
 * @since 1.0.0
 */
import * as Flow from "@smthrs/core/Flow"
import * as HttpClient from "@smthrs/kernel/HttpClient"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import { capability, envelope } from "./internal/Declaration.ts"
import { readBounded, requestError, Timeout, withDeadline } from "./internal/Http.ts"
import { MAX_OUTPUT_BYTES, notice, truncateBytes } from "./internal/Text.ts"
import { parseHttpUrl } from "./internal/Url.ts"
import * as StdError from "./StdError.ts"

/**
 * Registry name for the fetch flow.
 *
 * @category identifiers
 * @since 1.0.0
 */
export const name = "fetch"

/**
 * Model-facing description of the fetch flow.
 *
 * @category descriptions
 * @since 1.0.0
 */
export const description =
  "Get an absolute URL and return its status and text body; long bodies are truncated with a notice. Use http-post to send data."

/**
 * Input schema for the fetch flow.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Input = Schema.Struct({
  url: Schema.String.annotate({ description: "Absolute http or https URL to retrieve" }),
  headers: Schema.optional(Schema.Record(Schema.String, Schema.String)).annotate({
    description: "Additional request headers"
  }),
  timeout: Schema.optional(Timeout).annotate({
    description: "Total request and response body timeout in seconds; defaults to 30, capped at 120"
  })
})

/**
 * Decoded input accepted by the `fetch` flow.
 *
 * @category models
 * @since 1.0.0
 */
export type Input = typeof Input.Type

/**
 * Output schema for the fetch flow.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Output = Schema.Struct({
  status: Schema.Number.annotate({ description: "HTTP status code, including error statuses" }),
  body: Schema.String.annotate({ description: "Response body as text" }),
  truncated: Schema.Boolean.annotate({ description: "Whether the body exceeded the display budget" }),
  notice: Schema.optional(Schema.String.annotate({ description: "Truncation disclosure" }))
})

/**
 * Decoded output returned by the `fetch` flow.
 *
 * @category models
 * @since 1.0.0
 */
export type Output = typeof Output.Type

/**
 * Static effect envelope for the fetch flow.
 *
 * A retrieval leaves no durable state behind, so it is sealed even though it
 * leaves the machine.
 *
 * @category effects
 * @since 1.0.0
 */
export const effects = envelope({ tier: "sealed", mode: "expected", reads: [], writes: [] })

/**
 * Narrows the fetch effect envelope for one decoded input.
 *
 * Network reach is expressed as a capability rather than a path envelope, so
 * a retrieval has nothing left to narrow.
 *
 * @category effects
 * @since 1.0.0
 */
export const effectsFor = (_input: typeof Input.Type) => effects

/**
 * Capabilities required by the fetch flow.
 *
 * @category capabilities
 * @since 1.0.0
 */
export const capabilities = [capability("net:get", "*")]

/**
 * Declaration-only fetch flow.
 *
 * @category flows
 * @since 1.0.0
 */
export const flow = Flow.make({ name, description, input: Input, output: Output, capabilities, effects })

/**
 * Retrieves a URL through the permission-aware kernel HTTP client.
 *
 * Error statuses are ordinary results; only transport, permission, and body
 * decoding failures use the typed error channel.
 *
 * @category handlers
 * @since 1.0.0
 */
export const run = Effect.fn("Fetch.run")(function*(
  input: typeof Input.Type
): Effect.fn.Return<typeof Output.Type, StdError.StdError, HttpClient.HttpClient> {
  const url = parseHttpUrl(input.url)
  if (url === undefined) {
    return yield* Effect.fail(
      new StdError.StdError({
        code: "invalid_input",
        message: `URL must use http or https without user information: ${input.url}`,
        path: input.url
      })
    )
  }
  const client = yield* HttpClient.HttpClient
  const request = input.headers === undefined
    ? HttpClientRequest.get(url.toString())
    : HttpClientRequest.setHeaders(HttpClientRequest.get(url.toString()), input.headers)
  const { status, bytes } = yield* withDeadline(
    Effect.gen(function*() {
      const response = yield* client.execute(request).pipe(
        Effect.mapError((error) => requestError(input.url, error))
      )
      const bytes = yield* readBounded(response.stream, input.url).pipe(
        Effect.mapError((error) => requestError(input.url, error))
      )
      return { status: response.status, bytes }
    }),
    input.url,
    input.timeout
  )
  const text = new TextDecoder().decode(bytes)
  const rendered = truncateBytes(text, MAX_OUTPUT_BYTES, { keep: "head" })
  return {
    status,
    body: rendered.text,
    truncated: rendered.truncated,
    ...(rendered.truncated
      ? { notice: notice("bytes", rendered.keptBytes, rendered.keptBytes + rendered.droppedBytes) }
      : {})
  }
})

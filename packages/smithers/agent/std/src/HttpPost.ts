/**
 * HTTP POST flow declaration and portable handler.
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
 * Registry name for the http-post flow.
 *
 * @category identifiers
 * @since 1.0.0
 */
export const name = "http-post"

/**
 * Model-facing description of the http-post flow.
 *
 * @category descriptions
 * @since 1.0.0
 */
export const description =
  "Post a text body to an absolute URL and return the response; this is irreversible because the remote side may already have acted."

/**
 * Input schema for the http-post flow.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Input = Schema.Struct({
  url: Schema.String.annotate({ description: "Absolute http or https URL to post to" }),
  body: Schema.String.annotate({ description: "Request body sent verbatim" }),
  contentType: Schema.optional(Schema.String).annotate({
    description: "Request content type; defaults to application/json"
  }),
  headers: Schema.optional(Schema.Record(Schema.String, Schema.String)).annotate({
    description: "Additional request headers"
  }),
  timeout: Schema.optional(Timeout).annotate({
    description: "Total request and response body timeout in seconds; defaults to 30, capped at 120"
  })
})

/**
 * Decoded input accepted by the `http-post` flow.
 *
 * @category models
 * @since 1.0.0
 */
export type Input = typeof Input.Type

/**
 * Output schema for the http-post flow.
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
 * Decoded output returned by the `http-post` flow.
 *
 * @category models
 * @since 1.0.0
 */
export type Output = typeof Output.Type

/**
 * Static effect envelope for the http-post flow.
 *
 * @category effects
 * @since 1.0.0
 */
export const effects = envelope({ tier: "irreversible", mode: "expected", reads: [], writes: [] })

/**
 * Narrows the http-post effect envelope for one decoded input.
 *
 * Network reach is expressed as a capability rather than a path envelope, so
 * a post has nothing left to narrow.
 *
 * @category effects
 * @since 1.0.0
 */
export const effectsFor = (_input: typeof Input.Type) => effects

/**
 * Capabilities required by the http-post flow.
 *
 * @category capabilities
 * @since 1.0.0
 */
export const capabilities = [capability("net:post", "*")]

/**
 * Declaration-only http-post flow.
 *
 * @category flows
 * @since 1.0.0
 */
export const flow = Flow.make({ name, description, input: Input, output: Output, capabilities, effects })

/**
 * Posts a body through the permission-aware kernel HTTP client.
 *
 * @category handlers
 * @since 1.0.0
 */
export const run = Effect.fn("HttpPost.run")(function*(
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
  const requestWithBody = HttpClientRequest.post(url.toString()).pipe(
    HttpClientRequest.bodyText(input.body, input.contentType ?? "application/json")
  )
  const request = input.headers === undefined
    ? requestWithBody
    : HttpClientRequest.setHeaders(requestWithBody, input.headers)
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

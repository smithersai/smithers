/**
 * OpenAPI 3.0 and 3.1 operations as typed, executable flows.
 *
 * {@link fromSpec} reads a JSON OpenAPI document and returns one
 * {@link OperationFlow} per selected operation. Each flow carries a Schema for
 * its input and output and an `execute` that sends exactly one request through
 * the `HttpClient` in context, so the same flows run in a browser, a Worker,
 * Node, or Bun, and behind an egress client that swaps `@smthrs/secrets`
 * placeholders in headers for their values.
 *
 * The document names the operations; it never names the host. Requests go to
 * `baseUrl` only, and four rules keep a call from leaving it:
 *
 * - **Origin pin.** `baseUrl` must be `https:` (or `http:` with
 *   `allowInsecureHttp`), with no credentials, query, or fragment, and every
 *   rendered URL is checked against its origin and path before it is sent. A
 *   redirect is answered, not followed, and fails as `http_error`.
 * - **Path segments.** A path parameter is one URL-encoded segment. A value
 *   that is empty, `.` or `..`, or that holds `/`, `\`, a control character,
 *   or an encoded `/`, `\`, `.` or NUL fails `unsafe_path`.
 * - **Headers.** Static and per-call header values reject CR, LF, and NUL, and
 *   a per-call header never overrides a static one, so a call cannot replace
 *   the credential the host configured.
 * - **Bounds.** At most `maxOperations` flows, at most `maxResponseBytes` of
 *   body per call, and a `requestTimeoutMillis` deadline over the exchange.
 *
 * {@link toBindings} turns the flows into `{ flow, handler }` pairs that
 * `FlowBinding.make` from `@smthrs/harness` accepts, without this package
 * depending on the harness.
 *
 * @since 1.0.0
 */

import { Duration, Effect, Result, Schema, Stream } from "effect"
import * as HttpClient from "effect/http/HttpClient"
import type * as HttpClientError from "effect/http/HttpClientError"
import * as HttpClientRequest from "effect/http/HttpClientRequest"
import type * as HttpClientResponse from "effect/http/HttpClientResponse"
import { forCredentials, transportCause } from "./core/CredentialHttp.ts"

/**
 * Every classification an {@link OpenApiError} can carry.
 *
 * @category models
 * @since 1.0.0
 */
export const codes = [
  "invalid_spec",
  "invalid_base_url",
  "invalid_input",
  "unsafe_path",
  "http_error",
  "response_too_large",
  "limit_exceeded"
] as const

/**
 * What went wrong, coarsely enough for a caller to act on.
 *
 * @category models
 * @since 1.0.0
 */
export type Code = typeof codes[number]

/**
 * A refused spec, option, or input, or a failed call.
 *
 * `status` is the HTTP status of an `http_error` the server answered.
 * `retryable` is true when repeating the call is safe: a 408 or 429 for any
 * method, and a 5xx, a transport failure, or a timeout for a `GET`, `HEAD`,
 * or `OPTIONS`. Messages never carry header values or response bodies.
 *
 * @category errors
 * @since 1.0.0
 */
export class OpenApiError extends Schema.TaggedError<OpenApiError>()("@smthrs/integrations/OpenApiError", {
  code: Schema.Literals(codes),
  message: Schema.String,
  status: Schema.optionalKey(Schema.Number),
  retryable: Schema.optionalKey(Schema.Boolean)
}) {}

const fail = (code: Code, message: string): Effect.Effect<never, OpenApiError> =>
  Effect.fail(new OpenApiError({ code, message }))

/**
 * The HTTP methods an OpenAPI path item may declare.
 *
 * @category constants
 * @since 1.0.0
 */
export const methods = ["get", "post", "put", "patch", "delete", "head", "options"] as const

/**
 * One OpenAPI operation method.
 *
 * @category models
 * @since 1.0.0
 */
export type Method = typeof methods[number]

const SAFE_METHODS: ReadonlyArray<Method> = ["get", "head", "options"]

/**
 * The default {@link FromSpecOptions.maxOperations}.
 *
 * @category constants
 * @since 1.0.0
 */
export const DEFAULT_MAX_OPERATIONS = 128

/**
 * The default {@link FromSpecOptions.maxResponseBytes}: 1 MiB.
 *
 * @category constants
 * @since 1.0.0
 */
export const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024

/**
 * The default {@link FromSpecOptions.requestTimeoutMillis}: 30 seconds.
 *
 * @category constants
 * @since 1.0.0
 */
export const DEFAULT_REQUEST_TIMEOUT_MILLIS = 30_000

/**
 * How {@link fromSpec} binds a document to a host.
 *
 * @category models
 * @since 1.0.0
 */
export interface FromSpecOptions {
  /** The only origin calls reach, with an optional base path. The document's `servers` are ignored. */
  readonly baseUrl: string
  /** Permits an `http:` base URL. Off by default. */
  readonly allowInsecureHttp?: boolean | undefined
  /** Prefixes every flow name as `<namespace>.<operationId>`. */
  readonly namespace?: string | undefined
  /** Keeps only these operationIds. Every name must exist in the document. */
  readonly include?: ReadonlyArray<string> | undefined
  /** Drops these operationIds. Every name must exist in the document. */
  readonly exclude?: ReadonlyArray<string> | undefined
  /** Headers sent on every call, such as `authorization` holding a secret placeholder. */
  readonly headers?: Readonly<Record<string, string>> | undefined
  /** The most operations the selection may hold. Defaults to {@link DEFAULT_MAX_OPERATIONS}. */
  readonly maxOperations?: number | undefined
  /** The most body bytes one call reads. Defaults to {@link DEFAULT_MAX_RESPONSE_BYTES}. */
  readonly maxResponseBytes?: number | undefined
  /** The deadline over one exchange. Defaults to {@link DEFAULT_REQUEST_TIMEOUT_MILLIS}. */
  readonly requestTimeoutMillis?: number | undefined
}

/**
 * A scalar parameter value.
 *
 * @category models
 * @since 1.0.0
 */
export type Scalar = string | number | boolean

/**
 * The input every operation accepts. Which keys an operation requires is in
 * its {@link OperationFlow.inputSchema}.
 *
 * @category models
 * @since 1.0.0
 */
export interface OperationInput {
  readonly path?: Readonly<Record<string, Scalar>> | undefined
  readonly query?: Readonly<Record<string, Scalar | ReadonlyArray<Scalar>>> | undefined
  readonly headers?: Readonly<Record<string, Scalar>> | undefined
  readonly body?: Schema.Json | undefined
}

/**
 * What a successful call returns: the 2xx status and the body, parsed as
 * JSON when the response says it is JSON, else the text, and `null` when
 * empty.
 *
 * @category models
 * @since 1.0.0
 */
export interface OperationOutput {
  readonly status: number
  readonly body: Schema.Json
}

/**
 * The schema of {@link OperationOutput}.
 *
 * @category schemas
 * @since 1.0.0
 */
export const OperationOutput: Schema.Codec<OperationOutput> = Schema.Struct({
  status: Schema.Number,
  body: Schema.Json
})

/**
 * The effect declaration a flow carries, structurally the one
 * `@smthrs/plan/Effects` defines.
 *
 * @category models
 * @since 1.0.0
 */
export interface EffectDeclaration {
  readonly reads: ReadonlyArray<string>
  readonly writes: ReadonlyArray<string>
  readonly mode: "expected"
  readonly onConflict: "serialize"
  readonly tier: "sealed" | "irreversible"
}

/**
 * One OpenAPI operation as an executable flow.
 *
 * @category models
 * @since 1.0.0
 */
export interface OperationFlow {
  /** The flow name: the operationId, prefixed by the namespace. */
  readonly name: string
  readonly operationId: string
  readonly description: string
  readonly method: Method
  readonly pathTemplate: string
  /** `net:get:<host>` for a safe method, else `net:post:<host>`. */
  readonly capabilities: ReadonlyArray<string>
  readonly effects: EffectDeclaration
  readonly inputSchema: Schema.Codec<OperationInput>
  readonly outputSchema: Schema.Codec<OperationOutput>
  /** Validates `input`, then sends one request. */
  readonly execute: (input: unknown) => Effect.Effect<OperationOutput, OpenApiError, HttpClient.HttpClient>
}

/**
 * A `FlowBinding.make` options pair.
 *
 * @category models
 * @since 1.0.0
 */
export interface BindingDescriptor {
  readonly flow: {
    readonly name: string
    readonly description: string
    readonly input: Schema.Codec<OperationInput>
    readonly output: Schema.Codec<OperationOutput>
    readonly capabilities: ReadonlyArray<string>
    readonly effects: EffectDeclaration
  }
  readonly handler: (input: OperationInput) => Effect.Effect<OperationOutput, OpenApiError, HttpClient.HttpClient>
}

type Json = Record<string, unknown>

interface Parameter {
  readonly name: string
  readonly in: "path" | "query" | "header"
  readonly required: boolean
  readonly schema: Schema.Top
  readonly array: boolean
}

interface Operation {
  readonly operationId: string
  readonly method: Method
  readonly path: string
  readonly node: Json
  readonly item: Json
}

const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value)

const IDENTIFIER = /^[A-Za-z0-9_.-]{1,128}$/
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,256}$/
const UNSAFE_HEADER_VALUE = /[\r\n\0]/
// A path segment refuses separators, control characters, and encoded `/`, `\`, `.` and NUL.
const UNSAFE_SEGMENT = /[/\\]|%(?:2f|5c|2e|00)/i
const hasControl = (text: string): boolean => [...text].some((c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f)
const TEMPLATE = /\{([^{}]*)\}/g

const resolveRef = (spec: Json, value: unknown, where: string): Effect.Effect<Json, OpenApiError> => {
  if (!isObject(value)) return fail("invalid_spec", `${where} is not an object.`)
  if (!("$ref" in value)) return Effect.succeed(value)
  const ref = value.$ref
  const match = typeof ref === "string" ? /^#\/components\/([^/]+)\/([^/]+)$/.exec(ref) : null
  const decode = (part: string) => part.replaceAll("~1", "/").replaceAll("~0", "~")
  const components = spec.components
  const group = match === null || !isObject(components) ? undefined : components[decode(match[1]!)]
  const target = match === null || !isObject(group) ? undefined : group[decode(match[2]!)]
  // One hop only: a reference to a reference is refused rather than followed.
  return isObject(target) && !("$ref" in target)
    ? Effect.succeed(target)
    : fail("invalid_spec", `${where} has an unresolvable $ref; only one-hop #/components/<kind>/<name> is supported.`)
}

const scalarSchema = (schema: Json): Schema.Top => {
  if (Array.isArray(schema.enum) && schema.enum.length > 0 && schema.enum.every((v) => typeof v === "string")) {
    return Schema.Literals(schema.enum)
  }
  switch (schema.type) {
    case "string":
      return Schema.String
    case "integer":
      return Schema.Int
    case "number":
      return Schema.Finite
    case "boolean":
      return Schema.Boolean
    default:
      return Schema.Union([Schema.String, Schema.Finite, Schema.Boolean])
  }
}

const parameter = (spec: Json, raw: unknown, where: string): Effect.Effect<Parameter, OpenApiError> =>
  Effect.gen(function*() {
    const node = yield* resolveRef(spec, raw, where)
    const { name, in: location } = node
    if (typeof name !== "string" || name.length === 0) return yield* fail("invalid_spec", `${where} has no name.`)
    if (location !== "path" && location !== "query" && location !== "header") {
      return yield* fail("invalid_spec", `${where} (${name}) is in ${String(location)}; only path, query, header.`)
    }
    if (location === "header" && !HEADER_NAME.test(name)) {
      return yield* fail("invalid_spec", `${where} has an invalid header name.`)
    }
    const schema = isObject(node.schema) ? node.schema : {}
    const array = schema.type === "array"
    if (array && location !== "query") {
      return yield* fail("invalid_spec", `${where} (${name}) is an array; only query parameters may be.`)
    }
    const scalar = scalarSchema(array && isObject(schema.items) ? schema.items : array ? {} : schema)
    return {
      name,
      in: location,
      required: location === "path" || node.required === true,
      schema: array ? Schema.Array(scalar) : scalar,
      array
    }
  })

const parameters = (spec: Json, operation: Operation): Effect.Effect<ReadonlyArray<Parameter>, OpenApiError> =>
  Effect.gen(function*() {
    const where = `${operation.operationId} parameter`
    const merged = new Map<string, Parameter>()
    for (const list of [operation.item.parameters, operation.node.parameters]) {
      if (list === undefined) continue
      if (!Array.isArray(list)) {
        return yield* fail("invalid_spec", `${operation.operationId} parameters is not an array.`)
      }
      // Operation-level parameters override path-level ones with the same name and location.
      for (const raw of list) {
        const found = yield* parameter(spec, raw, where)
        merged.set(`${found.in}:${found.in === "header" ? found.name.toLowerCase() : found.name}`, found)
      }
    }
    const declared = [...merged.values()]
    const inTemplate = [...operation.path.matchAll(TEMPLATE)].map((match) => match[1]!)
    const pathNames = declared.filter((p) => p.in === "path").map((p) => p.name)
    const missing = inTemplate.find((name) => !pathNames.includes(name))
    if (missing !== undefined) {
      return yield* fail("invalid_spec", `${operation.operationId} has no path parameter for {${missing}}.`)
    }
    const unused = pathNames.find((name) => !inTemplate.includes(name))
    if (unused !== undefined) {
      return yield* fail("invalid_spec", `${operation.operationId} declares path parameter ${unused} not in its path.`)
    }
    return declared
  })

const JSON_MEDIA = /^application\/(?:[\w.+-]+\+)?json(?:\s*;.*)?$/i

const requestBody = (spec: Json, operation: Operation): Effect.Effect<"none" | "optional" | "required", OpenApiError> =>
  Effect.gen(function*() {
    if (operation.node.requestBody === undefined) return "none"
    const node = yield* resolveRef(spec, operation.node.requestBody, `${operation.operationId} requestBody`)
    const content = node.content
    if (!isObject(content) || !Object.keys(content).some((media) => JSON_MEDIA.test(media))) {
      return yield* fail("invalid_spec", `${operation.operationId} requestBody has no JSON media type.`)
    }
    return node.required === true ? "required" : "optional"
  })

const group = (members: ReadonlyArray<Parameter>, header: boolean): Schema.Top => {
  const fields: Record<string, Schema.Top> = {}
  for (const p of members) {
    const key = header ? p.name.toLowerCase() : p.name
    fields[key] = p.required ? p.schema : Schema.optionalKey(p.schema)
  }
  return Schema.Struct(fields)
}

const inputSchemaOf = (
  declared: ReadonlyArray<Parameter>,
  body: "none" | "optional" | "required"
): Schema.Codec<OperationInput> => {
  const fields: Record<string, Schema.Top> = {}
  for (const location of ["path", "query", "header"] as const) {
    const members = declared.filter((p) => p.in === location)
    if (members.length === 0) continue
    const schema = group(members, location === "header")
    fields[location === "header" ? "headers" : location] = members.some((p) => p.required)
      ? schema
      : Schema.optionalKey(schema)
  }
  if (body !== "none") fields.body = body === "required" ? Schema.Json : Schema.optionalKey(Schema.Json)
  return Schema.Struct(fields) as unknown as Schema.Codec<OperationInput>
}

const encodeSegment = (name: string, value: Scalar): Effect.Effect<string, OpenApiError> => {
  const text = String(value)
  return text.length === 0 || text === "." || text === ".." || UNSAFE_SEGMENT.test(text) || hasControl(text)
    ? fail("unsafe_path", `Path parameter ${name} is not one safe path segment.`)
    : Effect.succeed(encodeURIComponent(text))
}

const checkPathTemplate = (path: string): boolean =>
  path.startsWith("/") && !/[?#\\\0]/.test(path) &&
  path.split("/").every((segment) => segment !== "." && segment !== "..") &&
  [...path.matchAll(TEMPLATE)].every((match) => IDENTIFIER.test(match[1]!)) &&
  !/[{}]/.test(path.replaceAll(TEMPLATE, ""))

const parseBaseUrl = (options: FromSpecOptions): Effect.Effect<URL, OpenApiError> => {
  let url: URL
  try {
    url = new URL(options.baseUrl)
  } catch {
    return fail("invalid_base_url", "baseUrl is not an absolute URL.")
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && options.allowInsecureHttp === true)) {
    return fail("invalid_base_url", "baseUrl must be https:, or http: with allowInsecureHttp.")
  }
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
    return fail("invalid_base_url", "baseUrl must not carry credentials, a query, or a fragment.")
  }
  return Effect.succeed(url)
}

const checkLimit = (name: string, value: number | undefined, fallback: number): Effect.Effect<number, OpenApiError> =>
  value === undefined
    ? Effect.succeed(fallback)
    : Number.isSafeInteger(value) && value >= 1
    ? Effect.succeed(value)
    : fail("invalid_input", `${name} must be a positive integer.`)

const checkHeaders = (
  headers: Readonly<Record<string, string>> | undefined
): Effect.Effect<Record<string, string>, OpenApiError> => {
  const checked: Record<string, string> = {}
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (!HEADER_NAME.test(name) || typeof value !== "string" || UNSAFE_HEADER_VALUE.test(value)) {
      return fail("invalid_input", `Static header ${JSON.stringify(name.slice(0, 64))} has an unsafe name or value.`)
    }
    checked[name.toLowerCase()] = value
  }
  return Effect.succeed(checked)
}

const derivedId = (method: Method, path: string): string =>
  `${method}${path.replaceAll(/[{}]/g, "").replaceAll(/[^A-Za-z0-9]+/g, "_").replace(/_+$/, "")}`.slice(0, 128)

const collect = (spec: Json): Effect.Effect<ReadonlyArray<Operation>, OpenApiError> =>
  Effect.gen(function*() {
    if (typeof spec.openapi !== "string" || !/^3\.[01](?:\.\d+)?$/.test(spec.openapi)) {
      return yield* fail("invalid_spec", "The document is not OpenAPI 3.0 or 3.1.")
    }
    if (!isObject(spec.paths)) return yield* fail("invalid_spec", "The document has no paths object.")
    const operations: Array<Operation> = []
    const seen = new Set<string>()
    for (const [path, item] of Object.entries(spec.paths)) {
      if (!checkPathTemplate(path)) {
        return yield* fail("invalid_spec", `Path ${JSON.stringify(path)} is not a safe template.`)
      }
      if (!isObject(item)) {
        return yield* fail("invalid_spec", `Path ${path} is not an object.`)
      }
      for (const method of methods) {
        const node = item[method]
        if (node === undefined) continue
        if (!isObject(node)) return yield* fail("invalid_spec", `${method.toUpperCase()} ${path} is not an object.`)
        const operationId = node.operationId === undefined ? derivedId(method, path) : node.operationId
        if (typeof operationId !== "string" || !IDENTIFIER.test(operationId)) {
          return yield* fail("invalid_spec", `${method.toUpperCase()} ${path} has an invalid operationId.`)
        }
        if (seen.has(operationId)) return yield* fail("invalid_spec", `operationId ${operationId} is not unique.`)
        seen.add(operationId)
        operations.push({ operationId, method, path, node, item })
      }
    }
    return operations
  })

const select = (
  operations: ReadonlyArray<Operation>,
  options: FromSpecOptions
): Effect.Effect<ReadonlyArray<Operation>, OpenApiError> => {
  const ids = new Set(operations.map((operation) => operation.operationId))
  const unknown = [...(options.include ?? []), ...(options.exclude ?? [])].find((id) => !ids.has(id))
  if (unknown !== undefined) return fail("invalid_input", `No operation has operationId ${JSON.stringify(unknown)}.`)
  const include = options.include === undefined ? undefined : new Set(options.include)
  const exclude = new Set(options.exclude ?? [])
  return Effect.succeed(
    operations.filter((operation) =>
      (include === undefined || include.has(operation.operationId)) && !exclude.has(operation.operationId)
    )
  )
}

const readBounded = (
  response: HttpClientResponse.HttpClientResponse,
  limit: number
): Effect.Effect<Uint8Array, OpenApiError | HttpClientError.HttpClientError> => {
  const tooLarge = () =>
    new OpenApiError({ code: "response_too_large", message: `The response body exceeds ${limit} bytes.` })
  const declared = Number(response.headers["content-length"])
  if (Number.isFinite(declared) && declared > limit) return Effect.fail(tooLarge())
  const chunks: Array<Uint8Array> = []
  let size = 0
  return Stream.runForEach(response.stream, (chunk) => {
    size += chunk.byteLength
    if (size > limit) return Effect.fail(tooLarge())
    chunks.push(chunk)
    return Effect.void
  }).pipe(
    // A response with no body, such as a 204, is an empty one.
    Effect.catchIf(
      (error) => error._tag === "HttpClientError" && error.reason._tag === "EmptyBodyError",
      () => Effect.void
    ),
    Effect.map(() => {
      const bytes = new Uint8Array(size)
      let offset = 0
      for (const chunk of chunks) {
        bytes.set(chunk, offset)
        offset += chunk.byteLength
      }
      return bytes
    })
  )
}

const parseBody = (bytes: Uint8Array, contentType: string | undefined): Schema.Json => {
  if (bytes.byteLength === 0) return null
  const text = new TextDecoder().decode(bytes)
  if (contentType === undefined || !JSON_MEDIA.test(contentType.trim())) return text
  try {
    return JSON.parse(text) as Schema.Json
  } catch {
    return text
  }
}

interface Bound {
  readonly base: URL
  readonly headers: Record<string, string>
  readonly maxResponseBytes: number
  readonly timeout: Duration.Duration
}

const operationFlow = (
  operation: Operation,
  declared: ReadonlyArray<Parameter>,
  body: "none" | "optional" | "required",
  bound: Bound,
  namespace: string | undefined
): OperationFlow => {
  const { operationId, method, path } = operation
  const inputSchema = inputSchemaOf(declared, body)
  const decode = Schema.decodeUnknownResult(inputSchema, {
    onExcessProperty: "error"
  })
  const safe = SAFE_METHODS.includes(method)
  const basePath = bound.base.pathname.replace(/\/+$/, "")
  const label = `${method.toUpperCase()} ${operationId}`
  const summary = typeof operation.node.summary === "string" ? operation.node.summary : undefined
  const detail = typeof operation.node.description === "string" ? operation.node.description : undefined

  const render = (input: OperationInput): Effect.Effect<string, OpenApiError> =>
    Effect.gen(function*() {
      let rendered = ""
      let last = 0
      for (const match of path.matchAll(TEMPLATE)) {
        const name = match[1]!
        // The input schema requires every path parameter, so the value is present.
        rendered += path.slice(last, match.index) + (yield* encodeSegment(name, input.path![name]!))
        last = match.index + match[0].length
      }
      rendered += path.slice(last)
      const query = new URLSearchParams()
      for (const p of declared) {
        if (p.in !== "query") continue
        const value = input.query?.[p.name]
        if (value === undefined) continue
        for (const each of Array.isArray(value) ? value : [value]) query.append(p.name, String(each))
      }
      const search = query.size === 0 ? "" : `?${query.toString()}`
      // The template is checked and every segment encoded, so the URL stays on the base origin and path.
      return new URL(`${bound.base.origin}${basePath}${rendered}${search}`).href
    })

  const headersFor = (input: OperationInput): Effect.Effect<Record<string, string>, OpenApiError> => {
    const headers: Record<string, string> = {}
    for (const [name, value] of Object.entries(input.headers ?? {})) {
      const text = String(value)
      if (UNSAFE_HEADER_VALUE.test(text)) return fail("invalid_input", `Header ${name} has an unsafe value.`)
      headers[name] = text
    }
    if (input.body !== undefined) headers["content-type"] = "application/json"
    // Static headers win, so a call cannot replace the host's credential.
    return Effect.succeed({ ...headers, ...bound.headers })
  }

  const httpError = (message: string, retryable: boolean, status?: number) =>
    new OpenApiError({
      code: "http_error",
      message,
      retryable,
      ...(status === undefined ? {} : { status })
    })

  const send = (input: OperationInput) =>
    Effect.gen(function*() {
      const url = yield* render(input)
      const headers = yield* headersFor(input)
      const base = HttpClientRequest.make(method.toUpperCase() as "GET")(url, { headers })
      const request = input.body === undefined
        ? base
        : HttpClientRequest.bodyText(base, JSON.stringify(input.body), "application/json")
      const http = forCredentials(yield* HttpClient.HttpClient)
      return yield* http.execute(request).pipe(
        Effect.provideService(HttpClient.TracerDisabledWhen, () => true),
        Effect.flatMap((response) =>
          response.status >= 200 && response.status < 300
            ? Effect.map(readBounded(response, bound.maxResponseBytes), (bytes): OperationOutput => ({
              status: response.status,
              body: parseBody(bytes, response.headers["content-type"])
            }))
            : Effect.fail(httpError(
              `${label} answered HTTP ${response.status}.`,
              response.status === 408 || response.status === 429 || (safe && response.status >= 500),
              response.status
            ))
        ),
        Effect.catchTag("HttpClientError", (error) => {
          const cause = transportCause(error)
          return Effect.fail(httpError(
            `${label} failed in transport: ${cause instanceof Error ? cause.name : "unknown"}.`,
            safe
          ))
        }),
        Effect.timeoutOrElse({
          duration: bound.timeout,
          orElse: () => Effect.fail(httpError(`${label} timed out after ${Duration.toMillis(bound.timeout)} ms.`, safe))
        })
      )
    })

  return {
    name: namespace === undefined ? operationId : `${namespace}.${operationId}`,
    operationId,
    description: summary ?? detail ?? `${method.toUpperCase()} ${path}`,
    method,
    pathTemplate: path,
    capabilities: [`net:${safe ? "get" : "post"}:${bound.base.host}`],
    effects: {
      reads: [],
      writes: [],
      mode: "expected",
      onConflict: "serialize",
      tier: safe ? "sealed" : "irreversible"
    },
    inputSchema,
    outputSchema: OperationOutput,
    execute: (input) => {
      const decoded = decode(input)
      return Result.isFailure(decoded)
        ? fail("invalid_input", `${label} rejected its input: ${decoded.failure.message}`)
        : send(decoded.success)
    }
  }
}

/**
 * Builds one {@link OperationFlow} per selected operation in `spec`.
 *
 * Fails `invalid_spec` for a document outside the supported subset,
 * `invalid_base_url` for a refused `baseUrl`, `invalid_input` for a refused
 * option, and `limit_exceeded` when the selection holds more than
 * `maxOperations`. Only selected operations are deep-validated, so `exclude`
 * drops an operation this module cannot run.
 *
 * @example
 * ```ts
 * import { OpenApi } from "@smthrs/integrations"
 * import { Effect } from "effect"
 * import { FetchHttpClient } from "effect/http"
 *
 * const program = Effect.gen(function*() {
 *   const [getPet] = yield* OpenApi.fromSpec(spec, { baseUrl: "https://pets.example", include: ["getPet"] })
 *   return yield* getPet!.execute({ path: { petId: 7 } })
 * }).pipe(Effect.provide(FetchHttpClient.layer))
 * ```
 *
 * @category constructors
 * @since 1.0.0
 */
export const fromSpec = (
  spec: unknown,
  options: FromSpecOptions
): Effect.Effect<ReadonlyArray<OperationFlow>, OpenApiError> =>
  Effect.gen(function*() {
    const base = yield* parseBaseUrl(options)
    if (options.namespace !== undefined && !IDENTIFIER.test(options.namespace)) {
      return yield* fail("invalid_input", "namespace must match [A-Za-z0-9_.-]{1,128}.")
    }
    const headers = yield* checkHeaders(options.headers)
    const maxOperations = yield* checkLimit("maxOperations", options.maxOperations, DEFAULT_MAX_OPERATIONS)
    const maxResponseBytes = yield* checkLimit(
      "maxResponseBytes",
      options.maxResponseBytes,
      DEFAULT_MAX_RESPONSE_BYTES
    )
    const timeoutMillis = yield* checkLimit(
      "requestTimeoutMillis",
      options.requestTimeoutMillis,
      DEFAULT_REQUEST_TIMEOUT_MILLIS
    )
    if (!isObject(spec)) return yield* fail("invalid_spec", "The document is not a JSON object.")
    const selected = yield* select(yield* collect(spec), options)
    if (selected.length > maxOperations) {
      return yield* fail("limit_exceeded", `${selected.length} operations exceed maxOperations ${maxOperations}.`)
    }
    const bound: Bound = { base, headers, maxResponseBytes, timeout: Duration.millis(timeoutMillis) }
    const flows: Array<OperationFlow> = []
    for (const operation of selected) {
      flows.push(operationFlow(
        operation,
        yield* parameters(spec, operation),
        yield* requestBody(spec, operation),
        bound,
        options.namespace
      ))
    }
    return flows
  })

/**
 * Pairs each flow with its handler in the shape `FlowBinding.make` accepts.
 *
 * @example
 * ```ts
 * import * as FlowBinding from "@smthrs/harness/FlowBinding"
 * import { OpenApi } from "@smthrs/integrations"
 *
 * const bindings = OpenApi.toBindings(flows).map((options) => FlowBinding.make(options))
 * ```
 *
 * @category conversions
 * @since 1.0.0
 */
export const toBindings = (operations: ReadonlyArray<OperationFlow>): ReadonlyArray<BindingDescriptor> =>
  operations.map((operation) => ({
    flow: {
      name: operation.name,
      description: operation.description,
      input: operation.inputSchema,
      output: operation.outputSchema,
      capabilities: operation.capabilities,
      effects: operation.effects
    },
    handler: (input) => operation.execute(input)
  }))

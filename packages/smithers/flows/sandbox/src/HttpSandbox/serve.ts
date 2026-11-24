/**
 * Serves a retained `Sandbox.Provider` over HTTP.
 *
 * @since 1.0.0-rc.17
 */

import * as CommandLine from "@smthrs/kernel/CommandLine"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import type * as Scope from "effect/Scope"
import * as Stream from "effect/Stream"
import type { RemoteOptions } from "../RemoteChildProcessSpawner/Provider.ts"
import type { ProviderError } from "../RemoteChildProcessSpawner/ProviderError.ts"
import type { Provider } from "../Sandbox/Provider.ts"
import type { ResourceLimits } from "../Sandbox/ResourceLimits.ts"
import type { Session } from "../Sandbox/Session.ts"
import { byteBudget } from "./bytes.ts"
import { Acquire, Command, CommandResult, Failure, LimitsQuery, SessionInfo, statusOf } from "./protocol.ts"

/**
 * What `serve` needs: the provider that holds the machines, and the bearer
 * token every request must carry.
 *
 * @category models
 * @since 1.0.0-rc.17
 */
export interface ServeOptions {
  /**
   * The retained provider, or a choice of one by the session's limits. Every
   * request carries the limits its session was acquired with, so a function
   * picks the same provider for every request of one session. A fixed
   * provider ignores the limits.
   */
  readonly provider: Provider | ((limits: ResourceLimits | undefined) => Provider)
  /** The bearer token every request must carry; compared in constant time. */
  readonly token: string
  /** Maximum bytes accepted in a single request (default 24 MiB). */
  readonly maxRequestBytes?: number | undefined
  /** Maximum combined stdout and stderr bytes of one command (default 4 MiB). */
  readonly maxOutputBytes?: number | undefined
}

/** A request this service answers with a status of its own. */
class Refusal extends Data.TaggedError("Refusal")<{
  readonly status: number
  readonly code: ProviderError["code"]
  readonly message: string
}> {}

const malformed = (message: string) => new Refusal({ status: 400, code: "unknown", message })

const json = (status: number, body: string) =>
  new Response(body, { status, headers: { "content-type": "application/json" } })

const encodeFailure = Schema.encodeSync(Schema.fromJsonString(Failure))
const encodeInfo = Schema.encodeSync(Schema.fromJsonString(SessionInfo))
const encodeResult = Schema.encodeSync(Schema.fromJsonString(CommandResult))
const decodeAcquire = Schema.decodeUnknownEffect(Schema.fromJsonString(Acquire))
const decodeCommand = Schema.decodeUnknownEffect(Schema.fromJsonString(Command))
const decodeLimits = Schema.decodeUnknownEffect(LimitsQuery)

/** Compares every character, so the time taken does not reveal a matching prefix. */
const sameText = (left: string, right: string): boolean => {
  let difference = left.length ^ right.length
  // `charCodeAt` past the end is NaN, and `NaN | 0` is 0.
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    difference |= (left.charCodeAt(index) | 0) ^ (right.charCodeAt(index) | 0)
  }
  return difference === 0
}

type Retained = Provider & {
  readonly attach: NonNullable<Provider["attach"]>
  readonly destroy: NonNullable<Provider["destroy"]>
}

const retained = (provider: Provider): Retained => {
  if (provider.retained !== true || provider.attach === undefined || provider.destroy === undefined) {
    throw new TypeError("HttpSandbox.serve requires a retained provider with attach and destroy")
  }
  return provider as Retained
}

const limit = (value: number, name: string) => {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`http-sandbox: invalid ${name}`)
  return value
}

const tooLarge = () => new Refusal({ status: 413, code: "unknown", message: "byte limit exceeded" })

/** Runs a command within a single byte budget shared by both output streams. */
const runToEnd = (session: Session, command: string, options: RemoteOptions, maxBytes: number) =>
  Effect.flatMap(session.spawn(command, options), (child) => {
    const collect = byteBudget(maxBytes, tooLarge())
    return Effect.all([collect(child.stdout), collect(child.stderr), child.exitCode], { concurrency: "unbounded" })
      .pipe(Effect.map(([stdout, stderr, exitCode]) => ({ stdout, stderr, exitCode })))
  })

/**
 * Every delivery writes the same byte range. A concurrent duplicate or a
 * retry of a partial write cannot extend the file past the chunk's end.
 * The seek and the copy share one open file description, so the copy can use
 * normal block sizes even when the destination offset is unaligned.
 */
const appendScript = (path: string, offset: number, end: number) =>
  `f=${CommandLine.quote(path)}
` +
  `s=$(wc -c <"$f") || exit 3; [ "$s" -ge ${offset} ] && [ "$s" -le ${end} ] || exit 3
` +
  `if [ "$s" -eq ${end} ]; then cat >/dev/null; exit $?; fi\n` +
  `exec 3<>"$f" || exit 3
` +
  `dd bs=1 count=0 seek=${offset} conv=notrunc >&3 2>/dev/null && cat >&3 || exit 3
` +
  `s=$(wc -c <"$f") && [ "$s" -eq ${end} ]`

/**
 * Turns a retained `Sandbox.Provider` into an HTTP handler on web-standard
 * `Request` and `Response`, which a Cloudflare Worker or a Node server mounts.
 *
 * The handler keeps nothing between requests. Each request acquires or
 * attaches the machine it names in a scope of its own, which a retained
 * provider closes without stopping the machine. A provider that is not
 * retained, or lacks `attach` or `destroy`, throws a `TypeError` here, as
 * does an empty token; a provider function that throws, or returns such a
 * provider, refuses that request with `400`.
 *
 * | Route                                       | Does                                                          |
 * | ------------------------------------------- | ------------------------------------------------------------- |
 * | `POST /v1/sessions`                         | acquires `{ key, limits? }`; answers `{ id, remoteId, workdir }` |
 * | `POST /v1/sessions/<remoteId>/commands`     | runs `{ id, command, cwd?, env?, stdin?, limits? }` to its end |
 * | `PUT /v1/sessions/<remoteId>/files?id&path` | writes the body; with `&offset=<n>`, appends it at byte `n`    |
 * | `GET /v1/sessions/<remoteId>/files?id&path` | answers the file's bytes                                      |
 * | `DELETE /v1/sessions/<remoteId>?id`         | destroys the machine; idempotent                              |
 *
 * Routes without a JSON body take the limits as `cpus`, `memoryMib` and
 * `timeoutSecs` query parameters. A request without `Authorization: Bearer
 * <token>` is `401` with no body. A `ProviderError` is `404` (`not_found`) or
 * `422` with `{ code, message }`, never its cause; an append whose file does
 * not end at its offset is `409`, a malformed request `400`, and an unknown
 * route `404`, in the same shape.
 *
 * @category constructors
 * @since 1.0.0-rc.17
 */
export const serve = (options: ServeOptions): (request: Request) => Effect.Effect<Response> => {
  if (options.token === "") throw new TypeError("HttpSandbox.serve requires a token")
  const provider = options.provider
  // No ceilings and an empty set of them are one session shape, whichever
  // route carried them.
  const providerFor: (limits: ResourceLimits | undefined) => Effect.Effect<Retained, Refusal> =
    typeof provider === "function"
      ? (limits) =>
        Effect.try({
          try: () => retained(provider(limits === undefined || Object.keys(limits).length === 0 ? undefined : limits)),
          catch: (cause) => malformed(`no provider serves these limits: ${(cause as Error).message}`)
        })
      : ((fixed) => () => Effect.succeed(fixed))(retained(provider))
  const expected = `Bearer ${options.token}`

  const maxRequestBytes = limit(options.maxRequestBytes ?? 24 * 1024 * 1024, "maxRequestBytes")
  const maxOutputBytes = limit(options.maxOutputBytes ?? 4 * 1024 * 1024, "maxOutputBytes")
  const bytesOf = (request: Request) =>
    request.body === null ?
      Effect.succeed(new Uint8Array()) :
      byteBudget(maxRequestBytes, tooLarge())(Stream.fromReadableStream({
        evaluate: () => request.body!,
        onError: () => malformed("the request body could not be read")
      }))

  const body = <A>(request: Request, decode: (text: string) => Effect.Effect<A, { readonly message: string }>) =>
    Effect.flatMap(
      bytesOf(request),
      (bytes) =>
        Effect.mapError(decode(new TextDecoder().decode(bytes)), () => malformed("the request body is malformed"))
    )

  const query = (url: URL, name: string) => {
    const value = url.searchParams.get(name)
    return value === null ? Effect.fail(malformed(`the query lacks ${name}`)) : Effect.succeed(value)
  }

  const attached = <A>(
    remoteId: string,
    id: string,
    limits: ResourceLimits | undefined,
    use: (session: Session) => Effect.Effect<A, ProviderError | Refusal, Scope.Scope>
  ) =>
    Effect.flatMap(
      providerFor(limits),
      (chosen) => Effect.scoped(Effect.flatMap(chosen.attach({ id, remoteId }), use))
    )

  const handle = (request: Request): Effect.Effect<Response, Refusal | ProviderError> =>
    Effect.gen(function*() {
      if (!sameText(request.headers.get("authorization") ?? "", expected)) {
        return new Response(null, { status: 401 })
      }
      const url = new URL(request.url)
      const match = /^\/v1\/sessions(?:\/([^/]+)(\/commands|\/files)?)?$/.exec(url.pathname)
      const route = `${request.method} ${match?.[1] === undefined ? "" : ":remote"}${match?.[2] ?? ""}`
      if (match !== null && route === "POST ") {
        const acquire = yield* body(request, decodeAcquire)
        const chosen = yield* providerFor(acquire.limits)
        const session = yield* Effect.scoped(chosen.acquire(acquire.key))
        return json(200, encodeInfo({ id: session.id, remoteId: session.remoteId, workdir: session.workdir }))
      }
      if (
        match === null ||
        !["POST :remote/commands", "PUT :remote/files", "GET :remote/files", "DELETE :remote"].includes(route)
      ) {
        return yield* Effect.fail(new Refusal({ status: 404, code: "not_found", message: "no such route" }))
      }
      const remoteId = yield* Effect.try({
        try: () => decodeURIComponent(match[1]!),
        catch: () => malformed("the session segment is not URI encoded")
      })
      if (route === "POST :remote/commands") {
        const command = yield* body(request, decodeCommand)
        const result = yield* attached(remoteId, command.id, command.limits, (session) =>
          runToEnd(session, command.command, {
            cwd: command.cwd,
            env: command.env === undefined
              ? undefined
              : Object.fromEntries(Object.entries(command.env).map(([name, value]) => [name, value ?? undefined])),
            stdin: command.stdin
          }, maxOutputBytes).pipe(Effect.mapError((error) =>
            error._tag === "Refusal"
              ? error
              : new Refusal({ status: statusOf(error.code), code: error.code, message: "remote command failed" })
          )))
        return json(200, encodeResult(result))
      }
      const id = yield* query(url, "id")
      const limits = yield* decodeLimits(Object.fromEntries(url.searchParams)).pipe(
        Effect.mapError((error) =>
          malformed(`the limits are malformed: ${error.message}`)
        )
      )
      if (route === "DELETE :remote") {
        const chosen = yield* providerFor(limits)
        yield* chosen.destroy({ id, remoteId })
        return new Response(null, { status: 204 })
      }
      const path = yield* query(url, "path")
      if (!path.startsWith("/")) {
        return yield* Effect.fail(malformed(`the path is not absolute: ${path}`))
      }
      if (route === "GET :remote/files") {
        const bytes = yield* attached(remoteId, id, limits, (session) =>
          session.readFile(path))
        return new Response(new Uint8Array(bytes), {
          status: 200,
          headers: { "content-type": "application/octet-stream" }
        })
      }
      const offset = url.searchParams.get("offset")
      const start = Number(offset)
      if (offset !== null && (!/^\d+$/.test(offset) || !Number.isSafeInteger(start))) {
        return yield* Effect.fail(malformed("the offset is not a byte count"))
      }
      const bytes = yield* bytesOf(request)
      const end = start + bytes.length
      if (!Number.isSafeInteger(end)) {
        return yield* Effect.fail(malformed("the ending offset is not a byte count"))
      }
      yield* attached(remoteId, id, limits, (session) =>
        offset === null ? session.writeFile(path, bytes) : Effect.gen(function*() {
          const appended = yield* runToEnd(session, appendScript(path, start, end), { stdin: bytes }, maxOutputBytes)
          if (appended.exitCode !== 0) {
            return yield* Effect.fail(
              new Refusal({ status: 409, code: "unknown", message: `file does not end at byte ${start}` })
            )
          }
        }))
      return new Response(null, { status: 204 })
    })

  return (request) =>
    handle(request).pipe(
      Effect.catch((error) => {
        const status = error._tag === "Refusal" ? error.status : statusOf(error.code)
        return Effect.succeed(json(status, encodeFailure({ code: error.code, message: error.message })))
      })
    )
}

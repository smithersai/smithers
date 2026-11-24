/**
 * Serves a retained `Sandbox.Provider` over HTTP.
 *
 * @since 1.0.0-rc.17
 */

import { digestSync } from "@smthrs/crypto"
import * as CommandLine from "@smthrs/kernel/CommandLine"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Random from "effect/Random"
import * as Schedule from "effect/Schedule"
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
import { sessionScript, uploadScript } from "./upload.ts"

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
  /** Maximum bytes collected for one file response (default 4 MiB). */
  readonly maxFileBytes?: number | undefined
  /** Guest records and upload receipts, outside the workspace (default /tmp/.smthrs-http). */
  readonly processDirectory?: string | undefined
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
 * | `POST /v1/sessions`                         | acquires `{ key, limits?, uploadVersion? }`; answers `{ id, remoteId, workdir, uploadVersion?, incarnation? }` |
 * | `POST /v1/sessions/<remoteId>/commands`     | runs `{ id, command, cwd?, env?, stdin?, limits? }` to its end |
 * | `PUT /v1/sessions/<remoteId>/uploads/v2?id&path&incarnation&upload&offset&total` | stages one range and publishes the completed file    |
 * | `GET /v1/sessions/<remoteId>/files?id&path` | answers the file's bytes                                      |
 * | `DELETE /v1/sessions/<remoteId>?id&incarnation`         | destroys the machine; idempotent                              |
 *
 * Routes without a JSON body take the limits as `cpus`, `memoryMib` and
 * `timeoutSecs` query parameters. A request without `Authorization: Bearer
 * <token>` is `401` with no body. A `ProviderError` is `404` (`not_found`) or
 * `422` with `{ code, message }`, never its cause. File reads are bounded by
 * `maxFileBytes` before allocation in the server and travel as base64 from the
 * guest so text-only command providers preserve binary files. Upload ranges
 * carry `upload`, `offset` and `total`; their receipts live outside the workdir
 * in session-owned storage or under `processDirectory`. The server requires
 * the advertised incarnation on each range. The legacy file PUT returns
 * `426`. Linux guests need util-linux `flock` with `-E` support, BSD guests
 * need `lockf -k -t`. A malformed request returns `400` and an unknown
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
  const processDirectory = options.processDirectory ?? "/tmp/.smthrs-http"
  if (!/^\/[A-Za-z0-9._/-]*$/.test(processDirectory) || processDirectory.split("/").includes("..")) {
    throw new TypeError("http-sandbox: invalid processDirectory")
  }
  const sessionState = (session: Session) =>
    session.stateDirectory ??
      `${processDirectory}/uploads/${digestSync(JSON.stringify([session.remoteId, session.id]))}`
  const guarded = (session: Session, body: string, stdin?: Uint8Array, cwd?: string) =>
    Effect.gen(function*() {
      const state = sessionState(session)
      const lock = `${processDirectory}/locks/${digestSync(state).slice(0, 2)}`
      const result = yield* runToEnd(session, sessionScript(lock, state, body), { stdin, cwd }, 256)
      if (result.exitCode === 77) {
        return yield* Effect.fail(new Refusal({ status: 404, code: "not_found", message: "session is absent" }))
      }
      if (result.exitCode === 0) return new TextDecoder().decode(result.stdout).trim()
      return yield* Effect.fail(
        new Refusal({
          status: result.exitCode === 75 ? 503 : result.exitCode === 69 ? 422 : 409,
          code: result.exitCode === 75 ? "unavailable" : result.exitCode === 69 ? "spawn_error" : "unknown",
          message: result.exitCode === 75 ? "file upload is busy" : result.exitCode === 69 ?
            "file uploads require flock or lockf" :
            result.exitCode === 76
            ? "session incarnation has ended"
            : "file upload range could not be stored"
        })
      )
    })
  const incarnationGuard = (incarnation: string) =>
    `[ ! -L "$r/current" ] && [ "$(cat "$r/current" 2>/dev/null)" = ${CommandLine.quote(incarnation)} ] || exit 76`
  const maxFileBytes = limit(options.maxFileBytes ?? 4 * 1024 * 1024, "maxFileBytes")
  if (maxFileBytes > Math.floor(Number.MAX_SAFE_INTEGER / 2)) throw new TypeError("http-sandbox: invalid maxFileBytes")
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
      const match = /^\/v1\/sessions(?:\/([^/]+)(\/commands|\/files|\/uploads\/v2)?)?$/.exec(url.pathname)
      const route = `${request.method} ${match?.[1] === undefined ? "" : ":remote"}${match?.[2] ?? ""}`
      if (match !== null && route === "POST ") {
        const acquire = yield* body(request, decodeAcquire)
        const chosen = yield* providerFor(acquire.limits)
        return yield* Effect.scoped(Effect.gen(function*() {
          const session = yield* chosen.acquire(acquire.key)
          const info = { id: session.id, remoteId: session.remoteId, workdir: session.workdir }
          if (acquire.uploadVersion !== 2) return json(200, encodeInfo(info))
          const incarnation = yield* guarded(
            session,
            `cd ${CommandLine.quote(session.workdir)} || exit 77
[ ! -e .smthrs-http-retiring ] || exit 76
mkdir -p -- "$r" && [ ! -L "$r/current" ] && [ ! -L "$r/next" ] || exit 3
if [ ! -f "$r/current" ]; then
  bytes=$(od -An -N16 -tx1 /dev/urandom) || exit 3
  value=$(printf '%s' "$bytes" | tr -d '[:space:]') && [ "\${#value}" -eq 32 ] || exit 3
  printf '%s' "$value" >"$r/next" && mv -f -- "$r/next" "$r/current" || exit 3
fi
cat "$r/current"`,
            undefined,
            "/"
          ).pipe(Effect.catchIf((error) =>
            error._tag === "Refusal" && error.code === "spawn_error", () =>
            Effect.succeed(undefined)))
          return json(
            200,
            encodeInfo({
              ...info,
              ...(incarnation === undefined ? {} : { uploadVersion: 2, incarnation })
            })
          )
        }))
      }
      if (match !== null && route === "PUT :remote/files") {
        return yield* Effect.fail(
          new Refusal({ status: 426, code: "unavailable", message: "staged upload version 2 required" })
        )
      }
      if (
        match === null ||
        !["POST :remote/commands", "PUT :remote/uploads/v2", "GET :remote/files", "DELETE :remote"].includes(route)
      ) {
        return yield* Effect.fail(new Refusal({ status: 404, code: "not_found", message: "no such route" }))
      }
      const remoteId = yield* Effect.try({
        try: () =>
          decodeURIComponent(match[1]!),
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
        const incarnation = url.searchParams.get("incarnation")
        if (incarnation !== null && !/^[a-f0-9]{32}$/.test(incarnation)) {
          return yield* Effect.fail(malformed("invalid session incarnation"))
        }
        yield* Effect.scoped(Effect.gen(function*() {
          const session = yield* chosen.attach({ id, remoteId })
          const receipt = session.workdir.replace(/\/$/, "") + "/.smthrs-http-retiring"
          const ticket = (yield* Random.nextIntBetween(1, 2 ** 31)) + "-" + (yield* Random.nextIntBetween(1, 2 ** 31))
          const owner = (incarnation ?? "") + ":" + ticket
          // Keep the guest lock across the provider's destroy call. A second
          // handler can take over a failed deletion only after that call ends.
          // The ready file also works on transports that buffer command output.
          const holding = yield* guarded(
            session,
            `
cd ${CommandLine.quote(session.workdir)} || exit 77
[ ! -L .smthrs-http-retiring ] || exit 76
if [ -f .smthrs-http-retiring ]; then
  read -r previous <.smthrs-http-retiring || exit 3
  [ "\${previous%%:*}" = ${CommandLine.quote(incarnation ?? "")} ] || exit 76
elif [ -e "$r/current" ]; then
  ${incarnation === null ? "exit 76" : incarnationGuard(incarnation)}
else
  ${incarnation === null ? ":" : "exit 76"}
fi
printf '%s\\n' ${CommandLine.quote((incarnation ?? "") + ":retiring")} >.smthrs-http-retiring || exit 3
rm -rf -- "$r" || exit 3
printf '%s\\n' ${CommandLine.quote(owner)} >.smthrs-http-retiring || exit 3
while [ . -ef ${CommandLine.quote(session.workdir)} ] && [ -f .smthrs-http-retiring ]; do sleep 0.1; done`,
            undefined,
            "/"
          ).pipe(Effect.forkScoped)
          const ready = Effect.scoped(runToEnd(
            session,
            `p=${CommandLine.quote(receipt)}; [ ! -L "$p" ] && [ -f "$p" ] && printf '%s\\n' ${
              CommandLine.quote(owner)
            } | cmp -s - "$p"`,
            { cwd: "/" },
            256
          )).pipe(
            Effect.map((result) =>
              result.exitCode === 0
            ),
            Effect.repeat({
              until: (owned) =>
                owned,
              schedule: Schedule.spaced("20 millis")
            })
          )
          const acquired = yield* Effect.raceFirst(ready, Fiber.join(holding).pipe(Effect.as(false))).pipe(
            Effect.catchIf(
              (error) => error._tag === "Refusal" && error.code === "spawn_error" && incarnation === null,
              () => Effect.succeed(true)
            )
          )
          if (acquired) {
            yield* Effect.uninterruptible(chosen.destroy({ id, remoteId }))
          }
        })).pipe(Effect.catchIf((error) => error.code === "not_found", () => Effect.void))
        return new Response(null, { status: 204 })
      }
      const path = yield* query(url, "path")
      if (!path.startsWith("/")) {
        return yield* Effect.fail(malformed(`the path is not absolute: ${path}`))
      }
      if (route === "GET :remote/files") {
        const bytes = yield* attached(remoteId, id, limits, (session) =>
          Effect.gen(function*() {
            const child = yield* session.spawn(
              `[ -f ${CommandLine.quote(path)} ] || exit 44; t=$(mktemp) || exit 3; ` +
                `trap 'rm -f -- "$t"' EXIT; ` +
                `head -c ${maxFileBytes + 1} -- ${CommandLine.quote(path)} >"$t" || exit 3; ` +
                `s=$(wc -c <"$t") || exit 3; [ "$s" -le ${maxFileBytes} ] || exit 45; base64 <"$t"`,
              {}
            )
            // Include conservative wrapping overhead for GNU and BSD base64.
            const encodedBytes = 4 * Math.ceil(maxFileBytes / 3)
            const encodedLimit = encodedBytes + 2 * Math.ceil(encodedBytes / 64) + 2
            const [bytes, , code] = yield* Effect.all([
              byteBudget(encodedLimit, tooLarge())(child.stdout),
              byteBudget(maxOutputBytes, tooLarge())(child.stderr),
              child.exitCode
            ], { concurrency: "unbounded" })
            if (code === 45) {
              return yield* Effect.fail(tooLarge())
            }
            if (code !== 0) {
              return yield* Effect.fail(
                new Refusal({
                  status: code === 44 ? 404 : 422,
                  code: code === 44 ? "not_found" : "unknown",
                  message: "remote file read failed"
                })
              )
            }
            const decoded = yield* Schema.decodeUnknownEffect(Schema.Uint8ArrayFromBase64)(
              new TextDecoder().decode(bytes).replaceAll(/\s/g, "")
            ).pipe(
              Effect.mapError(() =>
                new Refusal({ status: 422, code: "unknown", message: "remote file encoding failed" })
              )
            )
            if (decoded.length > maxFileBytes) {
              return yield* Effect.fail(tooLarge())
            }
            return decoded
          }))
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
      const upload = url.searchParams.get("upload")
      const totalText = url.searchParams.get("total")
      const total = Number(totalText)
      if (
        upload === null || (
          !/^[a-zA-Z0-9-]{1,128}$/.test(upload) || totalText === null || !/^\d+$/.test(totalText) ||
          !Number.isSafeInteger(total) || total < end || offset === null
        )
      ) {
        return yield* Effect.fail(malformed("the upload range is malformed"))
      }
      const incarnation = yield* query(url, "incarnation")
      if (!/^[a-f0-9]{32}$/.test(incarnation)) return yield* Effect.fail(malformed("invalid session incarnation"))
      yield* attached(remoteId, id, limits, (session) =>
        guarded(
          session,
          `${incarnationGuard(incarnation)}
${
            uploadScript(
              path,
              `${sessionState(session)}/${incarnation}/${digestSync(path)}`,
              incarnation + "-" + upload,
              start,
              end,
              total
            )
          }`,
          bytes
        ))
      return new Response(null, { status: 204 })
    })

  return (request) =>
    Effect.raceFirst(
      handle(request),
      Effect.callback<never>((resume) => {
        const abort = () => resume(Effect.interrupt)
        if (request.signal.aborted) abort()
        else request.signal.addEventListener("abort", abort, { once: true })
        return Effect.sync(() => request.signal.removeEventListener("abort", abort))
      })
    ).pipe(
      Effect.catch((error) => {
        const status = error._tag === "Refusal" ? error.status : statusOf(error.code)
        return Effect.succeed(json(status, encodeFailure({ code: error.code, message: error.message })))
      })
    )
}

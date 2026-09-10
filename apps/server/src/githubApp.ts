import * as Clock from "effect/Clock"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import * as Ref from "effect/Ref"
import * as Result from "effect/Result"
import * as Semaphore from "effect/Semaphore"
import { ServerConfig } from "./Config"
import { CryptoFailure } from "./Failures"
import { fetchWithDeadline, readJson, readText, Transport } from "./Http"
import type { TransportShape } from "./Http"

/**
 * Server-to-server GitHub reads authenticate as the GitHub App
 * `smitherspreviewrelease` (app id 4163546, owned by the `smithersai` org),
 * not as a personal access token: an App credential belongs to the
 * organization, its installation token expires in an hour, and it can be
 * rotated without touching anyone's account.
 *
 * The exchange is the one GitHub documents, done with WebCrypto so it runs
 * unchanged in workerd and in Bun's test runner:
 *
 *   1. sign an RS256 JWT with the App's private key (`iss` = the app id,
 *      `iat` = now - 60 s for clock skew, `exp` = now + 9 minutes; GitHub
 *      rejects anything past 10),
 *   2. `GET /app/installations` with that JWT to find the installation on the
 *      `smithersai` organization (live: installation 150824198, every
 *      repository), and
 *   3. `POST /app/installations/{id}/access_tokens` to mint the installation
 *      token the reads carry as a bearer.
 *
 * The token is cached in the isolate and in the Cache API under a private URL
 * for 55 minutes, so a cold isolate does not re-exchange; a 401 on a read
 * drops both copies and buys exactly one new token.
 *
 * Every failure is honest and lands on the anonymous read the catalog has
 * always had: the App is not installed, the key does not import, or GitHub
 * refuses the exchange, and the caller reads GitHub without a bearer while one
 * warning line names the cause. The failure state is remembered for 5 minutes
 * so a broken secret cannot turn every catalog refresh into two more GitHub
 * calls.
 *
 * The private key, the JWT, and the installation token never enter a log line,
 * a response body, or a cache key: only the GitHub request's authorization
 * header, and the token's own cache entry.
 */

/** The bearer one GitHub read carries. */
export interface GithubBearer {
  readonly value: string
  /** An App installation token can be exchanged again after a 401; the override cannot. */
  readonly renewable: boolean
}

/*
 * The edge cache: Cloudflare's Cache API, keyed by URL. Every operation
 * swallows its own failure, because a cache that is down is a cache miss and
 * never a failed request. Absent (unit tests, a runtime without `caches`)
 * every read misses and every write is dropped.
 */

export interface EdgeCacheShape {
  readonly match: (key: string) => Effect.Effect<Response | undefined>
  readonly put: (key: string, response: Response) => Effect.Effect<void>
  readonly delete: (key: string) => Effect.Effect<void>
}

export class EdgeCache extends Context.Service<EdgeCache, EdgeCacheShape>()("smithers-server/EdgeCache") {}

const noEdgeCache: EdgeCacheShape = {
  match: () => Effect.succeed(undefined),
  put: () => Effect.void,
  delete: () => Effect.void
}

/** The Workers Cache API as an `EdgeCache`; `undefined` (no `caches` binding) never hits. */
export const edgeCacheFrom = (cache: Cache | undefined): EdgeCacheShape =>
  cache === undefined
    ? noEdgeCache
    : {
      match: (key) =>
        Effect.tryPromise(() => cache.match(key)).pipe(Effect.orElseSucceed(() => undefined)),
      put: (key, response) =>
        Effect.tryPromise(() => cache.put(key, response)).pipe(Effect.ignore),
      delete: (key) =>
        Effect.tryPromise(() => cache.delete(key)).pipe(Effect.ignore)
    }

export const edgeCacheLayer = (cache: Cache | undefined): Layer.Layer<EdgeCache> =>
  Layer.succeed(EdgeCache, edgeCacheFrom(cache))

export interface MemoryEdgeCache extends EdgeCacheShape {
  /** The stored responses by URL, for a test to inspect. */
  readonly records: Map<string, Response>
}

/** An in-memory edge cache for tests; one instance shared by two layers plays a cold isolate. */
export const memoryEdgeCache = (): MemoryEdgeCache => {
  const records = new Map<string, Response>()
  return {
    records,
    match: (key) => Effect.sync(() => records.get(key)?.clone()),
    put: (key, response) => Effect.sync(() => {
      records.set(key, response.clone())
    }),
    delete: (key) => Effect.sync(() => {
      records.delete(key)
    })
  }
}

export interface GithubAppAuthShape {
  /** The bearer for a server-to-server read, or undefined for the anonymous read. */
  readonly token: () => Effect.Effect<GithubBearer | undefined>
  /** Drops the cached installation token, in the isolate and at the edge, after a 401. */
  readonly forget: () => Effect.Effect<void>
}

export class GithubAppAuth extends Context.Service<GithubAppAuth, GithubAppAuthShape>()("smithers-server/GithubAppAuth") {}

const GITHUB_API = "https://api.github.com"

/** The organization whose installation this Worker prefers when the App is installed more than once. */
const PREFERRED_ACCOUNT = "smithersai"

/** GitHub installation tokens last an hour; 55 minutes leaves a margin for a slow read. */
const TOKEN_TTL_MS = 55 * 60 * 1000

/** How long a failed exchange is remembered, so a broken secret is not retried on every refresh. */
const FAILURE_TTL_MS = 5 * 60 * 1000

/** How long one exchange call gets to answer its headers. */
const GITHUB_TIMEOUT_MS = 10_000

/** GitHub rejects a JWT that lives longer than 10 minutes; 9 leaves room for skew. */
const JWT_BACKDATE_S = 60
const JWT_LIFETIME_S = 9 * 60

/**
 * The Cache API key for the installation token. The hostname is not routed
 * anywhere, so the entry is reachable only by this Worker's own cache lookups.
 */
const TOKEN_CACHE_URL = "https://github-app.smithers.invalid/installation-token"
const EXPIRES_HEADER = "x-installation-expires"

/** Bytes over their own ArrayBuffer: what `crypto.subtle` accepts as a BufferSource. */
type Bytes = Uint8Array<ArrayBuffer>

const encoder = new TextEncoder()

const base64url = (bytes: Uint8Array): string => {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "")
}

const fromBase64 = (value: string): Bytes => {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

const concat = (parts: ReadonlyArray<Uint8Array>): Bytes => {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0))
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

/** A DER definite length: one byte under 128, otherwise a count byte and the big-endian length. */
const derLength = (length: number): Bytes => {
  if (length < 0x80) return Uint8Array.of(length)
  const bytes: Array<number> = []
  for (let value = length; value > 0; value = Math.floor(value / 256)) bytes.unshift(value % 256)
  return Uint8Array.of(0x80 | bytes.length, ...bytes)
}

/** One DER element: tag, definite length, payload. */
const der = (tag: number, payload: Uint8Array): Bytes => concat([Uint8Array.of(tag), derLength(payload.length), payload])

const DER_INTEGER = 0x02
const DER_OCTET_STRING = 0x04
const DER_NULL = Uint8Array.of(0x05, 0x00)
const DER_SEQUENCE = 0x30
/** OID 1.2.840.113549.1.1.1, rsaEncryption. */
const RSA_ENCRYPTION_OID = Uint8Array.of(0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01)

/**
 * WebCrypto imports PKCS#8 only, and GitHub issues PKCS#1, so the RSAPrivateKey
 * is wrapped in a PrivateKeyInfo:
 *
 *   SEQUENCE { INTEGER 0, SEQUENCE { OID rsaEncryption, NULL }, OCTET STRING <pkcs1> }
 */
export const pkcs8FromPkcs1 = (pkcs1: Uint8Array): Bytes =>
  der(DER_SEQUENCE, concat([
    der(DER_INTEGER, Uint8Array.of(0x00)),
    der(DER_SEQUENCE, concat([RSA_ENCRYPTION_OID, DER_NULL])),
    der(DER_OCTET_STRING, pkcs1)
  ]))

/**
 * The base64 body between one PEM armor pair, or undefined when the PEM does
 * not carry that armor. Only whitespace is dropped, so an invalid body still
 * fails the decode instead of silently becoming other bytes.
 */
const armoredBody = (pem: string, armor: string): Bytes | undefined => {
  const begin = `-----BEGIN ${armor}-----`
  const end = `-----END ${armor}-----`
  const start = pem.indexOf(begin)
  const stop = pem.indexOf(end)
  if (start < 0 || stop <= start) return undefined
  const body = pem.slice(start + begin.length, stop).replace(/\s+/g, "")
  if (body === "") return undefined
  return fromBase64(body)
}

/**
 * The PKCS#8 DER for either armor GitHub or `openssl` produces. A secret stored
 * with escaped newlines (a key pasted through a shell that kept the backslashes)
 * reads like one stored with real ones.
 */
const privateKeyDer = (rawPem: string): Bytes => {
  const pem = rawPem.includes("\\n") ? rawPem.replaceAll("\\n", "\n") : rawPem
  const pkcs1 = armoredBody(pem, "RSA PRIVATE KEY")
  if (pkcs1 !== undefined) return pkcs8FromPkcs1(pkcs1)
  const pkcs8 = armoredBody(pem, "PRIVATE KEY")
  if (pkcs8 !== undefined) return pkcs8
  throw new Error("the private key carries no PKCS#1 or PKCS#8 PEM armor")
}

/**
 * The App JWT GitHub accepts on `/app/*`. Exported so a test can verify the
 * signature against the matching public key instead of trusting the shape.
 * The failure names the WebCrypto operation and never quotes the key.
 */
export const createAppJwt = (appId: string, privateKeyPem: string, nowMs: number): Effect.Effect<string, CryptoFailure> =>
  Effect.gen(function*() {
    const keyDer = yield* Effect.try({
      try: () => privateKeyDer(privateKeyPem),
      catch: (cause) => new CryptoFailure({ operation: "decodePrivateKey", cause })
    })
    const key = yield* Effect.tryPromise({
      try: () => crypto.subtle.importKey("pkcs8", keyDer, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]),
      catch: (cause) => new CryptoFailure({ operation: "importKey", cause })
    })
    const seconds = Math.floor(nowMs / 1000)
    const header = base64url(encoder.encode(JSON.stringify({ alg: "RS256", typ: "JWT" })))
    const claims = base64url(encoder.encode(JSON.stringify({
      iat: seconds - JWT_BACKDATE_S,
      exp: seconds + JWT_LIFETIME_S,
      iss: appId
    })))
    const signingInput = `${header}.${claims}`
    const signature = yield* Effect.tryPromise({
      try: () => crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, encoder.encode(signingInput)),
      catch: (cause) => new CryptoFailure({ operation: "sign", cause })
    })
    return `${signingInput}.${base64url(new Uint8Array(signature))}`
  })

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined

/** The login the installation belongs to, lowercased, or undefined when GitHub sent something else. */
const accountLogin = (entry: unknown): string | undefined => {
  const account = record(record(entry)?.account)
  return typeof account?.login === "string" ? account.login.toLowerCase() : undefined
}

const installationId = (entry: unknown): number | undefined => {
  const id = record(entry)?.id
  return typeof id === "number" && Number.isSafeInteger(id) && id > 0 ? id : undefined
}

export interface GithubAppAuthOptions {
  /** One line per failure. Defaults to `console.warn`; never receives a secret. */
  readonly log?: (line: string) => void
}

interface HeldToken {
  readonly value: string
  readonly expiresAt: number
}

/**
 * The App credential as one service instance: the held token, the failure
 * memory, and the single-flight gate live for the layer's lifetime (one
 * isolate). Concurrent callers queue on the gate; the first one exchanges
 * and the rest read the token it held, so N callers cost one exchange.
 */
export const makeGithubAppAuth = (
  options: GithubAppAuthOptions = {}
): Effect.Effect<GithubAppAuthShape, never, ServerConfig | Transport | EdgeCache> =>
  Effect.gen(function*() {
    const config = yield* ServerConfig
    const transport: TransportShape = yield* Transport
    const edge = yield* EdgeCache
    const log = options.log ?? ((line: string) => console.warn(line))
    const held = yield* Ref.make<HeldToken | undefined>(undefined)
    const failedUntil = yield* Ref.make(0)
    const gate = yield* Semaphore.make(1)

    const githubRequest = (url: string, jwt: string, method: "GET" | "POST") =>
      new Request(url, {
        method,
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${jwt}`,
          "user-agent": "Smithers-github-app",
          "x-github-api-version": "2022-11-28"
        },
        // workerd throws on redirect: "error" before the request is sent, so a
        // redirect is asked for manually and read as the non-answer it is.
        redirect: "manual"
      })

    const github = (url: string, jwt: string, method: "GET" | "POST") =>
      fetchWithDeadline("githubApp", githubRequest(url, jwt, method), undefined, GITHUB_TIMEOUT_MS).pipe(
        Effect.provideService(Transport, transport)
      )

    const readEdgeToken: Effect.Effect<GithubBearer | undefined> = Effect.gen(function*() {
      const stored = yield* edge.match(TOKEN_CACHE_URL)
      if (stored === undefined) return undefined
      const expiresAt = Number(stored.headers.get(EXPIRES_HEADER))
      const value = (yield* readText(stored).pipe(Effect.orElseSucceed(() => ""))).trim()
      const now = yield* Clock.currentTimeMillis
      if (value === "" || !Number.isFinite(expiresAt) || expiresAt <= now) return undefined
      yield* Ref.set(held, { value, expiresAt })
      return { value, renewable: true }
    })

    const writeEdgeToken = (value: string, expiresAt: number): Effect.Effect<void> =>
      Effect.gen(function*() {
        const now = yield* Clock.currentTimeMillis
        const maxAge = Math.max(1, Math.floor((expiresAt - now) / 1000))
        yield* edge.put(
          TOKEN_CACHE_URL,
          new Response(value, { headers: { "cache-control": `max-age=${maxAge}`, [EXPIRES_HEADER]: String(expiresAt) } })
        )
      })

    /** The installation to mint a token on: the `smithersai` one, else the first GitHub returned. */
    const chooseInstallation = (jwt: string): Effect.Effect<number | undefined> =>
      Effect.gen(function*() {
        const response = yield* Effect.result(github(`${GITHUB_API}/app/installations`, jwt, "GET"))
        if (Result.isFailure(response)) {
          log("the GitHub App installation lookup could not reach GitHub")
          return undefined
        }
        if (!response.success.ok) {
          log(`the GitHub App installation lookup answered ${response.success.status}`)
          return undefined
        }
        const body = yield* Effect.result(readJson(response.success))
        if (Result.isFailure(body)) {
          log("the GitHub App installation lookup answered an unreadable body")
          return undefined
        }
        const installations: ReadonlyArray<unknown> = Array.isArray(body.success) ? body.success : []
        const preferred = installations.find((entry) => accountLogin(entry) === PREFERRED_ACCOUNT)
        const id = installationId(preferred ?? installations[0])
        if (id === undefined) {
          log("the GitHub App is not installed on any organization")
          return undefined
        }
        return id
      })

    const exchange = (id: number, jwt: string): Effect.Effect<GithubBearer | undefined> =>
      Effect.gen(function*() {
        const response = yield* Effect.result(github(`${GITHUB_API}/app/installations/${id}/access_tokens`, jwt, "POST"))
        if (Result.isFailure(response)) {
          log("the GitHub App installation token exchange could not reach GitHub")
          return undefined
        }
        if (!response.success.ok) {
          log(`the GitHub App installation token exchange answered ${response.success.status}`)
          return undefined
        }
        const body = yield* Effect.result(readJson(response.success))
        if (Result.isFailure(body)) {
          log("the GitHub App installation token exchange answered an unreadable body")
          return undefined
        }
        const value = record(body.success)?.token
        if (typeof value !== "string" || value === "") {
          log("the GitHub App installation token exchange answered no token")
          return undefined
        }
        const now = yield* Clock.currentTimeMillis
        const expiresAt = record(body.success)?.expires_at
        const stated = typeof expiresAt === "string" ? Date.parse(expiresAt) - 60_000 - now : Number.NaN
        const lifetime = Number.isFinite(stated) ? Math.min(TOKEN_TTL_MS, stated) : TOKEN_TTL_MS
        if (lifetime > 0) {
          yield* Ref.set(held, { value, expiresAt: now + lifetime })
          yield* writeEdgeToken(value, now + lifetime)
        }
        return { value, renewable: true }
      })

    const mint = (appId: string, privateKey: string): Effect.Effect<GithubBearer | undefined> =>
      Effect.gen(function*() {
        const edgeToken = yield* readEdgeToken
        if (edgeToken !== undefined) return edgeToken
        const now = yield* Clock.currentTimeMillis
        const jwt = yield* Effect.result(createAppJwt(appId, privateKey, now))
        if (Result.isFailure(jwt)) {
          // The failure's cause could quote the key, so only the fact is named.
          log("the GitHub App private key could not be imported")
          return undefined
        }
        const id = yield* chooseInstallation(jwt.success)
        if (id === undefined) return undefined
        return yield* exchange(id, jwt.success)
      })

    /** Under the gate: one exchange at a time, and a caller behind it reads what it held. */
    const mintOnce = (appId: string, privateKey: string): Effect.Effect<GithubBearer | undefined> =>
      gate.withPermit(Effect.gen(function*() {
        const now = yield* Clock.currentTimeMillis
        const current = yield* Ref.get(held)
        if (current !== undefined && current.expiresAt > now) return { value: current.value, renewable: true }
        if (now < (yield* Ref.get(failedUntil))) return undefined
        const bearer = yield* mint(appId, privateKey)
        // The window starts when the mint ENDED: a slow refusal must not
        // hand back a window that is already half spent.
        if (bearer === undefined) yield* Ref.set(failedUntil, (yield* Clock.currentTimeMillis) + FAILURE_TTL_MS)
        return bearer
      }))

    const token = (): Effect.Effect<GithubBearer | undefined> =>
      Effect.gen(function*() {
        // The override wins over the App, and is sent unchanged; it cannot be re-minted.
        if (config.githubToken !== undefined) return { value: Redacted.value(config.githubToken), renewable: false }
        if (config.githubAppId === undefined || config.githubAppPrivateKey === undefined) return undefined
        const now = yield* Clock.currentTimeMillis
        const current = yield* Ref.get(held)
        if (current !== undefined && current.expiresAt > now) return { value: current.value, renewable: true }
        if (now < (yield* Ref.get(failedUntil))) return undefined
        return yield* mintOnce(config.githubAppId, Redacted.value(config.githubAppPrivateKey))
      })

    const forget = (): Effect.Effect<void> =>
      Effect.gen(function*() {
        yield* Ref.set(held, undefined)
        yield* Ref.set(failedUntil, 0)
        yield* edge.delete(TOKEN_CACHE_URL)
      })

    return { token, forget }
  })

export const githubAppAuthLayer: Layer.Layer<GithubAppAuth, never, ServerConfig | Transport | EdgeCache> =
  Layer.effect(GithubAppAuth, makeGithubAppAuth())

/**
 * A GitHub App's own authentication: the App's JWT and installation tokens.
 *
 * A GitHub App authenticates in two steps. It signs a short-lived JWT with its
 * private key, RS256, which lets it call the `/app/...` endpoints as itself;
 * then it trades that JWT for an installation access token, which acts on the
 * repositories one installation covers and expires within the hour.
 *
 * - **The key.** GitHub downloads an App's private key as PKCS#1 PEM
 *   (`-----BEGIN RSA PRIVATE KEY-----`). WebCrypto imports only PKCS#8, so
 *   {@link importPrivateKey} wraps the PKCS#1 key in a PKCS#8 `PrivateKeyInfo`
 *   with the `rsaEncryption` algorithm identifier. A PKCS#8 PEM
 *   (`-----BEGIN PRIVATE KEY-----`) is imported as it is. A key carried in an
 *   environment variable often has its newlines escaped as `\n`; those are
 *   restored first.
 * - **The JWT.** `iat` is 60 seconds in the past, against clock drift, and
 *   `exp` 9 minutes ahead, inside GitHub's 10-minute ceiling. `iss` is the
 *   App's ID or client ID. Time comes from the `Clock` service.
 * - **The calls.** Each one goes through a `GitHubClient` built with the JWT as
 *   its token and an empty environment, so an ambient `GITHUB_TOKEN` or
 *   `SMITHERS_GITHUB_API_BASE_URL` never decides who calls or where the JWT
 *   goes. The client makes one request and never repeats it; the flow step
 *   around the call owns retries. Minting a token is safe to repeat, so a lost
 *   answer to it is `retryable` while retaining `outcomeUnknown`.
 *
 * Neither the private key, the JWT, nor a minted installation token appears in
 * an error message, its `details`, its cause, or a span attribute. A response
 * that does not decode fails without quoting the response.
 *
 * Crypto is WebCrypto's (`crypto.subtle`), so this runs in a browser, a
 * Cloudflare Worker, Node and Bun.
 *
 * Sources: GitHub's "Generating a JSON Web Token (JWT) for a GitHub App",
 * "Authenticating as a GitHub App installation" and "Managing private keys
 * for GitHub Apps".
 *
 * @since 1.0.0
 */

import { Clock, Context, type Duration, Effect, Layer, Option, Redacted, Schema } from "effect"
import * as HttpClient from "effect/http/HttpClient"
import { IntegrationError } from "../core/IntegrationError.ts"
import { redactedError } from "../core/RedactedError.ts"
import * as GitHubClient from "./GitHubClient.ts"
import { isRepo, requireRepositoryPath } from "./Repository.vibe"

/**
 * What a GitHub App authenticates with.
 *
 * @category models
 * @since 1.0.0
 */
export interface AppCredentials {
  /** The App's ID (or its client ID, which GitHub also accepts as `iss`). */
  readonly appId: string
  /** The App's private key, PEM: PKCS#1 as GitHub downloads it, or PKCS#8. */
  readonly privateKey: Redacted.Redacted<string>
  /** REST base URL; defaults to Config's DEFAULT_API_BASE_URL. */
  readonly apiBaseUrl?: string | undefined
  readonly requestTimeout?: Duration.Input | undefined
}

/**
 * An installation access token and when it expires.
 *
 * @category models
 * @since 1.0.0
 */
export interface InstallationToken {
  readonly token: Redacted.Redacted<string>
  /** Epoch milliseconds, from GitHub's `expires_at`. */
  readonly expiresAt: number
}

/**
 * The App authentication service.
 *
 * @category services
 * @since 1.0.0
 */
export interface AppAuth {
  /** A JWT for the App: RS256, `iat` 60 s in the past, `exp` 9 minutes ahead (GitHub refuses more than 10), `iss` = appId. Uses the Clock service for time. */
  readonly jwt: Effect.Effect<Redacted.Redacted<string>, IntegrationError>
  /** The installation covering owner/repo: `GET /repos/{owner}/{repo}/installation` as the App. GitHub's 404 (not installed) fails `delivery-failed` with details.status 404, retryable false. */
  readonly installation: (owner: string, repo: string) => Effect.Effect<{ readonly id: number }, IntegrationError>
  /** `POST /app/installations/{id}/access_tokens`, optionally narrowed to `repositories` (names) or `repositoryIds` and `permissions` ({ issues: "write", ... }). */
  readonly installationToken: (options: {
    readonly installationId: number
    readonly repositories?: ReadonlyArray<string> | undefined
    readonly repositoryIds?: ReadonlyArray<number> | undefined
    readonly permissions?: Readonly<Record<string, "read" | "write">> | undefined
  }) => Effect.Effect<InstallationToken, IntegrationError>
}

/**
 * Service tag for {@link AppAuth}.
 *
 * @category services
 * @since 1.0.0
 */
export const AppAuth: Context.Service<AppAuth, AppAuth> = Context.Service("@smthrs/integrations/AppAuth")

/**
 * How far behind the clock the JWT's `iat` is set, in seconds, so a GitHub
 * clock slightly behind ours still accepts it.
 *
 * @category constants
 * @since 1.0.0
 */
export const JWT_BACKDATE_SECONDS = 60

/**
 * How far ahead of the clock the JWT's `exp` is set, in seconds. GitHub
 * refuses an `exp` more than 10 minutes ahead.
 *
 * @category constants
 * @since 1.0.0
 */
export const JWT_LIFETIME_SECONDS = 9 * 60

const invalidConfig = (message: string, details: Record<string, unknown> = {}): IntegrationError =>
  new IntegrationError("invalid-config", message, { ...details, retryable: false })

const PEM = /-----BEGIN (RSA )?PRIVATE KEY-----([\s\S]*?)-----END \1PRIVATE KEY-----/

// The DER length octets: short form below 128, long form above.
const derLength = (length: number): Array<number> => {
  if (length < 0x80) return [length]
  const octets: Array<number> = []
  for (let rest = length; rest > 0; rest = Math.floor(rest / 0x100)) octets.unshift(rest % 0x100)
  return [0x80 | octets.length, ...octets]
}

const tlv = (tag: number, content: ArrayLike<number>): Array<number> => [
  tag,
  ...derLength(content.length),
  ...Array.from(content)
]

// INTEGER 0, then the AlgorithmIdentifier { rsaEncryption (1.2.840.113549.1.1.1), NULL }.
const PKCS8_RSA_PREFIX = [
  0x02,
  0x01,
  0x00,
  0x30,
  0x0d,
  0x06,
  0x09,
  0x2a,
  0x86,
  0x48,
  0x86,
  0xf7,
  0x0d,
  0x01,
  0x01,
  0x01,
  0x05,
  0x00
]

// PKCS#8 PrivateKeyInfo ::= SEQUENCE { version, privateKeyAlgorithm, privateKey OCTET STRING }.
const wrapPkcs1 = (pkcs1: Uint8Array): Uint8Array<ArrayBuffer> =>
  new Uint8Array(tlv(0x30, [...PKCS8_RSA_PREFIX, ...tlv(0x04, pkcs1)]))

/**
 * Imports a GitHub App's PEM private key, PKCS#1 or PKCS#8, as an RS256
 * (`RSASSA-PKCS1-v1_5` with SHA-256) signing key.
 *
 * Escaped newlines (`\n` as two characters) are restored first. A PEM that is
 * neither form, whose body is not base64, or that WebCrypto refuses fails
 * `invalid-config`; no part of the key is in the error. The key is not
 * extractable.
 *
 * @category constructors
 * @since 1.0.0
 */
export const importPrivateKey = (pem: Redacted.Redacted<string>): Effect.Effect<CryptoKey, IntegrationError> =>
  Effect.suspend(() => {
    const text = Redacted.value(pem).replace(/\\r\\n|\\n|\\r/g, "\n")
    const match = PEM.exec(text)
    if (match === null) {
      return Effect.fail(invalidConfig(
        "The GitHub App private key is not a PEM private key: expected -----BEGIN RSA PRIVATE KEY----- (PKCS#1, as GitHub downloads it) or -----BEGIN PRIVATE KEY----- (PKCS#8)."
      ))
    }
    const format = match[1] === undefined ? "pkcs8" : "pkcs1"
    const body = match[2]!.replace(/\s+/g, "")
    const failure = redactedError([Redacted.value(pem), text, body])
    return Effect.try({
      try: () => Uint8Array.from(atob(body), (character) => character.charCodeAt(0)),
      catch: (cause) =>
        failure("invalid-config", "The GitHub App private key's PEM body is not base64.", {
          format,
          retryable: false
        }, { cause })
    }).pipe(
      Effect.flatMap((der) =>
        Effect.tryPromise({
          try: () =>
            crypto.subtle.importKey(
              "pkcs8",
              format === "pkcs1" ? wrapPkcs1(der) : der,
              { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
              false,
              ["sign"]
            ),
          catch: (cause) =>
            failure("invalid-config", "The GitHub App private key did not import as an RSA signing key.", {
              format,
              retryable: false
            }, { cause })
        })
      )
    )
  })

const encoder = new TextEncoder()

const base64Url = (bytes: Uint8Array): string => {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

const base64UrlJson = (value: unknown): string => base64Url(encoder.encode(JSON.stringify(value)))

const signJwt = (key: CryptoKey, appId: string): Effect.Effect<Redacted.Redacted<string>> =>
  Effect.flatMap(Clock.currentTimeMillis, (nowMs) => {
    const now = Math.floor(nowMs / 1000)
    const input = `${base64UrlJson({ alg: "RS256", typ: "JWT" })}.${
      base64UrlJson({ iat: now - JWT_BACKDATE_SECONDS, exp: now + JWT_LIFETIME_SECONDS, iss: appId })
    }`
    // The key imported for signing, so a refusal here is a broken host, not a
    // failure a caller can act on.
    return Effect.promise(() => crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, encoder.encode(input))).pipe(
      Effect.map((signature) => Redacted.make(`${input}.${base64Url(new Uint8Array(signature))}`))
    )
  })

const Installation = Schema.Struct({ id: Schema.Number })

const AccessTokenResponse = Schema.Struct({ token: Schema.NonEmptyString, expires_at: Schema.String })

const decodeAccessToken = Schema.decodeUnknownOption(AccessTokenResponse)

const isPositiveInteger = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0

/**
 * Validates `credentials` and returns the service, over the `HttpClient` in
 * context.
 *
 * A private key that does not parse or import, an empty `appId`, and a
 * malformed `apiBaseUrl` or `requestTimeout` fail `invalid-config`, never
 * echoing the key.
 *
 * @example
 * ```ts
 * import { GitHub } from "@smthrs/integrations"
 * import { Effect, Redacted } from "effect"
 * import { FetchHttpClient } from "effect/http"
 *
 * const token = Effect.gen(function*() {
 *   const app = yield* GitHub.AppAuth.make({ appId: "12345", privateKey: Redacted.make("PEM") })
 *   const { id } = yield* app.installation("OWNER", "REPO")
 *   return yield* app.installationToken({ installationId: id, repositories: ["REPO"], permissions: { issues: "write" } })
 * }).pipe(Effect.provide(FetchHttpClient.layer))
 * ```
 *
 * @category constructors
 * @since 1.0.0
 */
export const make = (credentials: AppCredentials): Effect.Effect<AppAuth, IntegrationError, HttpClient.HttpClient> =>
  Effect.gen(function*() {
    const appId = typeof credentials.appId === "string" ? credentials.appId.trim() : ""
    if (!/^[A-Za-z0-9._-]{1,100}$/.test(appId)) {
      return yield* Effect.fail(invalidConfig("The GitHub App ID must be the App's numeric ID or its client ID."))
    }
    const key = yield* importPrivateKey(credentials.privateKey)
    const http = yield* HttpClient.HttpClient
    const config = { apiBaseUrl: credentials.apiBaseUrl, requestTimeout: credentials.requestTimeout }
    // Builds a tokenless client once so a malformed base URL or deadline fails
    // here rather than on the first call.
    yield* GitHubClient.make(config, {}).pipe(Effect.provideService(HttpClient.HttpClient, http))

    const jwt = signJwt(key, appId).pipe(Effect.withSpan("GitHub.AppAuth.jwt"))

    // A client per call: the JWT expires within minutes, so it is never kept.
    const asApp = Effect.flatMap(
      jwt,
      (token) =>
        GitHubClient.make({ ...config, token: Redacted.value(token) }, {}).pipe(
          Effect.provideService(HttpClient.HttpClient, http)
        )
    )

    const installation: AppAuth["installation"] = (owner, repo) =>
      Effect.gen(function*() {
        const repository = yield* requireRepositoryPath(owner, repo)
        const client = yield* asApp
        return yield* client.request("GET", `/repos/${repository}/installation`, undefined, {
          schema: Installation
        }).pipe(
          Effect.mapError((error) =>
            error.details?.["status"] === 404
              ? new IntegrationError(
                "delivery-failed",
                `The GitHub App is not installed on ${owner}/${repo}, or cannot see it.`,
                { ...error.details, owner, repo, installed: false, retryable: false }
              )
              : error
          )
        )
      }).pipe(
        Effect.withSpan("GitHub.AppAuth.installation", { attributes: { "github.owner": owner, "github.repo": repo } })
      )

    const installationToken: AppAuth["installationToken"] = (options) =>
      Effect.gen(function*() {
        const { installationId, permissions, repositories, repositoryIds } = options
        if (!isPositiveInteger(installationId)) {
          return yield* Effect.fail(invalidConfig("A GitHub App installation ID must be a positive integer."))
        }
        const badName = repositories?.find((name) => !isRepo(name))
        if (badName !== undefined) {
          return yield* Effect.fail(
            invalidConfig("A repository an installation token names is not a repository name.", {
              repository: String(badName).slice(0, 100)
            })
          )
        }
        if (repositoryIds?.some((id) => !isPositiveInteger(id)) === true) {
          return yield* Effect.fail(
            invalidConfig("A repository ID an installation token names is not a positive integer.")
          )
        }
        const client = yield* asApp
        // Minting is safe to repeat: a second POST only issues another
        // short-lived token, so a lost answer is retryable, not unknown.
        const answer = yield* client.request("POST", `/app/installations/${installationId}/access_tokens`, {
          ...(repositories === undefined ? {} : { repositories: [...repositories] }),
          ...(repositoryIds === undefined ? {} : { repository_ids: [...repositoryIds] }),
          ...(permissions === undefined ? {} : { permissions: { ...permissions } })
        }, { retryUnsafeWrites: true })
        const decoded = decodeAccessToken(answer)
        const expiresAt = Option.isSome(decoded) ? Date.parse(decoded.value.expires_at) : Number.NaN
        if (Option.isNone(decoded) || !Number.isFinite(expiresAt)) {
          // The answer is not quoted: it may hold the token.
          return yield* Effect.fail(
            new IntegrationError(
              "decode-failed",
              `GitHub's installation access token response for installation ${installationId} did not have the expected shape.`,
              { installationId, retryable: false }
            )
          )
        }
        return { token: Redacted.make(decoded.value.token), expiresAt }
      }).pipe(
        Effect.withSpan("GitHub.AppAuth.installationToken", {
          attributes: {
            "github.installation_id": options.installationId,
            "github.repository_count": (options.repositories?.length ?? 0) + (options.repositoryIds?.length ?? 0),
            "github.permission_count": Object.keys(options.permissions ?? {}).length
          }
        })
      )

    return AppAuth.of({ jwt, installation, installationToken })
  })

/**
 * Layer for {@link AppAuth}, over the `HttpClient` in context.
 *
 * @example
 * ```ts
 * import { GitHub } from "@smthrs/integrations"
 * import { Layer, Redacted } from "effect"
 * import { FetchHttpClient } from "effect/http"
 *
 * const app = GitHub.AppAuth.layer({ appId: "12345", privateKey: Redacted.make("PEM") }).pipe(
 *   Layer.provide(FetchHttpClient.layer)
 * )
 * ```
 *
 * @category layers
 * @since 1.0.0
 */
export const layer = (credentials: AppCredentials): Layer.Layer<AppAuth, IntegrationError, HttpClient.HttpClient> =>
  Layer.effect(AppAuth)(make(credentials))

/**
 * Maximum repositories explicitly named by one installation token.
 * @see https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app
 * @category constants
 * @since 1.0.0
 */
export const MAX_TOKEN_REPOSITORIES = 500

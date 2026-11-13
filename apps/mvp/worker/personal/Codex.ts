import { Config, Context, Effect, Redacted, Schema } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http"

// A Codex subscription's credential (decision 0132): OpenAI's device-code sign-in, the flow the Codex CLI's
// `codex login --device-auth` runs (openai/codex codex-rs/login/src/device_code_auth.rs) and Amp's "ChatGPT Subscription
// (Legacy)" runs from its server (`/api/openai-chatgpt/oauth/start`). The person types a code at OpenAI; we hold the
// tokens sealed and refresh them here. No token leaves this Worker except through a box's egress, as a substitution.
//
// Everything here is a plain HTTP call over the injected `FetchHttpClient.Fetch`, so tests script OpenAI at the network.

/**
 * `CODEX_AUTH_ORIGIN` and `CODEX_OAUTH_CLIENT_ID`: OpenAI's auth server and the public OAuth client of the Codex CLI,
 * which Amp's legacy flow uses too. Sign in with ChatGPT needs its own partner client (decision 0132, follow-up).
 */
export const config = Effect.gen(function* () {
  const origin = yield* Config.String("CODEX_AUTH_ORIGIN").pipe(Config.withDefault("https://auth.openai.com"))
  const clientId = yield* Config.String("CODEX_OAUTH_CLIENT_ID").pipe(Config.withDefault("app_EMoamEEZ73f0CkXaXp7hrann"))
  return { origin, clientId }
}).pipe(Effect.orDie)

/** `config`, read where a program builds: a request or a step reading it would bind nothing (tests/worker-config.test.ts). */
export class CodexAuth extends Context.Service<CodexAuth, { readonly origin: string; readonly clientId: string }>()("@smthrs/mvp/personal/CodexAuth") {}

/** OpenAI's code a person types, and the handle polling it. */
export const UserCode = Schema.Struct({
  device_auth_id: Schema.String,
  user_code: Schema.optional(Schema.String),
  usercode: Schema.optional(Schema.String),
  interval: Schema.optional(Schema.Union([Schema.String, Schema.Number])),
})

/** What the poll answers once the person approved. */
const Approved = Schema.Struct({ authorization_code: Schema.String, code_verifier: Schema.String })

/** What OpenAI's token endpoint answers. */
const Tokens = Schema.Struct({
  access_token: Schema.String,
  refresh_token: Schema.optional(Schema.String),
  id_token: Schema.optional(Schema.String),
  expires_in: Schema.optional(Schema.Number),
})

/** The credential sealed in a `codex_subscription` row, as JSON. */
export const Credential = Schema.Struct({
  accessToken: Schema.String,
  refreshToken: Schema.String,
  idToken: Schema.String,
  accountId: Schema.String,
  planType: Schema.String,
  /** When the access token expires, in epoch milliseconds. */
  expiresAt: Schema.Number,
})
export type Credential = typeof Credential.Type

/** The longest one call to OpenAI's auth server may take. */
const REQUEST_TIMEOUT = "30 seconds"

/** How long past now an access token must live for a run to start on it: a run's limit and some. */
export const FRESH_FOR_MS = 2 * 60 * 60 * 1000

/** An access token's lifetime when OpenAI doesn't say: the 8 days after which the Codex CLI refreshes. */
const ASSUMED_LIFETIME_MS = 8 * 24 * 60 * 60 * 1000

/** OpenAI refused: `pending` while the person hasn't approved, `refused` for good; the status when one came. */
export class CodexAuthFailed extends Schema.TaggedError<CodexAuthFailed>()("@smthrs/mvp/personal/CodexAuthFailed", {
  reason: Schema.Literals(["pending", "refused", "unreachable"]),
  status: Schema.NullOr(Schema.Number),
}) {}

const decodeCredential = Schema.decodeUnknownEffect(Schema.fromJsonString(Credential))

/** The sealed credential's text as a {@link Credential}. */
export const readCredential = (text: Redacted.Redacted<string>) =>
  decodeCredential(Redacted.value(text)).pipe(Effect.mapError(() => new CodexAuthFailed({ reason: "refused", status: null })))

/** The claims of an unsigned read of `idToken`: what plan and which ChatGPT workspace it is for. */
export const claimsOf = (idToken: string): { readonly accountId: string; readonly planType: string } => {
  try {
    const payload = JSON.parse(atob(idToken.split(".")[1]!.replace(/-/g, "+").replace(/_/g, "/"))) as Record<string, unknown>
    const auth = payload["https://api.openai.com/auth"] as Record<string, unknown> | undefined
    return { accountId: String(auth?.["chatgpt_account_id"] ?? ""), planType: String(auth?.["chatgpt_plan_type"] ?? "unknown") }
    // expected: a token that isn't a JWT has no claims
  } catch {
    return { accountId: "", planType: "unknown" }
  }
}

const decoded = <A, I>(schema: Schema.Codec<A, I>, json: Effect.Effect<unknown, unknown>) =>
  json.pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(schema)),
    Effect.mapError(() => new CodexAuthFailed({ reason: "refused", status: 200 })),
  )

const post = <A, I>(body: HttpClientRequest.HttpClientRequest, schema: Schema.Codec<A, I>, pending = false) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    const answer = yield* client.execute(body).pipe(
      Effect.mapError(() => new CodexAuthFailed({ reason: "unreachable", status: null })),
    )
    if (answer.status !== 200) {
      return yield* new CodexAuthFailed({
        reason: pending && (answer.status === 403 || answer.status === 404) ? "pending" : "refused",
        status: answer.status,
      })
    }
    return yield* decoded(schema, answer.json)
  }).pipe(
    // Keep the body and decoding inside the deadline: a refresh holds a database row until this finishes.
    Effect.timeout(REQUEST_TIMEOUT),
    Effect.catchTag("TimeoutError", () => Effect.fail(new CodexAuthFailed({ reason: "unreachable", status: null }))),
    Effect.provide(FetchHttpClient.layer),
  )

const jsonTo = <A, I>(url: string, value: unknown, schema: Schema.Codec<A, I>, pending = false) =>
  post(HttpClientRequest.bodyJsonUnsafe(HttpClientRequest.post(url), value), schema, pending)

/** Asks OpenAI for a code the person types at {@link verificationUrl}. */
export const requestCode = Effect.gen(function* () {
  const { origin, clientId } = yield* CodexAuth
  const code = yield* jsonTo(`${origin}/api/accounts/deviceauth/usercode`, { client_id: clientId }, UserCode)
  const userCode = code.user_code ?? code.usercode
  if (userCode === undefined) return yield* new CodexAuthFailed({ reason: "refused", status: 200 })
  return {
    deviceAuthId: code.device_auth_id,
    userCode,
    intervalSeconds: Number(code.interval ?? 5) || 5,
    verificationUrl: `${origin}/codex/device`,
  }
})

const form = <A, I>(url: string, fields: Record<string, string>, schema: Schema.Codec<A, I>) =>
  post(HttpClientRequest.bodyUrlParams(HttpClientRequest.post(url), fields), schema)

/** The credential OpenAI's `answer` holds, keeping `earlier`'s refresh token when it rotated none. */
const credentialOf = (tokens: typeof Tokens.Type, earlier: Credential | undefined, now: number): Credential | undefined => {
  const refreshToken = tokens.refresh_token ?? earlier?.refreshToken
  const idToken = tokens.id_token ?? earlier?.idToken
  if (refreshToken === undefined || idToken === undefined) return undefined
  return {
    accessToken: tokens.access_token,
    refreshToken,
    idToken,
    ...claimsOf(idToken),
    expiresAt: now + (tokens.expires_in === undefined ? ASSUMED_LIFETIME_MS : tokens.expires_in * 1000),
  }
}

/**
 * One poll of a device code: the credential once the person approved, failing `pending` until then (OpenAI answers 403
 * or 404 while they haven't), `refused` for anything else.
 */
export const poll = (deviceAuthId: string, userCode: string, now: number) =>
  Effect.gen(function* () {
    const { origin, clientId } = yield* CodexAuth
    const approved = yield* jsonTo(
      `${origin}/api/accounts/deviceauth/token`, { device_auth_id: deviceAuthId, user_code: userCode }, Approved, true,
    )
    const exchanged = yield* form(`${origin}/oauth/token`, {
      grant_type: "authorization_code",
      code: approved.authorization_code,
      redirect_uri: `${origin}/deviceauth/callback`,
      client_id: clientId,
      code_verifier: approved.code_verifier,
    }, Tokens)
    const credential = credentialOf(exchanged, undefined, now)
    if (credential === undefined) return yield* new CodexAuthFailed({ reason: "refused", status: 200 })
    return credential
  })

/** `credential` refreshed at OpenAI. Its refresh token may rotate: the caller seals the answer before anything else. */
export const refresh = (credential: Credential, now: number) =>
  Effect.gen(function* () {
    const { origin, clientId } = yield* CodexAuth
    const answer = yield* form(`${origin}/oauth/token`, {
      grant_type: "refresh_token",
      refresh_token: credential.refreshToken,
      client_id: clientId,
    }, Tokens)
    return credentialOf(answer, credential, now)!
  })

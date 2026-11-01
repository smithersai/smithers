/**
 * The refresh-token access-token source, against a real `node:http` token
 * endpoint and, for rotation, the real control-plane credential boundary over
 * an in-memory SQLite database with AES-GCM sealing.
 *
 * Nothing is mocked. The expiry cases move Effect's clock with `TestClock`,
 * which is the clock the source reads; the requests themselves are real, over
 * the real fetch transport. The recovery cases run each token request as a
 * durable step on the flow engine, whose retry policy is the only retry.
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { Unauthorized } from "@smthrs/control/ControlError"
import * as Credential from "@smthrs/control/Credential"
import * as CredentialStore from "@smthrs/control/CredentialStore"
import * as SqlCredentialStore from "@smthrs/control/SqlCredentialStore"
import * as WebCryptoCipher from "@smthrs/control/WebCryptoCipher"
import { Crypto } from "@smthrs/crypto"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { FlowEngine } from "@smthrs/engine"
import { Action, Flow, Interpreter } from "@smthrs/flow"
import { Cause, Effect, Exit, Fiber, Layer, Redacted, Schema } from "effect"
import type * as HttpClient from "effect/http/HttpClient"
import { TestClock } from "effect/testing"
import { afterEach, describe, expect, it } from "vitest"
import type { AccessTokenSource } from "../src/core/AccessToken.vibe"
import { Failure, fromIntegrationError, RetryableIntegrationFailure, retryPolicy } from "../src/core/ActionFailure.ts"
import { IntegrationError, isIntegrationError } from "../src/core/IntegrationError.ts"
import * as OAuthToken from "../src/core/OAuthToken.ts"
import { type Fixture, json, type Recorded, startFixture } from "./Fixture.ts"
import { fetchLayer } from "./Http.ts"

const REFRESH = "refresh-token-fixture-1"
const SECRET = "client-secret-fixture"

let fixture: Fixture | undefined

afterEach(async () => {
  await fixture?.close()
  fixture = undefined
})

const form = (request: Recorded): URLSearchParams => new URLSearchParams(request.body)

const tokenRequests = (): ReadonlyArray<Recorded> => (fixture as Fixture).requests

/** The typed failure an effect ends with, over the real fetch transport. */
const failure = async <A>(
  effect: Effect.Effect<A, IntegrationError, HttpClient.HttpClient>
): Promise<IntegrationError> => {
  const exit = await Effect.runPromiseExit(Effect.provide(effect, fetchLayer))
  if (Exit.isSuccess(exit)) throw new Error("expected a typed failure")
  const error = Cause.squash(exit.cause)
  if (!isIntegrationError(error)) throw error
  return error
}

const endpoint = (extra: Partial<OAuthToken.Options> = {}): OAuthToken.Options => ({
  provider: "Fixture",
  tokenUrl: `${(fixture as Fixture).origin}/token`,
  clientId: "client-id",
  clientSecret: Redacted.make(SECRET),
  refreshToken: OAuthToken.memoryStore(Redacted.make(REFRESH)),
  ...extra
})

/** A token endpoint that mints `access-<n>` for every refresh. */
const mintingEndpoint = async (answer: Record<string, unknown> = { expires_in: 3600 }) => {
  let minted = 0
  fixture = await startFixture((_request, response) => {
    minted += 1
    json(response, 200, { access_token: `access-${minted}`, token_type: "Bearer", ...answer })
  })
}

const value = (token: Redacted.Redacted<string>): string => Redacted.value(token)

/** A source over the real fetch transport. */
const sourceOf = (options: OAuthToken.Options): AccessTokenSource =>
  Effect.runSync(Effect.provide(OAuthToken.make(options), fetchLayer))

/** The token a fresh source mints. */
const tokenOf = (options: OAuthToken.Options) => Effect.flatMap(OAuthToken.make(options), (source) => source.token)

/** A durable step that asks a source for its access token, under the integration retry policy. */
const TokenStep = Action.make("test/integrations/oauth-token", {
  payload: { source: Schema.String },
  success: Schema.String,
  error: Failure,
  retryPolicy
})

const tokenFlow = Flow.make("test/integrations/oauth-token-flow", {
  payload: { source: Schema.String },
  success: Schema.String,
  error: Failure,
  body: (input) => TokenStep.call(input)
})

/** How one token step settled, and how many attempts the engine made. */
interface Settled {
  readonly token?: string
  readonly failure?: Failure
  readonly attempts: number
}

/**
 * Runs one token step per source, each as its own durable flow on the engine
 * and all at once, and settles each to its token or its final failure.
 */
const tokenSteps = (sources: Readonly<Record<string, AccessTokenSource>>): Effect.Effect<ReadonlyArray<Settled>> => {
  const attempts = new Map<string, number>()
  const layer = Layer.mergeAll(
    TokenStep.toLayer(({ source }) =>
      Effect.suspend(() => {
        attempts.set(source, (attempts.get(source) ?? 0) + 1)
        return sources[source]!.token
      }).pipe(Effect.map(value), Effect.mapError((error) => fromIntegrationError(error)))
    ),
    Interpreter.layer(tokenFlow)
  ).pipe(
    Layer.provideMerge(Action.layerImplementations),
    Layer.provideMerge(Layer.mergeAll(FlowEngine.layerMemory, Crypto.layerFromDigest(NodeCrypto.layerDigest)))
  )
  return Effect.forEach(
    Object.keys(sources),
    (source) =>
      tokenFlow.execute({ source }, { executionId: `oauth-token-${source}` }).pipe(
        Effect.match({
          onSuccess: (token): Settled => ({ token, attempts: attempts.get(source) ?? 0 }),
          onFailure: (failure): Settled => ({ failure: failure as Failure, attempts: attempts.get(source) ?? 0 })
        })
      ),
    { concurrency: "unbounded" }
  ).pipe(Effect.provide(layer), Effect.scoped)
}

describe("OAuthToken refresh", () => {
  it("exchanges the refresh token with the client credentials in the form body", async () => {
    await mintingEndpoint()
    const source = sourceOf(endpoint({ scopes: ["scope.a", "scope.b"] }))
    const token = await Effect.runPromise(source.token)
    expect(value(token)).toBe("access-1")
    const request = tokenRequests()[0] as Recorded
    expect(request.method).toBe("POST")
    expect(request.url).toBe("/token")
    expect(request.headers["content-type"]).toBe("application/x-www-form-urlencoded")
    expect(request.headers["authorization"]).toBeUndefined()
    expect(Object.fromEntries(form(request))).toEqual({
      grant_type: "refresh_token",
      refresh_token: REFRESH,
      scope: "scope.a scope.b",
      client_id: "client-id",
      client_secret: SECRET
    })
  })

  it("serves the cached token until its expiry minus the skew, then refreshes", async () => {
    await mintingEndpoint({ expires_in: 3600 })
    const source = sourceOf(endpoint({ skew: "60 seconds" }))
    const seen = await Effect.runPromise(
      Effect.gen(function*() {
        const first = yield* source.token
        yield* TestClock.adjust("58 minutes")
        const cached = yield* source.token
        yield* TestClock.adjust("1 minute")
        const refreshed = yield* source.token
        const again = yield* source.token
        return [first, cached, refreshed, again].map(value)
      }).pipe(Effect.provide(TestClock.layer()))
    )
    expect(seen).toEqual(["access-1", "access-1", "access-2", "access-2"])
    expect(tokenRequests()).toHaveLength(2)
  })

  it("mints a fresh token after invalidate even when the old one has not expired", async () => {
    await mintingEndpoint()
    const source = sourceOf(endpoint())
    const seen = await Effect.runPromise(Effect.gen(function*() {
      const first = yield* source.token
      yield* source.invalidate
      return [first, yield* source.token].map(value)
    }))
    expect(seen).toEqual(["access-1", "access-2"])
  })

  it("does not cache a grant that does not say when it expires", async () => {
    await mintingEndpoint({})
    const source = sourceOf(endpoint())
    const seen = await Effect.runPromise(Effect.all([source.token, source.token]))
    expect(seen.map(value)).toEqual(["access-1", "access-2"])
  })

  it("accepts expires_in as a numeric string", async () => {
    await mintingEndpoint({ expires_in: "3600" })
    const source = sourceOf(endpoint())
    const seen = await Effect.runPromise(Effect.all([source.token, source.token]))
    expect(seen.map(value)).toEqual(["access-1", "access-1"])
  })

  it("shares one refresh between concurrent callers", async () => {
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let minted = 0
    fixture = await startFixture(async (_request, response) => {
      await gate
      minted += 1
      json(response, 200, { access_token: `access-${minted}`, expires_in: 3600 })
    })
    const source = sourceOf(endpoint())
    const fiber = Effect.runFork(
      Effect.all(Array.from({ length: 5 }, () => source.token), { concurrency: "unbounded" })
    )
    await (fixture as Fixture).arrived
    release?.()
    const tokens = await Effect.runPromise(Fiber.join(fiber))
    expect(tokens.map(value)).toEqual(Array(5).fill("access-1"))
    expect(tokenRequests()).toHaveLength(1)
  })

  it("authenticates with HTTP Basic when asked, and keeps the secret out of the body", async () => {
    await mintingEndpoint()
    const source = sourceOf(endpoint({ clientAuthentication: "basic", clientId: "id:with space" }))
    await Effect.runPromise(source.token)
    const request = tokenRequests()[0] as Recorded
    const basic = Buffer.from(`${encodeURIComponent("id:with space")}:${encodeURIComponent(SECRET)}`).toString("base64")
    expect(request.headers["authorization"]).toBe(`Basic ${basic}`)
    expect(form(request).has("client_secret")).toBe(false)
    expect(form(request).has("client_id")).toBe(false)
  })

  it("sends only the client id for a public client", async () => {
    await mintingEndpoint()
    const source = sourceOf(endpoint({ clientSecret: undefined, clientAuthentication: "basic" }))
    await Effect.runPromise(source.token)
    const request = tokenRequests()[0] as Recorded
    expect(request.headers["authorization"]).toBeUndefined()
    expect(form(request).get("client_id")).toBe("client-id")
    expect(form(request).has("client_secret")).toBe(false)
  })
})

describe("OAuthToken failures", () => {
  // A source cannot tell a revoked grant from a rotation another source has not
  // persisted yet without waiting, and the wait belongs to the step's retry
  // policy. So the refusal is permission-denied, and retryable after the settle
  // time; the step's bounded attempts end a grant that really is revoked.
  it("reports invalid_grant as permission-denied after one request, retryable after the settle time, never echoing a secret", async () => {
    fixture = await startFixture((request, response) => {
      json(response, 400, {
        error: "invalid_grant",
        error_description: `Token ${form(request).get("refresh_token")} has been expired or revoked (${SECRET}).`
      })
    })
    const error = await failure(tokenOf(endpoint()))
    expect(error.reason).toBe("permission-denied")
    expect(error.details).toMatchObject({
      oauthError: "invalid_grant",
      retryable: true,
      rotated: false,
      retryAfterMillis: OAuthToken.ROTATION_SETTLE_MS
    })
    expect(error.summary).toContain("may still be rotating")
    expect(tokenRequests()).toHaveLength(1)
    const text = JSON.stringify({ summary: error.summary, message: error.message, details: error.details })
    expect(text).not.toContain(REFRESH)
    expect(text).not.toContain(SECRET)
    expect(text).toContain("[REDACTED]")
  })

  it("maps the OAuth error codes onto the package's reasons", () => {
    expect(OAuthToken.reasonForOAuthError("invalid_grant")).toBe("permission-denied")
    expect(OAuthToken.reasonForOAuthError("unauthorized_client")).toBe("permission-denied")
    expect(OAuthToken.reasonForOAuthError("invalid_scope")).toBe("permission-denied")
    expect(OAuthToken.reasonForOAuthError("access_denied")).toBe("permission-denied")
    expect(OAuthToken.reasonForOAuthError("invalid_client")).toBe("invalid-config")
    expect(OAuthToken.reasonForOAuthError("invalid_request")).toBe("invalid-config")
    expect(OAuthToken.reasonForOAuthError("unsupported_grant_type")).toBe("invalid-config")
    expect(OAuthToken.reasonForOAuthError("temporarily_unavailable")).toBe("delivery-failed")
    // GitHub's own codes for a used or expired code or refresh token, and for a wrong client or redirect URI.
    expect(OAuthToken.reasonForOAuthError("bad_verification_code")).toBe("permission-denied")
    expect(OAuthToken.reasonForOAuthError("bad_refresh_token")).toBe("permission-denied")
    expect(OAuthToken.reasonForOAuthError("incorrect_client_credentials")).toBe("invalid-config")
    expect(OAuthToken.reasonForOAuthError("redirect_uri_mismatch")).toBe("invalid-config")
  })

  it("reports an OAuth error answered with 200, as GitHub answers one, as that error", async () => {
    fixture = await startFixture((_request, response) =>
      json(response, 200, {
        error: "bad_refresh_token",
        error_description: "The refresh token passed is incorrect or expired."
      })
    )
    const error = await failure(tokenOf(endpoint()))
    expect(error.reason).toBe("permission-denied")
    expect(error.details?.["oauthError"]).toBe("bad_refresh_token")
    expect(error.details?.["status"]).toBe(200)
    expect(error.details?.["retryable"]).toBe(false)
    expect(tokenRequests()).toHaveLength(1)
  })

  it("reports a rejected client as invalid-config", async () => {
    fixture = await startFixture((_request, response) => json(response, 401, { error: "invalid_client" }))
    const error = await failure(tokenOf(endpoint()))
    expect(error.reason).toBe("invalid-config")
    expect(error.details?.["status"]).toBe(401)
  })

  it("reports a refusal without an OAuth body as delivery-failed", async () => {
    fixture = await startFixture((_request, response) => {
      response.writeHead(403, { "content-type": "text/plain" })
      response.end("forbidden")
    })
    const error = await failure(tokenOf(endpoint()))
    expect(error.reason).toBe("delivery-failed")
    expect(error.details?.["oauthError"]).toBeNull()
    expect(error.details?.["retryable"]).toBe(false)
  })

  // The flow engine decides every retry, durably. The source makes one request
  // per refresh and hands the engine whether another attempt may help and how
  // long the server asked to wait.
  it("fails a 5xx and a 429 after one request each, retryable, with the wait the server named", async () => {
    let calls = 0
    fixture = await startFixture((_request, response) => {
      calls += 1
      if (calls === 1) return json(response, 503, { error: "temporarily_unavailable" }, { "retry-after": "4" })
      json(response, 429, { error: "slow_down" }, { "retry-after": "2" })
    })
    const unavailable = await failure(tokenOf(endpoint()))
    expect(unavailable.reason).toBe("delivery-failed")
    expect(unavailable.details).toMatchObject({
      status: 503,
      retryable: true,
      outcomeUnknown: false,
      retryAfterMillis: 4_000
    })
    const limited = await failure(tokenOf(endpoint()))
    expect(limited.details).toMatchObject({ status: 429, retryable: true, rateLimited: true, retryAfterMillis: 2_000 })
    expect(calls).toBe(2)
  })

  it("carries a Retry-After only when it is delay-seconds", async () => {
    fixture = await startFixture((_request, response) =>
      json(response, 429, { error: "slow_down" }, { "retry-after": "soon" })
    )
    const error = await failure(tokenOf(endpoint()))
    expect(error.details).toMatchObject({ retryable: true })
    expect(error.details).not.toHaveProperty("retryAfterMillis")
  })

  // A followed 307 re-sends the POST, refresh token and client secret
  // included, to the origin the Location names.
  it("refuses to follow a redirect, so the form never reaches another origin", async () => {
    const elsewhere = await startFixture((_request, response) => json(response, 200, { access_token: "stolen" }))
    try {
      fixture = await startFixture((_request, response) => {
        response.writeHead(307, { location: `${elsewhere.origin}/token` })
        response.end()
      })
      const error = await failure(tokenOf(endpoint()))
      expect(error.reason).toBe("delivery-failed")
      expect(error.details?.["status"]).toBe(307)
      expect(tokenRequests()).toHaveLength(1)
      expect(elsewhere.requests).toHaveLength(0)
    } finally {
      await elsewhere.close()
    }
  })

  it("rejects an answer that is not a bearer grant as decode-failed", async () => {
    for (
      const body of [
        { access_token: "a", token_type: "mac" },
        { access_token: "" },
        { access_token: "a", expires_in: "soon" },
        { access_token: "a", expires_in: -1 },
        "not json at all"
      ]
    ) {
      fixture = await startFixture((_request, response) => {
        if (typeof body === "string") {
          response.writeHead(200, { "content-type": "text/plain" })
          response.end(body)
          return
        }
        json(response, 200, body)
      })
      const error = await failure(tokenOf(endpoint()))
      expect(error.reason, JSON.stringify(body)).toBe("decode-failed")
      await fixture.close()
      fixture = undefined
    }
  })

  it("times out a stalled endpoint and reports the retryable failure", async () => {
    fixture = await startFixture(() => {
      // Never answers.
    })
    const error = await failure(tokenOf(endpoint({ requestTimeout: "100 millis" })))
    expect(error.reason).toBe("delivery-failed")
    expect(error.details?.["timedOut"]).toBe(true)
    expect(error.details?.["retryable"]).toBe(true)
  })

  it("reports a refused connection as a retryable delivery failure", async () => {
    fixture = await startFixture((_request, response) => json(response, 200, {}))
    const origin = fixture.origin
    await fixture.close()
    fixture = undefined
    const error = await failure(tokenOf(endpoint0(origin)))
    expect(error.reason).toBe("delivery-failed")
    expect(error.details?.["retryable"]).toBe(true)
  })

  it("validates its configuration up front", () => {
    const thrown = (options: OAuthToken.Options): IntegrationError =>
      Effect.runSync(Effect.provide(Effect.flip(OAuthToken.make(options)), fetchLayer))
    const base = endpoint0("https://token.example.test")
    expect(thrown({ ...base, tokenUrl: "not a url" }).reason).toBe("invalid-config")
    expect(thrown({ ...base, tokenUrl: "ftp://token.example.test/" }).reason).toBe("invalid-config")
    expect(thrown({ ...base, clientId: "  " }).reason).toBe("credentials-missing")
    expect(thrown({ ...base, requestTimeout: "0 millis" }).reason).toBe("invalid-config")
    expect(thrown({ ...base, requestTimeout: "Infinity" }).reason).toBe("invalid-config")
    expect(thrown({ ...base, skew: "Infinity" }).reason).toBe("invalid-config")
    expect(thrown({ ...base, provider: undefined, tokenUrl: "nope" }).summary).toContain("OAuth tokenUrl")
  })

  // Only a config error is a typed failure; anything else the build throws is
  // a bug and stays a defect.
  it("keeps a non-config throw from the build a defect", () => {
    const exit = Effect.runSyncExit(Effect.provide(OAuthToken.make(null as never), fetchLayer))
    expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
  })
})

/** The endpoint options for an origin that is not the current fixture. */
const endpoint0 = (origin: string): OAuthToken.Options => ({
  provider: "Fixture",
  tokenUrl: `${origin}/token`,
  clientId: "client-id",
  clientSecret: Redacted.make(SECRET),
  refreshToken: OAuthToken.memoryStore(Redacted.make(REFRESH))
})

describe("OAuthToken memory store", () => {
  it("replaces only the value it was asked to replace", async () => {
    const store = OAuthToken.memoryStore(Redacted.make("one"))
    const results = await Effect.runPromise(Effect.gen(function*() {
      const stale = yield* store.replace(Redacted.make("zero"), Redacted.make("two"))
      const fresh = yield* store.replace(Redacted.make("one"), Redacted.make("two"))
      return [stale, fresh, value(yield* store.load)] as const
    }))
    expect(results).toEqual([false, true, "two"])
  })

  it("keeps a rotated refresh token for the next exchange", async () => {
    let calls = 0
    fixture = await startFixture((request, response) => {
      calls += 1
      json(response, 200, {
        access_token: `access-${calls}`,
        expires_in: 3600,
        refresh_token: `${form(request).get("refresh_token")}-rotated`
      })
    })
    const source = sourceOf(endpoint())
    await Effect.runPromise(Effect.gen(function*() {
      yield* source.token
      yield* source.invalidate
      yield* source.token
    }))
    expect(tokenRequests().map((request) => form(request).get("refresh_token"))).toEqual([
      REFRESH,
      `${REFRESH}-rotated`
    ])
  })
})

const HOST_KEY = Redacted.make(btoa("0123456789abcdef0123456789abcdef"))
const REFERENCE = { id: "calendar-refresh", name: "Calendar refresh token" }

/** Runs `use` against a real credential boundary over in-memory SQLite. */
const withCredentials = <A, E>(
  use: (
    credentials: Credential.Credential,
    store: CredentialStore.Service
  ) => Effect.Effect<A, E, HttpClient.HttpClient>,
  options: {
    readonly authorize?: Credential.Options["authorize"]
    readonly wrap?: (store: CredentialStore.Service) => CredentialStore.Service
  } = {}
): Promise<A> =>
  Effect.runPromise(
    Effect.gen(function*() {
      const durable = yield* SqlCredentialStore.make
      const store = options.wrap === undefined ? durable : options.wrap(durable)
      const cipher = yield* WebCryptoCipher.make({ key: HOST_KEY })
      const credentials = Credential.make({ store, cipher, authorize: options.authorize })
      return yield* use(credentials, store)
    }).pipe(Effect.provide([TestDatabase.layer, fetchLayer]), Effect.scoped, Effect.orDie)
  )

/**
 * A provider that retires each refresh token the moment it is exchanged, and
 * refuses a retired one with `invalid_grant`. The first `holdFirst` requests
 * are held until all of them arrived, so their callers present the same token.
 */
const strictRotatingProvider = (options: { readonly holdFirst: number }) => {
  let current: string | null = REFRESH
  let minted = 0
  const held: Array<() => void> = []
  return {
    revoke: () => {
      current = null
    },
    handle: async (request: Recorded, response: Parameters<Parameters<typeof startFixture>[0]>[1]) => {
      if (held.length < options.holdFirst) {
        await new Promise<void>((release) => {
          held.push(release)
          if (held.length === options.holdFirst) held.forEach((resume) => resume())
        })
      }
      const presented = form(request).get("refresh_token")
      if (presented !== current) {
        return json(response, 400, {
          error: "invalid_grant",
          error_description: `Token ${presented} was already used.`
        })
      }
      minted += 1
      current = `rt-${minted}`
      json(response, 200, { access_token: `at-${minted}`, expires_in: 3600, refresh_token: current })
    }
  }
}

/** Persists every write late, so a refused loser can see the old token first. */
const slowWrites = (durable: CredentialStore.Service): CredentialStore.Service =>
  CredentialStore.make({
    ...durable,
    write: (record) => Effect.andThen(Effect.sleep("150 millis"), durable.write(record))
  })

describe("OAuthToken credential store", () => {
  it("persists a rotated refresh token through the credential boundary", async () => {
    let calls = 0
    fixture = await startFixture((_request, response) => {
      calls += 1
      json(response, 200, {
        access_token: `access-${calls}`,
        expires_in: 3600,
        refresh_token: `rotated-${calls}`,
        scope: "calendar"
      })
    })
    const stored = await withCredentials((credentials) =>
      Effect.gen(function*() {
        yield* credentials.create({ ...REFERENCE, secret: Redacted.make(REFRESH) })
        const source = yield* OAuthToken.make(
          endpoint({ refreshToken: OAuthToken.credentialStore(credentials, REFERENCE) })
        )
        yield* source.token
        const afterFirst = value(yield* credentials.resolve(REFERENCE))
        yield* source.invalidate
        yield* source.token
        return [afterFirst, value(yield* credentials.resolve(REFERENCE))]
      })
    )
    expect(stored).toEqual(["rotated-1", "rotated-2"])
    expect(tokenRequests().map((request) => form(request).get("refresh_token"))).toEqual([REFRESH, "rotated-1"])
  })

  it("keeps the winner when another refresher rotated the stored token first", async () => {
    const stored = await withCredentials((credentials) =>
      Effect.gen(function*() {
        yield* credentials.create({ ...REFERENCE, secret: Redacted.make(REFRESH) })
        // The endpoint answers only after a competing refresher has written
        // its own rotation, which is the interleaving the compare exists for.
        fixture = yield* Effect.promise(() =>
          startFixture(async (_request, response) => {
            await Effect.runPromise(credentials.rotate(REFERENCE, Redacted.make("rotated-elsewhere")))
            json(response, 200, { access_token: "access-mine", expires_in: 3600, refresh_token: "rotated-mine" })
          })
        )
        const source = yield* OAuthToken.make(
          endpoint({ refreshToken: OAuthToken.credentialStore(credentials, REFERENCE) })
        )
        const token = yield* source.token
        return [value(token), value(yield* credentials.resolve(REFERENCE))]
      })
    )
    expect(stored).toEqual(["access-mine", "rotated-elsewhere"])
  })

  it("reports a write that lost the version compare-and-set as not replaced", async () => {
    let interleave: (() => Promise<void>) | undefined
    const replaced = await withCredentials(
      (credentials) =>
        Effect.gen(function*() {
          yield* credentials.create({ ...REFERENCE, secret: Redacted.make(REFRESH) })
          const store = OAuthToken.credentialStore(credentials, REFERENCE)
          // A competing rotation lands between `rotate`'s compare and its write.
          interleave = () =>
            Effect.runPromise(credentials.rotate(REFERENCE, Redacted.make("rotated-elsewhere"))).then(() => undefined)
          const outcome = yield* store.replace(Redacted.make(REFRESH), Redacted.make("rotated-mine"))
          return [outcome, value(yield* credentials.resolve(REFERENCE))]
        }),
      {
        wrap: (durable) => {
          let armed = 0
          return CredentialStore.make({
            ...durable,
            read: (id) =>
              durable.read(id).pipe(Effect.tap(() =>
                Effect.promise(async () => {
                  armed += 1
                  // The first read is `rotate`'s own: the secret it compares
                  // and the version it writes over both come from it.
                  if (armed === 1 && interleave !== undefined) {
                    const run = interleave
                    interleave = undefined
                    await run()
                  }
                })
              ))
          })
        }
      }
    )
    expect(replaced).toEqual([false, "rotated-elsewhere"])
  })

  // The race the recovery exists for: two sources present the same token, the
  // provider rotates it for one and refuses the other, and the winner is still
  // persisting its rotation when the loser's refusal arrives. Each token
  // request is a durable step, so the loser's step retries after the settle
  // time, re-reads the store, and presents the rotated token.
  it("converges independent sources that both present the same refresh token to a rotating provider", async () => {
    const provider = strictRotatingProvider({ holdFirst: 2 })
    fixture = await startFixture(provider.handle)
    const outcome = await withCredentials(
      (credentials, store) =>
        Effect.gen(function*() {
          yield* credentials.create({ ...REFERENCE, secret: Redacted.make(REFRESH) })
          // A second process: its own credential boundary over the same rows.
          const cipher = yield* WebCryptoCipher.make({ key: HOST_KEY }).pipe(Effect.orDie)
          const elsewhere = Credential.make({ store, cipher })
          const first = yield* OAuthToken.make(
            endpoint({ refreshToken: OAuthToken.credentialStore(credentials, REFERENCE) })
          )
          const second = yield* OAuthToken.make(
            endpoint({ refreshToken: OAuthToken.credentialStore(elsewhere, REFERENCE) })
          )
          const settled = yield* tokenSteps({ first, second })
          const stored = value(yield* credentials.resolve(REFERENCE))
          const later = yield* OAuthToken.make(
            endpoint({ refreshToken: OAuthToken.credentialStore(credentials, REFERENCE) })
          )
          return { settled, stored, later: value(yield* later.token) }
        }),
      { wrap: slowWrites }
    )
    expect(outcome.settled.map((step) => step.token).sort()).toEqual(["at-1", "at-2"])
    expect(outcome.settled.map((step) => step.attempts).sort()).toEqual([1, 2])
    expect(outcome.stored).toBe("rt-2")
    expect(outcome.later).toBe("at-3")
    expect(tokenRequests().map((request) => form(request).get("refresh_token"))).toEqual([
      REFRESH,
      REFRESH,
      "rt-1",
      "rt-2"
    ])
    // The loser waited the settle time before presenting the rotated token.
    const [, refused, followed] = tokenRequests() as ReadonlyArray<Recorded>
    expect(followed!.receivedAt - refused!.receivedAt).toBeGreaterThanOrEqual(OAuthToken.ROTATION_SETTLE_MS)
  })

  it("ends a revoked grant when the step's attempts run out, presenting it once per attempt", async () => {
    const provider = strictRotatingProvider({ holdFirst: 0 })
    provider.revoke()
    fixture = await startFixture(provider.handle)
    const outcome = await withCredentials((credentials) =>
      Effect.gen(function*() {
        yield* credentials.create({ ...REFERENCE, secret: Redacted.make(REFRESH) })
        const source = yield* OAuthToken.make(
          endpoint({ refreshToken: OAuthToken.credentialStore(credentials, REFERENCE) })
        )
        const [step] = yield* tokenSteps({ source })
        return { step: step!, stored: value(yield* credentials.resolve(REFERENCE)) }
      })
    )
    expect(outcome.step.failure).toBeInstanceOf(RetryableIntegrationFailure)
    expect(outcome.step.failure).toMatchObject({ reason: "permission-denied", retryAfterMillis: 500 })
    expect(outcome.step.attempts).toBe(retryPolicy.maxAttempts)
    expect(outcome.stored).toBe(REFRESH)
    expect(tokenRequests()).toHaveLength(retryPolicy.maxAttempts!)
    expect(JSON.stringify(outcome.step.failure)).not.toContain(REFRESH)
  })

  it("presents a stored token another writer already rotated on the next attempt, without waiting", async () => {
    let rotations = 0
    const outcome = await withCredentials((credentials) =>
      Effect.gen(function*() {
        yield* credentials.create({ ...REFERENCE, secret: Redacted.make(REFRESH) })
        // Every exchange is refused, and each time another writer has already
        // rotated the stored token again.
        fixture = yield* Effect.promise(() =>
          startFixture(async (request, response) => {
            rotations += 1
            await Effect.runPromise(credentials.rotate(REFERENCE, Redacted.make(`elsewhere-${rotations}`)))
            json(response, 400, {
              error: "invalid_grant",
              error_description: `Token ${form(request).get("refresh_token")} was already used.`
            })
          })
        )
        const source = yield* OAuthToken.make(
          endpoint({ refreshToken: OAuthToken.credentialStore(credentials, REFERENCE) })
        )
        // Outside a step: one request, and a failure that asks for no wait.
        const direct = yield* Effect.flip(source.token)
        const [step] = yield* tokenSteps({ source })
        return { direct, step: step! }
      })
    )
    expect(outcome.direct.details).toMatchObject({ retryable: true, rotated: true, retryAfterMillis: 0 })
    expect(outcome.direct.summary).toContain("has rotated")
    expect(outcome.step.failure).toMatchObject({ reason: "permission-denied", retryAfterMillis: 0 })
    expect(outcome.step.attempts).toBe(retryPolicy.maxAttempts)
    expect(tokenRequests().map((request) => form(request).get("refresh_token"))).toEqual([
      REFRESH,
      "elsewhere-1",
      "elsewhere-2",
      "elsewhere-3"
    ])
    const text = JSON.stringify({ direct: outcome.direct.message, details: outcome.direct.details, step: outcome.step })
    for (const token of [REFRESH, "elsewhere-3", "elsewhere-4"]) expect(text).not.toContain(token)
  })

  it("refuses a caller the credential policy denies as permission-denied", async () => {
    await mintingEndpoint()
    const error = await withCredentials(
      (credentials) =>
        Effect.gen(function*() {
          const source = yield* OAuthToken.make(
            endpoint({ refreshToken: OAuthToken.credentialStore(credentials, REFERENCE) })
          )
          return yield* Effect.flip(source.token)
        }),
      {
        authorize: (operation) =>
          operation === "resolve"
            ? Effect.fail(new Unauthorized({ message: "denied" }))
            : Effect.void
      }
    )
    expect(error.reason).toBe("permission-denied")
    expect(tokenRequests()).toHaveLength(0)
  })

  it("reports missing credential storage as credentials-missing", async () => {
    await mintingEndpoint()
    const source = sourceOf(
      endpoint({ refreshToken: OAuthToken.credentialStore(Credential.makeNoop(), REFERENCE) })
    )
    const error = await failure(source.token)
    expect(error.reason).toBe("credentials-missing")
    expect(error.summary).toContain(REFERENCE.name)
  })

  it("surfaces a store failure while persisting a rotation", async () => {
    fixture = await startFixture((_request, response) =>
      json(response, 200, { access_token: "access", expires_in: 3600, refresh_token: "rotated" })
    )
    const store: OAuthToken.RefreshTokenStore = {
      load: Effect.succeed(Redacted.make(REFRESH)),
      replace: () => Effect.fail(new IntegrationError("credentials-missing", "no storage", { retryable: false }))
    }
    const error = await failure(tokenOf(endpoint({ refreshToken: store })))
    expect(error.reason).toBe("credentials-missing")
    expect(error.summary).toBe("no storage")
  })
})

describe("OAuthToken code exchange", () => {
  it("redeems a code with its verifier and returns both tokens", async () => {
    fixture = await startFixture((_request, response) =>
      json(response, 200, {
        access_token: "access-first",
        expires_in: 3599,
        refresh_token: "refresh-first",
        scope: "https://www.googleapis.com/auth/calendar.events",
        token_type: "Bearer"
      })
    )
    const grant = await Effect.runPromise(Effect.provide(
      OAuthToken.exchangeCode({
        tokenUrl: `${fixture.origin}/token`,
        clientId: "client-id",
        clientSecret: Redacted.make(SECRET),
        code: Redacted.make("code-fixture"),
        redirectUri: "http://127.0.0.1/callback",
        codeVerifier: Redacted.make("verifier-fixture")
      }),
      fetchLayer
    ))
    expect(value(grant.accessToken)).toBe("access-first")
    expect(grant.refreshToken === null ? null : value(grant.refreshToken)).toBe("refresh-first")
    expect(grant.expiresInSeconds).toBe(3599)
    expect(grant.scope).toBe("https://www.googleapis.com/auth/calendar.events")
    expect(Object.fromEntries(form(tokenRequests()[0] as Recorded))).toEqual({
      grant_type: "authorization_code",
      code: "code-fixture",
      redirect_uri: "http://127.0.0.1/callback",
      code_verifier: "verifier-fixture",
      client_id: "client-id",
      client_secret: SECRET
    })
  })

  it("does not present a code again after a lost answer", async () => {
    fixture = await startFixture((_request, response) => json(response, 502, { error: "server_error" }))
    const error = await failure(OAuthToken.exchangeCode({
      tokenUrl: `${fixture.origin}/token`,
      clientId: "client-id",
      code: Redacted.make("code-fixture"),
      redirectUri: "http://127.0.0.1/callback"
    }))
    expect(error.reason).toBe("delivery-failed")
    expect(error.details?.["outcomeUnknown"]).toBe(true)
    expect(error.details?.["retryable"]).toBe(false)
    expect(tokenRequests()).toHaveLength(1)
    expect(JSON.stringify(error.details)).not.toContain("code-fixture")
  })

  it("reports a stalled or unreachable endpoint as an unknown outcome", async () => {
    fixture = await startFixture(() => {
      // Never answers.
    })
    const stalled = await failure(OAuthToken.exchangeCode({
      tokenUrl: `${fixture.origin}/token`,
      clientId: "client-id",
      code: Redacted.make("code-fixture"),
      redirectUri: "http://127.0.0.1/callback",
      requestTimeout: "100 millis"
    }))
    expect(stalled.details?.["outcomeUnknown"]).toBe(true)
    expect(stalled.details?.["timedOut"]).toBe(true)
    const origin = fixture.origin
    await fixture.close()
    fixture = undefined
    const refused = await failure(OAuthToken.exchangeCode({
      tokenUrl: `${origin}/token`,
      clientId: "client-id",
      code: Redacted.make("code-fixture"),
      redirectUri: "http://127.0.0.1/callback"
    }))
    expect(refused.details?.["outcomeUnknown"]).toBe(true)
  })

  it("fails an invalid endpoint as a typed error rather than a defect", async () => {
    const error = await failure(OAuthToken.exchangeCode({
      tokenUrl: "not a url",
      clientId: "client-id",
      code: Redacted.make("code-fixture"),
      redirectUri: "http://127.0.0.1/callback"
    }))
    expect(error.reason).toBe("invalid-config")
  })

  it("reports a used code GitHub answers with 200 as permission-denied", async () => {
    fixture = await startFixture((_request, response) => json(response, 200, { error: "bad_verification_code" }))
    const error = await failure(OAuthToken.exchangeCode({
      tokenUrl: `${fixture.origin}/token`,
      clientId: "client-id",
      code: Redacted.make("code-fixture"),
      redirectUri: "http://127.0.0.1/callback"
    }))
    expect(error.reason).toBe("permission-denied")
    expect(error.details?.["oauthError"]).toBe("bad_verification_code")
    expect(JSON.stringify(error.details)).not.toContain("code-fixture")
  })
})

describe("OAuthToken one refresh", () => {
  const exchange = (extra: Partial<OAuthToken.RefreshExchange> = {}): OAuthToken.RefreshExchange => ({
    tokenUrl: `${(fixture as Fixture).origin}/token`,
    clientId: "client-id",
    clientSecret: Redacted.make(SECRET),
    refreshToken: Redacted.make(REFRESH),
    ...extra
  })

  it("trades the refresh token once and returns the whole grant, rotation included", async () => {
    fixture = await startFixture((_request, response) =>
      json(response, 200, { access_token: "access-next", expires_in: 28800, refresh_token: "refresh-next" })
    )
    const grant = await Effect.runPromise(Effect.provide(OAuthToken.exchangeRefreshToken(exchange()), fetchLayer))
    expect(value(grant.accessToken)).toBe("access-next")
    expect(grant.expiresInSeconds).toBe(28800)
    expect(grant.refreshToken === null ? null : value(grant.refreshToken)).toBe("refresh-next")
    expect(Object.fromEntries(form(tokenRequests()[0] as Recorded))).toEqual({
      grant_type: "refresh_token",
      refresh_token: REFRESH,
      client_id: "client-id",
      client_secret: SECRET
    })
  })

  it("narrows the grant to the scopes asked for", async () => {
    fixture = await startFixture((_request, response) => json(response, 200, { access_token: "access-next" }))
    await Effect.runPromise(
      Effect.provide(OAuthToken.exchangeRefreshToken(exchange({ scopes: ["a", "b"] })), fetchLayer)
    )
    expect(form(tokenRequests()[0] as Recorded).get("scope")).toBe("a b")
  })

  it("does not present a single-use refresh token again after a lost answer", async () => {
    fixture = await startFixture((_request, response) => json(response, 502, { error: "server_error" }))
    const error = await failure(OAuthToken.exchangeRefreshToken(exchange()))
    expect(error.reason).toBe("delivery-failed")
    expect(error.details?.["outcomeUnknown"]).toBe(true)
    expect(tokenRequests()).toHaveLength(1)
    expect(JSON.stringify(error.details)).not.toContain(REFRESH)
  })

  it("reports an expired refresh token as permission-denied, without its value", async () => {
    fixture = await startFixture((_request, response) => json(response, 200, { error: "bad_refresh_token" }))
    const error = await failure(OAuthToken.exchangeRefreshToken(exchange()))
    expect(error.reason).toBe("permission-denied")
    expect(`${error.message} ${JSON.stringify(error.details)}`).not.toContain(REFRESH)
  })

  it("fails an invalid endpoint as a typed error rather than a defect", async () => {
    const error = await failure(OAuthToken.exchangeRefreshToken({
      tokenUrl: "not a url",
      clientId: "client-id",
      refreshToken: Redacted.make(REFRESH)
    }))
    expect(error.reason).toBe("invalid-config")
  })
})

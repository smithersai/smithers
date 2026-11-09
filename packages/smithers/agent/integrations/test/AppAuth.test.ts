/**
 * A GitHub App's authentication against a fake GitHub on a real socket.
 *
 * The key is a real RSA key WebCrypto generates per run. The PKCS#1 form is
 * built by `node:crypto`, an implementation independent of the one under
 * test, and the fake verifies every JWT it receives with the public key, so
 * a JWT GitHub would refuse is refused here too.
 */
import { Effect, Exit, Layer, Redacted, Tracer } from "effect"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientResponse from "effect/http/HttpClientResponse"
import * as TestClock from "effect/testing/TestClock"
import { createPrivateKey } from "node:crypto"
import { inspect } from "node:util"
import { afterEach, beforeAll, describe, expect, it } from "vitest"
import type { IntegrationError } from "../src/core/IntegrationError.ts"
import * as AppAuth from "../src/github/AppAuth.vibe"
import { type Fixture, json, startFixture } from "./Fixture.ts"
import { faultingTransport, fetchLayer } from "./Http.ts"

const APP_ID = "424242"
const MINTED = "ghs_MINTED_SENTINEL_0123456789"

let fixture: Fixture | undefined

afterEach(async () => {
  await fixture?.close()
  fixture = undefined
})

const pem = (label: string, der: Uint8Array): string => {
  const body = Buffer.from(der).toString("base64").match(/.{1,64}/g)!.join("\n")
  return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----\n`
}

const generate = async () => {
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"]
  )
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey))
  const pkcs8Pem = pem("PRIVATE KEY", pkcs8)
  const pkcs1Pem = createPrivateKey({ key: Buffer.from(pkcs8), format: "der", type: "pkcs8" })
    .export({ type: "pkcs1", format: "pem" }) as string
  return { publicKey: pair.publicKey, pkcs8Pem, pkcs1Pem }
}

let key: Awaited<ReturnType<typeof generate>>
let otherKey: Awaited<ReturnType<typeof generate>>

beforeAll(async () => {
  ;[key, otherKey] = await Promise.all([generate(), generate()])
})

const decodeSegment = (segment: string): Record<string, unknown> =>
  JSON.parse(Buffer.from(segment, "base64url").toString("utf8"))

interface Verified {
  readonly header: Record<string, unknown>
  readonly claims: Record<string, unknown>
  readonly valid: boolean
}

const verifyJwt = async (jwt: string, publicKey: CryptoKey): Promise<Verified> => {
  const [header, payload, signature] = jwt.split(".") as [string, string, string]
  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    publicKey,
    Buffer.from(signature, "base64url"),
    new TextEncoder().encode(`${header}.${payload}`)
  )
  return { header: decodeSegment(header), claims: decodeSegment(payload), valid }
}

/** A fake GitHub that admits only a JWT signed by `key` with GitHub's claim rules. */
const startGitHub = () =>
  startFixture(async (request, response) => {
    const authorization = request.headers["authorization"] ?? ""
    const jwt = authorization.replace(/^Bearer /, "")
    const { claims, header, valid } = await verifyJwt(jwt, key.publicKey).catch((): Verified => ({
      header: {},
      claims: {},
      valid: false
    }))
    const now = Math.floor(Date.now() / 1000)
    const iat = Number(claims["iat"])
    const exp = Number(claims["exp"])
    if (
      !valid || header["alg"] !== "RS256" || claims["iss"] !== APP_ID || iat > now || exp <= now || exp - iat > 600
    ) {
      // GitHub does not echo the credential; this fake does, so the test can
      // prove the client never repeats it.
      return json(response, 401, { message: `Bad credentials: ${authorization}` })
    }
    const path = new URL(request.url, "http://github.test").pathname
    if (request.method === "GET" && path === "/repos/o/r/installation") {
      return json(response, 200, { id: 77, app_id: 424242, account: { login: "o" }, permissions: { issues: "write" } })
    }
    if (request.method === "GET" && path === "/repos/o/odd/installation") return json(response, 200, { id: "77" })
    if (request.method === "POST" && path === "/app/installations/77/access_tokens") {
      return json(response, 201, {
        token: MINTED,
        expires_at: "2026-10-20T13:00:00Z",
        permissions: { issues: "write" },
        repository_selection: "selected"
      })
    }
    if (request.method === "POST" && path === "/app/installations/78/access_tokens") {
      return json(response, 201, { token: MINTED, expires_at: "soon" })
    }
    if (request.method === "POST" && path === "/app/installations/79/access_tokens") {
      return json(response, 201, { token: MINTED })
    }
    json(response, 404, { message: "Not Found", documentation_url: "https://docs.github.com/rest" })
  })

const credentials = (overrides: Partial<AppAuth.AppCredentials> = {}): AppAuth.AppCredentials => ({
  appId: APP_ID,
  privateKey: Redacted.make(key.pkcs1Pem),
  ...(fixture === undefined ? {} : { apiBaseUrl: fixture.origin }),
  ...overrides
})

const run = <A>(effect: Effect.Effect<A, IntegrationError, HttpClient.HttpClient>): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.provide(fetchLayer)))

const failure = <A>(effect: Effect.Effect<A, IntegrationError, HttpClient.HttpClient>): Promise<IntegrationError> =>
  Effect.runPromise(Effect.flip(effect).pipe(Effect.provide(fetchLayer)))

const app = (overrides?: Partial<AppAuth.AppCredentials>) => run(AppAuth.make(credentials(overrides)))

/** Everything an error carries that a log or journal could print. */
const everything = (error: IntegrationError): string =>
  [error.message, JSON.stringify(error.details), String(error.cause), inspect(error, { depth: null })].join("\n")

const keyBody = (text: string): string => text.replace(/-----[A-Z ]+-----/g, "").replace(/\s+/g, "")

describe("importPrivateKey", () => {
  it.each([
    ["PKCS#1, as GitHub downloads it", () => key.pkcs1Pem],
    ["PKCS#8", () => key.pkcs8Pem],
    ["PKCS#1 with escaped newlines, as an env var carries it", () => key.pkcs1Pem.replace(/\n/g, "\\n")],
    ["PKCS#8 with escaped CRLF newlines", () => key.pkcs8Pem.replace(/\n/g, "\\r\\n")],
    ["PKCS#1 with surrounding quotes and CRLF", () => `"${key.pkcs1Pem.replace(/\n/g, "\r\n")}"`]
  ])("imports %s as a non-extractable RS256 signing key that verifies", async (_name, text) => {
    const imported = await Effect.runPromise(AppAuth.importPrivateKey(Redacted.make(text())))
    expect(imported.type).toBe("private")
    expect(imported.extractable).toBe(false)
    expect(imported.usages).toEqual(["sign"])
    expect(imported.algorithm).toMatchObject({ name: "RSASSA-PKCS1-v1_5", hash: { name: "SHA-256" } })
    const data = new TextEncoder().encode("signed")
    const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", imported, data)
    expect(await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key.publicKey, signature, data)).toBe(true)
  })

  const SENTINEL = "SENTINELKEYMATERIAL"
  const sentinelBase64 = Buffer.from(SENTINEL).toString("base64")

  const refusals: ReadonlyArray<readonly [string, () => string, string]> = [
    ["text that is not PEM", () => `${SENTINEL} not a key`, "is not a PEM private key"],
    [
      "an encrypted PKCS#8 key",
      () => `-----BEGIN ENCRYPTED PRIVATE KEY-----\n${sentinelBase64}\n-----END ENCRYPTED PRIVATE KEY-----`,
      "is not a PEM private key"
    ],
    [
      "mismatched BEGIN and END labels",
      () => `-----BEGIN RSA PRIVATE KEY-----\n${sentinelBase64}\n-----END PRIVATE KEY-----`,
      "is not a PEM private key"
    ],
    [
      "a body that is not base64",
      () => `-----BEGIN RSA PRIVATE KEY-----\n!${SENTINEL}!\n-----END RSA PRIVATE KEY-----`,
      "is not base64"
    ],
    [
      "a PKCS#8 body that is not a key",
      () => `-----BEGIN PRIVATE KEY-----\n${sentinelBase64}\n-----END PRIVATE KEY-----`,
      "did not import"
    ],
    [
      "a short PKCS#1 body that is not a key",
      () => `-----BEGIN RSA PRIVATE KEY-----\n${sentinelBase64}\n-----END RSA PRIVATE KEY-----`,
      "did not import"
    ],
    [
      "a long PKCS#1 body that is not a key",
      () =>
        `-----BEGIN RSA PRIVATE KEY-----\n${
          Buffer.from(SENTINEL.repeat(20)).toString("base64")
        }\n-----END RSA PRIVATE KEY-----`,
      "did not import"
    ],
    ["a PKCS#8 key labeled PKCS#1", () => key.pkcs8Pem.replace(/PRIVATE KEY/g, "RSA PRIVATE KEY"), "did not import"]
  ]

  it.each(refusals)("refuses %s with invalid-config, never echoing the key", async (_name, text, expected) => {
    const material = text()
    const error = await Effect.runPromise(Effect.flip(AppAuth.importPrivateKey(Redacted.make(material))))
    expect(error.reason).toBe("invalid-config")
    expect(error.message).toContain(expected)
    expect(error.details?.["retryable"]).toBe(false)
    const printed = everything(error)
    expect(printed).not.toContain(SENTINEL)
    expect(printed).not.toContain(sentinelBase64)
    if (material.includes("-----BEGIN")) expect(printed).not.toContain(keyBody(material).slice(0, 40))
  })
})

describe("make", () => {
  it.each([
    ["an empty app ID", { appId: "  " }],
    ["an app ID with a space", { appId: "42 42" }],
    ["an app ID that is not a string", { appId: 424242 as unknown as string }]
  ])("refuses %s", async (_name, overrides) => {
    const error = await failure(AppAuth.make(credentials(overrides)))
    expect(error.reason).toBe("invalid-config")
    expect(error.message).toContain("App ID")
  })

  it("refuses a garbage private key without echoing it", async () => {
    const error = await failure(AppAuth.make(credentials({ privateKey: Redacted.make("hunter2-private") })))
    expect(error.reason).toBe("invalid-config")
    expect(everything(error)).not.toContain("hunter2-private")
  })

  it("refuses a malformed apiBaseUrl before any call", async () => {
    const error = await failure(AppAuth.make(credentials({ apiBaseUrl: "ftp://github.test" })))
    expect(error.reason).toBe("invalid-config")
    expect(error.message).toContain("apiBaseUrl")
  })
})

describe("jwt", () => {
  it("signs RS256 with iat 60 s back, exp 9 minutes ahead and iss the app ID, on the Clock service's time", async () => {
    const now = Date.UTC(2026, 9, 20, 12, 0, 0, 750)
    const service = await run(AppAuth.make(credentials({ privateKey: Redacted.make(key.pkcs8Pem) })))
    const token = await Effect.runPromise(
      TestClock.setTime(now).pipe(Effect.andThen(service.jwt), Effect.provide(TestClock.layer()))
    )
    const { claims, header, valid } = await verifyJwt(Redacted.value(token), key.publicKey)
    expect(valid).toBe(true)
    expect(header).toEqual({ alg: "RS256", typ: "JWT" })
    const seconds = Math.floor(now / 1000)
    expect(claims).toEqual({ iat: seconds - 60, exp: seconds + 540, iss: APP_ID })
    expect((claims["exp"] as number) - (claims["iat"] as number)).toBeLessThanOrEqual(600)
    expect(String(token)).not.toContain(Redacted.value(token))
  })

  it("is signed by the key it was given: another key's public half does not verify it", async () => {
    const service = await app()
    const token = await Effect.runPromise(service.jwt)
    expect((await verifyJwt(Redacted.value(token), key.publicKey)).valid).toBe(true)
    expect((await verifyJwt(Redacted.value(token), otherKey.publicKey)).valid).toBe(false)
  })
})

describe("installation", () => {
  it("finds the installation covering a repository, calling as the App", async () => {
    fixture = await startGitHub()
    const service = await app()
    expect(await Effect.runPromise(service.installation("o", "r"))).toEqual({ id: 77 })
    const request = fixture.requests[0]!
    expect(request.method).toBe("GET")
    expect(request.url).toBe("/repos/o/r/installation")
    expect(request.headers["authorization"]).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/)
  })

  it("is served by the layer under the AppAuth tag", async () => {
    fixture = await startGitHub()
    const found = await Effect.runPromise(
      Effect.gen(function*() {
        const service = yield* AppAuth.AppAuth
        return yield* service.installation("o", "r")
      }).pipe(Effect.provide(AppAuth.layer(credentials()).pipe(Layer.provide(fetchLayer))))
    )
    expect(found).toEqual({ id: 77 })
  })

  it("reports an App that is not installed as delivery-failed 404, not retryable", async () => {
    fixture = await startGitHub()
    const service = await app()
    const error = await Effect.runPromise(Effect.flip(service.installation("o", "missing")))
    expect(error.reason).toBe("delivery-failed")
    expect(error.message).toContain("not installed on o/missing")
    expect(error.details).toMatchObject({ status: 404, retryable: false, installed: false, owner: "o" })
  })

  it("passes any other refusal through, without the JWT anywhere in it", async () => {
    fixture = await startGitHub()
    const service = await app({ privateKey: Redacted.make(otherKey.pkcs8Pem) })
    const error = await Effect.runPromise(Effect.flip(service.installation("o", "r")))
    expect(error.reason).toBe("delivery-failed")
    expect(error.details).toMatchObject({ status: 401, retryable: false })
    expect(error.details?.["installed"]).toBeUndefined()
    const jwt = fixture.requests[0]!.headers["authorization"]!.replace(/^Bearer /, "")
    expect(error.message).toContain("[REDACTED]")
    expect(everything(error)).not.toContain(jwt)
  })

  it("fails decode-failed when GitHub's answer does not fit", async () => {
    fixture = await startGitHub()
    const error = await Effect.runPromise(Effect.flip((await app()).installation("o", "odd")))
    expect(error.reason).toBe("decode-failed")
  })

  it("validates the repository coordinates before calling", async () => {
    fixture = await startGitHub()
    const error = await Effect.runPromise(Effect.flip((await app()).installation("..", "r")))
    expect(error.reason).toBe("invalid-config")
    expect(fixture.requests).toHaveLength(0)
  })
})

describe("installationToken", () => {
  it("mints a token narrowed to repositories and permissions", async () => {
    fixture = await startGitHub()
    const service = await app()
    const minted = await Effect.runPromise(service.installationToken({
      installationId: 77,
      repositories: ["r"],
      repositoryIds: [1296269],
      permissions: { issues: "write", metadata: "read" }
    }))
    expect(Redacted.value(minted.token)).toBe(MINTED)
    expect(String(minted.token)).not.toContain(MINTED)
    expect(minted.expiresAt).toBe(Date.parse("2026-10-20T13:00:00Z"))
    const request = fixture.requests[0]!
    expect(request.method).toBe("POST")
    expect(request.url).toBe("/app/installations/77/access_tokens")
    expect(JSON.parse(request.body)).toEqual({
      repositories: ["r"],
      repository_ids: [1296269],
      permissions: { issues: "write", metadata: "read" }
    })
  })

  it("sends an empty body when nothing narrows the token", async () => {
    fixture = await startGitHub()
    await Effect.runPromise((await app()).installationToken({ installationId: 77 }))
    expect(JSON.parse(fixture.requests[0]!.body)).toEqual({})
  })

  it.each([
    ["an expires_at that is not a time", 78],
    ["a missing expires_at", 79]
  ])("fails decode-failed on %s without quoting the token", async (_name, installationId) => {
    fixture = await startGitHub()
    const error = await Effect.runPromise(Effect.flip((await app()).installationToken({ installationId })))
    expect(error.reason).toBe("decode-failed")
    expect(error.details).toMatchObject({ installationId, retryable: false })
    expect(everything(error)).not.toContain(MINTED)
  })

  it("reports a lost answer as retryable, since minting again is harmless", async () => {
    fixture = await startGitHub()
    const { handled, transport } = faultingTransport(({ method }) =>
      method === "POST" ? { status: 502, body: { message: "Bad Gateway" } } : undefined
    )
    const service = await Effect.runPromise(
      AppAuth.make(credentials()).pipe(Effect.provideService(HttpClient.HttpClient, transport))
    )
    const error = await Effect.runPromise(Effect.flip(service.installationToken({ installationId: 77 })))
    expect(error.details).toMatchObject({ status: 502, retryable: true, outcomeUnknown: true })
    expect(handled).toHaveLength(1)
  })

  it("passes GitHub's refusal through", async () => {
    fixture = await startGitHub()
    const error = await Effect.runPromise(Effect.flip((await app()).installationToken({ installationId: 5 })))
    expect(error.reason).toBe("delivery-failed")
    expect(error.details).toMatchObject({ status: 404, method: "POST" })
  })

  it.each([
    ["a zero installation ID", { installationId: 0 }, "installation ID"],
    ["a fractional installation ID", { installationId: 1.5 }, "installation ID"],
    ["a repository name that is not one", { installationId: 77, repositories: ["r", "../x"] }, "repository name"],
    ["a repository ID that is not one", { installationId: 77, repositoryIds: [1, -2] }, "repository ID"]
  ])("refuses %s before calling", async (_name, options, expected) => {
    fixture = await startGitHub()
    const error = await Effect.runPromise(Effect.flip((await app()).installationToken(options)))
    expect(error.reason).toBe("invalid-config")
    expect(error.message).toContain(expected)
    expect(fixture.requests).toHaveLength(0)
  })

  it("records spans with no key, JWT or token in their attributes", async () => {
    fixture = await startGitHub()
    const service = await app()
    const spans: Array<Tracer.NativeSpan> = []
    const tracer = Tracer.make({
      span(options) {
        const span = new Tracer.NativeSpan(options)
        spans.push(span)
        return span
      }
    })
    const exit = await Effect.runPromise(Effect.exit(
      service.installation("o", "r").pipe(
        Effect.flatMap(({ id }) =>
          service.installationToken({ installationId: id, repositories: ["r"], permissions: { issues: "write" } })
        ),
        Effect.provideService(Tracer.Tracer, tracer)
      )
    ))
    expect(Exit.isSuccess(exit)).toBe(true)
    const names = spans.map((span) => span.name)
    expect(names).toEqual(expect.arrayContaining([
      "GitHub.AppAuth.jwt",
      "GitHub.AppAuth.installation",
      "GitHub.AppAuth.installationToken"
    ]))
    const minting = spans.find((span) => span.name === "GitHub.AppAuth.installationToken")!
    expect(minting.attributes.get("github.installation_id")).toBe(77)
    expect(minting.attributes.get("github.repository_count")).toBe(1)
    const jwts = fixture.requests.map((request) => request.headers["authorization"]!.replace(/^Bearer /, ""))
    for (const span of spans) {
      const attributes = JSON.stringify([...span.attributes.entries()])
      expect(attributes).not.toContain(MINTED)
      for (const jwt of jwts) expect(attributes).not.toContain(jwt)
      expect(attributes).not.toContain(keyBody(key.pkcs1Pem).slice(0, 40))
    }
  })
})

describe("over the HttpClient in context", () => {
  // The App's calls carry its JWT, so an ambient base URL must not choose where
  // they go: the client is built with an empty environment.
  it("never lets an ambient SMITHERS_GITHUB_API_BASE_URL redirect the JWT", async () => {
    const urls: Array<string> = []
    const recording = HttpClient.make((request) =>
      Effect.sync(() => {
        urls.push(request.url)
        return HttpClientResponse.fromWeb(
          request,
          new Response(JSON.stringify({ id: 9 }), { status: 200, headers: { "content-type": "application/json" } })
        )
      })
    )
    const previous = process.env["SMITHERS_GITHUB_API_BASE_URL"]
    process.env["SMITHERS_GITHUB_API_BASE_URL"] = "http://127.0.0.1:9"
    try {
      const found = await Effect.runPromise(
        Effect.flatMap(
          AppAuth.make({ appId: APP_ID, privateKey: Redacted.make(key.pkcs1Pem) }),
          (service) => service.installation("o", "r")
        ).pipe(Effect.provideService(HttpClient.HttpClient, recording))
      )
      expect(found).toEqual({ id: 9 })
    } finally {
      if (previous === undefined) delete process.env["SMITHERS_GITHUB_API_BASE_URL"]
      else process.env["SMITHERS_GITHUB_API_BASE_URL"] = previous
    }
    expect(urls).toEqual(["https://api.github.com/repos/o/r/installation"])
  })
})

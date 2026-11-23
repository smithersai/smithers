import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Effect, Layer, Logger, Redacted, Result, Schema, Stream } from "effect"
import { HttpClient, HttpClientResponse, HttpServerRequest } from "effect/http"
import { describe, expect, it } from "vitest"
import { Binding, Egress, Placeholder, Scrub } from "../src/index.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "800" : "200"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261122")
const silentLogger = Logger.layer([])

describe("@smthrs/secrets comprehensive fuzz security invariants", () => {
  it("Binding.isHost, Binding schema, and checkValue enforce strict DNS & printable ASCII rules", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        host: Schema.Union([
          Schema.String.pipe(Schema.check(Schema.isMaxLength(64))),
          Schema.Literals([
            "api.example.com",
            "localhost",
            "127.0.0.1",
            "*.example.com",
            "API.EXAMPLE.COM",
            "a.b",
            "a".repeat(260) + ".com",
            "bad_host.example.com"
          ])
        ]),
        secretVal: Schema.Union([
          Schema.String.pipe(Schema.check(Schema.isMaxLength(40))),
          Schema.Literals([
            "short",
            " valid_secret_1234",
            "valid_secret_1234 ",
            "secret\nwith\rcontrol",
            "secret_non_ascii_é",
            "secret_\ud800_bad",
            "a".repeat(17_000),
            "valid_secret_token_99999"
          ])
        ]),
        name: Schema.Literals(["API_KEY", "bad-name", "1BAD", "_OK_123"])
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ host, secretVal, name }) =>
          Effect.gen(function*() {
            const hostOk = Binding.isHost(host)
            if (hostOk) {
              if (host.length > 253 || !host.includes(".") || host !== host.toLowerCase()) return false
              if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return false
            }
            const problem = Binding.valueProblem(secretVal)
            const checked = yield* Effect.result(Binding.checkValue(Redacted.make(secretVal)))
            if (problem === undefined) {
              if (Result.isFailure(checked)) return false
              if (secretVal.length < Binding.minimumValueBytes || secretVal.length > Binding.maximumValueBytes) {
                return false
              }
            } else {
              if (Result.isSuccess(checked) || checked.failure.reason !== problem) return false
            }
            const bindingRes = Schema.decodeUnknownResult(Binding.Binding)({
              name,
              hosts: [host],
              methods: ["POST"]
            })
            if (Result.isSuccess(bindingRes)) {
              if (!hostOk || !/^[A-Z_][A-Z0-9_]{0,63}$/.test(name)) return false
            }
            return true
          }),
        { seed, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("Scrub removes all raw/base64/url-encoded forms across text and arbitrary byte stream chunking", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        secret: Schema.String.pipe(Schema.check(Schema.isPattern(/^[a-zA-Z0-9_-]{12,28}$/))),
        prefix: Schema.String.pipe(Schema.check(Schema.isMaxLength(40))),
        suffix: Schema.String.pipe(Schema.check(Schema.isMaxLength(40))),
        chunkSize: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 19 }))),
        encodeKind: Schema.Literals(["raw", "b64", "url"])
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ secret, prefix, suffix, chunkSize, encodeKind }) =>
          Effect.gen(function*() {
            const scrubber = Scrub.make([{ replacement: "[REDACTED:API_KEY]", value: Redacted.make(secret) }])
            const encoded = encodeKind === "raw"
              ? secret
              : encodeKind === "b64"
              ? Buffer.from(secret, "utf8").toString("base64")
              : encodeURIComponent(secret)
            const payload = `${prefix}${encoded}${suffix}`
            const scrubbedText = scrubber.text(payload)
            if (scrubbedText.includes(secret) || scrubbedText.includes(encoded)) return false

            const rawBytes = new TextEncoder().encode(payload)
            const chunks: Array<Uint8Array> = []
            for (let i = 0; i < rawBytes.length; i += chunkSize) {
              chunks.push(rawBytes.slice(i, i + chunkSize))
            }
            const outChunks = yield* Stream.runCollect(scrubber.stream(Stream.fromIterable(chunks)))
            const totalLen = outChunks.reduce((acc, c) => acc + c.byteLength, 0)
            const merged = new Uint8Array(totalLen)
            let off = 0
            for (const c of outChunks) {
              merged.set(c, off)
              off += c.byteLength
            }
            const outText = new TextDecoder().decode(merged)
            return !outText.includes(secret) && !outText.includes(encoded)
          }),
        { seed: seed + 1, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("Placeholder minter rejects short keys and emits opaque, deterministic, secret-free tokens", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        key: Schema.String.pipe(Schema.check(Schema.isMaxLength(64))),
        scope: Schema.String.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(24))),
        name: Schema.String.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(24)))
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ key, scope, name }) =>
          Effect.gen(function*() {
            const minted = yield* Effect.result(Placeholder.minter(Redacted.make(key)))
            if (key.length < 32) return Result.isFailure(minted)
            if (Result.isFailure(minted)) return false
            const p1 = yield* minted.success.derive(scope, name)
            const p2 = yield* minted.success.derive(scope, name)
            if (p1 !== p2 || !Placeholder.is(p1) || Placeholder.find(`x ${p1} y`).length !== 1) return false
            if (p1.includes(key)) return false
            return true
          }),
        { seed: seed + 2, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("Egress.decide & Egress.forward substitute secrets ONLY on bound HTTPS host/method, scrub echoes, and fail closed on vault/audit/upstream faults", async () => {
    const minter = await Effect.runPromise(Placeholder.minter(Redacted.make("a".repeat(48))))
    const placeholder = await Effect.runPromise(minter.derive("repo-1", "API_KEY"))
    const unknownPlaceholder = await Effect.runPromise(minter.derive("repo-1", "OTHER_KEY"))
    const secretPlain = "sk_live_REAL_SECRET_VALUE_987654321"
    const policy: Egress.Policy = {
      allow: ["api.example.com", "public.example.com"],
      secrets: [
        {
          name: "API_KEY",
          placeholder,
          hosts: ["api.example.com"],
          methods: ["POST"]
        }
      ]
    }
    const arb = Arbitrary.schema(
      Schema.Struct({
        scheme: Schema.Literals(["https:", "http:", "ftp:"]),
        host: Schema.Literals(["api.example.com", "public.example.com", "evil.example.com"]),
        port: Schema.Literals(["", ":443", ":8080"]),
        userinfo: Schema.Literals(["", "user:pass@"]),
        method: Schema.Literals(["GET", "POST", "HEAD", "DELETE"]),
        headerVal: Schema.Literals(["plain", `Bearer ${placeholder}`, `Bearer ${unknownPlaceholder}`]),
        fault: Schema.Literals(["none", "vaultFail", "auditFail", "upstreamFail", "status204", "echoSecret"])
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ scheme, host, port, userinfo, method, headerVal, fault }) =>
          Effect.gen(function*() {
            const url = `${scheme}//${userinfo}${host}${port}/v1/test`
            const decision = Egress.decide({ method, url, headers: { authorization: headerVal } }, policy)
            const hasKnown = headerVal.includes(placeholder)
            const hasUnknown = headerVal.includes(unknownPlaceholder)
            const nonDefaultPort = port !== "" && !(scheme === "https:" && port === ":443")

            if (decision._tag === "Allowed") {
              if (userinfo !== "" || nonDefaultPort) return false
              if (scheme !== "https:" && scheme !== "http:") return false
              if (host === "evil.example.com" || hasUnknown) return false
              if (hasKnown && (scheme !== "https:" || host !== "api.example.com" || method !== "POST")) return false
            }

            let seenAuth: string | undefined
            let upstreamCalled = false
            const fakeClient = HttpClient.make((req) => {
              upstreamCalled = true
              seenAuth = req.headers["authorization"]
              if (fault === "upstreamFail") {
                return Effect.fail(new Error("upstream down") as never)
              }
              const status = fault === "status204" ? 204 : 200
              const bodyText = status === 204 ? null : fault === "echoSecret" ? `echo:${secretPlain}` : "ok"
              return Effect.succeed(
                HttpClientResponse.fromWeb(
                  req,
                  new Response(bodyText, {
                    status,
                    headers: {
                      "x-echo": fault === "echoSecret" ? secretPlain : "clean",
                      "set-cookie": "drop-me=1"
                    }
                  })
                )
              )
            })
            const fakeVault = Layer.succeed(Egress.Vault, {
              reveal: () =>
                fault === "vaultFail"
                  ? Effect.fail(new Egress.SecretUnavailable({ name: "API_KEY" }))
                  : Effect.succeed(Redacted.make(secretPlain))
            })
            const fakeAudit = Layer.succeed(Egress.Audit, {
              record: () => fault === "auditFail" ? Effect.fail(new Egress.AuditUnavailable({})) : Effect.void
            })

            if (userinfo !== "" || scheme === "ftp:") return decision._tag === "Denied"
            const webReq = new Request(url, {
              method,
              headers: { authorization: headerVal },
              ...(method === "POST" || method === "DELETE" ? { body: "payload" } : {})
            })
            const serverReq = HttpServerRequest.fromWeb(webReq)
            const resp = yield* Egress.forward(serverReq, policy).pipe(
              Effect.provide(
                Layer.mergeAll(
                  Layer.succeed(HttpClient.HttpClient, fakeClient),
                  fakeVault,
                  fakeAudit,
                  silentLogger
                )
              )
            )

            // If refused, upstream MUST NEVER be called
            if (decision._tag === "Denied") {
              if (upstreamCalled) return false
              return resp.status === Egress.refusals[decision.code]
            }
            if (fault === "vaultFail") return !upstreamCalled && resp.status === 503
            if (fault === "auditFail") return !upstreamCalled && resp.status === 503
            if (fault === "upstreamFail") return resp.status === 502

            // Substitution check
            if (hasKnown && seenAuth !== `Bearer ${secretPlain}`) return false
            if (!hasKnown && seenAuth !== headerVal) return false

            // Scrubbing check: secret MUST NEVER appear in response headers or body!
            for (const val of Object.values(resp.headers)) {
              if (hasKnown && String(val).includes(secretPlain)) return false
            }
            if (resp.body._tag === "Stream") {
              const chunks = yield* Stream.runCollect(resp.body.stream)
              const txt = chunks.map((c) => new TextDecoder().decode(c)).join("")
              if (hasKnown && txt.includes(secretPlain)) return false
            }
            return true
          }),
        { seed: seed + 3, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })
})

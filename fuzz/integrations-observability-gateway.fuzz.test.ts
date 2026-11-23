import { RunTrace } from "@smthrs/gateway"
import { Core as IntegrationCore, GitHub as IntegrationGitHub, Telegram as IntegrationTelegram } from "@smthrs/integrations"
import { Endpoint } from "@smthrs/observability"
import { it } from "@smthrs/testing/Vitest"
import { Effect, Result, Schema } from "effect"
import { describe, expect } from "vitest"

describe("@smthrs/integrations, @smthrs/observability, and @smthrs/gateway fuzz", () => {
  it.fuzz(
    "Integrations JsonPath never crashes and never reads Object.prototype properties on arbitrary paths",
    [Schema.Unknown, Schema.String],
    ([value, path]) => {
      expect(() => IntegrationCore.JsonPath.readJsonPath(value, path)).not.toThrow()
      expect(() => IntegrationCore.JsonPath.readString(value, path)).not.toThrow()
      expect(() => IntegrationCore.JsonPath.readInteger(value, path)).not.toThrow()
      // Prototype properties must never be returned from plain empty objects
      expect(IntegrationCore.JsonPath.readJsonPath({}, "toString")).toBeUndefined()
      expect(IntegrationCore.JsonPath.readJsonPath({}, "__proto__.polluted")).toBeUndefined()
      expect(IntegrationCore.JsonPath.readJsonPath({}, "constructor.prototype")).toBeUndefined()
      return true
    }
  )

  it.effect.fuzz(
    "Integrations Signature.verifySignature accepts valid HMAC-SHA256 and rejects single-byte tamper",
    [
      Schema.String.check(Schema.isMaxLength(256)),
      Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64))
    ],
    ([rawBody, rawSecret]) =>
      Effect.gen(function*() {
        const body = rawBody.toWellFormed()
        const secret = rawSecret.toWellFormed()
        const hex = yield* IntegrationCore.Signature.computeHmacSha256Hex(body, secret)
        expect(hex).toMatch(/^[0-9a-f]{64}$/)

        const valid = yield* IntegrationCore.Signature.verifySignature({
          payload: body,
          secret,
          signature: `${IntegrationCore.Signature.GITHUB_SIGNATURE_PREFIX}${hex}`,
          prefix: IntegrationCore.Signature.GITHUB_SIGNATURE_PREFIX
        })
        expect(valid).toBe(true)

        // Flip the first hex nibble: verification MUST fail
        const flippedNibble = hex[0] === "0" ? "1" : "0"
        const tampered = yield* IntegrationCore.Signature.verifySignature({
          payload: body,
          secret,
          signature: `${IntegrationCore.Signature.GITHUB_SIGNATURE_PREFIX}${flippedNibble}${hex.slice(1)}`,
          prefix: IntegrationCore.Signature.GITHUB_SIGNATURE_PREFIX
        })
        expect(tampered).toBe(false)
        return true
      })
  )

  it.effect.fuzz(
    "Integrations Pkce.deriveCodeChallenge produces RFC 7636 base64url challenges deterministically",
    [Schema.Int.check(Schema.isBetween({ minimum: 43, maximum: 128 }))],
    ([length]) =>
      Effect.gen(function*() {
        const verifier = "A".repeat(length)
        const c1 = yield* IntegrationCore.Pkce.deriveCodeChallenge(verifier)
        const c2 = yield* IntegrationCore.Pkce.deriveCodeChallenge(verifier)
        expect(c1).toBe(c2)
        expect(c1).toMatch(/^[A-Za-z0-9_-]+$/)
        expect(c1.length).toBe(43) // base64url(32-byte SHA-256) without padding
        return true
      })
  )

  it.fuzz(
    "Integrations SignalName parse/eventName round-trips valid segments and AuthorizationUrl protects reserved params",
    [
      Schema.String.check(Schema.isMaxLength(64)),
      Schema.String.check(Schema.isMaxLength(64)),
      Schema.String.check(Schema.isMaxLength(64))
    ],
    ([service, event, extraVal]) => {
      const parsed = IntegrationCore.SignalName.parse(service)
      if (parsed !== null) {
        expect(IntegrationCore.SignalName.isSegment(parsed.service)).toBe(true)
        expect(IntegrationCore.SignalName.isSegment(parsed.event)).toBe(true)
      }
      if (IntegrationCore.SignalName.isSegment(service) && IntegrationCore.SignalName.isSegment(event)) {
        const name = IntegrationCore.SignalName.eventName(service, event)
        expect(IntegrationCore.SignalName.parse(name)).toEqual({ service, event })
      }

      // AuthorizationUrl must throw when extraParams tries to overwrite any reserved param
      for (const reserved of IntegrationCore.AuthorizationUrl.RESERVED_PARAMS) {
        expect(() =>
          IntegrationCore.AuthorizationUrl.buildAuthorizationUrl({
            authorizationEndpoint: "https://auth.example.com/oauth/authorize",
            clientId: "real-client",
            redirectUri: "https://app.example.com/callback",
            state: "real-state",
            codeChallenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
            extraParams: { [reserved]: extraVal }
          })
        ).toThrow(TypeError)
      }
      // Non-reserved extraParams preserve all reserved params intact
      const url = IntegrationCore.AuthorizationUrl.buildAuthorizationUrl({
        authorizationEndpoint: "https://auth.example.com/oauth/authorize",
        clientId: "real-client",
        redirectUri: "https://app.example.com/callback",
        state: "real-state",
        codeChallenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
        scope: ["read:user"],
        extraParams: { prompt: extraVal }
      })
      const parsedUrl = new URL(url)
      expect(parsedUrl.searchParams.get("client_id")).toBe("real-client")
      expect(parsedUrl.searchParams.get("redirect_uri")).toBe("https://app.example.com/callback")
      expect(parsedUrl.searchParams.get("state")).toBe("real-state")
      return true
    }
  )

  it.fuzz(
    "Integrations GitHub.Payload.pushSource and Telegram.Payload.Message never throw on arbitrary webhook JSON",
    [Schema.Unknown],
    ([payload]) => {
      const push = IntegrationGitHub.Payload.pushSource(payload)
      expect(Result.isResult(push)).toBe(true)
      const tg = Schema.decodeUnknownOption(IntegrationTelegram.Payload.Message)(payload)
      expect(tg._tag === "Some" || tg._tag === "None").toBe(true)
      return true
    }
  )

  it.effect.fuzz(
    "Observability Endpoint.decode enforces length & http(s) scheme and signalUrl appends clean paths",
    [Schema.String, Schema.Literals(["traces", "metrics", "logs"])],
    ([raw, signal]) =>
      Effect.gen(function*() {
        const decoded = yield* Effect.result(Endpoint.decode(raw, "otlp"))
        if (Result.isSuccess(decoded)) {
          expect(decoded.success.length).toBeLessThanOrEqual(Endpoint.maximumEndpointLength)
          const parsed = new URL(decoded.success)
          expect(parsed.protocol === "http:" || parsed.protocol === "https:").toBe(true)
          const sigUrl = Endpoint.signalUrl(decoded.success, signal)
          expect(() => new URL(sigUrl)).not.toThrow()
          expect(sigUrl.endsWith(`/${signal}`)).toBe(true)
        }
        return true
      })
  )

  it.fuzz(
    "Gateway RunTrace incremental traceFoldStep matches batch traceFromJournal and durationWords never throws",
    [
      Schema.Array(
        Schema.Struct({
          seq: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 })),
          type: Schema.Literals([
            "flow.started",
            "flow.completed",
            "step.started",
            "step.completed",
            "model.requested",
            "model.completed"
          ]),
          timestampMs: Schema.Int.check(Schema.isBetween({ minimum: 1_000_000, maximum: 2_000_000 })),
          stepId: Schema.String.check(Schema.isMaxLength(16))
        })
      ).check(Schema.isMaxLength(20)),
      Schema.Number
    ],
    ([rawEvents, ms]) => {
      expect(typeof RunTrace.durationWords(ms)).toBe("string")

      const run = {
        runId: "run-fuzz-1",
        flowName: "fuzz/flow",
        startedAtMs: 1_000_000
      }
      const records = rawEvents.map((e, i) => ({
        runId: "run-fuzz-1",
        seq: i + 1,
        type: e.type,
        timestampMs: e.timestampMs,
        payload: { stepId: e.stepId || `s${i}`, flowName: "fuzz/flow" },
        meta: { lineageId: "lin-1" }
      })) as any

      let fold = RunTrace.traceFold(run, [])
      for (const rec of records) {
        fold = RunTrace.traceFoldStep(fold, rec)
      }
      const incremental = RunTrace.traceFoldModel(fold, "completed")
      const batch = RunTrace.traceFromJournal({ ...run, status: "completed" }, records)
      expect(incremental.rows.length).toBe(batch.rows.length)
      expect(incremental.counts).toEqual(batch.counts)
      return true
    }
  )
})

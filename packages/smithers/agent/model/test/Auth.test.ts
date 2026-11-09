import { Effect, Redacted } from "effect"
import * as Headers from "effect/http/Headers"
import { describe, expect, it } from "vitest"
import * as Auth from "../src/Auth.vibe"

describe("Auth", () => {
  it("signs Anthropic API-key headers", async () => {
    const auth = Auth.apiKeyHeader("x-api-key", Redacted.make("anthropic-secret"))
    await expect(Effect.runPromise(auth.sign({ accept: "application/json" }))).resolves.toEqual({
      accept: "application/json",
      "x-api-key": "anthropic-secret"
    })
  })

  it("signs OpenAI bearer headers", async () => {
    const auth = Auth.bearer(Redacted.make("openai-secret"))
    await expect(Effect.runPromise(auth.sign({}))).resolves.toEqual({ Authorization: "Bearer openai-secret" })
  })

  it("scopes custom credential names without losing the caller's policy", async () => {
    const auth = Auth.apiKeyHeader("Ocp-Apim-Subscription-Key", Redacted.make("custom-secret"))
    const names = await Effect.runPromise(
      Effect.gen(function*() {
        const inside = yield* Effect.gen(function*() {
          const headers = yield* auth.sign({ "x-tenant": "tenant", "api-key": "another-secret" })
          return Headers.redact(Headers.fromInput(headers), yield* Headers.CurrentRedactedNames)
        }).pipe(Auth.withRedaction(auth))
        const outside = yield* Headers.CurrentRedactedNames
        return { inside, outside }
      }).pipe(Effect.provideService(Headers.CurrentRedactedNames, ["x-tenant"]))
    )
    expect(String(names.inside["ocp-apim-subscription-key"])).toBe("<redacted>")
    expect(String(names.inside["api-key"])).toBe("<redacted>")
    expect(String(names.inside["x-tenant"])).toBe("<redacted>")
    expect(names.outside).toEqual(["x-tenant"])
  })

  it("does not reveal credentials through the auth value", () => {
    const auth = Auth.bearer(Redacted.make("never-log-this"))
    expect(String(auth)).not.toContain("never-log-this")
    expect(JSON.stringify(auth)).not.toContain("never-log-this")
  })

  it("fails empty credentials as typed authentication errors", async () => {
    const error = await Effect.runPromise(Auth.bearer(Redacted.make("")).sign({}).pipe(Effect.flip))
    expect(error).toMatchObject({ code: "authentication" })
  })

  it("treats the ChatGPT account id as credential-shaped, and the client identity headers as public", () => {
    // The account id must never enter step keys, journals, or diagnostics, so
    // it rides through Auth; the codex client identity headers are route
    // identity and stay public.
    expect(Auth.isCredentialName("chatgpt-account-id")).toBe(true)
    expect(Auth.isCredentialName("ChatGPT-Account-Id")).toBe(true)
    expect(Auth.isCredentialName("chatgpt_account_id")).toBe(true)
    expect(Auth.isCredentialName("originator")).toBe(false)
    expect(Auth.isCredentialName("openai-beta")).toBe(false)
  })

  it("distinguishes credential token names from token-count field names", () => {
    for (const name of ["token", "x-token", "access_token", "api_key", "x-api-key", "Authorization"]) {
      expect(Auth.isCredentialName(name)).toBe(true)
    }
    for (
      const name of [
        "max_tokens",
        "budget_tokens",
        "max_output_tokens",
        "max_completion_tokens",
        "cache_read_input_tokens"
      ]
    ) {
      expect(Auth.isCredentialName(name)).toBe(false)
    }
  })
})

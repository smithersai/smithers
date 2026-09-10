import { describe, expect, test } from "bun:test"
import * as Redacted from "effect/Redacted"
import { configFrom, DEFAULT_CHAT_URL, DEFAULT_CLOUD_API_BASE_URL, upstreamTimeoutFrom } from "./Config"
import { DEFAULT_UPSTREAM_TIMEOUT_MS } from "./Http"

describe("ServerConfig from the binding bag", () => {
  test("an unset deployment has every seam absent and every default in place", () => {
    const config = configFrom({})
    expect(config.buildSha).toBe("unknown")
    expect(config.chatUrl).toBe("https://chat.smithers.sh/chat")
    expect(config.cloudApiBaseUrl).toBe("https://api.jjhub.tech")
    expect(config.upstreamTimeoutMs).toBe(20_000)
    expect([DEFAULT_CHAT_URL, DEFAULT_CLOUD_API_BASE_URL, DEFAULT_UPSTREAM_TIMEOUT_MS]).toEqual(["https://chat.smithers.sh/chat", "https://api.jjhub.tech", 20_000])
    expect(config.identityUpstreamUrl).toBeUndefined()
    expect(config.cerebrasApiKey).toBeUndefined()
    expect(config.billingCheckoutEnabled).toBe(false)
  })

  test("blank and whitespace values read as unset, like an empty `secret put`", () => {
    const config = configFrom({ IDENTITY_UPSTREAM_URL: "   ", CEREBRAS_API_KEY: "", BILLING_CHECKOUT_ENABLED: " 1 " })
    expect(config.identityUpstreamUrl).toBeUndefined()
    expect(config.cerebrasApiKey).toBeUndefined()
    expect(config.billingCheckoutEnabled).toBe(true)
  })

  test("secrets are redacted: their value is only reachable on purpose", () => {
    const config = configFrom({ SMITHERS_CHAT_AUTH_TOKEN: " bearer-secret " })
    expect(String(config.chatAuthToken)).not.toContain("bearer-secret")
    expect(JSON.stringify(config)).not.toContain("bearer-secret")
    expect(Redacted.value(config.chatAuthToken!)).toBe("bearer-secret")
  })

  test("UPSTREAM_TIMEOUT_MS accepts any finite positive number of milliseconds and nothing else", () => {
    expect(upstreamTimeoutFrom("45000")).toBe(45000)
    expect(upstreamTimeoutFrom("0")).toBe(20_000)
    expect(upstreamTimeoutFrom("-5")).toBe(20_000)
    expect(upstreamTimeoutFrom("soon")).toBe(20_000)
    expect(upstreamTimeoutFrom(undefined)).toBe(20_000)
    expect(upstreamTimeoutFrom("")).toBe(20_000)
    expect(upstreamTimeoutFrom("1500.5")).toBe(1500.5)
  })

  test("the anonymous salt keeps its exact bytes, because the persisted buckets are hashed from them", () => {
    expect(Redacted.value(configFrom({ ANONYMOUS_TURN_SALT: " salt \n" }).anonymousTurnSalt!)).toBe(" salt \n")
    expect(configFrom({ ANONYMOUS_TURN_SALT: "" }).anonymousTurnSalt).toBeUndefined()
  })
})

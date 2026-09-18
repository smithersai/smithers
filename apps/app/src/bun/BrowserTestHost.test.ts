import { describe, expect, test } from "bun:test"
import { browserTestOptions } from "../../scripts/browser-test-host"

describe("browser tests separate fixture ownership from real-host authority", () => {
  test("default options cannot discover host credentials or inherit hybrid cloud configuration", () => {
    const options = browserTestOptions("/fixture/owned", "/fixture/dist", {
      SMITHERS_LOCAL_MODE: "hybrid",
      SMITHERS_CLOUD_API: "https://not-a-test.invalid",
      CODEX_HOME: "/fixture/personal-credentials",
      OPENAI_API_KEY: "fixture-only-not-a-credential"
    })
    expect(options).toMatchObject({
      home: "/fixture/owned",
      stateDir: "/fixture/owned/state",
      chatStub: true,
      cloudMode: "offline",
      cloudApi: null,
      identityUpstream: null
    })
  })

  test("real chat is a separate explicit opt-in and never imports real identity authority", () => {
    const options = browserTestOptions("/fixture/owned", "/fixture/dist", { SMITHERS_CHAT_STUB: "0" })
    expect(options.chatStub).toBe(false)
    expect(options.cloudMode).toBe("hybrid")
    expect(options.home).toBe("/fixture/owned")
    expect(options.cloudApi).toBeNull()
    expect(options.identityUpstream).toBeNull()
    expect(() => browserTestOptions("/fixture/owned", "/fixture/dist", { SMITHERS_LOCAL_PORT: "NaN" })).toThrow("port")
  })
})

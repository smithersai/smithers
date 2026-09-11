import { describe, expect, test } from "bun:test"
import { browserTestOptions } from "../../scripts/browser-test-host"

describe("browser tests separate fixture ownership from real-host authority", () => {
  test("default options cannot discover host credentials or inherit hybrid cloud configuration", async () => {
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
    expect(options.pty).toBeFunction()
    const harnesses = await options.harnesses!()
    expect(harnesses.length).toBeGreaterThan(0)
    expect(harnesses.find((row) => row.id === "codex")).toMatchObject({
      status: "unavailable",
      binary: null,
      account: null
    })
    expect(harnesses.every((row) => row.status === "unavailable" && row.binary === null && row.account === null)).toBe(
      true
    )
  })

  test("host harness authority is opt-in and does not also enable real chat or cloud credentials", () => {
    const options = browserTestOptions("/fixture/owned", "/fixture/dist", { SMITHERS_E2E_HOST_HARNESSES: "1" })
    expect(options.home).toBeUndefined()
    expect(options.harnesses).toBeUndefined()
    expect(options.pty).toBeUndefined()
    expect(options.stateDir).toBe("/fixture/owned/state")
    expect(options.chatStub).toBe(true)
    expect(options.cloudMode).toBe("offline")
  })

  test("real chat is a separate explicit opt-in and never imports real harness or identity authority", () => {
    const options = browserTestOptions("/fixture/owned", "/fixture/dist", { SMITHERS_CHAT_STUB: "0" })
    expect(options.chatStub).toBe(false)
    expect(options.cloudMode).toBe("hybrid")
    expect(options.home).toBe("/fixture/owned")
    expect(options.harnesses).toBeFunction()
    expect(options.cloudApi).toBeNull()
    expect(options.identityUpstream).toBeNull()
    expect(() => browserTestOptions("/fixture/owned", "/fixture/dist", { SMITHERS_LOCAL_PORT: "NaN" })).toThrow("port")
  })
})

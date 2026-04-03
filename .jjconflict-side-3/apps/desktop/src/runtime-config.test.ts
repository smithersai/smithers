import { describe, expect, it } from "bun:test"
import { DEFAULT_BURNS_API_URL } from "@burns/shared"
import {
  buildRuntimeConfigInitScript,
  defaultRuntimeConfig,
  resolveRuntimeConfig,
} from "./runtime-config"

describe("runtime config injection", () => {
  it("injects and freezes window.__BURNS_RUNTIME_CONFIG__", () => {
    const script = buildRuntimeConfigInitScript({
      burnsApiUrl: "https://daemon.example.test",
      runtimeMode: "desktop",
    })

    const windowLike: Record<string, unknown> = {}
    const run = new Function("window", script) as (window: Record<string, unknown>) => void

    run(windowLike)

    const injectedConfig = windowLike.__BURNS_RUNTIME_CONFIG__ as {
      burnsApiUrl: string
      runtimeMode?: string
    }

    expect(injectedConfig.burnsApiUrl).toBe("https://daemon.example.test")
    expect(injectedConfig.runtimeMode).toBe("desktop")
    expect(Object.isFrozen(injectedConfig)).toBe(true)
  })

  it("uses daemon API URL by default", () => {
    const previousValue = process.env.BURNS_DESKTOP_FORCE_API_URL
    delete process.env.BURNS_DESKTOP_FORCE_API_URL

    const resolved = resolveRuntimeConfig({ daemonApiUrl: "http://localhost:8999" })
    expect(resolved.burnsApiUrl).toBe("http://localhost:8999")
    expect(resolved.runtimeMode).toBe("desktop")

    if (previousValue === undefined) {
      delete process.env.BURNS_DESKTOP_FORCE_API_URL
    } else {
      process.env.BURNS_DESKTOP_FORCE_API_URL = previousValue
    }
  })

  it("supports force API URL override for debug/testing", () => {
    const previousValue = process.env.BURNS_DESKTOP_FORCE_API_URL
    process.env.BURNS_DESKTOP_FORCE_API_URL = "http://127.0.0.1:7332"

    const resolved = resolveRuntimeConfig({ daemonApiUrl: "http://localhost:8999" })
    expect(resolved.burnsApiUrl).toBe("http://127.0.0.1:7332")
    expect(resolved.runtimeMode).toBe("desktop")

    if (previousValue === undefined) {
      delete process.env.BURNS_DESKTOP_FORCE_API_URL
    } else {
      process.env.BURNS_DESKTOP_FORCE_API_URL = previousValue
    }
  })

  it("falls back to default when both daemon and override are invalid", () => {
    const previousValue = process.env.BURNS_DESKTOP_FORCE_API_URL
    process.env.BURNS_DESKTOP_FORCE_API_URL = "not-a-url"

    const resolved = resolveRuntimeConfig({ daemonApiUrl: "still-not-a-url" })
    expect(resolved.burnsApiUrl).toBe(defaultRuntimeConfig.burnsApiUrl)
    expect(resolved.burnsApiUrl).toBe(DEFAULT_BURNS_API_URL)

    if (previousValue === undefined) {
      delete process.env.BURNS_DESKTOP_FORCE_API_URL
    } else {
      process.env.BURNS_DESKTOP_FORCE_API_URL = previousValue
    }
  })
})

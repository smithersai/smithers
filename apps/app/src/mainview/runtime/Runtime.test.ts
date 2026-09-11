import { describe, expect, test } from "bun:test"
import type { AppBootstrap } from "@smthrs/rpc/AppBootstrap"
import { APP_BOOTSTRAP_PATH } from "@smthrs/rpc/AppBootstrap"
import { createRuntime, loadBootstrap } from "./Runtime"

const cloud: AppBootstrap = {
  apiVersion: 1,
  host: "cloud",
  version: "1",
  buildSha: "abc",
  capabilities: ["agent", "identity", "cloud"],
  authFlow: "redirect",
  sandbox: null
}

describe("runtime composition", () => {
  test("constructs ports from the validated host contract", async () => {
    const requests: Array<string> = []
    const runtime = createRuntime({
      bootstrap: cloud,
      http: async (input) => {
        requests.push(input.toString())
        return new Response(null, { status: 204 })
      }
    })
    expect(runtime.backend.agent?.available).toBe(true)
    // Only ports a consumer holds: identity and cloud are capabilities the
    // reading site tests through hasCapability, not descriptors mirrored here.
    expect(Object.keys(runtime.backend)).toEqual(["agent"])
    expect(runtime.bootstrap.capabilities).toContain("identity")
    expect(runtime.shell.kind).toBe("browser")
    await runtime.backend.agent?.cancelTurn("run")
    expect(requests).toContain("/api/agent/turn/cancel")
  })

  test("local offline exposes only actual local ports", () => {
    const runtime = createRuntime({
      bootstrap: {
        ...cloud,
        host: "local",
        capabilities: ["local.repositories", "local.targets"],
        authFlow: "none",
        sandbox: { platform: "linux", mode: "trusted-only" }
      },
      http: async () => new Response(null, { status: 204 })
    })
    expect(runtime.backend.agent).toBeUndefined()
    expect(Object.keys(runtime.backend)).toEqual(["repositories"])
    expect(runtime.backend.repositories?.available).toBe(false)
    expect(runtime.bootstrap.capabilities).not.toContain("identity")
    // The sandbox descriptor stays on the validated bootstrap, where the
    // product reads it (state/Onboarding.ts).
    expect(runtime.bootstrap.sandbox?.mode).toBe("trusted-only")
  })

  test("loads and validates the bootstrap endpoint", async () => {
    const seen: Array<string> = []
    const loaded = await loadBootstrap(async (input) => {
      seen.push(input.toString())
      return Response.json(cloud)
    })
    expect(seen).toEqual([APP_BOOTSTRAP_PATH])
    expect(loaded).toEqual(cloud)
  })
})

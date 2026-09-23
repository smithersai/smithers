import { describe, expect, test } from "bun:test"
import type { AppBootstrap } from "@smthrs/rpc/AppBootstrap"
import { APP_BOOTSTRAP_PATH } from "@smthrs/rpc/AppBootstrap"
import { BootstrapFailure, createRuntime, loadBootstrap, warmBootstrap } from "./Runtime"

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
        capabilities: [],
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

for (const [label, response, kind] of [
  ["missing endpoint", new Response("404", { status: 404 }), "missing"],
  ["backend failure", new Response("oops", { status: 503 }), "server"],
  ["invalid document", Response.json({ apiVersion: 1 }), "invalid"]
] as const) {
  test(`classifies ${label} at the real bootstrap read`, async () => {
    await expect(loadBootstrap(async () => response)).rejects.toMatchObject({ kind })
  })
}

test("classifies an unreachable backend at the real bootstrap read", async () => {
  await expect(loadBootstrap(async () => { throw new TypeError("Failed to fetch") })).rejects.toBeInstanceOf(BootstrapFailure)
  await expect(loadBootstrap(async () => { throw new TypeError("Failed to fetch") })).rejects.toMatchObject({ kind: "unreachable" })
})

test("bootstrap warming shares the in-flight promise and retries after rejection", async () => {
  const first = Promise.withResolvers<Response>()
  let reads = 0
  const http = () => { reads++; return first.promise }
  const pending = warmBootstrap(http)
  expect(warmBootstrap(http)).toBe(pending)
  expect(reads).toBe(1)
  first.reject(new Error("offline"))
  await expect(pending).rejects.toMatchObject({ kind: "unreachable" })

  const next = Promise.withResolvers<Response>()
  const retry = warmBootstrap(() => { reads++; return next.promise })
  expect(retry).not.toBe(pending)
  expect(warmBootstrap(http)).toBe(retry)
  expect(reads).toBe(2)
  next.resolve(Response.json(cloud))
  await expect(retry).resolves.toEqual(cloud)
})

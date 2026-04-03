import { afterEach, describe, expect, it } from "bun:test"

import { validateSmithersBaseUrl } from "@/services/smithers-validation-service"

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe("validateSmithersBaseUrl", () => {
  it("returns ok=true when endpoint responds successfully", async () => {
    globalThis.fetch = (async () => new Response(null, { status: 200 })) as unknown as typeof fetch

    const result = await validateSmithersBaseUrl("http://localhost:7331")

    expect(result).toEqual({
      ok: true,
      status: 200,
      message: "Smithers server is reachable.",
    })
  })

  it("returns ok=false when endpoint responds with non-success status", async () => {
    globalThis.fetch = (async () => new Response(null, { status: 503 })) as unknown as typeof fetch

    const result = await validateSmithersBaseUrl("http://localhost:7331")

    expect(result).toEqual({
      ok: false,
      status: 503,
      message: "Server responded with HTTP 503",
    })
  })
})

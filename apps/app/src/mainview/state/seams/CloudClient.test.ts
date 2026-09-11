import { CLOUD_ROUTE_PREFIX } from "@smthrs/rpc/LocalApp"
import { describe, expect, test } from "bun:test"
import { cloudFailure, createCloudClient } from "./CloudClient"

describe("cloud transport", () => {
  test("uses the injected transport and preserves response headers for pagination", async () => {
    const calls: Array<{ path: string; init?: RequestInit }> = []
    const client = createCloudClient({
      baseUrl: "https://app.example",
      http: async (path, init) => {
        calls.push({ path, init })
        return Response.json({ items: [1] }, { headers: { link: "next" }, status: 201 })
      }
    })
    const read = await client.get("/repos")
    expect(read).toMatchObject({ body: { items: [1] }, status: 201 })
    if ("error" in read) throw new Error(read.error)
    expect(read.response.headers.get("link")).toBe("next")
    await client.send("POST", "/repos", { name: "sample" })
    await client.send("DELETE", "/repos/1")
    expect(calls).toEqual([
      { path: `https://app.example${CLOUD_ROUTE_PREFIX}api/repos`, init: undefined },
      {
        path: `https://app.example${CLOUD_ROUTE_PREFIX}api/repos`,
        init: {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{\"name\":\"sample\"}"
        }
      },
      { path: `https://app.example${CLOUD_ROUTE_PREFIX}api/repos/1`, init: { method: "DELETE" } }
    ])
  })

  test("preserves a refusal's message, code, status, and retry instruction together", async () => {
    expect(
      await cloudFailure(
        Response.json({ code: "guest_not_ready", message: "Guest is starting" }, {
          status: 503,
          headers: { "retry-after": "3" }
        }),
        "fallback"
      )
    ).toEqual({
      error: "Guest is starting",
      code: "guest_not_ready",
      status: 503,
      retryAfterSeconds: 3
    })
    expect(await cloudFailure(Response.json({ error: { message: "x".repeat(300) } }, { status: 409 }), "fallback"))
      .toEqual({ error: "x".repeat(240), code: null, status: 409, retryAfterSeconds: null })
  })

  test("distinguishes network failures from HTTP errors without inventing status zero", async () => {
    const client = createCloudClient({
      baseUrl: "",
      http: async () => {
        throw new Error("offline")
      }
    })
    expect(await client.get("/repos")).toEqual({
      error: "Could not reach Smithers Cloud: offline",
      status: null,
      code: null,
      retryAfterSeconds: null
    })
    expect(await client.send("POST", "/repos")).toEqual(await client.get("/repos"))
  })

  test("keeps malformed responses out of user-facing messages and supports empty successes", async () => {
    const client = createCloudClient({
      baseUrl: "",
      http: async () => new Response("<html>broken</html>", { status: 502 })
    })
    expect(await client.get("/repos?page=2", "/repos")).toMatchObject({
      error: "Reading /repos failed (502)",
      status: 502
    })
    expect(await client.send("POST", "/repos")).toMatchObject({ error: "The POST to /repos failed (502)" })
    const empty = createCloudClient({ baseUrl: "", http: async () => new Response(null, { status: 204 }) })
    expect(await empty.send("DELETE", "/repos/1")).toMatchObject({ body: null, status: 204 })
  })
})

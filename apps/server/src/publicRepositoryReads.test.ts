import { describe, expect, test } from "bun:test"
import { cloudReadPath, createPublicRepositoryReader, isPublicRepositoryRead } from "./publicRepositoryReads"
import worker from "./index"
import { memoryDurableObjects } from "./memoryDurableObjects"

describe("anonymous repository reads", () => {
  test("admits public document reads and excludes writes, account data, and workspace credentials", () => {
    for (const suffix of ["", "/contents/src/index.ts", "/topics", "/bookmarks", "/issues", "/issues/1/comments", "/changes/abc/diff"]) {
      expect(isPublicRepositoryRead("GET", `/api/repos/smithersai/smithers${suffix}`)).toBe(true)
    }
    for (const path of ["/api/user/repos", "/api/billing/balance", "/api/admin/errors", "/api/repos/a/b/workspaces", "/api/repos/a/b/workspaces/1/ssh", "/api/repos/a/b/gateway", "/api/repos/a/b/secrets", "/api/repos/a/../issues"]) {
      expect(isPublicRepositoryRead("GET", path)).toBe(false)
    }
    for (const method of ["POST", "PATCH", "PUT", "DELETE"]) {
      expect(isPublicRepositoryRead(method, "/api/repos/a/b/issues")).toBe(false)
    }
  })

  test("checks public visibility on every read without forwarding credentials", async () => {
    const seen: Array<Request> = []
    let isPublic = true
    const read = createPublicRepositoryReader({
      fetch: async (request) => {
        seen.push(request)
        return isPublic
          ? Response.json([{ name: "README.md", type: "file" }], { headers: { "cache-control": "public, max-age=300" } })
          : Response.json({ message: "repository not found" }, { status: 404 })
      }
    })
    const url = new URL("https://app.test/api/repos/smithersai/smithers/contents?ref=main")
    const first = await read(url, "https://cloud.test")
    expect(await first.json()).toEqual([{ name: "README.md", type: "file" }])
    expect(first.headers.get("cache-control")).toBe("private, no-store")
    isPublic = false
    const second = await read(url, "https://cloud.test")
    expect(second.status).toBe(404)
    expect(await second.json()).toEqual({ message: "repository not found" })
    expect(second.headers.get("cache-control")).toBe("private, no-store")
    expect(seen).toHaveLength(2)
    for (const request of seen) {
      expect(request.url).toBe("https://cloud.test/api/repos/smithers-canary/smithers/contents?ref=main")
      expect(request.headers.has("authorization")).toBe(false)
      expect(request.headers.has("cookie")).toBe(false)
    }
  })

  test("a catalog read reaches the Smithers Cloud mirror with the same document path and query", async () => {
    const seen: Array<Request> = []
    const read = createPublicRepositoryReader({
      fetch: async (request) => {
        seen.push(request)
        return Response.json({ name: "src", type: "dir", mirror: new URL(request.url).pathname })
      }
    })
    const response = await read(new URL("https://app.test/api/repos/smithersai/smithers/contents/src?ref=main&recursive=1"), "https://cloud.test")
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ name: "src", type: "dir", mirror: "/api/repos/smithers-canary/smithers/contents/src" })
    expect(seen.map((request) => request.url)).toEqual([
      "https://cloud.test/api/repos/smithers-canary/smithers/contents/src?ref=main&recursive=1"
    ])
    expect(seen[0]?.headers.has("authorization")).toBe(false)
    expect(seen[0]?.headers.has("cookie")).toBe(false)
  })

  test("the upstream request asks for a manual redirect and a 3xx answer is unavailable", async () => {
    // workerd rejects redirect: "error" before sending anything, which made
    // every production public read a 502; "manual" is the accepted mode.
    const seen: Array<Request> = []
    const read = createPublicRepositoryReader({
      fetch: async (request) => {
        seen.push(request)
        return new Response(null, { status: 302, headers: { location: "https://elsewhere.test/login" } })
      }
    })
    const response = await read(new URL("https://app.test/api/repos/smithersai/smithers/contents/README.md"), "https://cloud.test")
    expect(seen[0]?.redirect).toBe("manual")
    expect(response.status).toBe(502)
    expect(response.headers.get("location")).toBeNull()
    expect(await response.json()).toEqual({ message: "Repository data is temporarily unavailable." })
  })

  test("a repository outside the catalog is read under the name the browser asked for", async () => {
    const seen: Array<Request> = []
    const read = createPublicRepositoryReader({
      fetch: async (request) => {
        seen.push(request)
        return Response.json({ message: "repository not found" }, { status: 404 })
      }
    })
    const response = await read(new URL("https://app.test/api/repos/example/other/issues?state=open"), "https://cloud.test")
    expect(response.status).toBe(404)
    expect(seen.map((request) => request.url)).toEqual(["https://cloud.test/api/repos/example/other/issues?state=open"])
    expect(cloudReadPath("/api/repos/example/other/issues")).toBe("/api/repos/example/other/issues")
    expect(cloudReadPath("/api/repos/smithersai/smithers-docs")).toBe("/api/repos/smithersai/smithers-docs")
    expect(cloudReadPath("/api/user/repos")).toBe("/api/user/repos")
  })

  test("a mixed-case catalog name still reaches the mirror", async () => {
    const seen: Array<Request> = []
    const read = createPublicRepositoryReader({
      fetch: async (request) => {
        seen.push(request)
        return Response.json({ full_name: "smithers-canary/smithers" })
      }
    })
    const response = await read(new URL("https://app.test/api/repos/SmithersAI/Smithers/topics"), "https://cloud.test")
    expect(response.status).toBe(200)
    expect(seen.map((request) => request.url)).toEqual(["https://cloud.test/api/repos/smithers-canary/smithers/topics"])
    expect(cloudReadPath("/api/repos/SMITHERSAI/SMITHERS")).toBe("/api/repos/smithers-canary/smithers")
    expect(cloudReadPath("/api/repos/SmithersAI/Smithers/")).toBe("/api/repos/smithers-canary/smithers/")
  })

  test("preserves Vary and forbids storage even when the upstream answer is successful", async () => {
    for (const cacheControl of ["private", "no-store", "private, no-store", "public, max-age=300"]) {
      const read = createPublicRepositoryReader({
        fetch: async () => Response.json({ name: "README.md" }, { headers: {
          "cache-control": cacheControl, vary: "Cookie, Accept", "set-cookie": "session=upstream"
        } })
      })
      const response = await read(new URL("https://app.test/api/repos/owner/repo/contents"), "https://cloud.test")
      expect(response.status).toBe(200)
      expect(response.headers.get("cache-control")).toBe("private, no-store")
      expect(response.headers.get("vary")).toBe("Cookie, Accept")
      expect(response.headers.has("set-cookie")).toBe(false)
      expect(await response.json()).toEqual({ name: "README.md" })
    }
  })

  test("a private repository's refusal is neither converted to data nor made cacheable", async () => {
    const read = createPublicRepositoryReader({
      fetch: async () => Response.json({ message: "repository not found" }, { status: 404 })
    })
    const response = await read(new URL("https://app.test/api/repos/owner/private"), "https://cloud.test")
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ message: "repository not found" })
    expect(response.headers.get("cache-control")).toBe("private, no-store")
  })

  test("an interrupted upstream refusal still returns the app's structured error", async () => {
    const original = globalThis.fetch
    globalThis.fetch = (async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(new ReadableStream({
      start(controller) { controller.error(new Error("upstream error body disconnected")) }
    }), { status: 404, headers: { vary: "Cookie", "set-cookie": "session=upstream" } })) as typeof fetch
    try {
      for (const prefix of ["/api", "/api/cloud/api"]) {
        const response = await worker.fetch(new Request(`https://app.test${prefix}/repos/owner/repo`), {
          ...memoryDurableObjects(), ASSETS: { fetch: async () => new Response("app") }, SMITHERS_CLOUD_API_BASE_URL: "https://cloud.test"
        })
        expect(response.status).toBe(404)
        expect(await response.json()).toEqual({
          status: "error", message: "Smithers Cloud doesn't serve that request on this deployment."
        })
        expect(response.headers.get("cache-control")).toBe("private, no-store")
        expect(response.headers.get("vary")).toBe("Cookie")
        expect(response.headers.has("set-cookie")).toBe(false)
      }
    } finally { globalThis.fetch = original }
  })

  test("the app's direct and Cloud-prefixed read routes work without a session, but writes require one", async () => {
    const original = globalThis.fetch
    const requests: Array<Request> = []
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init)
      requests.push(request)
      if (request.url.startsWith("https://identity.test/")) {
        return request.headers.get("cookie") === "smithers_session=not-admitted"
          ? Response.json({ login: "visitor", allowlisted: false, admin: false })
          : new Response(null, { status: 401 })
      }
      return Response.json({ full_name: "smithersai/smithers", private: false })
    }) as typeof fetch
    const env = {
      ...memoryDurableObjects(),
      ASSETS: { fetch: async () => new Response("app") },
      IDENTITY_UPSTREAM_URL: "https://identity.test",
      SMITHERS_CLOUD_API_BASE_URL: "https://cloud.test"
    }
    try {
      for (const prefix of ["/api", "/api/cloud/api"]) {
        const response = await worker.fetch(new Request(`https://app.test${prefix}/repos/smithersai/smithers`), env)
        expect(response.status).toBe(200)
        expect((await response.json() as { full_name: string }).full_name).toBe("smithersai/smithers")
      }
      expect(requests).toHaveLength(2)
      expect(requests.every((request) => request.url === "https://cloud.test/api/repos/smithers-canary/smithers" && !request.headers.has("authorization"))).toBe(true)
      for (const session of ["expired", "not-admitted"]) {
        const response = await worker.fetch(new Request("https://app.test/api/repos/smithersai/smithers", {
          headers: { cookie: `smithers_session=${session}` }
        }), env)
        expect(response.status).toBe(200)
      }
      const write = await worker.fetch(new Request("https://app.test/api/repos/smithersai/smithers/issues", { method: "POST" }), env)
      expect(write.status).toBe(401)
      const cloudRequests = requests.filter((request) => request.url.startsWith("https://cloud.test/"))
      expect(cloudRequests).toHaveLength(4)
      expect(cloudRequests.every((request) => !request.headers.has("cookie") && !request.headers.has("authorization"))).toBe(true)
    } finally { globalThis.fetch = original }
  })
})

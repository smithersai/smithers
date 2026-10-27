// The site Worker (worker/index.ts): /api/* goes to ChatApi over its service binding, a bare docs folder on to its
// slashed form, and every other path to the app's assets. The bindings are Cloudflare's, so they are the seam: each
// answers with its own name.
import { expect, test } from "vitest"
import site from "./index.ts"

const binding = (name: string, seen: Array<string>) =>
  ({
    fetch: async (request: Request) => {
      seen.push(`${name} ${request.method} ${new URL(request.url).pathname}`)
      return new Response(name)
    },
  }) as unknown as Fetcher

test.each([
  ["POST", "/api/questions", "CHAT_API"],
  ["POST", "/api/conversations/archive", "CHAT_API"],
  ["GET", "/api/shapes/my-conversations?offset=-1", "CHAT_API"],
  ["GET", "/api/shapes/messages?offset=-1", "CHAT_API"],
  ["POST", "/api/telemetry/v1/logs", "CHAT_API"],
  ["GET", "/app", "ASSETS"],
  ["GET", "/", "ASSETS"],
  ["GET", "/api", "ASSETS"],
  ["GET", "/apis/x", "ASSETS"],
  ["GET", "/docsify/docsify", "ASSETS"],
  ["GET", "/docs/installation/", "ASSETS"],
])("%s %s goes to %s, unchanged", async (method, path, to) => {
  const seen: Array<string> = []
  const env = { CHAT_API: binding("CHAT_API", seen), ASSETS: binding("ASSETS", seen) }
  const request = new Request(`https://smithers.test${path}`, { method })
  const response = await site.fetch(request as Parameters<typeof site.fetch>[0], env)
  expect(await response.text()).toBe(to)
  expect(seen).toEqual([`${to} ${method} ${path.split("?")[0]}`])
})

test.each([
  ["/docs?ref=x", "https://smithers.test/docs/?ref=x"],
  ["/changelogs", "https://smithers.test/changelogs/"],
  ["/privacy?utm_source=a&b=c", "https://smithers.test/privacy/?utm_source=a&b=c"],
])("a bare docs folder, %s, goes on to %s, where the docs site's routes take it", async (path, location) => {
  const seen: Array<string> = []
  const env = { CHAT_API: binding("CHAT_API", seen), ASSETS: binding("ASSETS", seen) }
  const response = await site.fetch(new Request(`https://smithers.test${path}`) as Parameters<typeof site.fetch>[0], env)
  expect(response.status).toBe(301)
  expect(response.headers.get("location")).toBe(location)
  expect(seen).toEqual([])
})


// Real asset responses keep the shell's metadata, with the requesting origin substituted.
test.each(["text/html; charset=utf-8", "text/html"])("HTML response %s resolves the card origin", async (contentType) => {
  const { readFile } = await import("node:fs/promises")
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8")
  const response = new Response(html, { headers: {
    "content-type": contentType, "content-length": String(html.length), etag: '"asset"', "cache-control": "public, max-age=0",
  } })
  const env = { CHAT_API: binding("CHAT_API", []), ASSETS: { fetch: () => Promise.resolve(response) } as unknown as Fetcher }
  const result = await site.fetch(new Request("https://custom.example:8443/app") as Parameters<typeof site.fetch>[0], env)
  expect(await result.text()).toBe(html.replaceAll("__SMITHERS_ORIGIN__", "https://custom.example:8443"))
  expect(result.status).toBe(200)
  expect(result.headers.get("etag")).toBeNull()
  expect(result.headers.get("content-length")).toBeNull()
  expect(result.headers.get("cache-control")).toBe("public, max-age=0")
})

test("binary assets retain their response and validators", async () => {
  const response = new Response(new Uint8Array([137, 80, 78, 71]), { headers: { "content-type": "image/png", etag: '"png"' } })
  const env = { CHAT_API: binding("CHAT_API", []), ASSETS: { fetch: () => Promise.resolve(response) } as unknown as Fetcher }
  expect(await site.fetch(new Request("https://custom.example/social-card.png") as Parameters<typeof site.fetch>[0], env)).toBe(response)
})

test("conditional asset responses retain their empty body", async () => {
  const response = new Response(null, { status: 304, headers: { "content-type": "text/html" } })
  const env = { CHAT_API: binding("CHAT_API", []), ASSETS: { fetch: () => Promise.resolve(response) } as unknown as Fetcher }
  expect(await site.fetch(new Request("https://custom.example/") as Parameters<typeof site.fetch>[0], env)).toBe(response)
})

test.each(["/definitely-missing-page", "/sitemap.xml", "/favicon.ico", "/app/conversations/missing", "/owner/repo/issues/0"])("the SPA fallback keeps recovery HTML with a true 404: %s", async (path) => {
  const env = { CHAT_API: binding("CHAT_API", []), ASSETS: { fetch: async () => new Response("<html>__SMITHERS_ORIGIN__</html>", { headers: { "content-type": "text/html" } }) } as unknown as Fetcher }
  const response = await site.fetch(new Request(`https://app.test${path}`) as Parameters<typeof site.fetch>[0], env)
  expect(response.status).toBe(404)
  expect(response.headers.get("x-robots-tag")).toBe("noindex")
  expect(await response.text()).toBe("<html>https://app.test</html>")
})


test("the real index HTML resource keeps its successful status and origin metadata", async () => {
  const env = { CHAT_API: binding("CHAT_API", []), ASSETS: {
    fetch: async () => new Response("<html>__SMITHERS_ORIGIN__</html>", { headers: { "content-type": "text/html", etag: '"shell"' } }),
  } as unknown as Fetcher }
  const response = await site.fetch(new Request("https://app.test/index.html") as Parameters<typeof site.fetch>[0], env)
  expect(response.status).toBe(200)
  expect(response.headers.get("x-robots-tag")).toBeNull()
  expect(response.headers.get("etag")).toBeNull()
  expect(await response.text()).toBe("<html>https://app.test</html>")
})

import { expect, it } from "vitest"
import worker from "../worker/index.ts"
const fetchAsset = async (request) => new Response(new URL(request.url).pathname === "/media/logo-dark.svg" ? "<svg/>" : "<html>splash</html>", { headers: { "Content-Type": new URL(request.url).pathname === "/media/logo-dark.svg" ? "image/svg+xml" : "text/html" } })
const env = { ASSETS: { fetch: fetchAsset } }
it("never serves the splash for unknown routes or production fault pages", async () => {
  for (const path of ["/nope", "/missing.js", "/assets/missing.js", "/media/missing.png", "/e2e", "/e2e/", "/e2e/runtime/index.html", "/e2e/runtime/entry.ts"]) {
    const response = await worker.fetch(new Request(`https://example.test${path}`), env)
    expect(response.status, path).toBe(404)
    expect(await response.text()).not.toContain("splash")
  }
})
it("serves the home, health and known assets", async () => {
  expect(await (await worker.fetch(new Request("https://example.test/"), env)).text()).toContain("splash")
  expect(await (await worker.fetch(new Request("https://example.test/api/health"), env)).json()).toEqual({ ok: true, agent: "mock" })
  expect(await (await worker.fetch(new Request("https://example.test/media/logo-dark.svg"), env)).text()).toBe("<svg/>")
})
